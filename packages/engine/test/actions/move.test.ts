import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location, getAdjacentTiles } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { findPath, NO_PATH_VALUE } from '../../src/pathfind/pathfind.js';
import { executeMove, planTurnMovement } from '../../src/actions/move.js';

/** Same real-content pattern as test/pathfind/pathfindRealMap.test.ts. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadTerrainData(): TerrainTypeData {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines });
  return TerrainTypeData.fromConfigs(cfg.children('terrain_type'));
}

function loadRealMoveType(id: string, terrainData: TerrainTypeData): MoveType {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines });
  function walk({ tag, config }: { tag: string; config: WmlConfig }): WmlConfig[] {
    if (tag === 'movetype' && config.getString('name') === id) return [config];
    return config.allChildren().flatMap(walk);
  }
  const found = cfg.allChildren().flatMap(walk);
  if (!found[0]) throw new Error(`movetype ${id} not found`);
  return MoveType.fromConfig(found[0], terrainData);
}

function makeUnitType(id: string, moveType: MoveType, movement: number): UnitType {
  return new UnitType(id, id, '', 'neutral', 1, 30, movement, movement, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, [AttackType.fromConfig(new WmlConfig())], []);
}

describe('executeMove (real Home_1.map content)', () => {
  const terrainData = loadTerrainData();
  const smallfoot = loadRealMoveType('smallfoot', terrainData);
  const landType = makeUnitType('land-walker', smallfoot, 6);

  function loadHome1Board(): GameBoard {
    const mapText = fs.readFileSync(path.join(dataRoot, 'campaigns/Dead_Water/maps/Home_1.map'), 'utf8');
    const map = GameMap.fromMapString(mapText, terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));
    return board;
  }

  it('moves a unit along a real pathfound route and decrements movesLeft by the real terrain cost', () => {
    const board = loadHome1Board();
    const start = Location.fromWml(6, 1); // "Ds", sand -- same known-good origin as pathfindRealMap.test.ts
    const unit = Unit.create(landType, 1, start);
    unit.movesLeft = 6;
    unit.maxMoves = 6;
    board.addUnit(unit);

    const dest = Location.fromWml(8, 1);
    const route = findPath(board, unit, dest, { ignoreUnit: true });
    expect(route.moveCost).toBeLessThan(NO_PATH_VALUE);

    const moveResult = executeMove(board, unit, route.steps);

    expect(board.unitAt(start)).toBeUndefined();
    const finalLoc = route.steps[route.steps.length - 1]!;
    expect(board.unitAt(finalLoc)).toBe(unit);
    expect(unit.location.equals(finalLoc)).toBe(true);
    expect(unit.movesLeft).toBe(6 - route.moveCost);
    expect(unit.movesLeft).toBeGreaterThanOrEqual(0);
    expect(moveResult.path[0]!.equals(start)).toBe(true);
    expect(unit.hasStatus('not_moved')).toBe(false);
  });

  it('stops early exactly when movement points run out, never going negative', () => {
    const board = loadHome1Board();
    const start = Location.fromWml(6, 1);
    const unit = Unit.create(landType, 1, start);
    unit.movesLeft = 1; // deliberately tiny relative to smallfoot's real per-hex costs
    unit.maxMoves = 6;
    board.addUnit(unit);

    const dest = Location.fromWml(16, 1); // the same real multi-hex route pathfindRealMap.test.ts verifies
    const route = findPath(board, unit, dest, { ignoreUnit: true });
    expect(route.moveCost).toBeLessThan(NO_PATH_VALUE);
    expect(route.moveCost).toBeGreaterThan(unit.movesLeft); // route must be longer than what 1 move point covers, or this test proves nothing

    // Check the plan (pre-move state) before executeMove mutates unit.location.
    const planned = planTurnMovement(board, unit, route.steps);
    for (const remaining of planned.movesLeftAfter) {
      expect(remaining).toBeGreaterThanOrEqual(0);
    }

    const moveResult = executeMove(board, unit, route.steps);
    expect(moveResult.stoppedEarly).toBe(true);
    expect(unit.movesLeft).toBeGreaterThanOrEqual(0);
  });

  it("throws if the path doesn't start at the unit's current location", () => {
    const board = loadHome1Board();
    const unit = Unit.create(landType, 1, Location.fromWml(6, 1));
    board.addUnit(unit);
    expect(() => executeMove(board, unit, [Location.fromWml(5, 5), Location.fromWml(6, 5)])).toThrow();
  });
});

describe('executeMove / planTurnMovement zone-of-control regression (real, reported bug)', () => {
  /**
   * Regression tests for a real bug: `planTurnMovement` only checked
   * whether the *previously entered* hex was a ZoC hex before refusing a
   * *further* hop (and even then only from the second hop onward, via a
   * stray `i > 1` guard) -- it never inflated the *cost* of entering a
   * ZoC hex itself to "all remaining movement" the way `findPath`'s
   * `ShortestPathCalculator` already correctly does. In practice this let
   * a player hop from one hex adjacent to a non-skirmisher enemy directly
   * to an *adjacent* hex that's also adjacent to that same enemy (two
   * "ring" hexes around it, which are themselves neighbors) paying only
   * the raw terrain cost each time -- repeatable all the way around,
   * fully circling a stationary enemy while barely spending any movement.
   * User-reported; see docs/PROGRESS.md. `reachableHexesSynthetic.test.ts`
   * already covers `reachableHexes`' (correct) ZoC math -- this covers
   * `executeMove`'s separate, previously-buggy accounting.
   */
  const terrainData = new TerrainTypeData();
  const flatMoveType = (() => {
    const cfg = new WmlConfig();
    const costs = new WmlConfig();
    costs.setAttribute('Gg', 1);
    cfg.addChild('movement_costs', costs);
    return MoveType.fromConfig(cfg, terrainData);
  })();
  const moverType = makeUnitType('mover', flatMoveType, 5);
  const zocEnemyType = new UnitType('zoc-enemy', 'zoc-enemy', '', 'neutral', 1, 30, 5, 5, 0, 1, 0, -1, 500, [], '', true, false, false, flatMoveType, [AttackType.fromConfig(new WmlConfig())], []); // zoc=true

  function makeRingBoard(): { board: GameBoard; enemyLoc: Location } {
    const row = Array.from({ length: 9 }, () => 'Gg').join(',');
    const mapText = Array.from({ length: 9 }, () => row).join('\n');
    const board = new GameBoard(GameMap.fromMapString(mapText, terrainData, 1));
    board.addTeam(new Team(1));
    board.addTeam(new Team(2));
    const enemyLoc = new Location(4, 4);
    board.addUnit(Unit.create(zocEnemyType, 2, enemyLoc));
    return { board, enemyLoc };
  }

  it('a single hop directly into a ZoC hex consumes ALL remaining movement, not just its terrain cost', () => {
    const { board } = makeRingBoard();
    const start = Location.fromWml(1, 4); // west edge, not adjacent to the enemy.
    const mover = Unit.create(moverType, 1, start);
    mover.movesLeft = 5;
    mover.maxMoves = 5;
    board.addUnit(mover);

    const zocHex = new Location(3, 4); // adjacent to enemy at (4,4).
    const route = findPath(board, mover, zocHex, { seeAll: true });
    executeMove(board, mover, route.steps, { seeAll: true });

    expect(mover.location.equals(zocHex)).toBe(true);
    expect(mover.movesLeft).toBe(0); // NOT "5 - 1 real terrain cost" -- all of it.
  });

  it("hopping between two ring hexes that are BOTH adjacent to the same enemy (and to each other) costs everything on the first hop, blocking the 'circle around' exploit", () => {
    const { board, enemyLoc } = makeRingBoard();
    const ring = getAdjacentTiles(enemyLoc);
    const start = ring[0]!;
    const nextRingHex = ring[1]!; // adjacent to `start` AND to the enemy -- the exact reported repro shape.
    expect(getAdjacentTiles(start).some((h) => h.equals(nextRingHex))).toBe(true); // sanity: really are neighbors.

    const mover = Unit.create(moverType, 1, start);
    mover.movesLeft = 5;
    mover.maxMoves = 5;
    board.addUnit(mover);

    const route = findPath(board, mover, nextRingHex, { seeAll: true });
    executeMove(board, mover, route.steps, { seeAll: true });
    expect(mover.location.equals(nextRingHex)).toBe(true);
    expect(mover.movesLeft).toBe(0);

    // The actual reported symptom: attempting a THIRD ring hex (continuing
    // to "circle") must not move the unit at all -- it has 0 movement left.
    const thirdRingHex = ring[2]!;
    const route2 = findPath(board, mover, thirdRingHex, { seeAll: true });
    const result2 = executeMove(board, mover, route2.steps, { seeAll: true });
    expect(mover.location.equals(nextRingHex)).toBe(true); // unchanged
    expect(result2.stoppedEarly).toBe(true);
  });

  it('a skirmisher ignores zones of control entirely and can freely hop around the ring', () => {
    const { board, enemyLoc } = makeRingBoard();
    const skirmisherAbility = new WmlConfig();
    skirmisherAbility.setAttribute('id', 'skirmisher');
    const skirmisherType = new UnitType('skirmisher', 'skirmisher', '', 'neutral', 1, 30, 5, 5, 0, 1, 0, -1, 500, [], '', false, false, false, flatMoveType, [AttackType.fromConfig(new WmlConfig())], [skirmisherAbility]);

    const ring = getAdjacentTiles(enemyLoc);
    const start = ring[0]!;
    const nextRingHex = ring[1]!;
    const mover = Unit.create(skirmisherType, 1, start);
    mover.movesLeft = 5;
    mover.maxMoves = 5;
    board.addUnit(mover);

    const route = findPath(board, mover, nextRingHex, { seeAll: true });
    executeMove(board, mover, route.steps, { seeAll: true });
    expect(mover.location.equals(nextRingHex)).toBe(true);
    expect(mover.movesLeft).toBe(4); // real terrain cost only (5 - 1), no ZoC penalty.
  });
});
