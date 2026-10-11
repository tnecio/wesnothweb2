/**
 * Phase 27b: a port of upstream's ability and weapon-special pipeline -- `src/units/abilities.cpp` and the
 * special half of `src/units/attack_type.cpp`.
 *
 * - **Abilities** (`unit_ability_t`, `foreach_active_ability`, `unit::get_abilities`): a unit's own, and those
 *   other units teach through `[affect_adjacent]`, each gated by its `[filter]`, `[filter_self]`, the
 *   `[affect_adjacent]` radius, directions and `[filter]`, and `affect_self`/`affect_allies`/`affect_enemies`.
 * - **Specials** (`specials_context_t`): in a fight between two combatants (unit, hex, weapon), which specials
 *   and weapon-like abilities are active -- `apply_to=`, `active_on=`, the built-in immunities, `[filter_self]`,
 *   `[filter_student]`, `[filter_opponent]`, `[filter_attacker]`, `[filter_defender]` and their
 *   `[filter_weapon]`, and `overwrite_specials=`.
 * - **Values** (`unit_abilities::effect`): how several active abilities combine -- `value=` (highest and lowest
 *   win), `add=`/`sub=` and `multiply=`/`divide=` (the best per id), `cumulative=`, `priority=` groups,
 *   `[filter_base_value]`, `max_value=`/`min_value=` -- each value a number or a WFL formula.
 * - **Weapons** (`attack_type`): `modified_damage`, `modified_attacks`, `modified_chance_to_hit`,
 *   `effective_damage_type`, and the weapon filter's special keys.
 *
 * Where upstream identifies a combatant by its `attack_type` pointer (`self_and_other`), the port passes the
 * combatant: two units of one type share their `AttackType` objects here.
 */

import { Location, distanceBetween, getAdjacentTiles, parseDirection, relativeDirection, type Direction } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';
import { AttackType, specialTag, type RegistryEntry } from '../model/UnitType.js';
import type { TerrainCode } from '../model/Terrain.js';
import { WmlConfig, type WmlStoredValue } from '../wml/config.js';
import { TString } from '../i18n/tstring.js';
import { MapFormulaCallable, Variant, parseFormula, type Formula } from '../formula/index.js';
import { AttackTypeCallable, UnitCallable, configMatches, gameStateSymbols, parseRanges, unitMatchesFilter } from '../events/filter.js';

// --- ability_tags.hpp ---

/** Weapon specials that support add, sub, multiply and divide. */
export const WEAPON_MATH_TAGS: ReadonlySet<string> = new Set(['attacks', 'damage', 'chance_to_hit', 'drains', 'heal_on_hit']);
/** Weapon specials that don't. */
export const NO_WEAPON_MATH_TAGS: ReadonlySet<string> = new Set(['berserk', 'disable', 'plague', 'slow', 'petrifies', 'firststrike', 'swarm', 'poison', 'damage_type']);
export const ABILITY_VALUE_TAGS: ReadonlySet<string> = new Set(['defense', 'resistance', 'leadership', 'heals', 'regenerate', 'illuminates']);
export const ABILITY_NO_VALUE_TAGS: ReadonlySet<string> = new Set(['teleport', 'hides', 'skirmisher']);
export const ALL_WEAPON_TAGS: ReadonlySet<string> = new Set([
  'attacks', 'berserk', 'chance_to_hit', 'damage', 'damage_type', 'disable', 'drains', 'firststrike', 'heal_on_hit', 'petrifies', 'plague', 'poison', 'slow', 'swarm',
]);

const NUMERIC_KEYS = ['value', 'add', 'sub', 'multiply', 'divide', 'max_value', 'min_value'] as const;

const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter((x) => x !== '');

// --- unit_ability_t ---

export type ActiveOn = 'offense' | 'defense' | 'both';
export type ApplyTo = 'self' | 'opponent' | 'attacker' | 'defender' | 'both';
export type AffectsAllies = 'yes' | 'no' | 'same_side_only';
/** `unit_ability_t::affects_t`. */
export type Affects = 'self' | 'other' | 'either';

/** One ability or special (`unit_ability_t`): its tag, its config after the compatibility fixes, and what it affects. */
export class UnitAbility {
  readonly id: string;
  readonly cfg: WmlConfig;
  readonly activeOn: ActiveOn = 'both';
  readonly applyTo: ApplyTo = 'self';
  readonly affectsAllies: AffectsAllies = 'same_side_only';
  readonly affectsSelf: boolean;
  readonly affectsEnemies: boolean;
  readonly priority: number;
  /** `currently_checked_`: set while the ability's own filters are evaluated, so a filter that asks about it again fails. */
  currentlyChecked = false;

  constructor(
    readonly tag: string,
    cfg: WmlConfig,
    /** `in_specials_tag_`: a weapon special, not a unit ability. */
    readonly inSpecialsTag: boolean,
  ) {
    this.cfg = cfg.clone();
    doCompatFixes(this.cfg, tag, inSpecialsTag);
    this.id = this.cfg.getString('id', '');
    this.priority = this.cfg.getNumber('priority', 0);
    if (tag !== 'resistance' && tag !== 'leadership') {
      const applyTo = this.cfg.getString('apply_to', '');
      this.applyTo = applyTo === 'attacker' || applyTo === 'defender' || applyTo === 'opponent' || applyTo === 'both' ? applyTo : 'self';
    }
    if (tag !== 'leadership') {
      const activeOn = this.cfg.getString('active_on', '');
      this.activeOn = activeOn === 'defense' || activeOn === 'offense' ? activeOn : 'both';
    }
    if (!this.cfg.hasChild('affect_adjacent')) this.affectsAllies = 'no';
    if (this.cfg.getBoolean('affect_allies', false)) this.affectsAllies = 'yes';
    if (!this.cfg.getBoolean('affect_allies', true)) this.affectsAllies = 'no';
    this.affectsSelf = this.cfg.getBoolean('affect_self', true);
    this.affectsEnemies = this.cfg.getBoolean('affect_enemies', false);
  }

  activeOnMatches(studentIsAttacker: boolean): boolean {
    if (this.activeOn === 'both') return true;
    if (this.activeOn === 'offense' && studentIsAttacker) return true;
    if (this.activeOn === 'defense' && !studentIsAttacker) return true;
    return false;
  }

  /** `unit_ability_t::matches_filter`: an ability filter (`[filter_special]`, `[filter_ability]`), with `[and]`/`[or]`/`[not]`. */
  matchesFilter(filter: WmlConfig): boolean {
    return commonMatchesFilter(this.cfg, this.tag, filter);
  }

  /** `get_help_topic_id`. */
  helpTopicId(): string {
    return this.cfg.getString('unique_id', '') || this.cfg.getString('id', '');
  }

  /** `get_name`: the name, or the inactive or female one when there is one. */
  getName(inactive = false, female = false): string {
    return this.substituteVariables(fourFallback(this.cfg, inactive, female, 'female_name_inactive', 'name_inactive', 'female_name', 'name'));
  }

  getDescription(inactive = false, female = false): string {
    return this.substituteVariables(
      fourFallback(this.cfg, inactive, female, 'female_description_inactive', 'description_inactive', 'female_description', 'description'),
    );
  }

  /** `substitute_variables`: `$value`, `$add`... in a name or description become the special's own numbers. */
  substituteVariables(str: string, typeName?: (id: string) => string | undefined): string {
    const symbols = new Map<string, string>();
    if (this.tag === 'plague' && typeName) {
      const name = typeName(this.cfg.getString('type', ''));
      if (name === undefined) return str;
      symbols.set('type', name);
    }
    for (const key of NUMERIC_KEYS) {
      if (!this.cfg.hasAttribute(key)) continue;
      symbols.set(key, key === 'multiply' || key === 'divide' ? String(this.cfg.getNumber(key)) : String(Math.trunc(this.cfg.getNumber(key))));
    }
    if (symbols.size === 0) return str;
    return str.replace(/\$([A-Za-z_]+)\|?/g, (whole, name: string) => symbols.get(name) ?? whole);
  }

  /** `guard_against_recursion`: claims the ability while its filters run; null when it is already being checked. */
  guard(): (() => void) | null {
    if (this.currentlyChecked) return null;
    this.currentlyChecked = true;
    return () => {
      this.currentlyChecked = false;
    };
  }
}

function fourFallback(cfg: WmlConfig, b1: boolean, b2: boolean, yesYes: string, yesNo: string, noYes: string, noNo: string): string {
  if (b1 && b2 && cfg.hasAttribute(yesYes)) return cfg.getString(yesYes);
  if (b1 && cfg.hasAttribute(yesNo)) return cfg.getString(yesNo);
  if (b2 && cfg.hasAttribute(noYes)) return cfg.getString(noYes);
  return cfg.getString(noNo, '');
}

