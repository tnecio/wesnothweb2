/**
 * TS port of upstream Wesnoth's generic A* search (`src/pathfind/
 * astarsearch.hpp`/`.cpp`): `a_star_search`, over an abstract `cost_calculator`
 * interface. Deliberately generic -- not aware of `Unit`/`GameBoard` -- so it
 * can be reused for AI pathing, map-generator connectivity, and unit
 * movement alike, matching upstream's actual reuse (see call sites in
 * `game_state.cpp`, `mouse_events.cpp`, `ai/default/ca*.cpp`,
 * `generators/*_map_generator*.cpp`).
 *
 * Teleports (Phase 18a): an optional `TeleportMap` adds each source hex's
 * teleport targets as extra neighbours, and lowers a node's heuristic to
 * "distance to the nearest teleport source + 1 + distance from the nearest
 * target to the destination" when that is smaller, so the estimate stays
 * admissible (astarsearch.cpp's `node` constructor).
 */

import { Location, getAdjacentTiles, distanceBetween } from '../model/Location.js';
import { IndexedHeap } from './heap.js';
import type { TeleportMap } from './teleport.js';

/** Mirrors `cost_calculator::getNoPathValue()`: the sentinel "this path is impossible" cost. */
export const NO_PATH_VALUE = 42424242;

/** Mirrors `pathfind::cost_calculator`. */
export interface CostCalculator {
  /** Cost of moving *into* `loc`, given `soFar` cost already spent reaching its predecessor. */
  cost(loc: Location, soFar: number): number;
}

/** Mirrors `pathfind::plain_route`. */
export interface PlainRoute {
  /** Hexes from source (included) to destination (included), in order. Empty if no path was found. */
  readonly steps: Location[];
  /** Total cost of the route (or `NO_PATH_VALUE` if none was found), truncated to an integer as upstream does. */
  readonly moveCost: number;
}

/**
 * Mirrors `heuristic()` (anonymous-namespace helper in astarsearch.cpp): the
 * hex-count hexagonal distance, plus a tiny screen-space Euclidean tie-
 * breaker (kept below the 1-movement-point granularity) so paths that look
 * straight on screen are preferred among otherwise-equal-cost options.
 */
function heuristic(src: Location, dst: Location): number {
  const xdiff = (src.x - dst.x) * 0.75;
  // eslint-disable-next-line no-bitwise
  const ydiff = src.y - dst.y + ((src.x & 1) - (dst.x & 1)) * 0.5;
  return distanceBetween(src, dst) + (xdiff * xdiff + ydiff * ydiff) / 900000000.0;
}

interface AStarNode {
  g: number;
  h: number;
  t: number;
  /** Heuristic distance to the nearest teleport source (upstream `srch`); -1 until computed. */
  srch: number;
  curr: Location;
  prev: Location | null;
}

/**
 * Mirrors `pathfind::a_star_search`. `width`/`height` and `border` follow
 * `Location.valid()`'s convention (mirrors `map_location::valid(w, h,
 * border)`); real call sites pass the board's playable `w()`/`h()` with the
 * default `border = 0`, matching every non-teleport upstream call site.
 */
export function aStarSearch(
  src: Location,
  dst: Location,
  stopAt: number,
  calc: CostCalculator,
  width: number,
  height: number,
  border = 0,
  teleports?: TeleportMap,
): PlainRoute {
  // Mirrors the early-abort check: if the destination itself can never be
  // entered (regardless of path), don't bother searching.
  if (calc.cost(dst, 0) >= stopAt) {
    return { steps: [], moveCost: NO_PATH_VALUE };
  }

  const nodes = new Map<string, AStarNode>();
  const dstKey = dst.key();
  const srcKey = src.key();

  const bestG = (loc: Location): number => nodes.get(loc.key())?.g ?? Number.POSITIVE_INFINITY;

  const heap = new IndexedHeap<string>((a, b) => nodes.get(a)!.t < nodes.get(b)!.t);

  const useTeleports = teleports !== undefined && !teleports.isEmpty;
  // Heuristic distance from the nearest teleport target to the destination.
  let dsth = 1.0;
  if (useTeleports) for (const t of teleports.targets) dsth = Math.min(dsth, heuristic(t, dst));

  const makeNode = (g: number, curr: Location, prev: Location | null, knownSrch: number): AStarNode => {
    let h = heuristic(curr, dst);
    let srch = knownSrch;
    if (useTeleports) {
      if (srch < 0) {
        srch = 1.0;
        for (const s of teleports.sources) srch = Math.min(srch, heuristic(curr, s));
      }
      h = Math.min(h, srch + dsth + 1.0);
    }
    return { g, h, t: g + h, srch, curr, prev };
  };

  nodes.set(srcKey, makeNode(0, src, null, -1));
  heap.push(srcKey);

  while (heap.size > 0) {
    const curKey = heap.pop()!;
    const n = nodes.get(curKey)!;

    // Mirrors `if (n.t >= dst_node.g) break;` -- dst_node.g tracks the best
    // finish cost found so far (or the stop_at+1 bound before anything has
    // reached dst); once every remaining open node can only be worse, stop.
    if (n.t >= (nodes.get(dstKey)?.g ?? stopAt + 1)) break;

    const neighbours = useTeleports ? [...getAdjacentTiles(n.curr), ...teleports.adjacents(n.curr)] : getAdjacentTiles(n.curr);
    for (const loc of neighbours) {
      if (!loc.valid(width, height, border)) continue;
      if (loc.equals(n.curr)) continue;

      const lk = loc.key();
      const isKnown = nodes.has(lk);
      const thresh = isKnown ? bestG(loc) : (nodes.get(dstKey)?.g ?? stopAt + 1);

      // cost() is always >= 1 (assumed, as upstream assumes -- needed by the heuristic).
      if (n.g + 1 >= thresh) continue;
      const cost = n.g + calc.cost(loc, n.g);
      if (cost >= thresh) continue;

      const wasOpen = heap.has(lk);
      nodes.set(lk, makeNode(cost, loc, n.curr, isKnown ? nodes.get(lk)!.srch : -1));

      if (wasOpen) {
        heap.fix(lk);
      } else {
        heap.push(lk);
      }
    }
  }

  const dstNode = nodes.get(dstKey);
  if (!dstNode || dstNode.g > stopAt) {
    return { steps: [], moveCost: NO_PATH_VALUE };
  }

  const steps: Location[] = [];
  let cur: AStarNode | undefined = dstNode;
  while (cur && cur.prev) {
    steps.push(cur.curr);
    cur = nodes.get(cur.prev.key());
  }
  steps.push(src);
  steps.reverse();

  return { steps, moveCost: Math.trunc(dstNode.g) };
}
