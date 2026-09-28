/**
 * TS port of `terrain_builder`'s WML-parsing half (`wesnoth/src/terrain/
 * builder.hpp`/`.cpp`: `parse_config`, `parse_mapstring`, `add_constraints`,
 * `add_images_from_config`, `rotate`/`rotate_rule`, `load_images`,
 * `add_off_map_rule`). This is the *static* half of the real engine's
 * two-phase design (see `docs/IMPLEMENTATION_PLAN.md` Phase 9): parsing
 * `[terrain_graphics]` WML into a fully rotated, existence-filtered rule
 * list is independent of any specific map, so it runs once at build time
 * (`apps/web/scripts/build-scenario-snapshot.mjs`), not per-page-load in the
 * browser. The *dynamic* half -- matching those rules against a live map,
 * per hex, per time-of-day -- is `terrainBuilder.ts`, which runs client-side.
 *
 * Deliberately NOT ported (documented gaps, not silent gaps):
 *  - The `animate_water` preference toggle (`tile::rebuild_cache`'s
 *    `prefs::get().animate_water()`) -- this port always animates.
 *
 * `center=` multi-hex image slicing (`image::locator`'s `center_x/y`
 * constructor) WAS initially skipped here as "a small minority of real
 * content, mostly bridges/large decorations" -- wrong, discovered via a
 * real, visible bug (large black gaps between real mountain hexes in a live
 * browser render, cross-checked against the real engine's own
 * `--screenshot` output on the identical map file): `global_image=true`
 * rule_images turn out to be how a MAJOR terrain type (mountains --
 * `mountains/basic3.png` is 180x216px, not 72x72) is drawn at all. Now
 * ported: `RuleImage.sourceLoc` (set by `loadRuleImages`, after rotation)
 * plus `centerX/centerY` give `terrainBuilder.ts`'s `globalCropMod` what it
 * needs to crop the right 72x72 window per hex (see its own doc comment for
 * the exact upstream formula, `picture.cpp`'s `load_image_sub_file`).
 */

import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js'
import {
  parseTerrainList,
  terrainMatches,
  STAR,
  TerrainCode,
} from '@wesnothweb2/engine/src/model/Terrain.js'
import { TILE_SIZE } from '../hexGeometry.js'
import { squareParentheticalSplit } from '../animation/frame.js'
import { legacySum, type HexOffset } from './legacyHex.js'

// ── small WML helpers (no equivalent exists yet for these exact semantics) ──

