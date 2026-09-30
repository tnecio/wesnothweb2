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

import { Location, distanceBetween } from '../model/Location.js';
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

/**
 * Mirrors `pathfind::a_star_search`. `width`/`height` and `border` follow
 * `Location.valid()`'s convention (mirrors `map_location::valid(w, h,
 * border)`); real call sites pass the board's playable `w()`/`h()` with the
 * default `border = 0`, matching every non-teleport upstream call site.
 *
 * As upstream, the nodes live in arrays indexed by map position (`indexer`), and the open list is a binary heap
 * of indices ordered by `t`. Upstream keeps its node vector static between searches; here it is allocated per
 * search, since a cost calculator (a Lua `calculate=` function) may start another search.
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
  // Only hexes on the map (with `border`) are entered; the source may be off it, as upstream's release builds
  // allow (a `[move_unit_fake]` waypoint on the border). A destination off the map is never reached.
  if (!dst.valid(width, height, border) && !dst.equals(src)) {
    return { steps: [], moveCost: NO_PATH_VALUE };
  }
  const minX = Math.min(-border, src.x);
  const minY = Math.min(-border, src.y);
  const stride = Math.max(width + border - 1, src.x) - minX + 1;
  const size = stride * (Math.max(height + border - 1, src.y) - minY + 1);
  const indexOf = (x: number, y: number): number => (y - minY) * stride + x - minX;
  const g = new Float64Array(size);
  const t = new Float64Array(size);
  const srch = new Float64Array(size);
  const prev = new Int32Array(size);
  const known = new Uint8Array(size);
  const locs: Array<Location | undefined> = new Array(size);
  const locAt = (i: number, x: number, y: number): Location => (locs[i] ??= new Location(x, y));

  // The open list: a binary heap of node indices, `t` ascending, with each index's heap position (-1: not open).
  const heap = new Int32Array(size);
  const pos = new Int32Array(size).fill(-1);
  let heapSize = 0;
  const swap = (i: number, j: number): void => {
    const a = heap[i]!;
    const b = heap[j]!;
    heap[i] = b;
    heap[j] = a;
    pos[b] = i;
    pos[a] = j;
  };
  const siftUp = (i: number): void => {
    let idx = i;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!(t[heap[idx]!]! < t[heap[parent]!]!)) break;
      swap(idx, parent);
      idx = parent;
    }
  };
  const siftDown = (i: number): void => {
    let idx = i;
    for (;;) {
      let best = idx;
      const l = 2 * idx + 1;
      const r = 2 * idx + 2;
      if (l < heapSize && t[heap[l]!]! < t[heap[best]!]!) best = l;
      if (r < heapSize && t[heap[r]!]! < t[heap[best]!]!) best = r;
      if (best === idx) break;
      swap(idx, best);
      idx = best;
    }
  };
  const push = (i: number): void => {
    heap[heapSize] = i;
    pos[i] = heapSize;
    heapSize++;
    siftUp(heapSize - 1);
  };
  const pop = (): number => {
    const top = heap[0]!;
    heapSize--;
    pos[top] = -1;
    if (heapSize > 0) {
      heap[0] = heap[heapSize]!;
      pos[heap[0]!] = 0;
      siftDown(0);
    }
    return top;
  };

  const useTeleports = teleports !== undefined && !teleports.isEmpty;
  // Heuristic distance from the nearest teleport target to the destination.
  let dsth = 1.0;
  if (useTeleports) for (const tp of teleports.targets) dsth = Math.min(dsth, heuristic(tp, dst));

  const setNode = (i: number, cost: number, curr: Location, from: number, knownSrch: number): void => {
    let h = heuristic(curr, dst);
    let s = knownSrch;
    if (useTeleports) {
      if (s < 0) {
        s = 1.0;
        for (const source of teleports.sources) s = Math.min(s, heuristic(curr, source));
      }
      h = Math.min(h, s + dsth + 1.0);
    }
    g[i] = cost;
    t[i] = cost + h;
    srch[i] = s;
    prev[i] = from;
    known[i] = 1;
  };

  const dstIdx = indexOf(dst.x, dst.y);
  const srcIdx = indexOf(src.x, src.y);
  locs[dstIdx] = dst;
  locs[srcIdx] = src;
  // `dst_node.g = stop_at + 1`: the bound until something reaches the destination.
  g[dstIdx] = stopAt + 1;
  setNode(srcIdx, 0, src, -1, -1);
  push(srcIdx);

  const visit = (n: number, nx: number, ny: number, loc: Location | undefined): void => {
    if (!(nx + border >= 0 && ny + border >= 0 && nx < width + border && ny < height + border)) return;
    const i = indexOf(nx, ny);
    if (i === n) return;
    const thresh = known[i] ? g[i]! : g[dstIdx]!;
    // cost() is always >= 1 (assumed, as upstream assumes -- needed by the heuristic).
    if (g[n]! + 1 >= thresh) return;
    const next = loc ? (locs[i] ??= loc) : locAt(i, nx, ny);
    const cost = g[n]! + calc.cost(next, g[n]!);
    if (cost >= thresh) return;
    setNode(i, cost, next, n, known[i] ? srch[i]! : -1);
    if (pos[i]! >= 0) siftUp(pos[i]!);
    else push(i);
  };

  while (heapSize > 0) {
    const n = pop();
    // Mirrors `if (n.t >= dst_node.g) break;` -- dst_node.g tracks the best
    // finish cost found so far (or the stop_at+1 bound before anything has
    // reached dst); once every remaining open node can only be worse, stop.
    if (t[n]! >= g[dstIdx]!) break;

    const curr = locs[n]!;
    const { x, y } = curr;
    // `get_adjacent_tiles` order: N, NE, SE, S, SW, NW.
    const xOdd = x & 1;
    visit(n, x, y - 1, undefined);
    visit(n, x + 1, y - (xOdd === 0 ? 1 : 0), undefined);
    visit(n, x + 1, y + (xOdd === 1 ? 1 : 0), undefined);
    visit(n, x, y + 1, undefined);
    visit(n, x - 1, y + (xOdd === 1 ? 1 : 0), undefined);
    visit(n, x - 1, y - (xOdd === 0 ? 1 : 0), undefined);
    if (useTeleports) for (const loc of teleports.adjacents(curr)) visit(n, loc.x, loc.y, loc);
  }

  if (!known[dstIdx] || g[dstIdx]! > stopAt) {
    return { steps: [], moveCost: NO_PATH_VALUE };
  }

  const steps: Location[] = [];
  for (let i = dstIdx; i !== srcIdx; i = prev[i]!) steps.push(locs[i]!);
  steps.push(src);
  steps.reverse();

  return { steps, moveCost: Math.trunc(g[dstIdx]!) };
}
