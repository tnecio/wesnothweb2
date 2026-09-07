import { describe, expect, it } from 'vitest'
import { joinRef, parseAlpha, parseIpf, splitRef } from '../src/images/ipf'

describe('parseIpf', () => {
  it('returns an empty list for no modifiers', () => {
    expect(parseIpf(undefined)).toEqual([])
    expect(parseIpf(null)).toEqual([])
    expect(parseIpf('')).toEqual([])
  })

  it('parses a single modifier with args', () => {
    expect(parseIpf('CROP(0,0,72,72)')).toEqual([
      { name: 'CROP', args: ['0', '0', '72', '72'] },
    ])
  })

  it('parses both leading-~ and no-leading-~ forms identically', () => {
    const withTilde = parseIpf('~CROP(0,0,72,72)')
    const withoutTilde = parseIpf('CROP(0,0,72,72)')
    expect(withTilde).toEqual(withoutTilde)
  })

  it('parses a chain of modifiers separated by ~', () => {
    const ops = parseIpf('CROP(0,0,72,72)~MASK(terrain/masks/7hex-tr.png)~O(0.6)')
    expect(ops).toEqual([
      { name: 'CROP', args: ['0', '0', '72', '72'] },
      { name: 'MASK', args: ['terrain/masks/7hex-tr.png'] },
      { name: 'O', args: ['0.6'] },
    ])
  })

  it('does not split nested modifier arguments on ~ or ,', () => {
    const ops = parseIpf('MASK(terrain/masks/long-convex-tl-l.png~BLIT()~O())')
    expect(ops).toEqual([
      { name: 'MASK', args: ['terrain/masks/long-convex-tl-l.png~BLIT()~O()'] },
    ])
  })

  it('uppercases op names', () => {
    expect(parseIpf('crop(0,0,1,1)')).toEqual([{ name: 'CROP', args: ['0', '0', '1', '1'] }])
  })

  it('handles a zero-arg modifier', () => {
    expect(parseIpf('NOP()')).toEqual([{ name: 'NOP', args: [] }])
  })

  it('trims whitespace around args', () => {
    expect(parseIpf('CROP( 0 , 0 , 72 , 72 )')).toEqual([
      { name: 'CROP', args: ['0', '0', '72', '72'] },
    ])
  })

  it('skips unbalanced trailing garbage rather than throwing', () => {
    expect(() => parseIpf('CROP(0,0,72,72')).not.toThrow()
    expect(parseIpf('CROP(0,0,72,72')).toEqual([])
  })

  it('handles a compound-modifier args list with nested parens at top level', () => {
    const ops = parseIpf('BLIT(foo.png,10,20)~O(50%)')
    expect(ops).toEqual([
      { name: 'BLIT', args: ['foo.png', '10', '20'] },
      { name: 'O', args: ['50%'] },
    ])
  })
})

describe('splitRef / joinRef', () => {
  it('splits a path with no modifiers', () => {
    expect(splitRef('terrain/grass.png')).toEqual({ path: 'terrain/grass.png', mods: '' })
  })

  it('splits a path with modifiers at the first ~', () => {
    expect(splitRef('terrain/masks/x.png~BLIT()~O()')).toEqual({
      path: 'terrain/masks/x.png',
      mods: 'BLIT()~O()',
    })
  })

  it('joinRef is the inverse of splitRef for a modified ref', () => {
    const ref = 'terrain/masks/x.png~BLIT()~O()'
    const { path, mods } = splitRef(ref)
    expect(joinRef(path, mods)).toBe(ref)
  })

  it('joinRef returns the bare path when mods is empty/undefined/null', () => {
    expect(joinRef('a.png', '')).toBe('a.png')
    expect(joinRef('a.png', undefined)).toBe('a.png')
    expect(joinRef('a.png', null)).toBe('a.png')
  })
})

describe('parseAlpha', () => {
  it('defaults to 1 when missing', () => {
    expect(parseAlpha(undefined)).toBe(1)
  })

  it('parses a fraction', () => {
    expect(parseAlpha('0.6')).toBe(0.6)
  })

  it('parses a percentage', () => {
    expect(parseAlpha('60%')).toBe(0.6)
  })

  it('clamps to [0, 1]', () => {
    expect(parseAlpha('150%')).toBe(1)
    expect(parseAlpha('-1')).toBe(0)
  })

  it('falls back to 1 for garbage input', () => {
    expect(parseAlpha('not-a-number')).toBe(1)
  })
})
