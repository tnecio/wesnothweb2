/**
 * TS port of a targeted subset of upstream's generic ability-effect
 * pipeline (`units/abilities.cpp`'s `foreach_active_ability`/
 * `get_abilities`/`unit_abilities::effect`) -- the "generalized ability
 * pipeline" gap flagged as the single largest remaining Phase 2 item (see
 * `IMPLEMENTATION_PLAN.md`'s Phase 2 gap list, `UnitType.ts`'s and
 * `combatStats.ts`'s module doc comments).
 *
 * Scope, deliberately narrow (matches this project's established
 * "let real content demand features" philosophy rather than porting the
 * full engine up front): this module implements exactly enough of the
 * real query (`getActiveAbilities`) and composition (`computeAbilityEffect`)
 * machinery to correctly evaluate the two combat-relevant abilities
 * flagged as unimplemented in `combatStats.ts`'s own doc comment --
 * **leadership** and **resistance-granting abilities** (`steadfast`) --
 * against their real `data/core/macros/abilities.cfg` definitions. It is
 * *not* a full port: `[filter_self]`, `[filter_adjacent]` inside
 * `[affect_adjacent][filter]`, non-`value=1` radius direction matching
 * (`adjacent=`), and the `cumulative=`+`EFFECT_CUMULABLE` combination mode
 * (only relevant to weapon-special value composition, not abilities) are
 * all unimplemented -- none of `leadership`/`resistance`/`skirmisher`'s
 * real mainline definitions need them. `hides`-family abilities (ambush/
 * nightstalk/concealment/submerge/swamp_lurk/burrow) are intentionally
 * left alone: they only matter once there's a fog/vision system to hide
 * from (Phase 11, not started). `illuminates` is also not wired in here
 * -- upstream applies it via a dedicated `tod_manager::
 * get_illuminated_time_of_day` scan (symmetric, side-independent, unlike
 * the `affects_side` logic every other ability goes through), a
 * meaningfully different code path this module doesn't attempt.
 *
 * ## The query: `getActiveAbilities` (mirrors `foreach_active_ability`)
 *
 * For a `receiver` unit potentially standing at `at` (its own location if
 * omitted -- `combatStats.ts`'s callers always pass the real location),
 * looking for abilities tagged `tag`:
 *  - **Self**: each of `receiver`'s own abilities with this tag, if its
 *    `affect_self` (default true) holds and its optional top-level
 *    `[filter]` (evaluated against `receiver` itself) matches.
 *  - **Adjacent**: for every OTHER non-incapacitated unit `owner` on the
 *    board with an ability of this tag that declares at least one
 *    `[affect_adjacent]` child (a real ability with none can never affect
 *    anyone but its own owner -- matches upstream's own optimisation),
 *    check, in order: `affects_side` (same numeric side always counts if
 *    `affect_allies != no`; a different but allied side only if
 *    `affect_allies == yes`, i.e. not the `same_side_only` default; an
 *    enemy side only if `affect_enemies == yes`), the owner's own
 *    top-level `[filter]` (evaluated against the OWNER itself, matching
 *    `from.ability_active_impl` upstream), and finally that `receiver` is
 *    within one `[affect_adjacent]` child's radius (default 1, i.e. true
 *    hex-adjacency -- `"all_map"` also supported) with that child's
 *    optional `[filter]` matching `receiver` (with `other` bound to
 *    `owner` for `formula=`, matching leadership's real
 *    `formula="level < other.level"`).
 *
 * ## The composition: `computeAbilityEffect` (mirrors `unit_abilities::effect`)
 *
 * Given the active-ability list and a base value, groups by `priority=`
 * (ascending, folding the composite value from one group into the next
 * group's `def`), then within each group: `[filter_base_value]` gates
 * whether an entry contributes at all; `value=` entries combine via
 * "highest positive wins, plus lowest negative wins" (matching upstream's
 * `set_effect_max`/`set_effect_min` -- e.g. two adjacent leaders with
 * different level differences: only the single best bonus applies, not
 * both summed); `multiply=`/`divide=` combine as a running percentage
 * product; `add=`/`sub=` sum (one highest-wins entry per distinct
 * `id`/`name`, matching upstream's per-id dedup). `max_value=`/
 * `min_value=` (distinct from `[filter_base_value]`) clamp the final
 * composite. `value=`/`add=`/`sub=`/`max_value=`/`min_value=` may be a
 * WFL formula (`(...)`, e.g. leadership's `value="(25 * (level -
 * other.level))"`, evaluated with the ABILITY OWNER's fields as the
 * unqualified/fallback scope and `other`/`base_value` bound to the
 * receiver/current-def, matching `get_single_ability_value`);
 * `multiply=`/`divide=` are only supported as plain literals here (no
 * real mainline ability needs a formula there).
 */

