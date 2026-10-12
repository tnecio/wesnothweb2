/**
 * A port of upstream's `actions/heal.cpp` (`calculate_healing`): the start-of-side-turn healing and poison pass
 * over every unit on the board. Phase 27b: `heals` and `regenerate` go through the ability pipeline
 * (`get_abilities`, `unit_abilities::effect`), so their filters, `[affect_adjacent]` and `affect_allies=` count.
 */

import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';
import { POISON_AMOUNT, REST_HEAL_AMOUNT } from './gameConfig.js';
import { abilityEffect, getAbilities } from './abilities.js';

type PoisonStatus = 'normal' | 'slowed' | 'cured';

/** `poison_status`. */
function poisonStatus(status: string): PoisonStatus {
  if (status === 'cured') return 'cured';
  if (status === 'slowed') return 'slowed';
  return 'normal';
}
function poisonRank(s: PoisonStatus): number {
  return s === 'normal' ? 0 : s === 'slowed' ? 1 : 2;
}

/** One unit's computed healing outcome for this side's turn, mirroring the `heal_unit` struct. */
export interface HealOutcome {
  readonly unit: Unit;
  readonly amount: number;
  readonly curePoison: boolean;
  /** Units (if any) whose `heals`/`regenerate` ability contributed. */
  readonly healers: readonly Unit[];
}

/** `poison_progress`: how far `patient`'s poison is treated on `side`'s turn, and the unit curing it, if any. */
function poisonProgress(board: GameBoard, side: number, patient: Unit): { status: PoisonStatus; healers: Unit[] } {
  const healers: Unit[] = [];
  let curing: PoisonStatus = 'normal';
  if (patient.side === side) {
    // Village healing?
    if (board.map.givesHealing(patient.location) > 0) return { status: 'cured', healers };
    // Regeneration?
    for (const regen of getAbilities(board, patient, 'regenerate').items) {
      const status = poisonStatus(regen.ability.cfg.getString('poison', ''));
      if (poisonRank(status) > poisonRank(curing)) curing = status;
      if (curing === 'cured') return { status: 'cured', healers };
    }
  }

  // Look through the healers to find a curer.
  let curer: Unit | undefined;
  const team = board.getTeam(side);
  for (const heal of getAbilities(board, patient, 'heals').items) {
    let thisCure = poisonStatus(heal.ability.cfg.getString('poison', ''));
    if (poisonRank(thisCure) <= poisonRank(curing)) continue;
    const cureUnit = board.unitAt(heal.teacherLoc);
    if (!cureUnit) continue;
    // Healers on the current side can cure poison (for any side); allies of the current side can only slow
    // it (for the current side); enemies can do nothing.
    const cureTeam = board.getTeam(cureUnit.side);
    if (cureTeam && team && cureTeam.isEnemy(team)) continue;
    if (cureUnit.side !== side) thisCure = 'slowed';
    if (thisCure === 'cured') {
      healers.push(cureUnit);
      return { status: 'cured', healers };
    }
    curer = cureUnit;
    curing = thisCure;
  }
  if (curer) healers.push(curer);
  return { status: curing, healers };
}

/** `heal_amount`: how much `patient` heals on `side`'s turn (a village, regeneration, this side's healers), and the healers. */
function healAmount(board: GameBoard, side: number, patient: Unit): { amount: number; healers: Unit[] } {
  let healing = 0;
  let harming = 0;
  const healers: Unit[] = [];
  /** `update_healing`. */
  const update = (value: number): boolean => {
    if (value > healing) {
      healing = value;
      return true;
    }
    if (value < harming) {
      harming = value;
      return true;
    }
    return false;
  };

  if (patient.side === side) {
    update(board.map.givesHealing(patient.location));
    update(abilityEffect(getAbilities(board, patient, 'regenerate'), 0).compositeValue);
  }

  // Healers not on this side do not heal now.
  const healList = getAbilities(board, patient, 'heals').filter((i) => board.unitAt(i.teacherLoc)?.side === side);
  const healEffect = abilityEffect(healList, 0);
  if (update(healEffect.compositeValue)) {
    for (const e of healEffect.effects) {
      const healer = board.unitAt(e.loc);
      if (healer) healers.push(healer);
    }
  }
  return { amount: healing + harming, healers };
}

/**
 * Mirrors `calculate_healing`: computes (without applying -- see
 * `applyHealing`) this side's healing pass over every unit currently on
 * the board (both this side's own units, per the rest/poison/heals rules,
 * and other sides' units insofar as their own healers act on their own
 * turn -- callers should invoke this once per side at that side's
 * turn-start, matching upstream's call site in `play_controller`).
 */
export function calculateHealing(board: GameBoard, side: number): HealOutcome[] {
  const outcomes: HealOutcome[] = [];

  for (const patient of board.allUnits()) {
    if (patient.hasStatus('unhealable') || patient.incapacitated) continue;

    let curing: PoisonStatus = 'normal';
    let healing = 0;
    let healers: Unit[] = [];

    if (patient.side === side && (patient.resting || isHealthy(patient))) {
      healing += REST_HEAL_AMOUNT;
    }

    if (!patient.poisoned) {
      const result = healAmount(board, side, patient);
      healing += result.amount;
      healers = result.healers;
    } else {
      const result = poisonProgress(board, side, patient);
      curing = result.status;
      healers = result.healers;
      if (curing === 'normal' && patient.side === side) {
        healing -= POISON_AMOUNT;
      }
    }

    const maxHeal = Math.max(0, patient.maxHitpoints - patient.hitpoints);
    const minHeal = Math.min(0, 1 - patient.hitpoints);
    if (healing < minHeal) healing = minHeal;
    else if (healing > maxHeal) healing = maxHeal;

    if (curing !== 'cured' && healing === 0) continue;

    outcomes.push({ unit: patient, amount: healing, curePoison: curing === 'cured', healers });
  }

  return outcomes;
}

/** Mirrors `unit::is_healthy()`: the healthy trait's `[effect] apply_to=healthy` (Phase 18c: applied, not guessed from the trait id). */
function isHealthy(unit: Unit): boolean {
  return unit.healthy;
}

/** Mirrors `do_heal`: applies one `HealOutcome` to its unit. */
export function applyHealing(outcome: HealOutcome): void {
  if (outcome.curePoison) outcome.unit.setStatus('poisoned', false);
  if (outcome.amount > 0) outcome.unit.hitpoints = Math.min(outcome.unit.maxHitpoints, outcome.unit.hitpoints + outcome.amount);
  else if (outcome.amount < 0) outcome.unit.takeHit(-outcome.amount);
}

/** Convenience: computes and immediately applies this side's healing pass, returning what happened. */
export function applySideHealing(board: GameBoard, side: number): HealOutcome[] {
  const outcomes = calculateHealing(board, side);
  for (const outcome of outcomes) applyHealing(outcome);
  return outcomes;
}
