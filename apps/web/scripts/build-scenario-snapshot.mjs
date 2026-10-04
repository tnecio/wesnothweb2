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
 * the real `[base_unit]`/`[male]`/`[female]`-aware flattening loader, see
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
 * to ask. [Phase 21: the difficulty is now an argument, defaulting to the
 * campaign's own default; see `difficulty` below.] Everything else (image rooting, unit-type/movement-type
 * collection, `spawnUnitsFromTree: false`) is identical to the
 * Dead_Water path -- Dead_Water is no longer special-cased, just the
 * default when `argv[2]` is a bare filename.
 *
 * Run with: npx tsx apps/web/scripts/build-scenario-snapshot.mjs Two_Brothers/scenarios/01_Rooting_Out_a_Mage.cfg
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { campaignBinaryPaths } from './lib/binaryPaths.mjs';

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
// Phase 29 S10: upstream's AI test scenarios (`[test]`s under `data/ai/scenarios/` and
// `data/ai/micro_ais/scenarios/`, loaded by `data/_main.cfg` for `wesnoth -t <id>`). Filed as `ai_test/<id>.json`.
const isAiTestPath = !isBareFilename && /(^|\/)data\/ai\//.test(path.resolve(repoRoot, scenarioFileArg));

let scenarioFile;
let campaignDir; // the campaign root -- parent of scenarios/, maps/, images/, _main.cfg.
if (isBareFilename) {
  campaignDir = path.join(campaignsRoot, 'Dead_Water');
  scenarioFile = path.join(campaignDir, 'scenarios', scenarioFileArg);
} else if (isAiTestPath) {
  scenarioFile = path.resolve(repoRoot, scenarioFileArg);
  campaignDir = path.join(dataRoot, 'ai_test'); // not a real directory: only its name is used, as the asset dir
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
const isRealCampaign = !isSyntheticPath && !isAiTestPath;

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
/**
 * The directory this scenario's snapshot is filed under (Phase 21, fixing a real bug: a bare
 * `[scenario] id=` is only unique within its own campaign -- Dead Water and Under the Burning Suns both
 * ship a `13_Epilogue`, so a flat `scenarios/<id>.json` namespace let one campaign's build silently
 * overwrite another's). `campaignName` above stays real-campaign-only (it also roots image search paths);
 * this is the plain basename of whichever directory the scenario file lives under, real or synthetic --
 * matching `CampaignInfo.assetDir`, which `build-campaigns.mjs` computes the same way.
 */
const campaignDirName = path.basename(campaignDir);

/**
 * The difficulty define this build is for (Phase 21): `argv[3]` (`EASY`, `HARD`, ...), else the campaign's
 * `default=yes` difficulty from `public/campaigns.json` (built by `build-campaigns.mjs`), else `NORMAL`.
 * Difficulty is resolved by the preprocessor (`#ifdef EASY`), so each one is its own build; see
 * `rebuild-snapshots.mjs`, which turns the non-default builds into small overlays.
 * `argv[4]`, when given, is the output file instead of `public/scenarios/<campaignDirName>/<id>.json`.
 */
function defaultDifficulty() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8'));
  const entry = manifest.campaigns.find((c) => c.wesnothId === campaignName);
  return entry?.difficulties?.find((d) => d.default)?.define ?? entry?.difficulties?.[0]?.define ?? 'NORMAL';
}
const difficulty = isRealCampaign ? (process.argv[3] || defaultDifficulty()) : null;
const outArg = process.argv[4];

