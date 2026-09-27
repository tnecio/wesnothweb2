#!/usr/bin/env node
/**
 * Rebuilds every checked-in scenario snapshot (`apps/web/public/scenarios/*.json`)
 * by re-running `build-scenario-snapshot.mjs` on the `.cfg` each one came from.
 *
 * Needed whenever the WML pipeline's output shape changes (Phase 20 made
 * translatable strings survive parsing, so every snapshot picked up
 * `{"t": [...]}` markers). A snapshot is named after its `[scenario] id=`,
 * not its file, so each cfg is found by scanning the real campaigns and the
 * synthetic ones for that id. `13_Epilogue` exists in two campaigns; the
 * checked-in one is Dead Water's.
 *
 * Phase 21: a campaign's difficulty is resolved by the preprocessor, so each difficulty is its own build.
 * The campaign's default difficulty (`default=yes`, from `campaigns.json`) is written whole as
 * `<id>.json`; every other one is built to a scratch file and written as `<id>@<DEFINE>.json`, holding
 * only the top-level keys that differ (`snapshotOverlay.ts` refuses a difference outside its allow-list).
 * Debug scenarios have no difficulties and are built once.
 *
 * Run: npx tsx apps/web/scripts/rebuild-snapshots.mjs [id ...]   (no ids = all)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import { diffSnapshots } from '../../../packages/engine/src/snapshot/snapshotOverlay.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(repoRoot, 'apps/web/public/scenarios');
const campaignsRoot = path.join(repoRoot, 'wesnoth/data/campaigns');
const syntheticRoot = path.join(repoRoot, 'synthetic-campaigns');

const PREFER = { '13_Epilogue': 'Dead_Water' };

function cfgFilesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...cfgFilesUnder(p));
    else if (e.name.endsWith('.cfg')) out.push(p);
  }
  return out;
}

/** scenario id -> list of cfg paths (relative to the argument roots build-scenario-snapshot.mjs takes). */
function indexScenarios() {
  const byId = new Map();
  const add = (id, arg) => byId.set(id, [...(byId.get(id) ?? []), arg]);
  for (const camp of fs.readdirSync(campaignsRoot)) {
    for (const f of cfgFilesUnder(path.join(campaignsRoot, camp, 'scenarios'))) {
      const m = /^\s*id\s*=\s*"?([\w-]+)"?\s*$/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) add(m[1], path.relative(campaignsRoot, f));
    }
  }
  for (const camp of fs.readdirSync(syntheticRoot)) {
    for (const f of cfgFilesUnder(path.join(syntheticRoot, camp, 'scenarios'))) {
      const m = /^\s*id\s*=\s*"?([\w-]+)"?\s*$/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) add(m[1], path.relative(repoRoot, f));
    }
  }
  return byId;
}

const byId = indexScenarios();
const wanted = process.argv.slice(2);
const ids = (wanted.length ? wanted : fs.readdirSync(outDir).filter((f) => f.endsWith('.json') && !f.includes('@')).map((f) => f.slice(0, -5))).sort();

const jobs = ids.map((id) => {
  const candidates = byId.get(id) ?? [];
  const pick = PREFER[id] ? candidates.find((c) => c.startsWith(PREFER[id] + path.sep)) : candidates[0];
  if (!pick) throw new Error(`no scenario cfg found for id ${id}`);
  return { id, arg: pick };
});

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8'));

/** [defaultDefine, ...otherDefines] for the real campaign `arg` (a path under wesnoth/data/campaigns) belongs to; [] for a debug scenario. */
function difficultiesFor(arg) {
  if (path.isAbsolute(arg) || arg.startsWith('synthetic-campaigns')) return [];
  const entry = manifest.campaigns.find((c) => c.wesnothId === arg.split(path.sep)[0]);
  const all = (entry?.difficulties ?? []).map((d) => d.define);
  if (all.length === 0) return [];
  const def = entry.difficulties.find((d) => d.default)?.define ?? all[0];
  return [def, ...all.filter((d) => d !== def)];
}

function build(arg, difficulty, out) {
  return new Promise((resolve) => {
    const args = ['--import', 'tsx', path.join(repoRoot, 'apps/web/scripts/build-scenario-snapshot.mjs'), arg];
    if (difficulty) args.push(difficulty);
    if (out) args.push(out);
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', () => {});
    child.on('close', (code) => resolve({ code, err }));
  });
}

async function run(job) {
  const [def, ...others] = difficultiesFor(job.arg);
  const base = await build(job.arg, def, undefined);
  if (base.code !== 0) return { ...job, ...base };
  const baseFile = path.join(outDir, `${job.id}.json`);
  const wanted = new Set(others.map((d) => `${job.id}@${d}.json`));
  for (const f of fs.readdirSync(outDir)) if (f.startsWith(`${job.id}@`) && !wanted.has(f)) fs.rmSync(path.join(outDir, f));
  if (others.length === 0) return { ...job, ...base };
  const baseSnap = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  for (const difficulty of others) {
    const scratch = path.join(os.tmpdir(), `${job.id}@${difficulty}.${process.pid}.json`);
    const r = await build(job.arg, difficulty, scratch);
    if (r.code !== 0) return { ...job, ...r };
    try {
      const overlay = diffSnapshots(baseSnap, JSON.parse(fs.readFileSync(scratch, 'utf8')));
      fs.writeFileSync(path.join(outDir, `${job.id}@${difficulty}.json`), JSON.stringify(overlay));
    } catch (e) {
      return { ...job, code: 1, err: `${difficulty}: ${e instanceof Error ? e.message : e}` };
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  }
  return { ...job, code: 0, err: '' };
}

const CONCURRENCY = 4;
let next = 0;
let failed = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const r = await run(job);
    if (r.code === 0) console.log(`ok   ${r.id}`);
    else {
      failed++;
      console.error(`FAIL ${r.id} (${r.arg})\n${r.err}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.exit(failed ? 1 : 0);