import { Location, distanceBetween, getAdjacentTiles } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import { Unit } from '../model/Unit.js';
import type { WmlConfig } from '../wml/config.js';
import { MapFormulaCallable, Variant, parseFormula, type Callable } from '../formula/index.js';

export interface ActiveAbility {
  readonly config: WmlConfig;
  readonly owner: Unit;
  readonly ownerLoc: Location;
}

/** Exposes a unit's scalar fields directly (no `self.` prefix) -- matches `wfl::unit_callable`'s fallback role in ability value/filter formulas (see module doc comment), which is a different convention than `events/filter.ts`'s `unitFormulaContext` (`self.<field>`, no fallback) used for `[event][filter]`. */
function unitFieldsCallable(unit: Unit): Callable {
  const c = new MapFormulaCallable();
  c.add('id', Variant.string(unit.id));
  c.add('type', Variant.string(unit.type.id));
  c.add('side', Variant.int(unit.side));
  c.add('x', Variant.int(unit.location.wmlX));
  c.add('y', Variant.int(unit.location.wmlY));
  c.add('hitpoints', Variant.int(unit.hitpoints));
  c.add('max_hitpoints', Variant.int(unit.maxHitpoints));
  c.add('level', Variant.int(unit.level));
  c.add('experience', Variant.int(unit.experience));
  c.add('max_experience', Variant.int(unit.maxExperience));
  c.add('moves', Variant.int(unit.movesLeft));
  c.add('max_moves', Variant.int(unit.maxMoves));
  c.add('resting', Variant.int(unit.resting ? 1 : 0));
  return c;
}

/** Simple `id=`/`type=`/`side=`/`x=`/`y=` matching (no formula) for a unit filter, used only for the rare owner/self top-level `[filter]` on abilities in this module's scope (none of which currently use it -- kept for the abilities that will). */
function simpleUnitFilterMatches(unit: Unit, filterCfg: WmlConfig): boolean {
  if (filterCfg.hasAttribute('id') && !filterCfg.getString('id').split(',').map((s) => s.trim()).includes(unit.id)) return false;
  if (filterCfg.hasAttribute('type') && !filterCfg.getString('type').split(',').map((s) => s.trim()).includes(unit.type.id)) return false;
  if (filterCfg.hasAttribute('side')) {
    const sides = filterCfg.getString('side').split(',').map((s) => Number(s.trim()));
    if (!sides.includes(unit.side)) return false;
  }
  return true;
}

