/**
 * TS port of upstream Wesnoth's generic A* search (`src/pathfind/
 * astarsearch.hpp`/`.cpp`): `a_star_search`, over an abstract `cost_calculator`
 * interface. Deliberately generic -- not aware of `Unit`/`GameBoard` -- so it
 * can be reused for AI pathing, map-generator connectivity, and unit
 * movement alike, matching upstream's actual reuse (see call sites in
 * `game_state.cpp`, `mouse_events.cpp`, `ai/default/ca*.cpp`,
 * `generators/*_map_generator*.cpp`).
 *
 * NOT ported: teleportation (`pathfind::teleport_map`, from `teleport.cpp`).
 * Upstream's `a_star_search` takes an optional `teleport_map*` that adds
 * extra graph edges (ability-granted teleport pairs) and nudges the
 * heuristic to stay admissible around them; wesnothweb2 doesn't have a
 * teleport/ability-evaluation model yet (abilities are inert raw WML per
 * `UnitType`'s module doc comment), so there is nothing to feed a teleport
 * map from. This is a real, documented gap -- revisit once ability
 * evaluation exists. Every call site here simply omits it, exactly as
 * upstream call sites do when a unit has no teleport-granting ability.
 */

import { Location, getAdjacentTiles, distanceBetween } from '../model/Location.js';
import { IndexedHeap } from './heap.js';

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

  const srcH = heuristic(src, dst);
  nodes.set(srcKey, { g: 0, h: srcH, t: srcH, curr: src, prev: null });
  heap.push(srcKey);

  while (heap.size > 0) {
    const curKey = heap.pop()!;
    const n = nodes.get(curKey)!;

    // Mirrors `if (n.t >= dst_node.g) break;` -- dst_node.g tracks the best
    // finish cost found so far (or the stop_at+1 bound before anything has
    // reached dst); once every remaining open node can only be worse, stop.
    if (n.t >= (nodes.get(dstKey)?.g ?? stopAt + 1)) break;

    for (const loc of getAdjacentTiles(n.curr)) {
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
      const h = heuristic(loc, dst);
      nodes.set(lk, { g: cost, h, t: cost + h, curr: loc, prev: n.curr });

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