function splitTrimmed(str: string | undefined, sep = ','): string[] {
  if (!str) return []
  return str
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Mirrors `attribute_value::to_bool(default)`: unparsable strings fall back to `def`. */
function wmlBool(raw: string | number | boolean | undefined, def: boolean): boolean {
  if (raw === undefined) return def
  if (typeof raw === 'boolean') return raw
  const s = String(raw).trim().toLowerCase()
  if (s === 'yes' || s === 'true' || s === '1' || s === 'on') return true
  if (s === 'no' || s === 'false' || s === '0' || s === 'off') return false
  return def
}

/** Mirrors `attribute_value::to_int(default)`: unparsable strings fall back to `def`. */
function wmlInt(raw: string | number | boolean | undefined, def: number): number {
  if (raw === undefined) return def
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  return Number.isFinite(n) ? n : def
}

/** Mirrors `img["random_start"].to_bool(true) ? img["random_start"].to_int(-1) : 0`. */
function randomStartOf(cfg: WmlConfig, key = 'random_start'): number {
  const raw = cfg.get(key)
  return wmlBool(raw, true) ? wmlInt(raw, -1) : 0
}

// ── data model (mirrors terrain_builder::rule_image_variant/rule_image/terrain_constraint/building_rule) ──

export interface RuleImageFrame {
  readonly path: string
  readonly mods: string
  readonly durationMs: number
}

/** One `@V`-substituted animation cycle (a static image is a single-frame cycle). */
export type RuleImageAnimation = readonly RuleImageFrame[]

export interface RuleImageVariant {
  /** The unresolved `name=` string (may contain `@V`), kept permanently -- mirrors `rule_image_variant::image_string`. */
  readonly imageString: string
  /** `;`-separated `@V` substitution list. */
  readonly variations: string
  /** Empty = matches any time-of-day (mirrors `ter_match.is_empty`-style "unset = always"). */
  readonly tods: readonly string[]
  readonly hasFlag: readonly string[]
  /** -1 = full-period random start (upstream's `to_int(-1)` default); 0 = none; >0 = limited. */
  readonly randomStartMs: number
  /** One entry per `@V` variation (or a single entry if there's no `@V` token). Filled in by `loadRuleImages`. */
  readonly images: readonly RuleImageAnimation[]
}

export interface RuleImage {
  readonly layer: number
  readonly basex: number
  readonly basey: number
  readonly centerX: number
  readonly centerY: number
  readonly globalImage: boolean
  readonly isWater: boolean
  /** Declared `[variant]`s in document order, THEN the `[image]`'s own default variant last (see `addImagesFromConfig`). */
  readonly variants: readonly RuleImageVariant[]
  /**
   * The owning constraint's own (already-rotated) hex offset -- ONLY
   * meaningful when `globalImage` is true. Mirrors `image::locator`'s
   * `loc_` field, which `load_image_sub_file` (picture.cpp) uses to crop a
   * 72x72 window out of a LARGER, multi-hex-spanning source image (real
   * mountain art is the prime example -- e.g. `mountains/basic3.png` is
   * 180x216px, not 72x72). Set by `loadRuleImages` (which runs after
   * rotation, matching upstream's `load_images` running after
   * `rotate_rule`), not at parse time. `{x:0, y:0}` for non-global images
   * (unused there).
   */
  sourceLoc: HexOffset
}

/** Mirrors `rule_image::is_background()`: `UNITPOS = 36 + 18 = 54`. */
export const UNITPOS = 36 + 18

export function isBackgroundImage(img: RuleImage): boolean {
  return img.layer < 0 || (img.layer === 0 && img.basey < UNITPOS)
}

export interface TerrainConstraint {
  loc: HexOffset
  /** Empty = matches any terrain (mirrors the builder's own `is_empty ? true : ...` wrapper). */
  terrainTypesMatch: readonly TerrainCode[]
  setFlag: string[]
  noFlag: string[]
  hasFlag: string[]
  noDraw: boolean
  images: RuleImage[]
}

export interface BuildingRule {
  constraints: TerrainConstraint[]
  /** `null` = unconstrained (mirrors `location_constraints.valid() == false`). */
  locationConstraint: HexOffset | null
  modX: number
  modY: number
  probability: number
  precedence: number
  local: boolean
  /** Precomputed `building_rule::get_hash()` (pure function of image name strings). */
  hash: number
}

/** Mirrors the builder's private `terrain_matches(tcode, ter_match)`: empty list = always match. */
export function constraintMatches(code: TerrainCode, list: readonly TerrainCode[]): boolean {
  return list.length === 0 ? true : terrainMatches(code, list)
}

// ── image parsing (mirrors add_images_from_config) ──

function getVariations(base: string, variations: string): string[] {
  if (!variations) return [base]
  if (!base.includes('@V')) return [base]
  const vars = variations.split(';')
  return vars.map((v) => base.split('@V').join(v))
}

/** Splits an already-`@V`-substituted image string into its animation-cycle frames. Mirrors `load_images`'s inner loop. */
function parseFrames(varString: string, imageExists: (path: string) => boolean): RuleImageFrame[] | null {
  const chunks = squareParentheticalSplit(varString) // upstream defaults: `(` and `[` both nest, only `[..]` expands
  const frames: RuleImageFrame[] = []
  for (const chunk of chunks) {
    const items = chunk.split(':')
    const str = items[0] ?? ''
    const tilde = str.indexOf('~')
    const hasTilde = tilde !== -1
    const filename = 'terrain/' + (hasTilde ? str.slice(0, tilde) : str)
    if (!imageExists(filename)) continue // ignore missing frames, matches upstream
    const mods = hasTilde ? str.slice(tilde + 1) : ''
    let durationMs = 100
    if (items.length > 1) {
      const parsed = Number.parseInt(items[items.length - 1]!, 10)
      if (Number.isFinite(parsed)) durationMs = parsed
    }
    frames.push({ path: filename, mods, durationMs })
  }
  return frames.length === 0 ? null : frames
}

/**
 * Resolves every variant's `images` field (one `RuleImageAnimation` per `@V`
 * variation) against real files on disk. Returns false if a rule turns out
 * to have NO valid images anywhere (mirrors `load_images`'s "reject the
 * whole rule" behavior) -- including its "stop at the first fully-missing
 * `@V` variation" short-circuit, which is load-bearing for real content.
 */
export function loadRuleImages(rule: BuildingRule, imageExists: (path: string) => boolean): boolean {
  if (rule.constraints.length === 0) return false

  for (const constraint of rule.constraints) {
    for (const img of constraint.images) {
      img.sourceLoc = constraint.loc
      for (const variant of img.variants as Array<{ -readonly [K in keyof RuleImageVariant]: RuleImageVariant[K] }>) {
        const varStrings = getVariations(variant.imageString, variant.variations)
        const resolvedImages: RuleImageAnimation[] = []
        for (const v of varStrings) {
          const frames = parseFrames(v, imageExists)
          if (frames === null) break // stop entirely -- matches upstream's outer-loop `break`
          resolvedImages.push(frames)
        }
        if (resolvedImages.length === 0) return false
        variant.images = resolvedImages
      }
    }
  }
  return true
}

function addImagesFromConfig(images: RuleImage[], cfg: WmlConfig, global: boolean, dx = 0, dy = 0): void {
  for (const img of cfg.children('image')) {
    const layer = img.getNumber('layer', 0)
    let basex = TILE_SIZE / 2 + dx
    let basey = TILE_SIZE / 2 + dy
    const base = img.getString('base')
    if (base) {
      const parts = base.split(',').map((s) => s.trim())
      if (parts.length >= 2) {
        const bx = Number.parseInt(parts[0]!, 10)
        const by = Number.parseInt(parts[1]!, 10)
        if (Number.isFinite(bx) && Number.isFinite(by)) {
          basex = bx
          basey = by
        }
      }
    }

    let centerX = -1
    let centerY = -1
    const center = img.getString('center')
    if (center) {
      const parts = center.split(',').map((s) => s.trim())
      if (parts.length >= 2) {
        const cx = Number.parseInt(parts[0]!, 10)
        const cy = Number.parseInt(parts[1]!, 10)
        if (Number.isFinite(cx) && Number.isFinite(cy)) {
          centerX = cx
          centerY = cy
        }
      }
    }

    const isWater = img.getBoolean('is_water', false)
    const variants: RuleImageVariant[] = []

    for (const variant of img.children('variant')) {
      variants.push({
        imageString: variant.getString('name'),
        variations: img.getString('variations'),
        tods: splitTrimmed(variant.getString('tod')),
        hasFlag: splitTrimmed(variant.getString('has_flag')),
        randomStartMs: randomStartOf(variant),
        images: [],
      })
    }

    // The [image]'s own name=/variations= is always appended last as the unconditional fallback variant.
    variants.push({
      imageString: img.getString('name'),
      variations: img.getString('variations'),
      tods: [],
      hasFlag: [],
      randomStartMs: randomStartOf(img),
      images: [],
    })

    images.push({
      layer,
      basex: global ? basex - dx : basex,
      basey: global ? basey - dy : basey,
      centerX,
      centerY,
      globalImage: global,
      isWater,
      variants,
      sourceLoc: { x: 0, y: 0 }, // filled in by loadRuleImages (needs the post-rotation constraint.loc)
    })
  }
}

// ── constraints (mirrors the two add_constraints overloads) ──

function findOrCreateConstraint(constraints: TerrainConstraint[], loc: HexOffset): TerrainConstraint {
  for (const c of constraints) {
    if (c.loc.x === loc.x && c.loc.y === loc.y) return c
  }
  const created: TerrainConstraint = {
    loc,
    terrainTypesMatch: [],
    setFlag: [],
    noFlag: [],
    hasFlag: [],
    noDraw: false,
    images: [],
  }
  constraints.push(created)
  return created
}

function addConstraintsForType(
  constraints: TerrainConstraint[],
  loc: HexOffset,
  type: readonly TerrainCode[],
  globalImages: WmlConfig,
): TerrainConstraint {
  const cons = findOrCreateConstraint(constraints, loc)
  if (type.length > 0) {
    cons.terrainTypesMatch = type
  }
  const dx = loc.x * TILE_SIZE * 0.75
  const dy = loc.y * TILE_SIZE + (loc.x % 2) * (TILE_SIZE / 2)
  addImagesFromConfig(cons.images, globalImages, true, dx, dy)
  return cons
}

function addConstraintsFromTile(
  constraints: TerrainConstraint[],
  loc: HexOffset,
  cfg: WmlConfig,
  globalImages: WmlConfig,
): void {
  const type = parseTerrainList(cfg.getString('type'), STAR.base)
  const cons = addConstraintsForType(constraints, loc, type, globalImages)

  cons.setFlag.push(...squareParentheticalSplit(cfg.getString('set_flag')))
  cons.hasFlag.push(...squareParentheticalSplit(cfg.getString('has_flag')))
  cons.noFlag.push(...squareParentheticalSplit(cfg.getString('no_flag')))
  const setNoFlag = squareParentheticalSplit(cfg.getString('set_no_flag'))
  cons.setFlag.push(...setNoFlag)
  cons.noFlag.push(...setNoFlag)

  cons.noDraw = cfg.getBoolean('no_draw', false)

  addImagesFromConfig(cons.images, cfg, false)
}

// ── map= ASCII-art parsing (mirrors read_builder_map + parse_mapstring) ──

type BuilderCell = { kind: 'none' } | { kind: 'dot' } | { kind: 'star' } | { kind: 'anchor'; id: number }

function classifyBuilderCell(raw: string): BuilderCell {
  const str = raw.trim()
  if (str.length === 0) return { kind: 'none' }
  const asInt = Number.parseInt(str, 10)
  if (Number.isFinite(asInt) && String(asInt) === str) return { kind: 'anchor', id: asInt }
  if (str === '.') return { kind: 'dot' }
  if (str === '*') return { kind: 'star' }
  return { kind: 'dot' } // unrecognized single-char builder token: treat as a no-op placeholder rather than crash
}

/** Mirrors `read_builder_map`: a rectangular grid of cells, `w` = number of text lines, `h` = max cells per line. */
function readBuilderMap(mapstring: string): { w: number; h: number; get(line: number, cell: number): BuilderCell } {
  let offset = 0
  while (offset < mapstring.length && (mapstring[offset] === '\n' || mapstring[offset] === '\r')) offset++
  if (offset + 1 >= mapstring.length) return { w: 0, h: 0, get: () => ({ kind: 'none' }) }

  const lines = mapstring.slice(offset).split(/\r\n|\r|\n/)
  const rows: BuilderCell[][] = lines.map((line) => line.split(',').map(classifyBuilderCell))
  const w = rows.length
  const h = rows.reduce((max, row) => Math.max(max, row.length), 0)
  return {
    w,
    h,
    get(line, cell) {
      return rows[line]?.[cell] ?? { kind: 'dot' }
    },
  }
}

function parseMapstring(
  mapstring: string,
  constraints: TerrainConstraint[],
  anchors: Map<number, HexOffset[]>,
  globalImages: WmlConfig,
): void {
  const map = readBuilderMap(mapstring)
  if (map.w === 0 || map.h === 0) return

  let lineno = map.get(0, 0).kind === 'none' ? 1 : 0
  let x = lineno
  let y = 0

  for (let yOff = 0; yOff < map.w; yOff++) {
    for (let xOff = x; xOff < map.h; xOff++) {
      const cell = map.get(yOff, xOff)
      if (cell.kind === 'dot' || cell.kind === 'none') {
        // placeholder
      } else if (cell.kind === 'anchor') {
        const loc = { x, y }
        const list = anchors.get(cell.id)
        if (list) list.push(loc)
        else anchors.set(cell.id, [loc])
      } else if (cell.kind === 'star') {
        addConstraintsForType(constraints, { x, y }, [STAR], globalImages)
      }
      x += 2
    }

    if (lineno % 2 === 1) {
      y += 1
      x = 0
    } else {
      x = 1
    }
    lineno += 1
  }
}

// ── rotation (mirrors rotate/rotate_rule/replace_rotate_tokens) ──

const ROTATIONS: ReadonlyArray<{ ii: number; ij: number; ji: number; jj: number }> = [
  { ii: 1, ij: 0, ji: 0, jj: 1 },
  { ii: 1, ij: 1, ji: -1, jj: 0 },
  { ii: 0, ij: 1, ji: -1, jj: -1 },
  { ii: -1, ij: 0, ji: 0, jj: -1 },
  { ii: -1, ij: -1, ji: 1, jj: 0 },
  { ii: 0, ij: -1, ji: 1, jj: 1 },
]

const XY_ROTATIONS: ReadonlyArray<{ xx: number; xy: number; yx: number; yy: number }> = [
  { xx: 1, xy: 0, yx: 0, yy: 1 },
  { xx: 1 / 2, xy: -3 / 4, yx: 1, yy: 1 / 2 },
  { xx: -1 / 2, xy: -3 / 4, yx: 1, yy: -1 / 2 },
  { xx: -1, xy: 0, yx: 0, yy: -1 },
  { xx: -1 / 2, xy: 3 / 4, yx: -1, yy: -1 / 2 },
  { xx: 1 / 2, xy: 3 / 4, yx: -1, yy: 1 / 2 },
]

function rotateConstraintLoc(loc: HexOffset, angle: number): HexOffset {
  const vi = loc.y - Math.trunc(loc.x / 2) // `loc.x / 2` is plain C++ truncating integer division, not floor
  const vj = loc.x
  const r = ROTATIONS[angle]!
  const ri = r.ii * vi + r.ij * vj
  const rj = r.ji * vi + r.jj * vj
  const x = rj
  // Both divisions are plain C++ truncating integer division. NOT floor:
  // for rj = -2, `(rj - 1) / 2` is -3/2 = -1 truncated, but floor(-1.5) = -2
  // -- that one-off shifted every rotated constraint with an even negative
  // rj one hex south (real symptom: transitions/castle walls landing on the
  // wrong hex for templates whose anchor sits at an odd template column).
  const y = ri + (rj >= 0 ? Math.trunc(rj / 2) : Math.trunc((rj - 1) / 2))
  return { x, y }
}

function rotateImageBase(img: RuleImage, angle: number): { basex: number; basey: number } {
  const vx = img.basex - TILE_SIZE / 2
  const vy = img.basey - TILE_SIZE / 2
  const r = XY_ROTATIONS[angle]!
  const rx = r.xx * vx + r.xy * vy
  const ry = r.yx * vx + r.yy * vy
  return { basex: Math.trunc(rx + TILE_SIZE / 2), basey: Math.trunc(ry + TILE_SIZE / 2) }
}

/** Mirrors `replace_rotate_tokens(string&, angle, replacement)`: substitutes `@Rn` tokens. */
function replaceRotateTokens(s: string, angle: number, replacement: readonly string[]): string {
  let out = ''
  let pos = 0
  while (pos < s.length) {
    const idx = s.indexOf('@R', pos)
    if (idx === -1) {
      out += s.slice(pos)
      break
    }
    out += s.slice(pos, idx)
    if (idx + 2 >= s.length) {
      out += s.slice(idx)
      break
    }
    const digit = s.charCodeAt(idx + 2) - '0'.charCodeAt(0)
    let i = digit + angle
    if (i >= 6) i -= 6
    if (i >= 6 || i < 0) {
      out += s.slice(idx, idx + 2)
      pos = idx + 2
      continue
    }
    out += replacement[i]
    pos = idx + 3
  }
  return out
}

function rotateVariant(v: RuleImageVariant, angle: number, replacement: readonly string[]): RuleImageVariant {
  return { ...v, imageString: replaceRotateTokens(v.imageString, angle, replacement) }
}

function rotateImage(img: RuleImage, angle: number, replacement: readonly string[]): RuleImage {
  const { basex, basey } = rotateImageBase(img, angle)
  return { ...img, basex, basey, variants: img.variants.map((v) => rotateVariant(v, angle, replacement)) }
}

function rotateConstraint(c: TerrainConstraint, angle: number, replacement: readonly string[]): TerrainConstraint {
  return {
    ...c,
    loc: rotateConstraintLoc(c.loc, angle),
    setFlag: c.setFlag.map((f) => replaceRotateTokens(f, angle, replacement)),
    noFlag: c.noFlag.map((f) => replaceRotateTokens(f, angle, replacement)),
    hasFlag: c.hasFlag.map((f) => replaceRotateTokens(f, angle, replacement)),
    images: c.images.map((img) => rotateImage(img, angle, replacement)),
  }
}

/** Mirrors `rotate_rule`: rotates every constraint, then renormalizes so the minimum location is non-negative. */
function rotateRule(rule: BuildingRule, angle: number, rotationNames: readonly string[]): BuildingRule {
  const rotatedConstraints = rule.constraints.map((c) => rotateConstraint(c, angle, rotationNames))

  let minx = Number.POSITIVE_INFINITY
  let miny = Number.POSITIVE_INFINITY
  for (const c of rotatedConstraints) {
    minx = Math.min(minx, c.loc.x)
    miny = Math.min(miny, 2 * c.loc.y + (c.loc.x & 1))
  }
  if ((miny & 1) !== 0 && (minx & 1) !== 0 && minx < 0) miny += 2
  if ((miny & 1) === 0 && (minx & 1) !== 0 && minx > 0) miny -= 2

  const offset = { x: -minx, y: -Math.trunc((miny - 1) / 2) } // `(miny - 1) / 2` is plain C++ truncating integer division
  const normalized = rotatedConstraints.map((c) => ({ ...c, loc: legacySum(c.loc, offset) }))

  return { ...rule, constraints: normalized }
}

// ── top-level rule parsing (mirrors parse_config/add_rule/add_rotated_rules) ──

export interface ParseRulesOptions {
  /** Checks whether `terrain/<path>` (already `terrain/`-prefixed) exists on disk. */
  imageExists: (path: string) => boolean
  local?: boolean
}

function parseOneRule(br: WmlConfig, local: boolean): BuildingRule {
  const constraints: TerrainConstraint[] = []
  const anchors = new Map<number, HexOffset[]>()

  parseMapstring(br.getString('map'), constraints, anchors, br)

  for (const tc of br.children('tile')) {
    const hasX = tc.hasAttribute('x')
    const hasY = tc.hasAttribute('y')
    if (hasX || hasY) {
      const loc = { x: tc.getNumber('x', 0), y: tc.getNumber('y', 0) }
      addConstraintsFromTile(constraints, loc, tc, br)
    }
    if (tc.hasAttribute('pos')) {
      const pos = tc.getNumber('pos', 0)
      const locs = anchors.get(pos)
      if (locs) {
        for (const loc of locs) addConstraintsFromTile(constraints, loc, tc, br)
      }
    }
  }

  const globalSetFlag = splitTrimmed(br.getString('set_flag'))
  const globalNoFlag = splitTrimmed(br.getString('no_flag'))
  const globalHasFlag = splitTrimmed(br.getString('has_flag'))
  const globalSetNoFlag = splitTrimmed(br.getString('set_no_flag'))
  for (const c of constraints) {
    c.setFlag.push(...globalSetFlag, ...globalSetNoFlag)
    c.noFlag.push(...globalNoFlag, ...globalSetNoFlag)
    c.hasFlag.push(...globalHasFlag)
  }

  const hasX = br.hasAttribute('x')
  const hasY = br.hasAttribute('y')
  const locationConstraint = hasX || hasY ? { x: br.getNumber('x', 0) - 1, y: br.getNumber('y', 0) - 1 } : null

  return {
    constraints,
    locationConstraint,
    modX: br.getNumber('mod_x', 0),
    modY: br.getNumber('mod_y', 0),
    probability: br.getNumber('probability', 100),
    precedence: br.getNumber('precedence', 0),
    local,
    hash: 0, // filled in by computeRuleHash after images are resolved
  }
}

function hashString(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (((h << 9) | (h >>> (32 - 9))) ^ str.charCodeAt(i)) | 0
  }
  return h >>> 0
}

