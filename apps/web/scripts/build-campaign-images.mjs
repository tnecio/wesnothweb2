/**
 * Phase 18: lists every file under each shipped campaign's binary paths'
 * `images/` dirs (its own, then included resources such as
 * `internal/Rogue_Mage`: `lib/binaryPaths.mjs`), relative to each, into
 * `packages/ui/src/campaignImages.json` -- so an image
 * path WML hands over at run time (`[item] image=`, a halo, ...) can be
 * looked up the way the engine's image search does: the campaign's own
 * `images/` first (its `[binary_path]`), then core.
 *
 *   node apps/web/scripts/build-campaign-images.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { campaignBinaryPaths } from './lib/binaryPaths.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const campaigns = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8')).campaigns;

const dataRoot = path.join(repoRoot, 'wesnoth/data');

/** Every file under `root`, relative to it. */
function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(p).isDirectory());
      if (isDir) walk(p);
      else files.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

// Per campaign, its binary paths' images/ in search order (`campaignBinaryPaths`).
const out = {};
for (const c of campaigns) {
  if (!c.wesnothId) continue;
  const dirs = campaignBinaryPaths(dataRoot, c.wesnothId);
  const paths = {};
  for (const dir of dirs) {
    const files = listFiles(path.join(dataRoot, dir, 'images'));
    if (files.length > 0) paths[`${dir}/images`] = files;
  }
  out[c.wesnothId] = paths;
}
const target = path.join(repoRoot, 'packages/ui/src/campaignImages.json');
fs.writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
console.log(
  `wrote ${path.relative(repoRoot, target)}: ${Object.entries(out)
    .map(([k, v]) => `${k} ${Object.values(v).map((f) => f.length).join('+')}`)
    .join(', ')}`,
);

// The engine's own images/ (the game root's binary path), where core has no file of the same name.
const engineRoot = path.join(repoRoot, 'wesnoth/images');
const coreImages = path.join(repoRoot, 'wesnoth/data/core/images');
const engineImages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(png|webp|jpg)$/.test(e.name) && !e.name.includes('@2x')) {
      const rel = path.relative(engineRoot, p).split(path.sep).join('/');
      if (!fs.existsSync(path.join(coreImages, rel))) engineImages.push(rel);
    }
  }
})(engineRoot);
const engineTarget = path.join(repoRoot, 'packages/ui/src/engineImages.json');
fs.writeFileSync(engineTarget, JSON.stringify(engineImages.sort(), null, 1) + '\n');
console.log(`wrote ${path.relative(repoRoot, engineTarget)}: ${engineImages.length}`);
