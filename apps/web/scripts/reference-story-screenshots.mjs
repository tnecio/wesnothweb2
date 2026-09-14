/**
 * Phase 16 N8: reference story screen screenshots from the installed
 * Battle for Wesnoth binary, for side-by-side comparison with
 * `story-screenshots.mjs`.
 *
 *   node apps/web/scripts/reference-story-screenshots.mjs [--out dir] [--parts 6] [--campaign Dead_Water,Liberty]
 *
 * Runs `/usr/games/wesnoth --campaign <id>` inside a private Xvfb display at
 * 1920x1080, captures the screen with ImageMagick `import` once the story
 * has had time to load, then presses Space (next part) and captures again.
 *
 * The installed binary is 1.16.9 while this project's data is 1.19.21:
 * story WML and art largely match, dialog theming does not exactly -- the
 * user accepted it as a layout reference (docs/IMPLEMENTATION_PLAN.md,
 * Phase 16 decisions), not a pixel-exact one.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = arg('out', 'reference-screenshots');
const maxParts = Number(arg('parts', '6'));
const campaigns = arg('campaign', 'Dead_Water,Liberty,Two_Brothers,Under_the_Burning_Suns').split(',');
const binary = arg('binary', '/usr/games/wesnoth');
/** How long the game gets to start and load a campaign's first story part. */
const startupMs = Number(arg('startup-ms', '45000'));
const partMs = Number(arg('part-ms', '2500'));

fs.mkdirSync(outDir, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureCampaign(campaign, displayNumber) {
  const display = `:${displayNumber}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await delay(1500);
  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'wesnoth-ref-'));
  const env = { ...process.env, DISPLAY: display, SDL_AUDIODRIVER: 'dummy' };
  const game = spawn(binary, ['--campaign', campaign, '--resolution', '1920x1080', '--nosound', '--userdata-dir', userdata], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  game.stderr.on('data', (d) => (stderr += d));

  const shots = [];
  try {
    await delay(startupMs);
    for (let part = 0; part < maxParts; part++) {
      if (game.exitCode !== null) break;
      const file = path.join(outDir, `ref-${campaign}-part${part + 1}.png`);
      execFileSync('import', ['-window', 'root', file], { env });
      shots.push(file);
      execFileSync('xdotool', ['key', 'space'], { env });
      await delay(partMs);
    }
  } finally {
    game.kill('SIGTERM');
    await delay(1000);
    if (game.exitCode === null) game.kill('SIGKILL');
    xvfb.kill('SIGTERM');
    fs.rmSync(userdata, { recursive: true, force: true });
  }
  if (shots.length === 0) console.error(`${campaign}: no screenshots; game stderr tail:\n${stderr.slice(-800)}`);
  return shots;
}

let displayNumber = 97;
for (const campaign of campaigns) {
  const shots = await captureCampaign(campaign, displayNumber++);
  console.log(`${campaign}: ${shots.join(', ')}`);
}
