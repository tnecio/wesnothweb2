/**
 * Phase 27a S0: upstream's own WML unit tests (`data/test/`), run headlessly against the port, as a
 * conformance suite.
 *
 *   npx tsx packages/ui/scripts/wml-tests.ts [--only id,id] [--match text] [--turns N] [--verbose]
 *                                            [--write-baseline] [--check]
 *
 * Builds each `[test]` the way upstream's `wesnoth -u <id>` loads it -- the test data preprocessed with `TEST`
 * defined, core's and the test macros, core's units plus `data/test/units.cfg`, the game config's `[lua]` that
 * loads `test/lua/wml_tags.lua` -- straight into a `GameSession`, in memory. It plays the startup events and
 * then ends turns, as a human who does nothing, until the test ends or `--turns` run out, and maps the
 * outcome to upstream's codes (`run_wml_tests`' `UnitTestResult`): `[endlevel] test_result=pass` 0, `fail` 1,
 * no result but a victory 8, a defeat 7, no end 2 (timeout), an exception 6.
 *
 * Each result is compared with `wml-tests/wml_test_schedule` (upstream's, vendored). As upstream does without
 * `--strict` and without a timeout, tests expecting a strict-mode result (9-12) or a timeout (2) are skipped.
 *
 * `--write-baseline` records which tests give their expected result in `docs/completeness/wml-tests-baseline.json`;
 * `--check` fails if one of those no longer does. A summary by folder is printed either way.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir } from '@wesnothweb2/engine/src/wml/index.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { TerrainTypeData, writeTerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import { GameBoard } from '@wesnothweb2/engine/src/model/GameBoard.js';
import { GameMap } from '@wesnothweb2/engine/src/model/Map.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import { UnitType } from '@wesnothweb2/engine/src/model/UnitType.js';
import {
  collectUnitTypeConfigs,
  collectMovementTypeConfigs,
  collectSpecialRegistry,
  flattenAllUnitTypes,
  collectRaceConfigs,
  collectGlobalTraits,
  resolveTraitPools,
} from '@wesnothweb2/engine/src/model/UnitTypeDatabase.js';
import type { GameBoardSnapshot } from '@wesnothweb2/engine';
import { loadLuaDataDir } from '@wesnothweb2/lua-bridge/src/dataLua.js';
import { setLuaDataFiles } from '../src/luaData.js';
import { GameSession } from '../src/gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const scheduleFile = path.join(repoRoot, 'packages/ui/scripts/wml-tests/wml_test_schedule');
const baselineFile = path.join(repoRoot, 'docs/completeness/wml-tests-baseline.json');

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = opt('only')?.split(',').filter(Boolean);
const match = opt('match');
const maxTurns = Number(opt('turns') ?? 6);
const verbose = flag('verbose');

const RESULT = { 0: 'PASS', 1: 'FAIL', 2: 'TIMEOUT', 4: 'FAIL_PLAYING_REPLAY', 6: 'FAIL_WML_EXCEPTION', 7: 'FAIL_BY_DEFEAT', 8: 'PASS_BY_VICTORY' } as Record<number, string>;

// --- the schedule ---

const schedule = new Map<string, number>();
for (const line of fs.readFileSync(scheduleFile, 'utf8').split('\n')) {
  const m = /^(\d+)\s+(\S+)\s*$/.exec(line);
  if (m) schedule.set(m[2]!, Number(m[1]));
}

// --- the game config, as `wesnoth -u` loads it with TEST defined ---

const t0 = Date.now();
type Defines = Parameters<typeof preloadDefinesFromDir>[1];
const defines: Defines = new Map();
const define = (name: string) => defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<wml-tests>' });
define('TEST');
define('NORMAL');
// `config_cache`'s one predefined macro with a value (the version of the upstream checkout the data comes from).
defines.set('WESNOTH_VERSION', { name: 'WESNOTH_VERSION', params: [], optionalParams: new Map(), body: '1.19.21+dev', dir: dataRoot, location: '<wml-tests>' });
preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
preloadDefinesFromDir(path.join(dataRoot, 'themes'), defines, { dataRoot });
preloadDefinesFromDir(path.join(dataRoot, 'test/macros'), defines, { dataRoot });

const parse = (file: string): WmlConfig => parseWmlFile(file, { dataRoot, defines: new Map(defines) });

const terrainData = TerrainTypeData.fromConfigs(parse(path.join(dataRoot, 'core/terrain.cfg')).children('terrain_type'));
const coreUnitsCfg = parse(path.join(dataRoot, 'core/units.cfg'));
const testUnitsCfg = parse(path.join(dataRoot, 'test/units.cfg'));
const rawUnitTypes = collectUnitTypeConfigs(coreUnitsCfg);
for (const [id, cfg] of collectUnitTypeConfigs(testUnitsCfg)) rawUnitTypes.set(id, cfg);
const flattened = flattenAllUnitTypes(rawUnitTypes);
const races = collectRaceConfigs(coreUnitsCfg);
resolveTraitPools(flattened, races, collectGlobalTraits(coreUnitsCfg));
const movetypes = collectMovementTypeConfigs(coreUnitsCfg);
const weaponSpecials = collectSpecialRegistry(coreUnitsCfg, 'weapon_specials');
const abilities = collectSpecialRegistry(coreUnitsCfg, 'abilities');
const typeCache = new Map<string, UnitType>();
const resolveType = (id: string): UnitType => {
  let t = typeCache.get(id);
  if (!t) {
    const cfg = flattened.get(id);
    if (!cfg) throw new Error(`no [unit_type] "${id}"`);
    t = UnitType.fromConfig(cfg, movetypes, terrainData, { weaponSpecials, abilities });
    typeCache.set(id, t);
  }
  return t;
};

// Shared by every test's snapshot: the whole unit-type database, as the game has it.
const shared = {
  terrainTypeConfigs: parse(path.join(dataRoot, 'core/terrain.cfg')).children('terrain_type').map((c) => c.toJSON()),
  movementTypeConfigs: Object.fromEntries([...movetypes].map(([id, c]) => [id, c.toJSON()])),
  raceConfigs: Object.fromEntries([...races].map(([id, c]) => [id, c.toJSON()])),
  unitTypeConfigs: Object.fromEntries([...flattened].map(([id, c]) => [id, c.toJSON()])),
  weaponSpecialConfigs: Object.fromEntries([...weaponSpecials].map(([id, e]) => [id, { tag: e.tag, config: e.config.toJSON() }])),
  abilityConfigs: Object.fromEntries([...abilities].map(([id, e]) => [id, { tag: e.tag, config: e.config.toJSON() }])),
};
const unitTypeSummaries: GameBoardSnapshot['unitTypes'] = {};
for (const id of flattened.keys()) {
  try {
    const t = resolveType(id);
    unitTypeSummaries[id] = {
      id: t.id, name: t.name, raceId: t.raceId, alignment: t.alignment, level: t.level, hitpoints: t.hitpoints,
      movement: t.movement, vision: t.vision, jamming: t.jamming, maxAttacksPerTurn: t.maxAttacksPerTurn, cost: t.cost,
      recallCost: t.recallCost, experienceNeededBase: t.experienceNeededBase, advancesTo: t.advancesTo,
      undeadVariation: t.undeadVariation, zoc: t.zoc, hideHelp: t.hideHelp, doNotList: t.doNotList, attacks: [],
      image: null, flagRgb: 'magenta',
    } as unknown as GameBoardSnapshot['unitTypes'][string];
  } catch {
    // A type that does not build is reported by the test that uses it.
  }
}

// The game config's `[lua]` (data/test/_main.cfg) and the test tags upstream loads with wml-tags.lua.
const luaModules = {
  'test/lua/wml_tags.lua': fs.readFileSync(path.join(dataRoot, 'test/lua/wml_tags.lua'), 'utf8'),
  'lua/wml/test_condition.lua': fs.readFileSync(path.join(dataRoot, 'lua/wml/test_condition.lua'), 'utf8'),
};
const gameConfigLua = ["wesnoth.dofile 'test/lua/wml_tags.lua'", "wesnoth.dofile 'lua/wml/test_condition.lua'"];

// --- the tests: every [test] under the folders data/test/_main.cfg includes when TEST is defined ---

const mainCfg = fs.readFileSync(path.join(dataRoot, 'test/_main.cfg'), 'utf8');
const testBlock = mainCfg.slice(mainCfg.indexOf('#ifdef TEST'), mainCfg.indexOf('{test/units.cfg}'));
const dirs = [...testBlock.matchAll(/^\{(test\/scenarios\/[^}]+)\}/gm)].map((m) => m[1]!.replace(/\/$/, ''));
const tests = new Map<string, { cfg: WmlConfig; dir: string }>();
const parseErrors: string[] = [];
for (const dir of dirs) {
  const abs = path.join(dataRoot, dir);
  if (!fs.existsSync(abs)) continue;
  const files = fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).filter((f) => f.endsWith('.cfg')).sort().map((f) => path.join(abs, f)) : [abs];
  for (const file of files) {
    try {
      for (const t of parse(file).children('test')) tests.set(t.getString('id'), { cfg: t, dir: dir.replace(/^test\/scenarios\//, '') });
    } catch (e) {
      parseErrors.push(`${path.relative(dataRoot, file)}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
}
console.log(`Loaded the test config in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${tests.size} tests in ${dirs.length} folders, ${parseErrors.length} file(s) failed to parse.`);
if (verbose) for (const e of parseErrors) console.log(`  parse: ${e}`);

// --- building a test's snapshot ---

function snapshotOf(test: WmlConfig): GameBoardSnapshot {
  const scenario = test.clone();
  const mapFile = scenario.getString('map_file', '');
  if (mapFile) scenario.setAttribute('map_data', fs.readFileSync(path.join(dataRoot, mapFile), 'utf8'));
  else if (!scenario.hasAttribute('map_data')) scenario.setAttribute('map_data', 'Gg');
  gameConfigLua.forEach((code, i) => {
    const lua = new WmlConfig();
    lua.setAttribute('code', code);
    lua.setAttribute('game_config', true);
    scenario.addChildAt('lua', lua, i);
  });
  const board = GameBoard.fromConfig(scenario, terrainData, resolveType, { spawnUnitsFromTree: false });
  const terrain = [];
  for (let x = 0; x < board.map.w(); x++) for (let y = 0; y < board.map.h(); y++) terrain.push({ x, y, code: writeTerrainCode(board.map.getTerrain(new Location(x, y))) });
  return {
    assetDir: 'wml_test',
    scenario: { id: scenario.getString('id'), name: scenario.getString('name', '') },
    map: { width: board.map.w(), height: board.map.h(), totalWidth: board.map.totalWidth(), totalHeight: board.map.totalHeight(), border: GameMap.DEFAULT_BORDER, data: scenario.getString('map_data') },
    terrain,
    teams: board.teams().map((t) => ({
      side: t.side, controller: t.controller, gold: t.gold, teamName: t.teamName, color: t.color, recruit: [...t.canRecruit],
      income: t.income, incomePerVillage: t.incomePerVillage, supportPerVillage: t.supportPerVillage, fog: t.fog.enabled,
      shroud: t.shroud.enabled, shareVision: t.shareVision, noLeader: t.noLeader, saveId: t.saveId, persistent: t.persistent,
      ...(t.defeatCondition !== 'no_leader_left' ? { defeatCondition: t.defeatCondition } : {}),
      ...(board.recallList(t.side).length > 0 ? { recall: board.recallList(t.side).map((u) => u.toConfig().toJSON()) } : {}),
    })),
    units: board.allUnits().map((u) => ({
      id: u.id || null, name: u.name || null, typeId: u.type.id, image: null, side: u.side, x: u.location.x, y: u.location.y,
      canRecruit: u.canRecruit, hitpoints: u.hitpoints, maxHitpoints: u.maxHitpoints, experience: u.experience, maxExperience: u.maxExperience,
    })),
    unitTypes: unitTypeSummaries,
    ...shared,
    scenarioConfigJson: scenario.toJSON(),
    luaSources: { modules: luaModules, wml: {} },
  } as unknown as GameBoardSnapshot;
}

// --- running one ---

interface Outcome {
  code: number;
  detail: string;
}

async function run(id: string, test: WmlConfig): Promise<Outcome> {
  const errors: string[] = [];
  let session: GameSession;
  try {
    session = new GameSession(snapshotOf(test), { seed: 1, onLog: (level, message) => { if (process.env.WML_TRACE) process.stderr.write(`  [${level}] ${message.slice(0, 200)}\n`); if (level === 'error' || (level === 'warn' && /unexpectedly|Assertion/.test(message))) errors.push(message); } });
  } catch (e) {
    return { code: 6, detail: `setup: ${String(e).split('\n')[0]}` };
  }
  const outcome = (): Outcome | null => {
    const r = session.testResult;
    if (r === 'pass') return { code: 0, detail: '' };
    if (r === 'fail') return { code: 1, detail: errors[0] ?? '' };
    if (r === 'victory') return { code: 8, detail: '' };
    if (r === 'defeat') return { code: 7, detail: errors[0] ?? '' };
    if (r) return { code: 1, detail: `test_result=${r}` };
    if (session.scenarioResult === 'victory') return { code: 8, detail: '' };
    if (session.scenarioResult === 'defeat') return { code: 7, detail: errors[0] ?? '' };
    return null;
  };
  try {
    await session.runStartupEvents();
    for (let turn = 0; turn < maxTurns && !outcome(); turn++) await session.endTurn(50);
  } catch (e) {
    return { code: 6, detail: String(e).split('\n')[0]! };
  }
  return outcome() ?? { code: 2, detail: errors[0] ?? `no result after ${maxTurns} turns` };
}

// --- the run ---

setLuaDataFiles(loadLuaDataDir(dataRoot));
// The port's own warnings are noise here; errors are kept per test.
const quiet = console.warn;
// WML_TRACE=1 prints every session log line (to stderr).
console.warn = () => undefined;
const consoleError = console.error;
console.error = () => undefined;

const selected = [...schedule].filter(([id]) => (!only || only.includes(id)) && (!match || id.includes(match)));
const rows: { id: string; dir: string; expected: number; got: number | null; detail: string; ms: number }[] = [];
for (const [id, expected] of selected) {
  const entry = tests.get(id);
  if (expected >= 9 || expected === 2) {
    rows.push({ id, dir: entry?.dir ?? '?', expected, got: null, detail: 'skipped (strict mode or timeout expected)', ms: 0 });
    continue;
  }
  if (!entry) {
    rows.push({ id, dir: '?', expected, got: null, detail: 'not in the test data', ms: 0 });
    continue;
  }
  const started = Date.now();
  const o = await run(id, entry.cfg);
  rows.push({ id, dir: entry.dir, expected, got: o.code, detail: o.detail, ms: Date.now() - started });
  if (verbose || only) consoleError(`${o.code === expected ? 'ok  ' : 'FAIL'} ${id}: expected ${RESULT[expected] ?? expected}, got ${RESULT[o.code] ?? o.code}${o.detail ? ` -- ${o.detail.replace(/\s+/g, ' ').slice(0, only ? 2000 : 240)}` : ''}`);
}
console.warn = quiet;
console.error = consoleError;

// --- the summary ---

const ran = rows.filter((r) => r.got !== null);
const good = ran.filter((r) => r.got === r.expected);
const byDir = new Map<string, { ran: number; good: number }>();
for (const r of ran) {
  const d = byDir.get(r.dir) ?? { ran: 0, good: 0 };
  d.ran++;
  if (r.got === r.expected) d.good++;
  byDir.set(r.dir, d);
}
console.log('');
for (const [dir, d] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) console.log(`${String(d.good).padStart(4)}/${String(d.ran).padEnd(4)} ${dir}`);
const codes = new Map<string, number>();
for (const r of ran) if (r.got !== r.expected) codes.set(RESULT[r.got!] ?? String(r.got), (codes.get(RESULT[r.got!] ?? String(r.got)) ?? 0) + 1);
console.log(`\n${good.length} of ${ran.length} run gave their expected result (${rows.length - ran.length} skipped or missing). Unexpected: ${[...codes].map(([c, n]) => `${n} ${c}`).join(', ') || 'none'}.`);
console.log(`Took ${((Date.now() - t0) / 1000).toFixed(0)} s.`);

if (flag('write-baseline')) {
  fs.writeFileSync(baselineFile, `${JSON.stringify({ note: 'Tests that give their expected result (packages/ui/scripts/wml-tests.ts). --check fails if one stops doing so.', passing: good.map((r) => r.id).sort() }, null, 1)}\n`);
  console.log(`Wrote ${path.relative(repoRoot, baselineFile)} (${good.length} tests).`);
}
if (flag('check')) {
  const baseline = new Set<string>((JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as { passing: string[] }).passing);
  const regressed = rows.filter((r) => baseline.has(r.id) && r.got !== r.expected);
  if (regressed.length > 0) {
    console.log(`\n${regressed.length} test(s) no longer give their expected result:`);
    for (const r of regressed) console.log(`  ${r.id}: expected ${RESULT[r.expected]}, got ${r.got === null ? 'nothing' : RESULT[r.got] ?? r.got}${r.detail ? ` -- ${r.detail}` : ''}`);
    process.exit(1);
  }
  console.log('No regressions against the baseline.');
}
