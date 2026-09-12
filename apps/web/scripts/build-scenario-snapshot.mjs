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
 * *rendering* pipeline (packages/renderer, real image assets) and real
 * client-side gameplay (packages/ui, via packages/engine/src/snapshot/
 * gameBoardSnapshot.ts) can be proven end-to-end in a browser today without
 * waiting on that. Revisit once a real in-browser scenario loader is built.
 * The user has explicitly signed off on this as an acceptable interim
 * approach (build-time WML parsing, live client-side gameplay).
 *
 * ## Post-Phase-5 revision (playability feedback)
 *
 * The `units` list is now ONLY the two inline `[side]` leaders (Kai
 * Krellis, Mal-Kevek) -- every other unit in this scenario (six citizens,
 * Cylanna, Gwabbo, the enemy Skeleton/Walking Corpses) is spawned by the
 * scenario's own `prestart`/`start` `[event]`s, which the browser now runs
 * for REAL (`runScenarioStartupEvents`, see gameBoardSnapshot.ts) using
 * `scenarioConfigJson` below, instead of this script statically walking the
 * WML tree for `[unit]` tags regardless of which event places them (the
 * prior, Phase-1-era approach, documented there as a known simplification).
 * This is what actually fixes "no support for message/story tags": the
 * browser now genuinely executes the scenario's WML event logic once at
 * load, recording real `[message]` dialogue as it fires, rather than
 * pre-baking an end-state snapshot with no record of how it got there.
 *
 * New/changed fields (see gameBoardSnapshot.ts's own doc comments):
 *  - `scenarioConfigJson`: the scenario's full config (post-macro-expansion,
 *    at this build), via `WmlConfig.toJSON()`.
 *  - `story`: the scenario's `[story][part]` blocks (text + background
 *    image, if any), extracted directly since displaying them needs no
 *    event-pump execution -- just real, unmodified `story=` text.
 *  - `unitTypes` now covers EVERY unit type this build discovered a real
 *    image path for (currently ~332, from `data/core/units.cfg` plus this
 *    campaign's own `_main.cfg`), not just types already present in
 *    `units` -- necessary because `resolveType` in the browser now has to
 *    resolve whatever id an `[event]`'s `[unit]` tag or a side's real
 *    `recruit=` list names, not just a small fixed set known ahead of time.
 *  - `teams[].recruit`: each side's real `recruit=` list (unit type ids),
 *    straight from `[side] recruit=`, so the browser can offer a real
 *    recruit menu instead of none at all.
 *
 * ## Post-Phase-5 revision #2 (recruiting needs real castle/keep flags)
 *
 *  - `terrainFlags`: real castle/keep/village flags (from this script's own
 *    real `terrainData`, already loaded from `data/core/terrain.cfg`) for
 *    every terrain code the map uses. Without this, `gameBoardFromSnapshot`'s
 *    client-side `GameMap` has NO `[terrain_type]` data at all (its own
 *    `TerrainTypeData` was an intentionally empty stand-in, see
 *    gameBoardSnapshot.ts's doc comment on `buildFlatMoveType`), so
 *    `map.isKeep()`/`isCastle()` always returned false -- discovered while
 *    wiring up real recruiting, which needs to recognize a leader standing
 *    on an actual keep tile.
 *
 * ## Real per-unit-type combat/movement stats (this revision)
 *
 * Every one of the ~332 unit types this build discovers used to get
 * IDENTICAL placeholder stats (30 HP, 5 movement, one 3x6 blade attack --
 * `stubAttackCfg`/`resolveType`'s old body). That's gone: `resolveType` now
 * builds a REAL `UnitType` per id via `UnitType.fromConfig(flattenedCfg,
 * movementTypeConfigs, terrainData)`, where `flattenedCfg` comes from
 * `flattenAllUnitTypes` (`packages/engine/src/model/UnitTypeDatabase.ts`) --
 * the real `base_unit=`/`[male]`/`[female]`-aware flattening loader, see
 * that module's own doc comment for the exact (deliberately simplified)
 * semantics and why they're safe for every real type this project ships.
 * The snapshot now also carries `unitTypeConfigs`/`movementTypeConfigs`/
 * `terrainTypeConfigs` (real, parsed WML, JSON-round-tripped) so the browser
 * can rebuild the exact same real `UnitType`s client-side through the exact
 * same engine code, instead of the old flat-shared-MoveType simplification
 * (`gameBoardSnapshot.ts`'s `buildFlatMoveType`, now only a fallback for
 * snapshots that don't carry these new fields).
 *
 * ## Generic scenario parameter (scenario chaining)
 *
 * Originally hardcoded to `01_Invasion.cfg`, writing one fixed
 * `scenario-snapshot.json`. Now accepts the scenario's `.cfg` filename (bare,
 * resolved against this campaign's `scenarios/` dir) as `argv[2]`, and writes
 * to `apps/web/public/scenarios/<scenario-id>.json` (the id is the real,
 * parsed `[scenario] id=`, not the filename) -- so `apps/web/src/App.svelte`
 * and `GameSession.startNextScenario` can fetch whichever scenario a
 * previous one's real `next_scenario=` names, generically, not just scenario
 * 1. `apps/web/src/App.svelte` still hardcodes `scenarios/01_Invasion.json`
 * as the single entry point for a fresh page load -- a real campaign/
 * scenario picker is future Phase 6 work, out of this task's scope.
 *
 * Run with: npx tsx apps/web/scripts/build-scenario-snapshot.mjs 01_Invasion.cfg
 * (imports packages/engine's .ts sources directly; needs tsx, not plain node)
 *
 * ## Synthetic debug campaigns (small, hand-authored, no macros)
 *
 * `argv[2]` can also be a real path (contains a `/`, or absolute) to a
 * scenario file OUTSIDE the wesnoth submodule content -- e.g. this repo's
 * own `synthetic-campaigns/<name>/scenarios/*.cfg`, small hand-authored
 * WML for fast combat/economy/progression debugging (see docs/PROGRESS.md)
 * without playing through a real campaign's length. A bare filename (no
 * `/`) keeps the original, unchanged behavior: resolved against
 * Dead_Water's own `scenarios/` dir. For a path-style arg under
 * `synthetic-campaigns/`, the "campaign dir" (for `maps/`/`images/`/
 * `_main.cfg`) is that file's own grandparent directory, mirroring
 * Dead_Water's `scenarios/` + `maps/` sibling-directory layout. Synthetic
 * campaigns skip campaign-specific macro flags/`_main.cfg` defines
 * entirely (deliberately macro-free WML) and are built with
 * `spawnUnitsFromTree: true` (every unit placed inline in `[side]`, not
 * via `prestart`/`start` events) so they're playable the instant they
 * load -- no story/message click-through needed for a debugging tool
 * whose whole point is getting to the interesting state fast. Real
 * campaign content keeps `spawnUnitsFromTree: false` exactly as before
 * (unchanged).
 *
 * Run with: npx tsx apps/web/scripts/build-scenario-snapshot.mjs synthetic-campaigns/combat/scenarios/01_combat.cfg
 *
 * ## Any real mainline campaign (2026-09-11, Phase 6 breadth beyond Dead Water)
 *
 * `argv[2]` can also be a path rooted at `wesnoth/data/campaigns/<Name>/`
 * (relative to the repo root, or absolute) for a real mainline campaign
 * OTHER than Dead_Water -- e.g.
 * `Two_Brothers/scenarios/01_Rooting_Out_a_Mage.cfg`. `<Name>` (the first
 * path segment after `campaigns/`) is resolved generically: its own
 * `_main.cfg` is read for `[campaign] define=` (a lightweight regex
 * extraction over the raw file text, not a full parse -- that attribute
 * is never itself behind an `#ifdef`, so this is safe and avoids a
 * chicken-and-egg "need defines to parse the file that sets the define"
 * problem) and that symbol is set before anything else is preprocessed,
 * exactly like the previously-hardcoded `CAMPAIGN_DEAD_WATER`. Difficulty
 * defaults to `NORMAL` for every real campaign (matching Dead_Water's own
 * prior hardcoded choice) since this script has no difficulty-picker UI
 * to ask. Everything else (image rooting, unit-type/movement-type
 * collection, `spawnUnitsFromTree: false`) is identical to the
 * Dead_Water path -- Dead_Water is no longer special-cased, just the
 * default when `argv[2]` is a bare filename.
 *
 * Run with: npx tsx apps/web/scripts/build-scenario-snapshot.mjs Two_Brothers/scenarios/01_Rooting_Out_a_Mage.cfg
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const campaignsRoot = path.join(dataRoot, 'campaigns');

const scenarioFileArg = process.argv[2];
if (!scenarioFileArg) {
  console.error('Usage: npx tsx apps/web/scripts/build-scenario-snapshot.mjs <scenario-file.cfg>');
  console.error('  (a bare filename resolves against wesnoth/data/campaigns/Dead_Water/scenarios/;');
  console.error('   "<CampaignName>/scenarios/<file>.cfg" resolves against any real wesnoth/data/campaigns/<CampaignName>/;');
  console.error('   a synthetic-campaigns/ path is used directly -- e.g. a hand-authored debug scenario)');
  process.exit(1);
}

const isBareFilename = !scenarioFileArg.includes('/') && !path.isAbsolute(scenarioFileArg);
const isSyntheticPath = !isBareFilename && scenarioFileArg.includes('synthetic-campaigns');

let scenarioFile;
let campaignDir; // the campaign root -- parent of scenarios/, maps/, images/, _main.cfg.
if (isBareFilename) {
  campaignDir = path.join(campaignsRoot, 'Dead_Water');
  scenarioFile = path.join(campaignDir, 'scenarios', scenarioFileArg);
} else if (isSyntheticPath) {
  scenarioFile = path.resolve(repoRoot, scenarioFileArg);
  campaignDir = path.dirname(path.dirname(scenarioFile)); // grandparent of the scenario file -- see module doc comment.
} else {
  // Any other real mainline campaign: "<CampaignName>/..." rooted at wesnoth/data/campaigns/.
  scenarioFile = path.isAbsolute(scenarioFileArg) ? scenarioFileArg : path.join(campaignsRoot, scenarioFileArg);
  const relativeToCampaigns = path.relative(campaignsRoot, scenarioFile);
  const campaignName = relativeToCampaigns.split(path.sep)[0];
  if (!campaignName || relativeToCampaigns.startsWith('..')) {
    console.error(`Could not resolve a campaign name from "${scenarioFileArg}" -- expected it to live under wesnoth/data/campaigns/<CampaignName>/.`);
    process.exit(1);
  }
  campaignDir = path.join(campaignsRoot, campaignName);
}
const isRealCampaign = !isSyntheticPath;

/**
 * The `[campaign] define=` symbol for the real campaign at `dir`, read via
 * a lightweight regex over `_main.cfg`'s raw text rather than a full parse
 * -- see this file's module doc comment on why that's safe (the attribute
 * is never itself behind an `#ifdef`). Returns `null` if `_main.cfg` is
 * missing or doesn't declare one (shouldn't happen for a real campaign,
 * but fails soft rather than crashing the whole build over it).
 */
function readCampaignDefine(dir) {
  const mainCfgPath = path.join(dir, '_main.cfg');
  if (!fs.existsSync(mainCfgPath)) return null;
  const text = fs.readFileSync(mainCfgPath, 'utf8');
  const match = text.match(/define\s*=\s*"?([A-Za-z0-9_]+)"?/);
  return match ? match[1] : null;
}
const campaignDefine = isRealCampaign ? readCampaignDefine(campaignDir) : null;
const campaignName = isRealCampaign ? path.basename(campaignDir) : null;

const { parseWmlFile, preloadDefines, preloadDefinesFromDir } = await import(
  path.join(repoRoot, 'packages/engine/src/wml/index.ts')
);
const { TerrainTypeData, writeTerrainCode } = await import(path.join(repoRoot, 'packages/engine/src/model/Terrain.ts'));
const { GameBoard } = await import(path.join(repoRoot, 'packages/engine/src/model/GameBoard.ts'));
const { GameMap } = await import(path.join(repoRoot, 'packages/engine/src/model/Map.ts'));
const { UnitType } = await import(path.join(repoRoot, 'packages/engine/src/model/UnitType.ts'));
const { Location } = await import(path.join(repoRoot, 'packages/engine/src/model/Location.ts'));
const { WmlConfig } = await import(path.join(repoRoot, 'packages/engine/src/wml/config.ts'));
const { collectUnitTypeConfigs, collectMovementTypeConfigs, collectSpecialRegistry, flattenAllUnitTypes } = await import(
  path.join(repoRoot, 'packages/engine/src/model/UnitTypeDatabase.ts')
);

function loadDefines() {
  const defines = new Map();
  const flag = (name) =>
    defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<snapshot-script>' });
  // Flags must be set BEFORE preloadDefinesFromDir(core): several core
  // files gate which macros they even declare behind #ifdef NORMAL/etc,
  // so scanning with the flag already set is required, not just cosmetic
  // (confirmed the hard way -- reordering this once produced a real
  // "Macro/file 'ON_DIFFICULTY4' is missing" crash on the unchanged
  // Dead_Water path). `campaignDefine` is read generically per real
  // campaign (see `readCampaignDefine`); difficulty always defaults to
  // NORMAL (no difficulty-picker UI here to ask, see module doc comment).
  if (isRealCampaign) {
    if (campaignDefine) flag(campaignDefine);
    flag('NORMAL');
  }
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  if (isRealCampaign) {
    preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot });
  }
  return defines;
}

/**
 * Roots a raw WML image path (e.g. "units/merfolk/child_king.png", as
 * authored) against the real on-disk search order the C++ engine's image
 * VFS uses: the campaign's own `images/` dir first, then `core/images/`.
 * `game-images` (apps/web/public/game-images) is a symlink to the whole
 * `wesnoth/data` dir, so the rooted path this returns is exactly the
 * `/game-images/`-relative URL path the browser will fetch -- and matches
 * what packages/renderer's `imageUrl()` expects (it leaves `core/`- or
 * `campaigns/`-prefixed paths untouched rather than re-rooting them).
 *
 * Without this, raw unrooted paths reaching the browser get auto-rooted by
 * `imageUrl()` as `core/images/<raw>` unconditionally -- wrong for the
 * campaign's own art (404s, since it isn't under core/images at all).
 */
function rootImagePath(raw) {
  if (!raw) return raw;
  if (raw.startsWith('core/') || raw.startsWith('campaigns/')) return raw;
  // Synthetic campaigns have no custom art (deliberately -- they only use
  // real core unit types) and live outside wesnoth/data entirely, so
  // there's no campaign-relative image root to even check.
  if (isRealCampaign) {
    const campaignRelative = path.join(`campaigns/${campaignName}/images`, raw);
    if (fs.existsSync(path.join(dataRoot, campaignRelative))) return campaignRelative;
  }
  return `core/images/${raw}`;
}

/** Walks a parsed tree collecting every [unit_type] (including [male]/[female] variant children) id -> top-level image path (rooted, see rootImagePath). */
function collectUnitTypeImages(cfg, out) {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'unit_type') {
      const id = config.getString('id');
      const image = config.getString('image');
      if (id && image && !out.has(id)) out.set(id, rootImagePath(image));
      collectUnitTypeImages(config, out); // [male]/[female] sub-variants
    } else {
      collectUnitTypeImages(config, out);
    }
  }
}

