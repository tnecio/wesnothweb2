/**
 * Phase 16 N0/N5: measures the story screen's load path in a real browser
 * (headless Chromium via Playwright) against a running dev server.
 *
 *   node apps/web/scripts/measure-story.mjs [--base http://localhost:5173] [--campaign dead_water] [--parts 4]
 *
 * For each campaign, a COLD run (fresh browser context, empty cache) and a
 * WARM run (same context, page reloaded) report:
 * - scenario JSON: bytes and fetch+parse time
 * - first story paint: navigation start -> the story overlay's text visible
 * - per part: image bytes and time from "Next" click until every image the
 *   part displays has finished loading
 * - long tasks (> 50 ms) observed while the story is open
 *
 * Output is one JSON object per run plus a readable summary table.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const base = arg('base', 'http://localhost:5173');
const campaigns = arg('campaign', 'dead_water,liberty,under_the_burning_suns').split(',');
const maxParts = Number(arg('parts', '4'));
// Defaults target the Phase 16 viewer; the N0 baseline used `.story-overlay` / `.story-overlay .advance`.
const storySelector = arg('story-selector', '.story');
const nextSelector = arg('next-selector', '.story .arrow[aria-label="Next"]');

/** Installed before any page script: collects long tasks and image resource timings. */
function installObservers() {
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) });
  }).observe({ type: 'longtask', buffered: true });
}

async function imageEntries(page) {
  return page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((e) => /\.(webp|png|jpe?g|avif)(\?|$)/.test(e.name) && !e.name.includes('/units/') && !e.name.includes('/terrain/'))
      .map((e) => ({
        name: decodeURIComponent(e.name.replace(/^https?:\/\/[^/]+/, '')),
        start: Math.round(e.startTime),
        end: Math.round(e.responseEnd),
        bytes: e.encodedBodySize || e.decodedBodySize,
        transfer: e.transferSize,
      })),
  );
}

/** Resolves once every <img>/CSS background image under the story overlay is loaded (or 15s). */
async function waitForStoryImages(page) {
  return page.evaluate(async (sel) => {
    const t0 = performance.now();
    const root = document.querySelector(sel);
    if (!root) return { ms: 0, urls: [] };
    const urls = new Set();
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el instanceof HTMLImageElement && el.src) urls.add(el.src);
      const bg = getComputedStyle(el).backgroundImage;
      for (const m of bg.matchAll(/url\("?([^")]+)"?\)/g)) urls.add(m[1]);
    }
    await Promise.race([
      Promise.all(
        [...urls].map(
          (u) =>
            new Promise((resolve) => {
              const img = new Image();
              img.onload = img.onerror = resolve;
              img.src = u;
              if (img.complete) resolve();
            }),
        ),
      ),
      new Promise((r) => setTimeout(r, 15000)),
    ]);
    return { ms: Math.round(performance.now() - t0), urls: [...urls].map((u) => decodeURIComponent(u.replace(/^https?:\/\/[^/]+/, ''))) };
  }, storySelector);
}

async function measure(page, campaign, label, reload) {
  const navStart = Date.now();
  if (reload) await page.reload({ waitUntil: 'commit' });
  else await page.goto(`${base}/play/${campaign}`, { waitUntil: 'commit' });

  await page.waitForSelector(storySelector, { state: 'visible', timeout: 60000 });
  const firstPaintMs = Date.now() - navStart;
  const firstImages = await waitForStoryImages(page);

  const scenario = await page.evaluate(() => {
    const e = performance.getEntriesByType('resource').find((r) => r.name.includes('/scenarios/'));
    return e ? { bytes: e.encodedBodySize || e.decodedBodySize, transfer: e.transferSize, fetchMs: Math.round(e.responseEnd - e.startTime), responseEnd: Math.round(e.responseEnd) } : null;
  });

  // What the player feels: the first part's text fully faded in, and each Next until the next part's text is fully shown.
  const textShown = () =>
    page.waitForFunction(() => {
      const t = document.querySelector('.story .text');
      return !!t && getComputedStyle(t).opacity === '1';
    }, undefined, { timeout: 60000 });
  await textShown();
  const settledMs = Date.now() - navStart;

  const parts = [{ part: 0, imagesMs: firstImages.ms, images: firstImages.urls, advanceMs: 0 }];
  for (let i = 1; i < maxParts; i++) {
    const next = await page.$(nextSelector);
    if (!next) break;
    // Never press the final "Continue": it runs the scenario's startup events synchronously, which is not story cost.
    if ((await next.textContent())?.trim() === 'Continue') break;
    const before = await page.evaluate(() => document.querySelector('.story .text')?.textContent ?? '');
    const pressedAt = Date.now();
    await next.evaluate((el) => el.click());
    const stillStory = await page.$(storySelector);
    if (!stillStory) break;
    await page.waitForFunction((prev) => (document.querySelector('.story .text')?.textContent ?? '') !== prev, before, { timeout: 60000 });
    await textShown();
    const advanceMs = Date.now() - pressedAt;
    const r = await waitForStoryImages(page);
    parts.push({ part: i, imagesMs: r.ms, images: r.urls, advanceMs });
  }

  const images = await imageEntries(page);
  const longTasks = await page.evaluate(() => window.__longTasks);
  // What the page downloaded while the story was up, largest first -- attributes long tasks to their likely parse cost.
  const topResources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => ({ name: e.name.replace(/^https?:\/\/[^/]+/, ''), kb: Math.round((e.decodedBodySize || 0) / 1024), end: Math.round(e.responseEnd) }))
      .sort((a, b) => b.kb - a.kb)
      .slice(0, 5),
  );
  const byName = new Map(images.map((e) => [e.name, e]));
  for (const p of parts) {
    p.bytes = p.images.reduce((s, u) => s + (byName.get(u)?.bytes ?? 0), 0);
    p.networkBytes = p.images.reduce((s, u) => s + (byName.get(u)?.transfer ?? 0), 0);
  }
  return { campaign, label, firstPaintMs, settledMs, scenario, parts, topResources, longTasks, maxLongTaskMs: Math.max(0, ...longTasks.map((t) => t.ms)) };
}

const browser = await chromium.launch();
const results = [];
try {
  for (const campaign of campaigns) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addInitScript(installObservers);
    const page = await context.newPage();
    const cold = await measure(page, campaign, 'cold', false);
    const warm = await measure(page, campaign, 'warm', true);
    results.push(cold, warm);
    await context.close();
  }
} finally {
  await browser.close();
}

for (const r of results) console.log(JSON.stringify(r));
console.log('\ncampaign                 run   firstPaint  textShown  scenarioKB  part:imgKB/nextMs ...                       maxLongTask');
for (const r of results) {
  const parts = r.parts.map((p) => `${p.part}:${Math.round(p.bytes / 1024)}/${p.advanceMs}`).join(' ');
  console.log(
    `${r.campaign.padEnd(24)} ${r.label.padEnd(5)} ${String(r.firstPaintMs).padStart(10)} ${String(r.settledMs).padStart(10)} ${String(Math.round((r.scenario?.bytes ?? 0) / 1024)).padStart(11)}  ${parts.padEnd(42)} ${r.maxLongTaskMs}`,
  );
}
