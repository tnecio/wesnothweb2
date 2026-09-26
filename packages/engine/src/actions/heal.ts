/**
 * TS port of upstream's `actions/heal.cpp` (`calculate_healing`): the
 * start-of-side-turn healing/poison-damage pass over every unit on the
 * board.
 *
 * Deliberately simplified vs. upstream's full ability-evaluation version
 * (`heal_amount`/`poison_progress`, which run `unit_abilities::effect`
 * over every `heals`/`regenerate` ability in range with full filter/
 * `active_on`/adjacency evaluation): this project's abilities are inert
 * raw `WmlConfig` data everywhere else too (see `UnitType.ts`'s and
 * `combatStats.ts`'s module doc comments), so this module reads
 * `[heals]`/`[regenerate]` `[abilities]` entries **unconditionally** --
 * present on an adjacent unit's type (for `heals`) or the patient's own
 * type (for `regenerate`) means active, with no `[filter]`/
 * `[filter_adjacent]`/race/alignment/time-of-day conditions evaluated.
 * Concretely:
 *  - `heals`: any unit within one hex whose type has a `[heals]` ability
 *    heals *allied* (same-side, matching `heal_amount`'s "only this side's
 *    healers heal now" rule -- a healer only heals units on `side`, the
 *    side currently taking its turn) units by that ability's `value=`
 *    (poison curing is `[heals] poison=cured` -- also read directly).
 *    Multiple simultaneous healers don't stack (matches upstream: `heal_
 *    amount` takes the single largest value via `update_healing`).
 *  - `regenerate`: the patient's own type having a `[regenerate]` ability
 *    grants its `value=` as self-healing (and optionally poison curing),
 *    unconditional on anything except being the patient's own turn.
 *  - Allied (non-same-side, non-enemy) healers/regenerators are correctly
 *    restricted to *slowing* poison progression rather than curing it,
 *    mirroring `poison_progress`'s ally-vs-own-side distinction -- this
 *    part of the real rule *is* preserved since it only needs side/team
 *    data already on hand, not ability filter evaluation.
 *  - Resting/full-health rest-heal (`rest_heal_amount`) and poison damage
 *    (`poison_amount`) are ported exactly (no ability evaluation needed).
 */

import { getAdjacentTiles } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';
import type { WmlConfig } from '../wml/config.js';
import { POISON_AMOUNT, REST_HEAL_AMOUNT } from './gameConfig.js';

type PoisonStatus = 'normal' | 'slowed' | 'cured';

function poisonStatusRank(status: string): PoisonStatus {
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

/**
 * Every `[tag]` ability this unit's type has, by TAG NAME (`heals`,
 * `regenerate`) -- not by the ability's own `id=` attribute. Real content's
 * `id=` is a *display* id, not a type discriminator: the real `heals`-tag
 * registry entries (`heals_4`/`heals_8`/`cures`) all set `id=healing` or
 * `id=curing`, never literally `id=heals` -- matching by tag is what
 * upstream itself does (`tag_name == "heals"`, `src/units/abilities.cpp`).
 * Real bug this fixes: every real healer using the common `abilities_list=`
 * shorthand (e.g. Dead Water's Cylanna, a real Mermaid Priestess --
 * `abilities_list=heals_8,cures`) was previously invisible to this
 * function's old `id === 'heals'` check even after `specials_list=`/
 * `abilities_list=` resolution was added, because the resolved ability's
 * `id=` is "healing"/"curing", not "heals".
 */
function hasAbility(unit: Unit, tag: string): WmlConfig[] {
  return unit.abilities.filter((a) => a.tag === tag).map((a) => a.config);
}

/** Mirrors `poison_progress`: how far (if at all) `patient`'s poison is being treated this side's turn. */
function poisonProgress(board: GameBoard, side: number, patient: Unit): { status: PoisonStatus; healers: Unit[] } {
  const healers: Unit[] = [];
  let curing: PoisonStatus = 'normal';

  if (patient.side === side && board.map.givesHealing(patient.location) > 0) {
    return { status: 'cured', healers };
  }

  if (patient.side === side) {
    for (const regen of hasAbility(patient, 'regenerate')) {
      const status = poisonStatusRank(regen.getString('poison', ''));
      if (poisonRank(status) > poisonRank(curing)) curing = status;
      if (curing === 'cured') return { status: 'cured', healers };
    }
  }

  let curer: Unit | undefined;
  for (const adj of getAdjacentTiles(patient.location)) {
    const healer = board.unitAt(adj);
    if (!healer) continue;
    const healAbilities = hasAbility(healer, 'heals');
    if (healAbilities.length === 0) continue;
    let thisCure = poisonStatusRank(healAbilities[0]!.getString('poison', ''));
    if (poisonRank(thisCure) <= poisonRank(curing)) continue;

    const healerTeam = board.getTeam(healer.side);
    const patientTeam = board.getTeam(side);
    if (healerTeam && patientTeam && patientTeam.isEnemy(healerTeam)) continue;
    if (healer.side !== side) thisCure = 'slowed';

    if (thisCure === 'cured') {
      return { status: 'cured', healers: [healer] };
    }
    curer = healer;
    curing = thisCure;
  }
  if (curer) healers.push(curer);
  return { status: curing, healers };
}

/** Mirrors `heal_amount`: the (uncapped) amount `patient` heals this side's turn from village/regenerate/heals sources, plus any contributing healers. */
function healAmount(board: GameBoard, side: number, patient: Unit): { amount: number; healers: Unit[] } {
  let healing = 0;
  let harming = 0;
  const healers: Unit[] = [];

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
    for (const regen of hasAbility(patient, 'regenerate')) {
      update(regen.getNumber('value', 0));
    }
  }

  let bestHealValue = 0;
  let bestHealer: Unit | undefined;
  for (const adj of getAdjacentTiles(patient.location)) {
    const healer = board.unitAt(adj);
    if (!healer || healer.side !== side) continue;
    for (const heal of hasAbility(healer, 'heals')) {
      const value = heal.getNumber('value', 0);
      if (value > bestHealValue || bestHealer === undefined) {
        bestHealValue = value;
        bestHealer = healer;
      }
    }
  }
  if (bestHealer && update(bestHealValue)) {
    healers.push(bestHealer);
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
