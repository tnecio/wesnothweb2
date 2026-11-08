#!/usr/bin/env node
/**
 * The deploy's cache of built scenario snapshots (`apps/web/public/scenarios`), kept in the game media bucket as
 * `snapshot-cache/scenarios-<inputs hash>.tar.zst` (~8 MB). GitHub's own cache is scoped to a ref and evicted
 * after 7 days unused, so a tag deploy a week after the last merge, or any staging tag on a branch, rebuilt the
 * snapshots (6-7 minutes) although nothing they are built from had changed. Here one build serves every later
 * deploy, production and staging, until the bucket's lifecycle rule (`r2-lifecycle.json`) expires the object
 * 30 days after its upload; the next deploy then builds and uploads it again.
 *
 *   node apps/web/scripts/snapshot-cache.mjs restore   (before the build: unpacks the set for the current inputs)
 *   node apps/web/scripts/snapshot-cache.mjs save      (after it: uploads the set if it is complete and not there)
 *
 * The hash is `rebuild-snapshots.mjs --inputs-hash`, and the set holds its `.inputs-hash`, so the build's
 * `--if-stale` decides from the restored files whether anything needs building. A set is saved only when its
 * `.inputs-hash` is the current hash (a full, finished build). Neither command fails the deploy: without the
 * cache the build just takes longer. Needs `tar` with zstd. Environment: as `upload-game-data.mjs`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AwsClient } from 'aws4fetch';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(webRoot, 'public');
const hashFile = path.join(publicDir, 'scenarios', '.inputs-hash');
const command = process.argv[2];
const bucket = process.env.R2_BUCKET || 'wesnothweb2-data';

function warn(message) {
  console.log(`::warning::snapshot cache: ${message}`);
}

async function main() {
  if (command !== 'restore' && command !== 'save') throw new Error('usage: snapshot-cache.mjs restore|save');
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }
  const client = new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const hash = execFileSync('node', ['--import', 'tsx', path.join(webRoot, 'scripts/rebuild-snapshots.mjs'), '--inputs-hash'], {
    encoding: 'utf8',
  }).trim();
  const key = `snapshot-cache/scenarios-${hash}.tar.zst`;
  const url = `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
  const archive = path.join(os.tmpdir(), `scenarios-${hash}.tar.zst`);

  if (command === 'restore') {
    const res = await client.fetch(url);
    if (res.status === 404) return console.log(`${key}: not there, the build makes the snapshots`);
    if (!res.ok) return warn(`GET ${key}: ${res.status}`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    fs.rmSync(path.join(publicDir, 'scenarios'), { recursive: true, force: true });
    execFileSync('tar', ['--zstd', '-xf', archive, '-C', publicDir]);
    console.log(`${key}: restored (${(fs.statSync(archive).size / 1e6).toFixed(1)} MB)`);
    return;
  }

  const built = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : '';
  if (built !== hash) return warn(`not saved: public/scenarios is for inputs ${built || '(none)'}, not ${hash}`);
  const head = await client.fetch(url, { method: 'HEAD' });
  if (head.ok) return console.log(`${key}: already there`);
  execFileSync('tar', ['--zstd', '-cf', archive, '-C', publicDir, 'scenarios']);
  const body = fs.readFileSync(archive);
  const put = await client.fetch(url, { method: 'PUT', body, headers: { 'content-type': 'application/zstd' } });
  if (!put.ok) return warn(`PUT ${key}: ${put.status} ${await put.text()}`);
  console.log(`${key}: saved (${(body.length / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => warn(e instanceof Error ? e.message : String(e)));
