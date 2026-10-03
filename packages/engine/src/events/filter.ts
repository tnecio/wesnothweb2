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
import { ALL_DIRECTIONS, Direction, Location, distanceBetween, getAdjacentTiles, parseDirection, writeDirection } from '../model/Location.js';
import type { AttackType } from '../model/UnitType.js';
import { getActiveAbilities } from '../actions/abilityEffects.js';
import { findSides } from './sideFilter.js';
import { parseTerrainList, terrainMatches } from '../model/Terrain.js';
import type { Unit } from '../model/Unit.js';
import type { WmlConfig } from '../wml/config.js';
import { setEffectUnitFilter } from '../model/effects.js';
import { FormulaError, FunctionSymbolTable, MapFormulaCallable, parseFormula, Variant, type Callable, type Expression } from '../formula/index.js';
import { isUnitVisibleToTeam } from '../pathfind/visibility.js';

/** Parses WML's range-list syntax ("3", "3-7", "3,5,9-11") into inclusive [lo, hi] pairs. */
export function parseRanges(text: string): Array<[number, number]> {
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
 * A `Unit` as WFL sees it: `unit_callable` (`formula/callable_objects.cpp`) -- its fields at a location (the
 * unit's own unless a filter asks about another), weapons as `attack_type_callable`s, and equality by
 * identity (`unit_callable::do_compare` compares underlying ids), so a tunnel filter can ask
 * `unit = teleport_unit`.
 */
export class UnitCallable implements Callable {
  constructor(
    readonly unit: Unit,
    private readonly loc: Location = unit.location,
  ) {}
  getValue(key: string): Variant {
    const u = this.unit;
    const strings = (list: Iterable<string>) => Variant.list([...list].map((s) => Variant.string(s)));
    switch (key) {
      case 'x': return this.loc.valid() ? Variant.int(this.loc.wmlX) : Variant.null_();
      case 'y': return this.loc.valid() ? Variant.int(this.loc.wmlY) : Variant.null_();
      case 'loc': return this.loc.valid() ? Variant.callable(new LocationCallable(this.loc)) : Variant.null_();
      case 'id': return Variant.string(u.id);
      case 'type': return Variant.string(u.type.id);
      case 'name': return Variant.string(u.name);
      case 'usage': return Variant.string(u.type.usage);
      case 'leader':
      case 'canrecruit': return Variant.int(u.canRecruit ? 1 : 0);
      case 'undead': return Variant.int(u.hasStatus('not_living') ? 1 : 0);
      case 'attacks': return Variant.list(u.attacks.map((a) => Variant.callable(new AttackTypeCallable(a))));
      case 'abilities': return strings(u.abilities.map((a) => a.config.getString('id', '')).filter((id) => id !== ''));
      case 'hitpoints': return Variant.int(u.hitpoints);
      case 'max_hitpoints': return Variant.int(u.maxHitpoints);
      case 'experience': return Variant.int(u.experience);
      case 'max_experience': return Variant.int(u.maxExperience);
      case 'level':
      case 'full': return Variant.int(u.level);
      case 'total_movement':
      case 'max_moves': return Variant.int(u.maxMoves);
      case 'movement_left':
      case 'moves': return Variant.int(u.movesLeft);
      case 'attacks_left': return Variant.int(u.attacksLeft);
      case 'max_attacks': return Variant.int(u.maxAttacksPerTurn);
      case 'traits': return strings(modificationIds(u, 'trait'));
      case 'advancements_taken': return strings(modificationIds(u, 'advancement'));
      case 'objects': return strings(modificationIds(u, 'object'));
      case 'traits_count': return Variant.int(modificationIds(u, 'trait').length);
      case 'advancements_taken_count': return Variant.int(modificationIds(u, 'advancement').length);
      case 'objects_count': return Variant.int(modificationIds(u, 'object').length);
      case 'extra_recruit': return strings([...new Set(u.extraRecruit)].sort());
      case 'advances_to': return strings(u.advancesTo);
      case 'states':
      case 'status': return strings([...u.statuses].sort());
      case 'side':
      case 'side_number': return Variant.int(u.side);
      case 'cost': return Variant.int(u.type.cost);
      case 'upkeep': return Variant.int(u.upkeepCost);
      case 'loyal': return Variant.int(0);
      case 'hidden': return Variant.int(u.hidden ? 1 : 0);
      case 'petrified': return Variant.int(u.incapacitated ? 1 : 0);
      case 'resting': return Variant.int(u.resting ? 1 : 0);
      case 'role': return Variant.string(u.role);
      case 'race': return Variant.string(u.type.raceId);
      case 'gender': return Variant.string(u.gender);
      case 'variation': return Variant.string(u.variation);
      case 'zoc': return Variant.int(u.emitZoc ? 1 : 0);
      case 'alignment': return Variant.string(u.alignment);
      case 'facing': return Variant.string(writeDirection(u.facing));
      case 'flying': return Variant.int(u.isFlying() ? 1 : 0);
      case 'fearless': return Variant.int(u.fearless ? 1 : 0);
      case 'healthy': return Variant.int(u.healthy ? 1 : 0);
      case 'n': case 's': case 'ne': case 'se': case 'nw': case 'sw':
      case 'lawful': case 'neutral': case 'chaotic': case 'liminal':
      case 'male': case 'female':
        return Variant.string(key);
      default: return Variant.null_();
    }
  }
  getInputs(): string[] {
    return ['x', 'y', 'loc', 'id', 'type', 'name', 'usage', 'leader', 'canrecruit', 'undead', 'attacks', 'abilities', 'hitpoints', 'max_hitpoints', 'experience', 'max_experience', 'level', 'total_movement', 'max_moves', 'movement_left', 'moves', 'attacks_left', 'max_attacks', 'traits', 'extra_recruit', 'advances_to', 'status', 'side_number', 'cost', 'upkeep', 'hidden', 'petrified', 'resting', 'role', 'race', 'gender', 'variation', 'zoc', 'alignment', 'facing', 'flying', 'fearless', 'healthy'];
  }
  equalsCallable(other: Callable): boolean {
    return other instanceof UnitCallable && other.unit.underlyingId === this.unit.underlyingId;
  }
}

/** `attack_type_callable`. */
class AttackTypeCallable implements Callable {
  constructor(readonly attack: AttackType) {}
  getValue(key: string): Variant {
    const a = this.attack;
    switch (key) {
      case 'id':
      case 'name': return Variant.string(a.id);
      case 'description': return Variant.string(a.name);
      case 'type': return Variant.string(a.type);
      case 'range': return Variant.string(a.range);
      case 'alignment': return Variant.string(a.alignment ?? '');
      case 'damage': return Variant.int(a.damage);
      case 'number_of_attacks':
      case 'number':
      case 'num_attacks':
      case 'attacks': return Variant.int(a.numAttacks);
      case 'attack_weight': return Variant.decimalFromNumber(a.attackWeight);
      case 'defense_weight': return Variant.decimalFromNumber(a.defenseWeight);
      case 'accuracy': return Variant.int(a.accuracy);
      case 'parry': return Variant.int(a.parry);
      case 'movement_used': return Variant.int(a.movementUsed);
      case 'attacks_used': return Variant.int(a.attacksUsed);
      case 'min_range': return Variant.int(a.minRange);
      case 'max_range': return Variant.int(a.maxRange);
      case 'specials':
      case 'special': return Variant.list(a.specials.map((sp) => Variant.string(sp.getString('id', ''))));
      default: return Variant.null_();
    }
  }
  getInputs(): string[] {
    return ['name', 'description', 'type', 'range', 'alignment', 'damage', 'number', 'attack_weight', 'defense_weight', 'accuracy', 'parry', 'movement_used', 'attacks_used', 'min_range', 'max_range', 'specials'];
  }
  equalsCallable(other: Callable): boolean {
    return other instanceof AttackTypeCallable && other.attack === this.attack;
  }
}

function modificationIds(u: Unit, kind: string): string[] {
  return u.modifications.filter((m) => m.kind === kind).map((m) => m.cfg.getString('id', ''));
}

/** A unit formula's context (`unit_filter`'s `formula=`): the unit's fields directly (and as `self`), `other` when given. */
export function unitFormulaContext(unit: Unit, loc: Location = unit.location, other?: Unit): MapFormulaCallable {
  const top = new MapFormulaCallable();
  top.setFallback(new UnitCallable(unit, loc));
  if (other) top.add('other', Variant.callable(new UnitCallable(other)));
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

export interface UnitFilterOptions {
  /** Match as if the unit stood here (`unit_filter::matches(u, loc)`); its own location by default. */
  readonly loc?: Location;
  /** The secondary unit: `other` in `formula=`, the unit an adjacent one is checked against. */
  readonly other?: Unit;
}

const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter((x) => x !== '');

/**
 * `unit_filter_compound::matches` (`src/units/filter.cpp`): every attribute and filter child the unit must
 * satisfy, then `[and]`/`[or]`/`[not]` applied in document order. Attributes are already `$`-substituted by
 * callers. Not ported: `lua_function=`, `find_in=`, `upkeep=`, `has_variation=`, `type_adv_tree=`,
 * `[filter_ability]`.
 */
export function unitMatchesFilter(unit: Unit, filterCfg: WmlConfig, board?: GameBoard, options: UnitFilterOptions = {}): boolean {
  const loc = options.loc ?? unit.location;
  let res = unitFilterImpl(unit, filterCfg, board, loc, options.other);
  for (const { tag, config } of filterCfg.allChildren()) {
    if (tag === 'and') res = res && unitMatchesFilter(unit, config, board, options);
    else if (tag === 'or') res = res || unitMatchesFilter(unit, config, board, options);
    else if (tag === 'not') res = res && !unitMatchesFilter(unit, config, board, options);
  }
  return res;
}

function unitFilterImpl(u: Unit, cfg: WmlConfig, board: GameBoard | undefined, loc: Location, other: Unit | undefined): boolean {
  const has = (key: string): boolean => cfg.hasAttribute(key) && cfg.getString(key) !== '';
  const list = (key: string): string[] => splitList(cfg.getString(key));
  if (has('name') && cfg.getString('name') !== u.name) return false;
  if (has('id') && !list('id').includes(u.id)) return false;
  if (has('type') && !list('type').includes(u.type.id)) return false;
  if (has('variation') && !list('variation').includes(u.variation)) return false;
  if (has('ability')) {
    const ids = new Set(u.abilities.map((a) => a.config.getString('id', '')));
    if (!list('ability').some((id) => ids.has(id))) return false;
  }
  if (has('ability_type')) {
    const tags = new Set(u.abilities.map((a) => a.tag));
    if (!list('ability_type').some((t) => tags.has(t))) return false;
  }
  if (has('ability_id_active')) {
    const wanted = new Set(list('ability_id_active'));
    if (!board) return false;
    const tags = new Set(u.abilities.map((a) => a.tag));
    const active = [...tags].some((tag) => getActiveAbilities(board, u, tag, loc).some((a) => wanted.has(a.config.getString('id', ''))));
    if (!active) return false;
  }
  if (has('ability_type_active')) {
    if (!board || !list('ability_type_active').some((tag) => getActiveAbilities(board, u, tag, loc).length > 0)) return false;
  }
  if (has('trait')) {
    const traits = new Set(modificationIds(u, 'trait'));
    if (!list('trait').some((t) => traits.has(t))) return false;
  }
  if (has('race') && !list('race').includes(u.type.raceId)) return false;
  if (has('gender') && cfg.getString('gender') !== u.gender) return false;
  if (has('side')) {
    const sides = list('side').map((s) => Number(s)).filter((n) => !Number.isNaN(n));
    if (!sides.includes(u.side)) return false;
  }
  if (has('status') && !list('status').some((s) => u.hasStatus(s))) return false;
  if (has('has_weapon') && !u.attacks.some((a) => a.id === cfg.getString('has_weapon'))) return false;
  if (has('role') && u.role !== cfg.getString('role')) return false;
  if (has('alignment') && u.alignment !== cfg.getString('alignment')) return false;
  if (has('ai_special') && (cfg.getString('ai_special') === 'guardian') !== u.guardian) return false;
  if (has('usage') && !list('usage').includes(u.type.usage)) return false;
  if (has('canrecruit') && u.canRecruit !== cfg.getBoolean('canrecruit')) return false;
  if (has('recall_cost') && !inRanges(u.recallCost, parseRanges(cfg.getString('recall_cost')))) return false;
  if (has('level') && !inRanges(u.level, parseRanges(cfg.getString('level')))) return false;
  if (board) {
    const terrain = () => board.map.getTerrain(loc);
    if (has('defense') && !inRanges(u.defenseModifier(terrain()), parseRanges(cfg.getString('defense')))) return false;
    if (has('movement_cost') && !inRanges(u.movementCost(terrain()), parseRanges(cfg.getString('movement_cost')))) return false;
    if (has('vision_cost') && !inRanges(u.moveType.visionCost(terrain()), parseRanges(cfg.getString('vision_cost')))) return false;
    if (has('jamming_cost') && !inRanges(u.moveType.jammingCost(terrain()), parseRanges(cfg.getString('jamming_cost')))) return false;
  }
  if (cfg.hasAttribute('formula') && cfg.getString('formula') !== '') {
    try {
      const formula = parseFormula(cfg.getString('formula'), board ? gameStateSymbols(board) : undefined);
      if (!formula.evaluate(unitFormulaContext(u, loc, other)).asBool()) return false;
    } catch {
      // Formulae with errors match nothing, as upstream.
      return false;
    }
  }
  const xStr = cfg.getString('x', '');
  const yStr = cfg.getString('y', '');
  if (cfg.hasAttribute('x') || cfg.hasAttribute('y')) {
    if (xStr === '' && yStr === '') return false;
    if (xStr === 'recall' && yStr === 'recall') {
      if (!board || board.map.onBoard(loc)) return false;
    } else if (!loc.matchesRange(xStr, yStr)) return false;
  }
  for (const { tag, config } of cfg.allChildren()) {
    switch (tag) {
      case 'filter_wml':
        if (!configMatches(u.toConfig(), config)) return false;
        break;
      case 'filter_vision':
        if (!filterVisionMatches(board, u, loc, config)) return false;
        break;
      case 'filter_adjacent':
        if (!filterAdjacentMatches(board, u, loc, config)) return false;
        break;
      case 'filter_location':
        if (!board || !locationMatchesFilterOnBoard(board, loc, config)) return false;
        break;
      case 'filter_side':
        if (!board) return false;
        if (!findSides(board, config).includes(u.side)) return false;
        break;
      case 'has_attack':
        if (!u.attacks.some((a) => a.matchesFilter(config))) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

/** `unit_filter_adjacent`: units within `radius` of the unit matching the child filter (with this unit as `other`), in `adjacent=` directions, `is_enemy=`, counted against `count=`. */
function filterAdjacentMatches(board: GameBoard | undefined, u: Unit, loc: Location, cfg: WmlConfig): boolean {
  if (!board) return false;
  const adjacent = getAdjacentTiles(loc);
  const radius = cfg.getNumber('radius', 1);
  const dirs = cfg.hasAttribute('adjacent') ? splitList(cfg.getString('adjacent')).map((d) => parseDirection(d)) : undefined;
  const isEnemy = cfg.hasAttribute('is_enemy') ? cfg.getBoolean('is_enemy') : undefined;
  const team = board.getTeam(u.side);
  let count = 0;
  for (const other of board.allUnits()) {
    const from = other.location;
    const distance = distanceBetween(from, loc);
    if (other.underlyingId === u.underlyingId || distance > radius) continue;
    if (!unitMatchesFilter(other, cfg, board, { loc: from, other: u })) continue;
    let dir = 0;
    for (let j = 0; j < adjacent.length; j++) {
      const hit = distance !== 1 ? distanceBetween(adjacent[j]!, from) === distance - 1 : adjacent[j]!.equals(from);
      if (hit) {
        dir = j;
        break;
      }
    }
    if (dirs && !dirs.includes(dir as Direction)) continue;
    if (isEnemy !== undefined) {
      const otherTeam = board.getTeam(other.side);
      if (!team || !otherTeam || isEnemy !== team.isEnemy(otherTeam)) continue;
    }
    count++;
  }
  if (!cfg.hasAttribute('count')) return count > 0;
  return inRanges(count, parseRanges(cfg.getString('count')));
}

/**
 * Mirrors `unit_filter`'s `[filter_vision]`: the sides the child side filter selects; for any of them, the
 * unit's visibility (not fogged at its hex, and not hiding from an enemy) equals `visible=` (default yes).
 */
function filterVisionMatches(board: GameBoard | undefined, unit: Unit, loc: Location, cfg: WmlConfig): boolean {
  if (!board) return false;
  const sides = findSides(board, cfg);
  const wantVisible = cfg.getBoolean('visible', true);
  for (const side of sides) {
    const viewerTeam = board.getTeam(side);
    if (!viewerTeam) continue;
    const fogged = board.isFogged(side, loc);
    const unitTeam = board.getTeam(unit.side);
    const hiding = !!unitTeam && viewerTeam.isEnemy(unitTeam) && !isUnitVisibleToTeam(board, unit, viewerTeam, true, loc);
    if (wantVisible !== (fogged || hiding)) return true;
  }
  return false;
}

/**
 * `config::matches`: every attribute of the filter equals the config's, and each filter child matches some
 * child of the same tag (an `[not]` child: none may).
 */
export function configMatches(cfg: WmlConfig, filter: WmlConfig): boolean {
  for (const key of filter.attributeNames()) {
    if (cfg.getString(key) !== filter.getString(key)) return false;
  }
  for (const { tag, config } of filter.allChildren()) {
    if (tag === 'not') {
      if (configMatches(cfg, config)) return false;
      continue;
    }
    if (!cfg.children(tag).some((c) => configMatches(c, config))) return false;
  }
  return true;
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
  return loc.matchesRange(filterCfg.getString('x', ''), filterCfg.getString('y', ''));
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
 * What a location filter reads beyond the board (upstream's `filter_context`, the game's global state): the
 * WML variables (`find_in=`), the time areas (`area=`) and the time of day at a hex (`time_of_day=`). The game
 * session installs it; without one those keys match nothing.
 */
export interface FilterEnvironment {
  /** The `{x, y}` (1-based) entries of a WML array variable. */
  locationsIn(variable: string): readonly { x: number; y: number }[];
  /** `tod_manager::get_area_by_id`: the location keys of a time area, if there is one. */
  areaHexes(id: string): ReadonlySet<string> | undefined;
  /** The time of day at a hex, with illumination (`get_illuminated_time_of_day`). */
  timeOfDayAt(loc: Location): { readonly id: string; readonly lawfulBonus: number };
}

let filterEnvironment: FilterEnvironment | undefined;

/** Installs the game state location filters read (see `FilterEnvironment`). */
export function setFilterEnvironment(env: FilterEnvironment | undefined): void {
  filterEnvironment = env;
}

/** `utils::parse_ranges_unsigned` + `in_ranges`: `count=` such as `1-6` or `0,2-3`. */
function inCountRanges(n: number, text: string): boolean {
  return text.split(',').some((part) => {
    const [lo, hi] = part.trim().split('-');
    const min = Number(lo);
    const max = hi === undefined ? min : hi.trim() === '' ? Infinity : Number(hi);
    return n >= min && n <= max;
  });
}

/**
 * The per-hex part of a standard location filter (`terrain_filter::match_internal`): `area=`,
 * `gives_income=`, `terrain=`, `x,y=`, `find_in=`, `location_id=`, `[filter]` on the unit standing there,
 * `[filter_adjacent_location]` (`adjacent=`, `count=`), `time_of_day=`/`time_of_day_id=`, `[filter_owner]` or
 * `owner_side=`, and `formula=` (with `teleport_unit` bound to `refUnit`, as tunnels need).
 */
function locationSelfMatches(board: GameBoard, loc: Location, cfg: WmlConfig, refUnit?: Unit): boolean {
  const env = filterEnvironment;
  if (cfg.hasAttribute('area') && !env?.areaHexes(cfg.getString('area'))?.has(loc.key())) return false;
  if (cfg.hasAttribute('gives_income') && cfg.getBoolean('gives_income') !== board.map.isVillage(loc)) return false;
  if (cfg.hasAttribute('terrain') && !terrainMatches(board.map.getTerrain(loc), parseTerrainList(cfg.getString('terrain')))) {
    return false;
  }
  if (!locationMatchesFilter(loc, cfg)) return false;
  if (cfg.hasAttribute('find_in')) {
    const found = env?.locationsIn(cfg.getString('find_in')).some((p) => p.x === loc.wmlX && p.y === loc.wmlY) ?? false;
    if (!found) return false;
  }
  if (cfg.hasAttribute('location_id')) {
    const ids = cfg.getString('location_id').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.some((id) => board.map.specialLocation(id).equals(loc))) return false;
  }
  const unitFilter = cfg.child('filter');
  if (unitFilter) {
    const u = board.unitAt(loc);
    if (!u || !unitMatchesFilter(u, unitFilter, board)) return false;
  }
  for (const adjCfg of cfg.children('filter_adjacent_location')) {
    const adjacent = getAdjacentTiles(loc);
    const dirs = adjCfg.hasAttribute('adjacent')
      ? adjCfg.getString('adjacent').split(',').map((d) => parseDirection(d.trim())).filter((d) => d !== Direction.Indeterminate)
      : ALL_DIRECTIONS;
    let count = 0;
    for (const dir of dirs) {
      const adj = adjacent[dir];
      if (adj && board.map.onBoard(adj) && locationMatchesFilterOnBoard(board, adj, adjCfg, refUnit)) count++;
    }
    if (!inCountRanges(count, adjCfg.getString('count', '1-6'))) return false;
  }
  const todType = cfg.getString('time_of_day', '');
  const todId = cfg.getString('time_of_day_id', '');
  if (todType !== '' || todId !== '') {
    // Without the game state installed, the board's own lawful bonus still answers time_of_day=.
    const tod = env?.timeOfDayAt(loc);
    if (todType !== '') {
      const bonus = tod?.lawfulBonus ?? board.lawfulBonusAt?.(loc) ?? 0;
      const vals = todType.split(',').map((s) => s.trim());
      const ok = bonus < 0 ? vals.includes('chaotic') : bonus > 0 ? vals.includes('lawful') : vals.includes('neutral') || vals.includes('liminal');
      if (!ok) return false;
    }
    if (todId !== '' && !(tod && todId.split(',').map((s) => s.trim()).includes(tod.id))) return false;
  }
  const ownerFilter = cfg.child('filter_owner');
  if (ownerFilter) {
    if (!board.map.isVillage(loc)) return false;
    const sides = findSides(board, ownerFilter);
    const owner = board.villageOwner(loc) ?? 0;
    if (!(sides.length === 0 ? owner === 0 : sides.includes(owner))) return false;
  } else if (cfg.hasAttribute('owner_side') && (board.villageOwner(loc) ?? 0) !== cfg.getNumber('owner_side', 0)) return false;
  if (cfg.hasAttribute('formula') && !locationFormulaMatches(board, loc, cfg.getString('formula'), refUnit)) return false;
  return true;
}

/**
 * Mirrors `terrain_filter::get_locations` (what `wesnoth.map.find` and
 * tags like `[remove_shroud]` use): on-board hexes matching `x,y=`,
 * `terrain=` and `[filter]`, then `[and]`/`[or]`/`[not]` applied in
 * document order, then expanded by `radius=` (through hexes matching
 * `[filter_radius]`, if given). `refUnit` is `get_locations`' reference unit,
 * bound as `teleport_unit` in `formula=`. Not covered: `lua_function=`, `[filter_vision]`,
 * `include_borders=`.
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


// `[effect][filter]` (model/effects.ts) matches with this module's unit
// filter; the model layer cannot import it, so it is registered here.
setEffectUnitFilter((unit, filter, board) => unitMatchesFilter(unit, filter, board));
