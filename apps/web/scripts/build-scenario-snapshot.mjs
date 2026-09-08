#!/usr/bin/env node
/**
 * Builds a static JSON snapshot of Dead_Water scenario 1 (this project's
 * Phase 4/5 milestone target, see docs/IMPLEMENTATION_PLAN.md) using the
 * REAL WML pipeline and data model from packages/engine -- real macro
 * preprocessing, real parsing, real GameBoard wiring, all against the
 * actual wesnoth submodule content. Nothing here is placeholder/fake data.
 *
 * Why a build-time snapshot instead of the browser loading WML live: the
 * WML preprocessor's file-access is synchronous (mirrors Node's fs), so it
 * can run directly against the browser's game data by making a fetch-backed
 * host. Building a synchronous-looking API over an inherently async
 * fetch() is a real piece of work (a prefetch-everything-then-run-sync
 * approach, or reworking the pipeline to be async throughout) that hasn't
 * been done yet -- this script is the deliberate, documented bridge so the
 * *rendering* pipeline (packages/renderer, real image assets) and, since
 * Phase 5, real client-side gameplay (packages/ui, via
 * packages/engine/src/snapshot/gameBoardSnapshot.ts's `gameBoardFromSnapshot`)
 * can be proven end-to-end in a browser today without waiting on that.
 * Revisit once a real in-browser scenario loader is built.
 *
 * Phase 5 additions to the snapshot format (see gameBoardSnapshot.ts's own
 * doc comment for the client-side reconstruction half of this):
 *  - `map.data`: the raw map text, so the browser can rebuild a real
 *    `GameMap` via `GameMap.fromMapString` without a WML config tree.
 *  - `unitTypes`: every unit type referenced by `units`, with its full stat
 *    set (hp/movement/attacks/etc.), so the browser can rebuild real
 *    `UnitType`/`Unit` instances instead of just drawing static sprites.
 *  - The stub `resolveType`'s move type now gets a real, flat per-terrain
 *    movement-cost (and defense) table via `buildFlatMoveType`, instead of
 *    an empty `[movement_costs]` config -- an empty table makes
 *    `MoveType.movementCost()` resolve to `UNREACHABLE` for every terrain
 *    (this project's own tests have hit that exact bug three times
 *    already, see docs/PROGRESS.md), which would make pathfinding/movement
 *    completely non-functional against these units. See
 *    gameBoardSnapshot.ts's doc comment for why a flat cost (not real
 *    per-terrain data) is the honest simplification here, and why the
 *    defense table also needs a non-degenerate flat value for combat
 *    prediction to look like combat prediction rather than a broken 99%
 *    hit-chance artifact.
 *  - The stub attack's damage/number-of-attacks are now non-zero (was
 *    `AttackType.fromConfig(new WmlConfig())`, i.e. 0 damage / 0 attacks --
 *    real but functionally inert combat). Still a stub (every unit type
 *    gets the identical generic weapon), but a non-zero one so
 *    `executeAttack` actually does something in the browser demo.
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
const { TerrainTypeData, writeTerrainCode } = await import(path.join(repoRoot, 'packages/engine/src/model/Terrain.ts'));
const { GameBoard } = await import(path.join(repoRoot, 'packages/engine/src/model/GameBoard.ts'));
const { GameMap } = await import(path.join(repoRoot, 'packages/engine/src/model/Map.ts'));
const { UnitType, AttackType } = await import(path.join(repoRoot, 'packages/engine/src/model/UnitType.ts'));
const { Location } = await import(path.join(repoRoot, 'packages/engine/src/model/Location.ts'));
const { buildFlatMoveType } = await import(
  path.join(repoRoot, 'packages/engine/src/snapshot/gameBoardSnapshot.ts')
);

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

const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), { dataRoot, defines: new Map(defines) });
const scenario = scenarioCfg.child('scenario');
const mapText = fs.readFileSync(path.join(campaignDir, 'maps', scenario.getString('map_file')), 'utf8');
scenario.setAttribute('map_data', mapText);

// Build the stub move type's per-terrain movement-cost/defense tables (see
// this file's own module doc comment, and gameBoardSnapshot.ts's, for why a
// flat value is the honest simplification here) from the terrain codes this
// specific map actually uses, using the real TerrainTypeData already loaded
// above for other reasons.
const mapForCosts = GameMap.fromMapString(mapText, terrainData);
const codesInUse = [];
{
  const seen = new Set();
  for (let x = 0; x < mapForCosts.w(); x++) {
    for (let y = 0; y < mapForCosts.h(); y++) {
      const code = mapForCosts.getTerrain(new Location(x, y));
      const key = writeTerrainCode(code);
      if (seen.has(key)) continue;
      seen.add(key);
      codesInUse.push(code);
    }
  }
}
const moveType = buildFlatMoveType(codesInUse, terrainData);

// Stub UnitType resolver -- see GameBoard's own test for why full unit-type
// database loading (base_unit/gender-variation inheritance flattening) is
// out of scope for now. GameBoard wiring itself (map + sides + units) is
// real; only the per-type combat stats are placeholders here. The weapon
// numbers are chosen to be plausible-looking, not real per-unit-type data,
// but non-zero so combat in the browser demo actually does something (see
// this file's module doc comment).
const stubAttackCfg = new WmlConfig();
stubAttackCfg.setAttribute('name', 'attack');
stubAttackCfg.setAttribute('description', 'Attack');
stubAttackCfg.setAttribute('type', 'blade');
stubAttackCfg.setAttribute('range', 'melee');
stubAttackCfg.setAttribute('min_range', 1);
stubAttackCfg.setAttribute('max_range', 1);
stubAttackCfg.setAttribute('damage', 6);
stubAttackCfg.setAttribute('number', 3);
const stubAttack = AttackType.fromConfig(stubAttackCfg);

const typeCache = new Map();
function resolveType(id) {
  let t = typeCache.get(id);
  if (!t) {
    t = new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 0, -1, 500, [], '', true, false, false, moveType, [stubAttack], []);
    typeCache.set(id, t);
  }
  return t;
}

const board = GameBoard.fromConfig(scenario, terrainData, resolveType);

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

/** Serializes a real (though stubbed, see above) `AttackType` instance to `AttackTypeSnapshot` shape. */
function attackTypeToSnapshot(a) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    range: a.range,
    minRange: a.minRange,
    maxRange: a.maxRange,
    damage: a.damage,
    numAttacks: a.numAttacks,
    attackWeight: a.attackWeight,
    defenseWeight: a.defenseWeight,
    accuracy: a.accuracy,
    parry: a.parry,
    alignment: a.alignment,
  };
}

