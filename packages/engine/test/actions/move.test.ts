import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
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
