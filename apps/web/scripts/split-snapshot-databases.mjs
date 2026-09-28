#!/usr/bin/env node
/**
 * Phase 28: moves the unit/terrain databases out of the built scenario snapshots into shared files
 * (`packages/engine/src/snapshot/snapshotDatabase.ts`, `docs/ASSETS.md` §4.1):
 *
 *   public/scenarios/_core.json                   entries identical in every real campaign's scenarios
 *   public/scenarios/<campaignDir>/_campaign.json  entries identical across that campaign's scenarios
 *   public/scenarios/<campaignDir>/<id>.json       the rest, plus `databases` (the files above it needs)
 *
 * Idempotent: a scenario already split is first reassembled from the current database files, so running
 * this after rebuilding one scenario re-splits everything consistently. Difficulty overlays (`<id>@X.json`)
 * are diffs against the complete snapshot and are left alone. Checks that every scenario reassembles to
 * exactly what went in before writing anything.
 *
 * Run: npx tsx apps/web/scripts/split-snapshot-databases.mjs     (rebuild-snapshots.mjs runs it at the end)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleSnapshot,
  campaignDatabaseFile,
  CORE_DATABASE_FILE,
  isDatabaseFile,
  splitSnapshotDatabases,
} from '../../../packages/engine/src/snapshot/snapshotDatabase.ts';
import { readScenarioSnapshot } from '../../../packages/engine/src/snapshot/snapshotFiles.node.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenariosDir = path.join(repoRoot, 'apps/web/public/scenarios');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8'));
const realDirs = new Set(manifest.campaigns.filter((c) => !c.debug).map((c) => c.assetDir));

const inputs = [];
for (const campaignDir of fs.readdirSync(scenariosDir).sort()) {
  const dir = path.join(scenariosDir, campaignDir);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.includes('@') || isDatabaseFile(f)) continue;
    inputs.push({ campaignDir, real: realDirs.has(campaignDir), file: path.join(dir, f), snapshot: readScenarioSnapshot(path.join(dir, f)) });
  }
}
if (!inputs.some((i) => i.real)) throw new Error('no real campaign scenarios found: the core database would be empty');

const { core, campaigns, files } = splitSnapshotDatabases(inputs);
const dbFiles = new Map([[CORE_DATABASE_FILE, core], ...[...campaigns].map(([dir, db]) => [campaignDatabaseFile(dir), db])]);

// Same content, any key order: the split may reorder table entries, which nothing depends on.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
files.forEach((file, i) => {
  const back = assembleSnapshot(file, file.databases.map((name) => dbFiles.get(name)));
  if (JSON.stringify(canon(back)) !== JSON.stringify(canon(inputs[i].snapshot))) {
    throw new Error(`${path.relative(scenariosDir, inputs[i].file)} does not reassemble to its full snapshot`);
  }
});

for (const campaignDir of fs.readdirSync(scenariosDir)) {
  const stale = path.join(scenariosDir, campaignDatabaseFile(campaignDir));
  if (fs.existsSync(stale) && !dbFiles.has(campaignDatabaseFile(campaignDir))) fs.rmSync(stale);
}
for (const [name, db] of dbFiles) fs.writeFileSync(path.join(scenariosDir, name), JSON.stringify(db));
files.forEach((file, i) => fs.writeFileSync(inputs[i].file, JSON.stringify(file)));

const kb = (o) => `${Math.round(JSON.stringify(o).length / 1024)} KB`;
console.log(
  `split ${files.length} scenarios: ${CORE_DATABASE_FILE} ${kb(core)}, ` +
    [...campaigns].map(([dir, db]) => `${dir} ${kb(db)}`).join(', '),
);
