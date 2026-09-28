import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWmlFile,
  preprocess,
  preloadDefines,
  preloadDefinesFromDir,
  parseConfig,
  type DefineMap,
} from '@wesnothweb2/engine/src/wml/index.js';
import { GameMap } from '@wesnothweb2/engine/src/model/Map.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import { TerrainTypeData, parseTerrainCode, type TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import { parseTerrainGraphicsRules, type BuildingRule } from '../../src/terrain/terrainGraphicsRules.js';
import { buildTerrainTiles, getTerrainFramesAt, type TerrainMapQuery } from '../../src/terrain/terrainBuilder.js';

/**
 * End-to-end sanity + performance check against the actual scenario this
 * whole project targets (`docs/IMPLEMENTATION_PLAN.md`'s Phase 4 milestone):
 * real terrain-graphics rules matched against Dead_Water's real scenario-1
 * map. Not a pixel-fidelity assertion (no oracle to compare against here) --
 * just "does this run in reasonable time and produce plausible, non-empty
 * output for a real, full-sized map", the same bar `gameBoardIntegration.test.ts`
 * sets for the map/unit data model.
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

function loadRules(defines: DefineMap): BuildingRule[] {
  const coreDir = path.join(dataRoot, 'core');
  const defsPass = preprocess('{core/terrain-graphics/}', {
    currentFile: path.join(coreDir, 'synthetic.cfg'),
    dir: coreDir,
    dataRoot,
    defines: new Map(defines),
  });
  const invocationsPass = preprocess('{core/terrain-graphics.cfg}', {
    currentFile: path.join(coreDir, 'synthetic.cfg'),
    dir: coreDir,
    dataRoot,
    defines: defsPass.defines,
  });
  const root = parseConfig(defsPass.text + invocationsPass.text);
  const imageExists = (p: string) => fs.existsSync(path.join(dataRoot, 'core/images', p));
  return parseTerrainGraphicsRules(root, { imageExists, includeOffMapRule: true });
}

describe('terrainBuilder against the real Dead_Water scenario-1 map', () => {
  it('builds and resolves every hex in well under a second, with plausible output', () => {
    const defines = loadDefines();
    const rules = loadRules(defines);
    expect(rules.length).toBeGreaterThan(3000);

    const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(defines) });
    const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));

    const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), {
      dataRoot,
      defines: new Map(defines),
    });
    const scenario = scenarioCfg.child('scenario')!;
    const mapText = fs.readFileSync(path.join(campaignDir, 'maps', scenario.getString('map_file')), 'utf8');
    scenario.setAttribute('map_data', mapText);
    const map = GameMap.fromConfig(scenario, terrainData);

    const query: TerrainMapQuery = {
      width: map.w(),
      height: map.h(),
      terrainAt: (x, y) => map.getTerrain(new Location(x, y)),
      onBoard: (x, y) => map.onBoard(new Location(x, y)),
    };

    const offMapCode: TerrainCode = parseTerrainCode('_off^_usr');

    const t0 = Date.now();
    const tiles = buildTerrainTiles(rules, query, { offMapCode });
    const buildMs = Date.now() - t0;

    let resolved = 0;
    let withBackground = 0;
    const t1 = Date.now();
    for (let x = 0; x < map.w(); x++) {
      for (let y = 0; y < map.h(); y++) {
        const layers = getTerrainFramesAt(tiles, x, y, '');
        resolved++;
        if (layers.background.length > 0) withBackground++;
      }
    }
    const resolveMs = Date.now() - t1;

    // eslint-disable-next-line no-console
    console.log(`Dead Water scenario 1: build=${buildMs}ms resolve(${resolved} hexes)=${resolveMs}ms, ${withBackground}/${resolved} hexes got >=1 background layer`);

    expect(resolved).toBe(map.w() * map.h());
    expect(withBackground).toBe(resolved); // every real playable hex should get at least a base tile
    expect(buildMs).toBeLessThan(20_000);
  }, 30_000);
});
