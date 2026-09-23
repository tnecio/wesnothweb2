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
 *  - **Fog/shroud** IS handled: the unit steps hex by hex clearing fog
 *    (`handle_fog`), stops when units come into view at a reasonable stop,
 *    and hands `sighted` events to `options.raise` (no event pump here).
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
 *  - **Teleportation** (Phase 18a): a route may jump between
 *    non-adjacent hexes (a teleport, from `findPath`'s `allowTeleport`).
 *    It costs the exit hex's terrain as usual; an enemy on the exit, or an
 *    ally when the tunnel doesn't let units pass (`pass_allied_units=no`),
 *    fails the teleport and stops the unit before it
 *    (`check_for_obstructing_unit`, `MoveResult.teleportFailed`).
 */

import { Location, getAdjacentTiles, relativeDirection, tilesAdjacent, type Direction } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Team } from '../model/Team.js';
import type { Unit } from '../model/Unit.js';
import { UnitStatus } from '../model/Unit.js';
import { enemyZoc, hasSkirmisher } from '../pathfind/pathfind.js';
import { getVisibleUnit, unitInvisible } from '../pathfind/visibility.js';
import { ShroudClearer, actorSighted, getSidesNotSeeing, type RaiseEvent } from './vision.js';
import { getTeleportLocations } from '../pathfind/teleport.js';

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

  // plot_turn: never plan to end on a hex holding a unit the mover's side can see.
  const viewer = seeAll ? undefined : (viewingTeam ?? team);
  while (steps.length > 1 && getVisibleUnit(board, steps[steps.length - 1]!, viewer, seeAll)) {
    steps.pop();
    movesLeftAfter.pop();
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
  for (const adj of getAdjacentTiles(hex)) {
    const other = board.unitAt(adj);
    if (!other || other === unit) continue;
    const otherTeam = board.getTeam(other.side);
    if (!team || !otherTeam || !team.isEnemy(otherTeam)) continue;
    // `hidden=yes` is this port's older stand-in for a hides ability; keep it ambushing too.
    if (other.hidden || unitInvisible(board, other, adj)) ambushers.push(adj);
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
  /** An enemy the mover couldn't see occupied the next hex, so it stopped in front of it. */
  readonly blocked: boolean;
  /** A teleport on the route failed because a unit blocks its exit; the unit stopped before it. */
  readonly teleportFailed: boolean;
  /** Movement was interrupted because units came into view. */
  readonly sightedStop: boolean;
  readonly enemiesSighted: number;
  readonly friendsSighted: number;
  /** Fog or shroud was cleared along the way. */
  readonly fogChanged: boolean;
  /** Mirrors `unit_mover::undo_blocked`: the move revealed information and must not be undone. */
  readonly undoBlocked: boolean;
  readonly enteredVillage: boolean;
  readonly facing: Direction;
}

export interface ExecuteMoveOptions extends PlanTurnMovementOptions {
  /** Receives `sighted` events for the caller to pump; omit to drop them. */
  raise?: RaiseEvent;
}

/** The facing after stepping `from` -> `to`: the hex direction for a walk, the general direction for a teleport. */
function directionTo(from: Location, to: Location): Direction {
  return relativeDirection(from, to);
}

/**
 * Executes as much of `path` (a full route, e.g. from `pathfind.ts`'s
 * `findPath`) as `unit` can travel this turn, mirroring `unit_mover`'s
 * `try_actual_movement` + `post_move`: hidden units along the route are
 * found up front (an unseen enemy on the route blocks, an unseen enemy
 * adjacent to it ambushes), then the unit steps hex by hex, clearing fog
 * and stopping early if units come into view. Ambushers/blockers are
 * revealed (`uncovered`), village capture and `not_moved` are updated.
 */
export function executeMove(board: GameBoard, unit: Unit, path: readonly Location[], options: ExecuteMoveOptions = {}): MoveResult {
  const planned = planTurnMovement(board, unit, path, options);
  const team = board.getTeam(unit.side);
  const raise = options.raise;
  const start = planned.steps[0]!;

  // cache_hidden_units: where a hidden unit forces a stop, judged before moving.
  let limit = planned.steps.length;
  let ambusherLocations: readonly Location[] = [];
  let blockedLoc: Location | undefined;
  let teleportFailed = false;
  for (let i = 1; i < planned.steps.length; i++) {
    const hex = planned.steps[i]!;
    const occupant = board.unitAt(hex);
    const occupantTeam = occupant ? board.getTeam(occupant.side) : undefined;
    const prev = planned.steps[i - 1]!;
    if (occupant && occupant !== unit && !tilesAdjacent(prev, hex)) {
      // check_for_obstructing_unit: an enemy always blocks a teleport exit;
      // an ally only when the tunnel does not let units pass.
      const enemy = !!team && !!occupantTeam && team.isEnemy(occupantTeam);
      const allowed = !enemy && getTeleportLocations(board, unit, { seeAll: true }).adjacents(prev).some((l) => l.equals(hex));
      if (!allowed) {
        teleportFailed = true;
        limit = i;
        break;
      }
    }
    if (occupant && team && occupantTeam && team.isEnemy(occupantTeam)) {
      blockedLoc = hex;
      limit = i;
      break;
    }
    const ambush = checkForAmbushers(board, unit, hex);
    if (ambush.ambushed) {
      ambusherLocations = ambush.ambusherLocations;
      limit = i + 1;
      break;
    }
  }

  const usesFog = !!team && team.fogOrShroud() && team.autoShroudUpdates;
  const notSeeing = getSidesNotSeeing(board, unit);
  const clearer = new ShroudClearer(board);
  const counts = { enemies: 0, friends: 0 };
  const pumpSighted = (): void => {
    if (raise) clearer.fireEvents(raise);
    else clearer.dropEvents();
  };
  const isReasonableStop = (hex: Location): boolean =>
    board.unitAt(hex) === unit && (!board.map.isVillage(hex) || board.villageOwner(hex) === unit.side);

  let reached = 0;
  let sighted = false;
  let sightedStop = false;
  let fogChanged = false;
  for (let i = 1; i < limit; i++) {
    const from = planned.steps[i - 1]!;
    if (sighted && isReasonableStop(from)) {
      sightedStop = true;
      break;
    }
    const hex = planned.steps[i]!;
    // units().move fails onto an occupied hex: passing through an ally leaves the mover where it was.
    if (!board.hasUnitAt(hex)) {
      board.moveUnit(unit.location, hex);
      unit.facing = directionTo(from, hex);
    }
    reached = i;
    if (usesFog && team) {
      if (clearer.clearUnit(hex, unit, team, undefined, counts)) fogChanged = true;
      sighted = counts.enemies !== 0 || counts.friends !== 0;
    }
    if (isReasonableStop(hex)) pumpSighted();
  }
  pumpSighted();

  const finalHex = unit.location;
  const pathTaken = planned.steps.slice(0, reached + 1);
  while (pathTaken.length > 1 && !pathTaken[pathTaken.length - 1]!.equals(finalHex)) pathTaken.pop();
  const moved = !finalHex.equals(start);
  if (moved) {
    unit.setStatus(UnitStatus.NotMoved, false);
    // Mirrors `unit::end_turn()`'s `movement_ != total_movement()` check:
    // spending any movement this turn disqualifies the unit from its next
    // side-turn's rest-heal (`GameSession.advanceOneTurn` resets `resting`
    // back to true for every unit at the start of its own next turn).
    unit.resting = false;
  }
  if (raise) actorSighted(board, unit, raise, notSeeing);

  const ambushed = ambusherLocations.length > 0 && reached === limit - 1;
  const blocked = !!blockedLoc && reached === limit - 1;
  const revealed = [...(blocked ? [blockedLoc!] : []), ...(ambushed ? ambusherLocations : [])];
  for (const loc of revealed) {
    const other = board.unitAt(loc);
    if (!other) continue;
    const cache = getSidesNotSeeing(board, other);
    other.setStatus(UnitStatus.Uncovered, true);
    if (raise) actorSighted(board, other, raise, cache);
  }

  let movesLeft = planned.movesLeftAfter[reached]!;
  if (ambushed) movesLeft = 0;
  const enteredVillage = board.map.isVillage(finalHex);
  if (enteredVillage) {
    // Mirrors `unit_mover::post_move`: capturing a village (i.e. its owner
    // was NOT already this unit's side -- entering one you already own
    // doesn't cost anything extra) "zaps" the rest of this turn's movement,
    // in addition to reassigning ownership.
    const alreadyOwned = board.villageOwner(finalHex) === unit.side;
    board.captureVillage(finalHex, unit.side);
    if (!alreadyOwned) movesLeft = 0;
  }
  unit.movesLeft = movesLeft;

  return {
    path: pathTaken,
    movesLeft,
    stoppedEarly: pathTaken.length < path.length,
    zocStopped: planned.zocStopped,
    ambushed,
    ambusherLocations: ambushed ? ambusherLocations : [],
    blocked,
    teleportFailed,
    sightedStop,
    enemiesSighted: counts.enemies,
    friendsSighted: counts.friends,
    fogChanged,
    undoBlocked: ambushed || blocked || teleportFailed || fogChanged,
    enteredVillage,
    facing: unit.facing,
  };
}
