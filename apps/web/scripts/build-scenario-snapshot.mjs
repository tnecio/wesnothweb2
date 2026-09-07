#!/usr/bin/env node
/**
 * Builds a static JSON snapshot of Dead_Water scenario 1 (this project's
 * Phase 4/5 milestone target, see docs/IMPLEMENTATION_PLAN.md) using the
 * REAL WML pipeline and data model from packages/engine -- real macro
 * preprocessing, real parsing, real GameBoard wiring, all against the
 * actual wesnoth submodule content. Nothing here is placeholder/fake data.
 *
 * Why a build-time snapshot instead of the browser loading WML live: the
 * WML pipeline's PreprocessorHost (packages/engine/src/wml/preprocessor.ts)
 * is synchronous (readFile/readDir/stat), matching Node's fs API, so it can
 * run directly against the browser's game data by making a fetch-backed
 * host. Building a synchronous-looking API over an inherently async
 * fetch() is a real piece of work (a prefetch-everything-then-run-sync
 * approach, or reworking the pipeline to be async throughout) that hasn't
 * been done yet -- this script is the deliberate, documented bridge so the
 * *rendering* pipeline (packages/renderer, real image assets) can be
 * proven end-to-end in a browser today without waiting on that. Revisit
 * once a real in-browser scenario loader is built (Phase 4/5 work); this
 * script and the snapshot it produces should be deleted at that point, not
 * extended.
 *
 * Run with: npx tsx apps/web/scripts/build-scenario-snapshot.mjs
 * (imports packages/engine's .ts sources directly; needs tsx, not plain node)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const campaignDir = path.join(dataRoot, 'campaigns/Dead_Water');
const outFile = path.join(repoRoot, 'apps/web/public/scenario-snapshot.json');

const { parseWmlFile, preloadDefines, preloadDefinesFromDir } = await import(
  path.join(repoRoot, 'packages/engine/src/wml/index.ts')
);
const { WmlConfig } = await import(path.join(repoRoot, 'packages/engine/src/wml/config.ts'));
const { TerrainTypeData } = await import(path.join(repoRoot, 'packages/engine/src/model/Terrain.ts'));
const { GameBoard } = await import(path.join(repoRoot, 'packages/engine/src/model/GameBoard.ts'));
const { GameMap } = await import(path.join(repoRoot, 'packages/engine/src/model/Map.ts'));
const { UnitType, AttackType } = await import(path.join(repoRoot, 'packages/engine/src/model/UnitType.ts'));
const { MoveType } = await import(path.join(repoRoot, 'packages/engine/src/model/MoveType.ts'));

function loadDefines() {
  const defines = new Map();
  const flag = (name) =>
    defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<snapshot-script>' });
  flag('CAMPAIGN_DEAD_WATER');
  flag('NORMAL');
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot });
  return defines;
}

/** Walks a parsed tree collecting every [unit_type] (including [male]/[female] variant children) id -> top-level image path. */
function collectUnitTypeImages(cfg, out) {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'unit_type') {
      const id = config.getString('id');
      const image = config.getString('image');
      if (id && image && !out.has(id)) out.set(id, image);
      collectUnitTypeImages(config, out); // [male]/[female] sub-variants
    } else {
      collectUnitTypeImages(config, out);
    }
  }
}

const defines = loadDefines();

const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(defines) });
const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));

console.log('Parsing data/core/units.cfg for real unit-type image paths (this takes a few seconds)...');
const coreUnitsCfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(defines) });
const unitImages = new Map();
collectUnitTypeImages(coreUnitsCfg, unitImages);

const campaignMainCfg = parseWmlFile(path.join(campaignDir, '_main.cfg'), { dataRoot, defines: new Map(defines) });
collectUnitTypeImages(campaignMainCfg, unitImages);
console.log(`Collected ${unitImages.size} unit-type image paths from real WML.`);

// Stub UnitType resolver -- see GameBoard's own test for why full unit-type
// database loading (base_unit/gender-variation inheritance flattening) is
// out of scope for now. GameBoard wiring itself (map + sides + units) is
// real; only the per-type combat stats are placeholders here.
const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
const attack = AttackType.fromConfig(new WmlConfig());
const typeCache = new Map();
function resolveType(id) {
  let t = typeCache.get(id);
  if (!t) {
    t = new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 0, -1, 500, [], '', true, false, false, moveType, [attack], []);
    typeCache.set(id, t);
  }
  return t;
}

const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), { dataRoot, defines: new Map(defines) });
const scenario = scenarioCfg.child('scenario');
const mapText = fs.readFileSync(path.join(campaignDir, 'maps', scenario.getString('map_file')), 'utf8');
scenario.setAttribute('map_data', mapText);

const board = GameBoard.fromConfig(scenario, terrainData, resolveType);

const { Location } = await import(path.join(repoRoot, 'packages/engine/src/model/Location.ts'));
const { writeTerrainCode } = await import(path.join(repoRoot, 'packages/engine/src/model/Terrain.ts'));

const terrain = [];
for (let x = 0; x < board.map.w(); x++) {
  for (let y = 0; y < board.map.h(); y++) {
    const code = board.map.getTerrain(new Location(x, y));
    terrain.push({ x, y, code: writeTerrainCode(code) });
  }
}

const units = board.allUnits().map((u) => ({
  id: u.id || null,
  name: u.name || null,
  typeId: u.type.id,
  image: unitImages.get(u.type.id) ?? null,
  side: u.side,
  x: u.location.x,
  y: u.location.y,
  canRecruit: u.canRecruit,
  hitpoints: u.hitpoints,
  maxHitpoints: u.maxHitpoints,
}));

const teams = board.teams().map((t) => ({
  side: t.side,
  controller: t.controller,
  gold: t.gold,
  teamName: t.teamName,
  color: t.color,
}));

const snapshot = {
  generatedBy: 'apps/web/scripts/build-scenario-snapshot.mjs (see file header)',
  scenario: { id: scenario.getString('id'), name: scenario.getString('name') },
  map: {
    width: board.map.w(),
    height: board.map.h(),
    totalWidth: board.map.totalWidth(),
    totalHeight: board.map.totalHeight(),
    border: GameMap.DEFAULT_BORDER,
  },
  terrain,
  teams,
  units,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(snapshot));
console.log(`Wrote ${outFile} (${units.length} units, ${terrain.length} hexes, ${teams.length} sides).`);
