/**
 * TS port of a subset of upstream's Standard Unit Filter (`src/units/
 * filter.hpp/.cpp`, `unit_filter`/`unit_filter_compound`) used throughout
 * WML: `[event][filter]`, `[store_unit][filter]`, `[kill]`, `[modify_unit]
 * [filter]`, `[if][have_unit]`, etc.
 *
 * Ported attribute matchers: `id=` (comma list), `type=` (comma list),
 * `side=` (comma list of side numbers), `x=`/`y=` (WML range syntax,
 * "3", "3-7", "3,5,9-11", plus the `x,y=recall,recall` off-board idiom),
 * `canrecruit=`, `role=` (comma list), `race=` (comma list, matches
 * `UnitType.raceId`), `ability=` (comma list, matches any of the unit
 * type's abilities' own `id=`), `has_weapon=` (comma list, matches any
 * current attack's `id`, i.e. its WML `name=` -- see `AttackType.id`'s
 * own doc comment on this naming quirk), `status=` (comma list, matches
 * any set status flag), `ai_special=guardian` (matches the Guardian
 * status `Unit.fromConfig` sets from it), and boolean composition via
 * nested `[and]`/`[or]`/`[not]` (matching `conditional_wml.cpp`'s
 * in-order-precedence semantics, reused here since a unit filter's
 * boolean structure is the same shape). Also wires `formula=` through
 * the WFL interpreter (`packages/engine/src/formula/`) for simple
 * per-unit formulas -- see `unitFormulaContext`. Added for Phase 29 (the
 * real AI port): its `[filter_own]`/`[filter_enemy]` and micro-AI
 * `[filter]` WML lean on `role=`/`ability=`/`status=` more than
 * everyday scenario content does.
 *
 * NOT ported: `name=`, `type_adv_tree=`, `ability_type=`, `gender=`,
 * `trait=`, `find_in=`, `[filter_side]`, `[filter_wml]` (arbitrary
 * WML-subtree matching against a unit's stored variables), and
 * `formula=`'s full `unit_callable` surface (only a handful of scalar
 * fields are exposed, see `unitFormulaContext`). Real content leaning on
 * these needs a follow-up pass.
 */

import type { GameBoard } from '../model/GameBoard.js';
import { Location, distanceBetween, getAdjacentTiles } from '../model/Location.js';
import { parseTerrainList, terrainMatches } from '../model/Terrain.js';
import type { Unit } from '../model/Unit.js';
import type { WmlConfig } from '../wml/config.js';
import { FormulaError, FunctionSymbolTable, MapFormulaCallable, parseFormula, Variant, type Callable, type Expression } from '../formula/index.js';
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

/** A map location as WFL sees it (`location_callable`): `x`/`y` in WML (1-based) coordinates, equal by position. */
class LocationCallable implements Callable {
  constructor(readonly loc: Location) {}
  getValue(key: string): Variant {
    if (key === 'x') return Variant.int(this.loc.wmlX);
    if (key === 'y') return Variant.int(this.loc.wmlY);
    return Variant.null_();
  }
  getInputs(): string[] {
    return ['x', 'y'];
  }
  equalsCallable(other: Callable): boolean {
    return other instanceof LocationCallable && other.loc.equals(this.loc);
  }
}

/**
 * A `Unit` as WFL sees it -- a slice of `unit_callable`: its scalar fields,
 * `side_number` (1-based; kept `side` 1-based too, as this port's
 * `formula=` filters always had it), `loc`, and equality by identity
 * (`unit_callable::do_compare` compares underlying ids), so a tunnel filter
 * can ask `unit = teleport_unit`.
 */
class UnitCallable implements Callable {
  constructor(readonly unit: Unit) {}
  getValue(key: string): Variant {
    const u = this.unit;
    switch (key) {
      case 'id': return Variant.string(u.id);
      case 'type': return Variant.string(u.type.id);
      case 'side': return Variant.int(u.side);
      case 'side_number': return Variant.int(u.side);
      case 'x': return Variant.int(u.location.wmlX);
      case 'y': return Variant.int(u.location.wmlY);
      case 'loc': return Variant.callable(new LocationCallable(u.location));
      case 'hitpoints': return Variant.int(u.hitpoints);
      case 'max_hitpoints': return Variant.int(u.maxHitpoints);
      case 'moves': return Variant.int(u.movesLeft);
      case 'max_moves': return Variant.int(u.maxMoves);
      case 'experience': return Variant.int(u.experience);
      case 'level': return Variant.int(u.level);
      case 'resting': return Variant.int(u.resting ? 1 : 0);
      case 'canrecruit': return Variant.int(u.canRecruit ? 1 : 0);
      default: return Variant.null_();
    }
  }
  getInputs(): string[] {
    return ['id', 'type', 'side', 'side_number', 'x', 'y', 'loc', 'hitpoints', 'max_hitpoints', 'moves', 'max_moves', 'experience', 'level', 'resting', 'canrecruit'];
  }
  equalsCallable(other: Callable): boolean {
    return other instanceof UnitCallable && other.unit === this.unit;
  }
}

