/**
 * TS port of upstream `actions/vision.cpp` (plus `pathfind::vision_path`/
 * `jamming_path`): clearing fog/shroud around units and recording the
 * resulting `sighted` events.
 *
 * Differences from upstream:
 *  - Sightings hold `Unit` references rather than `underlying_id`s (this
 *    port's `underlyingId` isn't reliably unique), and firing takes a
 *    `raise` callback instead of reaching a global event pump.
 *  - No display invalidation: renderers re-read team fog/shroud state.
 *  - `clearer_info` (undo's unit-independent copy of vision data) isn't
 *    needed: undo here restores snapshots rather than replaying clears.
 */

import { Location, getAdjacentTiles, distanceBetween } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Team } from '../model/Team.js';
import { UnitStatus, type Unit } from '../model/Unit.js';
import type { TerrainCode } from '../model/Terrain.js';
import { findRoutes, type FindRoutesResult } from '../pathfind/pathfind.js';
import { getVisibleUnit, isUnitVisibleToTeam } from '../pathfind/visibility.js';

export type RaiseEvent = (name: string, loc1: Location, loc2: Location) => void;

/** `unit::vision()`: explicit `vision=` if set, otherwise the unit's max movement. */
export function unitVisionRange(unit: Unit): number {
  return unit.type.hasExplicitVision ? unit.type.vision : unit.maxMoves;
}

/** `unit::jamming()`. */
export function unitJammingRange(unit: Unit): number {
  return unit.type.jamming;
}

/** Mirrors `jamming_path`: hexes `jammer` can jam from `loc`, one turn out, ignoring units. */
export function jammingPath(board: GameBoard, jammer: Unit, loc: Location = jammer.location): FindRoutesResult {
  const range = unitJammingRange(jammer);
  return findRoutes({
    board,
    origin: loc,
    costFn: (terrain, slowed) => jammer.type.moveType.jammingCost(terrain, slowed),
    slowed: jammer.slowed,
    movesLeft: range,
    maxMoves: range,
  });
}

/** Mirrors `actions::create_jamming_map`: the strongest enemy jamming reaching each hex, as seen by `viewTeam`. */
export function createJammingMap(board: GameBoard, viewTeam: Team): Map<string, number> {
  const jamming = new Map<string, number>();
  for (const u of board.allUnits()) {
    const uTeam = board.getTeam(u.side);
    if (unitJammingRange(u) < 1 || !uTeam || !viewTeam.isEnemy(uTeam)) continue;
    for (const st of jammingPath(board, u).destinations.values()) {
      if ((jamming.get(st.curr.key()) ?? 0) < st.moveLeft) jamming.set(st.curr.key(), st.moveLeft);
    }
  }
  return jamming;
}

/** Mirrors `vision_path`'s cost-based constructor: hexes visible from `loc` (destinations) plus the ring just beyond (edges). */
export function visionPath(
  board: GameBoard,
  costFn: (terrain: TerrainCode, slowed: boolean) => number,
  slowed: boolean,
  sightRange: number,
  loc: Location,
  jamming: ReadonlyMap<string, number>,
): FindRoutesResult {
  return findRoutes({
    board,
    origin: loc,
    costFn,
    slowed,
    movesLeft: sightRange,
    maxMoves: sightRange,
    collectEdges: true,
    jammingMap: jamming,
  });
}

/** `vision_path` for a unit at `loc`. */
export function unitVisionPath(board: GameBoard, viewer: Unit, loc: Location, jamming: ReadonlyMap<string, number>): FindRoutesResult {
  return visionPath(
    board,
    (terrain, slowed) => viewer.type.moveType.visionCost(terrain, slowed),
    viewer.slowed,
    unitVisionRange(viewer),
    loc,
    jamming,
  );
}

/** Mirrors the file-static `can_see` in vision.cpp. */
function canSee(board: GameBoard, viewer: Unit, loc: Location, jamming?: ReadonlyMap<string, number>): boolean {
  const team = board.getTeam(viewer.side);
  const jam = jamming ?? (team ? createJammingMap(board, team) : new Map<string, number>());
  const sight = unitVisionPath(board, viewer, viewer.location, jam);
  return sight.destinations.contains(loc) || sight.edges.has(loc.key());
}

/** One recorded sighting: `seen` was uncovered at `seenLoc` by `sighter` standing at `sighterLoc`. */
export interface Sighting {
  seen: Unit;
  seenLoc: Location;
  sighter: Unit | undefined;
  sighterLoc: Location;
}

export interface SightCounts {
  enemies: number;
  friends: number;
}

/** Mirrors `actions::shroud_clearer`. */
export class ShroudClearer {
  private jamming = new Map<string, number>();
  private viewTeam: Team | undefined;
  private sightings: Sighting[] = [];

  constructor(private readonly board: GameBoard) {}

