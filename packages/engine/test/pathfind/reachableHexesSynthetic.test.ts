import { describe, expect, it } from 'vitest';
import { Location, distanceBetween, getAdjacentTiles } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { reachableHexes, findPath, findVacantTile, NO_PATH_VALUE } from '../../src/pathfind/pathfind.js';

/**
 * Synthetic hand-built-board tests for the Wesnoth-specific pathfinding
 * layer (enemy blocking, zones of control, skirmisher, multi-turn
 * spillover), complementing (not replacing) the real Dead_Water map
 * integration test in pathfindRealMap.test.ts. A uniform-cost grid keeps
 * these mechanics isolated and exactly checkable, since verifying ZoC
 * behavior on a real map would require hunting for specific unit
 * placements rather than exercising the rule directly.
 */

function buildFlatMap(size: number, terrainData: TerrainTypeData): GameMap {
  const row = Array.from({ length: size }, () => 'Gg').join(',');
  const text = Array.from({ length: size }, () => row).join('\n');
  return GameMap.fromMapString(text, terrainData, 1);
}

function buildMoveType(costs: Record<string, number>, terrainData: TerrainTypeData): MoveType {
  const cfg = new WmlConfig();
  const costsCfg = new WmlConfig();
  for (const [k, v] of Object.entries(costs)) costsCfg.setAttribute(k, v);
  cfg.addChild('movement_costs', costsCfg);
  return MoveType.fromConfig(cfg, terrainData);
}

function makeUnitType(
  id: string,
  moveType: MoveType,
  options: { movement?: number; zoc?: boolean; skirmisher?: boolean } = {},
): UnitType {
  const abilities: { tag: string; config: WmlConfig }[] = [];
  if (options.skirmisher) {
    const a = new WmlConfig();
    a.setAttribute('id', 'skirmisher');
    abilities.push({ tag: 'skirmisher', config: a });
  }
  return new UnitType(
    id,
    id,
    '',
    'neutral',
    1,
    30,
    options.movement ?? 3,
    options.movement ?? 3,
    0,
    1,
    0,
    -1,
    500,
    [],
    '',
    options.zoc ?? false,
    false,
    false,
    moveType,
    [],
    abilities,
  );
}

