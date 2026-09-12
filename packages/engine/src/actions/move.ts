/**
 * TS port of the state-mutation half of upstream's `actions/move.cpp`
 * (`unit_mover`/`move_unit`): given a route (as produced by `pathfind.ts`'s
 * `findPath`), determines how far the unit can actually travel *this turn*
 * (`plot_turn`) and executes that portion of the move (`try_actual_
 * movement`), returning a structured `MoveResult` rather than mutating the
 * unit silently.
 *
 * Per `ARCHITECTURE.md`'s "why the engine must decouple state from
 * presentation" section, `unit_mover` upstream is thoroughly
 * display-coupled (animation frames, `display::invalidate`, minimap
 * redraws, `unit_display::unit_mover_animation`) and event-pump-coupled
 * (`enter_hex`/`exit_hex`/`sighted` WML events, replay/OOS checking). None
 * of that is ported here -- only the pure "which hexes does the unit end
 * up having entered, and what interrupted it" logic, mirroring
 * `unit_mover::plot_turn` (turn-boundary movement-point accounting) and
 * `unit_mover::cache_hidden_units`/`check_for_ambushers` (ambush
 * detection) combined into one pass over the route.
 *
 * Deliberately NOT ported (documented gaps, matching stances already
 * established elsewhere in this port):
 *  - **Fog/shroud "sighted" stopping** (`sighted_`/`pump_sighted`):
 *    `pathfind.ts`'s own module doc comment already excludes fog/shroud
 *    ("every hex is currently treated as visible... regardless of the
 *    seeAll flag"); this module inherits that gap rather than half-solving
 *    it here. A unit's move is never interrupted by "you can now see an
 *    enemy you couldn't before" -- only by ambush (see below) and ZoC/
 *    movement-point exhaustion, both of which don't need fog to detect.
 *  - **WML event pump** (`enter_hex`/`exit_hex`/`sighted` events, and
 *    anything they could do to abort the move or move a different unit):
 *    out of scope for this actions-only task, see `IMPLEMENTATION_PLAN.md`.
 *  - **Village capture** on arrival (`unit_mover::post_move`'s village
 *    handling / `actions::get_village`) IS handled here now that
 *    `GameBoard` tracks village ownership (`captureVillage`/`villageOwner`)
 *    -- `executeMove` reassigns the final hex's owner to `unit.side`
 *    whenever it's a village, mirroring upstream's unconditional
 *    reassignment (a captured village is simply reassigned, no "already
 *    owned" special case). `MoveResult.enteredVillage` still reports
 *    whether the final hex is a village, for callers that want to react to
 *    the capture (e.g. a UI toast) without re-deriving it themselves.
 *  - **Teleportation** (`try_teleport`/`pathfind::teleport_map`): no
 *    teleport-map support exists yet (`pathfind.ts`'s own module doc
 *    comment excludes it for the same "no ability-evaluation model yet"
 *    reason). `executeMove` only walks ordinary adjacent-hex steps.
 */

import { Location, getAdjacentTiles, ALL_DIRECTIONS, type Direction } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Team } from '../model/Team.js';
import type { Unit } from '../model/Unit.js';
import { UnitStatus } from '../model/Unit.js';
import { enemyZoc, hasSkirmisher } from '../pathfind/pathfind.js';

export interface PlanTurnMovementOptions {
  /** Only this team's visible units are considered for ZoC; omit for "see all" (matches `pathfind.ts`'s convention). */
  viewingTeam?: Team;
  seeAll?: boolean;
}

/** How far along `path` the unit can travel this turn, mirroring `unit_mover::plot_turn`. */
export interface PlannedMovement {
  /** `path`'s prefix reachable this turn (always starts with `path[0]`; length 1 means "cannot leave the starting hex"). */
  readonly steps: readonly Location[];
  /** Movement points remaining after each entered step (same length as `steps`; `movesLeftAfter[0]` is the unit's current `movesLeft`). */
  readonly movesLeftAfter: readonly number[];
  /** True if a zone of control forced the stop (as opposed to running out of movement points or the path simply ending). */
  readonly zocStopped: boolean;
}

/**
 * Mirrors `unit_mover::plot_turn`: how far `unit` can travel along `path`
 * (which must start at `unit.location`) given its current `movesLeft`,
 * accounting for terrain cost and enemy zones of control (entering one
 * exhausts the rest of the turn's movement, unless the unit skirmishes).
 * Does not mutate anything.
 */
