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
  // [message] dialogs: skip the story (Escape), then the first startup message.
  { name: 'dead_water-message1', campaign: 'dead_water', viewport: { width: 1920, height: 1080 }, message: true },
  { name: 'dead_water-message2', campaign: 'dead_water', viewport: { width: 1920, height: 1080 }, message: true, messageAdvance: 1 },
  { name: 'liberty-message1', campaign: 'liberty', viewport: { width: 1920, height: 1080 }, message: true },
  { name: 'two_brothers-message1', campaign: 'two_brothers', viewport: { width: 1920, height: 1080 }, message: true },
  { name: 'dead_water-message1-phone', campaign: 'dead_water', viewport: { width: 390, height: 844 }, message: true },
  // Campaign outro: Dead Water's epilogue ends in victory from its start event with no next scenario.
  { name: 'dead_water-outro', campaign: 'dead_water', query: '?scenario=13_Epilogue', viewport: { width: 1920, height: 1080 }, outro: true },
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
    await page.goto(`${base}/play/${shot.campaign}${shot.query ?? ''}`);
    if (shot.outro) {
      // Click through any story, objectives and dialogue until the outro starts.
      const started = Date.now();
      const log = [];
      while (!(await page.$('.outro')) && Date.now() - started < 120000) {
        if (await page.$('.story')) {
          await page.keyboard.press('Escape');
          log.push('story');
        } else if (await page.$('.window[role="dialog"]')) {
          await page.keyboard.press('Enter');
          log.push('message');
        } else {
          const ok = page.getByRole('button', { name: 'OK', exact: true });
          if ((await ok.count()) > 0) {
            await ok.first().click();
            log.push('objectives');
          }
        }
        await page.waitForTimeout(400);
      }
      if (!(await page.$('.outro'))) {
        problems.push(`${shot.name}: outro never appeared (clicked through: ${log.join(',')})`);
        await page.screenshot({ path: path.join(outDir, `${shot.name}-FAILED.png`) });
        await context.close();
        continue;
      }
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(outDir, `${shot.name}-1.png`) });
      const first = await page.evaluate(() => document.querySelector('.outro .text')?.textContent?.trim() ?? null);
      // Next screen: 500 ms fade-in + 3500 ms hold + 500 ms fade-out, then the campaign name fades in.
      await page.waitForTimeout(4500);
      await page.screenshot({ path: path.join(outDir, `${shot.name}-2.png`) });
      const second = await page.evaluate(() => document.querySelector('.outro .text')?.textContent?.trim() ?? null);
      console.log(`${shot.name}: clicked through ${log.join(',') || 'nothing'}; screens: ${JSON.stringify([first, second])}`);
      await context.close();
      continue;
    }
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
    if (shot.message) {
      await page.keyboard.press('Escape');
      try {
        // Scenarios with [objectives] show that dialog first; dismiss it with OK.
        const okButton = page.getByRole('button', { name: 'OK', exact: true });
        await page.waitForFunction(
          () => !!document.querySelector('.window[role="dialog"]') || [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'OK'),
          undefined,
          { timeout: 90000 },
        );
        if (!(await page.$('.window[role="dialog"]')) && (await okButton.count()) > 0) await okButton.first().click();
        await page.waitForSelector('.window[role="dialog"]', { timeout: 90000 });
      } catch {
        problems.push(`${shot.name}: message dialog never appeared`);
        await page.screenshot({ path: path.join(outDir, `${shot.name}-FAILED.png`) });
        await context.close();
        continue;
      }
      for (let i = 0; i < (shot.messageAdvance ?? 0); i++) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
      }
      // Let portraits decode and the board scroll to the speaker.
      await page.waitForTimeout(2500);
      const file = path.join(outDir, `${shot.name}.png`);
      await page.screenshot({ path: file });
      const info = await page.evaluate(() => ({
        title: document.querySelector('.window .title')?.textContent?.trim() ?? null,
        text: (document.querySelector('.window .text')?.textContent ?? '').trim().slice(0, 60),
        portraits: [...document.querySelectorAll('.window img.portrait:not(.probe)')].map((img) => ({
          src: decodeURIComponent(img.getAttribute('src') ?? ''),
          loaded: img.complete && img.naturalWidth > 0,
          left: img.style.left,
          width: img.style.width,
          mirror: img.classList.contains('mirror'),
        })),
      }));
      console.log(`${file}: ${JSON.stringify(info)}`);
      await context.close();
      continue;
    }

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
