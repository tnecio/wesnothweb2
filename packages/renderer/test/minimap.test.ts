import { describe, expect, it } from 'vitest'
import {
  MINIMAP_FOG_IMAGE,
  MINIMAP_HIGHLIGHT_IMAGE,
  VOID_TERRAIN,
  buildMinimap,
  fitMinimap,
  minimapHexRect,
  minimapPointToHex,
  minimapScale,
  minimapViewRect,
  type MinimapInput,
  type MinimapOptions,
  type MinimapStyle,
  type MinimapTerrainCell,
  type MinimapVisibility,
  type MinimapRgb as Rgb,
} from '../src/minimap'

const imagesOf = (cell: MinimapTerrainCell): string[] | null => ('images' in cell ? cell.images : null)
const colorOf = (cell: MinimapTerrainCell): Rgb | null => ('color' in cell ? cell.color : null)

const ALL_ON: MinimapOptions = { drawTerrain: true, terrainCoding: true, drawUnits: true, movementCoding: true, drawVillages: true }

const RED: Rgb = [255, 0, 0]
const BLUE: Rgb = [0, 0, 255]
const style: MinimapStyle = {
  terrainImages: (code) => {
    const [base, overlay] = code.split('^')
    return { base: `terrain/${base}.png`, overlay: overlay ? `terrain/^${overlay}.png` : null }
  },
  terrainColors: (code) => (code === 'Gg' ? { own: [0, 200, 0], underlying: [[0, 200, 0]] } : { own: null, underlying: [[100, 100, 100], [200, 100, 0]] }),
  sideColor: (side) => (side === 1 ? RED : BLUE),
  orbColors: { unmoved: [0, 255, 0], partial: [255, 165, 0], moved: [255, 0, 0], ally: [0, 255, 255], enemy: [0, 0, 0] },
  unownedVillage: [255, 255, 255],
}

/** A 10 x 8 grass map; side 1 views, side 2 is its enemy; fog everywhere but the left half. */
function input(overrides: Partial<MinimapInput> = {}): MinimapInput {
  return {
    width: 10,
    height: 8,
    terrainAt: (x, y) => (x === 3 && y === 3 ? 'Gg^Vh' : 'Gg'),
    visibility: (x): MinimapVisibility => (x < 5 ? 'clear' : x === 9 ? 'shrouded' : 'fogged'),
    viewingSide: 1,
    isEnemy: (side) => side === 2,
    villages: [
      { x: 3, y: 3, owner: 1 },
      { x: 6, y: 2, owner: 2 },
      { x: 1, y: 1, owner: 0 },
    ],
    units: [
      { x: 2, y: 2, side: 1 },
      { x: 4, y: 4, side: 2 },
      { x: 7, y: 4, side: 2 },
    ],
    ...overrides,
  }
}

describe('minimapScale (get_scale)', () => {
  it('uses bigger hexes on smaller maps, and 4 px without terrain images', () => {
    expect(minimapScale(40, 30, ALL_ON)).toBe(24)
    expect(minimapScale(43, 27, ALL_ON)).toBe(16)
    expect(minimapScale(80, 20, ALL_ON)).toBe(8)
    expect(minimapScale(40, 30, { ...ALL_ON, terrainCoding: false })).toBe(4)
    expect(minimapScale(40, 30, { ...ALL_ON, drawTerrain: false })).toBe(4)
  })
})

describe('minimapHexRect (get_dst_rect)', () => {
  it('staggers odd columns down and balances the shift above and below', () => {
    expect(minimapHexRect(0, 0, 24)).toEqual({ x: -6, y: -12, w: 24, h: 24 })
    expect(minimapHexRect(1, 0, 24)).toEqual({ x: 12, y: 0, w: 24, h: 24 })
    expect(minimapHexRect(2, 3, 24)).toEqual({ x: 30, y: 60, w: 24, h: 24 })
  })
})

