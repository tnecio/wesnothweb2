/**
 * TS port of the plain-`advances_to=`-leveling slice of upstream's
 * `actions/advancement.cpp`: turning a unit that has accumulated enough XP
 * into its next-level type.
 *
 * Deliberately NOT ported: AMLA (after-max-level-advancement, `[advancement]`
 * modification-based advances past the normal `advances_to` list) --
 * `Unit.ts`'s own module doc comment already scopes `advances()`/
 * `advanceTo()` to plain leveling only ("AMLA ... and multi-step
 * advancement chains ... are only implemented for plain `advances_to=`
 * leveling"), so this module inherits that boundary rather than working
 * around it. `get_advanced_unit`'s trait/item-preserving clone-then-
 * advance shape is also not needed here since `Unit.advanceTo` already
 * mutates in place (no clone), matching how `Unit.ts` models a unit's
 * lifecycle throughout this port.
 */

import type { GameBoard } from '../model/GameBoard.js';
import { UnitStatus } from '../model/Unit.js';
import type { Unit } from '../model/Unit.js';
import type { UnitType } from '../model/UnitType.js';
import type { EffectEnv } from '../model/effects.js';
import type { Rng } from '../rng/Rng.js';

/** Result of advancing a unit one level, mirroring `advance_unit`'s net effect. */
export interface AdvancementResult {
  readonly unit: Unit;
  readonly fromTypeId: string;
  readonly toTypeId: string;
  /** True if further advancement is immediately possible again (overflow XP was enough for a second level), mirroring `advance_unit_at`'s cascading-advance loop. */
  readonly canAdvanceAgain: boolean;
}

/**
 * Advances `unit` to `newType` in place, mirroring `get_advanced_unit` +
 * `advance_unit`'s state-mutating effect: full heal, overflow XP carried
 * over (via `Unit.advanceTo`), and poison/slow/petrify cleared (advancing
 * cures all three, matching `get_advanced_unit`'s explicit `set_state`
 * calls).
 */
export function advanceUnitTo(unit: Unit, newType: UnitType, experienceModifierPercent = 100, env: EffectEnv = {}): AdvancementResult {
  const fromTypeId = unit.type.id;
  // get_advanced_unit: the XP overflow carries over, then advance_to (which
  // re-applies traits and objects to the new type), then a full heal.
  unit.experience = unit.experienceOverflow();
  unit.experienceModifier = experienceModifierPercent;
  unit.advanceTo(newType, env);
  unit.healToFull();
  unit.setStatus(UnitStatus.Poisoned, false);
  unit.setStatus(UnitStatus.Slowed, false);
  unit.setStatus(UnitStatus.Petrified, false);
  return {
    unit,
    fromTypeId,
    toTypeId: newType.id,
    canAdvanceAgain: unit.advances(),
  };
}

/**
 * Picks which of `unit.advancesTo` to advance into, mirroring the AI/
 * random branch of `unit_advancement_choice::query_user` (`get_random_int
 * (0, options-1)`) -- the human-dialog branch is a UI concern out of scope
 * here. Callers driving a human player's choice should call `advanceUnitTo`
 * directly with the player-picked type instead of this function.
 */
export function chooseAdvancementRandomly(unit: Unit, rng: Rng, resolveType: (id: string) => UnitType): UnitType {
  const options = unit.advancesTo;
  if (options.length === 0) {
    throw new Error(`chooseAdvancementRandomly: ${unit.type.id} has no advances_to options`);
  }
  const index = rng.getRandomInt(0, options.length - 1);
  return resolveType(options[index]!);
}

/**
 * Mirrors `advance_unit_at`'s cascading-advance loop (minus the WML
 * `pre_advance`/`post_advance`/dialog machinery, out of scope here): keeps
 * advancing `unit` for as long as it has enough XP and somewhere to
 * advance to, each time picking randomly among its `advances_to` options.
 * Returns every step taken (usually 0 or 1, but overflow XP from a kill
 * against a much higher-level unit can cascade further, matching
 * upstream's own comment about this).
 */
export function advanceUnitFully(
  board: GameBoard,
  unit: Unit,
  rng: Rng,
  resolveType: (id: string) => UnitType,
  experienceModifierPercent = 100,
): AdvancementResult[] {
  void board; // Kept for API symmetry with the other actions/ functions and for future callers that need board-relative effects (e.g. fog updates); not needed by plain leveling itself.
  const steps: AdvancementResult[] = [];
  let guard = 0;
  while (unit.advances() && guard < 20) {
    const newType = chooseAdvancementRandomly(unit, rng, resolveType);
    steps.push(advanceUnitTo(unit, newType, experienceModifierPercent));
    guard++;
  }
  return steps;
}
