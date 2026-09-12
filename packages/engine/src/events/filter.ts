/**
 * TS port of a subset of upstream's Standard Unit Filter (`src/units/
 * filter.hpp/.cpp`, `unit_filter`/`unit_filter_compound`) used throughout
 * WML: `[event][filter]`, `[store_unit][filter]`, `[kill]`, `[modify_unit]
 * [filter]`, `[if][have_unit]`, etc.
 *
 * Ported attribute matchers: `id=` (comma list), `type=` (comma list),
 * `side=` (comma list of side numbers), `x=`/`y=` (WML range syntax,
 * "3", "3-7", "3,5,9-11", plus the `x,y=recall,recall` off-board idiom),
 * `canrecruit=`, and boolean composition via nested `[and]`/`[or]`/`[not]`
 * (matching `conditional_wml.cpp`'s in-order-precedence semantics, reused
 * here since a unit filter's boolean structure is the same shape). Also
 * wires `formula=` through the WFL interpreter (`packages/engine/src/
 * formula/`) for simple per-unit formulas -- see `unitFormulaContext`.
 *
 * NOT ported (noted rather than silently ignored -- see `filterHasUnknownCriteria`):
 * `name=`, `type_adv_tree=`, `ability=`/`ability_type=`, `role=`,
 * `race=`/`gender=`/`trait=`, `has_weapon=`, `find_in=`, `[filter_side]`,
 * `[filter_wml]` (arbitrary WML-subtree matching against a unit's stored
 * variables), and `formula=`'s full `unit_callable` surface (only a
 * handful of scalar fields are exposed, see `unitFormulaContext`). Real
 * content leaning on these needs a follow-up pass; `x=`/`y=`/`id=`/
 * `type=`/`side=`/`[filter_location]`/`[filter_vision]` cover the common
 * cases (including everything Dead_Water scenario 1's own event bodies
 * use).
 */

import type { GameBoard } from '../model/GameBoard.js';
import { Location, distanceBetween, getAdjacentTiles } from '../model/Location.js';
import { parseTerrainList, terrainMatches } from '../model/Terrain.js';
import type { Unit } from '../model/Unit.js';
import type { WmlConfig } from '../wml/config.js';
import { MapFormulaCallable, parseFormula, Variant } from '../formula/index.js';
import { isUnitVisibleToTeam } from '../pathfind/visibility.js';

/** Parses WML's range-list syntax ("3", "3-7", "3,5,9-11") into inclusive [lo, hi] pairs. */
function parseRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const part of text.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const dash = token.indexOf('-', token[0] === '-' ? 1 : 0);
    if (dash === -1) {
      const n = Number(token);
      if (!Number.isNaN(n)) ranges.push([n, n]);
    } else {
      const lo = Number(token.slice(0, dash));
      const hi = Number(token.slice(dash + 1));
      if (!Number.isNaN(lo) && !Number.isNaN(hi)) ranges.push([lo, hi]);
    }
  }
  return ranges;
}

