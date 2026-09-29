/**
 * TS port of upstream Wesnoth's `src/pathfind/pathfind.hpp`/`.cpp`: the
 * Wesnoth-specific pathfinding layer built on top of `astar.ts`'s generic
 * search -- movement-cost-aware A* between two hexes (`shortest_path_calculator`
 * + `a_star_search`, as `actions/move.cpp` uses it) and the "every hex this
 * unit can reach this turn" flood-fill (`find_routes`, as `pathfind::paths`'
 * constructor uses it) that drives move-range highlighting.
 *
 * Deliberately NOT ported (documented gaps, not oversights):
 *
 *  - **Teleportation** (Phase 18a): `findRoutes` takes a `TeleportMap`
 *    (`reachableHexes`' `allowTeleport`) and `findPath` passes one to A*.
 *    Vision paths do not use teleports yet (upstream's `check_vision`).
 *  - Vision/jamming paths themselves live in `actions/vision.ts`; this
 *    module only provides `find_routes`' `jamming_map` hook they use. Unit
 *    visibility (fog, `hides`) comes from `visibility.ts`.
 *  - **`emits_zoc()`'s per-unit override**: upstream's `unit::emits_zoc()`
 *    is `emit_zoc_ && !incapacitated()`, where `emit_zoc_` is a mutable
 *    per-unit flag that *usually* mirrors `unit_type::has_zoc()` but can be
 *    overridden by WML (`[unit] emit_zoc=`) or in-game effects. `Unit.ts`
 *    doesn't model that per-unit override (only the type-level flag), so
 *    `emitsZoc()` below is `unit.emitZoc && !unit.incapacitated` --
 *    correct for the overwhelmingly common case (no override), wrong only
 *    for the rare WML scenario that explicitly flips a unit's ZoC.
 *  - **Skirmisher (and any other ability) as a live, filter-evaluated
 *    ability**: upstream's `get_ability_bool("skirmisher", loc)` runs the
 *    full ability-active-condition machinery (adjacency filters, WML
 *    `[filter_location]`, etc.). Ability evaluation isn't ported (abilities
 *    are inert raw WML per `UnitType`'s module doc comment), so
 *    `hasSkirmisher()` below is a raw-data proxy: true if any of the unit's
 *    type-level `[abilities]` children is TAG `skirmisher` (matching
 *    upstream's own `tag_name == "..."` ability-type matching, not the
 *    ability's `id=` -- see `UnitType.abilities`'s own doc comment on why
 *    `id=` isn't a safe discriminator in general, even though it happens
 *    to equal the tag name for every real mainline skirmisher-granting
 *    ability too). This is right for a unit that
 *    unconditionally has the ability and wrong for a hypothetical
 *    conditionally-active one -- there are no mainline abilities like that
 *    for skirmisher specifically, so this is a safe approximation today.
 *  - `full_cost_map`: a higher-level helper built on top of `find_routes`
 *    for AI cost-map aggregation. Not needed yet by anything in this
 *    project's scope; add when a caller needs it. (`mark_route`, the route
 *    annotations the footsteps overlay and multi-turn moves use, IS ported
 *    as `markRoute` below, Phase 28b.) (`find_vacant_tile` -- the other helper this bullet used
 *    to list here -- IS now ported, see below: the `[move_unit]` WML action
 *    needs it, real content relies on that tag's "nearest vacant hex"
 *    fallback.)
 */

import { getTeleportLocations, type TeleportMap } from './teleport.js';
import { Location, getAdjacentTiles } from '../model/Location.js';
import type { TerrainCode } from '../model/Terrain.js';
import { UNREACHABLE } from '../model/MoveType.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Team } from '../model/Team.js';
import type { Unit } from '../model/Unit.js';
import { aStarSearch, NO_PATH_VALUE, type CostCalculator, type PlainRoute } from './astar.js';
import { IndexedHeap } from './heap.js';
import { getVisibleUnit, unitInvisible } from './visibility.js';

export { NO_PATH_VALUE } from './astar.js';
export type { PlainRoute } from './astar.js';

// --- unit/team helpers shared by the cost calculator and find_routes ---

/** Mirrors `unit::emits_zoc()` -- see module doc comment for the per-unit-override gap. */
export function emitsZoc(unit: Unit): boolean {
  return unit.emitZoc && !unit.incapacitated;
}