const { parseWmlFile, preloadDefines, preloadDefinesFromDir, makeNodeHost } = await import(
  path.join(repoRoot, 'packages/engine/src/wml/index.ts')
);
const { TerrainTypeData, writeTerrainCode } = await import(path.join(repoRoot, 'packages/engine/src/model/Terrain.ts'));
const { parseTerrainGraphicsRules } = await import(path.join(repoRoot, 'packages/renderer/src/terrain/terrainGraphicsRules.ts'));
const { loadLuaDataDir } = await import(path.join(repoRoot, 'packages/lua-bridge/src/dataLua.ts'));
const { generateLuaMap } = await import(path.join(repoRoot, 'packages/lua-bridge/src/kernel/mapgen.ts'));
const { GameBoard } = await import(path.join(repoRoot, 'packages/engine/src/model/GameBoard.ts'));
const { GameMap } = await import(path.join(repoRoot, 'packages/engine/src/model/Map.ts'));
const { UnitType } = await import(path.join(repoRoot, 'packages/engine/src/model/UnitType.ts'));
const { Location } = await import(path.join(repoRoot, 'packages/engine/src/model/Location.ts'));
const { WmlConfig } = await import(path.join(repoRoot, 'packages/engine/src/wml/config.ts'));
const { collectUnitTypeConfigs, collectMovementTypeConfigs, collectSpecialRegistry, flattenAllUnitTypes, collectRaceConfigs, collectGlobalTraits, resolveTraitPools } = await import(
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
    flag(difficulty);
  }
  // A test scenario is started without a campaign, at the game's default difficulty (`NORMAL`).
  if (isAiTestPath) flag('NORMAL');
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  // Phase 28c: the theme macros too (`{themes/}` in `data/_main.cfg`) -- Heir to the Throne's scenarios use
  // `CUTSCENE_THEME_BACKGROUND` from `themes/_initial.cfg`.
  preloadDefinesFromDir(path.join(dataRoot, 'themes'), defines, { dataRoot });
  if (isRealCampaign) {
    // Upstream preprocesses the whole campaign in one pass, so a scenario sees the macros as they stand
    // when its own file is reached: a later file may `#undef` or redefine one (Heir to the Throne's last
    // scenario undefines `HTTT_BIGMAP`; Secrets of the Ancients' chapters swap their `JOURNEY_STAGE*`).
    // The table is copied at that point, as the campaign's preload reads the scenario's file.
    const host = makeNodeHost();
    const target = path.resolve(scenarioFile);
    let atScenario;
    const readFile = host.readFile;
    host.readFile = (p) => {
      if (!atScenario && path.resolve(p) === target) atScenario = new Map(defines);
      return readFile(p);
    };
    preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot, host });
    if (atScenario) return atScenario;
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

/**
 * Derives id -> top-level image path (rooted, see rootImagePath) into
 * `images`, and id -> real `flag_rgb=` (defaulting to "magenta", matching
 * `unit_type::flag_rgb()`'s own default and `unit::TC_image_mods()`'s
 * `~RC(flag_rgb>side_color_id)` -- real, reported bug bugs3.md #3: unit
 * sprites rendered in raw magenta, never the unit's side color, for lack of
 * this data) into `flagRgb`, for every id in `flattenedConfigs`.
 *
 * Deliberately reads `image=`/`flag_rgb=` off each id's FLATTENED config
 * (post `[base_unit]` inheritance), not the raw per-id config: a type like
 * Liberty's `Bandit_Peasant` (`[base_unit] id=Bandit [/base_unit]`) sets
 * neither attribute itself at all -- it inherits both from `Bandit`. Reading
 * the raw config here (this function's own prior implementation, which
 * walked the parsed tree directly instead of taking `flattenedConfigs`) left
 * `images` with no entry for any such id, which is why Liberty's Baldras
 * (a Bandit_Peasant) rendered as a blank white placeholder circle: with no
 * resolved image, `buildUnitVisual` (packages/renderer/src/SnapshotBoard.ts)
 * falls back to its "image missing" bare marker-dot case.
 */
function collectUnitTypeImages(flattenedConfigs, images, flagRgb) {
  for (const [id, config] of flattenedConfigs) {
    const image = config.getString('image');
    if (image && !images.has(id)) images.set(id, rootImagePath(image));
    if (!flagRgb.has(id)) flagRgb.set(id, config.getString('flag_rgb', 'magenta'));
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

console.log('Parsing data/core/units.cfg for real unit-type image paths (this takes a few seconds)...');
const coreUnitsCfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(defines) });

// Synthetic campaigns have no _main.cfg (no custom unit types either --
// deliberately, see this file's module doc comment) -- an empty stand-in
// config keeps every downstream use (collectUnitTypeConfigs/
// collectMovementTypeConfigs) a no-op for them without needing separate
// isRealCampaign branches at each call site.
const campaignMainCfg = isRealCampaign
  ? parseWmlFile(path.join(campaignDir, '_main.cfg'), { dataRoot, defines: new Map(defines) })
  : new WmlConfig();

// C1: the game config's terrain types are core's then the campaign's own (Heir to the Throne, Sceptre of
// Fire, Secrets of the Ancients, Under the Burning Suns add theirs under their #ifdef).
const terrainTypeCfgs = [...terrainCfg.children('terrain_type'), ...campaignMainCfg.children('terrain_type')];
const terrainData = TerrainTypeData.fromConfigs(terrainTypeCfgs);

