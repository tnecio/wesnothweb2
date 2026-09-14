/**
 * Phase 16: captures story screen screenshots in headless Chromium for visual
 * checks, and reports console errors and broken image loads.
 *
 *   node apps/web/scripts/story-screenshots.mjs [--base http://localhost:5173] [--out dir]
 *
 * Shots: each campaign's first part, Dead Water's journey part (after its
 * markers are revealed), and Dead Water's first part at phone width.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const outDir = arg('out', 'story-screenshots');
fs.mkdirSync(outDir, { recursive: true });

const shots = [
  { name: 'dead_water-part1', campaign: 'dead_water', viewport: { width: 1920, height: 1080 }, advance: 0 },
  { name: 'dead_water-journey', campaign: 'dead_water', viewport: { width: 1920, height: 1080 }, advance: 5, settleMs: 3500 },
  { name: 'dead_water-part1-phone', campaign: 'dead_water', viewport: { width: 390, height: 844 }, advance: 0 },
  { name: 'liberty-part1', campaign: 'liberty', viewport: { width: 1920, height: 1080 }, advance: 0 },
  { name: 'two_brothers-part1', campaign: 'two_brothers', viewport: { width: 1920, height: 1080 }, advance: 0 },
  { name: 'utbs-part1', campaign: 'under_the_burning_suns', viewport: { width: 1920, height: 1080 }, advance: 0 },
];

const browser = await chromium.launch();
const problems = [];
try {
  for (const shot of shots) {
    const context = await browser.newContext({ viewport: shot.viewport });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`${shot.name}: console error: ${msg.text()}`);
    });
    page.on('response', (res) => {
      const url = res.url();
      if (!/\.(webp|png|jpe?g|woff2)(\?|$)/.test(url)) return;
      const type = res.headers()['content-type'] ?? '';
      if (res.status() >= 400 || type.includes('html')) problems.push(`${shot.name}: bad image response ${res.status()} ${type} ${url}`);
    });
    page.on('pageerror', (err) => problems.push(`${shot.name}: page error: ${err.stack ?? err.message}`));
    await page.goto(`${base}/play/${shot.campaign}`);
    try {
      await page.waitForSelector('.story', { timeout: 60000 });
    } catch {
      problems.push(`${shot.name}: story screen never appeared; page text: ${(await page.evaluate(() => document.body.innerText)).slice(0, 200)}`);
      await page.screenshot({ path: path.join(outDir, `${shot.name}-FAILED.png`) });
      await context.close();
      continue;
    }
    // Let the first fade-in finish and images decode.
    await page.waitForTimeout(1500);
    // A press during a fade only completes it (upstream semantics), so wait for each new part's text to be fully shown.
    const waitForSettledPart = () =>
      page.waitForFunction(() => {
        const text = document.querySelector('.story .text');
        return !!text && getComputedStyle(text).opacity === '1';
      }, undefined, { timeout: 30000 });
    await waitForSettledPart();
    for (let i = 0; i < shot.advance; i++) {
      const before = await page.evaluate(() => document.querySelector('.story .text')?.textContent ?? '');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction((prev) => (document.querySelector('.story .text')?.textContent ?? '') !== prev, before, { timeout: 30000 });
      await waitForSettledPart();
    }
    await page.waitForTimeout(shot.settleMs ?? 800);
    const file = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    const info = await page.evaluate(() => ({
      layers: document.querySelectorAll('.story .layer').length,
      floating: document.querySelectorAll('.story .floating').length,
      title: document.querySelector('.story .title')?.textContent?.trim() ?? null,
      text: (document.querySelector('.story .text')?.textContent ?? '').trim().slice(0, 60),
    }));
    console.log(`${file}: ${JSON.stringify(info)}`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(problems.length ? `\nProblems:\n${problems.join('\n')}` : '\nNo console errors or broken image responses.');