export function planTurnMovement(
  board: GameBoard,
  unit: Unit,
  path: readonly Location[],
  options: PlanTurnMovementOptions = {},
): PlannedMovement {
  if (path.length === 0 || !path[0]!.equals(unit.location)) {
    throw new Error("planTurnMovement: path must start at the unit's current location");
  }
  const team = board.getTeam(unit.side);
  const seeAll = options.seeAll ?? false;
  const viewingTeam = seeAll ? undefined : options.viewingTeam;
  const skirmisher = hasSkirmisher(unit);

  /** Mirrors `plot_turn`'s "can we leave this hex" check: `pathfind.ts`'s `enemyZoc` already looks at the *neighboring* units' own ZoC-emission, so this only needs to skip the check for skirmishers. */
  const inEnemyZoc = (loc: Location): boolean => {
    if (!team || skirmisher) return false;
    return enemyZoc(board, team, loc, viewingTeam, seeAll);
  };

  const steps: Location[] = [path[0]!];
  const movesLeftAfter: number[] = [unit.movesLeft];
  let remaining = unit.movesLeft;
  let zocStopped = false;

  for (let i = 1; i < path.length; i++) {
    // A unit with no movement left at all (typically: already stopped by
    // ZoC on a prior hex, or this whole call is a no-op re-attempt) cannot
    // enter ANY further hex -- without this guard, the ZoC branch below
    // would compute `cost = remaining = 0` for a ZoC hex and let the unit
    // "enter for free," since 0 remaining minus 0 cost still isn't < 0.
    if (remaining <= 0) break;

    const hex = path[i]!;
    const terrain = board.map.getTerrain(hex);
    const terrainCost = unit.movementCost(terrain);

    // Entering a hex adjacent to an enemy (and not ourselves a skirmisher)
    // consumes ALL remaining movement, not just this hex's terrain cost --
    // mirrors `ShortestPathCalculator.cost()` (pathfind.ts), which already
    // gets this right. This function previously did NOT: it only checked
    // whether the *previously entered* hex was a ZoC hex before allowing a
    // *further* hop (and even then via `i > 1`, silently skipping the
    // check on the very first hop entirely), but never inflated the cost
    // of the ZoC entry itself -- so a single-hop move directly into a ZoC
    // hex, or a hop from one ZoC hex to an adjacent one around an enemy's
    // ring (both single hops), silently charged only the raw terrain cost
    // and left real movement to keep going. Real, reported bug -- a
    // player could circle all the way around a non-skirmisher enemy one
    // ring-hex at a time. See docs/PROGRESS.md.
    const enteringZoc = inEnemyZoc(hex);
    const cost = enteringZoc ? remaining : terrainCost;
    remaining -= cost;
    if (remaining < 0) break;
    steps.push(hex);
    movesLeftAfter.push(remaining);
    if (enteringZoc) {
      // Cannot continue past a ZoC hex this turn, regardless of whether
      // `remaining` happens to still allow further terrain costs -- only
      // "stopped short" (of the caller's requested path) if there was
      // more path left to take.
      zocStopped = i < path.length - 1;
      break;
    }
  }

  return { steps, movesLeftAfter, zocStopped };
}

export interface AmbushInfo {
  readonly ambushed: boolean;
  readonly ambusherLocations: readonly Location[];
}

/**
 * Mirrors `unit_mover::check_for_ambushers`: any adjacent enemy unit
 * invisible to the mover's own team ambushes the mover when it enters
 * `hex`.
 */
function checkForAmbushers(board: GameBoard, unit: Unit, hex: Location): AmbushInfo {
  const team = board.getTeam(unit.side);
  const ambushers: Location[] = [];
  const isAlly = (a: number, b: number): boolean => {
    const ta = board.getTeam(a);
    const tb = board.getTeam(b);
    return !!ta && !!tb && !ta.isEnemy(tb);
  };
  for (const adj of getAdjacentTiles(hex)) {
    const other = board.unitAt(adj);
    if (!other) continue;
    const otherTeam = board.getTeam(other.side);
    if (!team || !otherTeam || !team.isEnemy(otherTeam)) continue;
    if (!other.isVisibleToTeam(unit.side, isAlly, false)) {
      ambushers.push(adj);
    }
  }
  return { ambushed: ambushers.length > 0, ambusherLocations: ambushers };
}

