/**
 * Real core content for tests that need actual unit types (with their real
 * abilities) on a real terrain database: data/core/terrain.cfg and
 * data/core/units.cfg, parsed once per test file and cached.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { UnitType } from '../../src/model/UnitType.js';
import {
  collectMovementTypeConfigs,
  collectSpecialRegistry,
  collectUnitTypeConfigs,
  flattenAllUnitTypes,
} from '../../src/model/UnitTypeDatabase.js';
import { GameMap } from '../../src/model/Map.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const dataRoot = path.join(repoRoot, 'wesnoth/data');

export interface RealContent {
  terrainData: TerrainTypeData;
  unitType(id: string): UnitType;
  /** A map from rows of terrain codes (no border given: one is added, of the first code). */
  map(rows: readonly string[]): GameMap;
}

let cached: RealContent | null = null;

export function loadRealContent(): RealContent {
  if (cached) return cached;
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(defines) });
  const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));
  const unitsCfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(defines) });
  const flattened = flattenAllUnitTypes(collectUnitTypeConfigs(unitsCfg));
  const moveTypes = collectMovementTypeConfigs(unitsCfg);
  const registries = {
    weaponSpecials: collectSpecialRegistry(unitsCfg, 'weapon_specials'),
    abilities: collectSpecialRegistry(unitsCfg, 'abilities'),
  };
  const types = new Map<string, UnitType>();
  cached = {
    terrainData,
    unitType(id: string): UnitType {
      let type = types.get(id);
      if (!type) {
        const cfg = flattened.get(id);
        if (!cfg) throw new Error(`no [unit_type] ${id}`);
        type = UnitType.fromConfig(cfg, moveTypes, terrainData, registries);
        types.set(id, type);
      }
      return type;
    },
    map(rows: readonly string[]): GameMap {
      // Surround with a one-hex border so logical (0,0) is the first given code.
      const width = rows[0]!.split(',').length;
      const pad = rows[0]!.split(',')[0]!.trim();
      const border = Array(width + 2).fill(pad).join(', ');
      const body = rows.map((r) => `${pad}, ${r}, ${pad}`);
      return GameMap.fromMapString([border, ...body, border].join('\n'), terrainData);
    },
  };
  return cached;
}
