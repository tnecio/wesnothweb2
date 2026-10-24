import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { hexLighting, hexLightmap, LIGHTMAP_IMAGES, worldLightmap } from '../src/lighting'
import { mask, type Raster } from '../src/images/surfaceOps'

const images = join(dirname(fileURLToPath(import.meta.url)), '../../../wesnoth/data/core/images')
const read = (p: string): Raster => {
  const png = PNG.sync.read(readFileSync(join(images, p)))
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }
}
const hexMask = read('terrain/alphamask.png')
/** A light image as `get_surface(.., HEXED)` gives it: masked to the hex. */
const lightImage = (name: string) => {
  const r = read(name)
  mask(r, hexMask, 0, 0)
  return r
}

const dusk = { red: -25, green: -25, blue: 0 }
const night = { red: -75, green: -45, blue: -13 }
const noon = { red: 0, green: 0, blue: 0 }

describe('hexLighting (display::get_terrain_images)', () => {
  it('a hex lit as its neighbours: one (-1, halved colour), none at noon', () => {
    expect(hexLighting(dusk, Array(6).fill(dusk))).toEqual([{ l: -1, r: -12, g: -12, b: 0 }])
    expect(hexLighting(noon, Array(6).fill(noon))).toEqual([])
  })

  it('a hex beside a differently lit neighbour: its own colour, then a transition from that side', () => {
    const around = [night, noon, noon, noon, noon, noon]
    const list = hexLighting(noon, around)
    expect(list[0]).toEqual({ l: 0, r: 0, g: 0, b: 0 })
    // The north neighbour: convex 1 at d=0 (N vs NE) and convex 2 at d=5 (NW vs N).
    expect(list.slice(1).map((a) => a.l)).toEqual([7, 18])
    expect(list.slice(1).every((a) => a.r === -37 && a.g === -22 && a.b === -6)).toBe(true)
  })

  it('[color_adjust] is added to every colour', () => {
    expect(hexLighting(noon, Array(6).fill(noon), { red: 10, green: 0, blue: -4 })).toEqual([{ l: -1, r: 5, g: 0, b: -2 }])
  })
})

describe('hexLightmap (apply_light)', () => {
  it('lit evenly: the lightmap value 128 + the halved colour, which light_surface doubles', () => {
    expect(hexLightmap(hexLighting(dusk, Array(6).fill(dusk)), lightImage)).toEqual({ flat: [116, 116, 128] })
  })

  it('beside the dark north neighbour: its own light in the middle, darker towards the north edge', () => {
    const lm = hexLightmap(hexLighting(noon, [night, noon, noon, noon, noon, noon]), lightImage) as Raster
    expect(LIGHTMAP_IMAGES).toHaveLength(19)
    const at = (x: number, y: number) => lm.data[(y * 72 + x) * 4]!
    expect(at(36, 36)).toBe(128)
    expect(at(36, 2)).toBeLessThan(128)
  })
})

describe('worldLightmap', () => {
  it('puts each hex, hex-shaped, at its place; neutral elsewhere', () => {
    const world = worldLightmap([{ left: 0, top: 0, lightmap: { flat: [100, 110, 120] } }], hexMask, 0, 0, 80, 80)
    const at = (x: number, y: number) => Array.from(world.data.slice((y * 80 + x) * 4, (y * 80 + x) * 4 + 3))
    expect(at(36, 36)).toEqual([100, 110, 120])
    expect(at(1, 1)).toEqual([128, 128, 128])
    expect(at(78, 78)).toEqual([128, 128, 128])
  })
})