// Real UnitType resolver -- see this file's "Real per-unit-type combat/
// movement stats" doc comment above. `rawUnitTypeConfigs` collects every
// [unit_type]'s own (unflattened) config from the two real trees;
// `flattenAllUnitTypes` resolves `[base_unit]` inheritance (see
// UnitTypeDatabase.ts for the exact, deliberately-simplified semantics) --
// computed up front so `collectUnitTypeImages` below can read images/
// flag_rgb off the FLATTENED configs, not the raw ones (see its own doc
// comment for why that distinction matters).
const rawUnitTypeConfigs = collectUnitTypeConfigs(coreUnitsCfg);
collectUnitTypeConfigs(campaignMainCfg, rawUnitTypeConfigs);
const flattenedUnitTypes = flattenAllUnitTypes(rawUnitTypeConfigs);
// Phase 18b: each type's race folded in -- its trait pool in upstream's
// order, its trait count, and how many random numbers naming a unit takes
// (see `resolveTraitPools`) -- so recruits and event-spawned units roll the
// same random numbers the real game does, and replays line up with it.
const raceConfigs = collectRaceConfigs(coreUnitsCfg);
collectRaceConfigs(campaignMainCfg, raceConfigs);
resolveTraitPools(flattenedUnitTypes, raceConfigs, collectGlobalTraits(coreUnitsCfg));

const unitImages = new Map();
const unitFlagRgb = new Map();
collectUnitTypeImages(flattenedUnitTypes, unitImages, unitFlagRgb);
console.log(`Collected ${unitImages.size} unit-type image paths from real WML.`);

const scenarioCfg = parseWmlFile(scenarioFile, { dataRoot, defines: new Map(defines) });
const scenario = scenarioCfg.child('scenario') ?? scenarioCfg.child('test');