/** Extracts [story][part] blocks into {text, image} -- see this file's module doc comment. No event pump needed, just real static text. */
function extractStory(scenarioCfg) {
  const storyCfg = scenarioCfg.child('story');
  if (!storyCfg) return [];
  return storyCfg.children('part').map((part) => {
    const bg = part.child('background_layer');
    const rawImage = bg ? bg.getString('image', '') || null : null;
    return {
      text: part.getString('story', ''),
      image: rawImage ? rootImagePath(rawImage) : null,
    };
  });
}

const defines = loadDefines();

const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(defines) });
const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));

console.log('Parsing data/core/units.cfg for real unit-type image paths (this takes a few seconds)...');
const coreUnitsCfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(defines) });
const unitImages = new Map();
collectUnitTypeImages(coreUnitsCfg, unitImages);

// Synthetic campaigns have no _main.cfg (no custom unit types either --
// deliberately, see this file's module doc comment) -- an empty stand-in
// config keeps every downstream use (collectUnitTypeImages/
// collectUnitTypeConfigs/collectMovementTypeConfigs) a no-op for them
// without needing separate isRealCampaign branches at each call site.
const campaignMainCfg = isRealCampaign
  ? parseWmlFile(path.join(campaignDir, '_main.cfg'), { dataRoot, defines: new Map(defines) })
  : new WmlConfig();
