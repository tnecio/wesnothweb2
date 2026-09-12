/**
 * Team colouring — a port of Wesnoth's `recolor_palette` / `generate_color_mapping`
 * (src/color_range.cpp).
 *
 * Unit art is drawn in a reference palette (magenta by default); the engine
 * recolours those exact palette entries to the side's colour range at draw time.
 * That recolouring is *not* part of the animation frame's modifier string, so
 * without applying it here every unit renders magenta.
 *
 * The mapping is per (palette, range) pair and tiny (a few dozen entries), so it
 * is computed once and reused across every frame of every unit on that side.
 *
 * Ported verbatim from attempt #1
 * (wesnothweb/frontend/src/board/images/teamColor.ts) — pure math, no
 * WASM/worker-protocol dependency.
 */

export type Rgb = [number, number, number]

export interface ColorRange {
  mid: Rgb
  max: Rgb
  min: Rgb
  rep: Rgb
}

export interface ColorData {
  /** Reference palettes by name, e.g. "magenta". */
  palettes: Record<string, Rgb[]>
  /** Colour range per 1-based side number. */
  sideRanges: Record<number, ColorRange>
  /** Named colour ranges, for ~RC(palette>range). */
  ranges: Record<string, ColorRange>
  /** The `default=yes`-marked `[color_range]` ids, in file order -- `game_config::default_colors`. See `resolveSideColorId`. */
  defaultColors: readonly string[]
}

/** Pack an 8-bit RGB triple into a single integer key. */
export function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b
}

const clamp255 = (v: number) => (v > 255 ? 255 : v < 0 ? 0 : v | 0)

/**
 * Port of `recolor_palette()`.
 *
 * Each source colour is placed on a light/dark axis relative to the palette's
 * *first* entry, then interpolated between the range's min/mid/max accordingly.
 */
function recolorPalette(range: ColorRange, oldRgb: Rgb[]): Rgb[] {
  const out: Rgb[] = []
  const [midR, midG, midB] = range.mid
  const [maxR, maxG, maxB] = range.max
  const [minR, minG, minB] = range.min

  const referenceAvg = oldRgb.length === 0
    ? 255
    : Math.floor((oldRgb[0]![0] + oldRgb[0]![1] + oldRgb[0]![2]) / 3)

  for (const [r, g, b] of oldRgb) {
    const oldAvg = Math.floor((r + g + b) / 3)

    if (referenceAvg !== 0 && oldAvg <= referenceAvg) {
      const t = oldAvg / referenceAvg
      out.push([
        clamp255(t * midR + (1 - t) * minR),
        clamp255(t * midG + (1 - t) * minG),
        clamp255(t * midB + (1 - t) * minB),
      ])
    } else if (referenceAvg !== 255) {
      const t = (255 - oldAvg) / (255 - referenceAvg)
      out.push([
        clamp255(t * midR + (1 - t) * maxR),
        clamp255(t * midG + (1 - t) * maxG),
        clamp255(t * midB + (1 - t) * maxB),
      ])
    } else {
      // Matches the C++: neither branch taken means no entry is emitted, but the
      // caller pairs by index, so keep the slot with the original colour.
      out.push([r, g, b])
    }
  }

  return out
}

/** Port of `generate_color_mapping()`: packed old RGB → packed new RGB. */
export function generateColorMapping(range: ColorRange, oldRgb: Rgb[]): Map<number, number> {
  const newRgb = recolorPalette(range, oldRgb)
  const map = new Map<number, number>()
  for (let i = 0; i < oldRgb.length && i < newRgb.length; i++) {
    const [orr, og, ob] = oldRgb[i]!
    const [nr, ng, nb] = newRgb[i]!
    map.set(packRgb(orr, og, ob), packRgb(nr, ng, nb))
  }
  return map
}

/**
 * Apply a colour mapping in place over RGBA pixel data.
 * Only exact palette matches are remapped, which is what Wesnoth does.
 */
export function applyColorMapping(data: Uint8ClampedArray, map: Map<number, number>): void {
  if (map.size === 0) return
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue   // fully transparent — nothing to recolour
    const hit = map.get(packRgb(data[i]!, data[i + 1]!, data[i + 2]!))
    if (hit === undefined) continue
    data[i]     = (hit >> 16) & 0xff
    data[i + 1] = (hit >> 8) & 0xff
    data[i + 2] = hit & 0xff
  }
}

/** The reference palette unit art is drawn in, when ~TC does not name one. */
export const DEFAULT_TC_PALETTE = 'magenta'

/**
 * Port of `team::get_side_color_id`/`get_side_color_id_from_config`: a
 * side's `[side] color=` value, if it names a real color_range id (e.g.
 * "red"); otherwise (blank, or a *numeric* value -- either a `color=N`
 * cross-reference to another side's color, or `Team.ts`'s own
 * `String(side)` placeholder default when no `color=` was set at all)
 * falls back to `defaultColors[side-1]` (the `default=yes`-marked
 * `[color_range]`s, in file order -- see `build-team-colors.mjs`).
 *
 * Deliberately simplified vs. upstream for the numeric-cross-reference
 * case: real Wesnoth recurses (`color=2` resolves to whatever side 2's OWN
 * color resolves to, which could itself be an explicit override), this
 * just indexes `defaultColors` directly by that number -- correct for the
 * overwhelming majority of real content (a numeric `color=` almost always
 * points at a side using its own default color), wrong only if that
 * *target* side also has its own explicit non-default `color=` override.
 */
export function resolveSideColorId(color: string, side: number, defaultColors: readonly string[]): string {
  const trimmed = color.trim()
  const asNumber = Number(trimmed)
  if (trimmed !== '' && Number.isFinite(asNumber) && asNumber > 0) {
    return defaultColors[asNumber - 1] ?? trimmed
  }
  return trimmed || (defaultColors[side - 1] ?? '')
}
