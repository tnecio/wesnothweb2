/**
 * Phase 26 milestone: drives the save manager in a real browser against a
 * running dev server, covering the parts that cannot be unit-tested under
 * this project's node-only vitest setup -- IndexedDB, the file picker and
 * the browser download.
 *
 *   node apps/web/scripts/save-load-playthrough.mjs [--base http://localhost:5173]
 *
 * What it checks, in order:
 *   1. Save Game names a slot the way real Wesnoth would (`<abbrev>-<scenario> Turn <n>`).
 *   2. A save survives a full page reload and is listed with its real metadata.
 *   3. Ending a turn writes an autosave, and scenario start wrote one too.
 *   4. Download produces a real Wesnoth `.gz` -- gzipped WML, with the
 *      root attributes the game insists on.
 *   5. Uploading that file back imports it as a new save.
 *   6. Loading a save from another campaign switches campaign AND url, so
 *      the next save is filed under the right campaign (a real, reported
 *      bug: it used to keep the campaign from the URL).
 *
 * Dead Water 1's opening is a real cutscene whose beats take seconds, so
 * "no dialogue on screen right now" is not the same as "the opening is
 * over" -- `settle` waits for a quiet stretch instead. Getting that wrong
 * is what made an earlier version of this script look like the game had
 * deadlocked when it was simply waiting for input.
 */
import { chromium } from 'playwright';
import * as zlib from 'node:zlib';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openScenario, waitBoardReady, skipToPlay } from './lib/browserFlows.mjs';

const baseIndex = process.argv.indexOf('--base');
const BASE = baseIndex === -1 ? 'http://localhost:5173' : process.argv[baseIndex + 1];

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Waits until nothing has asked for input for `quietMs` -- see the header. */
async function settle(page, quietMs = 10000) {
  let quietSince = Date.now();
  for (let i = 0; i < 250; i++) {
    if (await page.$('.modal-box')) {
      await page.keyboard.press('Escape');
      quietSince = Date.now();
    } else if (await page.$('.dismiss, .window[role="dialog"]')) {
      await page.keyboard.press('Enter');
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
    await page.waitForTimeout(400);
  }
}

/**
 * Opens Save Game and stores the slot. Retries the hotkey rather than
 * trusting a fixed quiet window: `GameShell` deliberately ignores hotkeys
 * while a `[message]` is up or events are running, and this scenario's
 * opening keeps producing both for a while after the board is ready.
 */
async function saveAs(page, name) {
  const dialog = page.locator('.modal-box[aria-label="Save Game"]');
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await page.$('.dismiss, .window[role="dialog"]')) await page.keyboard.press('Enter');
    await page.keyboard.press('Control+s');
    try {
      await dialog.waitFor({ timeout: 3000 });
      break;
    } catch {
      if (attempt === 19) throw new Error('Save Game never opened');
    }
  }
  const field = dialog.locator('input[type=text]');
  const suggested = await field.inputValue();
  await field.fill(name);
  // Enter, not a click on Save: the dialog is the app's one real typing
  // target and submits on Enter, and pressing it cannot be intercepted by
  // whatever else the board is drawing at that moment.
  await field.press('Enter');
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
  return suggested;
}

async function openLoadDialog(page) {
  const dialog = page.locator('.modal-box[aria-label="Load Game"]');
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await page.$('.dismiss, .window[role="dialog"]')) await page.keyboard.press('Enter');
    await page.keyboard.press('Control+o');
    try {
      await dialog.waitFor({ timeout: 3000 });
      return dialog;
    } catch {
      // keep trying -- see `saveAs`
    }
  }
  throw new Error('Load Game never opened');
}

/** Plays one turn, answering the dialogue the AI turn raises -- the game genuinely waits on it. */
async function endTurn(page) {
  const status = async () => (await page.locator('.top-bar .status').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const before = await status();
  await page.keyboard.press('Control+Space');
  for (let i = 0; i < 90; i++) {
    if (await page.$('.dismiss, .window[role="dialog"]')) await page.keyboard.press('Enter');
    const now = await status();
    if (now !== before && /Turn \d+/.test(now) && !now.startsWith(before.slice(0, 12))) break;
    await page.waitForTimeout(1000);
  }
  await settle(page, 5000);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => {
  console.log(`${at()} PAGEERROR ${String(e).slice(0, 200)}`);
  failures++;
});
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`${at()} CONSOLE-ERR ${m.text().slice(0, 200)}`);
});