const BACKSTAB_FORMULA = 'enemy_of(self, flanker) and not flanker.petrified where flanker = unit_at(direction_from(loc, other.facing))';

/** `do_compat_fixes`: `backstab=`, and the old top-level `[filter_adjacent]`/`[filter_adjacent_location]`, as filters. */
function doCompatFixes(cfg: WmlConfig, tag: string, insideAttack: boolean): void {
  if (cfg.getBoolean('backstab', false)) {
    const filterOpponent = cfg.child('filter_opponent') ?? cfg.addChild('filter_opponent');
    const target = filterOpponent.attributeNames().length === 0 && filterOpponent.allChildren().length === 0 ? filterOpponent : filterOpponent.addChild('and');
    target.setAttribute('formula', BACKSTAB_FORMULA);
  }
  cfg.removeAttribute('backstab');

  const filterTeacher = insideAttack ? 'filter_self' : 'filter';
  const teacher = (): WmlConfig => cfg.child(filterTeacher) ?? cfg.addChild(filterTeacher);
  for (const adj of cfg.children('filter_adjacent')) {
    const copy = adj.clone();
    if (!copy.hasAttribute('count') || copy.getString('count') === '') copy.setAttribute('count', splitList(copy.getString('adjacent', '')).length);
    teacher().addChild('filter_adjacent', copy);
  }
  cfg.removeChildren('filter_adjacent');
  for (const adj of cfg.children('filter_adjacent_location')) {
    const copy = adj.clone();
    if (!copy.hasAttribute('count') || copy.getString('count') === '') copy.setAttribute('count', splitList(copy.getString('adjacent', '')).length);
    teacher().addChild('filter_location').addChild('filter_adjacent_location', copy);
  }
  cfg.removeChildren('filter_adjacent_location');

  if (tag === 'resistance' || tag === 'leadership') {
    const second = cfg.child('filter_second_weapon');
    if (second) cfg.addChild('filter_opponent').addChild('filter_weapon', second.clone());
    const weapon = cfg.child('filter_weapon');
    if (weapon) cfg.addChild('filter_student').addChild('filter_weapon', weapon.clone());
    cfg.removeChildren('filter_second_weapon');
    cfg.removeChildren('filter_weapon');
  }
}

// --- each unit's and weapon's abilities (upstream clones them per unit, so each has its own recursion flag) ---

const unitAbilityCache = new WeakMap<Unit, { readonly source: readonly RegistryEntry[]; readonly list: readonly UnitAbility[] }>();

/** `unit::abilities()`. */
export function unitAbilities(unit: Unit): readonly UnitAbility[] {
  const source = unit.abilities;
  const cached = unitAbilityCache.get(unit);
  if (cached && cached.source === source) return cached.list;
  const list = source.map((e) => new UnitAbility(e.tag, e.config, false));
  unitAbilityCache.set(unit, { source, list });
  return list;
}

const weaponSpecialCache = new WeakMap<AttackType, readonly UnitAbility[]>();

/** `attack_type::specials()`. */
export function weaponSpecials(at: AttackType): readonly UnitAbility[] {
  let list = weaponSpecialCache.get(at);
  if (!list) {
    list = at.specials.map((cfg) => new UnitAbility(specialTag(cfg) || 'dummy', cfg, true));
    weaponSpecialCache.set(at, list);
  }
  return list;
}

// --- active_ability, active_ability_list ---

export interface ActiveAbility {
  readonly ability: UnitAbility;
  /** The real hex of the unit receiving it (for `student` in its formulas). */
  readonly studentLoc: Location;
  /** The hex of the unit owning it (different from the student's through `[affect_adjacent]`). */
  readonly teacherLoc: Location;
}

/** `active_ability_list`: active abilities, and the hex of the unit they are for. */
export class ActiveAbilityList {
  readonly items: ActiveAbility[] = [];
  constructor(
    readonly board: GameBoard,
    readonly loc: Location = Location.NULL,
  ) {}

  get length(): number {
    return this.items.length;
  }

  push(ability: UnitAbility, studentLoc: Location, teacherLoc: Location): void {
    this.items.push({ ability, studentLoc, teacherLoc });
  }

  filter(pred: (a: ActiveAbility) => boolean): ActiveAbilityList {
    const res = new ActiveAbilityList(this.board, this.loc);
    res.items.push(...this.items.filter(pred));
    return res;
  }

  /** `highest(key, def)`: the best non-cumulative value plus every cumulative one, and where the best came from. */
  highest(key: string, def = 0): { value: number; loc: Location } {
    return this.extremum(key, def, (a, b) => a < b);
  }

  lowest(key: string, def = 0): { value: number; loc: Location } {
    return this.extremum(key, def, (a, b) => a > b);
  }

  private extremum(key: string, def: number, comp: (a: number, b: number) => boolean): { value: number; loc: Location } {
    if (this.items.length === 0) return { value: def, loc: Location.NULL };
    let bestLoc = Location.NULL;
    let onlyCumulative = true;
    let absMax = 0;
    let flat = 0;
    let stack = 0;
    for (const p of this.items) {
      let value = Math.round(
        singleAbilityValue(this.board, p.ability.cfg.getRaw(key), def, p, this.loc, undefined, (formula, callable) =>
          Math.round(formula.evaluate(callable).asInt()),
        ),
      );
      if (p.ability.cfg.getBoolean('cumulative', false)) {
        stack += value;
        if (value < 0) value = -value;
        if (onlyCumulative && !comp(value, absMax)) {
          absMax = value;
          bestLoc = p.teacherLoc;
        }
      } else if (onlyCumulative || comp(flat, value)) {
        onlyCumulative = false;
        flat = value;
        bestLoc = p.teacherLoc;
      }
    }
    return { value: flat + stack, loc: bestLoc };
  }
}

/**
 * `get_single_ability_value`: an attribute as a number -- a WFL formula when it is `(...)`, evaluated with the
 * teaching unit's fields, the fight's `attacker`/`defender`, `student` and `other`; `def` when it is absent, a
 * boolean, translatable text, or neither.
 */
function singleAbilityValue(
  board: GameBoard,
  v: WmlStoredValue | undefined,
  def: number,
  info: ActiveAbility,
  receiverLoc: Location,
  ctx: SpecialsContext | undefined,
  formulaHandler: (formula: Formula, callable: MapFormulaCallable) => number,
): number {
  if (v === undefined || typeof v === 'boolean' || v instanceof TString) return def;
  if (typeof v === 'number') return v;
  if (v.length >= 2 && v[0] === '(') {
    try {
      const teacher = board.unitAt(info.teacherLoc);
      if (!teacher) return def;
      const callable = new MapFormulaCallable();
      callable.setFallback(new UnitCallable(teacher));
      ctx?.addFormulaContext(callable);
      const student = board.unitAt(info.studentLoc);
      if (student) callable.add('student', Variant.callable(new UnitCallable(student)));
      const other = board.unitAt(receiverLoc);
      if (other) callable.add('other', Variant.callable(new UnitCallable(other)));
      return formulaHandler(parseFormula(v, gameStateSymbols(board)), callable);
    } catch {
      return def;
    }
  }
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : def;
}

// --- which abilities are active (foreach_active_ability and its helpers) ---

/** `affects_side`: can an ability owned by a unit of `otherSide` reach a unit of `side`? */
function affectsSide(board: GameBoard, ab: UnitAbility, side: number, otherSide: number): boolean {
  if (side === otherSide) return ab.affectsAllies !== 'no';
  const team = board.getTeam(side);
  const other = board.getTeam(otherSide);
  if (team && other && team.isEnemy(other)) return ab.affectsEnemies;
  return ab.affectsAllies === 'yes';
}

/** `find_direction`: from `fromLoc`, the direction of `loc` (or of the neighbour nearest it). */
function findDirection(loc: Location, fromLoc: Location, distance: number): number {
  const adjacent = getAdjacentTiles(fromLoc);
  for (let j = 0; j < adjacent.length; j++) {
    const hit = distance !== 1 ? distanceBetween(adjacent[j]!, loc) === distance - 1 : adjacent[j]!.equals(loc);
    if (hit) return j;
  }
  return 0;
}

/** `unit::ability_active_impl`: the ability's `[filter]` matches its owner at `loc`. */
function abilityActiveImpl(board: GameBoard, unit: Unit, ab: UnitAbility, loc: Location): boolean {
  const filter = ab.cfg.child('filter');
  return !filter || unitMatchesFilter(unit, filter, board, { loc });
}

/** `unit::ability_active`. */
export function abilityActive(board: GameBoard, unit: Unit, ab: UnitAbility, loc: Location = unit.location): boolean {
  const release = ab.guard();
  if (!release) return false;
  try {
    return abilityActiveImpl(board, unit, ab, loc);
  } finally {
    release();
  }
}

