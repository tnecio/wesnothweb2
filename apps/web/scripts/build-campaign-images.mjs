/**
 * Phase 18: lists every file under each shipped campaign's `images/` dir,
 * relative to it, into `packages/ui/src/campaignImages.json` -- so an image
 * path WML hands over at run time (`[item] image=`, a halo, ...) can be
 * looked up the way the engine's image search does: the campaign's own
 * `images/` first (its `[binary_path]`), then core.
 *
 *   node apps/web/scripts/build-campaign-images.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const campaignsDir = path.join(repoRoot, 'wesnoth/data/campaigns');
const campaigns = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8')).campaigns;

const out = {};
for (const c of campaigns) {
  if (!c.wesnothId) continue;
  const root = path.join(campaignsDir, c.wesnothId, 'images');
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
  out[c.wesnothId] = files.sort();
}
const target = path.join(repoRoot, 'packages/ui/src/campaignImages.json');
fs.writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${path.relative(repoRoot, target)}: ${Object.entries(out).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
