/**
 * Shared move choreography: `executeMove` plus the `capture`/`moveto` event
 * pair real Wesnoth's `unit_mover::post_move` raises after a real (more
 * than zero-length) move. Extracted from `packages/ui`'s `GameSession.
 * moveSelectedTo` (the human click-to-move path) as part of Phase 29 (the
 * real AI port): the AI's own move actions need the exact same
 * choreography so `moveto`/`capture`-triggered WML (ambush triggers,
 * "you entered my village" dialogue, etc.) fires for AI-controlled units
 * too, not just the human player's -- a real, previously-undetected gap
 * (`playAiTurn`, the Phase 7 heuristic AI, called `executeMove` directly
 * with no `raise` at all beyond `sighted`).
 */

import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';
import type { Location } from '../model/Location.js';
import { executeMoveFlow, type ExecuteMoveOptions, type MoveResult } from './move.js';
import { runFlow, type Flow } from '../events/interaction.js';

export interface PerformMoveResult {
  readonly result: MoveResult;
  /** Whether `capture` was raised (a real, previously-unowned-by-us village was the final hex). */
  readonly captured: boolean;
  /** Whether `moveto` (and therefore also `capture`, when applicable) was raised at all -- false for a zero-length "couldn't leave the hex" move. */
  readonly moved: boolean;
}

/**
 * Executes `path` via `executeMove`, then raises `capture` (if the unit's
 * real final hex is a village it didn't already own) followed by `moveto`
 * -- mirroring `unit_mover::post_move`'s ordering exactly. Both events are
 * queued through `options.raise` (the same callback `executeMove` itself
 * uses for `sighted`), not fired immediately; the caller pumps them
 * alongside anything else queued during the same action.
 */
export function performMove(
  board: GameBoard,
  unit: Unit,
  path: readonly Location[],
  options: ExecuteMoveOptions = {},
): PerformMoveResult {
  return runFlow(performMoveFlow(board, unit, path, options));
}

/** `performMove` with the per-step hex events (`options.hexEvent`), which may block on WML dialogue. */
export function* performMoveFlow(
  board: GameBoard,
  unit: Unit,
  path: readonly Location[],
  options: ExecuteMoveOptions = {},
): Flow<PerformMoveResult> {
  const start = unit.location;
  // Captured before the move actually happens: village ownership at each
  // hex of the REQUESTED path, indexed by the ACTUAL stopping point below --
  // mirrors GameSession.moveSelectedTo's own `ownersBefore` snapshot, which
  // must run before executeMove mutates anything.
  const ownersBefore = path.map((step) => board.villageOwner(step));
  const result = yield* executeMoveFlow(board, unit, path, options);
  const moved = result.path.length > 1;
  const finalHex = result.path[result.path.length - 1]!;
  let captured = false;
  if (moved) {
    if (result.enteredVillage && ownersBefore[result.path.length - 1] !== unit.side) {
      captured = true;
      options.raise?.('capture', finalHex, start);
    }
    // post_move fires `moveto` at the final hex even if WML removed the unit.
    options.raise?.('moveto', finalHex, start);
  }
  return { result, captured, moved };
}