/** Mirrors `building_rule::get_hash()`. Must run AFTER `loadRuleImages` resolves variant image strings. */
function computeRuleHash(rule: BuildingRule): number {
  let hash = 0
  for (const c of rule.constraints) {
    for (const img of c.images) {
      for (const v of img.variants) {
        hash = (hash + hashString(v.imageString)) | 0
      }
    }
  }
  hash = hash >>> 0
  return hash === 0 ? 105533 : hash
}

function addRule(rules: BuildingRule[], rule: BuildingRule, imageExists: (p: string) => boolean): void {
  if (!loadRuleImages(rule, imageExists)) return
  rules.push({ ...rule, hash: computeRuleHash(rule) })
}

function addRotatedRules(
  rules: BuildingRule[],
  template: BuildingRule,
  rotationsAttr: string,
  imageExists: (p: string) => boolean,
): void {
  if (!rotationsAttr) {
    addRule(rules, template, imageExists)
    return
  }
  const rot = splitTrimmed(rotationsAttr)
  for (let angle = 0; angle < rot.length; angle++) {
    if (rot[angle] === 'skip') continue
    const rotated = rotateRule(template, angle, rot)
    addRule(rules, rotated, imageExists)
  }
}

/** Builds the hardcoded `_off^_usr` rule (mirrors `add_off_map_rule`; default theme's `off-map/alpha.png`). */
function buildOffMapRule(offmapImage: string): WmlConfig {
  const cfg = new WmlConfig()
  const item = cfg.addChild('terrain_graphics')
  const tile = item.addChild('tile')
  tile.setAttribute('x', 0)
  tile.setAttribute('y', 0)
  tile.setAttribute('type', '_off^_usr')
  const image = tile.addChild('image')
  image.setAttribute('layer', -1000)
  image.setAttribute('name', offmapImage)
  item.setAttribute('probability', 100)
  item.setAttribute('no_flag', 'base')
  item.setAttribute('set_flag', 'base')
  return cfg
}

