import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWmlFile,
  preloadDefines,
  preloadDefinesFromDir,
  type DefineMap,
} from '@wesnothweb2/engine/src/wml/index.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { TerrainTypeData } from '@wesnothweb2/engine/src/model/Terrain.js';
import { GameBoard } from '@wesnothweb2/engine/src/model/GameBoard.js';
import { UnitType, AttackType } from '@wesnothweb2/engine/src/model/UnitType.js';
import { MoveType } from '@wesnothweb2/engine/src/model/MoveType.js';
import { newLuaState, doString, doStringArray } from '../src/luaEnv.js';
import { BOOTSTRAP_LUA_SOURCE } from '../src/bridges/bootstrap.js';
import { installUnitsBridge } from '../src/bridges/units.js';

/**
 * Task 2b: `wesnoth.units.get(x, y)` bridged to a real `GameBoard`. Reuses
 * this project's established real-content loading pattern (see
 * packages/engine/test/model/gameBoardIntegration.test.ts, which this test
 * mirrors closely) to load Dead_Water scenario 1's actual map/side/unit
 * data, then reads/writes real unit fields through Fengari.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const campaignDir = path.join(dataRoot, 'campaigns/Dead_Water');

function loadDefines(): DefineMap {
  const defines: DefineMap = new Map();
  const flag = (name: string) =>
    defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<test>' });
  flag('CAMPAIGN_DEAD_WATER');
  flag('NORMAL');
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot });
  return defines;
}

function loadTerrainData(defines: DefineMap): TerrainTypeData {
  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), {
    dataRoot,
    defines: new Map(defines),
  });
  return TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));
}

// Same permissive stub as gameBoardIntegration.test.ts -- the real
// data/core/units/ database needs [base_unit]/gender-variation flattening
// that's out of scope here too (see that test's own module doc comment);
// this bridge only needs SOME real Unit instances on a real GameBoard, not
// the real unit-type database specifically.
function makeStubResolveType(terrainData: TerrainTypeData): (id: string) => UnitType {
  const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
  const attack = AttackType.fromConfig(new WmlConfig());
  const cache = new Map<string, UnitType>();
  return (id: string) => {
    let type = cache.get(id);
    if (!type) {
      type = new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 0, -1, 500, [], '', true, false, false, moveType, [attack], []);
      cache.set(id, type);
    }
    return type;
  };
}

function loadRealDeadWaterBoard(): GameBoard {
  const defines = loadDefines();
  const terrainData = loadTerrainData(defines);
  const resolveType = makeStubResolveType(terrainData);
  const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), {
    dataRoot,
    defines: new Map(defines),
  });
  const scenario = scenarioCfg.child('scenario')!;
  const mapText = fs.readFileSync(path.join(campaignDir, 'maps', scenario.getString('map_file')), 'utf8');
  scenario.setAttribute('map_data', mapText);
  return GameBoard.fromConfig(scenario, terrainData, resolveType);
}

describe('wesnoth.units.get <-> GameBoard bridge (real Dead_Water scenario 1 content)', () => {
  it('reads x/y/side/hitpoints/id off the real leader unit through Fengari', () => {
    const board = loadRealDeadWaterBoard();
    const leader = board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    expect(leader).toBeDefined();

    const L = newLuaState();
    doString(L, BOOTSTRAP_LUA_SOURCE, '=bootstrap');
    installUnitsBridge(L, board);

    const result = doStringArray(
      L,
      `
      local u = wesnoth.units.get(${leader.location.wmlX}, ${leader.location.wmlY})
      assert(u, "expected a unit at the leader's real location")
      return { u.id, u.side, u.x, u.y, u.hitpoints, u.max_hitpoints, u.valid }
      `,
      '=t1',
    );

    expect(result[0]).toBe('Kai Krellis');
    expect(result[1]).toBe(leader.side);
    expect(result[2]).toBe(leader.location.wmlX);
    expect(result[3]).toBe(leader.location.wmlY);
    expect(result[4]).toBe(leader.hitpoints);
    expect(result[5]).toBe(leader.maxHitpoints);
    expect(result[6]).toBe(true);
  });

  it('returns nil for an empty hex', () => {
    const board = loadRealDeadWaterBoard();
    // Hex (1,1) is a map corner far from any placed unit in this scenario.
    expect(board.unitAt).toBeDefined();
    const L = newLuaState();
    doString(L, BOOTSTRAP_LUA_SOURCE, '=bootstrap');
    installUnitsBridge(L, board);
    const result = doString(L, 'return wesnoth.units.get(1, 1) == nil', '=t2');
    expect(result).toBe(true);
  });

  it('writing unit.hitpoints from Lua mutates the real Unit object on the real GameBoard', () => {
    const board = loadRealDeadWaterBoard();
    const leader = board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const original = leader.hitpoints;

    const L = newLuaState();
    doString(L, BOOTSTRAP_LUA_SOURCE, '=bootstrap');
    installUnitsBridge(L, board);

    doString(
      L,
      `
      local u = wesnoth.units.get(${leader.location.wmlX}, ${leader.location.wmlY})
      u.hitpoints = u.hitpoints - 5
      `,
      '=t3',
    );

    expect(leader.hitpoints).toBe(original - 5);
  });
});
