/**
 * Phase 24 milestone: the preferences, hotkeys and unit list in the browser.
 *
 *   node apps/web/scripts/phase24-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 * On `synthetic_economy`:
 *  1. Hotkeys tab: Undo gets Z as well as U; the binding is still there after a reload. Binding R (Redo's)
 *     asks "Reassign Hotkey" and moves it; Defaults puts everything back.
 *  2. Ctrl+A toggles Accelerated speed, announced over the map, and the preference is saved.
 *  3. Alt+U opens the Unit List; Scroll To closes it and the side panel shows the unit.
 *  4. With "Turn prompt" on, the next turn starts with "It is now ...'s turn" over a hidden board.
 *
 * Exits non-zero on any failed step or page error.
 */
import { chromium } from 'playwright';
import { openScenario, skipToPlay, waitBoardReady, confirmEndTurnIfAsked } from './lib/browserFlows.mjs';

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

async function openHotkeys(page) {
  await press(page, 'Control+p');
  await page.locator('[data-testid="prefs-tab-hotkeys"]').click();
  await page.locator('[data-testid="hotkeys-list"]').waitFor({ timeout: 30000 });
}

const keysOf = (page, id) => page.locator(`[data-testid="hotkey-keys-${id}"]`).textContent();

async function start(page) {
  await openScenario(page, base, 'synthetic_economy');
  await waitBoardReady(page);
  await skipToPlay(page);
}

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));

try {
  await start(page);

  // 1. Hotkeys.
  await openHotkeys(page);
  check('Undo starts on U', (await keysOf(page, 'undo')) === 'U', await keysOf(page, 'undo'));
  await page.locator('[data-testid="hotkey-row-undo"]').click();
  await page.locator('[data-testid="hotkeys-add"]').click();
  await page.locator('[data-testid="hotkey-bind"]').waitFor({ timeout: 10000 });
  await press(page, 'z');
  check('Add Hotkey binds Z to Undo', (await keysOf(page, 'undo')) === 'U, Z', await keysOf(page, 'undo'));
  await press(page, 'Escape');
  check('Escape closes the preferences', (await page.locator('[data-testid="hotkeys-list"]').count()) === 0);

  await page.reload();
  await waitBoardReady(page);
  await skipToPlay(page);
  await openHotkeys(page);
  check('the binding survives a reload', (await keysOf(page, 'undo')) === 'U, Z', await keysOf(page, 'undo'));

  await page.locator('[data-testid="hotkey-row-undo"]').click();
  await page.locator('[data-testid="hotkeys-add"]').click();
  await page.locator('[data-testid="hotkey-bind"]').waitFor({ timeout: 10000 });
  await press(page, 'r');
  const reassign = page.getByRole('dialog', { name: 'Reassign Hotkey' });
  check('a key bound elsewhere asks before it moves', (await reassign.count()) === 1);
  await reassign.getByRole('button', { name: 'Yes' }).click();
  await page.waitForTimeout(400);
  check('Undo takes R from Redo', (await keysOf(page, 'undo')) === 'U, Z, R' && (await keysOf(page, 'redo')) === '', `${await keysOf(page, 'undo')} / ${await keysOf(page, 'redo')}`);
  await page.locator('[data-testid="hotkeys-reset"]').click();
  await page.getByRole('button', { name: 'OK', exact: true }).last().click();
  check('Defaults restores U and R', (await keysOf(page, 'undo')) === 'U' && (await keysOf(page, 'redo')) === 'R');
  await press(page, 'Escape');

  // 2. Accelerated speed.
  await press(page, 'Control+a', 800);
  const announced = await page.locator('[data-testid="overlay-label"]').first().textContent().catch(() => '');
  const turboOn = await page.evaluate(() => JSON.parse(localStorage.getItem('wesnothweb2.display') ?? '{}').turbo === true);
  check('Ctrl+A turns Accelerated speed on', turboOn);
  check('and announces it', /Accelerated speed enabled!/.test(announced ?? ''), announced ?? '');
  await press(page, 'Control+a', 800);
  check('Ctrl+A again turns it off', await page.evaluate(() => JSON.parse(localStorage.getItem('wesnothweb2.display') ?? '{}').turbo === false));

  // 3. Unit list.
  await press(page, 'Alt+u');
  const rows = page.locator('[data-testid^="unit-list-row-"]');
  const count = await rows.count();
  check('Alt+U opens the Unit List with the side\'s units', count > 0, `${count} rows`);
  if (count > 0) {
    const typeName = ((await rows.first().locator('td').nth(2).textContent()) ?? '').trim();
    await rows.first().click();
    await page.locator('[data-testid="unit-list-scroll-to"]').click();
    await page.waitForTimeout(800);
    check('Scroll To closes the list', (await rows.count()) === 0);
    const panel = (await page.$$eval('aside, .side-panel', (els) => els.map((e) => e.textContent ?? '').join(' '))).replace(/\s+/g, ' ');
    check('and the side panel shows the unit', panel.includes(typeName), typeName);
  }

  // 4. Turn prompt.
  await press(page, 'Control+p');
  await page.locator('[data-testid="prefs-tab-general"]').click();
  await page.locator('[data-testid="prefs-turnDialog"]').check();
  await press(page, 'Escape');
  await page.locator('[data-testid="turn-button"]').click({ timeout: 60000 });
  await confirmEndTurnIfAsked(page);
  const prompt = page.locator('[data-testid="turn-prompt"]');
  await prompt.waitFor({ timeout: 240000 }).catch(() => {});
  const promptText = (await prompt.textContent().catch(() => '')) ?? '';
  check('the next turn starts with the turn prompt', /It is now/.test(promptText), promptText);
  check('over a hidden board', (await page.locator('.blindfold').count()) === 1);
  await press(page, 'Enter');
  check('Enter dismisses it', (await prompt.count()) === 0);
} catch (err) {
  check('run', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: process.env.SHOT ?? 'phase24-failure.png' }).catch(() => {});
} finally {
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nall passed');
