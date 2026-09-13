/**
 * TS port of the non-prediction half of upstream's `actions/attack.hpp`/
 * `.cpp`: turning a `(unit, weapon, opponent, opponent weapon, terrain)`
 * tuple into a `battle_context_unit_stats` (chance to hit, damage, and
 * which weapon specials are in play), plus the small standalone
 * `combat_modifier`/`generic_combat_modifier` time-of-day/alignment
 * formula and best-weapon selection (`battle_context::choose_*_weapon`).
 *
 * ## Weapon specials: what's evaluated, and how (read this before assuming
 * a special "just works")
 *
 * Upstream's real special/ability system (`units/abilities.cpp`'s
 * `unit_abilities::effect`, `specials_context_t`) is a general filter+
 * composition engine: each `[specials]` sub-tag can be gated by
 * `active_on`/`[filter]`/`[filter_opponent]`/adjacency, and multiple
 * matching specials combine via `add`/`sub`/`multiply`/`divide`/`set`
 * with per-id "highest wins" dedup. None of that is ported here, matching
 * this project's established stance (see `UnitType.ts`'s module doc
 * comment: abilities/specials are kept as raw, unevaluated `WmlConfig`
 * data until the WFL/Lua phases). What *is* implemented is a small,
 * direct, **unconditional** reading of the specific specials mainline
 * content actually uses for the numbers combat resolution needs, matched
 * by each special's `id=` attribute (`poison`, `slow`, `drains`,
 * `petrifies`, `firststrike`, `berserk`, `swarm`, `marksman`, `magical`,
 * `charge`, `heal_on_hit`) rather than by WML tag name as upstream's own
 * `attack_type::has_special_or_ability` does: `UnitType.ts`'s
 * `AttackType.fromConfig` (out of bounds for this task -- see the
 * `specials_list=` note below) discards each `[specials]` child's own tag
 * when building `AttackType.specials: WmlConfig[]`
 * (`specialsCfg.allChildren().map((c) => c.config)`), so the tag isn't
 * available to key off of here. `id=` is a safe substitute: every
 * canonical mainline special in `data/core/macros/weapon_specials.cfg`
 * sets `id=` to the same name as its tag (e.g. `[poison] id=poison`,
 * `[chance_to_hit] id=marksman`), so this is precise for real content --
 * just keyed differently than upstream, for a data-model reason rather
 * than a design choice.
 *
 *  - No `[filter]`/`[filter_opponent]`/`[filter_adjacent]` conditions are
 *    evaluated -- a special present on the weapon is treated as always
 *    active. This is correct for the overwhelming majority of mainline
 *    weapon specials (poison/slow/drains/petrifies/firststrike/berserk/
 *    swarm/marksman/magical carry no such filters in `data/core/macros/
 *    weapon_specials.cfg`) and wrong only for conditional ones.
 *  - **Backstab IS evaluated** (2026-09-11), as a narrow, hand-coded
 *    geometric proxy rather than a general WFL `[filter_opponent]`
 *    evaluator: `isBackstabActive` below checks whether the hex
 *    continuing in a straight line past the defender (attacker ->
 *    defender -> flanker) holds a unit hostile to the defender and not
 *    incapacitated -- matching the special's own real, plain-language
 *    `description=` ("double damage if there is an enemy of the target on
 *    the opposite side of the target"), not the full WFL formula. Callers
 *    (`GameSession.buildPreview`, `combat.ts`'s `executeAttack`) compute
 *    it themselves (they have board/location access this module
 *    deliberately doesn't) and pass it in via `UnitStatsOptions.
 *    backstabActive`.
 *  - **Leadership IS applied** (2026-09-11, `under_leadership()` upstream):
 *    a board-wide adjacency+ability scan (`abilityEffects.ts`'s
 *    `getActiveAbilities`/`computeAbilityEffect`, the new "generalized
 *    ability pipeline" module) finds any active `leadership` ability
 *    reaching a unit (its own, or an adjacent higher-level ally's) and
 *    evaluates its real `value="(25 * (level - other.level))"` WFL
 *    formula. This module still doesn't compute it itself (no board
 *    access, by design) -- callers with board access
 *    (`combat.ts`'s `executeAttack`, `GameSession.buildPreview`) compute
 *    it and pass it in via `UnitStatsOptions.attackerLeadershipBonus`/
 *    `defenderLeadershipBonus`.
 *  - **Resistance-granting abilities (steadfast) ARE applied** (2026-09-11):
 *    same `abilityEffects.ts` module, `computeResistanceModifier` --
 *    folds in any active `resistance`-tagged ability (`multiply=`/
 *    `max_value=`/`[filter_base_value]`/`active_on=`) on top of the
 *    attacked unit's own `moveType.resistanceAgainst()`. Callers pass the
 *    real value via `UnitStatsOptions.attackerResistanceModifier`/
 *    `defenderResistanceModifier`; omitting them falls back to the plain
 *    move-type value, matching the old behaviour.
 *  - **`specials_list=`/`abilities_list=` (the modern shorthand most
 *    mainline `[attack]`/`[unit_type]` tags use instead of inline
 *    `[specials]`/`[abilities]` children, e.g. `specials_list=marksman,
 *    poison`) IS resolved** (2026-09-11) against the real `[units]
 *    [weapon_specials]`/`[abilities]` registry -- see `UnitType.ts`'s
 *    `AttackType.fromConfig`/`UnitType.fromConfig` and
 *    `UnitTypeDatabase.ts`'s `collectSpecialRegistry`. A weapon/type built
 *    without passing a registry (e.g. a hand-built test fixture) simply
 *    resolves `specials_list=`/`abilities_list=` to nothing, same as
 *    before -- this module's own `id=`-based special matching (see above)
 *    needed no change, since real content's weapon-special `id=` already
 *    equals its canonical tag name whether declared inline or via the
 *    registry.
 *  - **Plague** creates a replacement unit only if the caller supplies a
 *    `resolveType` callback (see `combat.ts`); otherwise it's flagged in
 *    the result but no unit is created.
 */

