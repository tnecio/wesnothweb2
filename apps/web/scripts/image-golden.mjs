/**
 * Phase 28a P0: golden pixel hashes for the image pipeline (`ImageCache`).
 *
 *   node apps/web/scripts/image-golden.mjs --record [--base http://localhost:5173]
 *   node apps/web/scripts/image-golden.mjs            # check (default)
 *
 * Record: in headless Chromium against a running dev server, loads Dead
 * Water 1, Liberty 1 and the debug combat scenario (plus one attack, so
 * team-coloured animation frames are included), then hashes every texture
 * the shared ImageCache produced: SHA-256 over its RGBA pixels, read by
 * drawing the texture's source into a fresh canvas. Writes
 * `packages/renderer/fixtures/imagecache-golden.json`.
 *
 * Check: loads the small debug scenario (to initialise image base URLs and
 * team colour data), re-resolves every recorded ref from scratch through the
 * current pipeline and compares hashes. Exits non-zero on any difference or
 * missing image. Later stages (worker compositor, atlases) must pass this
 * unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openScenario, performAttack, skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const record = args.includes('--record');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = path.join(repoRoot, 'packages/renderer/fixtures/imagecache-golden.json');
/** `--log <file>`: progress written synchronously, so it survives the process being killed. */
const logFile = arg('log', null);
const progress = (line) => {
  if (logFile) fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
};

/** Runs in the page: SHA-256 of a texture's RGBA pixels, prefixed with its size. */
const hashInPage = async ({ refs, fresh }) => {
  const cache = window.__wesnothDebug.imageCache;
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const out = {};
  // Resolve the whole batch concurrently (as the board does), then read pixels back one by one.
  const t0 = performance.now();
  const textures = fresh ? await Promise.all(refs.map((ref) => cache.resolveRefForTest(ref))) : refs.map((ref) => cache.getRef(ref));
  const resolveMs = performance.now() - t0;
  let readbackMs = 0;
  for (const [index, ref] of refs.entries()) {
    const texture = textures[index];
    const t1 = performance.now();
    const source = texture?.source?.resource;
    if (!source) {
      out[ref] = null;
      continue;
    }
    const w = source.width;
    const h = source.height;
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0);
    const pixels = g.getImageData(0, 0, w, h).data;
    readbackMs += performance.now() - t1;
    out[ref] = `${w}x${h}:${toHex(await crypto.subtle.digest('SHA-256', pixels))}`;
  }
  out.__timing = { resolveMs: Math.round(resolveMs), readbackMs: Math.round(readbackMs) };
  return out;
};

async function withScenario(browser, campaign, scenario, fn) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${campaign}] page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') progress(`[${campaign}] console ${m.type()}: ${m.text().slice(0, 300)}`);
  });
  try {
    progress(`[${campaign}] opening`);
    await openScenario(page, base, campaign, scenario);
    await waitBoardReady(page);
    progress(`[${campaign}] board ready`);
    return await fn(page);
  } finally {
    await context.close();
  }
}

async function cachedRefs(page) {
  return page.evaluate(() => [...window.__wesnothDebug.imageCache.textures.keys()]);
}

/** Check mode: image requests seen while re-resolving the corpus (bundle images vs individual files). */
let checkFetches = null;

