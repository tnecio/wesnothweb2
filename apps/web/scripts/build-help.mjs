#!/usr/bin/env node
/**
 * Builds the help browser's data (Phase 24): `public/help/core.json`.
 *
 *   npx tsx apps/web/scripts/build-help.mjs [--if-stale]
 *
 * Upstream's help (`src/help/`) is built at runtime from the game config: the `[help]` tree
 * (`data/core/help.cfg`, which includes the editor's help and `core/encyclopedia/`), and pages generated
 * from every unit type, race, trait, ability, weapon special, terrain type and era. The browser has no WML
 * preprocessor, so all of that is read here, from `data/core` alone (the main menu shows the core help;
 * in a game the scenario snapshot's own tables, which include its campaign's units, are laid over it).
 *
 * The unit type configs are flattened (`[base_unit]`) and carry their resolved trait pools, as the scenario
 * snapshots' `unitTypeConfigs`, but keep only what a help page reads: animations, `[defend]`, `[death]` and
 * `[event]` children are dropped.
 *
 * `--if-stale` skips the build when a hash of its inputs matches the one stored with the output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const outDir = path.join(repoRoot, 'apps/web/public/help');
const outFile = path.join(outDir, 'core.json');
const hashFile = path.join(outDir, '.inputs-hash');

/** Hash of everything the build reads: this script, the engine's WML and unit-type code, and the submodule commit. */
function inputsHash() {
  const hash = createHash('sha256');
  const add = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) add(path.join(p, e));
    else hash.update(path.relative(repoRoot, p)).update('\0').update(fs.readFileSync(p)).update('\0');
  };
  for (const p of ['apps/web/scripts/build-help.mjs', 'packages/engine/src/wml', 'packages/engine/src/model/UnitTypeDatabase.ts']) {
    add(path.join(repoRoot, p));
  }
  const sub = path.join(repoRoot, 'wesnoth');
  const submodule = fs.existsSync(path.join(sub, '.git'))
    ? execFileSync('git', ['-C', sub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD:wesnoth'], { encoding: 'utf8' }).trim();
  return hash.update(submodule).digest('hex').slice(0, 16);
}

const current = inputsHash();
if (process.argv.includes('--if-stale') && fs.existsSync(outFile) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8').trim() === current) {
  console.log('help data is up to date');
  process.exit(0);
}

const { parseWmlFile, preloadDefinesFromDir } = await import(path.join(repoRoot, 'packages/engine/src/wml/index.ts'));
const { collectUnitTypeConfigs, collectMovementTypeConfigs, collectSpecialRegistry, flattenAllUnitTypes, collectRaceConfigs, collectGlobalTraits, resolveTraitPools } =
  await import(path.join(repoRoot, 'packages/engine/src/model/UnitTypeDatabase.ts'));

/** The core macros, with the game's default difficulty and `MULTIPLAYER` (for the eras' faction macros). */
function coreDefines() {
  const defines = new Map();
  for (const name of ['NORMAL', 'MULTIPLAYER']) {
    defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<build-help>' });
  }
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  preloadDefinesFromDir(path.join(dataRoot, 'multiplayer'), defines, { dataRoot });
  return defines;
}
const defines = coreDefines();
const parse = (rel) => parseWmlFile(path.join(dataRoot, rel), { dataRoot, defines: new Map(defines) });

const helpCfg = parse('core/help.cfg').child('help');
if (!helpCfg) throw new Error('data/core/help.cfg has no [help]');

const unitsCfg = parse('core/units.cfg');
const flattened = flattenAllUnitTypes(collectUnitTypeConfigs(unitsCfg));
const raceConfigs = collectRaceConfigs(unitsCfg);
const globalTraits = collectGlobalTraits(unitsCfg);
resolveTraitPools(flattened, raceConfigs, globalTraits);

/** A copy of a unit type config without what no help page reads (animations and events). */
const DROPPED = (tag) => tag.endsWith('_anim') || tag === 'animation' || tag === 'defend' || tag === 'death' || tag === 'event';
function stripped(json) {
  const out = { ...json };
  if (json.children) {
    out.children = json.children
      .filter((c) => !DROPPED(c.tag))
      .map((c) => ({ ...c, config: stripped(c.config) }));
  }
  return out;
}

const terrainCfg = parse('core/terrain.cfg');
// Upstream's `string_table`: the `[language]` block of `data/english.cfg` (damage type and range names, the
// damage types' special notes...).
const stringTable = parse('english.cfg').child('language');
if (!stringTable) throw new Error('data/english.cfg has no [language]');
const erasCfg = parse('multiplayer/eras.cfg');

const data = {
  generatedBy: 'apps/web/scripts/build-help.mjs',
  help: helpCfg.toJSON(),
  unitTypeConfigs: Object.fromEntries([...flattened].map(([id, cfg]) => [id, stripped(cfg.toJSON())])),
  movementTypeConfigs: Object.fromEntries([...collectMovementTypeConfigs(unitsCfg)].map(([id, cfg]) => [id, cfg.toJSON()])),
  raceConfigs: Object.fromEntries([...raceConfigs].map(([id, cfg]) => [id, cfg.toJSON()])),
  traitConfigs: globalTraits.map((cfg) => cfg.toJSON()),
  weaponSpecialConfigs: Object.fromEntries(
    [...collectSpecialRegistry(unitsCfg, 'weapon_specials')].map(([id, e]) => [id, { tag: e.tag, config: e.config.toJSON() }]),
  ),
  abilityConfigs: Object.fromEntries([...collectSpecialRegistry(unitsCfg, 'abilities')].map(([id, e]) => [id, { tag: e.tag, config: e.config.toJSON() }])),
  terrainTypeConfigs: terrainCfg.children('terrain_type').map((cfg) => cfg.toJSON()),
  eraConfigs: erasCfg.children('era').map((cfg) => cfg.toJSON()),
  stringTable: stringTable.toJSON().attrs,
};

fs.mkdirSync(outDir, { recursive: true });
const text = JSON.stringify(data);
fs.writeFileSync(outFile, text);
fs.writeFileSync(hashFile, current + '\n');
console.log(
  `Wrote ${path.relative(repoRoot, outFile)} (${(text.length / 1024).toFixed(0)} KiB): ${helpCfg.allChildren().length} [help] children, ` +
    `${flattened.size} unit types, ${raceConfigs.size} races, ${data.terrainTypeConfigs.length} terrains, ${data.eraConfigs.length} eras.`,
);
