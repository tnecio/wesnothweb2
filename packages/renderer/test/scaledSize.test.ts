import { describe, expect, it } from 'vitest'
import { scaledSize } from '../src/images/compositor'

describe('scaledSize (upstream parse_scale_args + scale_modification)', () => {
  it('takes pixels, or a percentage of the original', () => {
    expect(scaledSize(['144', '144'], 72, 72, false)).toEqual([144, 144])
    expect(scaledSize(['200%', '200%'], 72, 72, false)).toEqual([144, 144])
    expect(scaledSize(['50%', '10'], 72, 60, false)).toEqual([36, 10])
  })

  it('keeps the original for 0 or a missing dimension', () => {
    expect(scaledSize(['0', '30'], 72, 60, false)).toEqual([72, 30])
    expect(scaledSize(['30'], 72, 60, false)).toEqual([30, 60])
  })

  it('fits inside the box, keeping the aspect ratio, for the _INTO forms', () => {
    expect(scaledSize(['16', '16'], 30, 20, true)).toEqual([16, 10])
    expect(scaledSize(['16', '16'], 60, 60, true)).toEqual([16, 16])
  })

  it('does nothing without arguments', () => {
    expect(scaledSize([''], 72, 72, false)).toBeNull()
    expect(scaledSize([], 72, 72, false)).toBeNull()
  })
})
