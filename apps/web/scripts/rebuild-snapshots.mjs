#!/usr/bin/env node
/**
 * Rebuilds every checked-in scenario snapshot (`apps/web/public/scenarios/<campaignDir>/*.json`)
 * by re-running `build-scenario-snapshot.mjs` on the `.cfg` each one came from.
 *
 * Needed whenever the WML pipeline's output shape changes (Phase 20 made
 * translatable strings survive parsing, so every snapshot picked up
 * `{"t": [...]}` markers).
 *
 * Snapshots are filed under their own campaign's directory (`<campaignDirName>/<id>.json`), not flat under
 * `scenarios/`, because a bare `[scenario] id=` is only unique *within* one campaign -- Dead Water and
 * Under the Burning Suns both ship a `13_Epilogue`. A flat namespace (this script's own shape before
 * 2026-09-27) let one campaign's rebuild silently overwrite another's: a hardcoded `PREFER` map picked
 * Dead Water's `13_Epilogue` and dropped Under the Burning Suns' every time this ran, without so much as a
 * warning. So a scenario id here is always paired with the campaign directory it belongs to, and a bare id
 * given on the command line rebuilds it for *every* campaign that has one, not just the first found.
 *
 * Phase 21: a campaign's difficulty is resolved by the preprocessor, so each difficulty is its own build.
 * The campaign's default difficulty (`default=yes`, from `campaigns.json`) is written whole as
 * `<campaignDir>/<id>.json`; every other one is built to a scratch file and written as
 * `<campaignDir>/<id>@<DEFINE>.json`, holding only the top-level keys that differ (`snapshotOverlay.ts`
 * refuses a difference outside its allow-list). Debug scenarios have no difficulties and are built once.
 *
 * Run: npx tsx apps/web/scripts/rebuild-snapshots.mjs [id ...]   (no ids = every scenario currently built)
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

/**
 * Every scenario found in the source tree: `{ id, campaignDirName, arg }`. `campaignDirName` matches what
 * `build-scenario-snapshot.mjs` computes (and what `CampaignInfo.assetDir` names) -- the plain directory
 * name under `wesnoth/data/campaigns/` or `synthetic-campaigns/`. `arg` is what to pass that script.
 */
function findScenarios() {
  const found = [];
  for (const camp of fs.readdirSync(campaignsRoot)) {
    for (const f of cfgFilesUnder(path.join(campaignsRoot, camp, 'scenarios'))) {
      const m = /^\s*id\s*=\s*"?([\w-]+)"?\s*$/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) found.push({ id: m[1], campaignDirName: camp, arg: path.relative(campaignsRoot, f) });
    }
  }
  for (const camp of fs.readdirSync(syntheticRoot)) {
    for (const f of cfgFilesUnder(path.join(syntheticRoot, camp, 'scenarios'))) {
      const m = /^\s*id\s*=\s*"?([\w-]+)"?\s*$/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) found.push({ id: m[1], campaignDirName: camp, arg: path.relative(repoRoot, f) });
    }
  }
  return found;
}

/** Every `<campaignDir>/<id>.json` (not an overlay) currently built, as `{ id, campaignDirName }`. */
function builtScenarios() {
  const out = [];
  if (!fs.existsSync(outDir)) return out;
  for (const campaignDirName of fs.readdirSync(outDir)) {
    const dir = path.join(outDir, campaignDirName);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json') && !f.includes('@')) out.push({ id: f.slice(0, -5), campaignDirName });
    }
  }
  return out;
}

const allScenarios = findScenarios();
const wantedIds = process.argv.slice(2);

/** The jobs to run: every scenario matching a requested id (or, with none given, every scenario already built). */
const jobs = (
  wantedIds.length > 0
    ? wantedIds.flatMap((id) => {
        const matches = allScenarios.filter((s) => s.id === id);
        if (matches.length === 0) throw new Error(`no scenario cfg found for id ${id}`);
        return matches;
      })
    : builtScenarios().map(({ id, campaignDirName }) => {
        const match = allScenarios.find((s) => s.id === id && s.campaignDirName === campaignDirName);
        if (!match) throw new Error(`built scenario ${campaignDirName}/${id}.json has no source cfg any more`);
        return match;
      })
).sort((a, b) => (a.campaignDirName === b.campaignDirName ? a.id.localeCompare(b.id) : a.campaignDirName.localeCompare(b.campaignDirName)));

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8'));

/** [defaultDefine, ...otherDefines] for the campaign directory `campaignDirName` belongs to; [] for a debug scenario. */
function difficultiesFor(campaignDirName) {
  const entry = manifest.campaigns.find((c) => c.assetDir === campaignDirName);
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
  const [def, ...others] = difficultiesFor(job.campaignDirName);
  const base = await build(job.arg, def, undefined);
  if (base.code !== 0) return { ...job, ...base };
  const campaignOutDir = path.join(outDir, job.campaignDirName);
  const baseFile = path.join(campaignOutDir, `${job.id}.json`);
  const wanted = new Set(others.map((d) => `${job.id}@${d}.json`));
  for (const f of fs.readdirSync(campaignOutDir)) if (f.startsWith(`${job.id}@`) && !wanted.has(f)) fs.rmSync(path.join(campaignOutDir, f));
  if (others.length === 0) return { ...job, ...base };
  const baseSnap = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  for (const difficulty of others) {
    const scratch = path.join(os.tmpdir(), `${job.campaignDirName}-${job.id}@${difficulty}.${process.pid}.json`);
    const r = await build(job.arg, difficulty, scratch);
    if (r.code !== 0) return { ...job, ...r };
    try {
      const overlay = diffSnapshots(baseSnap, JSON.parse(fs.readFileSync(scratch, 'utf8')));
      fs.writeFileSync(path.join(campaignOutDir, `${job.id}@${difficulty}.json`), JSON.stringify(overlay));
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
    if (r.code === 0) console.log(`ok   ${job.campaignDirName}/${r.id}`);
    else {
      failed++;
      console.error(`FAIL ${job.campaignDirName}/${r.id} (${r.arg})\n${r.err}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.exit(failed ? 1 : 0);