collectUnitTypeImages(campaignMainCfg, unitImages);
console.log(`Collected ${unitImages.size} unit-type image paths from real WML.`);

const scenarioCfg = parseWmlFile(scenarioFile, { dataRoot, defines: new Map(defines) });
const scenario = scenarioCfg.child('scenario');
// A real, if rare, shape: a map-less "epilogue" scenario that's pure
// [story] with no [side]/gameplay at all (e.g. Two_Brothers' own
// 05_Epilogue.cfg -- unlike Dead_Water's 13_Epilogue, which reuses a real
// map for a final cutscene). Neither map_file= nor inline map_data= is
// set in that case; fall back to a trivial single-hex map rather than
// crashing (fs.readFileSync on an empty map_file= resolves to the maps/
// directory itself, an EISDIR) -- this project's board-centric UI has no
// real mapless-scenario support yet (a future Phase 6/11 concern), but a
// trivial placeholder board at least lets the real [story]/dialogue
// content load instead of failing the whole build.
const mapFileName = scenario.getString('map_file', '');
if (mapFileName) {
  scenario.setAttribute('map_data', fs.readFileSync(path.join(campaignDir, 'maps', mapFileName), 'utf8'));
} else if (!scenario.hasAttribute('map_data')) {
  console.warn(`Warning: "${scenario.getString('id')}" has no map_file=/map_data= -- using a trivial 1-hex placeholder map.`);
  scenario.setAttribute('map_data', 'Gg');
}
const mapText = scenario.getString('map_data');

