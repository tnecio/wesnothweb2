/**
 * Phase 33: how much of each frame the board costs on a big map -- Heir to the Throne 1 after Konrad leaves home
 * (56x26 hexes, 43 units, hundreds of animated terrain images), the board a player reported as slow.
 *
 *   node apps/web/scripts/perf-playthrough.mjs [--base http://localhost:5173] [--only day,night] [--no-budget]
 *
 * Each fixture (`fixtures/perf-httt1-battle*.json.gz`, built by `packages/ui/scripts/build-perf-fixture.ts`) is
 * uploaded through the title screen's Load dialog and opened. Then, with the CPU profiler on:
 *   - idle, 10 s (after 20 s for the units' first frames to reach the atlas pages): the ticker's JS per frame
 *     (PixiJS's render and everything the board animates); how many times a second PixiJS rebuilds its render
 *     instructions (`_buildInstructions`: a structure change, or a sprite's texture changing source); how many
 *     draw calls a frame takes;
 *   - panning, 8 s: the camera gliding corner to corner (`scrollToHex`, 'scroll'), the same numbers.
 * And that the board's images drawn from the atlas pages (`packages/renderer/src/atlasPages.ts`) are byte for byte
 * their originals.
 * Everything measured is CPU-side, so it means the same here (software WebGL) as on a real machine, except that
 * at this VM's ~1 frame a second the per-frame numbers carry what a real machine spreads over many frames; what
 * the GPU costs is not measured. It fails when a number is over its budget (below).
 */
import { chromium } from 'playwright';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipToPlay } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:5173';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : ['day', 'night'];
const budgets = !args.includes('--no-budget');
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Per-frame budgets, in ms of main-thread JS. */
const BUDGET = { idleTick: 2.5, idleRebuildsPerSecond: 0.2, idleDrawCalls: 60, panTick: 3, panRebuildsPerSecond: 0.2 };

const failures = [];
function check(label, value, limit, unit = 'ms') {
  const ok = !budgets || value <= limit;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${value.toFixed(2)} ${unit}${budgets ? ` (budget ${limit})` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch();

async function openFixture(file) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('wesnothweb2.statsConsent', 'no'));
  await page.goto(base);
  await page.click('[data-testid="title-load"]');
  await page.setInputFiles('.modal-box input[type="file"]', path.join(fixtures, file));
  await page.waitForTimeout(2500);
  await page.locator('.modal-box [data-list-option]').first().click();
  await page.locator('.modal-box').getByRole('button', { name: 'Load', exact: true }).click();
  await page.waitForSelector('[data-testid="board-loading"]', { state: 'detached', timeout: 1500000 });
  await skipToPlay(page);
  await page.waitForFunction(() => !!window.__wesnothDebug?.board?.(), null, { timeout: 600000 });
  // Counts PixiJS's instruction rebuilds and the draw calls.
  await page.evaluate(() => {
    const renderer = window.__wesnothDebug.board().atlas.renderer;
    const rgs = renderer.renderGroup;
    const build = rgs._buildInstructions.bind(rgs);
    window.__perf = { builds: 0, draws: 0 };
    rgs._buildInstructions = (...a) => {
      window.__perf.builds++;
      return build(...a);
    };
    const gl = renderer.gl;
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const draw = gl[name]?.bind(gl);
      if (draw) gl[name] = (...a) => { window.__perf.draws++; return draw(...a); };
    }
  });
  await page.waitForTimeout(20000);
  return { page, errors };
}

/** Profiles `seconds` of frames while `during` runs; returns per-frame ms of the ticker and of instruction rebuilds. */
async function profileFrames(page, seconds, during = async () => {}) {
  const before = await page.evaluate(() => ({ ...window.__perf }));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const counting = page.evaluate(
    (ms) => new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < ms) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); }),
    seconds * 1000,
  );
  await during();
  const frames = await counting;
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.detach();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map();
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] ?? 0;
    const seen = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) {
      const k = byId.get(x).callFrame.functionName;
      if (seen.has(k)) continue;
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + dt);
    }
  });
  const perFrame = (k) => (incl.get(k) ?? 0) / 1000 / Math.max(1, frames);
  const after = await page.evaluate(() => ({ ...window.__perf }));
  return {
    frames,
    fps: frames / seconds,
    tick: perFrame('_tick'),
    rebuild: perFrame('_buildInstructions'),
    rebuildsPerSecond: (after.builds - before.builds) / seconds,
    drawCalls: (after.draws - before.draws) / Math.max(1, frames),
  };
}

