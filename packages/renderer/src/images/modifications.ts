/**
 * Phase 27c S1: the image path functions (`image_modifications.cpp`) that work on pixels, as one pure
 * dispatcher over a {@link Raster}. The compositor runs every op here except its own pseudo-ops (GLOBAL,
 * HEXED); the oracle test (`test/imageOracle.test.ts`) runs the same code in Node against the C++ engine's
 * output. Nested image references (MASK, BLIT, L) are loaded through the context, so the caller decides how.
 *
 * Arguments are read as upstream's parsers read them (`utils::from_chars`: a leading number, trailing text
 * ignored), and an op upstream's parser rejects is skipped, as upstream skips it.
 */
import { parseIpf, splitRef, type IpfOp } from './ipf'
import type { Rgb } from './teamColor'
import {
  adjustColor, alphaToGreyscale, background, blend, blitBlend, blurAlpha, channelIndex, cropTransparency, cut,
  flip, greyscale, light, mapPixels, mask, monochrome, negative, opacity, pad, recolor, rotate, scaleSurface,
  scaleSurfaceLegacy, scaleSurfaceSharp, sepia, swapChannels, wipeAlpha, type Raster,
} from './surfaceOps'
import { pixelFunction, splitFormulas } from './pixelFormula'
import { xbrzScale } from './xbrz'
import { applyTodTint } from '../animation/timeOfDay'

/** What the modifications need from their caller. */
export interface ModificationContext {
  /**
   * A nested image reference (with its own modifications) as pixels, or null when it does not load. `straight`:
   * the colour of translucent pixels matters even where alpha is low (a lightmap), so a premultiplying decoder
   * must not round it away.
   */
  loadRaster(ref: string, straight?: boolean): Promise<Raster | null>
  /** `~TC(side, palette)`'s colour map, or null without colour data. */
  tcMapping(side: number, palette: string): Map<number, number> | null
  /** `~RC(palette>range)`'s colour map, or null. */
  rcMapping(spec: string): Map<number, number> | null
  /** A named `[color_palette]`, or undefined. */
  palette(name: string): Rgb[] | undefined
}

/**
 * Ops that make the colour of translucent (even fully transparent) pixels visible, so their source must be
 * decoded without premultiplying (`Compositor`'s straight decode).
 */
export const STRAIGHT_OPS: ReadonlySet<string> = new Set(['WIPE_ALPHA', 'SWAP', 'CHAN', 'ADJUST_ALPHA', 'PLOT_ALPHA'])

/** The ops {@link applyModification} handles; anything else is the compositor's (or unknown). */
export const PIXEL_OPS: ReadonlySet<string> = new Set([
  'NOP', 'NO_TOD_SHIFT', 'RIGHT', 'CROP', 'MASK', 'BLIT', 'O', 'FL', 'SCALE', 'SCALE_SHARP', 'SCALE_INTO',
  'SCALE_INTO_SHARP', 'TC', 'RC', 'PAL', 'TOD', 'ROTATE', 'GS', 'CROP_TRANSPARENCY', 'BW', 'SEPIA', 'NEG',
  'PLOT_ALPHA', 'WIPE_ALPHA', 'ADJUST_ALPHA', 'CHAN', 'CS', 'R', 'G', 'B', 'BLEND', 'L', 'XBRZ', 'PAD', 'BL', 'BG',
  'SWAP',
])

/**
 * `modification_queue`: the recolourings (`rc_modification`: ~TC, ~RC, ~PAL) have priority 1 and run before
 * every other function, wherever they are in the chain; the rest keep their order.
 */
export function modificationOrder<T extends { name: string }>(ops: readonly T[]): T[] {
  const first = (op: T) => op.name === 'TC' || op.name === 'RC' || op.name === 'PAL'
  return [...ops.filter(first), ...ops.filter((op) => !first(op))]
}

/**
 * `utils::from_chars<int>`: leading spaces and a `+` are skipped, then the longest integer prefix is read
 * (trailing text is ignored); null for no number or one outside [min, max] (the target type's range).
 */
export function intArg(s: string | undefined, min = -2147483648, max = 2147483647): number | null {
  const m = /^-?\d+/.exec((s ?? '').replace(/^\s+/, '').replace(/^\+(?!-)/, ''))
  if (!m) return null
  const n = Number(m[0])
  return n < min || n > max ? null : n
}

/** `utils::from_chars<float>`, as {@link intArg}: the longest decimal prefix, as a C++ `float`. */
export function floatArg(s: string | undefined): number | null {
  const m = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec((s ?? '').replace(/^\s+/, '').replace(/^\+(?!-)/, ''))
  return m ? Math.fround(Number(m[0])) : null
}

