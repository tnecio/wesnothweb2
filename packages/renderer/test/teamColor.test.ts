import { describe, expect, it } from 'vitest'
import {
  applyColorMapping,
  generateColorMapping,
  packRgb,
  type ColorRange,
  type Rgb,
} from '../src/images/teamColor'

describe('packRgb', () => {
  it('packs 8-bit RGB into a single integer', () => {
    expect(packRgb(0, 0, 0)).toBe(0)
    expect(packRgb(255, 255, 255)).toBe(0xffffff)
    expect(packRgb(0x12, 0x34, 0x56)).toBe(0x123456)
  })
})

describe('generateColorMapping', () => {
  // A red-ish range, distinct from the reference magenta palette.
  const redRange: ColorRange = {
    mid: [200, 0, 0],
    max: [255, 150, 150],
    min: [100, 0, 0],
    rep: [200, 0, 0],
  }

  it('produces one mapping entry per palette colour', () => {
    const palette: Rgb[] = [
      [255, 0, 255],   // reference (brightest-ish, used to compute referenceAvg)
      [128, 0, 128],
      [0, 0, 0],
    ]
    const map = generateColorMapping(redRange, palette)
    expect(map.size).toBe(palette.length)
  })

  it('maps darker-than-reference colours toward min, via mid', () => {
    // reference avg = avg(255,0,255) = floor(510/3) = 170
    const palette: Rgb[] = [
      [255, 0, 255],  // avg 170 (reference itself: oldAvg === referenceAvg -> t=1 -> mid)
      [0, 0, 0],      // avg 0 (darkest -> min)
    ]
    const map = generateColorMapping(redRange, palette)

    const refMapped = map.get(packRgb(255, 0, 255))
    expect(refMapped).toBe(packRgb(...redRange.mid))

    const darkMapped = map.get(packRgb(0, 0, 0))
    expect(darkMapped).toBe(packRgb(...redRange.min))
  })

  it('maps lighter-than-reference colours toward max', () => {
    const palette: Rgb[] = [
      [100, 0, 100],  // avg 66, below reference(170) - not this case
      [255, 255, 255], // avg 255, above reference -> interpolates toward max
    ]
    const map = generateColorMapping(redRange, palette)
    const lightMapped = map.get(packRgb(255, 255, 255))
    // t = (255-255)/(255-170) = 0 -> pure max
    expect(lightMapped).toBe(packRgb(...redRange.max))
  })

  it('is deterministic for the same inputs', () => {
    const palette: Rgb[] = [[255, 0, 255], [10, 10, 10]]
    const a = generateColorMapping(redRange, palette)
    const b = generateColorMapping(redRange, palette)
    expect([...a.entries()]).toEqual([...b.entries()])
  })
})

describe('applyColorMapping', () => {
  it('remaps exact palette matches in RGBA data', () => {
    const map = new Map<number, number>([[packRgb(255, 0, 255), packRgb(10, 20, 30)]])
    const data = new Uint8ClampedArray([255, 0, 255, 255])
    applyColorMapping(data, map)
    expect([...data]).toEqual([10, 20, 30, 255])
  })

  it('leaves fully transparent pixels untouched', () => {
    const map = new Map<number, number>([[packRgb(255, 0, 255), packRgb(10, 20, 30)]])
    const data = new Uint8ClampedArray([255, 0, 255, 0])
    applyColorMapping(data, map)
    expect([...data]).toEqual([255, 0, 255, 0])
  })

  it('leaves non-matching colours untouched', () => {
    const map = new Map<number, number>([[packRgb(255, 0, 255), packRgb(10, 20, 30)]])
    const data = new Uint8ClampedArray([1, 2, 3, 255])
    applyColorMapping(data, map)
    expect([...data]).toEqual([1, 2, 3, 255])
  })

  it('is a no-op for an empty mapping', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 255])
    applyColorMapping(data, new Map())
    expect([...data]).toEqual([1, 2, 3, 255])
  })
})