import type { WmlConfig } from '../wml/config.js';
import { AttackType, type Alignment } from '../model/UnitType.js';
import type { Unit } from '../model/Unit.js';
import type { BattleContextUnitStats } from './attackPrediction.js';
import { calcBlows, swarmBlows, simulateCombat, Combatant } from './attackPrediction.js';
import { roundDamage } from './gameConfig.js';

// --- time-of-day / alignment damage modifier ---

/**
 * Mirrors `generic_combat_modifier`: the percentage damage bonus/penalty
 * from a unit's alignment vs. the current time of day. `lawfulBonus` is the
 * scenario's current `[time]lawful_bonus=` (positive favors lawful units,
 * negative favors chaotic); `maxLiminalBonus` is `tod_manager::
 * get_max_liminal_bonus()`. Since this project has no time-of-day/turn
 * system yet (see `IMPLEMENTATION_PLAN.md`'s Phase 2 scope), callers not
 * yet tracking time of day should pass `lawfulBonus: 0` (a permanently
 * "neutral" time of day) -- this function is exposed as a pure formula so
 * that plugging in a real ToD system later needs no change here.
 */
export function combatModifier(lawfulBonus: number, alignment: Alignment, isFearless: boolean, maxLiminalBonus = 0): number {
  let bonus: number;
  switch (alignment) {
    case 'lawful':
      bonus = lawfulBonus;
      break;
    case 'neutral':
      bonus = 0;
      break;
    case 'chaotic':
      bonus = -lawfulBonus;
      break;
    case 'liminal':
      bonus = maxLiminalBonus - Math.abs(lawfulBonus);
      break;
    default:
      bonus = 0;
  }
  if (isFearless) bonus = Math.max(bonus, 0);
  return bonus;
}

// --- raw weapon-special lookup helpers (see module doc comment) ---

/** All `[specials]` sub-configs on `weapon` whose `id=` is `id` (see module doc comment for why `id=`, not tag name). */
function specialsById(weapon: AttackType, id: string): WmlConfig[] {
  return weapon.specials.filter((s) => s.getString('id', '') === id);
}

/**
 * Exported for `packages/ui`'s combat-prediction dialogs (bugs4.md #10):
 * `buildPreview` (`gameSession.ts`) needs to know WHICH of the several
 * chance-to-hit/damage modifiers this module already folds into
 * `chanceToHit`/`damage` actually applied to a given weapon, to show a
 * real breakdown (e.g. "70% (magical)") instead of just the final number.
 */