/** Approximates `unit.get_ability_bool("skirmisher", loc)` -- see module doc comment. */
export function hasSkirmisher(unit: Unit): boolean {
  return unit.abilities.some((a) => a.tag === 'skirmisher');
}

/** Mirrors `pathfind::enemy_zoc`. */
export function enemyZoc(
  board: GameBoard,
  currentTeam: Team,
  loc: Location,
  viewingTeam: Team | undefined,
  seeAll: boolean,
): boolean {
  for (const adj of getAdjacentTiles(loc)) {
    const u = getVisibleUnit(board, adj, viewingTeam, seeAll);
    if (!u || !emitsZoc(u)) continue;
    const uTeam = board.getTeam(u.side);
    if (uTeam && currentTeam.isEnemy(uTeam)) return true;
  }
  return false;
}

// --- shortest_path_calculator: movement-cost-aware two-hex A* ---

export interface ShortestPathCalculatorOptions {
  ignoreUnit?: boolean;
  ignoreDefense?: boolean;
  seeAll?: boolean;
}

/**
 * Mirrors `pathfind::shortest_path_calculator`: the cost function used for
 * "find a route for this unit to travel to a specific hex" (as opposed to
 * `findRoutes`' flood fill of every reachable hex). Blocks visible enemy
 * hexes, spends all remaining movement when crossing into an enemy zone of
 * control (unless skirmishing), and adds a sub-movement-point tie-breaker
 * favoring hexes with better terrain defense so `astar.ts`'s search prefers
 * the "nicer" of two equal-cost routes -- exactly as upstream's comment
 * describes.
 */
export class ShortestPathCalculator implements CostCalculator {
  private readonly ignoreUnit: boolean;
  private readonly ignoreDefense: boolean;
  private readonly seeAll: boolean;

  constructor(
    private readonly board: GameBoard,
    private readonly unit: Unit,
    private readonly viewingTeam: Team | undefined,
    options: ShortestPathCalculatorOptions = {},
  ) {
    this.ignoreUnit = options.ignoreUnit ?? false;
    this.ignoreDefense = options.ignoreDefense ?? false;
    this.seeAll = options.seeAll ?? false;
  }

  cost(loc: Location, soFar: number): number {
    const terrain: TerrainCode = this.board.map.getTerrain(loc);
    const movementLeft = this.unit.movesLeft;
    const totalMovement = this.unit.maxMoves;

    const terrainCost = this.unit.movementCost(terrain);

    let remainingMovement = movementLeft - Math.trunc(soFar);
    if (remainingMovement < 0) {
      remainingMovement = totalMovement - (-remainingMovement) % totalMovement;
    }

    if (terrainCost >= UNREACHABLE || (totalMovement < terrainCost && remainingMovement < terrainCost)) {
      return NO_PATH_VALUE;
    }

    let otherUnitSubcost = 0;
    const unitTeam = this.board.getTeam(this.unit.side);
    if (!this.ignoreUnit) {
      const other = getVisibleUnit(this.board, loc, this.viewingTeam, this.seeAll);
      if (other) {
        const otherTeam = this.board.getTeam(other.side);
        if (unitTeam && otherTeam && unitTeam.isEnemy(otherTeam)) {
          return NO_PATH_VALUE;
        }
        // Prefer empty hexes over friend-occupied ones (less blocking on
        // multi-turn moves; matches upstream's "-1% defense" comment).
        otherUnitSubcost = 1;
      }
    }

    let moveCost = 0;
    if (remainingMovement < terrainCost) {
      moveCost += remainingMovement;
      remainingMovement = totalMovement;
    }

    if (
      !this.ignoreUnit &&
      unitTeam &&
      remainingMovement !== terrainCost &&
      enemyZoc(this.board, unitTeam, loc, this.viewingTeam, this.seeAll) &&
      !hasSkirmisher(this.unit)
    ) {
      moveCost += remainingMovement;
    } else {
      moveCost += terrainCost;
    }

    const defenseSubcost = this.ignoreDefense ? 0 : this.unit.defenseModifier(terrain);
    return moveCost + (defenseSubcost + otherUnitSubcost) / 10000;
  }
}

export interface FindPathOptions extends ShortestPathCalculatorOptions {
  viewingTeam?: Team;
  /** Mirrors the `stop_at` bound real call sites pass (typically `map.w() + map.h()` or a large constant). */
  stopAt?: number;
  /** Route through the unit's teleports (default true: upstream hands `a_star_search` the unit's teleport map for moves, the AI and `find_path`). */
  allowTeleport?: boolean;
}

