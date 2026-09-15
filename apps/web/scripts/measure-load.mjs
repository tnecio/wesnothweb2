/**
 * Phase 28a P0: board load and animation start metrics in headless Chromium
 * against a running dev server.
 *
 *   node apps/web/scripts/measure-load.mjs [--base http://localhost:5173] [--runs 1] [--warm]
 *
 * Per real scenario (Dead Water 1, Liberty 1, UtBS 1), from a cold context:
 * - boardReadyMs: navigation -> `[data-board-ready]` (terrain rendered)
 * - terrainImagesMs: the `board:terrain-images` measure (ImageCache preload)
 * - blockedMs / maxLongTaskMs / longTasks: long tasks (> 50 ms) until board
 *   ready + 3 s; blocked time counts each task's time over 50 ms
 * - imageRequests / imageKB: image fetches in that window
 * - heapMB: used JS heap afterwards (Chromium only)
 *
 * Attack (debug combat scenario): one attack after the board is ready --
 * first/max `anim:frames` measure (time to resolve an animation's frames
 * before it can start), image requests and long tasks during the exchange.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { openScenario, performAttack, skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const runs = Number(arg('runs', '1'));
// --warm: after the cold load, reload the page in the same context and count image requests that still reach
// the network (Phase 28a P7: content-hashed bundles served `immutable` should come from the HTTP cache).
const warm = args.includes('--warm');

function installObservers() {
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push({ start: e.startTime, ms: e.duration });
  }).observe({ type: 'longtask', buffered: true });
  window.__imageRequests = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (/\.(png|webp|jpe?g)(\?|$)/.test(e.name)) window.__imageRequests.push({ start: e.startTime, bytes: e.encodedBodySize || e.decodedBodySize || 0 });
    }
  }).observe({ type: 'resource', buffered: true });
}

const summarise = (tasks) => ({
  longTasks: tasks.length,
  maxLongTaskMs: Math.round(Math.max(0, ...tasks.map((t) => t.ms))),
  blockedMs: Math.round(tasks.reduce((s, t) => s + Math.max(0, t.ms - 50), 0)),
});

/**
 * Counts image requests at the network level. The page's own resource timing
 * does not see fetches made inside Web Workers (the compositor pool), so it
 * would undercount once compositing moved off the main thread.
 */
function countImageRequests(context) {
  // `requests`/`bytes` count what actually crossed the network; responses served from the HTTP cache
  // (e.g. a second compositor worker asking for the same immutable bundle) are counted in `cacheHits`.
  const counter = { requests: 0, bytes: 0, cacheHits: 0, urls: [], frozen: false };
  context.on('requestfinished', async (request) => {
    if (counter.frozen || !/\.(png|webp|jpe?g)(\?|$)/.test(request.url())) return;
    const sizes = await request.sizes().catch(() => null);
    if (!sizes || sizes.responseHeadersSize <= 0) {
      counter.cacheHits++;
      return;
    }
    counter.requests++;
    counter.urls.push(new URL(request.url()).pathname);
    counter.bytes += Math.max(0, sizes.responseBodySize);
  });
  return counter;
}