export function hasSpecialId(weapon: AttackType, id: string): boolean {
  return specialsById(weapon, id).length > 0;
}

/** The highest `value=` (or `attr=`) among an id's occurrences, or `fallback` if none present. */
function highestSpecialValue(weapon: AttackType, id: string, attr = 'value', fallback = 0): number {
  const specials = specialsById(weapon, id);
  if (specials.length === 0) return fallback;
  return Math.max(...specials.map((s) => s.getNumber(attr, fallback)));
}

// --- battle_context_unit_stats construction ---

export interface UnitStatsOptions {
  /**
   * The real ToD lawful_bonus AT THE ATTACKER'S OWN HEX (schedule +
   * `[time_area]` + `[illuminates]`, see `actions/illumination.ts`'s
   * `effectiveTimeOfDayAt`) -- mirrors `combat_modifier`'s per-unit
   * `get_illuminated_time_of_day(units, map, loc)` call, which upstream
   * makes separately for the attacker and the defender's own locations
   * (they can differ: standing in a lit radius, or straddling a
   * `[time_area]` boundary, changes only THAT unit's bonus). Used only
   * when `isAttacker` is true for this call. Default 0 (neutral ToD).
   */
  readonly attackerLawfulBonus?: number;
  /** Same, at the defender's own hex -- used only when `isAttacker` is false for this call. */
  readonly defenderLawfulBonus?: number;
  readonly maxLiminalBonus?: number;
  /** Overrides the terrain-defense-derived base hit chance (mirrors the `opp_terrain_defense` optional param). */
  readonly opponentTerrainDefense?: number;
  /** The real geometric backstab condition for THIS attacker/defender pair, computed by the caller (see `combat.ts`'s `isBackstabActive`) -- only doubles damage when `isAttacker` is also true for this call. Default false. */
  readonly backstabActive?: boolean;
  /** The attacker's own `leadership`-ability damage bonus percentage (`abilityEffects.ts`'s `computeLeadershipBonus`), used only when `isAttacker` is true for this call. Default 0. */
  readonly attackerLeadershipBonus?: number;
  /** Same, for the defender (used only when `isAttacker` is false for this call). */
  readonly defenderLeadershipBonus?: number;
  /** Overrides `opponent.resistanceAgainst(weapon.type)` with the real ability-aware value (`abilityEffects.ts`'s `computeResistanceModifier`, e.g. Dwarvish steadfast) for the attacker-computing call (`isAttacker` true -- i.e. the defender's resistance against the attacker's weapon). Falls back to the plain move-type resistance when omitted. */
  readonly attackerResistanceModifier?: number;
  /** Same, for the defender-computing call (`isAttacker` false -- the attacker's resistance against the defender's weapon, i.e. the counter-strike). */
  readonly defenderResistanceModifier?: number;
}

/**
 * Builds one side's `BattleContextUnitStats`, mirroring the
 * `battle_context_unit_stats` constructor. `weapon` is the unit's own
 * weapon for this combat (`undefined` means "no weapon" -- upstream
 * returns a mostly-zeroed stats struct in that case, which callers
 * shouldn't normally reach since `combat.ts` filters those out first).
 * `defenderTerrain` is the terrain code under the *opponent's* location
 * (needed to compute the opponent's own defense -- i.e. when building the
 * defender's stats, `defenderTerrain` should be the terrain *the defender
 * unit is not standing on* -- callers pass the two locations' terrain
 * codes explicitly since this module doesn't own the map).
 */
