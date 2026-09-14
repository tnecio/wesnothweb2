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

/** Runs in the page: SHA-256 of a texture's RGBA pixels, prefixed with its size. */
const hashInPage = async ({ refs, fresh }) => {
  const cache = window.__wesnothDebug.imageCache;
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const out = {};
  for (const ref of refs) {
    const texture = fresh ? await cache.resolveRefForTest(ref) : cache.getRef(ref);
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
    out[ref] = `${w}x${h}:${toHex(await crypto.subtle.digest('SHA-256', pixels))}`;
  }
  return out;
};

async function withScenario(browser, campaign, scenario, fn) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${campaign}] page error: ${e.message}`));
  try {
    await openScenario(page, base, campaign, scenario);
    await waitBoardReady(page);
    return await fn(page);
  } finally {
    await context.close();
  }
}

async function cachedRefs(page) {
  return page.evaluate(() => [...window.__wesnothDebug.imageCache.textures.keys()]);
}

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
    const refs = Object.keys(golden);
    const actual = await withScenario(browser, 'synthetic_combat', undefined, async (page) => {
      const out = {};
      for (let i = 0; i < refs.length; i += 200) Object.assign(out, await page.evaluate(hashInPage, { refs: refs.slice(i, i + 200), fresh: true }));
      return out;
    });
    const diffs = refs.filter((r) => actual[r] !== golden[r]);
    for (const r of diffs.slice(0, 20)) console.log(`DIFF ${r}\n  golden ${golden[r]}\n  actual ${actual[r]}`);
    console.log(`${refs.length - diffs.length}/${refs.length} refs match`);
    if (diffs.length > 0) process.exitCode = 1;
  }
} finally {
  await browser.close();
}