/**
 * Convenience wrapper mirroring how `actions/move.cpp`-style call sites use
 * `shortest_path_calculator` + `a_star_search` together: the single best
 * route for `unit` from its current location to `dst`.
 */
export function findPath(board: GameBoard, unit: Unit, dst: Location, options: FindPathOptions = {}): PlainRoute {
  const stopAt = options.stopAt ?? board.map.w() + board.map.h();
  const viewingTeam = options.seeAll ? undefined : (options.viewingTeam ?? board.getTeam(unit.side));
  const calc = new ShortestPathCalculator(board, unit, viewingTeam, options);
  const teleports = (options.allowTeleport ?? true) ? getTeleportLocations(board, unit, { viewingTeam, seeAll: viewingTeam === undefined }) : undefined;
  return aStarSearch(unit.location, dst, stopAt, calc, board.map.w(), board.map.h(), 0, teleports);
}

// --- mark_route: where a multi-turn route ends each turn ---

/** Mirrors `pathfind::marked_route::mark`: a hex where the unit ends a turn, or the route's last hex. */
export interface RouteMark {
  readonly loc: Location;
  /** The turn the unit reaches this hex (1 = this turn). */
  readonly turns: number;
  /** The unit stops here because it entered an enemy's zone of control. */
  readonly zoc: boolean;
  /** Stopping here captures a village (or, for an enemy unit on a fogged village, might). */
  readonly capture: boolean;
  /** The unit would be invisible here (`hides`). */
  readonly invisible: boolean;
}

/** Mirrors `pathfind::marked_route`. */
export interface MarkedRoute {
  /** The route's hexes, the unit's own first. */
  readonly steps: readonly Location[];
  /** One mark per turn-end hex plus the last hex, in route order. Ends early when the unit cannot go on. */
  readonly marks: readonly RouteMark[];
  /** `marked_route::move_cost` (upstream's `update_move_cost`): movement spent, a turn's leftover counted as spent. */
  readonly moveCost: number;
}

/**
 * Mirrors `pathfind::mark_route`: walks `steps` (a route from `unit`'s own
 * hex, as `findPath` returns) with the unit's movement, marking each hex
 * where it has to stop for the turn -- the next step costs more than it
 * has left, or it entered an enemy zone of control -- and the last hex,
 * each with the turn it gets there. `viewingTeam` is the side looking (its
 * knowledge of zones of control and fog); the unit's own by default.
 */
export function markRoute(board: GameBoard, unit: Unit, steps: readonly Location[], viewingTeam?: Team): MarkedRoute {
  const marks: RouteMark[] = [];
  if (steps.length === 0) return { steps, marks, moveCost: 0 };
  const unitTeam = board.getTeam(unit.side);
  const viewer = viewingTeam ?? unitTeam;
  const skirmisher = hasSkirmisher(unit);
  let turns = 0;
  let totalCosts = 0;
  let movement = unit.movesLeft;
  let zoc = false;

  for (let i = 0; i < steps.length; i++) {
    const loc = steps[i]!;
    const lastStep = i + 1 === steps.length;
    // The next step's cost is irrelevant for the last step.
    const moveCost = lastStep ? 0 : unit.movementCost(board.map.getTerrain(steps[i + 1]!));

    if (lastStep || zoc || moveCost > movement) {
      // A village the unit's side doesn't own is captured by stopping on it;
      // an enemy's fogged one is assumed captured (the viewer can't know).
      const capture =
        board.map.isVillage(loc) &&
        (board.villageOwner(loc) !== unit.side || (!!viewer && !!unitTeam && viewer.isEnemy(unitTeam) && board.isFogged(viewer.side, loc)));
      turns++;
      marks.push({ loc, turns, zoc, capture, invisible: unitInvisible(board, unit, loc, false) });
      if (lastStep) {
        if (capture) totalCosts += movement;
        break;
      }
      totalCosts += movement;
      movement = unit.maxMoves;
      // Can't reach the destination.
      if (moveCost > movement) return { steps, marks, moveCost: totalCosts };
    }

    zoc = !!unitTeam && enemyZoc(board, unitTeam, steps[i + 1]!, viewer, false) && !skirmisher;
    if (zoc) {
      totalCosts += movement;
      movement = 0;
    } else {
      movement -= moveCost;
      totalCosts += moveCost;
    }
  }
  return { steps, marks, moveCost: totalCosts };
}