  /** Mirrors `cache_units`/`calculate_jamming`. */
  cacheUnits(newTeam?: Team): void {
    this.jamming = newTeam ? createJammingMap(this.board, newTeam) : new Map();
    this.viewTeam = newTeam;
  }

  /** Mirrors `shroud_clearer::clear_loc`. Returns true if `loc` was on-board and fogged under shared vision. */
  private clearLoc(
    team: Team,
    loc: Location,
    viewLoc: Location,
    eventNonLoc: Location,
    viewer: Unit | undefined,
    checkUnits: boolean,
    counts: SightCounts,
  ): boolean {
    const map = this.board.map;
    const wasFogged = team.fogged(loc, this.board.teams());
    const result = wasFogged && map.onBoard(loc);

    // Clear the border too, so half-hexes at the edge get cleared.
    if (map.onBoardWithBorder(loc)) {
      const clearedShroud = team.clearShroud(loc);
      const clearedFog = team.clearFog(loc);
      if (clearedShroud || clearedFog) {
        const w = map.w();
        const h = map.h();
        let corner: Location | undefined;
        if (loc.x === 0 && loc.y === h - 1) corner = new Location(-1, h);
        else if (w % 2 === 1 && loc.x === w - 1 && loc.y === h - 1) corner = new Location(w, h);
        else if (w % 2 === 0 && loc.x === w - 1 && loc.y === 0) corner = new Location(w, -1);
        if (corner) {
          team.clearShroud(corner);
          team.clearFog(corner);
        }
      }
    }

    if (result && checkUnits && !loc.equals(eventNonLoc)) {
      const seen = getVisibleUnit(this.board, loc, team, false);
      if (seen) {
        this.sightings.push({ seen, seenLoc: loc, sighter: viewer, sighterLoc: viewLoc });
        if (!seen.hasStatus(UnitStatus.Petrified)) {
          const seenTeam = this.board.getTeam(seen.side);
          if (!seenTeam || team.isEnemy(seenTeam)) counts.enemies++;
          else counts.friends++;
        }
      }
    }
    return result;
  }

  /**
   * Mirrors the general `shroud_clearer::clear_unit`: clears around
   * `viewLoc` for `team` using explicit vision data. `realLoc` (the
   * viewer's actual position) is never reported as sighted; hexes in
   * `knownUnits` (location keys) aren't checked for units.
   */
  clearWith(
    viewLoc: Location,
    team: Team,
    viewer: Unit | undefined,
    sightRange: number,
    slowed: boolean,
    costFn: (terrain: TerrainCode, slowed: boolean) => number,
    realLoc: Location,
    knownUnits?: ReadonlySet<string>,
    counts: SightCounts = { enemies: 0, friends: 0 },
  ): boolean {
    if (this.viewTeam !== team) this.cacheUnits(team);
    const sight = visionPath(this.board, costFn, slowed, sightRange, viewLoc, this.jamming);
    let cleared = false;
    for (const dest of sight.destinations.values()) {
      const known = knownUnits?.has(dest.curr.key()) ?? false;
      if (this.clearLoc(team, dest.curr, viewLoc, realLoc, viewer, !known, counts)) cleared = true;
    }
    for (const key of sight.edges) {
      const known = knownUnits?.has(key) ?? false;
      if (this.clearLoc(team, Location.fromKey(key), viewLoc, realLoc, viewer, !known, counts)) cleared = true;
    }
    return cleared;
  }

  /** Mirrors `clear_unit(view_loc, viewer, view_team, known_units, ...)`: as if `viewer` stood at `viewLoc`. */
  clearUnit(viewLoc: Location, viewer: Unit, team: Team, knownUnits?: ReadonlySet<string>, counts?: SightCounts): boolean {
    return this.clearWith(
      viewLoc,
      team,
      viewer,
      unitVisionRange(viewer),
      viewer.slowed,
      (terrain, slowed) => viewer.type.moveType.visionCost(terrain, slowed),
      viewer.location,
      knownUnits,
      counts,
    );
  }

  /**
   * Mirrors `clear_unit(view_loc, viewer, can_delay, ...)`: aborts if the
   * viewer's side uses neither fog nor shroud, or (with `currentSide`
   * given) if it's that side's turn and it has delayed shroud updates on.
   */
  clearUnitIfNeeded(viewLoc: Location, viewer: Unit, currentSide?: number): boolean {
    const team = this.board.getTeam(viewer.side);
    if (!team || !team.fogOrShroud()) return false;
    if (currentSide !== undefined && !team.autoShroudUpdates && viewer.side === currentSide) return false;
    return this.clearUnit(viewLoc, viewer, team);
  }