export function computeUnitStats(
  unit: Unit,
  isAttacker: boolean,
  weapon: AttackType | undefined,
  opponent: Unit,
  opponentWeapon: AttackType | undefined,
  distanceToOpponent: number,
  opponentTerrainDefenseValue: number,
  options: UnitStatsOptions = {},
): BattleContextUnitStats {
  const hp = Math.max(0, Math.min(unit.hitpoints, unit.maxHitpoints));
  const isPoisoned = unit.poisoned;
  const isSlowed = unit.slowed;

  if (!weapon) {
    // Mirrors the early-return branch of the C++ constructor: a unit with
    // no (usable) weapon deals no damage and never hits.
    return {
      isAttacker,
      isPoisoned,
      isSlowed,
      slows: false,
      drains: false,
      petrifies: false,
      poisons: false,
      firststrike: false,
      canAdvance: unit.advances(),
      experience: unit.experience,
      maxExperience: unit.maxExperience,
      level: unit.level,
      rounds: 1,
      hp,
      maxHp: unit.maxHitpoints,
      chanceToHit: 0,
      damage: 0,
      slowDamage: 0,
      drainPercent: 0,
      drainConstant: 0,
      numBlows: 0,
      swarmMin: 0,
      swarmMax: 0,
    };
  }

  const opponentAlreadyPoisoned = opponent.poisoned;

  const slows = hasSpecialId(weapon, 'slow');
  const drainsSpecial = hasSpecialId(weapon, 'drains');
  const petrifies = hasSpecialId(weapon, 'petrifies');
  const poisons = hasSpecialId(weapon, 'poison') && !opponentAlreadyPoisoned;
  const firststrike = hasSpecialId(weapon, 'firststrike');
  const berserkSpecials = specialsById(weapon, 'berserk');
  const rounds = berserkSpecials.length > 0 ? highestSpecialValue(weapon, 'berserk', 'value', 30) : 1;

  const outOfRange = distanceToOpponent > weapon.maxRange || distanceToOpponent < weapon.minRange;
  void outOfRange; // Exposed via `disable`-equivalent handling left to callers (combat.ts filters unusable weapons before this point).

  // --- chance to hit ---
  const opponentInvulnerable = opponent.hasStatus('invulnerable');
  const opponentBaseCth = opponentTerrainDefenseValue;
  let cth = clampInt(opponentBaseCth + weapon.accuracy - (opponentWeapon?.parry ?? 0), 0, 100);
  const magicalSpecials = specialsById(weapon, 'magical');
  const marksmanSpecials = specialsById(weapon, 'marksman');
  if (magicalSpecials.length > 0) {
    cth = magicalSpecials[0]!.getNumber('value', 70);
  } else if (marksmanSpecials.length > 0 && isAttacker) {
    const marksmanValue = Math.max(...marksmanSpecials.map((s) => s.getNumber('value', 60)));
    cth = Math.max(cth, marksmanValue);
  }
  if (opponentInvulnerable) cth = 0;
  const chanceToHit = clampInt(cth, 0, 100);

  // --- damage ---
  const baseDamage = weapon.damage;
  let damageMultiplier = 100;
  const lawfulBonus = (isAttacker ? options.attackerLawfulBonus : options.defenderLawfulBonus) ?? 0;
  damageMultiplier += combatModifier(lawfulBonus, weapon.alignment ?? unit.type.alignment, false, options.maxLiminalBonus ?? 0);
  const leadershipBonus = (isAttacker ? options.attackerLeadershipBonus : options.defenderLeadershipBonus) ?? 0;
  if (leadershipBonus !== 0) damageMultiplier += leadershipBonus;
  const resistanceModifier = (isAttacker ? options.attackerResistanceModifier : options.defenderResistanceModifier) ?? opponent.resistanceAgainst(weapon.type);
  damageMultiplier *= resistanceModifier;

  let damage = roundDamage(baseDamage, damageMultiplier, 10000);
  let slowDamage = roundDamage(baseDamage, damageMultiplier, 20000);
  if (isSlowed) damage = slowDamage;

  // Backstab: `[damage] id=backstab` (default apply_to=self, active_on=offense)
  // doubles ONLY the wielder's own damage, and only when it's the one doing
  // the attacking in this exchange -- unlike charge below, never the
  // defender's retaliation. `options.backstabActive` is the caller-computed
  // geometric condition (see `isBackstabActive` in `combat.ts`); this
  // module has no board/location access to compute it itself.
  if (isAttacker && (options.backstabActive ?? false) && hasSpecialId(weapon, 'backstab')) {
    damage *= 2;
    slowDamage *= 2;
  }

  // Charge: `[damage] id=charge` with `apply_to=both` doubles both combatants'
  // damage for this exchange, but only "when used offensively" (active_on=offense).
  // Applied as a two-sided effect by `buildBattleContext` below (needs both stats).

  let drainPercent = 0;
  let drainConstant = 0;
  if (drainsSpecial) {
    drainPercent = highestSpecialValue(weapon, 'drains', 'value', 50);
  }
  drainConstant += highestSpecialValue(weapon, 'heal_on_hit', 'value', 0);
  const drains = drainConstant !== 0 || drainPercent !== 0;

  const swarmSpecials = specialsById(weapon, 'swarm');
  const attacksValue = Math.max(0, weapon.numAttacks);
  let swarmMin = attacksValue;
  let swarmMax = attacksValue;
  if (swarmSpecials.length > 0) {
    swarmMin = Math.max(0, highestSpecialValue(weapon, 'swarm', 'swarm_attacks_min', 0));
    swarmMax = Math.max(0, highestSpecialValue(weapon, 'swarm', 'swarm_attacks_max', attacksValue));
  }
  const numBlows = swarmBlows(swarmMin, swarmMax, hp, unit.maxHitpoints || 1);

  return {
    isAttacker,
    isPoisoned,
    isSlowed,
    slows,
    drains,
    petrifies,
    poisons,
    firststrike,
    canAdvance: unit.advances(),
    experience: unit.experience,
    maxExperience: unit.maxExperience,
    level: unit.level,
    rounds,
    hp,
    maxHp: unit.maxHitpoints,
    chanceToHit,
    damage,
    slowDamage,
    drainPercent,
    drainConstant,
    numBlows,
    swarmMin,
    swarmMax,
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

/** Presence (unconditional, see module doc comment) of `[damage] id=charge` on `weapon`, only meaningful `active_on=offense`. */
function hasCharge(weapon: AttackType | undefined): boolean {
  if (!weapon) return false;
  return hasSpecialId(weapon, 'charge');
}

export interface BattleContextInput {
  readonly attacker: Unit;
  readonly attackerWeapon: AttackType;
  readonly defender: Unit;
  readonly defenderWeapon: AttackType | undefined;
  readonly distance: number;
  /** Terrain-defense value (0-100, "chance to be hit" convention -- see `Unit.defenseModifier`) for the attacker's own location. */
  readonly attackerTerrainDefense: number;
  /** Same, for the defender's location. */
  readonly defenderTerrainDefense: number;
  readonly options?: UnitStatsOptions;
}

/**
 * Builds both combatants' stats for one attacker-weapon/defender-weapon
 * pairing, mirroring `battle_context`'s two-argument
 * `battle_context_unit_stats` construction plus the cross-combatant charge
 * effect (`apply_to=both`).
 */
export function buildBattleContext(input: BattleContextInput): { attacker: BattleContextUnitStats; defender: BattleContextUnitStats } {
  const { attacker, attackerWeapon, defender, defenderWeapon, distance, options } = input;

  const attackerStats = computeUnitStats(
    attacker,
    true,
    attackerWeapon,
    defender,
    defenderWeapon,
    distance,
    input.defenderTerrainDefense,
    options,
  );
  const defenderStats = computeUnitStats(
    defender,
    false,
    defenderWeapon,
    attacker,
    attackerWeapon,
    distance,
    input.attackerTerrainDefense,
    options,
  );

  const chargeActive = hasCharge(attackerWeapon);
  if (!chargeActive) {
    return { attacker: attackerStats, defender: defenderStats };
  }

  const chargeMultiplier = specialsById(attackerWeapon, 'charge')[0]?.getNumber('multiply', 2) ?? 2;

  return {
    attacker: { ...attackerStats, damage: attackerStats.damage * chargeMultiplier, slowDamage: attackerStats.slowDamage * chargeMultiplier },
    defender: { ...defenderStats, damage: defenderStats.damage * chargeMultiplier, slowDamage: defenderStats.slowDamage * chargeMultiplier },
  };
}

// --- weapon selection ---

const POISON_AMOUNT_FOR_COMPARISON = 8;

/**
 * Mirrors `battle_context::better_combat`: is combat A a better outcome for
 * "us" than combat B, given `harmWeight` (1.0 = weigh our own losses fully,
 * 0.0 = ignore them, i.e. pure aggression)?
 */
export function betterCombat(
  usA: Combatant,
  themA: Combatant,
  usAWeight: number,
  usB: Combatant,
  themB: Combatant,
  usBWeight: number,
  harmWeight: number,
): boolean {
  const a0 = themA.hpDist[0]! - usA.hpDist[0]! * harmWeight;
  const b0 = themB.hpDist[0]! - usB.hpDist[0]! * harmWeight;
  if (a0 - b0 < -0.01) return false;
  if (a0 - b0 > 0.01) return true;

  const poisonAUs = usA.poisoned > 0 ? (usA.poisoned - usA.hpDist[0]!) * POISON_AMOUNT_FOR_COMPARISON : 0;
  const poisonAThem = themA.poisoned > 0 ? (themA.poisoned - themA.hpDist[0]!) * POISON_AMOUNT_FOR_COMPARISON : 0;
  const poisonBUs = usB.poisoned > 0 ? (usB.poisoned - usB.hpDist[0]!) * POISON_AMOUNT_FOR_COMPARISON : 0;
  const poisonBThem = themB.poisoned > 0 ? (themB.poisoned - themB.hpDist[0]!) * POISON_AMOUNT_FOR_COMPARISON : 0;

  const damageA = (themA.stats.hp - themA.averageHp()) * usAWeight;
  const damageB = (themB.stats.hp - themB.averageHp()) * usBWeight;

  const a = (usA.averageHp() - poisonAUs) * harmWeight + damageA + poisonAThem;
  const b = (usB.averageHp() - poisonBUs) * harmWeight + damageB + poisonBThem;
  if (a - b < -0.01) return false;
  if (a - b > 0.01) return true;

  return damageA >= damageB;
}

/**
 * Picks the defender weapon (by index into `defender.attacks`, or `-1` for
 * "no weapon") that gives the best expected outcome for the defender
 * against `attackerWeaponIndex`, mirroring `battle_context::
 * choose_defender_weapon`'s intent (a simplified, non-harm-weighted
 * version -- upstream also considers AI aggression settings, which are a
 * caller concern here).
 *
 * The filter for "can this defender weapon even be used to retaliate" is
 * `def.range() != att.range()` (`attack.cpp`'s `choose_defender_weapon`,
 * verified directly) -- a STRING comparison of each weapon's `range=`
 * label ("melee"/"ranged"/a custom value), NOT the numeric `min_range`/
 * `max_range` distance bounds (those gate whether the ATTACKER can use a
 * weapon against a target at a given hex distance at all, a separate,
 * earlier check -- real combat is between adjacent hexes, distance 1, for
 * everything except specialised ranged-attack content). Filtering by
 * distance here made a melee attacker's target retaliate with ANY weapon
 * whose (distance-based) min/max happened to include 1, including a
 * defender's own ranged-only weapon -- e.g. a spearman's javelin throw
 * drawing a bow counter from a unit with no melee weapon at all. Real,
 * reported bug.
 */
export function chooseDefenderWeaponIndex(
  attacker: Unit,
  attackerWeaponIndex: number,
  defender: Unit,
  distance: number,
  attackerTerrainDefense: number,
  defenderTerrainDefense: number,
  options: UnitStatsOptions = {},
): number {
  const attackerWeapon = attacker.attacks[attackerWeaponIndex];
  if (!attackerWeapon) return -1;

  let bestIndex = -1;
  let bestDefCombatant: Combatant | undefined;
  let bestAttCombatant: Combatant | undefined;

  const tryWeapon = (index: number, weapon: AttackType | undefined): void => {
    const { attacker: aStats, defender: dStats } = buildBattleContext({
      attacker,
      attackerWeapon,
      defender,
      defenderWeapon: weapon,
      distance,
      attackerTerrainDefense,
      defenderTerrainDefense,
      options,
    });
    const { attacker: aCombatant, defender: dCombatant } = simulateCombat(aStats, dStats);
    if (
      bestDefCombatant === undefined ||
      bestAttCombatant === undefined ||
      betterCombat(dCombatant, aCombatant, weapon?.defenseWeight ?? 1, bestDefCombatant, bestAttCombatant, 1, 1.0)
    ) {
      bestIndex = index;
      bestDefCombatant = dCombatant;
      bestAttCombatant = aCombatant;
    }
  };

  let consideredAny = false;
  defender.attacks.forEach((weapon, index) => {
    const rangeMatches = weapon.range === attackerWeapon.range;
    if (!rangeMatches || weapon.defenseWeight <= 0) return;
    consideredAny = true;
    tryWeapon(index, weapon);
  });

  if (!consideredAny) {
    // No usable counter-attack weapon: the defender fights back with nothing.
    tryWeapon(-1, undefined);
  }

  return bestIndex;
}
