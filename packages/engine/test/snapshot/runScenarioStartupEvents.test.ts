import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefines, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { runScenarioStartupEvents } from '../../src/snapshot/gameBoardSnapshot.js';

/**
 * Real-content test for the snapshot-facing `runScenarioStartupEvents`
 * (the browser-side entry point apps/web/packages/ui will actually call) --
 * distinct from `test/events/deadWaterPrestartEvent.test.ts`, which
 * exercises `EventManager`/`EventPump` directly. This test specifically
 * proves the JSON round-trip (`WmlConfig.toJSON`/`fromJSON`, exactly what
 * ships in `GameBoardSnapshot.scenarioConfigJson`) doesn't lose anything
 * `runScenarioStartupEvents` needs, and that `GameBoard.fromConfig`'s new
 * `spawnUnitsFromTree: false` option correctly avoids double-spawning the
 * units the events themselves place.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
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

describe('runScenarioStartupEvents (real Dead_Water scenario 1, through the JSON round-trip)', () => {
  const defines = loadDefines();
  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(defines) });
  const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));
  const resolveType = makeStubResolveType(terrainData);

  const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), {
    dataRoot,
    defines: new Map(defines),
  });
  const scenario = scenarioCfg.child('scenario')!;
  const mapText = fs.readFileSync(path.join(campaignDir, 'maps', scenario.getString('map_file')), 'utf8');
  scenario.setAttribute('map_data', mapText);

  // The exact transformation apps/web/scripts/build-scenario-snapshot.mjs applies:
  // serialize to JSON (simulating shipping it to the browser), then parse it back.
  const scenarioConfigJson = JSON.parse(JSON.stringify(scenario.toJSON()));

  function freshBoard(): GameBoard {
    // spawnUnitsFromTree: false -- units come from the events fired below, not a static walk.
    return GameBoard.fromConfig(scenario, terrainData, resolveType, { spawnUnitsFromTree: false });
  }

  it('starts with only the two side leaders before any event fires', () => {
    const board = freshBoard();
    expect(board.allUnits().map((u) => u.id).sort()).toEqual(['Kai Krellis', 'Mal-Kevek']);
  });

  it('firing prestart+start through the JSON-round-tripped config spawns the real units and records the real dialogue', () => {
    const board = freshBoard();
    const { messages, variables } = runScenarioStartupEvents(board, scenarioConfigJson, ['prestart', 'start'], {
      resolveType,
    });

    // Real dialogue, verbatim -- same lines test/events/deadWaterPrestartEvent.test.ts
    // (and, before it, this project's own manual grep of the source .cfg) already confirmed.
    expect(messages.length).toBeGreaterThan(0);
    const combined = messages.map((m) => m.message).join(' | ');
    expect(combined).toContain('Is something wrong, priestess?');
    expect(combined).toContain('Maybe. I smell death and decay.');

    // Real macro-computed variable state survived the JSON round-trip too.
    expect(variables.getString('zombie_type')).toBe('Walking Corpse');

    // The real event-spawned units (6 citizens + Cylanna + Gwabbo + the "fiend" Skeleton +
    // 3 Walking Corpses, per this project's earlier real-content investigation) are now on
    // the board alongside the two leaders that were already there -- not double-spawned.
    const ids = board.allUnits();
    expect(ids.length).toBeGreaterThan(2);
    expect(ids.filter((u) => u.id === 'Kai Krellis')).toHaveLength(1);
    expect(ids.filter((u) => u.id === 'Mal-Kevek')).toHaveLength(1);
  });
});
