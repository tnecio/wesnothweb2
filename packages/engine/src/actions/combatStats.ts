/**
 * A port of the stats half of upstream's `actions/attack.cpp`: `battle_context_unit_stats` (one combatant's
 * chance to hit, damage, strikes and specials in a fight), `battle_context`'s weapon choice
 * (`choose_attacker_weapon`, `choose_defender_weapon`, `better_combat`), and `combat_modifier`.
 *
 * Phase 27b: every special and weapon ability goes through the ability pipeline (`abilities.ts`'s
 * `SpecialsContext`): `[damage]`, `[attacks]`, `[chance_to_hit]`, `[berserk]`, `[swarm]`, `[drains]`,
 * `[heal_on_hit]`, `[poison]`, `[slow]`, `[petrifies]`, `[firststrike]`, `[plague]`, `[damage_type]` and
 * `[disable]`, with their filters, `apply_to=`, `active_on=` and the opponent's specials -- so backstab is its
 * real `[filter_opponent]` formula, charge its `apply_to=both`, and a campaign's own specials work. Leadership,
 * resistance and `[defense]` abilities come from the same pipeline.
 */

import type { AttackType, Alignment } from '../model/UnitType.js';
import type { Unit } from '../model/Unit.js';
import type { GameBoard } from '../model/GameBoard.js';
import { distanceBetween, type Location } from '../model/Location.js';
import type { BattleContextUnitStats } from './attackPrediction.js';
import { swarmBlows, simulateCombat, Combatant } from './attackPrediction.js';
import { roundDamage } from './gameConfig.js';
import { SpecialsContext, abilityEffect, defenseModifier, type SpecialsCombatant } from './abilities.js';

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

// --- battle_context_unit_stats ---

export interface UnitStatsOptions {
  /**
   * `lawful_bonus`: the lawful bonus at the attacker's hex (with illumination), else the board's
   * (`GameBoard.lawfulBonusAt`), else 0. Used for the attacker's stats.
   */
  readonly attackerLawfulBonus?: number;
  /** The same, at the defender's hex, for the defender's stats. */
  readonly defenderLawfulBonus?: number;
  /** `tod_manager::get_max_liminal_bonus`; 0 by default. */
  readonly maxLiminalBonus?: number;
  /** `opp_terrain_defense`, for the attacker's stats: the defender's defense (a percentage, not the chance to be hit) instead of its hex's. */
  readonly defenderDefense?: number;
  /** The same, for the defender's stats: the attacker's defense. */
  readonly attackerDefense?: number;
}

/** One combatant of a fight: the unit, the hex it fights from (its own by default), and its weapon (none for no counter). */
export interface CombatantInput {
  readonly unit: Unit;
  readonly loc?: Location;
  readonly weapon: AttackType | undefined;
}

/**
 * `battle_context_unit_stats`: one combatant's numbers -- `u` at `uLoc` with `weapon`, attacking or defending
 * against `opp` at `oppLoc` with `oppWeapon`. `oppTerrainDefense` (a defense percentage) replaces the
 * opponent's hex's; `lawfulBonus` the board's lawful bonus at `uLoc`.
 */
