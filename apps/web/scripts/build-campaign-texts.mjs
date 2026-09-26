#!/usr/bin/env node
/**
 * Phase 20: gives each real campaign in `public/campaigns.json` its upstream `name` and
 * `description` as translatable strings (`{"t": [[domain, msgid], ...]}`), read from the
 * campaign's own `[campaign]` block, so the menu shows them in the player's language with
 * upstream's own translations. Synthetic debug campaigns keep their plain English text.
 *
 * Run after editing campaigns.json or updating the wesnoth data:
 *   node --import tsx apps/web/scripts/build-campaign-texts.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir } from '../../../packages/engine/src/wml/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const file = path.join(repoRoot, 'apps/web/public/campaigns.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const campaign of manifest.campaigns) {
  if (!campaign.wesnothId || !campaign.define) continue;
  const flag = (defines, name) => defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<build-campaign-texts>' });
  const defines = new Map();
  flag(defines, campaign.define);
  flag(defines, 'NORMAL');
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const main = parseWmlFile(path.join(dataRoot, 'campaigns', campaign.wesnothId, '_main.cfg'), { dataRoot, defines });
  const block = main.child('campaign');
  if (!block) throw new Error(`no [campaign] in ${campaign.wesnothId}`);
  for (const key of ['name', 'description']) {
    const t = block.getTString(key);
    if (!t || !t.translatable) throw new Error(`${campaign.wesnothId}: ${key} is not translatable`);
    campaign[key] = t.toJSON();
  }
}
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
console.log('updated campaigns.json');