/** `unit::ability_affects_adjacent`: does one of the ability's `[affect_adjacent]` reach `unit` at `loc` from `from`? */
function abilityAffectsAdjacent(board: GameBoard, unit: Unit, ab: UnitAbility, dist: number, dir: number, loc: Location, from: Unit): boolean {
  for (const adj of ab.cfg.children('affect_adjacent')) {
    if (adj.getString('radius', '') !== 'all_map') {
      const raw = adj.getString('radius', '1');
      const radius = raw.trim() !== '' && Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : 1;
      if (radius <= 0 || dist > radius) continue;
    }
    if (adj.hasAttribute('adjacent')) {
      const dirs = splitList(adj.getString('adjacent')).map((d) => parseDirection(d));
      if (!dirs.includes(dir as Direction)) continue;
    }
    const filter = adj.child('filter');
    if (!filter || unitMatchesFilter(unit, filter, board, { loc, other: from })) return true;
  }
  return false;
}

/** `unit::ability_affects_self`: `affect_self=`, and the ability's `[filter_self]`. */
export function abilityAffectsSelf(board: GameBoard, unit: Unit, ab: UnitAbility, loc: Location = unit.location): boolean {
  const filter = ab.cfg.child('filter_self');
  if (!filter || !ab.affectsSelf) return ab.affectsSelf;
  return unitMatchesFilter(unit, filter, board, { loc });
}

/** `unit::get_self_ability_bool`. */
function selfAbilityBool(board: GameBoard, unit: Unit, ab: UnitAbility, loc: Location): boolean {
  const release = ab.guard();
  if (!release) return false;
  try {
    return abilityActiveImpl(board, unit, ab, loc) && abilityAffectsSelf(board, unit, ab, loc);
  } finally {
    release();
  }
}

/** `unit::get_adj_ability_bool`: an ability of `from` (at `fromLoc`) reaching `unit` at `loc`. */
function adjAbilityBool(board: GameBoard, unit: Unit, ab: UnitAbility, dist: number, dir: number, loc: Location, from: Unit, fromLoc: Location): boolean {
  const release = ab.guard();
  if (!release) return false;
  try {
    return affectsSide(board, ab, unit.side, from.side) && abilityActiveImpl(board, from, ab, fromLoc) && abilityAffectsAdjacent(board, unit, ab, dist, dir, loc, from);
  } finally {
    release();
  }
}

/** What abilities a search is after (`tag_check` and the like), and how far a unit's can reach for it. */
export interface QuickCheck {
  (ab: UnitAbility): boolean;
  /** `get_unit_radius`: the widest radius of the abilities this check is for; the unit's widest otherwise. */
  radius?: (u: Unit) => number;
}

export function tagCheck(tag: string): QuickCheck {
  const check: QuickCheck = (ab) => ab.tag === tag;
  check.radius = (u) => u.maxAbilityRadius(tag);
  return check;
}

/** `foreach_distant_active_ability`: abilities other units teach `un` at `loc` through `[affect_adjacent]`. */
export function foreachDistantActiveAbility(
  board: GameBoard,
  un: Unit,
  loc: Location,
  quickCheck: QuickCheck,
  handler: (ab: UnitAbility, source: Unit) => boolean | void,
): boolean {
  for (const u of board.allUnits()) {
    if (!u.maxAbilityRadiusAny() || u.incapacitated || isSameUnit(u, un)) continue;
    const radius = quickCheck.radius ? quickCheck.radius(u) : u.maxAbilityRadiusAny();
    if (!radius) continue;
    const fromLoc = u.location;
    const distance = distanceBetween(fromLoc, loc);
    if (distance > radius) continue;
    const dir = findDirection(loc, fromLoc, distance);
    for (const ab of unitAbilities(u)) {
      if (!quickCheck(ab)) continue;
      if (adjAbilityBool(board, un, ab, distance, dir, loc, u, fromLoc) && handler(ab, u) === true) return true;
    }
  }
  return false;
}

/** `u.underlying_id() == un.underlying_id()`: the same unit (a copy of it counts). */
function isSameUnit(a: Unit, b: Unit): boolean {
  return a === b || (a.underlyingId !== 0 && a.underlyingId === b.underlyingId);
}

/** `foreach_self_active_ability`. */
function foreachSelfActiveAbility(board: GameBoard, un: Unit, loc: Location, quickCheck: QuickCheck, handler: (ab: UnitAbility, source: Unit) => boolean | void): boolean {
  for (const ab of unitAbilities(un)) {
    if (!quickCheck(ab)) continue;
    if (selfAbilityBool(board, un, ab, loc) && handler(ab, un) === true) return true;
  }
  return false;
}

/**
 * `foreach_active_ability`: every active ability of `un` at `loc`, its own and those taught to it, passed to
 * `handler`; a handler returning true stops the search, and the function returns true.
 */
export function foreachActiveAbility(
  board: GameBoard,
  un: Unit,
  loc: Location,
  quickCheck: QuickCheck,
  handler: (ab: UnitAbility, source: Unit) => boolean | void,
  skipAdjacent = false,
): boolean {
  if (foreachSelfActiveAbility(board, un, loc, quickCheck, handler)) return true;
  if (!skipAdjacent && foreachDistantActiveAbility(board, un, loc, quickCheck, handler)) return true;
  return false;
}

/** `unit::get_ability_bool`: has `un` at `loc` any active ability with this tag? */
export function getAbilityBool(board: GameBoard, un: Unit, tag: string, loc: Location = un.location): boolean {
  return foreachActiveAbility(board, un, loc, tagCheck(tag), () => true);
}

/** `unit::get_abilities`: the active abilities with this tag reaching `un` at `loc`. */
export function getAbilities(board: GameBoard, un: Unit, tag: string, loc: Location = un.location): ActiveAbilityList {
  const res = new ActiveAbilityList(board, un.location);
  foreachActiveAbility(board, un, loc, tagCheck(tag), (ab, u2) => {
    res.push(ab, loc, u2.location);
  });
  return res;
}

/** `specials_context_t::has_active_ability_id`. */
export function hasActiveAbilityId(board: GameBoard, un: Unit, loc: Location, id: string): boolean {
  return foreachActiveAbility(board, un, loc, (ab) => ab.id === id, () => true);
}

/** `specials_context_t::has_active_ability_matching_filter` (`[filter_ability] active=yes`). */
export function hasActiveAbilityMatchingFilter(board: GameBoard, un: Unit, loc: Location, filter: WmlConfig): boolean {
  const skipAdjacent = !filter.getBoolean('affect_adjacent', true);
  return foreachActiveAbility(board, un, loc, (ab) => ab.matchesFilter(filter), () => true, skipAdjacent);
}

/** `unit::ability_tooltips(active_list, loc)`: each named ability, and whether it is active there. */
export function abilityTooltips(board: GameBoard, unit: Unit, loc: Location = unit.location): { name: string; description: string; helpTopicId: string; active: boolean }[] {
  const female = unit.gender === 'female';
  const res: { name: string; description: string; helpTopicId: string; active: boolean }[] = [];
  for (const ab of unitAbilities(unit)) {
    const active = abilityActive(board, unit, ab, loc);
    const name = ab.getName(!active, female);
    if (name === '') continue;
    res.push({ name, description: ab.getDescription(!active, female), helpTopicId: ab.helpTopicId(), active });
  }
  return res;
}

/** `unit::halo_or_icon_abilities`: the halo (or overlay) images of the active abilities on and around a unit. */
export function haloOrIconAbilities(board: GameBoard, unit: Unit, imageType: 'halo' | 'overlay'): string[] {
  const attr = `${imageType}_image`;
  const images = new Set<string>();
  for (const ab of unitAbilities(unit)) {
    const active = abilityActive(board, unit, ab, unit.location);
    if (ab.cfg.getString(attr, '') !== '' && active && abilityAffectsSelf(board, unit, ab, unit.location)) images.add(ab.cfg.getString(attr));
    if (ab.cfg.getString(`${imageType}_image_self`, '') !== '' && active) images.add(ab.cfg.getString(`${imageType}_image_self`));
  }
  const check: QuickCheck = (ab) => ab.cfg.getString(attr, '') !== '';
  foreachDistantActiveAbility(board, unit, unit.location, check, (ab) => {
    images.add(ab.cfg.getString(attr));
  });
  return [...images].sort();
}

// --- matches_ability_filter (unit_ability_t::matches_filter) and utils/config_filters.cpp ---

const filterHas = (filter: WmlConfig, key: string): boolean => filter.hasAttribute(key);

function boolMatchesIfPresent(filter: WmlConfig, cfg: WmlConfig, attr: string, def: boolean): boolean {
  if (!filterHas(filter, attr)) return true;
  return filter.getBoolean(attr) === cfg.getBoolean(attr, def);
}

function stringMatchesIfPresent(filter: WmlConfig, cfg: WmlConfig, attr: string, def: string): boolean {
  if (!filterHas(filter, attr)) return true;
  return splitList(filter.getString(attr)).includes(cfg.getString(attr, def));
}