/** Exposes a `Unit`'s scalar fields to `formula=` filters as `self.<field>`. Mirrors a small slice of `unit_callable`. */
export function unitFormulaContext(unit: Unit): MapFormulaCallable {
  const top = new MapFormulaCallable();
  top.add('self', Variant.callable(new UnitCallable(unit)));
  return top;
}

/**
 * `terrain_callable` (callable_objects.cpp ~L607-650): what a location
 * filter's `formula=` sees as its top-level names -- the hex's `x`/`y`/`loc`,
 * its terrain's `id`/`village`/`castle`/`keep`/`healing`, and `owner_side`
 * (the owning side's number, 0 if none).
 */
class TerrainCallable implements Callable {
  constructor(
    private readonly board: GameBoard,
    private readonly loc: Location,
  ) {}
  getValue(key: string): Variant {
    const map = this.board.map;
    switch (key) {
      case 'x': return Variant.int(this.loc.wmlX);
      case 'y': return Variant.int(this.loc.wmlY);
      case 'loc': return Variant.callable(new LocationCallable(this.loc));
      case 'id': return Variant.string(map.terrainId(this.loc));
      case 'village': return Variant.int(map.isVillage(this.loc) ? 1 : 0);
      case 'castle': return Variant.int(map.isCastle(this.loc) ? 1 : 0);
      case 'keep': return Variant.int(map.isKeep(this.loc) ? 1 : 0);
      case 'healing': return Variant.int(map.givesHealing(this.loc));
      case 'owner_side': return Variant.int(this.board.villageOwner(this.loc) ?? 0);
      default: return Variant.null_();
    }
  }
  getInputs(): string[] {
    return ['x', 'y', 'loc', 'id', 'village', 'castle', 'keep', 'healing', 'owner_side'];
  }
}

/** `unit_at(loc)` (function_gamestate.cpp): the unit on the live board at a location, or null. */
function gameStateSymbols(board: GameBoard): FunctionSymbolTable {
  const symbols = new FunctionSymbolTable();
  symbols.addBuiltin('unit_at', (args: Expression[]): Expression => {
    if (args.length !== 1) throw new FormulaError(args.length < 1 ? 'Too few arguments' : 'Too many arguments');
    return {
      evaluate(vars: Callable): Variant {
        const value = args[0]!.evaluate(vars);
        if (!value.isCallable()) return Variant.null_();
        const target = value.asCallable();
        const loc = target instanceof LocationCallable ? target.loc : new Location(target.getValue('x').asInt() - 1, target.getValue('y').asInt() - 1);
        const unit = board.unitAt(loc);
        return unit ? Variant.callable(new UnitCallable(unit)) : Variant.null_();
      },
      toString: () => `unit_at(${args[0]!.toString()})`,
    };
  });
  return symbols;
}

