/**
 * TS port of the move-map half of upstream's `readonly_context_impl`
 * (`src/ai/contexts.cpp`): for one side (or its enemies), which hexes
 * each of its units can reach this turn, as both a `srcdst` (unit
 * location -> reachable hexes) and `dstsrc` (hex -> units that can reach
 * it) multimap -- the data structure every candidate action queries
 * rather than recomputing pathfinding itself.
 *
 * Simplified vs. upstream's `calculate_moves` (documented, not silent):
 * no `additional_turns`/multi-turn projection, no `remove_destinations`
 * pruning beyond the `avoid` filter passed in, and a hex a same-side unit
 * already occupies is excluded outright rather than upstream's more
 * elaborate "can still be a valid intermediate/self hex" bookkeeping --
 * matches this port's own `simpleAi.ts`/`reachableHexes` conventions
 * (ally-occupied hexes are legal to path THROUGH but not stop on; a
 * caller temporarily relocating a unit to evaluate a hypothetical must
 * guard against overwriting whoever's actually there, same as
 * `simpleAi.ts`'s `evaluateAttack` already does).
 */

import type { GameBoard } from '../model/GameBoard.js';
import { Location } from '../model/Location.js';
import type { Team } from '../model/Team.js';
import { reachableHexes } from '../pathfind/pathfind.js';
import { isUnitVisibleToTeam } from '../pathfind/visibility.js';

/** `unit location key -> reachable hex list` (srcdst) or `hex key -> unit location list` (dstsrc) -- mirrors upstream's `move_map` multimap, keyed by `Location.key()`. */
export type MoveMap = ReadonlyMap<string, readonly Location[]>;

export interface CalculateMovesOptions {
  /** Compute for the OTHER sides (relative to `side`, "enemy" in the upstream sense: any side `side`'s team `isEnemy()`s), not `side`'s own units. */
  readonly enemy: boolean;
  /** Pretend every considered unit has full movement points (upstream's threat/support-projection convention: what could this side muster if it moved everything at once). */
  readonly assumeFullMovement: boolean;
  /** A destination hex this filter accepts is EXCLUDED (mirrors the `avoid` aspect / `remove_destinations`). */
  readonly avoid?: (loc: Location) => boolean;
  /** Only units visible to this team are considered when `enemy` is true (fog/hides-aware); omit (with `seeAll`) for a "no fog" computation. */
  readonly viewingTeam?: Team;
  readonly seeAll?: boolean;
}

export interface CalculatedMoves {
  readonly srcDst: MoveMap;
  readonly dstSrc: MoveMap;
}

/**
 * Mirrors `calculate_possible_moves`/`calculate_moves` (`src/ai/contexts.
 * cpp`): builds both directions of the move map for `side` (or its
 * enemies). The trivial self-move `(loc, loc)` is always included (every
 * unit can always "move" zero hexes -- upstream relies on this for e.g.
 * `move_to_targets`'s "already there" case). Allied-owned villages are
 * excluded as destinations for the side's OWN units (mirrors upstream:
 * an AI doesn't "move onto" an ally's village). Hexes visibly occupied by
 * another unit are excluded (can't stop where someone already stands).
 */
export function calculateMoves(board: GameBoard, side: number, options: CalculateMovesOptions): CalculatedMoves {
  const team = board.getTeam(side);
  const srcDst = new Map<string, Location[]>();
  const dstSrc = new Map<string, Location[]>();

  const units = board.allUnits().filter((u) => {
    if (options.enemy) {
      if (!team) return false;
      const unitTeam = board.getTeam(u.side);
      return !!unitTeam && team.isEnemy(unitTeam);
    }
    return u.side === side;
  });

  for (const unit of units) {
    if (unit.incapacitated) continue;
    if (!options.assumeFullMovement && unit.movesLeft <= 0) continue;

    const savedMoves = unit.movesLeft;
    if (options.assumeFullMovement) unit.movesLeft = unit.maxMoves;
    const { destinations } = reachableHexes(board, unit, {
      viewingTeam: options.seeAll ? undefined : options.viewingTeam,
      seeAll: options.seeAll,
    });
    if (options.assumeFullMovement) unit.movesLeft = savedMoves;

    if (options.enemy && !options.seeAll && options.viewingTeam) {
      if (!isUnitVisibleToTeam(board, unit, options.viewingTeam, false)) continue;
    }

    const dsts: Location[] = [unit.location];
    for (const step of destinations.values()) {
      const loc = step.curr;
      if (loc.equals(unit.location)) continue;
      if (options.avoid?.(loc)) continue;
      if (!options.enemy && team) {
        const owner = board.villageOwner(loc);
        if (owner !== undefined && owner !== side) {
          const ownerTeam = board.getTeam(owner);
          if (ownerTeam && !team.isEnemy(ownerTeam)) continue; // allied village: not a valid destination
        }
      }
      const occupant = board.unitAt(loc);
      if (occupant && occupant !== unit) continue;
      dsts.push(loc);
    }

    srcDst.set(unit.location.key(), dsts);
    for (const dst of dsts) {
      const key = dst.key();
      const existing = dstSrc.get(key);
      if (existing) existing.push(unit.location);
      else dstSrc.set(key, [unit.location]);
    }
  }

  return { srcDst, dstSrc };
}

/** All (unit-location) entries `dstSrc` lists as able to reach `loc`, mapped to the live `Unit` at each (skipping any that moved/died since the map was built). */
export function unitsReaching(board: GameBoard, dstSrc: MoveMap, loc: Location): Location[] {
  return [...(dstSrc.get(loc.key()) ?? [])];
}

export function destinationsOf(srcDst: MoveMap, from: Location): Location[] {
  return [...(srcDst.get(from.key()) ?? [])];
}
