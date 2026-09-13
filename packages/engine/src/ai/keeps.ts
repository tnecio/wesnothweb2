/**
 * TS port of the keep-lookup half of upstream's `readonly_context_impl`
 * (`src/ai/contexts.cpp`): `nearest_keep`/`suitable_keep`, used by
 * `move_leader_to_keep_phase` and `get_villages_phase` (dispatch tracks
 * "the reachable hex closest to the leader's own keep" for
 * castle-clearing purposes).
 *
 * Simplified vs. upstream (documented): `suitableKeep` here picks the
 * REACHABLE keep this turn with the lowest movement cost consumed to
 * reach it (via the `DestVect`'s own `moveLeft` bookkeeping -- higher
 * `moveLeft` after arriving means less was spent getting there), falling
 * back to the nearest keep overall (by hex distance) when none is
 * reachable this turn. Upstream additionally re-derives a full A* route
 * and inspects several fallback hexes along it; this port's simplified
 * version is faithful for the common "leader can already reach a keep
 * this turn" case Phase 29 S1's own tests exercise.
 */

import { Location, distanceBetween } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { DestVect } from '../pathfind/pathfind.js';

/** Every on-board keep hex. */
export function allKeeps(board: GameBoard): Location[] {
  const keeps: Location[] = [];
  for (let x = 0; x < board.map.w(); x++) {
    for (let y = 0; y < board.map.h(); y++) {
      const loc = new Location(x, y);
      if (board.map.isKeep(loc)) keeps.push(loc);
    }
  }
  return keeps;
}

/** Mirrors `nearest_keep`: the on-board keep hex closest to `loc` by simple hex distance. */
export function nearestKeep(board: GameBoard, loc: Location): Location | undefined {
  let best: Location | undefined;
  let bestDist = Infinity;
  for (const keep of allKeeps(board)) {
    const d = distanceBetween(loc, keep);
    if (d < bestDist) {
      bestDist = d;
      best = keep;
    }
  }
  return best;
}

/** See module doc comment for how this simplifies upstream's `suitable_keep`. */
export function suitableKeep(board: GameBoard, leaderLoc: Location, leaderDestinations: DestVect): Location | undefined {
  let best: Location | undefined;
  let bestMovesLeft = -1;
  for (const step of leaderDestinations.values()) {
    if (!board.map.isKeep(step.curr)) continue;
    if (step.moveLeft > bestMovesLeft) {
      bestMovesLeft = step.moveLeft;
      best = step.curr;
    }
  }
  if (best) return best;
  return nearestKeep(board, leaderLoc);
}
