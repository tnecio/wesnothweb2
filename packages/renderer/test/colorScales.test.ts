import { describe, expect, it } from 'vitest'
import { RED_GREEN_SCALE, RED_GREEN_SCALE_TEXT, redToGreen } from '../src/colorScales'

describe('redToGreen (game_config::red_to_green)', () => {
  it('carries both upstream palettes in full', () => {
    expect(RED_GREEN_SCALE).toHaveLength(121)
    expect(RED_GREEN_SCALE_TEXT).toHaveLength(121)
  })
  it('maps the bugs6.md reference points: 30% orange-red, 50% yellow, 70% yellow-green', () => {
    expect(redToGreen(30)).toBe(0xff8000)
    expect(redToGreen(50)).toBe(0xffff00)
    expect(redToGreen(70)).toBe(0x80ff00)
  })
  it('clamps to the ends of the scale', () => {
    expect(redToGreen(-10)).toBe(0xdf0000)
    expect(redToGreen(0)).toBe(0xdf0000)
    expect(redToGreen(100)).toBe(0x00df00)
    expect(redToGreen(150)).toBe(0x00df00)
  })
  it('uses the darker text palette on request', () => {
    expect(redToGreen(50, true)).toBe(0xdfdf00)
  })
})
