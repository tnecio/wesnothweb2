/**
 * Phase 20 Stage 4 verification: screenshots of the story screen, a dialogue line, the objectives
 * dialog, the side panel and the recruit dialog in each language, at desktop (1280x720) and phone
 * (390x844) size, plus automatic checks that nothing overflows its box:
 *
 *   node apps/web/scripts/i18n-screenshots.mjs [--langs pl_PL,ar_AR,fi_FI,hu_HU,cs_CZ] [--base http://localhost:5173]
 *
 * `--scale 150` also sets the font size preference (80-150 %) before loading, and `--fast` swaps Dead
 * Water 1 for the small synthetic scenarios (`synthetic_keyboard` for the story and objectives,
 * `synthetic_dialogue` for a dialogue line, `synthetic_economy` for the side panel and recruit dialog),
 * which reach the same screens in seconds. The accessibility milestone runs
 * `--fast --scale 150` in English and Polish at both sizes.
 *
 * One Dead Water 1 load per language (the opening is slow on a cold image cache); each state is
 * captured at both sizes by resizing the viewport, so the two shots show the very same screen.
 *
 * The automatic check walks every visible element and reports any whose text is wider than its
 * own box and not scrollable (`scrollWidth > clientWidth` with `overflow: visible`), and any
 * element whose box leaves the viewport horizontally -- the failure a long Finnish or Hungarian
 * compound, or a right-to-left layout gone wrong, would produce. Exits non-zero on any overflow.
 * Screenshots land in `i18n-screenshots/<lang>/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { openScenario, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const langs = arg('langs', 'pl_PL,ar_AR,fi_FI,hu_HU,cs_CZ').split(',');
const outRoot = arg('out', 'i18n-screenshots');
const scale = Number(arg('scale', '100'));
const fast = args.includes('--fast');
const SIZES = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
];

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** Elements whose text spills out of their box, or whose box leaves the viewport sideways. */
async function overflows(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || el.closest('canvas')) continue;
      // Only text-bearing leaves: an element whose own text nodes are wider than the box.
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
      if (hasText && el.scrollWidth > el.clientWidth + 1 && !['auto', 'scroll', 'hidden'].includes(style.overflowX) && style.display !== 'inline') {
        bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} text ${el.scrollWidth}px in ${el.clientWidth}px: "${(el.textContent ?? '').trim().slice(0, 40)}"`);
      }
      const modal = el.closest('.modal-box, .window, .story, .side-panel, .top-bar, .menu');
      // Inside a horizontal scroller (the top bar's stat strip) sideways overflow is the design, not a defect.
      let scrolled = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(a).overflowX)) scrolled = true;
      }
      if (modal && !scrolled && hasText && (rect.right > vw + 1 || rect.left < -1) && style.position !== 'fixed') {
        bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} leaves the viewport (${Math.round(rect.left)}..${Math.round(rect.right)} of ${vw}): "${(el.textContent ?? '').trim().slice(0, 40)}"`);
      }
    }
    return [...new Set(bad)].slice(0, 8);
  });
}

async function shoot(page, dir, name) {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir, `${name}-${size.name}.png`) });
    const bad = await overflows(page);
    check(`${dir.split('/').pop()} ${name} @ ${size.name}: nothing overflows`, bad.length === 0, bad.join(' | '));
  }
  await page.setViewportSize({ width: SIZES[0].width, height: SIZES[0].height });
}

