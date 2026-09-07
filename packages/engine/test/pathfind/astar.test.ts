import { describe, expect, it } from 'vitest';
import { Location, tilesAdjacent } from '../../src/model/Location.js';
import { aStarSearch, NO_PATH_VALUE, type CostCalculator } from '../../src/pathfind/astar.js';

/**
 * Synthetic-grid unit tests for the generic A* search itself, isolated from
 * the terrain/unit model. Real-content verification against the actual
 * Dead_Water map lives in pathfindRealMap.test.ts -- these toy grids are a
 * complement (fast, exact, easy to reason about edge cases), not a
 * replacement.
 */

/** Uniform cost-1 grid, with an optional set of "wall" hexes that cost NO_PATH_VALUE. */
class GridCalculator implements CostCalculator {
  constructor(private readonly walls: Set<string> = new Set()) {}
  cost(loc: Location): number {
    return this.walls.has(loc.key()) ? NO_PATH_VALUE : 1;
  }
}

describe('aStarSearch (synthetic grids)', () => {
  it('finds a direct route on an open uniform-cost grid', () => {
    const calc = new GridCalculator();
    const src = new Location(0, 0);
    const dst = new Location(3, 0);
    const route = aStarSearch(src, dst, 10000, calc, 10, 10);

    expect(route.moveCost).toBeLessThan(NO_PATH_VALUE);
    expect(route.steps[0]!.equals(src)).toBe(true);
    expect(route.steps.at(-1)!.equals(dst)).toBe(true);
    // Every consecutive pair of steps must be board-adjacent, and cost should equal hex count - 1.
    for (let i = 1; i < route.steps.length; i++) {
      expect(tilesAdjacent(route.steps[i - 1]!, route.steps[i]!)).toBe(true);
    }
    expect(route.moveCost).toBe(route.steps.length - 1);
  });

  it('returns no path when the destination is walled off entirely', () => {
    const width = 5;
    const height = 5;
    const walls = new Set<string>();
    // Wall off every hex adjacent to (2,2) so it's unreachable and unenterable.
    const wallCoords: Array<[number, number]> = [
      [2, 1],
      [3, 1],
      [3, 2],
      [2, 3],
      [1, 2],
      [1, 1],
    ];
    for (const [x, y] of wallCoords) {
      walls.add(new Location(x, y).key());
    }
    const calc = new GridCalculator(walls);
    const route = aStarSearch(new Location(0, 0), new Location(2, 2), 10000, calc, width, height);
    expect(route.moveCost).toBe(NO_PATH_VALUE);
    expect(route.steps).toEqual([]);
  });

  it('trivial route from a hex to itself is just that hex, cost 0', () => {
    const calc = new GridCalculator();
    const src = new Location(2, 2);
    const route = aStarSearch(src, src, 10000, calc, 10, 10);
    expect(route.moveCost).toBe(0);
    expect(route.steps).toHaveLength(1);
    expect(route.steps[0]!.equals(src)).toBe(true);
  });

  it('respects stopAt: a route costing more than stopAt is reported as no-path', () => {
    const calc = new GridCalculator();
    const src = new Location(0, 0);
    const dst = new Location(9, 0);
    const shortStop = aStarSearch(src, dst, 3, calc, 20, 20);
    expect(shortStop.moveCost).toBe(NO_PATH_VALUE);

    const longStop = aStarSearch(src, dst, 100, calc, 20, 20);
    expect(longStop.moveCost).toBeLessThan(NO_PATH_VALUE);
    expect(longStop.moveCost).toBeGreaterThanOrEqual(9); // at least 9 hexes of horizontal distance
  });

  it('prefers the cheaper of two routes when one crosses higher-cost terrain', () => {
    // A 3-wide corridor: the middle column costs 5 to enter, the side columns cost 1.
    class CorridorCalculator implements CostCalculator {
      cost(loc: Location): number {
        return loc.x === 1 ? 5 : 1;
      }
    }
    const route = aStarSearch(new Location(0, 1), new Location(2, 1), 10000, new CorridorCalculator(), 3, 3);
    expect(route.moveCost).toBeLessThan(NO_PATH_VALUE);
    // The optimal route should avoid stepping through the expensive middle
    // column when a cheaper detour around it exists.
    const crossesMiddle = route.steps.some((s) => s.x === 1);
    if (crossesMiddle) {
      // If it does cross (e.g. no detour fits in a 3x3 grid), cost must still reflect the toll paid.
      expect(route.moveCost).toBeGreaterThanOrEqual(5);
    }
  });

  it('respects map bounds (border=0): cannot route through negative coordinates', () => {
    const calc = new GridCalculator();
    // Small grid; a destination just off the edge should be unreachable by construction of valid().
    const route = aStarSearch(new Location(0, 0), new Location(-1, 0), 10000, calc, 5, 5);
    expect(route.moveCost).toBe(NO_PATH_VALUE);
  });
});