function setIncludesIfPresent(filter: WmlConfig, cfg: WmlConfig, attr: string): boolean {
  if (!filterHas(filter, attr)) return true;
  if (!cfg.hasAttribute(attr)) return false;
  const have = new Set(splitList(cfg.getString(attr)));
  return splitList(filter.getString(attr)).every((v) => have.has(v));
}

const inRanges = (n: number, text: string): boolean => parseRanges(text).some(([lo, hi]) => n >= lo && n <= hi);

function intMatchesIfPresent(filter: WmlConfig, cfg: WmlConfig, attr: string, def?: number): boolean {
  if (!filterHas(filter, attr)) return true;
  if (!cfg.hasAttribute(attr) && def === undefined) return false;
  if (filter.getString(attr) === 'default' && def !== undefined) return Math.trunc(cfg.getNumber(attr, def)) === def;
  return inRanges(Math.trunc(cfg.getNumber(attr, def ?? 0)), filter.getString(attr));
}

function intMatchesIfPresentOrNegative(filter: WmlConfig, cfg: WmlConfig, attr: string, opposite: string, def?: number): boolean {
  if (intMatchesIfPresent(filter, cfg, attr, def)) return true;
  if (!cfg.hasAttribute(attr)) {
    if (!cfg.hasAttribute(opposite) && def === undefined) return false;
    if (filter.getString(attr) === 'default' && def !== undefined) return Math.trunc(cfg.getNumber(attr, def)) === def;
    return inRanges(-Math.trunc(cfg.getNumber(opposite, def ?? 0)), filter.getString(attr));
  }
  return false;
}

function doubleMatchesIfPresent(filter: WmlConfig, cfg: WmlConfig, attr: string, def?: number): boolean {
  if (!filterHas(filter, attr)) return true;
  if (!cfg.hasAttribute(attr) && def === undefined) return false;
  if (filter.getString(attr) === 'default' && def !== undefined) return Math.trunc(cfg.getNumber(attr, def)) === def;
  return inRanges(cfg.getNumber(attr, def ?? 1), filter.getString(attr));
}

function boolOrEmpty(filter: WmlConfig, cfg: WmlConfig, attr: string): boolean {
  if (!filterHas(filter, attr)) return true;
  const wanted = new Set(splitList(filter.getString(attr)));
  let matches = false;
  if (cfg.hasAttribute(attr)) {
    if (wanted.has('yes') || wanted.has('true')) matches = cfg.getBoolean(attr);
    if (!matches && (wanted.has('no') || wanted.has('false'))) matches = !cfg.getBoolean(attr);
  } else if (wanted.has('none')) {
    matches = true;
  }
  return matches;
}

/** `exclude_ability_attributes`: a filter attribute this kind of ability cannot have matches nothing. */
function excludeAbilityAttributes(tag: string, filter: WmlConfig): boolean {
  const abilitiesCheck = ABILITY_VALUE_TAGS.has(tag) || ABILITY_NO_VALUE_TAGS.has(tag);
  if (filter.hasAttribute('active_on') && tag !== 'resistance' && abilitiesCheck) return false;
  if (filter.hasAttribute('apply_to') && tag !== 'resistance' && abilitiesCheck) return false;
  if (filter.hasAttribute('overwrite_specials') && !WEAPON_MATH_TAGS.has(tag)) return false;
  const noValue = NO_WEAPON_MATH_TAGS.has(tag) || ABILITY_NO_VALUE_TAGS.has(tag);
  // Upstream's `(tag_name != "swarm" || tag_name != "berserk")` is always true.
  if (filter.hasAttribute('cumulative') && noValue) return false;
  if (filter.hasAttribute('value') && noValue && tag !== 'berserk') return false;
  for (const key of ['add', 'sub', 'multiply', 'divide', 'priority']) {
    if (filter.hasAttribute(key) && noValue) return false;
  }
  const allEngine = NO_WEAPON_MATH_TAGS.has(tag) || WEAPON_MATH_TAGS.has(tag) || ABILITY_VALUE_TAGS.has(tag) || ABILITY_NO_VALUE_TAGS.has(tag);
  if (filter.hasAttribute('replacement_type') && tag !== 'damage_type' && allEngine) return false;
  if (filter.hasAttribute('alternative_type') && tag !== 'damage_type' && allEngine) return false;
  if (filter.hasAttribute('type') && tag !== 'plague' && allEngine) return false;
  return true;
}

function matchesAbilityFilter(cfg: WmlConfig, tag: string, filter: WmlConfig): boolean {
  if (!excludeAbilityAttributes(tag, filter)) return false;
  const tagNames = splitList(filter.getString('tag_name', ''));
  if (tagNames.length > 0 && !tagNames.includes(tag)) return false;
  if (!stringMatchesIfPresent(filter, cfg, 'id', '')) return false;
  if (filter.getString('affect_adjacent', '') !== '' && filter.getBoolean('affect_adjacent') !== cfg.hasChild('affect_adjacent')) return false;
  if (!boolMatchesIfPresent(filter, cfg, 'affect_self', true)) return false;
  if (!boolOrEmpty(filter, cfg, 'affect_allies')) return false;
  if (!boolMatchesIfPresent(filter, cfg, 'affect_enemies', false)) return false;
  if (!boolMatchesIfPresent(filter, cfg, 'cumulative', false)) return false;
  if (!stringMatchesIfPresent(filter, cfg, 'overwrite_specials', 'none')) return false;
  if (!stringMatchesIfPresent(filter, cfg, 'active_on', 'both')) return false;
  if (WEAPON_MATH_TAGS.has(tag) || ABILITY_VALUE_TAGS.has(tag)) {
    if (!doubleMatchesIfPresent(filter, cfg, 'priority', 0)) return false;
  } else if (!doubleMatchesIfPresent(filter, cfg, 'priority')) {
    return false;
  }
  if (filter.getString('value', '') !== '') {
    const def = tag === 'drains' ? 50 : tag === 'berserk' ? 1 : tag === 'heal_on_hit' || tag === 'heals' || tag === 'regenerate' || tag === 'leadership' ? 0 : undefined;
    if (!intMatchesIfPresent(filter, cfg, 'value', def)) return false;
  }
  if (!intMatchesIfPresentOrNegative(filter, cfg, 'add', 'sub')) return false;
  if (!intMatchesIfPresentOrNegative(filter, cfg, 'sub', 'add')) return false;
  if (!doubleMatchesIfPresent(filter, cfg, 'multiply')) return false;
  if (!doubleMatchesIfPresent(filter, cfg, 'divide')) return false;
  if (tag === 'resistance') {
    if (!setIncludesIfPresent(filter, cfg, 'apply_to')) return false;
  } else if (!stringMatchesIfPresent(filter, cfg, 'apply_to', 'self')) {
    return false;
  }
  if (!stringMatchesIfPresent(filter, cfg, 'replacement_type', '')) return false;
  if (!stringMatchesIfPresent(filter, cfg, 'alternative_type', '')) return false;
  if (!stringMatchesIfPresent(filter, cfg, 'type', '')) return false;
  const fwml = filter.child('filter_wml');
  if (fwml && !configMatches(cfg, fwml)) return false;
  return true;
}

function commonMatchesFilter(cfg: WmlConfig, tag: string, filter: WmlConfig): boolean {
  let matches = matchesAbilityFilter(cfg, tag, filter);
  for (const { tag: key, config } of filter.allChildren()) {
    if (key === 'and') matches = matches && commonMatchesFilter(cfg, tag, config);
    else if (key === 'or') matches = matches || commonMatchesFilter(cfg, tag, config);
    else if (key === 'not') matches = matches && !commonMatchesFilter(cfg, tag, config);
  }
  return matches;
}

// --- unit_abilities::effect ---

/** `unit_abilities::EFFECTS`. */
export type EffectMode = 'default' | 'cumulable' | 'without_clamp_min_max';

export interface IndividualEffect {
  readonly type: 'set' | 'add' | 'mul' | 'div';
  readonly value: number;
  readonly ability: WmlConfig;
  readonly loc: Location;
}

export interface AbilityEffect {
  readonly compositeValue: number;
  readonly compositeDoubleValue: number;
  readonly effects: readonly IndividualEffect[];
}

/** `filter_base_matches`: the value being modified satisfies the ability's `[filter_base_value]`. */
export function filterBaseMatches(cfg: WmlConfig, def: number): boolean {
  const f = cfg.child('filter_base_value');
  if (!f) return true;
  const cond = (key: string, test: (v: number) => boolean): boolean => !f.hasAttribute(key) || f.getString(key) === '' || test(Math.trunc(f.getNumber(key)));
  return (
    cond('equals', (v) => def === v) &&
    cond('not_equals', (v) => def !== v) &&
    cond('less_than', (v) => def < v) &&
    cond('greater_than', (v) => def > v) &&
    cond('greater_than_equal_to', (v) => def >= v) &&
    cond('less_than_equal_to', (v) => def <= v)
  );
}