for (const [label, file] of [['day', 'perf-httt1-battle.json.gz'], ['night', 'perf-httt1-battle-night.json.gz']]) {
  if (!only.includes(label)) continue;
  const { page, errors } = await openFixture(file);
  const scene = await page.evaluate(() => {
    const b = window.__wesnothDebug.board();
    let total = 0;
    let filtered = 0;
    const walk = (x) => {
      total++;
      if (x.filters?.length) filtered++;
      for (const c of x.children ?? []) walk(c);
    };
    walk(b.stage);
    return { objects: total, animatedCycles: b.frameClock?.size ?? null, atlasPages: b.atlas?.size ?? null, filteredContainers: filtered, units: window.__wesnoth.session.board.allUnits().length, tod: window.__wesnoth.session.currentTimeOfDay.id };
  });
  console.log(`\n== ${label}: ${JSON.stringify(scene)}`);
  // The copies in the atlas pages are their originals, byte for byte (a sample of the terrain's and the units').
  const pixels = await page.evaluate(() => {
    const atlas = window.__wesnothDebug.board().atlas;
    let compared = 0;
    let differing = 0;
    let images = 0;
    for (const original of window.__wesnothDebug.imageCache.textures.values()) {
      const copy = original && !original.destroyed && atlas.copyOf(original);
      if (!copy || copy === original) continue;
      const a = atlas.renderer.extract.pixels(original).pixels;
      const b = atlas.renderer.extract.pixels(copy).pixels;
      images++;
      compared += a.length;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
      if (images >= 40) break;
    }
    return { images, compared, differing };
  });
  console.log(`   atlas copies: ${pixels.images} images, ${pixels.compared} bytes compared, ${pixels.differing} differ`);
  if (pixels.images === 0 || pixels.differing > 0) {
    console.log(`FAIL ${label}: atlas copies are not their originals`);
    failures.push(`${label} atlas copies`);
  }
  const idle = await profileFrames(page, 10);
  console.log(`   idle: ${idle.fps.toFixed(1)} fps here (software GPU); rebuilds ${idle.rebuild.toFixed(2)} ms per frame`);
  check(`${label} idle: ticker JS per frame`, idle.tick, BUDGET.idleTick);
  check(`${label} idle: instruction rebuilds per second`, idle.rebuildsPerSecond, BUDGET.idleRebuildsPerSecond, '/s');
  check(`${label} idle: draw calls per frame`, idle.drawCalls, BUDGET.idleDrawCalls, '');
  const pan = await profileFrames(page, 8, async () => {
    for (let i = 0; i < 4; i++) {
      await page.evaluate(([x, y]) => window.__wesnothDebug.scrollToHex(x, y, 'scroll'), i % 2 ? [2, 2] : [52, 23]);
      await page.waitForTimeout(1500);
    }
  });
  console.log(`   panning: ${pan.fps.toFixed(1)} fps here; rebuilds ${pan.rebuild.toFixed(2)} ms per frame; ${pan.drawCalls.toFixed(0)} draw calls per frame`);
  check(`${label} panning: ticker JS per frame`, pan.tick, BUDGET.panTick);
  check(`${label} panning: instruction rebuilds per second`, pan.rebuildsPerSecond, BUDGET.panRebuildsPerSecond, '/s');
  if (errors.length) {
    console.log(`FAIL ${label}: page errors ${errors.join(' | ')}`);
    failures.push(`${label} page errors`);
  }
  await page.context().close();
}

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} over budget: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nALL WITHIN BUDGET');
