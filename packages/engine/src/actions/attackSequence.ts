/**
 * Shared attack choreography: `executeAttack` plus the `last breath`/`die`
 * (fired immediately, while the dying unit is still on the board) and
 * `attack end` (queued) events real Wesnoth's `attack::perform_hit`/
 * `attack::fight`/`~attack` raise around a single attack. Extracted from
 * `packages/ui`'s `GameSession.confirmAttack` (the human attack-dialog
 * path) as part of Phase 29 (the real AI port) -- see `moveSequence.ts`'s
 * module doc comment for why this matters: the AI's own attacks need the
 * same events so WML hooked on them fires regardless of who's attacking.
 *
 * Deliberately NOT included here (caller responsibilities, since they need
 * session-level state this module has no access to):
 *  - Firing `attack` itself, and the "did that event end the scenario or
 *    displace either combatant" abort check `GameSession.confirmAttack`
 *    does before ever calling `executeAttack` -- both need the caller's own
 *    `scenarioResult`/event-pump wiring.
 *  - Draining whatever `attack end` (or `executeAttack`'s own internal fog
 *    recalculation) queued -- the caller pumps once, after this returns,
 *    alongside anything else queued in the same action.
 *  - Advancement (`advanceUnitFully`/an interactive advancement dialog):
 *    upstream's own `attack_unit_and_advance` runs it right after, but a
 *    human path (dialog-driven) and an AI path (always-random) want
 *    different policies, so each caller does its own.
 */

import type { GameBoard } from '../model/GameBoard.js';
import type { Location } from '../model/Location.js';
import type { Rng } from '../rng/Rng.js';
import { executeAttack, type AttackOptions, type AttackResult } from './combat.js';
import type { RaiseEvent } from './vision.js';

export interface PerformAttackOptions extends AttackOptions {
  /** Queues `attack end` after the exchange, and is passed through to `executeAttack` for its own internal fog-recalculation events (e.g. `sighted`). */
  raise?: RaiseEvent;
  /** Fires `last breath` then `die`, immediately, for a unit that died in this exchange -- called once per death, while the dead unit is still on the board (matches `AttackOptions.onUnitDying`'s contract). */
  fire?: (name: string, loc1: Location, loc2: Location) => void;
}

export function performAttack(
  board: GameBoard,
  rng: Rng,
  attackerLoc: Location,
  attackerWeaponIndex: number,
  defenderLoc: Location,
  defenderWeaponIndex: number | undefined,
  options: PerformAttackOptions = {},
): AttackResult {
  const { raise, fire, ...attackOptions } = options;
  const result = executeAttack(board, rng, attackerLoc, attackerWeaponIndex, defenderLoc, defenderWeaponIndex, {
    ...attackOptions,
    raise,
    onUnitDying: (dead, killer) => {
      fire?.('last breath', dead.location, killer.location);
      fire?.('die', dead.location, killer.location);
    },
  });
  raise?.('attack end', attackerLoc, defenderLoc);
  return result;
}
