/**
 * Phase 25 milestone: statistics and achievements in the browser.
 *
 *   node apps/web/scripts/phase25-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 *  1. `synthetic_combat`: the hero attacks the orc (keyboard, as `keyboard-playthrough.mjs`); S opens the
 *     statistics dialog, whose damage and hits rows now count that attack and whose scenario menu offers
 *     "All Scenarios" and this scenario.
 *  2. The title screen's Achievements button opens the dialog; The South Guard's group lists its
 *     achievements, "Completed 0/9". An earned one (as the game records it) shows completed, and is still
 *     there after a reload.
 *
 * Exits non-zero on any failed step or page error.
 */
import { chromium } from 'playwright';
import { openScenario, skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const headed = args.includes('--headed');

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function press(page, key, settleMs = 500) {
  await page.keyboard.press(key);
  await page.waitForTimeout(settleMs);
}

const browser = await chromium.launch({ headless: !headed });
const pageErrors = [];
try {
  // ---- 1. statistics -------------------------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    try {
      await openScenario(page, base, 'synthetic_combat');
      await waitBoardReady(page);
      await skipToPlay(page);
      await page.waitForTimeout(800);
      await press(page, 's', 1000);
      const before = (await page.locator('[data-testid="stats-damage"]').textContent()) ?? '';
      check('S opens the statistics dialog', before.includes('Inflicted'), before.replace(/\s+/g, ' ').slice(0, 80));
      check('nothing inflicted before any attack', /\+0% \(0 \+ 0\)/.test(before));
      await press(page, 'Escape');

      await press(page, 'ArrowRight'); // the cursor on the hero
      await press(page, 'Enter', 600); // select it
      await press(page, 'ArrowRight'); // onto the adjacent orc
      await press(page, 'Enter', 1500); // the attack dialog
      await press(page, 'Enter', 8000); // confirm
      await press(page, 's', 1000);
      const damage = ((await page.locator('[data-testid="stats-damage"]').textContent()) ?? '').replace(/\s+/g, ' ');
      const hits = ((await page.locator('[data-testid="stats-hits"]').textContent()) ?? '').replace(/\s+/g, ' ');
      check('the attack is counted: expected damage is no longer 0', !/Inflicted \+0% \(0 \+ 0\)/.test(damage), damage.slice(0, 120));
      check('and the hits, with an a-priori probability', /Inflicted[^T]*\(\d/.test(hits) && /\d+\.\d|100/.test(hits), hits.slice(0, 160));
      const options = await page.locator('[data-testid="stats-scenario"] option').allTextContents();
      check('the scenario menu: All Scenarios, then this scenario', options.length === 2 && options[0] === 'All Scenarios', options.join(' / '));
      await press(page, 'Escape');
    } finally {
      await context.close();
    }
  }

  // ---- 2. achievements -----------------------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const openTsg = async () => {
      await page.locator('[data-testid="title-achievements"]').click({ timeout: 120000 });
      const select = page.locator('[data-testid="achievements-group"]');
      await select.waitFor({ timeout: 30000 });
      await select.selectOption({ label: 'The South Guard' });
      await page.waitForTimeout(400);
    };
    try {
      await page.goto(base);
      await openTsg();
      const rows = await page.locator('[data-testid^="achievement-"]').count();
      const count = (await page.locator('[data-testid="achievements-count"]').textContent()) ?? '';
      check('the title screen opens The South Guard\'s achievements', rows === 9, `${rows} rows`);
      check('none earned yet', count.trim() === 'Completed 0/9', count);
      await press(page, 'Escape');

      // What [set_achievement] content_for=the_south_guard id=tsg_s01 records.
      await page.evaluate(() => localStorage.setItem('wesnothweb2.achievements', JSON.stringify({ the_south_guard: { tsg_s01: { done: true } } })));
      await page.reload();
      await openTsg();
      const after = (await page.locator('[data-testid="achievements-count"]').textContent()) ?? '';
      const earned = await page.locator('[data-testid="achievement-tsg_s01"]').getAttribute('class');
      check('an earned achievement shows completed after a reload', after.trim() === 'Completed 1/9' && /achieved/.test(earned ?? ''), after);
    } finally {
      await context.close();
    }
  }
} catch (err) {
  check('run', false, err instanceof Error ? err.message : String(err));
} finally {
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nall passed');