export const DEFAULT_OFFMAP_IMAGE = 'off-map/alpha.png'

/**
 * Parses every `[terrain_graphics]` rule in `root` (plus, when `includeOffMapRule`
 * is set, the hardcoded off-map rule) into the final, rotated, existence-filtered
 * rule list -- ready to hand to `terrainBuilder.ts` (or to `JSON.stringify` into
 * a build-time snapshot). Order matters (see `buildTerrains`'s precedence-then-
 * insertion-order rule application) so callers should concatenate core then
 * scenario-local configs and call this once, in that order, rather than merging
 * two separately-parsed lists.
 */
export function parseTerrainGraphicsRules(
  root: WmlConfig,
  options: ParseRulesOptions & { includeOffMapRule?: boolean },
): BuildingRule[] {
  const rules: BuildingRule[] = []
  const local = options.local ?? false

  if (options.includeOffMapRule) {
    const offMapCfg = buildOffMapRule(DEFAULT_OFFMAP_IMAGE)
    for (const br of offMapCfg.children('terrain_graphics')) {
      const rule = parseOneRule(br, false)
      addRotatedRules(rules, rule, br.getString('rotations'), options.imageExists)
    }
  }

  for (const br of root.children('terrain_graphics')) {
    const rule = parseOneRule(br, local)
    addRotatedRules(rules, rule, br.getString('rotations'), options.imageExists)
  }

  // Mirrors storage order in upstream's `multiset<building_rule>` (ordered by `precedence`,
  // ties broken by insertion order) -- `build_terrains`'s `apply_rule` flag side effects make
  // this order load-bearing, not cosmetic. `Array#sort` is stable (ES2019+).
  rules.sort((a, b) => a.precedence - b.precedence)
  return rules
}

/**
 * Reconstructs real `TerrainCode` instances inside a rule list that just
 * came back through `JSON.parse` (e.g. fetched by the browser from a
 * build-time-generated snapshot). `JSON.parse` produces plain `{base,
 * overlay}` objects with no `TerrainCode` prototype -- `constraintMatches`/
 * `terrainMatches` call `.equals()` on entries, which would throw on those.
 * Mutates and returns the same array (freshly parsed JSON has no other
 * references to it, so this is safe and avoids a full second copy of a
 * potentially large rule list).
 */
export function reviveBuildingRules(rules: BuildingRule[]): BuildingRule[] {
  for (const rule of rules) {
    for (const c of rule.constraints) {
      c.terrainTypesMatch = c.terrainTypesMatch.map((t) => new TerrainCode(t.base, t.overlay))
    }
  }
  return rules
}