function individualValueInt(board: GameBoard, v: WmlStoredValue | undefined, def: number, ability: ActiveAbility, loc: Location, ctx: SpecialsContext | undefined): number {
  return Math.round(
    singleAbilityValue(board, v, def, ability, loc, ctx, (formula, callable) => {
      callable.add('base_value', Variant.int(def));
      return Math.round(formula.evaluate(callable).asInt());
    }),
  );
}

function individualValueDouble(board: GameBoard, v: WmlStoredValue | undefined, def: number, ability: ActiveAbility, loc: Location, ctx: SpecialsContext | undefined): number {
  return Math.round(
    singleAbilityValue(board, v, def, ability, loc, ctx, (formula, callable) => {
      callable.add('base_value', Variant.int(def));
      return formula.evaluate(callable).asDecimal() / 1000;
    }) * 100,
  );
}

/** `unit_abilities::effect`: the abilities in `list` applied to `def`, priority group by priority group (lowest first). */
export function abilityEffect(list: ActiveAbilityList, def: number, ctx?: SpecialsContext, wham: EffectMode = 'default'): AbilityEffect {
  const groups = new Map<number, ActiveAbility[]>();
  for (const i of list.items) {
    const group = groups.get(i.ability.priority);
    if (group) group.push(i);
    else groups.set(i.ability.priority, [i]);
  }
  const effects: IndividualEffect[] = [];
  let value = def;
  let composite = { value: def, double: def };
  for (const priority of [...groups.keys()].sort((a, b) => a - b)) {
    composite = effectImpl(list.board, groups.get(priority)!, list.loc, value, ctx, wham, effects);
    value = composite.value;
  }
  return { compositeValue: composite.value, compositeDoubleValue: composite.double, effects };
}

function effectImpl(
  board: GameBoard,
  list: readonly ActiveAbility[],
  loc: Location,
  def: number,
  ctx: SpecialsContext | undefined,
  wham: EffectMode,
  effects: IndividualEffect[],
): { value: number; double: number } {
  let valueSet = def;
  const valuesAdd = new Map<string, IndividualEffect>();
  const valuesSub = new Map<string, IndividualEffect>();
  const valuesMul = new Map<string, IndividualEffect>();
  const valuesDiv = new Map<string, IndividualEffect>();
  let setMax: IndividualEffect | undefined;
  let setMin: IndividualEffect | undefined;
  let setCum: IndividualEffect | undefined;
  let maxValue: number | undefined;
  let minValue: number | undefined;
  const effect = (type: IndividualEffect['type'], v: number, ability: ActiveAbility): IndividualEffect => ({ type, value: v, ability: ability.ability.cfg, loc: ability.teacherLoc });

  for (const ability of list) {
    const cfg = ability.ability.cfg;
    const effectId = cfg.getString('id', '') === '' ? cfg.getString('name', '') : cfg.getString('id');
    if (!filterBaseMatches(cfg, def)) continue;

    if (cfg.hasAttribute('value')) {
      const v = individualValueInt(board, cfg.getRaw('value'), def, ability, loc, ctx);
      const cumulative = cfg.getBoolean('cumulative', false);
      const valueCum = wham !== 'cumulable' && cumulative ? Math.max(def, v) : v;
      if (setCum && wham === 'cumulable' && cumulative) {
        setCum = effect('set', setCum.value + valueCum, ability);
      } else if (wham === 'cumulable' && cumulative) {
        setCum = effect('set', valueCum, ability);
      } else if (!setMin || !setMax) {
        setMin = effect('set', valueCum, ability);
        setMax = effect('set', valueCum, ability);
      } else {
        if (valueCum > setMax.value) setMax = effect('set', valueCum, ability);
        if (valueCum < setMin.value) setMin = effect('set', valueCum, ability);
      }
    }

    if (wham !== 'without_clamp_min_max') {
      if (cfg.hasAttribute('max_value')) {
        const v = individualValueInt(board, cfg.getRaw('max_value'), def, ability, loc, ctx);
        maxValue = maxValue === undefined ? v : Math.min(maxValue, v);
      }
      if (cfg.hasAttribute('min_value')) {
        const v = individualValueInt(board, cfg.getRaw('min_value'), def, ability, loc, ctx);
        minValue = minValue === undefined ? v : Math.max(minValue, v);
      }
    }

    if (cfg.hasAttribute('add')) {
      const add = individualValueInt(board, cfg.getRaw('add'), def, ability, loc, ctx);
      const prev = valuesAdd.get(effectId);
      if (!prev || add > prev.value) valuesAdd.set(effectId, effect('add', add, ability));
    }
    if (cfg.hasAttribute('sub')) {
      const sub = -individualValueInt(board, cfg.getRaw('sub'), def, ability, loc, ctx);
      const prev = valuesSub.get(effectId);
      if (!prev || sub < prev.value) valuesSub.set(effectId, effect('add', sub, ability));
    }
    if (cfg.hasAttribute('multiply')) {
      const mul = individualValueDouble(board, cfg.getRaw('multiply'), def, ability, loc, ctx);
      const prev = valuesMul.get(effectId);
      if (!prev || mul > prev.value) valuesMul.set(effectId, effect('mul', mul, ability));
    }
    if (cfg.hasAttribute('divide')) {
      const divide = individualValueDouble(board, cfg.getRaw('divide'), def, ability, loc, ctx);
      if (divide !== 0) {
        const prev = valuesDiv.get(effectId);
        if (!prev || divide > prev.value) valuesDiv.set(effectId, effect('div', divide, ability));
      }
    }
  }

  if (setMax && setMin) {
    valueSet = Math.max(setMax.value, 0) + Math.min(setMin.value, 0);
    if (setMax.value > def) effects.push(setMax);
    if (setMin.value < def) effects.push(setMin);
  }

  const byKey = <T>(m: Map<string, T>): T[] => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  let multiplier = 1;
  let divisor = 1;
  for (const v of byKey(valuesMul)) {
    multiplier *= v.value / 100;
    effects.push(v);
  }
  for (const v of byKey(valuesDiv)) {
    divisor *= v.value / 100;
    effects.push(v);
  }
  let addition = 0;
  for (const v of byKey(valuesAdd)) {
    addition += v.value;
    effects.push(v);
  }
  // Since 1.19.4, addition and subtraction are independent.
  let subtraction = 0;
  for (const v of byKey(valuesSub)) {
    subtraction += v.value;
    effects.push(v);
  }
  if (setCum) {
    valueSet += setCum.value;
    effects.push(setCum);
  }

  let compositeDouble = ((valueSet + addition + subtraction) * multiplier) / divisor;
  if (maxValue !== undefined && minValue !== undefined && minValue < maxValue) {
    // Upstream calls `std::clamp(min_value, max_value, composite)`, arguments in that order: with min_value below
    // max_value, libstdc++'s clamp returns max_value whatever the composite. Ported as it behaves.
    compositeDouble = maxValue;
  } else if (maxValue !== undefined && minValue === undefined) {
    compositeDouble = Math.min(maxValue, compositeDouble);
  } else if (minValue !== undefined && maxValue === undefined) {
    compositeDouble = Math.max(minValue, compositeDouble);
  }
  return { value: Math.round(compositeDouble), double: compositeDouble };
}

// --- abilities used for a unit's numbers ---

/** `under_leadership(u, loc)`: the leadership bonus on `u` at `loc`. */
export function underLeadership(board: GameBoard, u: Unit, loc: Location = u.location): number {
  return abilityEffect(getAbilities(board, u, 'leadership', loc), 0, undefined, 'cumulable').compositeValue;
}

/** `unit::resistance_filter_matches`: a resistance ability applies to this damage type, given the resistance so far. */
function resistanceFilterMatches(cfg: WmlConfig, damageName: string, res: number): boolean {
  const applyTo = cfg.getString('apply_to', '');
  if (applyTo !== '' && damageName !== applyTo) {
    if (applyTo.includes(',') && applyTo.includes(damageName)) {
      if (!splitList(applyTo).includes(damageName)) return false;
    } else {
      return false;
    }
  }
  return filterBaseMatches(cfg, res);
}

/** `unit::resistance_value`: the unit's damage taken from this type (100 is normal) with the given resistance abilities. */
export function resistanceValue(unit: Unit, list: ActiveAbilityList, damageName: string): number {
  let res = unit.resistanceAgainst(damageName);
  const applicable = list.filter((i) => resistanceFilterMatches(i.ability.cfg, damageName, 100 - res));
  if (applicable.length > 0) res = 100 - abilityEffect(applicable, 100 - res).compositeValue;
  return res;
}

