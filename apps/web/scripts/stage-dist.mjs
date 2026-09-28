#!/usr/bin/env node
/**
 * Phase 28: completes `apps/web/dist` after `vite build` for deployment as Cloudflare Workers static assets.
 *
 * - Copies what the app itself serves from `public/` (scenario snapshots and their databases, image bundles,
 *   story assets, translations, the small JSON files) to content-hashed paths, `h/<hash>/<path>`, and writes
 *   `h/<hash>/data-manifest.json` mapping each path to its URL; `index.html` names the manifest in
 *   `window.__WESNOTH_DATA_MANIFEST__` (read by `packages/ui/src/dataUrls.ts`). A file's URL changes exactly
 *   when its content does, so everything under `h/` is cached for a year. Image bundle manifests name their
 *   PNGs relative to themselves; they are rewritten to the PNGs' hashed URLs before being hashed.
 *   The `game-images*`/`game-sounds-engine` symlinks are skipped: that upstream media is uploaded to its own
 *   bucket (`upload-game-data.mjs`) and reached through `VITE_GAME_DATA_URL` (`packages/ui/src/gameData.ts`).
 * - Writes `_headers`: Vite's hashed `assets/` and `h/` are immutable; `index.html` keeps Cloudflare's default
 *   (revalidate with an ETag). Rules that match the same path merge their values, so each Cache-Control rule
 *   must own a disjoint prefix.
 * - Fails if the upload would break a Workers limit: 20,000 files per version, 25 MiB per file (with margin).
 *
 * Run: node apps/web/scripts/stage-dist.mjs   (after `npm run build --workspace=apps/web`)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(webRoot, 'public');
const distDir = path.join(webRoot, 'dist');
const MAX_FILES = 18000;
const MAX_FILE_BYTES = 24 * 1024 * 1024;

if (!fs.existsSync(path.join(distDir, 'index.html'))) throw new Error('dist/index.html missing: run the Vite build first');

/** Served from the game data bucket instead. */
const EXCLUDED = new Set(['game-images', 'game-images-engine', 'game-sounds-engine']);

/** Every file the app serves from `public/`, as paths relative to it. Dot files (build bookkeeping) are not served. */
function publicFiles(dir = publicDir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || (!rel && EXCLUDED.has(e.name))) continue;
    const p = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (fs.statSync(p).isDirectory()) out.push(...publicFiles(p, r));
    else out.push(r);
  }
  return out;
}

const hashed = new Map();
function publish(rel, content) {
  const url = `/h/${createHash('sha256').update(content).digest('hex').slice(0, 16)}/${rel}`;
  const out = path.join(distDir, url);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content);
  hashed.set(rel, url);
}

const all = publicFiles();
const isBundleManifest = (rel) => rel.startsWith('atlases/') && rel.endsWith('.json');
for (const rel of all.filter((r) => !isBundleManifest(r))) publish(rel, fs.readFileSync(path.join(publicDir, rel)));
for (const rel of all.filter(isBundleManifest)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, rel), 'utf8'));
  const dir = rel.slice(0, rel.lastIndexOf('/') + 1);
  for (const atlas of manifest.atlases ?? []) {
    const url = hashed.get(dir + atlas.file);
    if (!url) throw new Error(`${rel} names ${atlas.file}, which was not published`);
    atlas.file = url;
  }
  publish(rel, JSON.stringify(manifest));
}

const manifestJson = JSON.stringify(Object.fromEntries([...hashed].sort(([a], [b]) => a.localeCompare(b))));
publish('data-manifest.json', manifestJson);
const manifestUrl = hashed.get('data-manifest.json');
const indexFile = path.join(distDir, 'index.html');
const html = fs.readFileSync(indexFile, 'utf8');
if (!html.includes('</title>')) throw new Error('index.html has no </title> to insert the data manifest after');
fs.writeFileSync(indexFile, html.replace('</title>', `</title>\n    <script>window.__WESNOTH_DATA_MANIFEST__ = ${JSON.stringify(manifestUrl)};</script>`));

fs.writeFileSync(
  path.join(distDir, '_headers'),
  [
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/h/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n'),
);

let files = 0;
let bytes = 0;
let largest = { size: 0, file: '' };
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const size = fs.statSync(p).size;
      files++;
      bytes += size;
      if (size > largest.size) largest = { size, file: path.relative(distDir, p) };
    }
  }
};
walk(distDir);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const summary = `dist: ${files} files, ${mb(bytes)}; largest ${largest.file} (${mb(largest.size)}); data manifest ${manifestUrl} (${hashed.size - 1} files)`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (files > MAX_FILES) throw new Error(`${files} files: over the ${MAX_FILES}-file budget (Workers allows 20,000 per version)`);
if (largest.size > MAX_FILE_BYTES) throw new Error(`${largest.file} is ${mb(largest.size)}: over the 24 MiB budget (Workers allows 25 MiB per file)`);
