/**
 * Phase 28a P3: a map's terrain layout -- which image layers every hex
 * draws, and the full set of image refs to preload -- as one pure,
 * PixiJS-free function, so it can run in a worker
 * (`terrainLayout.worker.ts`). Matching `[terrain_graphics]` rules against a
 * whole map took ~0.4-0.6 s of main-thread time on Dead Water 1.
 *
 * Moved from `SnapshotBoard.renderTerrainReal` (Phase 9): matches `rules`
 * against the map once (`buildTerrainTiles`) and resolves every hex's final
 * layers for a fixed time-of-day (an empty string matches any
 * `tods=`-unfiltered variant, the overwhelming majority of real content),
 * over every board hex PLUS the one-hex off-map ring around it -- upstream
 * draws that ring too (`display::draw_hex` runs over the border when
 * `draw_border` is set), which is where the `_off^_usr` background and the
 * `off-map/border.png` edge fades come from.
 */
import { parseTerrainCode, NONE_TERRAIN, type TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js'
import { hexedRef } from '../images/compositor'
import { joinRef } from '../images/ipf'
import type { TerrainLayer } from '../terrainPositioning.js'
import { buildTerrainTiles, getTerrainFramesAt, type TerrainMapQuery } from './terrainBuilder.js'
import type { BuildingRule } from './terrainGraphicsRules.js'

/** One board hex's terrain code, engine-convention (0-based) coordinates. */
export interface TerrainHexCode {
  readonly x: number
  readonly y: number
  readonly code: string
}

/** One hex's resolved layers: background (under units) and foreground (over units). */
export interface HexTerrainLayout {
  x: number
  y: number
  bg: TerrainLayer[]
  fg: TerrainLayer[]
}

export interface TerrainLayout {
  hexes: HexTerrainLayout[]
  /** Every hexed image ref the layers need, for `ImageCache.preload`. */
  refs: string[]
}

export function layoutTerrain(
  rules: readonly BuildingRule[],
  terrain: readonly TerrainHexCode[],
  width: number,
  height: number,
): TerrainLayout {
  const byKey = new Map<string, TerrainCode>()
  for (const hex of terrain) byKey.set(`${hex.x},${hex.y}`, parseTerrainCode(hex.code))
  const query: TerrainMapQuery = {
    width,
    height,
    terrainAt: (x, y) => byKey.get(`${x},${y}`) ?? NONE_TERRAIN,
    onBoard: (x, y) => byKey.has(`${x},${y}`),
  }
  const tiles = buildTerrainTiles(rules as BuildingRule[], query, { offMapCode: parseTerrainCode('_off^_usr') })

  const hexes: HexTerrainLayout[] = []
  const refs = new Set<string>()
  for (let x = -1; x <= width; x++) {
    for (let y = -1; y <= height; y++) {
      const { background, foreground } = getTerrainFramesAt(tiles, x, y, '')
      hexes.push({ x, y, bg: [...background], fg: [...foreground] })
      for (const layer of [...background, ...foreground]) {
        for (const frame of layer.frames) refs.add(hexedRef(joinRef(frame.path, frame.mods)))
      }
    }
  }
  return { hexes, refs: [...refs] }
}