/** `unit::resistance_against(damage, attacker, loc)`: with the unit's active resistance abilities. */
export function resistanceAgainst(board: GameBoard, unit: Unit, damageName: string, attacker: boolean, loc: Location = unit.location): number {
  const list = getAbilities(board, unit, 'resistance', loc).filter((i) => i.ability.activeOnMatches(attacker));
  return resistanceValue(unit, list, damageName);
}

/** `unit::defense_modifier(terrain, loc)`: the chance to be hit there, with the unit's `[defense]` abilities. */
export function defenseModifier(board: GameBoard, unit: Unit, terrain: TerrainCode, loc: Location = unit.location): number {
  let def = unit.defenseModifier(terrain);
  const list = getAbilities(board, unit, 'defense', loc);
  if (list.length > 0) def = 100 - abilityEffect(list, 100 - def).compositeValue;
  return def;
}

// --- specials_context_t ---

/** `specials_context_t::specials_combatant`: one side of a fight -- the unit (if known), its hex and its weapon. */
export interface SpecialsCombatant {
  readonly un?: Unit;
  readonly loc: Location;
  readonly at?: AttackType;
}

/**
 * `specials_context_t`: a fight's two combatants, against which specials and weapon abilities are evaluated.
 * Pass `ctx.attacker` or `ctx.defender` wherever upstream passes an `attack_type`.
 */
export class SpecialsContext {
  readonly attacker: SpecialsCombatant;
  readonly defender: SpecialsCombatant;
  /** `is_for_listing`: describing a weapon with no known opponent, so filters on the absent one pass. */
  isForListing = false;

  constructor(
    readonly board: GameBoard,
    attacker: SpecialsCombatant,
    defender: SpecialsCombatant,
  ) {
    this.attacker = { ...attacker };
    this.defender = { ...defender };
  }

  /** `specials_context_t::make`: `self` attacks when `attacking`, else defends. */
  static make(board: GameBoard, self: SpecialsCombatant, other: SpecialsCombatant, attacking: boolean): SpecialsContext {
    return attacking ? new SpecialsContext(board, self, other) : new SpecialsContext(board, other, self);
  }

  /** `attack_type::fallback_context`: a weapon on its own, as if attacking an unknown opponent. */
  static fallback(board: GameBoard, at: AttackType, self?: Unit): SpecialsContext {
    return new SpecialsContext(board, { un: self, loc: self ? self.location : Location.NULL, at }, { loc: Location.NULL });
  }

  other(self: SpecialsCombatant): SpecialsCombatant {
    return self === this.attacker ? this.defender : this.attacker;
  }

  /** The combatant record for a unit of this fight (`self_and_other(unit)`), the defender's when it is not the attacker. */
  combatantOf(un: Unit): SpecialsCombatant {
    return un === this.attacker.un ? this.attacker : this.defender;
  }

  addFormulaContext(callable: MapFormulaCallable): void {
    if (this.attacker.un) callable.add('attacker', Variant.callable(new UnitCallable(this.attacker.un)));
    if (this.defender.un) callable.add('defender', Variant.callable(new UnitCallable(this.defender.un)));
  }

  /** `is_special_active`: is `ab` active for `self` in this fight, for whom it is to affect? */
  isSpecialActive(self: SpecialsCombatant, ab: UnitAbility, whom: Affects): boolean {
    const isAttacker = self === this.attacker;
    const other = this.other(self);
    if (whom === 'self' && !specialAffectsSelf(ab, isAttacker)) return false;
    if (whom === 'other' && !specialAffectsOpponent(ab, isAttacker)) return false;
    if (!ab.activeOnMatches(isAttacker)) return false;

    // WML may have replaced a unit during an attack event: then it is found by its hex.
    const selfU = self.un ?? this.board.unitAt(self.loc);
    const otherU = other.un ?? this.board.unitAt(other.loc);

    // Make sure they're facing each other (`temporary_facing`).
    const restore: Array<() => void> = [];
    const face = (u: Unit | undefined, dir: Direction): void => {
      if (!u) return;
      const saved = u.facing;
      u.facing = dir;
      restore.push(() => {
        u.facing = saved;
      });
    };
    face(selfU, relativeDirection(self.loc, other.loc));
    face(otherU, relativeDirection(other.loc, self.loc));
    try {
      const whomIsSelf = whom === 'self' || (whom === 'either' && specialAffectsSelf(ab, isAttacker));
      const them = whomIsSelf ? otherU : selfU;
      const theirLoc = whomIsSelf ? other.loc : self.loc;
      if (builtinIsImmune(this.board, ab, them, theirLoc)) return false;

      const att = isAttacker ? selfU : otherU;
      const def = isAttacker ? otherU : selfU;

      // Both units having first strike cancel out. Only the defender's is checked, else this would recurse.
      if (ab.tag === 'firststrike') {
        const whomIsDefender = whomIsSelf ? !isAttacker : isAttacker;
        if (whomIsDefender && this.attacker.at && this.hasSpecialOrAbility(this.attacker, 'firststrike')) return false;
      }

      const appliedBoth = ab.applyTo === 'both';
      const filterSelf = ab.inSpecialsTag ? 'filter_self' : 'filter_student';
      if (!this.specialUnitMatches(selfU, otherU, self, ab, filterSelf, appliedBoth || whomIsSelf)) return false;
      if (!this.specialUnitMatches(otherU, selfU, other, ab, 'filter_opponent', appliedBoth || !whomIsSelf)) return false;
      const appliedToAttacker = appliedBoth || (whomIsSelf && isAttacker) || (!whomIsSelf && !isAttacker);
      if (!this.specialUnitMatches(att, def, this.attacker, ab, 'filter_attacker', appliedToAttacker)) return false;
      const appliedToDefender = appliedBoth || (whomIsSelf && !isAttacker) || (!whomIsSelf && isAttacker);
      if (!this.specialUnitMatches(def, att, this.defender, ab, 'filter_defender', appliedToDefender)) return false;
      return true;
    } finally {
      for (const r of restore.reverse()) r();
    }
  }

  /**
   * `special_unit_matches`: `u` (with `u2` the other unit), whose weapon is `weaponOf`'s, matches the special's
   * `childTag` filter and its `[filter_weapon]`.
   */
  private specialUnitMatches(u: Unit | undefined, u2: Unit | undefined, weaponOf: SpecialsCombatant, ab: UnitAbility, childTag: string, appliesToChecked: boolean): boolean {
    const loc = weaponOf.loc;
    // The opponent is unknown (a weapon described on its own): assume the special can be made to apply.
    if (this.isForListing && !loc.valid()) return true;
    const filter = ab.cfg.child(childTag);
    if (!filter) return true;
    if (!u) return false;
    const release = ab.guard();
    if (!release) return false;
    try {
      const filterWeapon = filter.child('filter_weapon');
      if (filterWeapon) {
        const checkIfRecursion = appliesToChecked ? ab.tag : '';
        if (!weaponOf.at || !this.weaponMatchesFilter(weaponOf, filterWeapon, checkIfRecursion)) return false;
      }
      return unitMatchesFilter(u, filter, this.board, { loc, other: u2 });
    } finally {
      release();
    }
  }

  /**
   * `foreach_active_special`: the specials and weapon abilities active for `self` -- its weapon's, the
   * opponent's weapon's that apply to it, and both units' abilities (with those taught by neighbours).
   */
  foreachActiveSpecial(
    self: SpecialsCombatant,
    quickCheck: QuickCheck,
    handler: (ab: UnitAbility, student: SpecialsCombatant, source: AttackType | Unit) => boolean | void,
    skipAdjacent = false,
  ): boolean {
    const other = this.other(self);
    const handlerSelf = (ab: UnitAbility, source: AttackType | Unit): boolean => this.isSpecialActive(self, ab, 'self') && handler(ab, self, source) === true;
    const handlerOther = (ab: UnitAbility, source: AttackType | Unit): boolean => this.isSpecialActive(other, ab, 'other') && handler(ab, other, source) === true;
    if (self.at) {
      for (const ab of weaponSpecials(self.at)) if (quickCheck(ab) && handlerSelf(ab, self.at)) return true;
    }
    if (other.at) {
      for (const ab of weaponSpecials(other.at)) if (quickCheck(ab) && handlerOther(ab, other.at)) return true;
    }
    if (self.un && foreachActiveAbility(this.board, self.un, self.loc, quickCheck, (ab, source) => handlerSelf(ab, source), skipAdjacent)) return true;
    if (other.un && foreachActiveAbility(this.board, other.un, other.loc, quickCheck, (ab, source) => handlerOther(ab, source), skipAdjacent)) return true;
    return false;
  }

  /** `has_active_special`: an active special or weapon ability with this tag. */
  hasActiveSpecial(self: SpecialsCombatant, tag: string): boolean {
    return this.foreachActiveSpecial(self, (ab) => ab.tag === tag, () => true);
  }