const story = extractStory(scenario);

// Real castle/keep/village flags per terrain code in use -- see this
// file's "Post-Phase-5 revision #2" doc comment above. Still shipped
// (cheap, backward-compat) even though terrainTypeConfigs below now carries
// the FULL real terrain.cfg too.
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
const terrainFlags = {};
for (const code of codesInUse) {
  const info = terrainData.getTerrainInfo(code);
  terrainFlags[writeTerrainCode(code)] = {
    castle: info.isCastle(),
    keep: info.isKeep(),
    village: info.isVillage(),
  };
}

// Real UnitType resolver -- see this file's "Real per-unit-type combat/
// movement stats" doc comment above. `rawUnitTypeConfigs` collects every
// [unit_type]'s own (unflattened) config from the same two real trees
// `collectUnitTypeImages` already walked for image paths; `flattenAllUnitTypes`
// resolves base_unit= inheritance (see UnitTypeDatabase.ts for the exact,
// deliberately-simplified semantics); `movementTypeConfigs` is the real
// [movetype] registry (all 38 of them live inside data/core/units.cfg's
// own [units] block, alongside the [unit_type]s and [race]s).
const rawUnitTypeConfigs = collectUnitTypeConfigs(coreUnitsCfg);
collectUnitTypeConfigs(campaignMainCfg, rawUnitTypeConfigs);
const movementTypeConfigs = collectMovementTypeConfigs(coreUnitsCfg);
collectMovementTypeConfigs(campaignMainCfg, movementTypeConfigs);
const flattenedUnitTypes = flattenAllUnitTypes(rawUnitTypeConfigs);