// --- find_routes: the reachable-hexes flood fill ---

/** Mirrors `pathfind::paths::step`. */
export interface PathStep {
  readonly curr: Location;
  readonly prev: Location | null;
  /** Movement points left after arriving (blended across future turns: `moves_left + turns_left * max_moves`, mirroring upstream). */
  readonly moveLeft: number;
}

/** Mirrors `pathfind::paths::dest_vect`: an ordered set of reachable hexes with their best route. */
export class DestVect {
  private readonly byKey = new Map<string, PathStep>();

  get size(): number {
    return this.byKey.size;
  }

  find(loc: Location): PathStep | undefined {
    return this.byKey.get(loc.key());
  }

  contains(loc: Location): boolean {
    return this.byKey.has(loc.key());
  }

  /** Mirrors `dest_vect::insert`: adds `loc` with no route info if not already present. */
  insert(loc: Location): void {
    if (this.byKey.has(loc.key())) return;
    this.byKey.set(loc.key(), { curr: loc, prev: null, moveLeft: 0 });
  }

  /** Internal: records a real (route-bearing) step. Used by `findRoutes`. */
  setStep(step: PathStep): void {
    this.byKey.set(step.curr.key(), step);
  }

  /** All destinations, ordered to match `map_location::operator<` (x-major, then y). */
  values(): PathStep[] {
    return [...this.byKey.values()].sort((a, b) => a.curr.compare(b.curr));
  }

  /**
   * Mirrors `dest_vect::get_path`: the route from the flood-fill's origin
   * (included) to `step` (EXCLUDED -- matches upstream's doc comment
   * exactly, however surprising that looks at first glance).
   */
  getPath(step: PathStep): Location[] {
    const path: Location[] = [];
    if (!step.prev) {
      path.push(step.curr);
    } else {
      let i: PathStep | undefined = step;
      do {
        const prevStep: PathStep | undefined = this.find(i.prev!);
        if (!prevStep) break;
        i = prevStep;
        path.push(i.curr);
      } while (i.prev);
    }
    return path.reverse();
  }
}

/** Mirrors the parameters `pathfind::paths`' constructors funnel into `find_routes`. */
export interface FindRoutesOptions {
  /** Cost of entering a hex of the given terrain; mirrors `movetype::terrain_costs::cost`. Typically `unit.moveType.movementCost`. */
  costFn: (terrain: TerrainCode, slowed: boolean) => number;
  slowed?: boolean;
  movesLeft: number;
  maxMoves: number;
  /** Extra future turns of movement to search beyond the current one (0 = this turn only). */
  turnsLeft?: number;
  collectEdges?: boolean;
  /** If set, enemy-occupied hexes block movement and (with `zocUnit`) exert zones of control. Omit to ignore units entirely (mirrors `ignore_units=true`). */
  currentTeam?: Team;
  /** The moving unit, used to test its own skirmisher ability when crossing a zone of control. Omit (with `currentTeam` set) to force-ignore all zones of control while still blocking enemy-occupied hexes. */
  zocUnit?: Unit;
  /** Only this team's visible units are considered; omit for "see all". */
  viewingTeam?: Team;
  /** Mirrors `find_routes`' `jamming_map`: extra cost per hex (keyed by `Location.key()`), used by vision paths. */
  jammingMap?: ReadonlyMap<string, number>;
  /** Teleport targets reachable from each hex, as extra neighbours (upstream's `teleporter` argument). */
  teleports?: TeleportMap;
}

export interface FindRoutesResult {
  destinations: DestVect;
  /** Off-board or unreachable hexes bordering the reached area (may overlap `destinations`, matching upstream). */
  edges: Set<string>;
}

interface FindRouteNode {
  movesLeft: number;
  turnsLeft: number;
  prev: Location | null;
}

/**
 * Mirrors `find_routes()` (the `static` function in `pathfind.cpp`, called
 * by `pathfind::paths`' and `full_cost_map`'s constructors): a Dijkstra-like
 * flood fill from `origin` (vertex-weighted, not edge-weighted -- each
 * hex's terrain cost is paid once, on arrival) collecting every hex
 * reachable within `movesLeft` this turn plus `turnsLeft` further turns of
 * `maxMoves` each.
 *
 * Unlike `astar.ts`'s `aStarSearch`, this never re-relaxes an already-
 * touched node: because the search always expands the currently-best-known
 * node next (by `(turnsLeft desc, movesLeft desc)`, mirroring
 * `findroute_node::operator<`), the first time a hex is reached is
 * necessarily optimal, exactly as upstream relies on (`if (next.search_num
 * == search_counter) continue;`, no comparison against a prior cost).
 */