  /** `has_active_special_id`. */
  hasActiveSpecialId(self: SpecialsCombatant, id: string): boolean {
    // A placeholder weapon (no range) has no specials, even through abilities.
    if (!self.at || self.at.range === '') return false;
    return this.foreachActiveSpecial(self, (ab) => ab.id === id, () => true);
  }

  /** `has_active_special_matching_filter`. */
  hasActiveSpecialMatchingFilter(self: SpecialsCombatant, filter: WmlConfig): boolean {
    if (!self.at || self.at.range === '') return false;
    const skipAdjacent = !filter.getBoolean('affect_adjacent', true);
    return this.foreachActiveSpecial(self, (ab) => ab.matchesFilter(filter), () => true, skipAdjacent);
  }

  /** `get_active_specials`: every active special or weapon ability with this tag, for `self`. */
  getActiveSpecials(self: SpecialsCombatant, tag: string): ActiveAbilityList {
    const res = new ActiveAbilityList(this.board, self.un ? self.un.location : self.loc);
    this.foreachActiveSpecial(self, (ab) => ab.tag === tag, (ab, student, source) => {
      if (source instanceof AttackType) res.push(ab, student.loc, student.loc);
      else res.push(ab, student.un!.location, source.location);
    });
    return res;
  }

  /** `get_abilities_weapons`: `self`'s unit's abilities with this tag that are active as specials in this fight. */
  getAbilitiesWeapons(self: SpecialsCombatant, tag: string): ActiveAbilityList {
    if (!self.un) return new ActiveAbilityList(this.board, self.loc);
    return getAbilities(this.board, self.un, tag, self.loc).filter((i) => this.isSpecialActive(self, i.ability, 'self'));
  }

  /** `get_active_combat_teachers`: the weapon abilities neighbours teach to either combatant. */
  getActiveCombatTeachers(self: SpecialsCombatant): ActiveAbilityList {
    const other = this.other(self);
    const res = new ActiveAbilityList(this.board, self.un ? self.un.location : self.loc);
    const check: QuickCheck = (ab) => ALL_WEAPON_TAGS.has(ab.tag);
    if (self.un) {
      foreachDistantActiveAbility(this.board, self.un, self.loc, check, (ab, teacher) => {
        if (this.isSpecialActive(self, ab, 'self')) res.push(ab, self.un!.location, teacher.location);
      });
    }
    if (other.un) {
      foreachDistantActiveAbility(this.board, other.un, other.loc, check, (ab, teacher) => {
        if (this.isSpecialActive(other, ab, 'other')) res.push(ab, other.un!.location, teacher.location);
      });
    }
    return res;
  }

  // --- attack_type, in this context ---

  /** `attack_type::get_specials_and_abilities`: the active ones with this tag, less those others overwrite. */
  getSpecialsAndAbilities(self: SpecialsCombatant, tag: string): ActiveAbilityList {
    const list = this.getActiveSpecials(self, tag);
    const overwriters = this.overwriteSpecialOverwriter(self, list.items);
    if (list.length > 0 && overwriters.length > 0) return list.filter((j) => !this.overwriteSpecialChecking(self, overwriters, j));
    return list;
  }

  /** `overwrite_special_overwriter`: those with `overwrite_specials=`, highest `[overwrite] priority=` first, less those overwritten in turn. */
  private overwriteSpecialOverwriter(self: SpecialsCombatant, items: readonly ActiveAbility[]): ActiveAbility[] {
    let overwriters = items.filter((i) => overwriteSpecialAffects(i.ability));
    if (overwriters.length >= 2) {
      const prio = (i: ActiveAbility): number => {
        const o = i.ability.cfg.child('overwrite');
        return o && o.getString('priority', '') !== '' ? o.getNumber('priority', 0) : 0;
      };
      overwriters = [...overwriters].sort((a, b) => prio(b) - prio(a));
      // Upstream evaluates this while erasing from the same list; here each is checked against the sorted list.
      const sorted = overwriters;
      overwriters = sorted.filter((i) => !this.overwriteSpecialChecking(self, sorted, i));
    }
    return overwriters;
  }

  /** `overwrite_special_checking`: is `i` overwritten by one of `overwriters`? */
  private overwriteSpecialChecking(self: SpecialsCombatant, overwriters: readonly ActiveAbility[], i: ActiveAbility): boolean {
    if (overwriters.length === 0) return false;
    const other = this.other(self);
    const ab = i.ability;
    const loc = i.studentLoc;
    for (const j of overwriters) {
      const ovLoc = j.studentLoc;
      const affectSide = j.ability.cfg.getString('overwrite_specials', '') === 'one_side';
      const overwrite = j.ability.cfg.child('overwrite');
      const priority = overwrite ? overwrite.getNumber('priority', 0) : 0;
      const hasOverwrite = ab.cfg.child('overwrite');
      const prior = priority > 0 ? !!hasOverwrite && hasOverwrite.getNumber('priority', 0) >= priority : true;
      const isOverwritable = (overwriteSpecialAffects(ab) && !prior) || !overwriteSpecialAffects(ab);
      let oneSideOverwritable = true;
      if (affectSide && isOverwritable) {
        if (ovLoc.equals(self.loc)) oneSideOverwritable = loc.equals(self.loc);
        else if (other.un && ovLoc.equals(other.loc)) oneSideOverwritable = loc.equals(other.loc);
      }
      let specialMatches = true;
      if (overwrite) {
        const filter = overwrite.child('filter_specials') ?? overwrite.child('experimental_filter_specials');
        if (filter && isOverwritable && oneSideOverwritable) specialMatches = ab.matchesFilter(filter);
      }
      if (isOverwritable && oneSideOverwritable && specialMatches) return true;
    }
    return false;
  }

  /** `attack_type::composite_value`. */
  compositeValue(list: ActiveAbilityList, baseValue: number): number {
    return abilityEffect(list, baseValue, this).compositeValue;
  }

  /** `attack_type::has_special_or_ability`. */
  hasSpecialOrAbility(self: SpecialsCombatant, tag: string): boolean {
    return this.hasActiveSpecial(self, tag);
  }

  /** `attack_type::has_active_special_or_ability_id`. */
  hasActiveSpecialOrAbilityId(self: SpecialsCombatant, id: string): boolean {
    return this.hasActiveSpecialId(self, id);
  }

  /** `attack_type::has_special_or_ability_with_filter` (`[filter_special]`): `active=yes` asks whether it is active here. */
  hasSpecialOrAbilityWithFilter(self: SpecialsCombatant, filter: WmlConfig): boolean {
    if (!filter.getBoolean('active', false)) return !!self.at && weaponSpecials(self.at).some((ab) => ab.matchesFilter(filter));
    return this.hasActiveSpecialMatchingFilter(self, filter);
  }

  /** `attack_type::modified_attacks`: strikes, after `[attacks]`, and swarm's range. */
  modifiedAttacks(self: SpecialsCombatant): { min: number; max: number } {
    let attacksValue = this.compositeValue(this.getSpecialsAndAbilities(self, 'attacks'), self.at?.numAttacks ?? 0);
    if (attacksValue < 0) attacksValue = 0;
    const swarm = this.getSpecialsAndAbilities(self, 'swarm');
    if (swarm.length > 0) {
      return { min: Math.max(0, swarm.highest('swarm_attacks_min').value), max: Math.max(0, swarm.highest('swarm_attacks_max', attacksValue).value) };
    }
    return { min: attacksValue, max: attacksValue };
  }

  /** `attack_type::modified_damage`: damage per strike after `[damage]`, unrounded. */
  modifiedDamage(self: SpecialsCombatant): number {
    return abilityEffect(this.getSpecialsAndAbilities(self, 'damage'), self.at?.damage ?? 0, this).compositeDoubleValue;
  }

  /** `attack_type::modified_chance_to_hit`: the base chance with accuracy and the opponent's parry, then `[chance_to_hit]`. */
  modifiedChanceToHit(self: SpecialsCombatant, cth: number): number {
    const other = this.other(self);
    const parry = other.at ? other.at.parry : 0;
    const base = Math.min(100, Math.max(0, cth + (self.at?.accuracy ?? 0) - parry));
    return this.compositeValue(this.getSpecialsAndAbilities(self, 'chance_to_hit'), base);
  }

  /** `attack_type::select_replacement_type`: the most named `replacement_type=`, the weapon's own type without any. */
  private selectReplacementType(self: SpecialsCombatant, list: ActiveAbilityList): string {
    const count = new Map<string, number>();
    let max = 0;
    for (const i of list.items) {
      if (!i.ability.cfg.hasAttribute('replacement_type')) continue;
      const type = i.ability.cfg.getString('replacement_type');
      const n = (count.get(type) ?? 0) + 1;
      count.set(type, n);
      if (n > max) max = n;
    }
    const best = [...count.entries()].filter(([, n]) => n === max).map(([t]) => t).sort();
    return best[0] ?? self.at?.type ?? '';
  }