const browser = await chromium.launch();
try {
  for (const lang of langs) {
    const dir = path.join(outRoot, fast || scale !== 100 ? `${lang}-${scale}${fast ? '-fast' : ''}` : lang);
    fs.mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: SIZES[0].width, height: SIZES[0].height } });
    await context.addInitScript(([code, fontScale]) => {
      localStorage.setItem('wesnothweb2.language', code);
      if (fontScale !== 100) localStorage.setItem('wesnothweb2.accessibility', JSON.stringify({ fontScale }));
    }, [lang, scale]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    try {
      // menu
      await page.goto(base + '/');
      await page.waitForSelector('[data-testid="title-screen"]');
      await page.waitForTimeout(1500);
      await shoot(page, dir, 'menu');
      // Phase 21: the dialogs the title screen opens, each checked for overflow like every other screen.
      await page.keyboard.press('c');
      await page.waitForSelector('[data-testid="campaign-dialog"]');
      await page.click('[data-testid="campaign-liberty"]');
      await page.waitForTimeout(1500);
      await shoot(page, dir, 'campaigns');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+p');
      await page.waitForSelector('[data-testid="prefs-tab-display"]');
      await shoot(page, dir, 'preferences');
      await page.keyboard.press('Escape');
      await page.keyboard.press(' ');
      await page.waitForSelector('[data-testid="credits-text"]');
      await page.waitForTimeout(800);
      await shoot(page, dir, 'credits');
      await page.keyboard.press('Escape');

      if (fast) {
        // story + objectives + the keyboard scenario's choice dialogue
        await openScenario(page, base, 'synthetic_keyboard');
        await waitBoardReady(page);
        await page.waitForSelector('.story', { timeout: 60000 });
        await page.waitForTimeout(800);
        await shoot(page, dir, 'story');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.window[role="dialog"]', { timeout: 30000 });
        await shoot(page, dir, 'dialogue');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.modal-box .advance', { timeout: 30000 });
        await shoot(page, dir, 'objectives');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        await page.keyboard.press('n');
        await page.waitForTimeout(500);
        await shoot(page, dir, 'side-panel');
      } else {
        await openScenario(page, base, 'dead_water');
        await waitBoardReady(page);
        await page.waitForSelector('.story', { timeout: 60000 });
        await page.waitForTimeout(1500);
        await shoot(page, dir, 'story');
        for (let i = 0; i < 15 && (await page.$('.story')); i++) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(350);
        }

        // the first dialogue line (the objectives dialog, if the scenario opens with it, is dismissed first)
        for (let i = 0; i < 240 && !(await page.$('.window[role="dialog"]')); i++) {
          if (await page.$('.modal-box .advance')) {
            await shoot(page, dir, 'objectives-opening');
            await page.locator('.modal-box .advance').first().click();
          }
          await page.waitForTimeout(500);
        }
        if (await page.$('.window[role="dialog"]')) await shoot(page, dir, 'dialogue');

        // on to play
        let quiet = 0;
        for (let i = 0; i < 150 && quiet < 6; i++) {
          if (await page.$('.story')) await page.keyboard.press('Escape'), (quiet = 0);
          else if (await page.$('.window[role="dialog"]')) await page.keyboard.press('Enter'), (quiet = 0);
          else if (await page.$('.modal-box .advance')) await page.locator('.modal-box .advance').first().click(), (quiet = 0);
          else quiet++;
          await page.waitForTimeout(400);
        }
        await page.keyboard.press('n');
        await page.waitForTimeout(500);
        await shoot(page, dir, 'side-panel');

        // objectives, reopened from Actions (the 7th entry: Recruit, Recall, two Place Label, Clear Labels, Label Settings, Objectives)
        await page.click('.menu-button >> nth=1');
        await page.locator('.dropdown button').nth(6).click();
        await page.waitForTimeout(600);
        if (await page.$('.modal-box .section')) {
          await shoot(page, dir, 'objectives');
          await page.locator('.modal-box .advance').first().click();
        }

      }
      // recruit dialog: the economy debug scenario has a leader on a keep and a real recruit list
      await openScenario(page, base, 'synthetic_economy');
      await waitBoardReady(page);
      await page.waitForTimeout(1500);
      await page.keyboard.press('n');
      await page.waitForTimeout(500);
      await page.click('.menu-button >> nth=1');
      await page.locator('.dropdown button').nth(0).click();
      await page.waitForSelector('.modal-box', { timeout: 10000 }).catch(() => {});
      if (await page.$('.modal-box')) await shoot(page, dir, 'recruit');
      else check(`${lang}: the recruit dialog opened`, false);
    } finally {
      check(`${lang}: no console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await context.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nno overflow in any captured screen');
}