export function findRoutes(options: FindRoutesOptions & { board: GameBoard; origin: Location }): FindRoutesResult {
  const { board, origin, costFn, movesLeft, maxMoves, currentTeam, zocUnit, viewingTeam, collectEdges } = options;
  const slowed = options.slowed ?? false;
  const turnsLeft = options.turnsLeft ?? 0;
  const map = board.map;
  const seeAll = viewingTeam === undefined;

  const nodes = new Map<string, FindRouteNode>();
  const edges = new Set<string>();
  const destinations = new DestVect();

  const heap = new IndexedHeap<string>((a, b) => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    if (na.turnsLeft !== nb.turnsLeft) return na.turnsLeft > nb.turnsLeft;
    return na.movesLeft > nb.movesLeft;
  });

  const originKey = origin.key();
  nodes.set(originKey, { movesLeft, turnsLeft, prev: null });
  heap.push(originKey);
  // The origin is itself a valid "destination" (you can always stay put),
  // matching upstream's inclusion of it (its search_num is set at init, so
  // it always survives into the final destinations list).
  destinations.setStep({ curr: origin, prev: null, moveLeft: movesLeft + turnsLeft * maxMoves });

  while (heap.size > 0) {
    const curKey = heap.pop()!;
    const curNode = nodes.get(curKey)!;
    const curHex = Location.fromKey(curKey);

    const neighbours = options.teleports ? [...getAdjacentTiles(curHex), ...options.teleports.adjacents(curHex)] : getAdjacentTiles(curHex);
    for (const nextHex of neighbours) {
      if (!map.onBoard(nextHex)) {
        if (collectEdges) edges.add(nextHex.key());
        continue;
      }
      const nk = nextHex.key();
      // Already touched (open or finalized) this search -- never re-relaxed, see module doc comment.
      if (nodes.has(nk)) continue;

      const terrain = map.getTerrain(nextHex);
      let cost = costFn(terrain, slowed);
      const jam = options.jammingMap?.get(nk);
      if (jam !== undefined) cost += jam;

      let nextMovesLeft = curNode.movesLeft - cost;
      let nextTurnsLeft = curNode.turnsLeft;
      if (nextMovesLeft < 0) {
        nextTurnsLeft -= 1;
        nextMovesLeft = maxMoves - cost;
      }
      if (nextMovesLeft < 0 || nextTurnsLeft < 0) {
        // Either can never enter this hex, or out of turns to spend trying.
        if (collectEdges) edges.add(nk);
        continue;
      }

      if (currentTeam) {
        const other = getVisibleUnit(board, nextHex, viewingTeam, seeAll);
        if (other) {
          const otherTeam = board.getTeam(other.side);
          if (otherTeam && currentTeam.isEnemy(otherTeam)) {
            // Cannot enter enemy-occupied hexes.
            if (collectEdges) edges.add(nk);
            continue;
          }
        }

        if (
          zocUnit &&
          nextMovesLeft > 0 &&
          enemyZoc(board, currentTeam, nextHex, viewingTeam, seeAll) &&
          !hasSkirmisher(zocUnit)
        ) {
          nextMovesLeft = 0;
        }
      }

      // bug #2199: in "Show Enemy Moves", don't pathfind enemy units through the player's shroud.
      if (!seeAll && viewingTeam && currentTeam && viewingTeam !== currentTeam && viewingTeam.shrouded(nextHex, board.teams())) {
        continue;
      }

      nodes.set(nk, { movesLeft: nextMovesLeft, turnsLeft: nextTurnsLeft, prev: curHex });
      heap.push(nk);
      destinations.setStep({
        curr: nextHex,
        prev: curHex,
        moveLeft: nextMovesLeft + nextTurnsLeft * maxMoves,
      });
    }
  }

  return { destinations, edges };
}

// --- pathfind::paths equivalent: reachable hexes for a real unit ---

export interface ReachableHexesOptions {
  /** Set to completely ignore zones of control. */
  forceIgnoreZoc?: boolean;
  /** Only this team's visible units are considered; omit (or `seeAll`) for "see all". */
  viewingTeam?: Team;
  /** Extra future turns of movement to include (0 = this turn only). */
  additionalTurns?: number;
  seeAll?: boolean;
  /** Set if units should never obstruct paths (implies ignoring ZoC too, matching upstream). */
  ignoreUnits?: boolean;
  collectEdges?: boolean;
  /** Include the unit's teleports (`allow_teleport`). Defaults to true: the game's reach display, the AI's move maps and moves all pass it upstream. */
  allowTeleport?: boolean;
}