// Phase 28c: what upstream adds to every scenario of a campaign when the game starts
// (`saved_game::expand_mp_events` -> `load_non_scenario("campaign", id)`): the `[campaign]` block's own
// `[event]`, `[lua]`, `[modify_unit_type]` and `[load_resource]` children, appended in that order; then
// each `[load_resource]` is replaced, once per id, by the same four kinds of children of the
// `[resource]` with that id. (`enable_if=` on an event is not evaluated: no mainline content uses it.)
// The game config's own top-level `[lua]` (a campaign's Lua loaded under its `#ifdef`) is run by upstream's
// Lua kernel before the scenario's (`game_lua_kernel::initialize`); it is prepended, marked
// `game_config=yes`, so the runtime can run those first.
if (isRealCampaign) {
  const NON_SCENARIO_TAGS = ['event', 'lua', 'modify_unit_type', 'load_resource'];
  const copyNonScenario = (from, pos) => {
    for (const tag of NON_SCENARIO_TAGS) for (const child of from.children(tag)) scenario.addChildAt(tag, child.clone(), pos++);
    return pos;
  };
  const campaign = campaignMainCfg.child('campaign');
  if (campaign) copyNonScenario(campaign, scenario.allChildren().length);
  const resources = new Map();
  const collectResources = (cfg) => {
    for (const r of cfg.children('resource')) resources.set(r.getString('id'), r);
  };
  // `internal/_main.cfg` includes `{internal/resources/}`, one folder per resource.
  const resourcesDir = path.join(dataRoot, 'internal/resources');
  for (const name of fs.readdirSync(resourcesDir)) {
    const main = path.join(resourcesDir, name, '_main.cfg');
    if (fs.existsSync(main)) collectResources(parseWmlFile(main, { dataRoot, defines: new Map(defines) }));
  }
  collectResources(campaignMainCfg);
  const loaded = new Set();
  for (;;) {
    const index = scenario.allChildren().findIndex((e) => e.tag === 'load_resource');
    if (index < 0) break;
    const id = scenario.allChildren()[index].config.getString('id');
    scenario.removeChildAt(index);
    if (loaded.has(id)) continue;
    loaded.add(id);
    const resource = resources.get(id);
    if (resource) copyNonScenario(resource, index);
    else console.warn(`Warning: [load_resource] id=${id}: no such [resource]`);
  }
  if (loaded.size) scenario.setAttribute('loaded_resources', [...loaded].join(','));
  campaignMainCfg.children('lua').forEach((lua, i) => {
    const copy = lua.clone();
    copy.setAttribute('game_config', true);
    scenario.addChildAt('lua', copy, i);
  });
}

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
  // `map_file=` is resolved against the general WML data search path, so a
  // real campaign can spell it either as a path already rooted at data/
  // (e.g. Under_the_Burning_Suns's own `{UTBS_MAP}` macro:
  // "campaigns/Under_the_Burning_Suns/maps/<file>") or as a bare filename
  // resolved against ITS OWN campaign's maps/ (e.g. Dead_Water's
  // `map_file=Wolf_Coast.map`) -- try the data-root-relative form first,
  // falling back to the campaign-relative one.
  const dataRootPath = path.join(dataRoot, mapFileName);
  const campaignRelativePath = path.join(campaignDir, 'maps', mapFileName);
  const mapPath = fs.existsSync(dataRootPath) ? dataRootPath : campaignRelativePath;
  scenario.setAttribute('map_data', fs.readFileSync(mapPath, 'utf8'));
} else if (!scenario.hasAttribute('map_data') && scenario.getString('map_generation', '') === 'lua' && scenario.child('generator')) {
  // C1: `saved_game::expand_random_scenario`: `random_generate_map` runs the [generator]'s create_map in the
  // map generator's Lua kernel (Heir to the Throne's and Sceptre of Fire's caves). Upstream does this as the
  // scenario starts, so each play gets a new cave; here it is done once, at build time, with a seed fixed by
  // the scenario's id, so every play gets the same one (the user's call, 2026-10-01).
  const generator = scenario.child('generator');
  const seed = [...`${campaignDirName}/${scenario.getString('id')}`].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const files = loadLuaDataDir(dataRoot);
  scenario.setAttribute('map_data', generateLuaMap(files, generator.getString('create_map'), generator, seed, (level, message) => {
    if (level === 'error' || level === 'warn') console.warn(`map generator: ${message}`);
  }));
  console.log(`Generated the map with [generator] ${generator.getString('id')} (seed ${seed}).`);
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

// `movementTypeConfigs` is the real [movetype] registry (all 38 of them
// live inside data/core/units.cfg's own [units] block, alongside the
// [unit_type]s and [race]s) -- `rawUnitTypeConfigs`/`flattenedUnitTypes`
// (needed by `resolveType` below) were already computed above, before
// `collectUnitTypeImages`.
const movementTypeConfigs = collectMovementTypeConfigs(coreUnitsCfg);
collectMovementTypeConfigs(campaignMainCfg, movementTypeConfigs);

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

const board = GameBoard.fromConfig(scenario, terrainData, resolveType, { spawnUnitsFromTree: !isRealCampaign && !isAiTestPath });

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
  // `[side] flag=` (the village flag animation), only when the side sets one.
  ...(t.flag ? { flag: t.flag } : {}),
  recruit: [...t.canRecruit],
  // Real [side] income=/village_gold= -- see GameBoardSnapshot.SnapshotTeam's
  // own doc comment for the real bug this fixes (gold-carryover finishing
  // bonus silently computed as income=0 regardless of the real WML value).
  income: t.income,
  incomePerVillage: t.incomePerVillage,
  supportPerVillage: t.supportPerVillage,
  fog: t.fog.enabled,
  shroud: t.shroud.enabled,
  shareVision: t.shareVision,
  // Real, reported bug: without this, a `no_leader=yes` AI side whose
  // leader is placed by a later scripted event (rather than inline in
  // [side]) read as already-defeated the instant any victory check ran,
  // ending the scenario in an instant false "Victory!" -- see
  // GameBoardSnapshot.SnapshotTeam's own doc comment.
  noLeader: t.noLeader,
  saveId: t.saveId,
  persistent: t.persistent,
  ...(t.defeatCondition !== 'no_leader_left' ? { defeatCondition: t.defeatCondition } : {}),
  // Units the [side] put on its recall list (a leader with no hex for it, `[unit] x,y=recall`), in full.
  ...(board.recallList(t.side).length > 0 ? { recall: board.recallList(t.side).map((u) => u.toConfig().toJSON()) } : {}),
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
    flagRgb: unitFlagRgb.get(t.id) ?? 'magenta',
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
const terrainTypeConfigsJson = terrainTypeCfgs.map((cfg) => cfg.toJSON());

// C1: the campaign's own [terrain_graphics] (global rules, after core's: `parse_global_config`) and the
// scenario's (local: `parse_config(level)`), parsed as the core rules file is; the board joins them to it
// (`mergeBuildingRules`). An image counts as existing in any of the campaign's binary paths (its own, and
// resources it includes such as `internal/Weather`), or in core.
const campaignImagesDirs = isRealCampaign ? campaignBinaryPaths(dataRoot, path.basename(campaignDir)).map((d) => path.join(dataRoot, d, 'images')) : [];
const terrainImageExists = (rel) => campaignImagesDirs.some((dir) => fs.existsSync(path.join(dir, rel))) || fs.existsSync(path.join(dataRoot, 'core/images', rel));
const rulesOf = (from) => {
  const holder = new WmlConfig();
  for (const br of from.children('terrain_graphics')) holder.addChild('terrain_graphics', br);
  return holder;
};
const campaignTerrainRules = parseTerrainGraphicsRules(rulesOf(campaignMainCfg), { imageExists: terrainImageExists });
const scenarioTerrainRules = parseTerrainGraphicsRules(rulesOf(scenario), { imageExists: terrainImageExists, local: true });
const extraTerrainRules = [...campaignTerrainRules, ...scenarioTerrainRules];
if (extraTerrainRules.length > 0) {
  console.log(`Own terrain: ${campaignMainCfg.children('terrain_type').length} [terrain_type], ${campaignTerrainRules.length} campaign and ${scenarioTerrainRules.length} scenario terrain rules (rotations included).`);
}
// Shipped in full (a few dozen entries, negligible size next to the ~332
// unit types above) so the browser can resolve specials_list=/
// abilities_list= for real content the same way this build script just did.
const weaponSpecialConfigsJson = Object.fromEntries([...weaponSpecialRegistry].map(([id, entry]) => [id, { tag: entry.tag, config: entry.config.toJSON() }]));
const abilityConfigsJson = Object.fromEntries([...abilityRegistry].map(([id, entry]) => [id, { tag: entry.tag, config: entry.config.toJSON() }]));

// Phase 28c: `[replace_map] map_file=` is read when the tag runs (`WML_HANDLER_FUNCTION(replace_map)`); the
// browser has no map files, so the file's contents go in as `map_data=` now, resolved like `map_file=` above.
(function inlineReplaceMaps(cfg) {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'replace_map' && config.hasAttribute('map_file') && !config.hasAttribute('map_data')) {
      const file = config.getString('map_file');
      const candidates = [path.join(dataRoot, file), path.join(campaignDir, 'maps', file)];
      const found = candidates.find((p) => fs.existsSync(p));
      if (found) config.setAttribute('map_data', fs.readFileSync(found, 'utf8'));
      else console.warn(`Warning: [replace_map] map_file=${file} not found`);
    }
    inlineReplaceMaps(config);
  }
})(scenario);

