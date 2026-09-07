import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData, parseTerrainCode } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType, UNREACHABLE } from '../../src/model/MoveType.js';
import { reachableHexes, findPath, NO_PATH_VALUE } from '../../src/pathfind/pathfind.js';

/**
 * Real-content integration test, following the pattern set by
 * test/model/gameBoardIntegration.test.ts: load actual data straight out of
 * the wesnoth submodule rather than only hand-built toy grids (the astar.
 * test.ts / reachableHexesSynthetic.test.ts files cover the algorithmic
 * edge cases in isolation; this file is the "does it work on the real
 * thing" check the project's testing standard calls for).
 *
 * Three real sources feed this test:
 *  - data/core/terrain.cfg -- the real terrain-type/alias database.
 *  - data/core/units.cfg's `[movetype]` blocks -- the real, shipped
 *    "smallfoot" (generic land infantry) and "swimmer" (merfolk/naga-style
 *    water dweller) movement-cost/defense tables, used as-is (not
 *    hand-invented numbers) to build synthetic-but-realistically-costed
 *    unit types.
 *  - wesnoth/data/campaigns/Dead_Water/maps/Home_1.map -- this project's own
 *    MVP scenario's actual map, per the task brief.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const mapPath = path.join(dataRoot, 'campaigns/Dead_Water/maps/Home_1.map');

/** Real terrain codes referenced by the assertions below, named for readability. */
const GameMapTestTerrain = {
  flat: parseTerrainCode('Gg'),
  mountains: parseTerrainCode('Mm'),
  deepWater: parseTerrainCode('Wo'),
  shallowWater: parseTerrainCode('Ww'),
  rawSandBeach: parseTerrainCode('Ds'),
  rawDeepWaterTropical: parseTerrainCode('Wot'),
  rawDryMountains: parseTerrainCode('Md'),
};

function loadDefines(): DefineMap {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  return defines;
}

function loadTerrainData(defines: DefineMap): TerrainTypeData {
  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), {
    dataRoot,
    defines: new Map(defines),
  });
  return TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));
}

/** Locates a real `[movetype]` block by its `name=` inside data/core/units.cfg. */
function loadMoveType(name: string, defines: DefineMap, terrainData: TerrainTypeData): MoveType {
  const unitsCfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), {
    dataRoot,
    defines: new Map(defines),
  });
  const race = unitsCfg.child('units');
  const searchRoot = race ?? unitsCfg;
  const found = searchRoot.children('movetype').find((c) => c.getString('name') === name);
  if (!found) throw new Error(`[movetype] name=${name} not found in units.cfg`);
  return MoveType.fromConfig(found, terrainData);
}

function makeUnitType(id: string, moveType: MoveType, movement: number): UnitType {
  return new UnitType(
    id,
    id,
    '',
    'neutral',
    1,
    30,
    movement,
    movement,
    0,
    1,
    0,
    -1,
    500,
    [],
    '',
    false,
    false,
    false,
    moveType,
    [AttackType.fromConfig(new WmlConfig())],
    [],
  );
}