export interface MoveResult {
  /** The hexes actually entered, in order (including the starting hex). */
  readonly path: readonly Location[];
  readonly movesLeft: number;
  /** True if the unit stopped before reaching `requestedPath`'s final hex, for any reason. */
  readonly stoppedEarly: boolean;
  readonly zocStopped: boolean;
  readonly ambushed: boolean;
  readonly ambusherLocations: readonly Location[];
  readonly enteredVillage: boolean;
  readonly facing: Direction;
}

export type ExecuteMoveOptions = PlanTurnMovementOptions;

function directionTo(from: Location, to: Location): Direction {
  const adj = getAdjacentTiles(from);
  const idx = adj.findIndex((loc) => loc.equals(to));
  return idx === -1 ? ALL_DIRECTIONS[0]! : ALL_DIRECTIONS[idx]!;
}

/**
 * Executes as much of `path` (a full route, e.g. from `pathfind.ts`'s
 * `findPath`) as `unit` can travel this turn, mutating the board: moves the
 * unit's board position, decrements `movesLeft`, updates facing, and clears
 * the `not_moved` status flag if it actually moved. Stops early on running
 * out of movement, entering an enemy zone of control, or ambush (an
 * adjacent hidden enemy discovered on entering a hex) -- see module doc
 * comment for what's deliberately not handled (fog "sighted" stops,
 * village capture, teleportation).
 */
export function executeMove(board: GameBoard, unit: Unit, path: readonly Location[], options: ExecuteMoveOptions = {}): MoveResult {
  const planned = planTurnMovement(board, unit, path, options);

  // Ambush detection: walk the planned steps, stopping (but still entering)
  // at the first hex with a hidden adjacent enemy, mirroring
  // `cache_hidden_units`/`check_for_ambushers`'s combined effect on the
  // executed portion of the route.
  const actualSteps: Location[] = [planned.steps[0]!];
  let actualMovesLeft = planned.movesLeftAfter[0]!;
  let ambushed = false;
  let ambusherLocations: readonly Location[] = [];

  for (let i = 1; i < planned.steps.length; i++) {
    const hex = planned.steps[i]!;
    const occupant = board.unitAt(hex);
    if (occupant) {
      const occupantTeam = board.getTeam(occupant.side);
      const unitTeam = board.getTeam(unit.side);
      const isEnemy = !!unitTeam && !!occupantTeam && unitTeam.isEnemy(occupantTeam);
      // Mirrors `unit_mover::check_for_obstructing_unit`: only an ENEMY
      // occupant ever blocks movement (defensive here -- shouldn't happen
      // given a path from `findPath`/`reachableHexes`, which already
      // exclude enemy-occupied hexes). A FRIENDLY unit does NOT obstruct
      // at all -- upstream's `cache_hidden_units` walks straight past
      // allied-occupied hexes with no stop, since this port never mutates
      // an intermediate hex's occupant (only origin/final are written),
      // there is nothing further to do here beyond not blocking.
      if (isEnemy) break;
    }
    actualSteps.push(hex);
    actualMovesLeft = planned.movesLeftAfter[i]!;

    const ambush = checkForAmbushers(board, unit, hex);
    if (ambush.ambushed) {
      ambushed = true;
      ambusherLocations = ambush.ambusherLocations;
      break;
    }
  }

  const finalHex = actualSteps[actualSteps.length - 1]!;
  const moved = actualSteps.length > 1;

  if (moved) {
    const prevHex = actualSteps[actualSteps.length - 2]!;
    board.moveUnit(unit.location, finalHex);
    unit.facing = directionTo(prevHex, finalHex);
    unit.setStatus(UnitStatus.NotMoved, false);
  }
  const enteredVillage = board.map.isVillage(finalHex);
  if (enteredVillage) {
    // Mirrors `unit_mover::post_move`: capturing a village (i.e. its owner
    // was NOT already this unit's side -- entering one you already own
    // doesn't cost anything extra) "zaps" the rest of this turn's movement,
    // in addition to reassigning ownership.
    const alreadyOwned = board.villageOwner(finalHex) === unit.side;
    board.captureVillage(finalHex, unit.side);
    if (!alreadyOwned) actualMovesLeft = 0;
  }
  unit.movesLeft = actualMovesLeft;

  return {
    path: actualSteps,
    movesLeft: actualMovesLeft,
    stoppedEarly: actualSteps.length < path.length,
    zocStopped: planned.zocStopped,
    ambushed,
    ambusherLocations,
    enteredVillage,
    facing: unit.facing,
  };
}