try {
  // --- 1. save a named slot -------------------------------------------
  await openScenario(page, BASE, 'dead_water', '01_Invasion');
  await waitBoardReady(page);
  await skipToPlay(page);
  await settle(page);
  console.log(`${at()} Dead Water 1 ready`);

  const suggested = await saveAs(page, 'probe-manual');
  check('Save Game suggests upstream\'s own name', /^DW-Invasion! Turn \d+$/.test(suggested), suggested);

  // --- 2. an autosave per turn ----------------------------------------
  await endTurn(page);
  let dialog = await openLoadDialog(page);
  let names = (await dialog.locator('tbody tr td:first-child').allInnerTexts()).map((n) => n.replace(/\s+/g, ' ').trim());
  check('the named save is listed', names.some((n) => n.startsWith('probe-manual')), names.join(' | ').slice(0, 160));
  check('a turn autosave was written', names.some((n) => n.includes('Auto-Save')), names.join(' | ').slice(0, 160));
  check('a start-of-scenario save was written', names.some((n) => n.startsWith('DW-Invasion!') && !n.includes('Auto-Save')), names.join(' | ').slice(0, 160));

  // --- 3. download it as a real Wesnoth save --------------------------
  await dialog.getByRole('button', { name: 'probe-manual' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    dialog.getByRole('button', { name: 'Download' }).click(),
  ]);
  check('download is named after the save, with .gz', download.suggestedFilename() === 'probe-manual.gz', download.suggestedFilename());
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wesnothweb2-save-')), 'probe-manual.gz');
  await download.saveAs(file);
  const wml = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  check('the file is gzipped WML, not this port\'s JSON', wml.startsWith('version='), wml.slice(0, 40));
  for (const key of ['campaign="Dead_Water"', 'campaign_define="CAMPAIGN_DEAD_WATER"', '[snapshot]', '[replay_start]', '[replay]']) {
    check(`it carries ${key}`, wml.includes(key));
  }

  // --- 4. upload it back ----------------------------------------------
  await dialog.locator('input[type=file]').setInputFiles(file);
  await page.waitForTimeout(4000);
  names = (await dialog.locator('tbody tr td:first-child').allInnerTexts()).map((n) => n.replace(/\s+/g, ' ').trim());
  check('uploading a Wesnoth save imports it', names.filter((n) => n.includes('DW-Invasion!')).length >= 2, names.join(' | ').slice(0, 200));
  await page.keyboard.press('Escape');

  // --- 5. survive a full page reload ----------------------------------
  await page.reload();
  await waitBoardReady(page);
  await skipToPlay(page);
  await settle(page);
  dialog = await openLoadDialog(page);
  names = (await dialog.locator('tbody tr td:first-child').allInnerTexts()).map((n) => n.replace(/\s+/g, ' ').trim());
  check('saves survive a full page reload', names.some((n) => n.startsWith('probe-manual')), names.join(' | ').slice(0, 160));
  const row = await dialog.locator('tbody tr', { hasText: 'probe-manual' }).innerText();
  check('rows carry campaign/scenario/turn metadata', /Dead Water/.test(row) && /Invasion/.test(row), row.replace(/\s+/g, ' ').slice(0, 120));
  await page.keyboard.press('Escape');

  // --- 6. loading another campaign's save switches campaign AND url ---
  await openScenario(page, BASE, 'two_brothers', '01_Rooting_Out_a_Mage');
  await waitBoardReady(page);
  await skipToPlay(page);
  await settle(page);
  await saveAs(page, 'probe-other-campaign');

  await openScenario(page, BASE, 'dead_water', '01_Invasion');
  await waitBoardReady(page);
  await skipToPlay(page);
  await settle(page);
  dialog = await openLoadDialog(page);
  await dialog.getByRole('button', { name: 'probe-other-campaign' }).click();
  await dialog.getByRole('button', { name: 'Load', exact: true }).click();
  await waitBoardReady(page);
  await settle(page, 6000);
  check('the url follows the loaded save\'s campaign', page.url().includes('/play/two_brothers'), page.url());
  const nextName = await saveAs(page, 'probe-after-switch');
  check('the next save is named for the loaded campaign', nextName.startsWith('AToTB-'), nextName);

  console.log(`${at()} ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
} finally {
  await browser.close();
}

process.exit(failures === 0 ? 0 : 1);