export function battleContextUnitStats(
  board: GameBoard,
  u: Unit,
  uLoc: Location,
  weapon: AttackType | undefined,
  attacking: boolean,
  opp: Unit,
  oppLoc: Location,
  oppWeapon: AttackType | undefined,
  oppTerrainDefense?: number,
  lawfulBonus?: number,
  maxLiminalBonus = 0,
): BattleContextUnitStats {
  const hp = Math.max(0, Math.min(u.hitpoints, u.maxHitpoints));
  const base = {
    isAttacker: attacking,
    isPoisoned: u.poisoned,
    isSlowed: u.slowed,
    canAdvance: u.advances(),
    experience: u.experience,
    maxExperience: u.maxExperience,
    level: u.level,
    hp,
    maxHp: u.maxHitpoints,
  };
  if (!weapon) {
    return {
      ...base,
      slows: false,
      drains: false,
      petrifies: false,
      poisons: false,
      firststrike: false,
      plagues: false,
      plagueType: '',
      swarm: false,
      disable: false,
      leadershipBonus: 0,
      rounds: 1,
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

  const ctx = SpecialsContext.make(board, { un: u, loc: uLoc, at: weapon }, { un: opp, loc: oppLoc, at: oppWeapon }, attacking);
  const self = attacking ? ctx.attacker : ctx.defender;

  const slows = ctx.hasSpecialOrAbility(self, 'slow') && !opp.hasStatus('unslowable');
  let drains = !opp.hasStatus('undrainable') && ctx.hasSpecialOrAbility(self, 'drains');
  const petrifies = !opp.hasStatus('unpetrifiable') && ctx.hasSpecialOrAbility(self, 'petrifies');
  const poisons = !opp.hasStatus('unpoisonable') && ctx.hasSpecialOrAbility(self, 'poison') && !opp.poisoned;
  const rounds = ctx.getSpecialsAndAbilities(self, 'berserk').highest('value', 1).value;
  const firststrike = ctx.hasSpecialOrAbility(self, 'firststrike');

  const distance = distanceBetween(uLoc, oppLoc);
  const outOfRange = distance > weapon.maxRange || distance < weapon.minRange;
  const disable = ctx.hasSpecialOrAbility(self, 'disable') || outOfRange;

  // Plague: the special, an opponent that can be plagued (not `unplagueable`, an undead variation not `null`),
  // on a hex that is not a village.
  const plagueSpecials = ctx.getSpecialsAndAbilities(self, 'plague');
  const plagues = !opp.hasStatus('unplagueable') && plagueSpecials.length > 0 && opp.undeadVariation !== 'null' && !board.map.isVillage(oppLoc);
  let plagueType = '';
  if (plagues) plagueType = plagueSpecials.items[0]!.ability.cfg.getString('type', '') || u.baseType.id;

  // Chance to hit.
  const oppBaseCth = oppTerrainDefense !== undefined ? 100 - oppTerrainDefense : defenseModifier(board, opp, board.map.getTerrain(oppLoc), oppLoc);
  let cth = ctx.modifiedChanceToHit(self, oppBaseCth);
  if (opp.hasStatus('invulnerable')) cth = 0;
  const chanceToHit = Math.min(100, Math.max(0, cth));

  // Base damage, before the multiplier.
  const baseDamage = ctx.modifiedDamage(self);
  let damageMultiplier = 100;
  const alignment = weapon.alignment ?? u.alignment;
  damageMultiplier += combatModifier(lawfulBonus ?? board.lawfulBonusAt?.(uLoc) ?? 0, alignment, u.fearless, maxLiminalBonus);
  const leadershipBonus = underLeadershipInFight(ctx, self);
  if (leadershipBonus !== 0) damageMultiplier += leadershipBonus;
  damageMultiplier *= ctx.effectiveDamageType(self).res;

  let damage = roundDamage(baseDamage, damageMultiplier, 10000);
  const slowDamage = roundDamage(baseDamage, damageMultiplier, 20000);
  if (base.isSlowed) damage = slowDamage;

  let drainPercent = 0;
  if (drains) drainPercent = ctx.compositeValue(ctx.getSpecialsAndAbilities(self, 'drains'), 50);
  const drainConstant = ctx.compositeValue(ctx.getSpecialsAndAbilities(self, 'heal_on_hit'), 0);
  drains = drainConstant !== 0 || drainPercent !== 0;

  const { min: swarmMin, max: swarmMax } = ctx.modifiedAttacks(self);
  return {
    ...base,
    slows,
    drains,
    petrifies,
    poisons,
    firststrike,
    plagues,
    plagueType,
    swarm: swarmMin !== swarmMax,
    disable,
    leadershipBonus,
    rounds,
    chanceToHit,
    damage,
    slowDamage,
    drainPercent,
    drainConstant,
    numBlows: swarmBlows(swarmMin, swarmMax, hp, u.maxHitpoints),
    swarmMin,
    swarmMax,
  };
}

/** `under_leadership(u, context)`: the unit's leadership abilities active as specials in this fight. */
function underLeadershipInFight(ctx: SpecialsContext, self: SpecialsCombatant): number {
  return abilityEffect(ctx.getAbilitiesWeapons(self, 'leadership'), 0, undefined, 'cumulable').compositeValue;
}

export interface BattleContextInput {
  readonly board: GameBoard;
  readonly attacker: Unit;
  /** Where the attacker fights from; its own hex by default (the AI asks about hexes it would move to). */
  readonly attackerLoc?: Location;
  readonly attackerWeapon: AttackType | undefined;
  readonly defender: Unit;
  readonly defenderLoc?: Location;
  readonly defenderWeapon: AttackType | undefined;
  readonly options?: UnitStatsOptions;
}

/** `battle_context(attacker, a_loc, a_weapon, defender, d_loc, d_weapon)`: both combatants' stats. */
export function buildBattleContext(input: BattleContextInput): { attacker: BattleContextUnitStats; defender: BattleContextUnitStats } {
  const { board, attacker, defender, attackerWeapon, defenderWeapon } = input;
  const options = input.options ?? {};
  const aLoc = input.attackerLoc ?? attacker.location;
  const dLoc = input.defenderLoc ?? defender.location;
  const liminal = options.maxLiminalBonus ?? 0;
  return {
    attacker: battleContextUnitStats(board, attacker, aLoc, attackerWeapon, true, defender, dLoc, defenderWeapon, options.defenderDefense, options.attackerLawfulBonus, liminal),
    defender: battleContextUnitStats(board, defender, dLoc, defenderWeapon, false, attacker, aLoc, attackerWeapon, options.attackerDefense, options.defenderLawfulBonus, liminal),
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

/** A fight between one weapon pair: the stats, and the simulated outcome once asked for (`battle_context::simulate`). */
class WeaponChoice {
  private simulated: { attacker: Combatant; defender: Combatant } | undefined;
  constructor(
    readonly attackerWeaponIndex: number,
    readonly defenderWeaponIndex: number,
    readonly stats: { attacker: BattleContextUnitStats; defender: BattleContextUnitStats },
    readonly attackerWeapon: AttackType | undefined,
    readonly defenderWeapon: AttackType | undefined,
    private readonly prevDef?: Combatant,
  ) {}

  /** `battle_context::simulate(prev_def)`. */
  simulate(): { attacker: Combatant; defender: Combatant } {
    if (!this.simulated) {
      if (this.prevDef) {
        const attacker = new Combatant(this.stats.attacker);
        const defender = new Combatant(this.stats.defender, this.prevDef);
        attacker.fight(defender);
        this.simulated = { attacker, defender };
      } else {
        this.simulated = simulateCombat(this.stats.attacker, this.stats.defender);
      }
    }
    return this.simulated;
  }

  /** `better_defense`: is this a better fight for the defender than `that`? */
  betterDefense(that: WeaponChoice, harmWeight: number): boolean {
    const a = this.simulate();
    const b = that.simulate();
    return betterCombat(a.defender, a.attacker, this.defenderWeapon?.attackWeight ?? 1, b.defender, b.attacker, that.defenderWeapon?.attackWeight ?? 1, harmWeight);
  }

  /** `better_attack`. */
  betterAttack(that: WeaponChoice, harmWeight: number): boolean {
    const a = this.simulate();
    const b = that.simulate();
    return betterCombat(a.attacker, a.defender, this.attackerWeapon?.attackWeight ?? 1, b.attacker, b.defender, that.attackerWeapon?.attackWeight ?? 1, harmWeight);
  }
}

export interface WeaponChoiceInput {
  readonly board: GameBoard;
  readonly attacker: Unit;
  readonly attackerLoc?: Location;
  readonly defender: Unit;
  readonly defenderLoc?: Location;
  readonly options?: UnitStatsOptions;
  /** `prev_def`: the defender's outcome of an earlier fight this turn, which this one continues. */
  readonly prevDef?: Combatant;
}

function choice(input: WeaponChoiceInput, attackerWeaponIndex: number, defenderWeaponIndex: number): WeaponChoice {
  const attackerWeapon = attackerWeaponIndex >= 0 ? input.attacker.attacks[attackerWeaponIndex] : undefined;
  const defenderWeapon = defenderWeaponIndex >= 0 ? input.defender.attacks[defenderWeaponIndex] : undefined;
  const stats = buildBattleContext({ ...input, attackerWeapon, defenderWeapon });
  return new WeaponChoice(attackerWeaponIndex, defenderWeaponIndex, stats, attackerWeapon, defenderWeapon, input.prevDef);
}

/**
 * `battle_context::choose_defender_weapon`: the defender's answer to `attackerWeaponIndex` -- among its weapons
 * of the same range with a positive `defense_weight` and not disabled, one that disables the attacker's weapon if
 * any, else the one giving the defender the best fight among those rating at least the heaviest weapon's.
 * Returns both indices and the stats (-1: no weapon).
 */
function chooseDefenderChoice(input: WeaponChoiceInput, attackerWeaponIndex: number): WeaponChoice {
  const att = input.attacker.attacks[attackerWeaponIndex];
  if (!att) throw new Error('An invalid attacker weapon got selected.');
  const choices: WeaponChoice[] = [];
  for (let i = 0; i < input.defender.attacks.length; i++) {
    const def = input.defender.attacks[i]!;
    if (def.range !== att.range || def.defenseWeight <= 0) continue;
    const bc = choice(input, attackerWeaponIndex, i);
    if (bc.stats.defender.disable) continue;
    // The defender's weapon disables the attacker's: always this one.
    if (bc.stats.attacker.disable) return bc;
    choices.push(bc);
  }
  if (choices.length === 0) return choice(input, attackerWeaponIndex, -1);
  if (choices.length === 1) return choices[0]!;

  // First pass: the heaviest weight, and the lowest simple rating among weapons of that weight.
  let minRating = 0;
  let maxWeight = 0;
  for (const c of choices) {
    const dWeight = c.defenderWeapon!.defenseWeight;
    if (dWeight >= maxWeight) {
      const d = c.stats.defender;
      maxWeight = dWeight;
      const rating = Math.trunc(d.numBlows * d.damage * d.chanceToHit * dWeight);
      // As upstream, `d_weight > max_weight` is never true here, having just been assigned.
      if (rating < minRating) minRating = rating;
    }
  }
  let best: WeaponChoice | undefined;
  for (const c of choices) {
    const d = c.stats.defender;
    const simpleRating = Math.trunc(d.numBlows * d.damage * d.chanceToHit * c.defenderWeapon!.defenseWeight);
    if (simpleRating >= minRating && (!best || c.betterDefense(best, 1.0))) best = c;
  }
  return best ?? choice(input, attackerWeaponIndex, -1);
}

/** `choose_defender_weapon`'s weapon: an index into the defender's attacks, or -1 for none. */
export function chooseDefenderWeaponIndex(input: WeaponChoiceInput, attackerWeaponIndex: number): number {
  return chooseDefenderChoice(input, attackerWeaponIndex).defenderWeaponIndex;
}

/**
 * `battle_context::choose_attacker_weapon`: for each of the attacker's weapons with a positive `attack_weight`
 * (and not disabled by the defender's answer), the defender's answer; then the best fight for the attacker
 * with this `harmWeight` (1 - aggression). -1 for both when the attacker has no usable weapon.
 */
export function chooseAttackerWeapon(input: WeaponChoiceInput, harmWeight: number): { attackerWeaponIndex: number; defenderWeaponIndex: number } {
  const choices: WeaponChoice[] = [];
  for (let i = 0; i < input.attacker.attacks.length; i++) {
    if (input.attacker.attacks[i]!.attackWeight <= 0) continue;
    const bc = chooseDefenderChoice(input, i);
    if (bc.stats.attacker.disable) continue;
    choices.push(bc);
  }
  if (choices.length === 0) return { attackerWeaponIndex: -1, defenderWeaponIndex: -1 };
  let best = choices[0]!;
  for (const c of choices.slice(1)) if (c.betterAttack(best, harmWeight)) best = c;
  return { attackerWeaponIndex: best.attackerWeaponIndex, defenderWeaponIndex: best.defenderWeaponIndex };
}
