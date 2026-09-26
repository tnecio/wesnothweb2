/**
 * Phase 19: lists every music and sound file that ships, into
 * `packages/ui/src/audioFiles.json` -- so the player can tell whether a
 * `[music] name=`/`[sound] name=` exists (`resolve_track_path`) and where it
 * lives, campaign first and then core, as the binary-path search does.
 *
 *   node apps/web/scripts/build-audio-files.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const data = path.join(repoRoot, 'wesnoth/data');
const campaigns = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8')).campaigns;

function list(root) {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(p).isDirectory());
      if (isDir) walk(p);
      else if (/\.(ogg|wav|mp3|flac)$/i.test(e.name)) files.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

// `sounds/` beside `data/` holds the engine's own sounds (turn bell, button and menu clicks), served at /game-sounds-engine.
const out = { music: { core: list(path.join(data, 'core/music')) }, sounds: { core: list(path.join(data, 'core/sounds')), engine: list(path.join(data, '../sounds')) } };
for (const c of campaigns) {
  if (!c.wesnothId) continue;
  const music = list(path.join(data, 'campaigns', c.wesnothId, 'music'));
  const sounds = list(path.join(data, 'campaigns', c.wesnothId, 'sounds'));
  if (music.length > 0) out.music[c.wesnothId] = music;
  if (sounds.length > 0) out.sounds[c.wesnothId] = sounds;
}
const target = path.join(repoRoot, 'packages/ui/src/audioFiles.json');
fs.writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
const count = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.length}`).join(', ');
console.log(`wrote ${path.relative(repoRoot, target)}: music ${count(out.music)}; sounds ${count(out.sounds)}`);