  /** `attack_type::select_alternative_type`: the `alternative_type=` the opponent resists least, and that resistance. */
  private selectAlternativeType(self: SpecialsCombatant, list: ActiveAbilityList, resistanceList: ActiveAbilityList): { type: string; res: number } {
    const other = this.other(self);
    const typeRes = new Map<string, number>();
    let maxRes = -Infinity;
    if (other.un) {
      for (const i of list.items) {
        if (!i.ability.cfg.hasAttribute('alternative_type')) continue;
        const type = i.ability.cfg.getString('alternative_type');
        if (!typeRes.has(type)) {
          const res = resistanceValue(other.un, resistanceList, type);
          typeRes.set(type, res);
          maxRes = Math.max(maxRes, res);
        }
      }
    }
    if (typeRes.size === 0) return { type: '', res: -Infinity };
    const best = [...typeRes.entries()].filter(([, r]) => r === maxRes).map(([t]) => t).sort();
    return best.length > 0 ? { type: best[0]!, res: maxRes } : { type: '', res: -Infinity };
  }

  /** `attack_type::effective_damage_type`: the damage type that hurts the opponent most, and its resistance against it. */
  effectiveDamageType(self: SpecialsCombatant): { type: string; res: number } {
    const at = self.at;
    if (!at || at.range === '') return { type: '', res: 100 };
    const other = this.other(self);
    const isAttacker = self === this.attacker;
    let resistanceList = new ActiveAbilityList(this.board);
    if (other.un) resistanceList = this.getAbilitiesWeapons(other, 'resistance').filter((i) => i.ability.activeOnMatches(!isAttacker));
    const damageTypeList = this.getSpecialsAndAbilities(self, 'damage_type');
    let res = other.un ? resistanceValue(other.un, resistanceList, at.type) : 100;
    if (damageTypeList.length === 0) return { type: at.type, res };
    let replacement = this.selectReplacementType(self, damageTypeList);
    const alternative = this.selectAlternativeType(self, damageTypeList, resistanceList);
    if (other.un) {
      res = replacement !== at.type ? resistanceValue(other.un, resistanceList, replacement) : res;
      replacement = alternative.res > res ? alternative.type : replacement;
      res = Math.max(res, alternative.res);
    }
    return { type: replacement, res };
  }

  /** `attack_type::damage_types`: the type shown (after `replacement_type=`) and the alternatives. */
  damageTypes(self: SpecialsCombatant): { type: string; alternatives: string[] } {
    const list = this.getSpecialsAndAbilities(self, 'damage_type');
    if (list.length === 0) return { type: self.at?.type ?? '', alternatives: [] };
    const alternatives = new Set<string>();
    for (const i of list.items) if (i.ability.cfg.hasAttribute('alternative_type')) alternatives.add(i.ability.cfg.getString('alternative_type'));
    return { type: this.selectReplacementType(self, list), alternatives: [...alternatives].sort() };
  }

  /** `attack_type::matches_filter` in this fight: a weapon filter, with `[and]`/`[or]`/`[not]`. */
  weaponMatchesFilter(self: SpecialsCombatant, filter: WmlConfig, checkIfRecursion = ''): boolean {
    let matches = this.weaponMatchesSimpleFilter(self, filter, checkIfRecursion);
    for (const { tag, config } of filter.allChildren()) {
      if (tag === 'and') matches = matches && this.weaponMatchesFilter(self, config, checkIfRecursion);
      else if (tag === 'or') matches = matches || this.weaponMatchesFilter(self, config, checkIfRecursion);
      else if (tag === 'not') matches = matches && !this.weaponMatchesFilter(self, config, checkIfRecursion);
    }
    return matches;
  }

  /** `matches_simple_filter`. */
  private weaponMatchesSimpleFilter(self: SpecialsCombatant, filter: WmlConfig, checkIfRecursion: string): boolean {
    const at = self.at;
    if (!at) return false;
    const set = (key: string): Set<string> => new Set(splitList(filter.getString(key, '')));
    const ranges = (value: number, key: string): boolean => filter.getString(key, '') === '' || inRanges(value, filter.getString(key));
    if (!ranges(at.minRange, 'min_range') || !ranges(at.maxRange, 'max_range')) return false;
    const range = set('range');
    if (range.size > 0 && !range.has(at.range)) return false;
    if (!ranges(at.damage, 'damage') || !ranges(at.numAttacks, 'number')) return false;
    if (!ranges(at.accuracy, 'accuracy') || !ranges(at.parry, 'parry')) return false;
    if (!ranges(at.movementUsed, 'movement_used') || !ranges(at.attacksUsed, 'attacks_used')) return false;
    const alignment = set('alignment');
    if (alignment.size > 0 && !alignment.has(at.alignment ?? '')) return false;
    const name = set('name');
    if (name.size > 0 && !name.has(at.id)) return false;
    const type = set('type');
    if (type.size > 0) {
      // The damage_type special always looks at the weapon's own type, else it would flip on and off.
      if (checkIfRecursion === 'damage_type') {
        if (!type.has(at.type)) return false;
      } else if (!type.has(this.effectiveDamageType(self).type)) {
        return false;
      }
    }
    const baseType = set('base_type');
    if (baseType.size > 0 && !baseType.has(at.type)) return false;
    if (filter.hasAttribute('special') || filter.hasAttribute('special_id') || filter.hasAttribute('special_type')) {
      if (!hasFilterSpecialOrAbility(at, filter)) return false;
    }
    const typeActive = splitList(filter.getString('special_type_active', ''));
    if (typeActive.length > 0 && !typeActive.some((t) => this.hasSpecialOrAbility(self, t))) return false;
    const idActive = splitList(filter.getString('special_id_active', ''));
    if (idActive.length > 0 && !idActive.some((id) => this.hasActiveSpecialOrAbilityId(self, id))) return false;
    const active = splitList(filter.getString('special_active', ''));
    if (active.length > 0 && !active.some((s) => this.hasActiveSpecialOrAbilityId(self, s) || this.hasSpecialOrAbility(self, s))) return false;
    const subFilter = filter.child('filter_special');
    if (subFilter && !this.hasSpecialOrAbilityWithFilter(self, subFilter)) return false;
    const formula = filter.getString('formula', '');
    if (formula !== '') {
      try {
        if (!parseFormula(formula, gameStateSymbols(this.board)).evaluate(new AttackTypeCallable(at)).asBool()) return false;
      } catch {
        // Formulae with errors match nothing.
        return false;
      }
    }
    return true;
  }
}

function specialAffectsOpponent(ab: UnitAbility, isAttacker: boolean): boolean {
  const a = ab.applyTo;
  return a === 'both' || a === 'opponent' || (isAttacker && a === 'defender') || (!isAttacker && a === 'attacker');
}

function specialAffectsSelf(ab: UnitAbility, isAttacker: boolean): boolean {
  const a = ab.applyTo;
  return a === 'both' || a === 'self' || (isAttacker && a === 'attacker') || (!isAttacker && a === 'defender');
}

/** `buildin_is_immune`: the unit a draining, plaguing, poisoning, slowing or petrifying special would affect is immune. */
function builtinIsImmune(board: GameBoard, ab: UnitAbility, them: Unit | undefined, theirLoc: Location): boolean {
  if (!them) return false;
  switch (ab.tag) {
    case 'drains': return them.hasStatus('undrainable');
    case 'plague': return them.hasStatus('unplagueable') || board.map.isVillage(theirLoc);
    case 'poison': return them.hasStatus('unpoisonable') || them.poisoned;
    case 'slow': return them.hasStatus('unslowable') || them.slowed;
    case 'petrifies': return them.hasStatus('unpetrifiable');
    default: return false;
  }
}

/** `overwrite_special_affects`. */
function overwriteSpecialAffects(ab: UnitAbility): boolean {
  const applyTo = ab.cfg.getString('overwrite_specials', '');
  return applyTo === 'one_side' || applyTo === 'both_sides';
}

/** `attack_type::has_filter_special_or_ability`: the weapon's own specials by `special=`, `special_id=` or `special_type=`. */
function hasFilterSpecialOrAbility(at: AttackType, filter: WmlConfig): boolean {
  if (at.range === '') return false;
  const special = new Set(splitList(filter.getString('special', '')));
  const specialId = new Set(splitList(filter.getString('special_id', '')));
  const specialType = new Set(splitList(filter.getString('special_type', '')));
  return weaponSpecials(at).some((ab) => {
    if (special.size > 0 && !special.has(ab.id) && !special.has(ab.tag)) return false;
    if (specialId.size > 0 && !specialId.has(ab.id)) return false;
    if (specialType.size > 0 && !specialType.has(ab.tag)) return false;
    return true;
  });
}