/** Evaluates an ability/affect_adjacent `[filter]` (`self` = `subject`, unqualified/fallback; `other` = `other`, matching real `unit_filter::matches(subject, loc, other)`'s formula convention). `formula=` is the only attribute this module's target abilities (leadership) actually use here; the rest of `simpleUnitFilterMatches` is included for robustness. */
function abilityFilterMatches(filterCfg: WmlConfig, subject: Unit, other?: Unit): boolean {
  if (!simpleUnitFilterMatches(subject, filterCfg)) return false;
  if (filterCfg.hasAttribute('formula')) {
    try {
      const formula = parseFormula(filterCfg.getString('formula'));
      const ctx = new MapFormulaCallable();
      ctx.setFallback(unitFieldsCallable(subject));
      if (other) ctx.add('other', Variant.callable(unitFieldsCallable(other)));
      if (!formula.evaluate(ctx).asBool()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

type AffectAllies = 'yes' | 'no' | 'same_side_only';

/** Mirrors `unit_ability_t`'s constructor logic for `affects_allies_`/`affects_self_`/`affects_enemies_`. */
function abilityAffectFlags(cfg: WmlConfig): { affectsAllies: AffectAllies; affectsSelf: boolean; affectsEnemies: boolean } {
  const hasAffectAdjacent = cfg.allChildren().some((c) => c.tag === 'affect_adjacent');
  let affectsAllies: AffectAllies = hasAffectAdjacent ? 'same_side_only' : 'no';
  if (cfg.hasAttribute('affect_allies')) {
    affectsAllies = cfg.getBoolean('affect_allies') ? 'yes' : 'no';
  }
  return {
    affectsAllies,
    affectsSelf: cfg.getBoolean('affect_self', true),
    affectsEnemies: cfg.getBoolean('affect_enemies', false),
  };
}

/** Mirrors `affects_side`: does an ability owned by a unit on `ownerSide` reach a unit on `receiverSide`? */
function affectsSide(cfg: WmlConfig, receiverSide: number, ownerSide: number, board: GameBoard): boolean {
  const { affectsAllies, affectsEnemies } = abilityAffectFlags(cfg);
  if (receiverSide === ownerSide) return affectsAllies !== 'no';
  const receiverTeam = board.getTeam(receiverSide);
  const ownerTeam = board.getTeam(ownerSide);
  if (receiverTeam && ownerTeam && receiverTeam.isEnemy(ownerTeam)) return affectsEnemies;
  return affectsAllies === 'yes';
}

/** Which `ALL_DIRECTIONS`-style adjacency index `to` sits at relative to `from`, or -1 if not adjacent. */
function adjacentIndex(from: Location, to: Location): number {
  return getAdjacentTiles(from).findIndex((loc) => loc.equals(to));
}

/**
 * Mirrors `ability_affects_adjacent`: does at least one `[affect_adjacent]`
 * child of `cfg` reach `receiver` (at `at`) from `owner`? Only true
 * hex-adjacency (`distance === 1`) is matched precisely against a child's
 * `adjacent=` direction list, if any -- `radius=`/`"all_map"` beyond 1 is
 * honoured for the distance check but not direction-restricted (no real
 * mainline ability in this module's scope needs that combination -- see
 * module doc comment).
 */
function affectsAdjacent(cfg: WmlConfig, receiver: Unit, at: Location, owner: Unit): boolean {
  const distance = distanceBetween(owner.location, at);
  const dirIndex = distance === 1 ? adjacentIndex(owner.location, at) : -1;
  for (const child of cfg.allChildren()) {
    if (child.tag !== 'affect_adjacent') continue;
    const radiusStr = child.config.getString('radius', '1');
    if (radiusStr !== 'all_map') {
      const radius = Number(radiusStr) || 1;
      if (radius <= 0 || distance > radius) continue;
    }
    if (child.config.hasAttribute('adjacent') && dirIndex !== -1) {
      const dirs = child.config.getString('adjacent').split(',').map((s) => s.trim());
      const dirNames = ['n', 'ne', 'se', 's', 'sw', 'nw'];
      if (!dirs.includes(dirNames[dirIndex]!)) continue;
    }
    const filter = child.config.child('filter');
    if (!filter || abilityFilterMatches(filter, receiver, owner)) return true;
  }
  return false;
}

/**
 * Mirrors `unit::get_abilities`: every active instance of ability `tag`
 * reaching `receiver` at `at` (its own location by default), from itself
 * and/or from other units on the board. See module doc comment for exact
 * scope/simplifications.
 */
export function getActiveAbilities(board: GameBoard, receiver: Unit, tag: string, at: Location = receiver.location): ActiveAbility[] {
  const result: ActiveAbility[] = [];

  for (const entry of receiver.abilities) {
    if (entry.tag !== tag) continue;
    const { affectsSelf } = abilityAffectFlags(entry.config);
    if (!affectsSelf) continue;
    const ownFilter = entry.config.child('filter');
    if (ownFilter && !abilityFilterMatches(ownFilter, receiver)) continue;
    result.push({ config: entry.config, owner: receiver, ownerLoc: at });
  }

  for (const owner of board.allUnits()) {
    if (owner === receiver || owner.incapacitated) continue;
    // `foreach_distant_active_ability`: the owner's widest `[affect_adjacent] radius=` for this tag, checked first.
    const radius = owner.maxAbilityRadius(tag);
    if (!radius || distanceBetween(owner.location, at) > radius) continue;
    for (const entry of owner.abilities) {
      if (entry.tag !== tag) continue;
      if (!entry.config.allChildren().some((c) => c.tag === 'affect_adjacent')) continue;
      if (!affectsSide(entry.config, receiver.side, owner.side, board)) continue;
      const ownFilter = entry.config.child('filter');
      if (ownFilter && !abilityFilterMatches(ownFilter, owner)) continue;
      if (!affectsAdjacent(entry.config, receiver, at, owner)) continue;
      result.push({ config: entry.config, owner, ownerLoc: owner.location });
    }
  }

  return result;
}

// --- composition (`unit_abilities::effect`) ---

/** Resolves a `value=`/`add=`/`sub=`/`max_value=`/`min_value=` attribute: a plain number, or a WFL formula (`(...)`) evaluated with `owner`'s fields as the fallback scope, `other` bound to `receiver`, and `base_value` bound to `def` -- matches `individual_value_int`/`get_single_ability_value`. Rounds to the nearest integer, as upstream does. */
function resolveIntAttr(raw: string, def: number, owner: Unit, receiver: Unit): number {
  const trimmed = raw.trim();
  if (trimmed.startsWith('(')) {
    try {
      const formula = parseFormula(trimmed);
      const ctx = new MapFormulaCallable();
      ctx.setFallback(unitFieldsCallable(owner));
      ctx.add('other', Variant.callable(unitFieldsCallable(receiver)));
      ctx.add('base_value', Variant.int(def));
      return Math.round(formula.evaluate(ctx).asInt(def));
    } catch {
      return def;
    }
  }
  const n = Number(trimmed);
  return Number.isNaN(n) ? def : Math.round(n);
}

/** Resolves `multiply=`/`divide=` into the composite's ×100-scaled percentage form (matches `individual_value_double`: a plain `multiply=2` means "×2.00", stored as `200`). Literal numbers only -- see module doc comment. */
function resolveDoubleAttr(raw: string, def: number): number {
  const n = Number(raw.trim());
  return Math.round((Number.isNaN(n) ? def : n) * 100);
}

/** Mirrors `unit_abilities::filter_base_matches`: does `def` (the value the ability is about to modify) satisfy the ability's optional `[filter_base_value]`? */
function filterBaseMatches(cfg: WmlConfig, def: number): boolean {
  const filter = cfg.child('filter_base_value');
  if (!filter) return true;
  if (filter.hasAttribute('equals') && def !== filter.getNumber('equals')) return false;
  if (filter.hasAttribute('not_equals') && def === filter.getNumber('not_equals')) return false;
  if (filter.hasAttribute('less_than') && !(def < filter.getNumber('less_than'))) return false;
  if (filter.hasAttribute('greater_than') && !(def > filter.getNumber('greater_than'))) return false;
  if (filter.hasAttribute('greater_than_equal_to') && !(def >= filter.getNumber('greater_than_equal_to'))) return false;
  if (filter.hasAttribute('less_than_equal_to') && !(def <= filter.getNumber('less_than_equal_to'))) return false;
  return true;
}

/**
 * Mirrors `unit_abilities::effect`: folds a list of active abilities
 * (each paired with its own owner, for formula `self`/`other` binding)
 * into one composite value, starting from `def`. See module doc comment
 * for the exact combination rules and the (deliberate) scope this
 * doesn't cover.
 */
export function computeAbilityEffect(abilities: readonly ActiveAbility[], def: number, receiver: Unit): number {
  const byPriority = new Map<number, ActiveAbility[]>();
  for (const a of abilities) {
    const priority = a.config.getNumber('priority', 0);
    (byPriority.get(priority) ?? byPriority.set(priority, []).get(priority)!).push(a);
  }
  const priorities = [...byPriority.keys()].sort((a, b) => a - b);

  let value = def;
  for (const priority of priorities) {
    value = effectImpl(byPriority.get(priority)!, value, receiver);
  }
  return value;
}

function effectImpl(list: readonly ActiveAbility[], def: number, receiver: Unit): number {
  let valueSet = def;
  let haveSetRange = false;
  let setMax = 0;
  let setMin = 0;

  const addById = new Map<string, number>();
  const subById = new Map<string, number>();
  const mulById = new Map<string, number>();
  const divById = new Map<string, number>();
  let maxValue: number | undefined;
  let minValue: number | undefined;

  for (const { config: cfg, owner } of list) {
    if (!filterBaseMatches(cfg, def)) continue;
    const effectId = cfg.getString('id', '') || cfg.getString('name', '');

    if (cfg.hasAttribute('value')) {
      const value = resolveIntAttr(cfg.getString('value'), def, owner, receiver);
      const valueCum = cfg.getBoolean('cumulative', false) ? Math.max(def, value) : value;
      if (!haveSetRange) {
        setMax = valueCum;
        setMin = valueCum;
        haveSetRange = true;
      } else {
        setMax = Math.max(setMax, valueCum);
        setMin = Math.min(setMin, valueCum);
      }
    }

    if (cfg.hasAttribute('max_value')) {
      const v = resolveIntAttr(cfg.getString('max_value'), def, owner, receiver);
      maxValue = maxValue === undefined ? v : Math.min(maxValue, v);
    }
    if (cfg.hasAttribute('min_value')) {
      const v = resolveIntAttr(cfg.getString('min_value'), def, owner, receiver);
      minValue = minValue === undefined ? v : Math.max(minValue, v);
    }

    if (cfg.hasAttribute('add')) {
      const add = resolveIntAttr(cfg.getString('add'), def, owner, receiver);
      if (!addById.has(effectId) || add > addById.get(effectId)!) addById.set(effectId, add);
    }
    if (cfg.hasAttribute('sub')) {
      const sub = -resolveIntAttr(cfg.getString('sub'), def, owner, receiver);
      if (!subById.has(effectId) || sub < subById.get(effectId)!) subById.set(effectId, sub);
    }
    if (cfg.hasAttribute('multiply')) {
      const mul = resolveDoubleAttr(cfg.getString('multiply'), def);
      if (!mulById.has(effectId) || mul > mulById.get(effectId)!) mulById.set(effectId, mul);
    }
    if (cfg.hasAttribute('divide')) {
      const div = resolveDoubleAttr(cfg.getString('divide'), def);
      if (div !== 0 && (!divById.has(effectId) || div > divById.get(effectId)!)) divById.set(effectId, div);
    }
  }

  if (haveSetRange) {
    valueSet = Math.max(setMax, 0) + Math.min(setMin, 0);
  }

  let multiplier = 1;
  for (const v of mulById.values()) multiplier *= v / 100;
  let divisor = 1;
  for (const v of divById.values()) divisor *= v / 100;
  let addition = 0;
  for (const v of addById.values()) addition += v;
  let subtraction = 0;
  for (const v of subById.values()) subtraction += v;

  let composite = ((valueSet + addition + subtraction) * multiplier) / divisor;
  if (maxValue !== undefined && minValue !== undefined && minValue < maxValue) {
    composite = Math.min(maxValue, Math.max(minValue, composite));
  } else if (maxValue !== undefined) {
    composite = Math.min(maxValue, composite);
  } else if (minValue !== undefined) {
    composite = Math.max(minValue, composite);
  }
  return Math.round(composite);
}

// --- high-level combat entry points ---

/**
 * Mirrors `under_leadership`: `unit`'s own damage-bonus percentage from
 * any active `leadership` ability reaching it (its own, or an adjacent
 * higher-level ally's -- see `getActiveAbilities`). 0 if none. Callers
 * with board access (`combat.ts`'s `executeAttack`, `GameSession.
 * buildPreview`) compute this once per combatant and pass it into
 * `combatStats.ts`'s `UnitStatsOptions` (that module deliberately has no
 * board access of its own).
 */
export function computeLeadershipBonus(board: GameBoard, unit: Unit): number {
  const abilities = getActiveAbilities(board, unit, 'leadership');
  if (abilities.length === 0) return 0;
  return computeAbilityEffect(abilities, 0, unit);
}

/** Mirrors `unit_ability_t::active_on_matches`: does a `resistance`-tagged ability with this `active_on=` apply when its owner (here always the resistance-receiving unit, since `resistance` abilities in scope are self-only) is/isn't the attacker of the current exchange? */
function activeOnMatches(cfg: WmlConfig, ownerIsAttacker: boolean): boolean {
  const activeOn = cfg.getString('active_on', 'both');
  if (activeOn === 'offense') return ownerIsAttacker;
  if (activeOn === 'defense') return !ownerIsAttacker;
  return true;
}

/** Mirrors `unit::resistance_filter_matches`: does this `resistance` ability apply to `damageType`, given the pre-ability resistance percentage `res` (`100 - moveType.resistanceAgainst(damageType)`)? */
function resistanceFilterMatches(cfg: WmlConfig, damageType: string, res: number): boolean {
  const applyTo = cfg.getString('apply_to', '');
  if (applyTo !== '' && applyTo !== damageType) {
    const types = applyTo.split(',').map((s) => s.trim());
    if (!types.includes(damageType)) return false;
  }
  return filterBaseMatches(cfg, res);
}

/**
 * Mirrors `unit::resistance_against`/`resistance_value`: `defendingUnit`'s
 * real, ability-aware resistance against `damageType` (the same 100-based
 * "percent damage taken" scale as `Unit.resistanceAgainst`, e.g. 100 =
 * no resistance, 50 = takes half damage) -- folds in any active
 * `resistance`-tagged ability (currently only `steadfast`'s `multiply=2
 * max_value=50` in real mainline content) whose `active_on=` matches
 * `defendingUnitIsAttacker` (is the resistance-owner the attacker of the
 * current exchange, not the one about to take this particular hit --
 * matches `effective_damage_type`'s `active_on_matches(!is_attacker)`)
 * and whose `apply_to=`/`[filter_base_value]` accept this damage type.
 * `at` defaults to `defendingUnit`'s own location (real `resistance`
 * abilities in scope are self-only, so this rarely matters).
 */
export function computeResistanceModifier(
  board: GameBoard,
  defendingUnit: Unit,
  damageType: string,
  defendingUnitIsAttacker: boolean,
  at: Location = defendingUnit.location,
): number {
  const base = defendingUnit.resistanceAgainst(damageType);
  const res = 100 - base;
  const abilities = getActiveAbilities(board, defendingUnit, 'resistance', at)
    .filter((a) => activeOnMatches(a.config, defendingUnitIsAttacker))
    .filter((a) => resistanceFilterMatches(a.config, damageType, res));
  if (abilities.length === 0) return base;
  const composite = computeAbilityEffect(abilities, res, defendingUnit);
  return 100 - composite;
}