/** A `float` argument that may be a percentage (`~O`, `~BLEND`): `50%` is 0.5. */
function fractionArg(s: string): number {
  const percent = s.indexOf('%')
  return percent < 0 ? floatArg(s) ?? 0 : Math.fround((floatArg(s.slice(0, percent)) ?? 0) / 100)
}

/** The `PAD` parser: `[top, right, bottom, left]`, or null for arguments upstream rejects. */
export function padArgs(args: string): [number, number, number, number] | null {
  if (args.includes('=')) {
    const sides: [number, number, number, number] = [0, 0, 0, 0]
    const index: Record<string, number> = { top: 0, t: 0, right: 1, r: 1, bottom: 2, b: 2, left: 3, l: 3 }
    for (const part of args.split(',')) {
      if (part.trim() === '') continue
      const eq = part.indexOf('=')
      const key = (eq < 0 ? part : part.slice(0, eq)).trim()
      const value = eq < 0 ? null : intArg(part.slice(eq + 1).trim())
      const i = index[key]
      if (i === undefined || value === null) return null
      sides[i] = value
    }
    return sides
  }
  const parts = args.split(',').map((s) => s.trim()).filter(Boolean)
  const n = parts.length === 1 ? intArg(parts[0]) : null
  return n === null ? null : [n, n, n, n]
}

/**
 * The size `~SCALE`, `~SCALE_SHARP`, `~SCALE_INTO` and `~SCALE_INTO_SHARP` give a `srcW`x`srcH` image
 * (`parse_scale_args` and `scale_modification::operator()`): each dimension is pixels, or a percentage of the
 * original with `%`; 0 (or a negative or missing one) keeps the original; the `_INTO` forms fit the image
 * inside that box, keeping its aspect ratio. Null when no argument is given.
 */
export function scaledSize(args: readonly string[], srcW: number, srcH: number, preserveAspect: boolean): [number, number] | null {
  if (args.length === 0 || (args.length === 1 && args[0]!.trim() === '')) return null
  const dim = (arg: string | undefined, original: number): number => {
    const s = (arg ?? '').trim()
    const relative = s.includes('%')
    const n = intArg(relative ? s.slice(0, s.lastIndexOf('%')) : s) ?? 0
    if (n <= 0) return original
    return relative ? Math.trunc(original * (n / 100)) : n
  }
  let w = dim(args[0], srcW)
  let h = dim(args[1], srcH)
  if (preserveAspect) {
    const ratio = Math.min(w / srcW, h / srcH)
    w = Math.trunc(srcW * ratio)
    h = Math.trunc(srcH * ratio)
  }
  return w > 0 && h > 0 ? [w, h] : null
}