const browser = await chromium.launch();
try {
  if (record) {
    const hashes = {};
    const collect = async (page) => Object.assign(hashes, await page.evaluate(hashInPage, { refs: await cachedRefs(page), fresh: false }));
    for (const campaign of ['dead_water', 'liberty']) {
      await withScenario(browser, campaign, undefined, async (page) => {
        await page.waitForTimeout(3000); // let unit sprites resolve after the terrain
        await collect(page);
      });
      console.log(`${campaign}: ${Object.keys(hashes).length} refs so far`);
    }
    await withScenario(browser, 'synthetic_combat', undefined, async (page) => {
      await skipToPlay(page);
      // Spearman (side 1) at 2,3 attacks the Orcish Grunt (side 2) at 3,3 -- engine 0-based.
      await performAttack(page, { x: 1, y: 2 }, { x: 2, y: 2 });
      await collect(page);
    });
    const missing = Object.entries(hashes).filter(([, h]) => h === null).map(([r]) => r);
    const sorted = Object.fromEntries(Object.entries(hashes).filter(([, h]) => h !== null).sort(([a], [b]) => a.localeCompare(b)));
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(fixture, `${JSON.stringify({ description: 'ImageCache golden pixel hashes (Phase 28a P0); regenerate with apps/web/scripts/image-golden.mjs --record', refs: sorted }, null, 1)}\n`);
    console.log(`recorded ${Object.keys(sorted).length} refs to ${path.relative(repoRoot, fixture)}${missing.length ? ` (${missing.length} unresolvable, skipped)` : ''}`);
  } else {
    const golden = JSON.parse(fs.readFileSync(fixture, 'utf8')).refs;
    // A fixed shuffle, not the fixture's sorted order: sorted refs put hundreds of tiles cut from the
    // same source file into one batch, which the compositor pool (sharded by source path) would route
    // to a single worker. A real board's refs are spread out, so this keeps the check representative.
    const refs = Object.keys(golden)
      .map((ref, i) => ({ ref, key: Math.imul(i + 1, 2654435761) >>> 0 }))
      .sort((a, b) => a.key - b.key)
      .map((e) => e.ref);
    const actual = await withScenario(browser, 'synthetic_combat', undefined, async (page) => {
      // The check never looks at the board; a live render loop under software GL starves the workers.
      const paused = await page.evaluate(() => window.__wesnothDebug.setRenderingPaused?.(true) ?? false);
      progress(`render loop paused: ${paused}`);
      // Take source images from the terrain bundles of every scenario the corpus came from (when built), so
      // the check covers cropping from bundles; anything not bundled is fetched on its own as usual.
      const manifests = ['01_Invasion', '01_The_Raid', 'synth_combat_01'].map((id) => `/atlases/${id}/terrain.json`);
      // ...and every unit type bundle (P6), so unit frames are cropped from bundles too.
      const unitIndex = await page.evaluate(() => fetch('/atlases/units/index.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
      for (const stem of Object.values(unitIndex)) manifests.push(`/atlases/units/${stem}.json`);
      await page.evaluate((urls) => window.__wesnothDebug.imageCache.setAtlasManifests(urls), manifests);
      const fetched = { bundle: 0, file: 0 };
      page.context().on('response', (res) => {
        const url = res.url();
        if (url.includes('/atlases/') && url.endsWith('.png')) fetched.bundle++;
        else if (/\/game-images(-engine)?\/.*\.(png|webp|jpe?g)$/.test(url)) fetched.file++;
      });
      checkFetches = fetched;
      const out = {};
      const t0 = Date.now();
      for (let i = 0; i < refs.length; i += 200) {
        progress(`batch ${i}-${i + 200} start`);
        const batch = await page.evaluate(hashInPage, { refs: refs.slice(i, i + 200), fresh: true });
        const timing = batch.__timing;
        delete batch.__timing;
        Object.assign(out, batch);
        progress(`batch ${i}-${i + 200} done after ${Math.round((Date.now() - t0) / 1000)} s (resolve ${timing?.resolveMs} ms, readback ${timing?.readbackMs} ms)`);
        if (args.includes('--verbose') || logFile) {
          const state = await page.evaluate(() => {
            const cache = window.__wesnothDebug.imageCache;
            const pool = cache.pool;
            return pool
              ? {
                  workers: pool.slots.length,
                  inFlight: pool.slots.map((s) => s.inFlight),
                  high: pool.slots.map((s) => s.high.length),
                  low: pool.slots.map((s) => s.low.length),
                  waiting: pool.waiting.size,
                  pending: cache.pending.size,
                }
              : { pool: String(pool), pending: cache.pending.size };
          });
          const line = `${Math.min(i + 200, refs.length)}/${refs.length} after ${Math.round((Date.now() - t0) / 1000)} s ${JSON.stringify(state)}`;
          progress(line);
          if (args.includes('--verbose')) console.log(line);
        }
      }
      // Which compositor produced these: a silent fallback to in-thread would also match.
      const path = await page.evaluate(async () => {
        const cache = window.__wesnothDebug.imageCache;
        const usable = cache.poolUsable ? await cache.poolUsable : false;
        return cache.pool && usable ? `worker pool (${cache.pool.slots.length} workers)` : 'in-thread';
      });
      console.log(`compositor: ${path}`);
      return out;
    });
    if (checkFetches) console.log(`image fetches during the check: ${checkFetches.bundle} bundle images, ${checkFetches.file} individual files`);
    const diffs = refs.filter((r) => actual[r] !== golden[r]);
    for (const r of diffs.slice(0, 20)) console.log(`DIFF ${r}\n  golden ${golden[r]}\n  actual ${actual[r]}`);
    console.log(`${refs.length - diffs.length}/${refs.length} refs match`);
    if (diffs.length > 0) process.exitCode = 1;
  }
} finally {
  await browser.close();
}
