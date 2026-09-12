/**
 * TS port of `display_context::unit_can_move`/its `can_move_result`
 * (src/display_context.cpp/.hpp) -- whether a unit has any adjacent hex it
 * could still step onto, and/or any adjacent-or-in-range hex holding an
 * attackable enemy. This is NOT full pathfinding/reachability: it mirrors
 * upstream's own (surprisingly narrow) real definition, checking only the
 * unit's immediately adjacent hexes for `move` (no ZoC/occupancy check, no
 * flood fill -- upstream's own `move` loop doesn't do either), and a scan
 * of hexes within its weapons' `min_range=`/`max_range=` union (via
 * `Location.getRing`, not upstream's own literal `dx/dy` loop) for
 * `attack_here`.
 *
 * Used by `GameSession.toSnapshotUnit` to feed `movesOrbStatus` (`packages/
 * renderer/src/unitOverlays.ts`) -- real, reported bug: a unit that still
 * has movement points left, but is boxed in with nowhere to actually move
 * to and no attack possible, showed the "partial" (yellow) orb instead of
 * the real "moved" (red) one, since the orb logic only ever checked the raw
 * `movesLeft <= 0` counter, never real reachability.
 */

import { isUnitVisibleToTeam } from '../pathfind/visibility.js';
import { getAdjacentTiles, distanceBetween } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';

export interface UnitCanAct {
  /** Can move to another adjacent hex, taking account only of terrain cost vs remaining movement points -- mirrors `can_move_result::move`. */
  readonly canMove: boolean;
  /** Can make an attack from the current hex -- mirrors `can_move_result::attack_here`. */
  readonly canAttackHere: boolean;
}

/** Mirrors `display_context::unit_can_move`. */
export function unitCanAct(board: GameBoard, unit: Unit): UnitCanAct {
  if (unit.attacksLeft <= 0 && unit.movesLeft <= 0) {
    return { canMove: false, canAttackHere: false };
  }

  const isEnemyOf = (side: number): boolean => {
    const ownTeam = board.getTeam(unit.side);
    const otherTeam = board.getTeam(side);
    return !!ownTeam && !!otherTeam && ownTeam.isEnemy(otherTeam);
  };
  const isAlly = (a: number, b: number): boolean => {
    const ta = board.getTeam(a);
    const tb = board.getTeam(b);
    return !!ta && !!tb && !ta.isEnemy(tb);
  };

  let canAttackHere = false;
  if (unit.attacksLeft > 0 && unit.attacks.length > 0) {
    const attackableDistances = new Set<number>();
    for (const attack of unit.attacks) {
      for (let d = attack.minRange; d <= attack.maxRange; d++) attackableDistances.add(d);
    }
    if (attackableDistances.size > 0) {
      // `getRing` (proper cubic-coordinate hex math) replaces upstream's
      // literal `dx/dy + floor(dx/2)` bounding-box loop -- equivalent for
      // this project's own `Location` convention, without needing to
      // re-derive/trust that raw C++ loop's exact hex-grid adjustment here.
      const candidates = unit.location.getRing(Math.min(...attackableDistances), Math.max(...attackableDistances));
      for (const loc of candidates) {
        if (!attackableDistances.has(distanceBetween(unit.location, loc))) continue;
        if (!board.map.onBoard(loc)) continue;
        const other = board.unitAt(loc);
        if (other && !other.incapacitated && isEnemyOf(other.side) && isUnitVisibleToTeam(board, other, board.getTeam(unit.side)!, false)) {
          canAttackHere = true;
          break;
        }
      }
    }
  }

  let canMove = false;
  for (const adj of getAdjacentTiles(unit.location)) {
    if (!board.map.onBoard(adj)) continue;
    if (unit.movementCost(board.map.getTerrain(adj)) <= unit.movesLeft) {
      canMove = true;
      break;
    }
  }

  return { canMove, canAttackHere };
}