async function measureScenario(browser, campaign) {
  const viewport = { width: 1920, height: 1080 };
  // Warm mode needs a disk cache like a real profile: a plain context's in-memory cache does not keep
  // Dead Water 1's ~5 MB terrain bundle, which would show up as a download on reload.
  const profileDir = warm ? fs.mkdtempSync(path.join(os.tmpdir(), 'measure-load-')) : null;
  const context = profileDir ? await chromium.launchPersistentContext(profileDir, { viewport }) : await browser.newContext({ viewport });
  await context.addInitScript(installObservers);
  const network = countImageRequests(context);
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await openScenario(page, base, campaign);
    await waitBoardReady(page);
    const boardReadyMs = Math.round(await page.evaluate(() => performance.now()));
    await page.waitForTimeout(3000);
    network.frozen = true;
    const result = await page.evaluate(
      ({ boardReadyMs }) => {
        const until = boardReadyMs + 3000;
        const tasks = window.__longTasks.filter((t) => t.start <= until);
        const images = window.__imageRequests.filter((r) => r.start <= until);
        const terrain = performance.getEntriesByName('board:terrain-images')[0];
        const terrainLayout = performance.getEntriesByName('board:terrain-layout')[0];
        return {
          boardReadyMs,
          terrainLayoutMs: terrainLayout ? Math.round(terrainLayout.duration) : null,
          terrainImagesMs: terrain ? Math.round(terrain.duration) : null,
          tasks,
          pageImageRequests: images.length,
          heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        };
      },
      { boardReadyMs },
    );
    // Which work actually ran off the main thread (an in-thread fallback would look the same otherwise).
    const workers = [...new Set(page.workers().map((w) => w.url().replace(/^.*\//, '').replace(/[?#].*$/, '')))];
    const cold = { ...result, imageRequests: network.requests, imageKB: Math.round(network.bytes / 1024), imageCacheHits: network.cacheHits, workers };
    if (!warm) return cold;

    // Playwright's `request.sizes()` reports header sizes for disk-cache hits too, so the counter above cannot
    // tell a cached bundle from a download. CDP's cache flags can (bundles are fetched by the page itself,
    // in `CompositorPool`; per-file images fetched inside workers are not seen here).
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const bundles = { network: [], cached: 0 };
    cdp.on('Network.responseReceived', ({ response }) => {
      const url = new URL(response.url).pathname;
      if (!url.startsWith('/atlases/') || !url.endsWith('.png')) return;
      if (response.fromDiskCache || response.fromMemoryCache) bundles.cached++;
      else bundles.network.push(`${response.status} ${url}`);
    });
    await page.reload();
    await waitBoardReady(page);
    await page.waitForTimeout(3000);
    return { ...cold, warmBundlesCached: bundles.cached, warmBundlesFromNetwork: bundles.network };
  } finally {
    await context.close();
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function measureAttack(browser) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(installObservers);
  const network = countImageRequests(context);
  const page = await context.newPage();
  try {
    await openScenario(page, base, 'synthetic_combat');
    await waitBoardReady(page);
    await skipToPlay(page);
    await page.waitForTimeout(2000);
    const requestsBefore = network.requests;
    const before = await page.evaluate(() => ({ at: performance.now() }));
    await performAttack(page, { x: 1, y: 2 }, { x: 2, y: 2 });
    const result = await page.evaluate((before) => {
      const frames = performance.getEntriesByName('anim:frames').map((e) => e.duration);
      return {
        animations: frames.length,
        firstFramesMs: frames.length ? Math.round(frames[0]) : null,
        maxFramesMs: Math.round(Math.max(0, ...frames)),
        tasks: window.__longTasks.filter((t) => t.start >= before.at),
      };
    }, before);
    return { ...result, imageRequests: network.requests - requestsBefore, imageUrls: network.urls.slice(requestsBefore) };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();
const rows = [];
try {
  for (let run = 1; run <= runs; run++) {
    for (const campaign of ['dead_water', 'liberty', 'under_the_burning_suns']) {
      const r = await measureScenario(browser, campaign);
      rows.push({ run, what: campaign, ...r, ...summarise(r.tasks), tasks: undefined });
    }
    const a = await measureAttack(browser);
    rows.push({ run, what: 'attack (synthetic_combat)', ...a, ...summarise(a.tasks), tasks: undefined });
  }
} finally {
  await browser.close();
}

for (const r of rows) console.log(JSON.stringify(r));
console.log('\nwhat                        run  boardReady  terrainImg  blocked  maxTask  longTasks  imgReq   imgKB  heapMB  animFirst/max');
for (const r of rows) {
  const cell = (v, n) => String(v ?? '-').padStart(n);
  console.log(
    `${r.what.padEnd(27)} ${cell(r.run, 3)} ${cell(r.boardReadyMs, 11)} ${cell(r.terrainImagesMs, 11)} ${cell(r.blockedMs, 8)} ${cell(r.maxLongTaskMs, 8)} ${cell(r.longTasks, 10)} ${cell(r.imageRequests, 7)} ${cell(r.imageKB, 7)} ${cell(r.heapMB, 7)}  ${r.firstFramesMs !== undefined ? `${r.firstFramesMs}/${r.maxFramesMs} (${r.animations})` : ''}`,
  );
}
