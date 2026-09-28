#!/usr/bin/env node
/**
 * Phase 28: completes `apps/web/dist` after `vite build` for deployment as Cloudflare Workers static assets.
 *
 * - Copies what the app itself serves from `public/`: scenario snapshots and their databases, image bundles,
 *   story assets, translations and the small JSON files. The `game-images*`/`game-sounds-engine` symlinks
 *   are skipped: that upstream media is uploaded to its own bucket (`upload-game-data.mjs`) and reached
 *   through `VITE_GAME_DATA_URL` (`packages/ui/src/gameData.ts`).
 * - Writes `_headers`. Vite's hashed `assets/` are cached for a year; everything else keeps Cloudflare's
 *   default (revalidate with an ETag) until data files get content-hashed names (PHASE28_PLAN S3). Rules that
 *   match the same path merge their values, so each Cache-Control rule must own a disjoint prefix.
 * - Fails if the upload would break a Workers limit: 20,000 files per version, 25 MiB per file (with margin).
 *
 * Run: node apps/web/scripts/stage-dist.mjs   (after `npm run build --workspace=apps/web`)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(webRoot, 'public');
const distDir = path.join(webRoot, 'dist');
const MAX_FILES = 18000;
const MAX_FILE_BYTES = 24 * 1024 * 1024;

if (!fs.existsSync(path.join(distDir, 'index.html'))) throw new Error('dist/index.html missing: run the Vite build first');

/** Served from the game data bucket instead. */
const EXCLUDED = new Set(['game-images', 'game-images-engine', 'game-sounds-engine']);

for (const name of fs.readdirSync(publicDir)) {
  if (EXCLUDED.has(name) || name.startsWith('.')) continue;
  fs.cpSync(path.join(publicDir, name), path.join(distDir, name), {
    recursive: true,
    dereference: true,
    // Build bookkeeping such as scenarios/.inputs-hash is not served.
    filter: (src) => !path.basename(src).startsWith('.'),
  });
}

fs.writeFileSync(
  path.join(distDir, '_headers'),
  ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
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
const summary = `dist: ${files} files, ${mb(bytes)}; largest ${largest.file} (${mb(largest.size)})`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (files > MAX_FILES) throw new Error(`${files} files: over the ${MAX_FILES}-file budget (Workers allows 20,000 per version)`);
if (largest.size > MAX_FILE_BYTES) throw new Error(`${largest.file} is ${mb(largest.size)}: over the 24 MiB budget (Workers allows 25 MiB per file)`);