describe('reachableHexes (synthetic uniform-cost grid)', () => {
  const terrainData = new TerrainTypeData();
  // Unregistered "Gg" resolves via TerrainType.fromDefault, whose `id`
  // equals the terrain code's string form -- so a movement_costs table
  // keyed by "Gg" applies uniformly across this synthetic all-grass board.
  const flatMoveType = buildMoveType({ Gg: 1 }, terrainData);

  function makeBoard(): GameBoard {
    const map = buildFlatMap(9, terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));
    board.addTeam(new Team(2));
    return board;
  }

  it('reaches every hex within movement budget on an open uniform-cost grid, including the origin', () => {
    const board = makeBoard();
    const type = makeUnitType('walker', flatMoveType, { movement: 2 });
    const origin = new Location(4, 4);
    const unit = Unit.create(type, 1, origin);
    unit.movesLeft = 2;

    const { destinations } = reachableHexes(board, unit, { ignoreUnits: true });

    // Origin itself must be included, with full remaining movement.
    const originStep = destinations.find(origin);
    expect(originStep).toBeDefined();
    expect(originStep!.moveLeft).toBe(2);
    expect(originStep!.prev).toBeNull();

    // Every hex within hex-distance <= 2 (cost is uniformly 1/hex here) should be reachable.
    for (let x = 0; x < 9; x++) {
      for (let y = 0; y < 9; y++) {
        const loc = new Location(x, y);
        const dist = distanceBetween(origin, loc);
        if (dist <= 2) {
          expect(destinations.contains(loc)).toBe(true);
        } else {
          expect(destinations.contains(loc)).toBe(false);
        }
      }
    }
  });

  it('getPath returns the route from origin (included) to the step (excluded)', () => {
    const board = makeBoard();
    const type = makeUnitType('walker', flatMoveType, { movement: 3 });
    const origin = new Location(4, 4);
    const unit = Unit.create(type, 1, origin);
    unit.movesLeft = 3;

    const { destinations } = reachableHexes(board, unit, { ignoreUnits: true });
    const target = new Location(4, 2); // straight north, 2 hexes away
    const step = destinations.find(target)!;
    expect(step).toBeDefined();

    const path = destinations.getPath(step);
    // Excludes the destination itself; includes the origin.
    expect(path.some((l) => l.equals(target))).toBe(false);
    expect(path[0]!.equals(origin)).toBe(true);
  });

  it('blocks movement onto an enemy-occupied hex', () => {
    const board = makeBoard();
    const moverType = makeUnitType('mover', flatMoveType, { movement: 3 });
    const enemyType = makeUnitType('enemy', flatMoveType, { movement: 3, zoc: false });
    const origin = new Location(4, 4);
    const enemyLoc = new Location(5, 4); // SE of origin (x=4 is even: SE = (5,4))
    const mover = Unit.create(moverType, 1, origin);
    mover.movesLeft = 3;
    board.addUnit(mover);
    const enemy = Unit.create(enemyType, 2, enemyLoc);
    board.addUnit(enemy);

    const { destinations } = reachableHexes(board, mover);
    expect(destinations.contains(enemyLoc)).toBe(false);
  });

  it('zone of control costs all remaining movement to enter, and is bypassed by skirmisher', () => {
    const board = makeBoard();
    const origin = new Location(3, 3);
    // x=3 is odd: NE = (4,3). Place a ZoC-emitting enemy there.
    const enemyLoc = new Location(4, 3);
    const zocMoveType = flatMoveType;

    const moverType = makeUnitType('mover', zocMoveType, { movement: 3 });
    const enemyType = makeUnitType('enemy', zocMoveType, { movement: 3, zoc: true });

    const mover = Unit.create(moverType, 1, origin);
    mover.movesLeft = 3;
    board.addUnit(mover);
    const enemy = Unit.create(enemyType, 2, enemyLoc);
    board.addUnit(enemy);

    // x=4 is even: NW of the enemy is (3,3-1)=(3,2) -- the mover's own N
    // neighbor, and it is inside the enemy's zone of control.
    const zocHex = new Location(3, 2);

    const { destinations } = reachableHexes(board, mover);
    const step = destinations.find(zocHex);
    expect(step).toBeDefined();
    // Entering a ZoC hex costs ALL remaining movement (not just its terrain cost of 1).
    expect(step!.moveLeft).toBe(0);

    // A skirmisher ignores zones of control entirely.
    const skirmisherType = makeUnitType('skirmisher-mover', zocMoveType, { movement: 3, skirmisher: true });
    const board2 = makeBoard();
    const skirmisherUnit = Unit.create(skirmisherType, 1, origin);
    skirmisherUnit.movesLeft = 3;
    board2.addUnit(skirmisherUnit);
    board2.addUnit(Unit.create(enemyType, 2, enemyLoc));
    const result2 = reachableHexes(board2, skirmisherUnit);
    const step2 = result2.destinations.find(zocHex);
    expect(step2).toBeDefined();
    expect(step2!.moveLeft).toBe(2); // normal terrain cost only (3 - 1)

    // forceIgnoreZoc has the same bypass effect for a non-skirmisher.
    const result3 = reachableHexes(board, mover, { forceIgnoreZoc: true });
    const step3 = result3.destinations.find(zocHex);
    expect(step3!.moveLeft).toBe(2);

    // ignoreUnits bypasses both enemy-blocking AND zones of control, so the
    // enemy's own hex becomes enterable too.
    const result4 = reachableHexes(board, mover, { ignoreUnits: true });
    expect(result4.destinations.contains(enemyLoc)).toBe(true);
  });

  it('additionalTurns lets the flood fill spill over into a future turn', () => {
    const board = makeBoard();
    const type = makeUnitType('walker', flatMoveType, { movement: 3 });
    const origin = new Location(4, 4);
    const unit = Unit.create(type, 1, origin);
    unit.movesLeft = 1; // just enough to reach one hex this turn

    const target = new Location(4, 2); // 2 hexes north, costs 2 total

    const thisTurnOnly = reachableHexes(board, unit, { ignoreUnits: true });
    expect(thisTurnOnly.destinations.contains(target)).toBe(false);

    const withSpillover = reachableHexes(board, unit, { ignoreUnits: true, additionalTurns: 1 });
    const step = withSpillover.destinations.find(target);
    expect(step).toBeDefined();
    // 1 movement spent this turn to reach the first hex, then next turn's
    // full 3 movement minus the 1 spent on the second hex = 2 left.
    expect(step!.moveLeft).toBe(2);
  });
});