/**
 * Mirrors `pathfind::paths`' unit constructor: every hex `unit` can reach
 * this turn (plus `additionalTurns` more), with the best route to each --
 * the calculation behind move-range highlighting.
 */
export function reachableHexes(board: GameBoard, unit: Unit, options: ReachableHexesOptions = {}): FindRoutesResult {
  const forceIgnoreZoc = options.forceIgnoreZoc ?? false;
  const ignoreUnits = options.ignoreUnits ?? false;
  const seeAll = options.seeAll ?? false;

  const currentTeam = ignoreUnits ? undefined : board.getTeam(unit.side);
  const zocUnit = forceIgnoreZoc ? undefined : unit;
  const viewingTeam = seeAll ? undefined : options.viewingTeam;

  return findRoutes({
    board,
    origin: unit.location,
    costFn: (terrain, slowed) => unit.moveType.movementCost(terrain, slowed),
    slowed: unit.slowed,
    movesLeft: unit.movesLeft,
    maxMoves: unit.maxMoves,
    turnsLeft: options.additionalTurns ?? 0,
    collectEdges: options.collectEdges,
    currentTeam,
    zocUnit,
    viewingTeam,
    teleports: (options.allowTeleport ?? true)
      ? getTeleportLocations(board, unit, { viewingTeam, seeAll: viewingTeam === undefined, ignoreUnits })
      : undefined,
  });
}

// --- find_vacant_tile: nearest unoccupied hex to a point ---

export interface FindVacantTileOptions {
  /** Only consider castle tiles (mirrors upstream's `VACANT_CASTLE` enumerator; omit/false for `VACANT_ANY`). */
  castleOnly?: boolean;
  /** If given, a hex the unit can't enter at all (`movementCost` returns `UNREACHABLE`) is skipped once the search has expanded past a 10-hex radius (mirrors upstream's `pass_check`). */
  passCheck?: Unit;
}

/**
 * Mirrors `pathfind::find_vacant_tile`: the hex closest to `loc` (breadth-
 * first outward, `loc` itself checked first) that has no unit on it, or
 * `undefined` if none is found within 50 rings. Used by the `[move_unit]`
 * WML action (real content commonly targets an already-occupied hex,
 * relying on this "land nearby instead" fallback -- see that macro's own
 * comment: "setting the destination on an existing unit... causes the unit
 * to move to the nearest vacant hex instead").
 */
export function findVacantTile(board: GameBoard, loc: Location, options: FindVacantTileOptions = {}): Location | undefined {
  if (!board.map.onBoard(loc)) return undefined;
  const castleOnly = options.castleOnly ?? false;
  const passCheck = options.passCheck;

  // Upstream's tile sets are std::set<map_location>, which iterate sorted by
  // (x, y) -- so among equally distant vacant hexes the lowest x (then y)
  // wins. Iterating in insertion order instead put a Dead Water 1 zombie on
  // a different hex than the real game did.
  const byXY = (a: string, b: string) => {
    const la = Location.fromKey(a);
    const lb = Location.fromKey(b);
    return la.x - lb.x || la.y - lb.y;
  };
  let checked = new Set<string>();
  let pending = new Set<string>([loc.key()]);

  for (let distance = 0; distance < 50; distance++) {
    if (pending.size === 0) return undefined;
    const checking = pending;
    pending = new Set<string>();

    for (const key of [...checking].sort(byXY)) {
      const here = Location.fromKey(key);
      if (castleOnly && !board.map.isCastle(here)) continue;

      const unreachable = !!passCheck && passCheck.movementCost(board.map.getTerrain(here)) >= UNREACHABLE;
      if (unreachable && distance > 10) continue;
      if (!board.hasUnitAt(here) && !unreachable) return here;

      for (const adj of getAdjacentTiles(here)) {
        if (!board.map.onBoard(adj)) continue;
        const adjKey = adj.key();
        if (!checked.has(adjKey) && !checking.has(adjKey)) pending.add(adjKey);
      }
    }
    // `tiles_checked.swap(tiles_checking)`: only the ring just checked is remembered.
    checked = checking;
  }
  return undefined;
}
