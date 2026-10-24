/**
 * Phase 27c S1: `~ADJUST_ALPHA(formula)` and `~CHAN(r, g, b, a)` -- Wesnoth Formula Language evaluated for
 * every pixel (`adjust_alpha_modification`, `adjust_channels_modification` and their `pixel_callable`,
 * image_modifications.cpp). Core's black, dark and white horses are drawn with `~CHAN`.
 *
 * Imports only the engine's formula module (no DOM, no game state), so it runs in the compositor workers.
 */
import { Formula, TokenType, Variant, tokenize, type Callable } from '@wesnothweb2/engine/src/formula/index.js'
import type { PixelFunction } from './surfaceOps'

/**
 * `pixel_callable`: the pixel's `red`, `green`, `blue`, `alpha` (`color_callable`), `x`, `y`, `width`,
 * `height`, `u` and `v`. Upstream builds `u` and `v` as `variant(x / float(w))`, which picks `variant(int)` --
 * so they are always 0, and so they are here.
 */
class PixelCallable implements Callable {
  x = 0
  y = 0
  r = 0
  g = 0
  b = 0
  a = 0
  constructor(readonly width: number, readonly height: number) {}

  getValue(key: string): Variant {
    switch (key) {
      case 'red': return Variant.int(this.r)
      case 'green': return Variant.int(this.g)
      case 'blue': return Variant.int(this.b)
      case 'alpha': return Variant.int(this.a)
      case 'x': return Variant.int(this.x)
      case 'y': return Variant.int(this.y)
      case 'width': return Variant.int(this.width)
      case 'height': return Variant.int(this.height)
      case 'u': return Variant.int(Math.trunc(this.x / this.width))
      case 'v': return Variant.int(Math.trunc(this.y / this.height))
    }
    return Variant.null_()
  }

  getInputs(): string[] {
    return ['red', 'green', 'blue', 'alpha', 'x', 'y', 'u', 'v', 'height', 'width']
  }
}

/** `std::min<unsigned>(value, 255)`: a negative result wraps to a huge unsigned number, so it gives 255 too. */
function channel(v: Variant): number {
  const n = v.asInt()
  return n < 0 || n > 255 ? 255 : n
}

const POSITIONAL = new Set(['x', 'y', 'u', 'v', 'width', 'height'])

/**
 * The per-pixel function of `~CHAN` (one to four formulas; missing ones keep their channel) or, with
 * `alphaOnly`, `~ADJUST_ALPHA` (one formula, for alpha). Formulas that do not look at the pixel's position give
 * the same result for the same colour, so those results are remembered by colour (a sprite has few).
 */
export function pixelFunction(formulas: readonly string[], width: number, height: number, alphaOnly: boolean): PixelFunction {
  const sources = alphaOnly ? ['red', 'green', 'blue', formulas[0] ?? 'alpha'] : [...formulas]
  const defaults = ['red', 'green', 'blue', 'alpha']
  while (sources.length < 4) sources.push(defaults[sources.length]!)
  const compiled = sources.map((s) => new Formula(s))
  const positional = sources.some((s) => tokenize(s).some((t) => t.type === TokenType.Identifier && POSITIONAL.has(t.text)))
  const px = new PixelCallable(width, height)
  const memo = new Map<number, [number, number, number, number]>()
  return (x, y, r, g, b, a) => {
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
    if (!positional) {
      const hit = memo.get(key)
      if (hit) return hit
    }
    px.x = x; px.y = y; px.r = r; px.g = g; px.b = b; px.a = a
    const out: [number, number, number, number] = [
      alphaOnly ? r : channel(compiled[0]!.evaluate(px)),
      alphaOnly ? g : channel(compiled[1]!.evaluate(px)),
      alphaOnly ? b : channel(compiled[2]!.evaluate(px)),
      channel(compiled[3]!.evaluate(px)),
    ]
    if (!positional) memo.set(key, out)
    return out
  }
}

/**
 * `utils::parenthetical_split(args, ',', "([", ")]")`: the formulas of `~CHAN`/`~ADJUST_ALPHA`, split on the
 * commas outside parentheses and brackets.
 */
export function splitFormulas(args: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(args.slice(start).trim())
  return out.filter((s) => s !== '')
}
