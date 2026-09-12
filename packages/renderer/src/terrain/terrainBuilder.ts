/**
 * TS port of `terrain_builder`'s dynamic half (`wesnoth/src/terrain/
 * builder.cpp`'s `build_terrains`/`rule_matches`/`apply_rule`/
 * `tile::rebuild_cache`/`get_terrain_frames_at`). Runs client-side (unlike
 * `terrainGraphicsRules.ts`'s WML parsing, which runs once at build time --
 * see that file's own doc comment and `docs/IMPLEMENTATION_PLAN.md` Phase 9)
 * because matching rules against the map is map-specific and must react to
 * mid-scenario `[terrain]` changes and time-of-day.
 *
 * Deliberate simplification vs. upstream, matching `terrainGraphicsRules.ts`'s
 * own documented gaps:
 *  - No "find the cheapest constraint to pre-filter candidate hexes"
 *    optimization (`build_terrains`'s `terrain_by_type_`-based search). That
 *    optimization only exists for performance; this port instead tests every
 *    rule against every hex directly (`ruleMatches` with no
 *    `type_checked` short-circuit), which is semantically identical --
 *    slower, but far simpler to keep correct. Revisit if real maps prove
 *    too slow.
 *  - No `is_empty_hex` (fully-transparent placeholder image) filtering --
 *    affects a small minority of real art (mostly cave/wall dummy tiles per
 *    attempt #1's own measurement: 29 of 5,566 terrain PNGs).
 *  - No animation start-time jitter (`variant.randomStartMs`,
 *    `img_loc.set_animation_time`) applied to the output yet -- every
 *    multi-frame animated layer starts at phase 0. `RuleImageVariant`
 *    already carries `randomStartMs`/the per-hex `rand` seed needed to add
 *    this later.
 *  - `animate_water` preference toggle: always animates (see
 *    `terrainGraphicsRules.ts`).
 */

