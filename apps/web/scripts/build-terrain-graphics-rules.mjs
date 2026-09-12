#!/usr/bin/env node
/**
 * Builds `apps/web/public/terrain-graphics-rules.json`: the real,
 * fully-parsed/rotated/existence-filtered `[terrain_graphics]` rule list
 * (see `packages/renderer/src/terrain/terrainGraphicsRules.ts`), shipped as
 * ONE static asset shared across every scenario/campaign snapshot -- these
 * rules are core content, identical regardless of which scenario is being
 * played (Dead_Water has no scenario-local `[terrain_graphics]` overrides;
 * see `docs/PROGRESS.md`'s 2026-09-12 Phase 9 entry), so duplicating them
 * into every ~2.3MB scenario snapshot (`build-scenario-snapshot.mjs`) would
 * be pure waste. Unlike that script, this one is NOT re-run per scenario --
 * run it once, or whenever `wesnoth/data/core/terrain-graphics{,.cfg}`
 * content changes.
 *
 * The output is large uncompressed (~17MB for the real ~10,063-rule set)
 * but compresses to ~360KB gzipped -- fetched once and cached by the
 * browser, this is a reasonable tradeoff against the alternative (parsing
 * ~16,000 lines of WML client-side on every page load).
 *
 * `SnapshotBoard` (packages/renderer) calls `reviveBuildingRules` on the
 * fetched JSON before use -- `JSON.parse` produces plain `{base, overlay}`
 * objects for every `TerrainCode`, not real class instances, which the
 * matching code's `.equals()` calls need.
 *
 * Run with: npx tsx apps/web/scripts/build-terrain-graphics-rules.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const coreDir = path.join(dataRoot, 'core');
const outPath = path.join(repoRoot, 'apps/web/public/terrain-graphics-rules.json');

const { preprocess, preloadDefinesFromDir, parseConfig } = await import(
  path.join(repoRoot, 'packages/engine/src/wml/index.ts')
);
const { parseTerrainGraphicsRules } = await import(
  path.join(repoRoot, 'packages/renderer/src/terrain/terrainGraphicsRules.ts')
);

console.log('Preloading core #defines...');
const defines = new Map();
preloadDefinesFromDir(coreDir, defines, { dataRoot });

// Mirrors data/_main.cfg's real load order for this content -- see
// terrainGraphicsRules.real.test.ts's own doc comment for why these are two
// separate includes, in this order, sharing one macro table.
console.log('Preprocessing core/terrain-graphics/ (macro definitions)...');
const defsPass = preprocess('{core/terrain-graphics/}', {
  currentFile: path.join(coreDir, 'synthetic-terrain-graphics-loader.cfg'),
  dir: coreDir,
  dataRoot,
  defines,
});
console.log('Preprocessing core/terrain-graphics.cfg (rule invocations)...');
const invocationsPass = preprocess('{core/terrain-graphics.cfg}', {
  currentFile: path.join(coreDir, 'synthetic-terrain-graphics-loader.cfg'),
  dir: coreDir,
  dataRoot,
  defines: defsPass.defines,
});

const root = parseConfig(defsPass.text + invocationsPass.text);
const imageExists = (relPath) => fs.existsSync(path.join(dataRoot, 'core/images', relPath));

console.log('Parsing + rotating + existence-filtering rules...');
const t0 = Date.now();
const rules = parseTerrainGraphicsRules(root, { imageExists, includeOffMapRule: true });
console.log(`  ${rules.length} rules in ${Date.now() - t0}ms`);

const json = JSON.stringify(rules);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, json);
console.log(`Wrote ${outPath} (${(json.length / 1e6).toFixed(1)}MB)`);