// Phase 28c B4: map files a scenario may load at run time by a name its Lua builds (Heir to the Throne's
// seasons: `filesystem.have_asset(MAP, id..'-winter.map')`, then `[replace_map] map_file=`): the campaign's
// maps named after the scenario or its map, followed by `-`. The browser has no data directory to look in.
const mapFiles = {};
if (isRealCampaign && fs.existsSync(path.join(campaignDir, 'maps'))) {
  const prefixes = new Set([scenario.getString('id'), path.basename(mapFileName, '.map')].filter(Boolean).map((p) => `${p}-`));
  for (const name of fs.readdirSync(path.join(campaignDir, 'maps'))) {
    if (name.endsWith('.map') && [...prefixes].some((p) => name.startsWith(p))) mapFiles[name] = fs.readFileSync(path.join(campaignDir, 'maps', name), 'utf8');
  }
}

/** A PNG's width and height from its IHDR chunk, or undefined for anything else. */
function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head.toString('latin1', 1, 4) === 'PNG' ? [head.readUInt32BE(16), head.readUInt32BE(20)] : undefined;
}

// Phase 28c B4: `filesystem.image_size` is synchronous Lua; the browser learns an image's size only by loading
// it. The images Heir to the Throne's `[multihex_image]` cuts up are measured now (their base files: the image
// path functions it uses there, ~RC and ~FL, keep the size).
const imageSizes = {};
(function measure(cfg) {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'multihex_image') {
      const base = config.getString('image', '').split('~')[0];
      const file = [path.join(campaignDir, 'images', base), path.join(dataRoot, 'core/images', base)].find((p) => base && fs.existsSync(p));
      const size = file ? pngSize(file) : undefined;
      if (size) imageSizes[base] = size;
    }
    measure(config);
  }
})(scenario);