describe('findPath (synthetic uniform-cost grid, two-hex A*)', () => {
  const terrainData = new TerrainTypeData();
  const flatMoveType = buildMoveType({ Gg: 1 }, terrainData);

  it('finds a direct route on an open board and reports no path onto an enemy hex', () => {
    const map = buildFlatMap(9, terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));
    board.addTeam(new Team(2));

    const moverType = makeUnitType('mover', flatMoveType, { movement: 5 });
    const origin = new Location(1, 1);
    const mover = Unit.create(moverType, 1, origin);
    mover.movesLeft = 5;
    board.addUnit(mover);

    const dst = new Location(4, 1);
    const route = findPath(board, mover, dst);
    expect(route.moveCost).toBeLessThan(NO_PATH_VALUE);
    expect(route.steps[0]!.equals(origin)).toBe(true);
    expect(route.steps.at(-1)!.equals(dst)).toBe(true);

    // Occupy the destination with an enemy: no route should land there.
    const enemyType = makeUnitType('enemy', flatMoveType, { movement: 5 });
    board.addUnit(Unit.create(enemyType, 2, dst));
    const blocked = findPath(board, mover, dst);
    expect(blocked.moveCost).toBe(NO_PATH_VALUE);
  });
});

describe('findVacantTile (real, reported bug: [move_unit] silently no-op, needed "land on nearest empty hex" fallback)', () => {
  const terrainData = new TerrainTypeData();
  const flatMoveType = buildMoveType({ Gg: 1 }, terrainData);

  function makeBoard(): GameBoard {
    const map = buildFlatMap(9, terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));
    return board;
  }

  it('returns the target hex itself when it is already vacant', () => {
    const board = makeBoard();
    const target = new Location(4, 4);
    expect(findVacantTile(board, target)?.equals(target)).toBe(true);
  });

  it('returns the nearest vacant neighbour when the target hex is occupied', () => {
    const board = makeBoard();
    const target = new Location(4, 4);
    const occupant = Unit.create(makeUnitType('occupant', flatMoveType), 1, target);
    board.addUnit(occupant);

    const found = findVacantTile(board, target);
    expect(found).toBeDefined();
    expect(found!.equals(target)).toBe(false);
    expect(board.hasUnitAt(found!)).toBe(false);
    expect(distanceBetween(target, found!)).toBe(1); // the ring immediately around the target is fully vacant here.
  });

  it('keeps expanding outward past the first ring if that ring is also fully occupied', () => {
    const board = makeBoard();
    const target = new Location(4, 4);
    // Fill the target and its whole first ring, leaving only the second ring vacant.
    const filled = [target, ...getAdjacentTiles(target)];
    for (const loc of filled) board.addUnit(Unit.create(makeUnitType(`u-${loc.key()}`, flatMoveType), 1, loc));

    const found = findVacantTile(board, target);
    expect(found).toBeDefined();
    expect(filled.some((f) => f.equals(found!))).toBe(false);
    expect(board.hasUnitAt(found!)).toBe(false);
  });

  it('returns undefined for an off-board location', () => {
    const board = makeBoard();
    expect(findVacantTile(board, new Location(-50, -50))).toBeUndefined();
  });

  it('with castleOnly, skips non-castle hexes even if vacant', () => {
    const board = makeBoard();
    const target = new Location(4, 4); // plain grass, not a castle, on this synthetic map
    expect(board.map.isCastle(target)).toBe(false);
    // No castle tiles exist on this map at all, so the search should exhaust and find nothing.
    expect(findVacantTile(board, target, { castleOnly: true })).toBeUndefined();
  });
});
