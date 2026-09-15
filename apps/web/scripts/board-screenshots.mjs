/**
 * Phase 28a: rendered-board screenshots, the second gate next to the golden
 * pixel hashes -- the hashes pin each texture's pixels, this pins what
 * actually reaches the screen (texture upload, alpha handling, layering).
 *
 *   node apps/web/scripts/board-screenshots.mjs --out <dir> [--base http://localhost:5173]
 *   node apps/web/scripts/board-screenshots.mjs --out <dir> --compare <baseline dir>
 *
 * For Dead Water 1, Liberty 1 and the debug combat scenario: skip to play,
 * wait for the board, let unit sprites settle, screenshot the board area.
 * Compare mode counts differing pixels per image with ImageMagick
 * `compare -metric AE` and exits non-zero on any difference.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { openScenario, skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const outDir = arg('out', 'board-screenshots');
const baselineDir = arg('compare', null);
const settleMs = Number(arg('settle-ms', '4000'));
const scenarios = arg('only', 'dead_water,liberty,synthetic_combat').split(',');

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const campaign of scenarios) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    try {
      await openScenario(page, base, campaign);
      await waitBoardReady(page);
      await skipToPlay(page);
      // Park the pointer outside the board so no hover highlight is drawn.
      await page.mouse.move(1910, 1070);
      await page.waitForTimeout(settleMs);
      // Animated terrain would otherwise be captured on an arbitrary frame.
      const frozen = await page.evaluate(() => window.__wesnothDebug?.freezeAnimationsForCapture() ?? false);
      if (!frozen) throw new Error('freezeAnimationsForCapture dev hook unavailable');
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const board = await page.$('.board-view .canvas-host');
      await board.screenshot({ path: path.join(outDir, `${campaign}.png`) });
      console.log(`captured ${path.join(outDir, `${campaign}.png`)}`);
    } catch (err) {
      await page.screenshot({ path: path.join(outDir, `${campaign}-FAILED.png`) });
      console.error(`${campaign}: ${err.message} (see ${campaign}-FAILED.png)`);
      process.exitCode = 1;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

if (baselineDir) {
  let failed = false;
  for (const campaign of scenarios) {
    const a = path.join(baselineDir, `${campaign}.png`);
    const b = path.join(outDir, `${campaign}.png`);
    let differing;
    try {
      // `compare` exits 1 when images differ; the metric is printed on stderr either way.
      execFileSync('compare', ['-metric', 'AE', a, b, 'null:'], { stdio: ['ignore', 'ignore', 'pipe'] });
      differing = 0;
    } catch (err) {
      differing = Number(String(err.stderr).trim().split(/\s+/)[0]);
      if (!Number.isFinite(differing)) throw err;
    }
    console.log(`${campaign}: ${differing} differing pixels`);
    if (differing !== 0) failed = true;
  }
  if (failed) process.exitCode = 1;
}