function inRanges(n: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

/** Exposes a `Unit`'s scalar fields to `formula=` filters as `self.<field>`. Mirrors a small slice of `unit_callable`. */
export function unitFormulaContext(unit: Unit): MapFormulaCallable {
  const self = new MapFormulaCallable();
  self.add('id', Variant.string(unit.id));
  self.add('type', Variant.string(unit.type.id));
  self.add('side', Variant.int(unit.side));
  self.add('x', Variant.int(unit.location.wmlX));
  self.add('y', Variant.int(unit.location.wmlY));
  self.add('hitpoints', Variant.int(unit.hitpoints));
  self.add('max_hitpoints', Variant.int(unit.maxHitpoints));
  self.add('moves', Variant.int(unit.movesLeft));
  self.add('max_moves', Variant.int(unit.maxMoves));
  self.add('experience', Variant.int(unit.experience));
  self.add('level', Variant.int(unit.level));
  self.add('resting', Variant.int(unit.resting ? 1 : 0));
  const top = new MapFormulaCallable();
  top.add('self', Variant.callable(self));
  return top;
}

/**
 * Matches a `Unit` against a (variable-already-expanded) filter config.
 * `board` is used only for `x,y=recall,recall`'s "off the board" check.
 */
export function unitMatchesFilter(unit: Unit, filterCfg: WmlConfig, board?: GameBoard): boolean {
  if (filterCfg.hasAttribute('id')) {
    const ids = filterCfg.getString('id').split(',').map((s) => s.trim());
    if (!ids.includes(unit.id)) return false;
  }
  if (filterCfg.hasAttribute('type')) {
    const types = filterCfg.getString('type').split(',').map((s) => s.trim());
    if (!types.includes(unit.type.id)) return false;
  }
  if (filterCfg.hasAttribute('side')) {
    const sides = filterCfg
      .getString('side')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
    if (!sides.includes(unit.side)) return false;
  }
  if (filterCfg.hasAttribute('canrecruit')) {
    if (unit.canRecruit !== filterCfg.getBoolean('canrecruit')) return false;
  }
  const xStr = filterCfg.getString('x', '');
  const yStr = filterCfg.getString('y', '');
  if (xStr !== '' || yStr !== '') {
    if (xStr === 'recall' && yStr === 'recall') {
      if (board && unit.location.valid(board.map.w(), board.map.h())) return false;
    } else {
      if (xStr !== '' && !inRanges(unit.location.wmlX, parseRanges(xStr))) return false;
      if (yStr !== '' && !inRanges(unit.location.wmlY, parseRanges(yStr))) return false;
    }
  }
  if (filterCfg.hasAttribute('formula')) {
    try {
      const formula = parseFormula(filterCfg.getString('formula'));
      if (!formula.evaluate(unitFormulaContext(unit)).asBool()) return false;
    } catch {
      // A formula that fails to parse/evaluate is treated as non-matching rather than
      // aborting the whole filter -- upstream logs and treats the filter as unmatched too.
      return false;
    }
  }

  let matches = true;
  for (const { tag, config } of filterCfg.allChildren()) {
    if (tag === 'and') matches = matches && unitMatchesFilter(unit, config, board);
    else if (tag === 'or') matches = matches || unitMatchesFilter(unit, config, board);
    else if (tag === 'not') matches = matches && !unitMatchesFilter(unit, config, board);
    else if (tag === 'filter_location') matches = matches && !!board && findLocations(board, config).some((l) => l.equals(unit.location));
    else if (tag === 'filter_vision') matches = matches && filterVisionMatches(board, unit, config);
  }
  return matches;
}

/**
 * Mirrors `unit_filter`'s `[filter_vision]`: matches if, for at least one
 * of `side=`'s sides (all sides if omitted), the unit's visibility to that
 * side (fogged, or hidden from an enemy via a `hides` ability/`hidden=`)
 * equals the requested `visible=` (default `yes`).
 */
function filterVisionMatches(board: GameBoard | undefined, unit: Unit, cfg: WmlConfig): boolean {
  if (!board) return false;
  const sideStr = cfg.getString('side', '');
  const sides = sideStr === '' ? board.teams().map((t) => t.side) : sideStr.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  const wantVisible = cfg.getBoolean('visible', true);
  for (const side of sides) {
    const viewerTeam = board.getTeam(side);
    if (!viewerTeam) continue;
    if (wantVisible === isUnitVisibleToTeam(board, unit, viewerTeam, false)) return true;
  }
  return false;
}

/** Finds all board units (and, optionally, recall-list units) matching `filterCfg`. */
export function findUnits(board: GameBoard, filterCfg: WmlConfig, includeRecall = false): Unit[] {
  const found = board.allUnits().filter((u) => unitMatchesFilter(u, filterCfg, board));
  if (includeRecall) {
    for (const team of board.teams()) {
      for (const u of board.recallList(team.side)) {
        if (unitMatchesFilter(u, filterCfg, board)) found.push(u);
      }
    }
  }
  return found;
}

/** Location-only matching subset (`x=`/`y=` ranges), for `[filter_location]`/`[have_location]`-style needs. */
export function locationMatchesFilter(loc: Location, filterCfg: WmlConfig): boolean {
  const xStr = filterCfg.getString('x', '');
  const yStr = filterCfg.getString('y', '');
  if (xStr !== '' && !inRanges(loc.wmlX, parseRanges(xStr))) return false;
  if (yStr !== '' && !inRanges(loc.wmlY, parseRanges(yStr))) return false;
  return true;
}

/** The per-hex part of a standard location filter: `x,y=`, `terrain=`, and `[filter]` on the unit standing there. */
function locationSelfMatches(board: GameBoard, loc: Location, cfg: WmlConfig): boolean {
  if (!locationMatchesFilter(loc, cfg)) return false;
  if (cfg.hasAttribute('terrain') && !terrainMatches(board.map.getTerrain(loc), parseTerrainList(cfg.getString('terrain')))) {
    return false;
  }
  const unitFilter = cfg.child('filter');
  if (unitFilter) {
    const u = board.unitAt(loc);
    if (!u || !unitMatchesFilter(u, unitFilter, board)) return false;
  }
  return true;
}

/**
 * Mirrors `terrain_filter::get_locations` (what `wesnoth.map.find` and
 * tags like `[remove_shroud]` use): on-board hexes matching `x,y=`,
 * `terrain=` and `[filter]`, then `[and]`/`[or]`/`[not]` applied in
 * document order, then expanded by `radius=` (through hexes matching
 * `[filter_radius]`, if given). Not covered: `find_in=`, `[filter_adjacent_location]`,
 * `owner_side=`, `time_of_day=`, `area=`.
 */
export function findLocations(board: GameBoard, cfg: WmlConfig): Location[] {
  const map = board.map;
  const all: Location[] = [];
  for (let x = 0; x < map.w(); x++) {
    for (let y = 0; y < map.h(); y++) all.push(new Location(x, y));
  }
  const matched = new Map<string, Location>();
  for (const loc of all) {
    if (locationSelfMatches(board, loc, cfg)) matched.set(loc.key(), loc);
  }

  for (const { tag, config } of cfg.allChildren()) {
    if (tag !== 'and' && tag !== 'or' && tag !== 'not') continue;
    const other = new Set(findLocations(board, config).map((l) => l.key()));
    if (tag === 'and') {
      for (const key of [...matched.keys()]) if (!other.has(key)) matched.delete(key);
    } else if (tag === 'or') {
      for (const key of other) if (!matched.has(key)) matched.set(key, Location.fromKey(key));
    } else {
      for (const key of other) matched.delete(key);
    }
  }

  const radius = cfg.getNumber('radius', 0);
  if (radius <= 0 || matched.size === 0) return [...matched.values()];

  const radiusFilter = cfg.child('filter_radius');
  if (!radiusFilter) {
    const seeds = [...matched.values()];
    return all.filter((loc) => matched.has(loc.key()) || seeds.some((s) => distanceBetween(s, loc) <= radius));
  }
  // get_tiles_radius with a predicate: grow ring by ring, only through hexes the predicate accepts.
  const allowed = new Set(findLocations(board, radiusFilter).map((l) => l.key()));
  const result = new Map(matched);
  let frontier = [...matched.values()];
  for (let step = 0; step < radius && frontier.length > 0; step++) {
    const next: Location[] = [];
    for (const loc of frontier) {
      for (const adj of getAdjacentTiles(loc)) {
        if (result.has(adj.key()) || !map.onBoard(adj)) continue;
        if (!allowed.has(adj.key())) continue;
        result.set(adj.key(), adj);
        next.push(adj);
      }
    }
    frontier = next;
  }
  return [...result.values()];
}