describe('buildMinimap (prep_minimap_for_rendering)', () => {
  const list = buildMinimap(input(), ALL_ON, style)!

  it('is sized w * scale * 3/4 by h * scale', () => {
    expect(list.scale).toBe(24)
    expect(list.width).toBe(180)
    expect(list.height).toBe(192)
  })

  it('draws a combined terrain as its base then its overlay image', () => {
    const cell = list.terrain.find((c) => c.rect.x === minimapHexRect(3, 3, 24).x && c.rect.y === minimapHexRect(3, 3, 24).y)!
    expect(imagesOf(cell)).toEqual(['terrain/Gg.png', 'terrain/^Vh.png'])
  })

  it('darkens fogged hexes and draws shrouded ones as void, unfogged', () => {
    const at = (x: number, y: number) => list.terrain.find((c) => c.rect.x === minimapHexRect(x, y, 24).x && c.rect.y === minimapHexRect(x, y, 24).y)!
    expect(imagesOf(at(6, 0))).toEqual(['terrain/Gg.png', MINIMAP_FOG_IMAGE])
    expect(imagesOf(at(9, 0))).toEqual([`terrain/${VOID_TERRAIN}.png`])
    expect(imagesOf(at(0, 0))).toEqual(['terrain/Gg.png'])
  })

  it('highlights reachable hexes, but not under shroud', () => {
    const reach = buildMinimap(input({ reach: new Set(['0,0', '9,0']) }), ALL_ON, style)!
    const at = (x: number, y: number) => reach.terrain.find((c) => c.rect.x === minimapHexRect(x, y, 24).x && c.rect.y === minimapHexRect(x, y, 24).y)!
    expect(imagesOf(at(0, 0))).toContain(MINIMAP_HIGHLIGHT_IMAGE)
    expect(imagesOf(at(9, 0))).not.toContain(MINIMAP_HIGHLIGHT_IMAGE)
  })

  it('marks only villages the viewing side can see, in their owner\'s colour (movement coding)', () => {
    expect(list.villages.map((v) => v.color)).toEqual([RED, [255, 255, 255]]) // the enemy's fogged village is absent
  })

  it('without movement coding, villages are own / enemy / ally orb colours', () => {
    const v = buildMinimap(input({ visibility: () => 'clear' }), { ...ALL_ON, movementCoding: false }, style)!
    expect(v.villages.map((x) => x.color)).toEqual([style.orbColors.unmoved, style.orbColors.enemy, [255, 255, 255]])
  })

  it('skips fogged units, and draws visible ones in their side\'s colour', () => {
    expect(list.units.map((u) => [u.rect.x, u.color])).toEqual([
      [minimapHexRect(2, 2, 24).x, RED],
      [minimapHexRect(4, 4, 24).x, BLUE],
    ])
  })

  it('skips an invisible enemy and a hidden unit, but not an invisible friend', () => {
    const units = buildMinimap(
      input({ units: [{ x: 1, y: 1, side: 2, invisible: true }, { x: 2, y: 1, side: 1, hidden: true }, { x: 3, y: 1, side: 1, invisible: true }] }),
      ALL_ON,
      style,
    )!.units
    expect(units).toHaveLength(1)
    expect(units[0]!.rect.x).toBe(minimapHexRect(3, 1, 24).x)
  })

  it('without movement coding, the viewing side\'s units show their orb status', () => {
    const units = buildMinimap(input({ units: [{ x: 1, y: 1, side: 1, orb: 'moved' }, { x: 2, y: 1, side: 2 }] }), { ...ALL_ON, movementCoding: false }, style)!.units
    expect(units.map((u) => u.color)).toEqual([style.orbColors.moved, style.orbColors.enemy])
  })

  it('with no viewing side, shows everything', () => {
    const all = buildMinimap(input({ viewingSide: null }), ALL_ON, style)!
    expect(all.units).toHaveLength(3)
    expect(all.villages).toHaveLength(3)
  })

  it('blindfolded: nothing but void', () => {
    const blind = buildMinimap(input({ blindfolded: true }), ALL_ON, style)!
    expect(blind.units).toHaveLength(0)
    expect(blind.villages).toHaveLength(0)
    expect(blind.terrain.every((c) => 'images' in c && c.images[0] === `terrain/${VOID_TERRAIN}.png`)).toBe(true)
  })

  it('colour coding averages the underlying terrains\' colours, darkened under fog', () => {
    const coded = buildMinimap(input({ terrainAt: (x) => (x === 0 ? 'Gg' : 'Mix') }), { ...ALL_ON, terrainCoding: false }, style)!
    expect(coded.scale).toBe(4)
    const at = (x: number, y: number) => coded.terrain.find((c) => c.rect.x === minimapHexRect(x, y, 4).x && c.rect.y === minimapHexRect(x, y, 4).y)!
    expect(colorOf(at(0, 0))).toEqual([0, 200, 0])
    expect(colorOf(at(1, 0))).toEqual([150, 100, 50]) // (100,100,100) and (200,100,0), halfway
    expect(colorOf(at(6, 0))).toEqual([100, 50, 25]) // both minus 50 (clamped at 0) first
  })

  it('draws nothing with neither terrain nor villages on', () => {
    expect(buildMinimap(input(), { ...ALL_ON, drawTerrain: false, drawVillages: false }, style)).toBeNull()
  })
})

describe('fitting, outline and clicks', () => {
  it('fits the image into its area keeping the aspect ratio, centred', () => {
    expect(fitMinimap({ width: 180, height: 192 }, { x: 0, y: 0, w: 200, h: 100 })).toEqual({ x: 53, y: 0, w: 93, h: 100 })
  })

  it('outlines exactly the hexes on screen: a view whose centre is a hex outlines around that hex', () => {
    const map = { w: 10, h: 8 }
    const location = { x: 0, y: 0, w: 180, h: 192 }
    // View centred on hex (4, 3) at 1:1 in a 540 x 360 canvas: board centre (4*54+36, 3*72+36) = (252, 252).
    const view = { x: 270 - 252, y: 180 - 252, scale: 1 }
    const r = minimapViewRect(view, { width: 540, height: 360 }, map, location)
    const hex = minimapHexRect(4, 3, 24)
    expect(Math.abs(r.x + r.w / 2 - (hex.x + hex.w / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs(r.y + r.h / 2 - (hex.y + hex.h / 2))).toBeLessThanOrEqual(1)
    // 540 px of board is 10 columns, 180 px of minimap; 360 px is 5 rows, 120 px.
    expect(r.w).toBe(182)
    expect(r.h).toBe(122)
  })

  it('a click lands on the hex drawn under it (exactly, unlike upstream), clamped to the map', () => {
    const map = { w: 10, h: 8 }
    const location = { x: 10, y: 20, w: 180, h: 192 }
    const centre = (x: number, y: number) => {
      const r = minimapHexRect(x, y, 24)
      return [location.x + r.x + r.w / 2, location.y + r.y + r.h / 2] as const
    }
    for (const [hx, hy] of [[0, 0], [3, 3], [4, 5], [9, 7], [1, 0], [8, 6]] as const) {
      const [px, py] = centre(hx, hy)
      expect(minimapPointToHex(px, py, map, location)).toEqual({ x: hx, y: hy })
    }
    expect(minimapPointToHex(5, 5, map, location)).toBeNull()
  })
})