describe('pathfind (real Home_1.map + real terrain/movetype content)', () => {
  const defines = loadDefines();
  const terrainData = loadTerrainData(defines);

  it('loads the real smallfoot and swimmer movetypes with the expected shipped costs', () => {
    const smallfoot = loadMoveType('smallfoot', defines, terrainData);
    const swimmer = loadMoveType('swimmer', defines, terrainData);

    // Real values straight from data/core/units.cfg -- confirms the
    // movement_costs table actually loaded, not just "didn't throw".
    expect(smallfoot.movementCost(GameMapTestTerrain.flat)).toBe(1);
    expect(smallfoot.movementCost(GameMapTestTerrain.mountains)).toBe(3);
    expect(smallfoot.movementCost(GameMapTestTerrain.mountains)).toBeGreaterThan(
      smallfoot.movementCost(GameMapTestTerrain.flat),
    );
    // smallfoot has no deep_water entry at all -- unreachable for a land unit.
    expect(smallfoot.movementCost(GameMapTestTerrain.deepWater)).toBe(UNREACHABLE);

    // swimmer crosses water cheaply...
    expect(swimmer.movementCost(GameMapTestTerrain.deepWater)).toBe(1);
    expect(swimmer.movementCost(GameMapTestTerrain.shallowWater)).toBe(1);
    // ...but has no mountains entry -- unreachable for a water dweller.
    expect(swimmer.movementCost(GameMapTestTerrain.mountains)).toBe(UNREACHABLE);
  });

  it('flood-fills reachable hexes on the real Home_1 map for a land unit, respecting real terrain costs', () => {
    const mapText = fs.readFileSync(mapPath, 'utf8');
    const map = GameMap.fromMapString(mapText, terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));

    const smallfoot = loadMoveType('smallfoot', defines, terrainData);
    const landType = makeUnitType('land-walker', smallfoot, 6);

    // wml (1,1) is "Wot" (deep water); wml (6,1) is "Ds" (sand_beach, aliases
    // to "sand", cost 2 for smallfoot) -- real, confirmed by reading the map
    // file directly (see module doc comment).
    const landOrigin = Location.fromWml(6, 1);
    expect(map.getTerrain(landOrigin).equals(GameMapTestTerrain.rawSandBeach)).toBe(true);

    const landUnit = Unit.create(landType, 1, landOrigin);
    landUnit.movesLeft = 6;
    board.addUnit(landUnit);

    const { destinations } = reachableHexes(board, landUnit, { ignoreUnits: true });

    // The origin is always reachable, with full remaining movement.
    const originStep = destinations.find(landOrigin);
    expect(originStep).toBeDefined();
    expect(originStep!.moveLeft).toBe(6);

    // No destination the land unit reached can be a hex whose real movement
    // cost is UNREACHABLE for it -- proves the flood fill actually consults
    // real per-hex terrain, not just graph distance.
    let checkedAtLeastOneWaterHex = false;
    for (const step of destinations.values()) {
      const terrain = map.getTerrain(step.curr);
      const cost = smallfoot.movementCost(terrain);
      expect(cost).toBeLessThan(UNREACHABLE);
    }

    // The specific real deep-water hexes at wml (1,1)/(2,1)/(3,1) must NOT
    // be reachable by the land unit, regardless of geometric distance.
    for (const wmlX of [1, 2, 3]) {
      const deepWaterHex = Location.fromWml(wmlX, 1);
      expect(map.getTerrain(deepWaterHex).equals(GameMapTestTerrain.rawDeepWaterTropical)).toBe(true);
      expect(destinations.contains(deepWaterHex)).toBe(false);
      checkedAtLeastOneWaterHex = true;
    }
    expect(checkedAtLeastOneWaterHex).toBe(true);

    // Sanity: it did reach *something* beyond the origin (not a degenerate empty flood fill).
    expect(destinations.size).toBeGreaterThan(1);
  });

  it('flood-fills reachable hexes on the real Home_1 map for a merfolk-style swimmer, crossing real water', () => {
    const mapText = fs.readFileSync(mapPath, 'utf8');
    const map = GameMap.fromMapString(mapText, terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));

    const swimmer = loadMoveType('swimmer', defines, terrainData);
    const swimmerType = makeUnitType('swimmer-unit', swimmer, 8);

    // wml (1,1) is real deep water ("Wot").
    const waterOrigin = Location.fromWml(1, 1);
    expect(map.getTerrain(waterOrigin).equals(GameMapTestTerrain.rawDeepWaterTropical)).toBe(true);

    const swimmerUnit = Unit.create(swimmerType, 1, waterOrigin);
    swimmerUnit.movesLeft = 8;
    board.addUnit(swimmerUnit);

    const { destinations } = reachableHexes(board, swimmerUnit, { ignoreUnits: true });

    // The swimmer must be able to reach further real water hexes nearby --
    // wml (1,2) and (2,1) are both real "Wot" (deep water, tropical) too.
    expect(destinations.contains(Location.fromWml(1, 2))).toBe(true);
    expect(destinations.contains(Location.fromWml(2, 1))).toBe(true);

    // And it must NOT be able to enter a real dry-mountain hex at all (no
    // mountains entry in the swimmer movetype) -- confirmed against wml
    // (17,1), which is real "Md" (dry mountains).
    const mountainHex = Location.fromWml(17, 1);
    expect(map.getTerrain(mountainHex).equals(GameMapTestTerrain.rawDryMountains)).toBe(true);
    expect(destinations.contains(mountainHex)).toBe(false);
  });

  it('finds an actual movement-cost-aware route across the real map via the two-hex A* pathfinder', () => {
    const mapText = fs.readFileSync(mapPath, 'utf8');
    const map = GameMap.fromMapString(mapText, terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));

    const smallfoot = loadMoveType('smallfoot', defines, terrainData);
    const landType = makeUnitType('land-walker', smallfoot, 6);
    const origin = Location.fromWml(6, 1); // "Ds", sand_beach
    const unit = Unit.create(landType, 1, origin);
    unit.movesLeft = 6;
    unit.maxMoves = 6;
    board.addUnit(unit);

    // wml (16,1) is "Hd" (desert hills) -- reachable in principle (mvt_alias
    // resolves through sand/hills, both present in the smallfoot table).
    const dst = Location.fromWml(16, 1);
    const route = findPath(board, unit, dst, { ignoreUnit: true });

    expect(route.moveCost).toBeLessThan(NO_PATH_VALUE);
    expect(route.steps[0]!.equals(origin)).toBe(true);
    expect(route.steps.at(-1)!.equals(dst)).toBe(true);

    // The reported move_cost should be at least the sum of the real terrain
    // costs along the route the search returned (it may exceed that sum
    // slightly due to the tiny defense tie-breaking subcost, but never be
    // less -- that would mean an under-counted route).
    let terrainCostSum = 0;
    for (let i = 1; i < route.steps.length; i++) {
      terrainCostSum += smallfoot.movementCost(map.getTerrain(route.steps[i]!));
    }
    expect(route.moveCost).toBeGreaterThanOrEqual(terrainCostSum);

    // Attempting to reach the real deep-water hex at wml (1,1) must fail:
    // it is genuinely impossible for this land unit, not just far away.
    const impossible = findPath(board, unit, Location.fromWml(1, 1), { ignoreUnit: true, stopAt: 100000 });
    expect(impossible.moveCost).toBe(NO_PATH_VALUE);
  });
});
