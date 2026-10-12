import { describe, expect, it } from 'vitest'
import { floatArg, intArg, modificationOrder, padArgs } from '../src/images/modifications'
import { splitFormulas } from '../src/images/pixelFormula'

describe('image path function arguments (utils::from_chars and the parsers)', () => {
  it('reads a leading number and ignores what follows, as from_chars does', () => {
    expect(intArg(' +12px')).toBe(12)
    expect(intArg('-3')).toBe(-3)
    expect(intArg('x3')).toBeNull()
    expect(intArg('40000', -32768, 32767)).toBeNull()
    expect(floatArg('0.16')).toBe(Math.fround(0.16))
    expect(floatArg('.5x')).toBe(0.5)
  })

  it('PAD takes one size or keyword sides, and rejects anything else', () => {
    expect(padArgs('5')).toEqual([5, 5, 5, 5])
    expect(padArgs('top=3,l=10')).toEqual([3, 0, 0, 10])
    expect(padArgs('up=3')).toBeNull()
    expect(padArgs('3,4')).toBeNull()
  })

  it('runs the recolourings (TC, RC, PAL) first, the rest in order', () => {
    const names = (s: string[]) => modificationOrder(s.map((name) => ({ name }))).map((o) => o.name)
    expect(names(['CS', 'TC', 'O', 'PAL', 'FL', 'RC'])).toEqual(['TC', 'PAL', 'RC', 'CS', 'O', 'FL'])
  })

  it('splits CHAN formulas on commas outside parentheses and brackets', () => {
    expect(splitFormulas('if(red > 1, red, 0), [1,2][0], blue')).toEqual(['if(red > 1, red, 0)', '[1,2][0]', 'blue'])
  })
})
