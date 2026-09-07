import { describe, expect, it } from 'vitest'
import {
  HEX_COL_WIDTH,
  HEX_ROW_HEIGHT,
  HEX_SIZE,
  hexCorners,
  hexDistance,
  hexEqual,
  hexNeighbours,
  hexToPixel,
  pixelToHex,
  type HexCoord,
} from '../src/hexGeometry'

describe('hexToPixel / pixelToHex', () => {
  it('places hex (1,1) at (HEX_SIZE, HEX_ROW_HEIGHT/2)', () => {
    expect(hexToPixel({ x: 1, y: 1 })).toEqual({ x: HEX_SIZE, y: HEX_ROW_HEIGHT / 2 })
  })

  it('advances one column by HEX_COL_WIDTH', () => {
    const a = hexToPixel({ x: 1, y: 1 })
    const b = hexToPixel({ x: 2, y: 1 })
    expect(b.x - a.x).toBe(HEX_COL_WIDTH)
  })

  it('shifts even columns down by half a row', () => {
    const odd = hexToPixel({ x: 1, y: 1 })
    const even = hexToPixel({ x: 2, y: 1 })
    expect(even.y - odd.y).toBe(HEX_ROW_HEIGHT / 2)
  })

  it('advances one row by HEX_ROW_HEIGHT within the same column', () => {
    const a = hexToPixel({ x: 1, y: 1 })
    const b = hexToPixel({ x: 1, y: 2 })
    expect(b.y - a.y).toBe(HEX_ROW_HEIGHT)
  })

  it('pixelToHex inverts hexToPixel for a grid of coordinates', () => {
    for (let x = 1; x <= 8; x++) {
      for (let y = 1; y <= 8; y++) {
        const { x: px, y: py } = hexToPixel({ x, y })
        expect(pixelToHex(px, py)).toEqual({ x, y })
      }
    }
  })
})

describe('hexNeighbours', () => {
  it('returns 6 neighbours', () => {
    expect(hexNeighbours({ x: 3, y: 3 })).toHaveLength(6)
  })

  it('every neighbour is at hex distance 1', () => {
    const center: HexCoord = { x: 4, y: 4 }
    for (const n of hexNeighbours(center)) {
      expect(hexDistance(center, n)).toBe(1)
    }
  })

  it('neighbour sets differ between odd and even columns (staggered grid)', () => {
    const odd = hexNeighbours({ x: 3, y: 3 })
    const even = hexNeighbours({ x: 4, y: 3 })
    expect(odd).not.toEqual(even)
  })

  it('neighbour relation is symmetric: distance(a,b) === distance(b,a) === 1', () => {
    const a: HexCoord = { x: 5, y: 5 }
    for (const b of hexNeighbours(a)) {
      expect(hexDistance(a, b)).toBe(hexDistance(b, a))
    }
  })
})

describe('hexDistance', () => {
  it('is 0 for the same hex', () => {
    expect(hexDistance({ x: 3, y: 3 }, { x: 3, y: 3 })).toBe(0)
  })

  it('is 1 for adjacent hexes', () => {
    expect(hexDistance({ x: 3, y: 3 }, { x: 3, y: 2 })).toBe(1)
  })

  it('grows with straight-line distance along a column', () => {
    expect(hexDistance({ x: 1, y: 1 }, { x: 1, y: 5 })).toBe(4)
  })
})

describe('hexCorners', () => {
  it('returns 6 corners', () => {
    expect(hexCorners(0, 0)).toHaveLength(6)
  })

  it('corners are symmetric around the centre', () => {
    const corners = hexCorners(100, 200)
    for (const c of corners) {
      const opposite = corners.find(o => o.x === 200 - c.x && o.y === 400 - c.y)
      expect(opposite).toBeDefined()
    }
  })

  it('uses the full tile height (not sqrt(3)*size) for vertical half-height', () => {
    const corners = hexCorners(0, 0, HEX_SIZE)
    const ys = corners.map(c => c.y)
    expect(Math.max(...ys)).toBe(HEX_ROW_HEIGHT / 2)
    expect(Math.min(...ys)).toBe(-HEX_ROW_HEIGHT / 2)
  })
})

describe('hexEqual', () => {
  it('is true for identical coordinates', () => {
    expect(hexEqual({ x: 2, y: 5 }, { x: 2, y: 5 })).toBe(true)
  })

  it('is false when either component differs', () => {
    expect(hexEqual({ x: 2, y: 5 }, { x: 3, y: 5 })).toBe(false)
    expect(hexEqual({ x: 2, y: 5 }, { x: 2, y: 6 })).toBe(false)
  })
})
