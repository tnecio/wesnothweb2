/**
 * Phase 27c S5: how upstream lights the map by time of day (`display::get_terrain_images` and
 * `image::apply_light`), as pixels -- no PixiJS here, `SnapshotBoard` puts the result on the board.
 *
 * Each hex is lit by its own time of day (`tod_manager::get_time_of_day(loc)`: the schedule, or the
 * `[time_area]` covering it -- illumination changes combat, not the picture), blending into a neighbour
 * lit differently through the `terrain/light/*` lightmaps. A hex's lighting is a list of `light_adjust`s:
 * one `(-1, colour)` for a hex lit evenly, else the whole hex's colour `(0, ...)` followed by the
 * directional transitions. `apply_light` turns the list into a lightmap -- each light image shifted by its
 * colour (halved, `light_adjust`'s constructor) and blitted over the first -- and `light_surface` shifts every
 * pixel of the hex's terrain images by `(lightmap - 128) * 2`. A hex lit evenly is shifted by twice the
 * halved colour (`adjust_surface_color(r * 2)`), so an odd colour loses one.
 *
 * `worldLightmap` puts every hex's lightmap side by side, hex-shaped, over the whole board: the value the
 * board's lighting filter adds, `(value - 128) * 2`, to the terrain and items under each pixel.
 */
import { adjustColor, blitBlend, makeRaster, type Raster } from './images/surfaceOps'

/** A time of day's `red=`/`green=`/`blue=`. */
export interface TodShift {
  readonly red: number
  readonly green: number
  readonly blue: number
}

/** `image::light_adjust`: the lightmap image index (-1 for none) and the colour, halved and clamped to int8. */
export interface LightAdjust {
  readonly l: number
  readonly r: number
  readonly g: number
  readonly b: number
}

const half = (v: number) => Math.max(-128, Math.min(127, Math.trunc(v / 2)))

export function lightAdjust(op: number, r: number, g: number, b: number): LightAdjust {
  return { l: op, r: half(r), g: half(g), b: half(b) }
}

const same = (a: TodShift, b: TodShift) => a.red === b.red && a.green === b.green && a.blue === b.blue
const plus = (a: TodShift, b: TodShift): TodShift => ({ red: a.red + b.red, green: a.green + b.green, blue: a.blue + b.blue })

/**
 * `display::get_terrain_images`' lighting: for a hex lit by `tod` whose neighbours (N, NE, SE, S, SW, NW --
 * `get_adjacent_tiles`' order) are lit by `around`, with `[color_adjust]`'s `adjust` added to every colour.
 */
export function hexLighting(tod: TodShift, around: readonly TodShift[], adjust: TodShift = { red: 0, green: 0, blue: 0 }): LightAdjust[] {
  const lighting: LightAdjust[] = []
  const whole = () => {
    if (lighting.length === 0) {
      const col = plus(tod, adjust)
      lighting.push(lightAdjust(0, col.red, col.green, col.blue))
    }
  }
  const push = (op: number, c: TodShift) => {
    const col = plus(c, adjust)
    lighting.push(lightAdjust(op, col.red, col.green, col.blue))
  }
  // concave: both neighbours of a corner lit alike, and not as this hex
  for (let d = 0; d < 6; d++) {
    const a1 = around[d]!, a2 = around[(d + 1) % 6]!
    if (same(a1, tod) || same(a2, tod) || !same(a1, a2)) continue
    whole()
    push(d + 1, a1)
  }
  // convex 1: the first neighbour lit otherwise than this hex and the second
  for (let d = 0; d < 6; d++) {
    const a1 = around[d]!, a2 = around[(d + 1) % 6]!
    if (same(a1, tod) || same(a1, a2)) continue
    whole()
    push(d + 7, a1)
  }
  // convex 2: the second neighbour lit otherwise than this hex and the first
  for (let d = 0; d < 6; d++) {
    const a1 = around[d]!, a2 = around[(d + 1) % 6]!
    if (same(a2, tod) || same(a1, a2)) continue
    whole()
    push(d + 13, a2)
  }
  if (lighting.length === 0) {
    const col = plus(tod, adjust)
    if (col.red !== 0 || col.green !== 0 || col.blue !== 0) lighting.push(lightAdjust(-1, col.red, col.green, col.blue))
  }
  return lighting
}