// Phase 28c: the campaign's Lua sources, and the WML files that Lua reads with `wml.load "path"` (found by
// scanning the sources for literal paths), preprocessed with this build's defines -- the browser has no data
// directory and no preprocessor.
let luaSources;
if (isRealCampaign) {
  const modules = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.lua')) modules[path.relative(dataRoot, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(campaignDir);
  const wml = {};
  for (const source of Object.values(modules)) {
    for (const m of source.matchAll(/wml\.load\s*\(?\s*["']([^"']+)["']/g)) {
      const rel = m[1].replace(/^~?\/?/, '');
      if (!wml[rel]) wml[rel] = parseWmlFile(path.join(dataRoot, rel), { dataRoot, defines: new Map(defines) }).toJSON();
    }
  }
  if (Object.keys(modules).length > 0) luaSources = { modules, wml };
}

// Phase 28c: a campaign's own `[color_range]`s (The South Guard's `wesred`, Liberty's ...), which upstream
// adds to the game's colour table when the campaign is loaded (`game_config::add_color_info`). Same shape
// as `team-colors.json`'s `ranges`: `rgb=mid,max,min,rep`.
const colorRanges = {};
for (const rangeCfg of campaignMainCfg.children('color_range')) {
  const id = rangeCfg.getString('id');
  const parts = rangeCfg.getString('rgb', '').split(',').map((hex) => {
    const s = hex.trim();
    return s.length === 3
      ? [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)]
      : [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  });
  const [mid, max, min, rep] = parts;
  if (id && mid && max && min && rep) colorRanges[id] = { mid, max, min, rep };
}

const snapshot = {
  generatedBy: 'apps/web/scripts/build-scenario-snapshot.mjs (see file header)',
  ...(difficulty ? { difficulty } : {}),
  assetDir: campaignDirName,
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
  // Two keys, so the campaign's (the same in all its scenarios) is shared in `_campaign.json`.
  ...(campaignTerrainRules.length > 0 ? { campaignTerrainGraphicsRules: JSON.parse(JSON.stringify(campaignTerrainRules)) } : {}),
  ...(scenarioTerrainRules.length > 0 ? { scenarioTerrainGraphicsRules: JSON.parse(JSON.stringify(scenarioTerrainRules)) } : {}),
  movementTypeConfigs: movementTypeConfigsJson,
  raceConfigs: Object.fromEntries([...raceConfigs].map(([id, cfg]) => [id, cfg.toJSON()])),
  unitTypeConfigs,
  weaponSpecialConfigs: weaponSpecialConfigsJson,
  abilityConfigs: abilityConfigsJson,
  scenarioConfigJson: scenario.toJSON(),
  ...(luaSources ? { luaSources } : {}),
  ...(Object.keys(mapFiles).length > 0 ? { mapFiles } : {}),
  ...(Object.keys(imageSizes).length > 0 ? { imageSizes } : {}),
  ...(Object.keys(colorRanges).length > 0 ? { colorRanges } : {}),
};

/**
 * Every textdomain a `{"t": [[domain, msgid], ...]}` marker in this snapshot names, so the browser fetches
 * exactly the catalogues this scenario can need (Phase 20) instead of guessing from the campaign.
 */
function collectTextdomains(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) collectTextdomains(n, out);
  } else if (node && typeof node === 'object') {
    if (Array.isArray(node.t) && Object.keys(node).length === 1) {
      for (const part of node.t) if (Array.isArray(part)) out.add(part[0]);
    } else {
      for (const v of Object.values(node)) collectTextdomains(v, out);
    }
  }
  return out;
}
snapshot.textdomains = [...collectTextdomains(snapshot, new Set())].sort();

const outFile = outArg ? path.resolve(outArg) : path.join(repoRoot, 'apps/web/public/scenarios', campaignDirName, `${snapshot.scenario.id}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(snapshot));
console.log(
  `Wrote ${outFile} (${units.length} pre-placed units, ${terrain.length} hexes, ${teams.length} sides, ` +
    `${Object.keys(unitTypes).length} unit types, ${story.length} story parts).`,
);