  /** Mirrors `shroud_clearer::clear_dest`: clears `dest` and its neighbours (used before a teleport lands). */
  clearDest(dest: Location, viewer: Unit): boolean {
    const team = this.board.getTeam(viewer.side);
    if (!team || !team.fogOrShroud()) return false;
    const counts = { enemies: 0, friends: 0 };
    let cleared = this.clearLoc(team, dest, dest, viewer.location, viewer, true, counts);
    for (const adj of getAdjacentTiles(dest)) {
      if (this.clearLoc(team, adj, dest, viewer.location, viewer, true, counts)) cleared = true;
    }
    return cleared;
  }

  /** Sightings recorded so far and not yet fired or dropped. */
  pendingSightings(): readonly Sighting[] {
    return this.sightings;
  }

  /** Mirrors `drop_events`. */
  dropEvents(): void {
    this.sightings = [];
  }

  /**
   * Mirrors `fire_events`: raises one `sighted` per recorded sighting
   * (primary = the seen unit, secondary = the sighter at its current
   * location, or null if it's gone). The caller pumps afterwards.
   */
  fireEvents(raise: RaiseEvent): void {
    const list = this.sightings;
    this.sightings = [];
    for (const s of list) {
      const sighterLoc = s.sighter && this.board.unitAt(s.sighter.location) === s.sighter ? s.sighter.location : Location.NULL;
      raise('sighted', s.seenLoc, sighterLoc);
    }
  }
}

/** Mirrors `actions::get_sides_not_seeing`. */
export function getSidesNotSeeing(board: GameBoard, target: Unit): number[] {
  return board
    .teams()
    .filter((t) => !isUnitVisibleToTeam(board, target, t, false))
    .map((t) => t.side);
}

/**
 * Mirrors `actions::actor_sighted`: fires `sighted` for each side (other
 * than the target's, and within `cache` if given) that can now see
 * `target`, with the second unit being one of that side's units that can
 * see it, or else its closest unit.
 */
export function actorSighted(board: GameBoard, target: Unit, raise: RaiseEvent, cache?: readonly number[]): void {
  const needsEvent = new Set<number>();
  for (const t of board.teams()) {
    if (cache && !cache.includes(t.side)) continue;
    if (t.side === target.side) continue;
    if (!isUnitVisibleToTeam(board, target, t, false)) continue;
    needsEvent.add(t.side);
  }

  const jammingBySide = new Map<number, Map<string, number>>();
  for (const side of needsEvent) jammingBySide.set(side, createJammingMap(board, board.getTeam(side)!));

  const second = new Map<number, { unit: Unit; distance: number }>();
  for (const viewer of board.allUnits()) {
    if (!needsEvent.has(viewer.side)) continue;
    const best = second.get(viewer.side);
    if (best?.distance === 0) continue;
    if (canSee(board, viewer, target.location, jammingBySide.get(viewer.side))) {
      second.set(viewer.side, { unit: viewer, distance: 0 });
    } else {
      const d = distanceBetween(target.location, viewer.location);
      if (!best || d < best.distance) second.set(viewer.side, { unit: viewer, distance: d });
    }
  }

  for (const t of board.teams()) {
    const s = second.get(t.side);
    if (s) raise('sighted', target.location, s.unit.location);
  }
}

/**
 * Mirrors `actions::recalculate_fog`: re-fogs `side` and clears it again
 * from its units' current positions. Units already visible beforehand
 * don't produce `sighted` events. Does nothing if the side has no fog.
 */
export function recalculateFog(board: GameBoard, side: number, raise?: RaiseEvent): void {
  const team = board.getTeam(side);
  if (!team || !team.usesFog()) return;

  const teams = board.teams();
  const visibleLocs = new Set<string>();
  for (const u of board.allUnits()) {
    if (!team.fogged(u.location, teams)) visibleLocs.add(u.location.key());
  }

  team.refog();
  const clearer = new ShroudClearer(board);
  for (const u of board.unitsForSide(side)) {
    clearer.clearUnit(u.location, u, team, visibleLocs);
  }
  if (raise) clearer.fireEvents(raise);
  else clearer.dropEvents();
}

/**
 * Mirrors `actions::clear_shroud`: clears `side`'s shroud and fog from its
 * units' current positions, without re-fogging unless `resetFog`. Pass
 * `raise` to fire `sighted` events (omit to drop them). Returns true if
 * anything was uncovered.
 */
export function clearShroud(board: GameBoard, side: number, options: { resetFog?: boolean; raise?: RaiseEvent } = {}): boolean {
  const team = board.getTeam(side);
  if (!team || !team.fogOrShroud()) return false;

  const clearer = new ShroudClearer(board);
  let result = false;
  for (const u of board.unitsForSide(side)) {
    if (clearer.clearUnit(u.location, u, team)) result = true;
  }
  if (options.raise) clearer.fireEvents(options.raise);
  else clearer.dropEvents();

  if (options.resetFog) recalculateFog(board, side, options.raise);
  return result;
}
