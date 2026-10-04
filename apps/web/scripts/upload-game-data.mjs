#!/usr/bin/env node
/**
 * Phase 28: uploads the upstream game media (images, music, sounds) to the R2 bucket the production build
 * reads it from (`VITE_GAME_DATA_URL`, `packages/ui/src/gameData.ts`):
 *
 *   <prefix>/game-images/...          wesnoth/data/{core,campaigns,internal}/**   (as public/game-images)
 *   <prefix>/game-images-engine/...   wesnoth/images/**                  (as public/game-images-engine)
 *   <prefix>/game-sounds-engine/...   wesnoth/sounds/**                  (as public/game-sounds-engine)
 *
 * `<prefix>` is `<submodule commit>-m<MEDIA_VERSION>`: the commit fixes the sources, the version the way
 * they are processed. Only media files (png, webp, jpg, ogg, wav) are uploaded; WML, maps and Lua are baked
 * into the build. WAVs are converted to Ogg Vorbis (quality 5, ~6x smaller) and stored as `<name>.wav.ogg`,
 * which is what the production build asks for (`packages/ui/src/gameData.ts` `servedAudioPath`); this needs
 * `ffmpeg`. A prefix never changes once written, so every object is sent with
 * `Cache-Control: public, max-age=31536000, immutable`. When `<prefix>/.complete-s<SOURCES_VERSION>` exists the
 * prefix is done and nothing is sent; otherwise objects already present (an interrupted earlier run, or one
 * from before a source directory was added) are skipped.
 *
 * Uses R2's S3-compatible API: the Cloudflare REST API's rate limit would stretch ~19k uploads past an hour.
 * Environment: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY; optional R2_BUCKET
 * (default wesnothweb2-data).
 *
 * Run: node apps/web/scripts/upload-game-data.mjs [--dry-run]    (prints the prefix as its last line)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AwsClient } from 'aws4fetch';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const wesnoth = path.join(repoRoot, 'wesnoth');
const dryRun = process.argv.includes('--dry-run');
const bucket = process.env.R2_BUCKET || 'wesnothweb2-data';

/** Bump when the processing below changes (2: WAV -> Ogg Vorbis), so a new prefix is uploaded. */
const MEDIA_VERSION = 2;
/**
 * Bump when a source directory is added (2: `data/internal`, the resources campaigns include as binary paths):
 * the prefix stays, and only the new files are sent.
 */
const SOURCES_VERSION = 2;
const CONTENT_TYPES = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', ogg: 'audio/ogg' };
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The submodule commit: its own HEAD when checked out as a repository, else the one the superproject pins. */
function submoduleCommit() {
  return fs.existsSync(path.join(wesnoth, '.git'))
    ? execFileSync('git', ['-C', wesnoth, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD:wesnoth'], { encoding: 'utf8' }).trim();
}

function mediaFiles(dir, keyPrefix, out) {
  if (!fs.existsSync(dir)) throw new Error(`${path.relative(repoRoot, dir)} is missing`);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) mediaFiles(p, `${keyPrefix}/${e.name}`, out);
    else {
      const ext = e.name.split('.').pop().toLowerCase();
      if (ext === 'wav') out.push({ file: p, key: `${keyPrefix}/${e.name}.ogg`, type: 'audio/ogg', transcode: true });
      else if (CONTENT_TYPES[ext]) out.push({ file: p, key: `${keyPrefix}/${e.name}`, type: CONTENT_TYPES[ext] });
    }
  }
  return out;
}

const prefix = `${submoduleCommit()}-m${MEDIA_VERSION}`;
const files = [];
mediaFiles(path.join(wesnoth, 'data/core'), `${prefix}/game-images/core`, files);
mediaFiles(path.join(wesnoth, 'data/campaigns'), `${prefix}/game-images/campaigns`, files);
mediaFiles(path.join(wesnoth, 'data/internal'), `${prefix}/game-images/internal`, files);
mediaFiles(path.join(wesnoth, 'images'), `${prefix}/game-images-engine`, files);
mediaFiles(path.join(wesnoth, 'sounds'), `${prefix}/game-sounds-engine`, files);
const totalBytes = files.reduce((n, f) => n + fs.statSync(f.file).size, 0);
console.log(`${files.length} media files (${files.filter((f) => f.transcode).length} WAVs to convert), ${(totalBytes / 1024 / 1024).toFixed(0)} MiB, under ${bucket}/${prefix}/`);

if (dryRun) {
  console.log(prefix);
  process.exit(0);
}

if (files.some((f) => f.transcode)) execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); // fail early without ffmpeg
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'game-data-'));
/** The bytes to upload for `f`: the file itself, or its Ogg Vorbis conversion. */
function body(f) {
  if (!f.transcode) return fs.readFileSync(f.file);
  const out = path.join(scratch, `${f.key.replace(/[^A-Za-z0-9.-]/g, '_')}`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', f.file, '-c:a', 'libvorbis', '-q:a', '5', out]);
  const bytes = fs.readFileSync(out);
  fs.rmSync(out);
  return bytes;
}

for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
}
const client = new AwsClient({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  service: 's3',
  region: 'auto',
});
const endpoint = `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}`;
const objectUrl = (key) => `${endpoint}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function withRetries(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 5) throw new Error(`${what}: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

const marker = `${prefix}/.complete-s${SOURCES_VERSION}`;
const head = await withRetries('HEAD marker', () => client.fetch(objectUrl(marker), { method: 'HEAD' }));
if (head.status === 200) {
  console.log(`${marker} exists: nothing to upload`);
  console.log(prefix);
  process.exit(0);
}

// Keys already uploaded by an interrupted run.
const existing = new Set();
let token;
do {
  const url = new URL(endpoint);
  url.searchParams.set('list-type', '2');
  url.searchParams.set('prefix', `${prefix}/`);
  if (token) url.searchParams.set('continuation-token', token);
  const res = await withRetries('list', async () => {
    const r = await client.fetch(url.toString());
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    return r.text();
  });
  for (const m of res.matchAll(/<Key>([^<]*)<\/Key>/g)) existing.add(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  token = /<IsTruncated>true<\/IsTruncated>/.test(res) ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(res)?.[1] : undefined;
} while (token);

const todo = files.filter((f) => !existing.has(f.key));
console.log(`${existing.size} already present, uploading ${todo.length}`);

let done = 0;
let next = 0;
const started = Date.now();
async function worker() {
  while (next < todo.length) {
    const f = todo[next++];
    await withRetries(f.key, async () => {
      const r = await client.fetch(objectUrl(f.key), {
        method: 'PUT',
        body: body(f),
        headers: { 'Content-Type': f.type, 'Cache-Control': CACHE_CONTROL },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    });
    if (++done % 1000 === 0) console.log(`  ${done}/${todo.length} (${Math.round((Date.now() - started) / 1000)} s)`);
  }
}
await Promise.all(Array.from({ length: 32 }, worker));

const put = await client.fetch(objectUrl(marker), { method: 'PUT', body: new Date().toISOString() });
if (!put.ok) throw new Error(`writing ${marker}: HTTP ${put.status}`);
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`uploaded ${done} objects in ${Math.round((Date.now() - started) / 1000)} s`);
console.log(prefix);