/** `game_config::tc_info`: a `[color_palette]` by name, else a comma-separated list of hex colours. */
function paletteColors(ctx: ModificationContext, name: string): Rgb[] | null {
  const named = ctx.palette(name)
  if (named) return named
  const colors: Rgb[] = []
  for (const s of name.split(',').map((c) => c.trim()).filter(Boolean)) {
    const hex = s.replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
    const n = parseInt(hex, 16)
    colors.push([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
  }
  return colors
}

/**
 * Apply one image path function to `src` (which it may change in place) and return the result. An op that is
 * not in {@link PIXEL_OPS}, or that upstream's parser would reject, returns `src` unchanged.
 */
export async function applyModification(src: Raster, op: IpfOp, ctx: ModificationContext): Promise<Raster> {
  const { name, args } = op
  /** The arguments as one string, as upstream's parsers receive them (ours were split on top-level commas). */
  const raw = args.join(',')
  const noArgs = args.length === 0 || (args.length === 1 && args[0] === '')

  switch (name) {
    // Upstream's parsers return no modification for these: NO_TOD_SHIFT only tags a terrain or overlay image
    // the board must not tint by time of day (display.cpp), RIGHT is an old GUI2 portrait marker.
    case 'NOP':
    case 'NO_TOD_SHIFT':
    case 'RIGHT':
      return src

    // ~CROP(x,y,w,h): `cut_surface`, transparent outside the image; a zero or missing size keeps the image's.
    case 'CROP': {
      if (noArgs) return src
      const x = intArg(args[0], -32768, 32767) ?? 0
      const y = intArg(args[1], -32768, 32767) ?? 0
      const w = intArg(args[2], 0, 65535) || src.width
      const h = intArg(args[3], 0, 65535) || src.height
      return cut(src, x, y, w, h)
    }

    // ~MASK(ref[,x,y]): each alpha becomes the smaller of the image's and the mask's (`mask_surface`) -- not
    // canvas's 'destination-in', a product, which differs wherever both are partly transparent (antialiased
    // edges, water overlays, fords). A negative position makes upstream drop the function.
    case 'MASK': {
      if (noArgs) return src
      const x = args.length === 3 ? intArg(args[1]) ?? 0 : 0
      const y = args.length === 3 ? intArg(args[2]) ?? 0 : 0
      if (x < 0 || y < 0) return src
      const maskImage = await ctx.loadRaster(args[0]!)
      if (!maskImage) return src
      mask(src, maskImage, x, y)
      return src
    }

    // ~BLIT(ref[,x,y]): another image drawn over this one (SDL's alpha blit); upstream refuses one entirely
    // outside the image.
    case 'BLIT': {
      if (noArgs || args.length > 3) return src
      const x = args.length === 3 ? intArg(args[1]) ?? 0 : 0
      const y = args.length === 3 ? intArg(args[2]) ?? 0 : 0
      const top = await ctx.loadRaster(args[0]!)
      if (!top) return src
      if (x >= src.width || y >= src.height || top.width + x < 0 || top.height + y < 0) return src
      blitBlend(src, top, x, y)
      return src
    }

    // ~O(opacity): alpha times `float_to_color(opacity)` (truncating n*256, so 0.16 gives 40, not 41), by
    // `color_multiply`, an integer a*b/255.
    case 'O': {
      const value = fractionArg(raw)
      if (value >= 1) return src
      opacity(src, value)
      return src
    }

    // ~FL([horiz|vert]): flip; no argument means horizontal.
    case 'FL':
      return flip(src, raw === '' || raw.includes('horiz'), raw.includes('vert'))

    // ~SCALE / ~SCALE_INTO: `scale_surface_legacy`; the _SHARP forms: `scale_surface_sharp`.
    case 'SCALE':
    case 'SCALE_SHARP':
    case 'SCALE_INTO':
    case 'SCALE_INTO_SHARP': {
      const size = scaledSize(args, src.width, src.height, name.startsWith('SCALE_INTO'))
      if (!size) return src
      return name.endsWith('SHARP') ? scaleSurfaceSharp(src, size[0], size[1]) : scaleSurfaceLegacy(src, size[0], size[1])
    }

    // ~TC(side, palette): `palette` to the side's team colour; ~RC(palette>range): to a named colour range;
    // ~PAL(from>to): one palette onto another, colour by colour (`recolor_image`).
    case 'TC':
    case 'RC':
    case 'PAL': {
      let map: Map<number, number> | null
      if (name === 'PAL') {
        const [from, to] = raw.split('>').map((s) => s.trim())
        const a = from ? paletteColors(ctx, from) : null
        const b = to ? paletteColors(ctx, to) : null
        if (!a || !b) return src
        map = new Map()
        for (let i = 0; i < a.length && i < b.length; i++) {
          map.set((a[i]![0] << 16) | (a[i]![1] << 8) | a[i]![2], (b[i]![0] << 16) | (b[i]![1] << 8) | b[i]![2])
        }
      } else {
        map = name === 'TC' ? ctx.tcMapping(Number(args[0]), args[1] ?? 'magenta') : ctx.rcMapping(args[0] ?? '')
      }
      if (map) recolor(src, map)
      return src
    }

    // ~TOD(r,g,b): the compositor's own additive time-of-day tint (see `todRef`), not an upstream function.
    case 'TOD': {
      const [r, g, b] = args.map(Number)
      if (![r, g, b].every(Number.isFinite)) return src
      applyTodTint(src.data, { r: r!, g: g!, b: b! })
      return src
    }

    // ~ROTATE([degrees[,zoom[,offset]]]): 90 by default, zoom 16, offset 8.
    case 'ROTATE': {
      const p = args.filter((a) => a !== '')
      if (p.length > 3) return src
      const degrees = p.length > 0 ? intArg(p[0]) ?? 0 : 90
      const zoom = p.length > 1 ? intArg(p[1]) ?? 0 : 16
      const offset = p.length > 2 ? intArg(p[2]) ?? 0 : 8
      return rotate(src, degrees, zoom, offset)
    }

    case 'GS':
      greyscale(src)
      return src

    case 'CROP_TRANSPARENCY':
      return cropTransparency(src)

    // ~BW(threshold): exactly one argument, 0 to 255.
    case 'BW': {
      const threshold = args.length === 1 ? intArg(args[0]) : null
      if (threshold === null || threshold < 0 || threshold > 255) return src
      monochrome(src, threshold)
      return src
    }

    case 'SEPIA':
      sepia(src)
      return src

    // ~NEG([threshold] | [r,g,b]): thresholds -1 (invert all) to 255.
    case 'NEG': {
      const p = args.filter((a) => a !== '')
      let t: (number | null)[]
      if (p.length === 0) t = [-1, -1, -1]
      else if (p.length === 1) t = [intArg(p[0]), intArg(p[0]), intArg(p[0])]
      else if (p.length === 3) t = p.map((a) => intArg(a))
      else return src
      if (t.some((v) => v === null || v < -1 || v > 255)) return src
      negative(src, t[0]!, t[1]!, t[2]!)
      return src
    }

    case 'PLOT_ALPHA':
      alphaToGreyscale(src)
      return src

    case 'WIPE_ALPHA':
      wipeAlpha(src)
      return src

    // ~ADJUST_ALPHA(formula) and ~CHAN(r[,g[,b[,a]]]): WFL per pixel. A formula that fails to parse or to
    // evaluate throws upstream too, which drops the image function.
    case 'ADJUST_ALPHA':
    case 'CHAN': {
      const formulas = splitFormulas(raw)
      if (name === 'ADJUST_ALPHA' ? formulas.length !== 1 : formulas.length < 1 || formulas.length > 4) return src
      const out: Raster = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) }
      try {
        mapPixels(out, pixelFunction(formulas, src.width, src.height, name === 'ADJUST_ALPHA'))
      } catch (err) {
        console.warn(`[ImageCache] ~${name}(${raw}):`, err)
        return src
      }
      return out
    }

    // ~CS(r[,g[,b]]) and its single-channel forms ~R(n), ~G(n), ~B(n).
    case 'CS':
    case 'R':
    case 'G':
    case 'B': {
      let rgb: number[]
      if (name === 'CS') {
        if (noArgs) return src
        rgb = [0, 1, 2].map((i) => intArg(args[i]) ?? 0)
      } else {
        const n = intArg(raw) ?? 0
        rgb = [name === 'R' ? n : 0, name === 'G' ? n : 0, name === 'B' ? n : 0]
      }
      adjustColor(src, rgb[0]!, rgb[1]!, rgb[2]!)
      return src
    }

    // ~BLEND(r,g,b,opacity): opacity a fraction or a percentage.
    case 'BLEND':
      if (args.length !== 4) return src
      blend(src, fractionArg(args[3]!), intArg(args[0]) ?? 0, intArg(args[1]) ?? 0, intArg(args[2]) ?? 0)
      return src

    // ~L(lightmap): `light_surface`, with the lightmap scaled to the image first.
    case 'L': {
      if (raw === '') return src
      const lightmap = await ctx.loadRaster(raw, true)
      if (!lightmap) return src
      light(src, scaleSurface(lightmap, src.width, src.height))
      return src
    }

    // ~XBRZ(n): xBRZ upscaling by 1 to 6.
    case 'XBRZ': {
      const z = Math.min(6, Math.max(1, intArg(raw) ?? 1))
      return z === 1 ? src : xbrzScale(src, z)
    }

    // ~PAD(n) or ~PAD(top=,right=,bottom=,left=) (also t, r, b, l).
    case 'PAD': {
      const sides = padArgs(raw)
      return sides ? pad(src, sides[0], sides[1], sides[2], sides[3]) : src
    }

    // ~BL(depth): blur.
    case 'BL':
      blurAlpha(src, Math.max(0, intArg(raw) ?? 0))
      return src

    // ~BG([r[,g[,b[,a]]]]): the image over a solid colour, opaque black by default.
    case 'BG': {
      const c = [0, 0, 0, 255]
      args.slice(0, 4).forEach((a, i) => { c[i] = intArg(a) ?? 0 })
      return background(src, c[0]!, c[1]!, c[2]!, c[3]!)
    }

    // ~SWAP(r,g,b[,a]): each output channel takes the named one.
    case 'SWAP': {
      if (args.length !== 3 && args.length !== 4) return src
      const ch = [...args, 'alpha'].slice(0, 4).map(channelIndex)
      if (ch.some((c) => c < 0)) return src
      swapChannels(src, ch[0]!, ch[1]!, ch[2]!, ch[3]!)
      return src
    }
  }
  return src
}

/**
 * Resolve a whole reference -- `path~MOD()~MOD()` -- with pure pixel code: `load` decodes a file, and nested
 * references resolve through this same function. What the oracle test uses; the compositor has its own loop
 * (canvases, workers, bundles) around the same {@link applyModification}.
 */
export async function resolveRaster(
  ref: string,
  load: (path: string) => Promise<Raster | null>,
  ctx: Omit<ModificationContext, 'loadRaster'>,
): Promise<Raster | null> {
  const { path, mods } = splitRef(ref)
  let image = await load(path)
  if (!image) return null
  const full: ModificationContext = { ...ctx, loadRaster: (r) => resolveRaster(r, load, ctx) }
  for (const op of modificationOrder(parseIpf(mods))) image = await applyModification(image, op, full)
  return image
}