// Real `[units][weapon_specials]`/`[units][abilities]` registries --
// resolves real content's `specials_list=`/`abilities_list=` shorthand
// (e.g. Assassin.cfg's `specials_list=marksman,poison`) the same way
// `unit_type_data::add_registry_entries` does upstream. See
// `UnitTypeDatabase.ts`'s `collectSpecialRegistry` for what this fixes:
// without it, any real unit relying on the shorthand (rather than inline
// [specials]/[abilities] tags) would have NONE of its specials/abilities
// recognized by this engine at all.
const weaponSpecialRegistry = collectSpecialRegistry(coreUnitsCfg, 'weapon_specials');
collectSpecialRegistry(campaignMainCfg, 'weapon_specials', weaponSpecialRegistry);
const abilityRegistry = collectSpecialRegistry(coreUnitsCfg, 'abilities');
collectSpecialRegistry(campaignMainCfg, 'abilities', abilityRegistry);

const typeCache = new Map();
function resolveType(id) {
  let t = typeCache.get(id);
  if (!t) {
    const flatCfg = flattenedUnitTypes.get(id);
    if (!flatCfg) {
      throw new Error(`resolveType: no [unit_type] found for id "${id}" (checked data/core/units.cfg and the campaign's own unit files)`);
    }
    t = UnitType.fromConfig(flatCfg, movementTypeConfigs, terrainData, { weaponSpecials: weaponSpecialRegistry, abilities: abilityRegistry });
    typeCache.set(id, t);
  }
  return t;
}