const P = 'terrain/light/light'
/** `apply_light`'s `lm_img`: the lightmap image of each `light_adjust.l`. */
export const LIGHTMAP_IMAGES: readonly string[] = [
  `${P}.png`,
  `${P}-concave-2-tr.png`, `${P}-concave-2-r.png`, `${P}-concave-2-br.png`,
  `${P}-concave-2-bl.png`, `${P}-concave-2-l.png`, `${P}-concave-2-tl.png`,
  `${P}-convex-br-bl.png`, `${P}-convex-bl-l.png`, `${P}-convex-l-tl.png`,
  `${P}-convex-tl-tr.png`, `${P}-convex-tr-r.png`, `${P}-convex-r-br.png`,
  `${P}-convex-l-bl.png`, `${P}-convex-tl-l.png`, `${P}-convex-tr-tl.png`,
  `${P}-convex-r-tr.png`, `${P}-convex-br-r.png`, `${P}-convex-bl-br.png`,
]

/** A hex's lightmap: its pixels, or one value for the whole hex (a hex lit evenly, or not at all). */
export type HexLightmap = Raster | { readonly flat: readonly [number, number, number] }

/**
 * `apply_light`'s lightmap for `list` (from `hexLighting`). `lightImage(name)` gives a light image as the
 * board's hex images are (`get_surface(.., HEXED)`), 72x72; `null` while not loaded.
 */
export function hexLightmap(list: readonly LightAdjust[], lightImage: (name: string) => Raster | null): HexLightmap | null {
  if (list.length === 0) return { flat: [128, 128, 128] }
  if (list.length === 1) {
    // `adjust_surface_color(surf, r * m)` with m = 2 for no lightmap: as a lightmap value, 128 + r.
    const a = list[0]!
    return { flat: [128 + a.r, 128 + a.g, 128 + a.b] }
  }
  let base: Raster | null = null
  for (const adj of list) {
    const img = lightImage(LIGHTMAP_IMAGES[adj.l] ?? '')
    if (!img) return null
    const lit: Raster = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
    adjustColor(lit, adj.r, adj.g, adj.b)
    if (!base) base = lit
    else blitBlend(base, lit, 0, 0)
  }
  return base
}

/** One hex of the board for `worldLightmap`: its top-left in world pixels, and its lightmap. */
export interface PlacedLightmap {
  readonly left: number
  readonly top: number
  readonly lightmap: HexLightmap
}

/**
 * Every hex's lightmap put on one world-sized raster (`width` x `height`, world pixel (0,0) at `originX`,
 * `originY`), each cut to its hex by `hexMask` (`terrain/alphamask.png`): the pixels where the mask is at least
 * half opaque. Pixels no hex covers stay neutral (128).
 */
export function worldLightmap(hexes: readonly PlacedLightmap[], hexMask: Raster, originX: number, originY: number, width: number, height: number): Raster {
  const out = makeRaster(width, height)
  out.data.fill(128)
  const m = hexMask.data
  for (const { left, top, lightmap } of hexes) {
    const flat = 'flat' in lightmap ? lightmap.flat : null
    const pix = 'flat' in lightmap ? null : lightmap.data
    for (let y = 0; y < hexMask.height; y++) {
      const wy = top - originY + y
      if (wy < 0 || wy >= height) continue
      for (let x = 0; x < hexMask.width; x++) {
        const wx = left - originX + x
        if (wx < 0 || wx >= width) continue
        const mi = (y * hexMask.width + x) * 4
        if (m[mi + 3]! < 128) continue
        const o = (wy * width + wx) * 4
        if (flat) {
          out.data[o] = flat[0]; out.data[o + 1] = flat[1]; out.data[o + 2] = flat[2]
        } else {
          out.data[o] = pix![mi]!; out.data[o + 1] = pix![mi + 1]!; out.data[o + 2] = pix![mi + 2]!
        }
        out.data[o + 3] = 255
      }
    }
  }
  return out
}