/** A location filter's `formula=` at `loc`, with `teleport_unit` bound when there is a reference unit (terrain_filter::match_internal). Formulas that fail to parse or evaluate match nothing, as upstream. */
function locationFormulaMatches(board: GameBoard, loc: Location, source: string, refUnit: Unit | undefined): boolean {
  try {
    const context = new MapFormulaCallable();
    context.setFallback(new TerrainCallable(board, loc));
    if (refUnit) context.add('teleport_unit', Variant.callable(new UnitCallable(refUnit)));
    return parseFormula(source, gameStateSymbols(board)).evaluate(context).asBool();
  } catch {
    return false;
  }
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
  if (filterCfg.hasAttribute('role')) {
    const roles = filterCfg.getString('role').split(',').map((s) => s.trim());
    if (!roles.includes(unit.role)) return false;
  }
  if (filterCfg.hasAttribute('race')) {
    const races = filterCfg.getString('race').split(',').map((s) => s.trim());
    if (!races.includes(unit.type.raceId)) return false;
  }
  if (filterCfg.hasAttribute('ability')) {
    const wanted = filterCfg.getString('ability').split(',').map((s) => s.trim());
    const has = unit.type.abilities.some((a) => wanted.includes(a.config.getString('id', '')));
    if (!has) return false;
  }
  if (filterCfg.hasAttribute('has_weapon')) {
    const wanted = filterCfg.getString('has_weapon').split(',').map((s) => s.trim());
    const has = unit.attacks.some((a) => wanted.includes(a.id));
    if (!has) return false;
  }
  if (filterCfg.hasAttribute('status')) {
    const wanted = filterCfg.getString('status').split(',').map((s) => s.trim());
    if (!wanted.some((s) => unit.hasStatus(s))) return false;
  }
  if (filterCfg.hasAttribute('ai_special')) {
    // Real Wesnoth's only ai_special value is "guardian"; matches the Guardian status set by Unit.fromConfig.
    const wanted = filterCfg.getString('ai_special', '');
    if (wanted === 'guardian' && !unit.guardian) return false;
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

/**
 * Full standard location filter match (self-match + `[and]`/`[or]`/`[not]`,
 * no `radius=` expansion) against a single hex -- used by the `avoid`
 * aspect (Phase 29) and `ai.aspects.avoid`/`wesnoth.map.find`-style
 * single-hex checks, where testing one location is wanted rather than
 * enumerating every matching one via `findLocations`.
 */
export function locationMatchesFilterOnBoard(board: GameBoard, loc: Location, cfg: WmlConfig, refUnit?: Unit): boolean {
  if (!locationSelfMatches(board, loc, cfg, refUnit)) return false;
  let matches = true;
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'and') matches = matches && locationMatchesFilterOnBoard(board, loc, config, refUnit);
    else if (tag === 'or') matches = matches || locationMatchesFilterOnBoard(board, loc, config, refUnit);
    else if (tag === 'not') matches = matches && !locationMatchesFilterOnBoard(board, loc, config, refUnit);
  }
  return matches;
}

/**
 * The per-hex part of a standard location filter (`terrain_filter::
 * match_internal`): `x,y=`, `gives_income=` (is a village), `terrain=`,
 * `[filter]` on the unit standing there, `owner_side=`, and `formula=`
 * (with `teleport_unit` bound to `refUnit`, as tunnels need).
 */
function locationSelfMatches(board: GameBoard, loc: Location, cfg: WmlConfig, refUnit?: Unit): boolean {
  if (!locationMatchesFilter(loc, cfg)) return false;
  if (cfg.hasAttribute('gives_income') && cfg.getBoolean('gives_income') !== board.map.isVillage(loc)) return false;
  if (cfg.hasAttribute('terrain') && !terrainMatches(board.map.getTerrain(loc), parseTerrainList(cfg.getString('terrain')))) {
    return false;
  }
  const unitFilter = cfg.child('filter');
  if (unitFilter) {
    const u = board.unitAt(loc);
    if (!u || !unitMatchesFilter(u, unitFilter, board)) return false;
  }
  if (cfg.hasAttribute('owner_side') && (board.villageOwner(loc) ?? 0) !== cfg.getNumber('owner_side', 0)) return false;
  if (cfg.hasAttribute('formula') && !locationFormulaMatches(board, loc, cfg.getString('formula'), refUnit)) return false;
  return true;
}

/**
 * Mirrors `terrain_filter::get_locations` (what `wesnoth.map.find` and
 * tags like `[remove_shroud]` use): on-board hexes matching `x,y=`,
 * `terrain=` and `[filter]`, then `[and]`/`[or]`/`[not]` applied in
 * document order, then expanded by `radius=` (through hexes matching
 * `[filter_radius]`, if given). `refUnit` is `get_locations`' reference unit,
 * bound as `teleport_unit` in `formula=`. Not covered: `find_in=`,
 * `[filter_adjacent_location]`, `[filter_owner]`, `time_of_day=`, `area=`.
 */
export function findLocations(board: GameBoard, cfg: WmlConfig, refUnit?: Unit): Location[] {
  const map = board.map;
  const all: Location[] = [];
  for (let x = 0; x < map.w(); x++) {
    for (let y = 0; y < map.h(); y++) all.push(new Location(x, y));
  }
  const matched = new Map<string, Location>();
  for (const loc of all) {
    if (locationSelfMatches(board, loc, cfg, refUnit)) matched.set(loc.key(), loc);
  }

  for (const { tag, config } of cfg.allChildren()) {
    if (tag !== 'and' && tag !== 'or' && tag !== 'not') continue;
    const other = new Set(findLocations(board, config, refUnit).map((l) => l.key()));
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
  const allowed = new Set(findLocations(board, radiusFilter, refUnit).map((l) => l.key()));
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