/** Serializes a real (though stubbed) `UnitType` instance to `UnitTypeSnapshot` shape (see gameBoardSnapshot.ts). */
function unitTypeToSnapshot(t) {
  return {
    id: t.id,
    name: t.name,
    raceId: t.raceId,
    alignment: t.alignment,
    level: t.level,
    hitpoints: t.hitpoints,
    movement: t.movement,
    vision: t.vision,
    jamming: t.jamming,
    maxAttacksPerTurn: t.maxAttacksPerTurn,
    cost: t.cost,
    recallCost: t.recallCost,
    experienceNeededBase: t.experienceNeededBase,
    advancesTo: t.advancesTo,
    undeadVariation: t.undeadVariation,
    zoc: t.zoc,
    hideHelp: t.hideHelp,
    doNotList: t.doNotList,
    attacks: t.attacks.map(attackTypeToSnapshot),
  };
}

const unitTypes = Object.fromEntries([...typeCache].map(([id, t]) => [id, unitTypeToSnapshot(t)]));

const snapshot = {
  generatedBy: 'apps/web/scripts/build-scenario-snapshot.mjs (see file header)',
  scenario: { id: scenario.getString('id'), name: scenario.getString('name') },
  map: {
    width: board.map.w(),
    height: board.map.h(),
    totalWidth: board.map.totalWidth(),
    totalHeight: board.map.totalHeight(),
    border: GameMap.DEFAULT_BORDER,
    data: mapText,
  },
  terrain,
  teams,
  units,
  unitTypes,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(snapshot));
console.log(
  `Wrote ${outFile} (${units.length} units, ${terrain.length} hexes, ${teams.length} sides, ${Object.keys(unitTypes).length} unit types).`,
);