// Dead Water: spawnUnitsFromTree false -- every unit besides the two
// inline leaders comes from the scenario's real events, run live in the
// browser (see this file's module doc comment). Synthetic campaigns:
// true -- every unit is placed inline in [side], no events needed, so the
// board is immediately, fully populated (see this file's "Synthetic debug
// campaigns" doc comment for why that's the right default for a fast
// debugging tool). Pre-populate typeCache for every id we have a real
// image for either way, so the snapshot's unitTypes covers whatever an
// event's [unit] tag or a side's recruit= list might reference, not just
// what's already on the board at build time.
for (const id of unitImages.keys()) resolveType(id);

const board = GameBoard.fromConfig(scenario, terrainData, resolveType, { spawnUnitsFromTree: !isRealCampaign });

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
  // Real, reported bug: a scenario-authored [unit] experience= override
  // (e.g. a debug scenario setting a unit up one hit from advancing) was
  // silently dropped by this snapshot -- gameBoardFromSnapshot only ever
  // applied hitpoints/maxHitpoints on top of the resolved type's real
  // defaults, never experience/maxExperience.
  experience: u.experience,
  maxExperience: u.maxExperience,
}));

const teams = board.teams().map((t) => ({
  side: t.side,
  controller: t.controller,
  gold: t.gold,
  teamName: t.teamName,
  color: t.color,
  recruit: [...t.canRecruit],
  // Real [side] income=/village_gold= -- see GameBoardSnapshot.SnapshotTeam's
  // own doc comment for the real bug this fixes (gold-carryover finishing
  // bonus silently computed as income=0 regardless of the real WML value).
  income: t.income,
  incomePerVillage: t.incomePerVillage,
  supportPerVillage: t.supportPerVillage,
}));

/** Serializes a real `AttackType` instance to `AttackTypeSnapshot` shape. */
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

/** Serializes a real `UnitType` instance to the scalar `UnitTypeSnapshot` shape (see gameBoardSnapshot.ts) -- a display-friendly summary; the full real per-type movement/defense data travels separately via `unitTypeConfigs`/`movementTypeConfigs`/`terrainTypeConfigs` below. */
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
    image: unitImages.get(t.id) ?? null,
  };
}

const unitTypes = Object.fromEntries([...typeCache].map(([id, t]) => [id, unitTypeToSnapshot(t)]));

// Real WML, JSON-round-tripped, so the browser can rebuild the exact same
// real UnitTypes client-side via UnitType.fromConfig/MoveType.fromConfig --
// see this file's and gameBoardSnapshot.ts's "Real per-unit-type stats" doc
// comments. Only the ids actually resolved above (== unitImages' ~332,
// plus anything GameBoard.fromConfig additionally needed) are shipped, not
// every id flattenAllUnitTypes happened to touch.
const unitTypeConfigs = Object.fromEntries([...typeCache.keys()].map((id) => [id, flattenedUnitTypes.get(id).toJSON()]));
const movementTypeConfigsJson = Object.fromEntries([...movementTypeConfigs].map(([name, cfg]) => [name, cfg.toJSON()]));
const terrainTypeConfigsJson = terrainCfg.children('terrain_type').map((cfg) => cfg.toJSON());
// Shipped in full (a few dozen entries, negligible size next to the ~332
// unit types above) so the browser can resolve specials_list=/
// abilities_list= for real content the same way this build script just did.
const weaponSpecialConfigsJson = Object.fromEntries([...weaponSpecialRegistry].map(([id, entry]) => [id, { tag: entry.tag, config: entry.config.toJSON() }]));
const abilityConfigsJson = Object.fromEntries([...abilityRegistry].map(([id, entry]) => [id, { tag: entry.tag, config: entry.config.toJSON() }]));

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
  story,
  terrainFlags,
  terrainTypeConfigs: terrainTypeConfigsJson,
  movementTypeConfigs: movementTypeConfigsJson,
  unitTypeConfigs,
  weaponSpecialConfigs: weaponSpecialConfigsJson,
  abilityConfigs: abilityConfigsJson,
  scenarioConfigJson: scenario.toJSON(),
};

const outFile = path.join(repoRoot, 'apps/web/public/scenarios', `${snapshot.scenario.id}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(snapshot));
console.log(
  `Wrote ${outFile} (${units.length} pre-placed units, ${terrain.length} hexes, ${teams.length} sides, ` +
    `${Object.keys(unitTypes).length} unit types, ${story.length} story parts).`,
);