import type { TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js'
import type { TerrainFrame, TerrainLayer } from '../terrainPositioning.js'
import { TILE_SIZE } from '../hexGeometry.js'
import { legacySum, type HexOffset } from './legacyHex.js'
import { constraintMatches, isBackgroundImage, type BuildingRule, type RuleImage } from './terrainGraphicsRules.js'

/** The padding margin `build_terrains` uses beyond the visible board (`tile_map_`'s own `-2..w+1` range). */
const BUILD_MARGIN = 2

export interface TerrainMapQuery {
  readonly width: number
  readonly height: number
  terrainAt(x: number, y: number): TerrainCode
  /** Real board (not the rendering-only padding margin) -- drives the `_border`/`_board` flags. */
  onBoard(x: number, y: number): boolean
}

interface TileState {
  flags: Set<string>
  /** (image, per-rule-application random seed) pairs, in application order (pre-sort). */
  images: Array<{ image: RuleImage; rand: number }>
}

export interface TerrainTiles {
  get(x: number, y: number): TileState | undefined
}

function tileKey(x: number, y: number): string {
  return `${x},${y}`
}

function u32(n: number): number {
  return n >>> 0
}

/** Mirrors `get_noise()`: a 32-bit-wraparound hash, bit-exact via `Math.imul`/`>>> 0`. */
function getNoise(loc: HexOffset, index: number): number {
  const a = u32((loc.x + 92872973) ^ 918273)
  const b = u32((loc.y + 1672517) ^ 128123)
  const c = u32((index + 127390) ^ 13923787)
  let abc = u32(Math.imul(a, b))
  abc = u32(abc + Math.imul(b, c))
  abc = u32(abc + Math.imul(a, c))
  abc = u32(abc + a)
  abc = u32(abc + b)
  abc = u32(abc + c)
  return u32(Math.imul(abc, abc))
}

function withinPadding(loc: HexOffset, map: TerrainMapQuery): boolean {
  return (
    loc.x >= -BUILD_MARGIN &&
    loc.y >= -BUILD_MARGIN &&
    loc.x <= map.width + BUILD_MARGIN - 1 &&
    loc.y <= map.height + BUILD_MARGIN - 1
  )
}

/** Real board hexes get terrain from the map; the padding ring beyond it is treated as off-map for matching purposes. */
function terrainAtPadded(loc: HexOffset, map: TerrainMapQuery, offMapCode: TerrainCode): TerrainCode {
  if (loc.x >= 0 && loc.y >= 0 && loc.x < map.width && loc.y < map.height) {
    return map.terrainAt(loc.x, loc.y)
  }
  return offMapCode
}

function ruleMatches(
  rule: BuildingRule,
  loc: HexOffset,
  map: TerrainMapQuery,
  offMapCode: TerrainCode,
  tiles: Map<string, TileState>,
): boolean {
  if (rule.modX > 0 && loc.x % rule.modX !== 0) return false
  if (rule.modY > 0 && loc.y % rule.modY !== 0) return false
  if (rule.locationConstraint && (rule.locationConstraint.x !== loc.x || rule.locationConstraint.y !== loc.y)) {
    return false
  }
  if (rule.probability !== 100) {
    const random = getNoise(loc, rule.hash) % 100
    if (random > rule.probability) return false
  }

  for (const cons of rule.constraints) {
    const tloc = legacySum(loc, cons.loc)
    if (!withinPadding(tloc, map)) return false
    if (!constraintMatches(terrainAtPadded(tloc, map, offMapCode), cons.terrainTypesMatch)) return false

    const flags = tiles.get(tileKey(tloc.x, tloc.y))?.flags
    for (const f of cons.noFlag) {
      if (flags?.has(f)) return false
    }
    for (const f of cons.hasFlag) {
      if (!flags?.has(f)) return false
    }
  }
  return true
}

function applyRule(rule: BuildingRule, loc: HexOffset, map: TerrainMapQuery, tiles: Map<string, TileState>): void {
  const randSeed = getNoise(loc, rule.hash)
  for (const cons of rule.constraints) {
    const tloc = legacySum(loc, cons.loc)
    if (!withinPadding(tloc, map)) return // matches upstream: partial application, then abort

    const key = tileKey(tloc.x, tloc.y)
    let tile = tiles.get(key)
    if (!tile) {
      tile = { flags: new Set(), images: [] }
      tiles.set(key, tile)
    }

    if (!cons.noDraw) {
      for (const img of cons.images) tile.images.push({ image: img, rand: randSeed })
    }
    for (const f of cons.setFlag) tile.flags.add(f)
  }
}

/**
 * Matches every rule against every hex in the padded board (mirrors
 * `build_terrains`, minus its pure-performance candidate-prefiltering --
 * see this module's doc comment). Rules must already be sorted by
 * `precedence` (ties in insertion order) -- `parseTerrainGraphicsRules`
 * does this once at build time, matching upstream's `multiset<building_rule>`
 * ordering, since `apply_rule`'s flag side effects make rule order load-bearing.
 */
export function buildTerrainTiles(
  rules: readonly BuildingRule[],
  map: TerrainMapQuery,
  options: { drawBorder?: boolean; offMapCode: TerrainCode },
): TerrainTiles {
  const tiles = new Map<string, TileState>()
  const drawBorder = options.drawBorder ?? true

  for (let x = -BUILD_MARGIN; x <= map.width + BUILD_MARGIN - 1; x++) {
    for (let y = -BUILD_MARGIN; y <= map.height + BUILD_MARGIN - 1; y++) {
      const onBoard = map.onBoard(x, y)
      const tile: TileState = { flags: new Set(), images: [] }
      tile.flags.add(drawBorder && !onBoard ? '_border' : '_board')
      tiles.set(tileKey(x, y), tile)
    }
  }

  for (const rule of rules) {
    for (let x = -BUILD_MARGIN; x <= map.width + BUILD_MARGIN - 1; x++) {
      for (let y = -BUILD_MARGIN; y <= map.height + BUILD_MARGIN - 1; y++) {
        const loc = { x, y }
        if (ruleMatches(rule, loc, map, options.offMapCode, tiles)) {
          applyRule(rule, loc, map, tiles)
        }
      }
    }
  }

  return { get: (x, y) => tiles.get(tileKey(x, y)) }
}

export interface HexTerrainLayers {
  readonly background: readonly TerrainLayer[]
  readonly foreground: readonly TerrainLayer[]
}

const EMPTY_LAYERS: HexTerrainLayers = { background: [], foreground: [] }

/**
 * Resolves one hex's final image layers for a given time-of-day. Mirrors
 * `tile::rebuild_cache`/`get_terrain_frames_at`: stable-sorts by
 * (layer, basey), then per image walks its variants in declared order
 * (declared `[variant]`s first, the `[image]`'s own default last), picking
 * the first whose `hasFlag`/`tods` match, then a `@V`-variation index from
 * the per-hex-per-rule random seed.
 */
export function getTerrainFramesAt(tiles: TerrainTiles, x: number, y: number, tod: string): HexTerrainLayers {
  const tile = tiles.get(x, y)
  if (!tile) return EMPTY_LAYERS

  const sorted = [...tile.images].sort((a, b) => a.image.layer - b.image.layer || a.image.basey - b.image.basey)

  const background: TerrainLayer[] = []
  const foreground: TerrainLayer[] = []

  for (const { image, rand } of sorted) {
    for (const variant of image.variants) {
      if (variant.hasFlag.length > 0 && !variant.hasFlag.every((f) => tile.flags.has(f))) continue
      if (variant.tods.length > 0 && !variant.tods.includes(tod)) continue
      if (variant.images.length === 0) continue

      const idx = Math.floor(rand / 7919) % variant.images.length
      const anim = variant.images[idx]!
      const offsetX = image.basex - TILE_SIZE / 2
      const offsetY = image.basey - TILE_SIZE / 2
      const frames: TerrainFrame[] = anim.map((f) => ({
        path: f.path,
        mods: f.mods,
        durationMs: f.durationMs,
        offsetX,
        offsetY,
      }))
      const layer: TerrainLayer = { frames }
      ;(isBackgroundImage(image) ? background : foreground).push(layer)
      break // first matching variant wins
    }
  }

  return { background, foreground }
}
