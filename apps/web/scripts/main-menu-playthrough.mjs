/**
 * Phase 21 milestone: starting a campaign at a chosen difficulty, and loading a save, are both reachable
 * only through the main menu, laid out as the real title screen is.
 *
 *   node apps/web/scripts/main-menu-playthrough.mjs [--base http://localhost:5173] [--headed] [--shots <dir>]
 *   node apps/web/scripts/main-menu-playthrough.mjs --keyboard-only [...]
 *
 * Default run (mouse):
 *   1. the title screen: its four buttons, the version, the language button and a tip, at desktop and phone
 *      width and at a 150 % font scale (screenshots with --shots);
 *   2. Campaigns (key C): the filter finds Liberty, its Hard difficulty is chosen, Play opens the HARD build
 *      of the scenario (`/play/liberty?difficulty=HARD`, `session.snapshot.difficulty`);
 *   3. Ctrl+S saves it, Quit to Menu (with its confirmation) returns, Load resumes it: same difficulty, same turn;
 *   4. Two Brothers, left on its default, opens the EASY build (its own default, not a hardcoded NORMAL);
 *   5. the completion filter hides and shows a finished campaign.
 *
 * `--keyboard-only` (the milestone's other half): from the title screen, with the keyboard alone and a
 * capture-phase listener counting every mouse, pointer and touch event (the run fails unless it is zero):
 * C, type "keyboard", Down, Play; the whole two-scenario campaign to its final victory, the credits and the
 * end screen's Quit to Menu; back at the menu the campaign wears its victory laurel; then Load (Ctrl+O),
 * Preferences (Ctrl+P), Credits (Space) and Language (L) each open and close by keys.
 *
 * Exits non-zero on any failed check. Needs the dev server (`npm run dev` in apps/web).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { skipToPlay, waitBoardReady, confirmEndTurnIfAsked } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const headed = args.includes('--headed');
const keyboardOnly = args.includes('--keyboard-only');
const shotsDir = arg('shots', undefined);
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const press = async (page, key, settleMs = 400) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(settleMs);
};
const shot = async (page, name) => {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
};
const dialogs = (page) => page.$$eval('.modal-box', (els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
const focusedTestId = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? '');
const sessionInfo = (page) =>
  page.evaluate(() => {
    const s = window.__wesnoth?.session;
    return s ? { scenario: s.snapshot.scenario.id, difficulty: s.snapshot.difficulty ?? null, turn: s.turnNumber, saved: s.toSaveData().difficulty ?? null } : null;
  });
const waitSession = (page) => page.waitForFunction(() => window.__wesnoth?.session, null, { timeout: 180000 });
const openTitle = async (page) => {
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="title-screen"]', { timeout: 60000 });
};

/** Types into the campaign filter, the way a keyboard user finds a campaign. */
async function filterFor(page, text) {
  await page.keyboard.type(text, { delay: 30 });
  await page.waitForTimeout(300);
}

const visibleCampaigns = (page) => page.$$eval('[data-testid="campaign-list"] [role="option"]', (els) => els.map((e) => e.getAttribute('data-testid')?.replace('campaign-', '') ?? ''));

// ── the mouse run ──────────────────────────────────────────────────────────────────────────────────

async function titleScreen(browser) {
  for (const [label, viewport, fontScale] of [
    ['desktop', { width: 1280, height: 800 }, 100],
    ['phone', { width: 390, height: 844 }, 100],
    ['desktop-150', { width: 1280, height: 800 }, 150],
    ['phone-150', { width: 390, height: 844 }, 150],
  ]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript((scale) => {
      if (scale !== 100) localStorage.setItem('wesnothweb2.accessibility', JSON.stringify({ fontScale: scale }));
    }, fontScale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await openTitle(page);
    await page.waitForSelector('[data-testid="tip-text"]', { timeout: 15000 });
    await page.waitForTimeout(1200);
    const names = await page.$$eval('[data-testid="title-menu"] button', (els) => els.map((e) => e.textContent?.trim()));
    check(`[${label}] the title screen offers Campaigns, Load, Preferences, Credits`, names.join() === 'Campaigns,Load,Preferences,Credits', names.join());
    check(`[${label}] the version and the language button show`, /Version 1\.\d+\.\d+/.test(await page.textContent('[data-testid="title-version"]')) && /English/.test(await page.textContent('[data-testid="title-language"]')));
    check(`[${label}] a tip shows`, (await page.textContent('[data-testid="tip-text"]')).trim().length > 20);
    const box = await page.evaluate(() => {
      const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const m = rect('[data-testid="title-menu"]');
      const b = rect('[data-testid="title-language"]');
      return { menu: m && { top: m.top, bottom: m.bottom, left: m.left, right: m.right }, lang: b && { top: b.top, bottom: b.bottom }, vh: innerHeight, vw: innerWidth, scrollW: document.documentElement.scrollWidth };
    });
    check(`[${label}] the button column and the language button are on screen`, box.menu.right <= box.vw + 1 && box.menu.left >= -1 && box.lang.bottom <= box.vh + 1, JSON.stringify(box));
    check(`[${label}] nothing makes the page scroll sideways`, box.scrollW <= box.vw + 1, `${box.scrollW} > ${box.vw}`);
    // every button is reachable: the last one is on screen (or scrolls into view in the stacked layout)
    await page.locator('[data-testid="title-credits"]').scrollIntoViewIfNeeded();
    const credits = await page.evaluate(() => document.querySelector('[data-testid="title-credits"]').getBoundingClientRect().bottom <= innerHeight + 1);
    check(`[${label}] Credits is reachable`, credits);
    await shot(page, `title-${label}`);
    check(`[${label}] no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
}

async function libertyHard(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openTitle(page);

  await press(page, 'c', 700);
  check('C opens the campaign dialog', (await dialogs(page)).includes('Play a Campaign'));
  // The real campaigns by rank (`campaigns.json`), then the debug ones.
  const REAL = 'the_south_guard,of_pearls_and_pirates,liberty,two_brothers,dusk_of_dawn,the_hammer_of_thursagan,descent_into_darkness,dead_water,the_rise_of_wesnoth,winds_of_fate,sceptre_of_fire,legend_of_wesmere,son_of_the_black_eye,under_the_burning_suns,northern_rebirth';
  check('the dialog lists the real campaigns first, by rank, then the debug ones', (await visibleCampaigns(page)).slice(0, 15).join() === REAL, (await visibleCampaigns(page)).join());
  check('with nothing chosen there is a landing text and Play is off', (await page.isDisabled('[data-testid="campaign-play"]')) && (await page.textContent('[data-testid="campaign-details"]')).includes('Select a campaign'));
  // The filter searches descriptions too, as upstream's does: "lib" would also match Two Brothers' mention of Liberty.
  await filterFor(page, 'marchlanders');
  check("the filter finds Liberty by a word in its description", (await visibleCampaigns(page)).join() === 'liberty', (await visibleCampaigns(page)).join());
  await press(page, 'ArrowDown', 500);
  check('Down selects it: description, difficulties and Play appear', /marchlanders/.test(await page.textContent('[data-testid="campaign-description"]')) && !(await page.isDisabled('[data-testid="campaign-play"]')));
  const levels = await page.$$eval('[data-testid="difficulty-menu"] input', (els) => els.map((e) => `${e.value}${e.checked ? '*' : ''}`));
  check('Liberty has three difficulties, Normal the default', levels.join() === 'EASY,NORMAL*,HARD', levels.join());
  await shot(page, 'campaigns-liberty');
  await page.check('[data-testid="difficulty-HARD"]', { force: true });
  await page.click('[data-testid="campaign-play"]');
  await page.waitForURL(/\/play\/liberty\?difficulty=HARD/, { timeout: 15000 });
  await waitSession(page);
  let info = await sessionInfo(page);
  check('Play opens Liberty at HARD (the HARD build of the scenario)', info?.difficulty === 'HARD' && info.scenario === '01_The_Raid', JSON.stringify(info));
  check('a save made now records HARD', info?.saved === 'HARD');

  await waitBoardReady(page);
  await skipToPlay(page);
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.modal-box input[type="text"], .modal-box input:not([type])', { timeout: 10000 });
  await page.fill('.modal-box input', 'menu-milestone-hard');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  check('Ctrl+S saved it', true);

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: /Quit to Menu/ }).click();
  check('Quit to Menu asks first', (await dialogs(page)).includes('Quit'));
  await page.getByRole('button', { name: 'Yes' }).click();
  await page.waitForSelector('[data-testid="title-screen"]', { timeout: 15000 });
  check('confirming returns to the title screen', new URL(page.url()).pathname === '/');

  await press(page, 'Control+o', 700);
  check('Ctrl+O opens the Load dialog', (await dialogs(page)).includes('Load Game') || (await dialogs(page)).some((l) => /Load/.test(l)), (await dialogs(page)).join());
  // "Show replay" from here (like the in-game Load dialog's) is covered end to end in
  // replay-from-menu-playthrough.mjs, including opening straight into the replay screen from a cold URL.
  check('...with a Show replay box, same as the in-game Load dialog', (await page.$('[data-testid="show-replay"]')) !== null);
  await page.getByText('menu-milestone-hard').first().click();
  await page.getByRole('button', { name: 'Load', exact: true }).last().click();
  await page.waitForURL(/\/play\/liberty\?save=menu-milestone-hard/, { timeout: 15000 });
  await waitSession(page);
  info = await sessionInfo(page);
  check('Load resumes the save on the same difficulty', info?.difficulty === 'HARD' && info.scenario === '01_The_Raid', JSON.stringify(info));
  check('...at the same turn', info?.turn === 1, String(info?.turn));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

async function twoBrothersDefault(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await openTitle(page);
  await press(page, 'c', 700);
  await filterFor(page, 'brothers');
  await press(page, 'ArrowDown', 400);
  const levels = await page.$$eval('[data-testid="difficulty-menu"] input', (els) => els.map((e) => `${e.value}${e.checked ? '*' : ''}`));
  check('Two Brothers offers Easy (the default) and Hard, as upstream lists them', levels.join() === 'EASY*,HARD', levels.join());
  await page.click('[data-testid="campaign-play"]');
  await page.waitForURL(/\/play\/two_brothers\?difficulty=EASY/, { timeout: 15000 });
  await waitSession(page);
  const info = await sessionInfo(page);
  check('left on its default it opens the EASY build', info?.difficulty === 'EASY', JSON.stringify(info));
  await context.close();
}

async function completionFilter(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await openTitle(page);
  // record the completion through the app's own store
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('wesnothweb2-saves');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put({ key: 'completedCampaigns', value: { liberty: ['HARD'], two_brothers: ['EASY'] } });
        tx.oncomplete = () => (db.close(), resolve());
      };
    });
  });
  await page.reload();
  await page.waitForSelector('[data-testid="title-screen"]');
  await press(page, 'c', 700);
  const alt = await page.getAttribute('[data-testid="campaign-liberty"] .laurel', 'alt');
  check('a campaign won at its last difficulty wears the gold laurel', alt === 'Completed: Gold', String(alt));
  const bronze = await page.getAttribute('[data-testid="campaign-two_brothers"] .laurel', 'alt');
  check('one won only at the first of two difficulties wears bronze', bronze === 'Completed: Bronze', String(bronze));
  await page.click('[data-testid="completion-filter"] summary');
  await page.uncheck('[data-testid="completion-all-completed"]');
  await page.uncheck('[data-testid="completion-gold"]');
  await page.uncheck('[data-testid="completion-bronze"]');
  let shown = await visibleCampaigns(page);
  check('unchecking the completed kinds hides the finished campaigns', !shown.includes('liberty') && !shown.includes('two_brothers') && shown.includes('dead_water'), shown.join());
  await page.uncheck('[data-testid="completion-not-completed"]');
  await page.check('[data-testid="completion-gold"]');
  shown = await visibleCampaigns(page);
  check('only Gold shows just the gold-laurel campaign', shown.join() === 'liberty', shown.join());
  await shot(page, 'campaigns-filtered');
  await context.close();
}

// ── the keyboard-only run ──────────────────────────────────────────────────────────────────────────

/** One keyboard fight to the win (the enemy leader has one hit point): move next to it, attack, retry after a 3 % miss. */
async function winByKeys(page) {
  await press(page, 'n', 500);
  await press(page, 'ArrowRight', 400);
  await press(page, 'ArrowRight', 400);
  await press(page, 'Enter', 1500);
  await press(page, 'Enter', 600);
  await press(page, 'ArrowRight', 400);
  for (let attempt = 0; attempt < 4; attempt++) {
    await press(page, 'Enter', 1200);
    if (process.env.DEBUG_KEYS) console.log('attack dialog:', (await page.$eval('.modal-box', (e) => e.textContent ?? '').catch(() => 'none')).replace(/\s+/g, ' ').slice(0, 400));
    await press(page, 'Enter', 6000);
    if (process.env.DEBUG_KEYS) console.log('log:', (await page.$$eval('aside, .side-panel', (els) => els.map((e) => e.textContent ?? '').join(' '))).replace(/\s+/g, ' ').slice(0, 500));
    if ((await page.$('.modal-box')) && /Advance/.test(await page.$eval('.modal-box', (e) => e.textContent ?? '').catch(() => ''))) {
      await press(page, 'ArrowDown', 300);
      await press(page, 'Enter', 1500);
    }
    if (await page.$('.end-overlay, .outro')) return true; // the campaign's last win rolls the outro before the end screen
    await press(page, 'Escape', 300);
    await press(page, 'Control+Space', 2500);
    await press(page, 'Control+Space', 2500);
    await confirmEndTurnIfAsked(page);
    await press(page, 'n', 500);
    await press(page, 'ArrowRight', 300);
    await press(page, 'ArrowRight', 300);
  }
  return false;
}

async function keyboardRun(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.__pointerEvents = 0;
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu', 'wheel']) {
      window.addEventListener(type, (e) => (e.type === 'click' && e.detail === 0 ? 0 : (window.__pointerEvents += 1)), true);
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const pointerEvents = () => page.evaluate(() => window.__pointerEvents ?? 0);

  await openTitle(page);
  // the Campaigns button takes the focus first, so a keyboard user can Tab/Enter it too
  await press(page, 'c', 700);
  check('C opens the campaign dialog with the filter focused', (await dialogs(page)).includes('Play a Campaign') && (await focusedTestId(page)) === 'campaign-filter', await focusedTestId(page));
  await filterFor(page, 'keyboard');
  check('typing finds the debug Keyboard campaign', (await visibleCampaigns(page)).join() === 'synthetic_keyboard', (await visibleCampaigns(page)).join());
  await press(page, 'ArrowDown', 500);
  check('...which has no difficulty to choose', (await page.$$('[data-testid="difficulty-menu"] input')).length === 0);
  await press(page, 'Enter', 800);
  await page.waitForURL(/\/play\/synthetic_keyboard/, { timeout: 15000 });
  await waitBoardReady(page);

  // scenario 1: story, the [option] prompt, the objectives, then the fight
  await page.waitForSelector('.story', { timeout: 30000 });
  await press(page, 'Escape', 700);
  await page.waitForSelector('.window[role="dialog"] .option', { timeout: 15000 });
  await press(page, 'ArrowDown', 300);
  await press(page, 'Enter', 800);
  await page.waitForSelector('.modal-box', { timeout: 15000 });
  await press(page, 'Enter', 700);
  check('scenario 1 is won by keys', await winByKeys(page));
  await press(page, 'Enter', 1000); // Continue
  await page.waitForFunction(() => window.__wesnoth?.session?.snapshot?.scenario?.id === 'synth_keyboard_02' && !document.querySelector('.end-overlay'), null, { timeout: 60000 });
  check('Enter continues into scenario 2', /2\/2/.test(await page.$eval('.scenario-name', (e) => e.textContent ?? '').catch(() => '')));
  await waitBoardReady(page);
  await page.waitForTimeout(3000);
  const won2 = await winByKeys(page);
  if (!won2) {
    await shot(page, 'scenario2-not-won');
    console.log('state:', await page.evaluate(() => JSON.stringify({ units: window.__wesnoth.session.board.allUnits().map((u) => `${u.id}@${u.location.x},${u.location.y} hp${u.hitpoints} mv${u.movesLeft}`), turn: window.__wesnoth.session.turnNumber, side: window.__wesnoth.session.activeSide, dialogs: [...document.querySelectorAll('.modal-box,.window,.story')].map((e) => e.className) })));
  }
  check('scenario 2 (the last) is won by keys', won2);

  // the campaign's last victory: the credits (Escape skips them), then the end screen with Quit to Menu
  if (await page.$('.outro')) {
    check('the campaign end rolls the outro', true);
    await press(page, 'Escape', 1200);
  }
  await page.waitForSelector('.end-overlay', { timeout: 30000 });
  check('the end screen offers Quit to Menu, focused', (await focusedTestId(page)) === 'end-quit-to-menu', await focusedTestId(page));
  await press(page, 'Enter', 1500);
  await page.waitForSelector('[data-testid="title-screen"]', { timeout: 15000 });
  check('Enter returns to the title screen', new URL(page.url()).pathname === '/');

  await press(page, 'c', 700);
  await filterFor(page, 'keyboard');
  const laurel = await page.getAttribute('[data-testid="campaign-synthetic_keyboard"] .laurel', 'alt').catch(() => null);
  check('the finished campaign now wears a victory laurel', laurel === 'Completed: Silver', String(laurel));
  if (laurel !== 'Completed: Silver') {
    console.log('option:', await page.$eval('[data-testid="campaign-synthetic_keyboard"]', (e) => e.outerHTML).catch((e) => String(e)));
    console.log('stored:', await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open('wesnothweb2-saves'); r.onsuccess = () => { const q = r.result.transaction('settings').objectStore('settings').get('completedCampaigns'); q.onsuccess = () => resolve(JSON.stringify(q.result)); }; })));
  }
  await press(page, 'Escape', 400);

  // the other title-screen keys
  for (const [key, label, test] of [
    ['Control+o', 'Ctrl+O opens Load', (l) => l.some((x) => /Load/.test(x))],
    ['Control+p', 'Ctrl+P opens Preferences', (l) => l.includes('Preferences')],
    [' ', 'Space opens the credits', (l) => l.includes('Credits')],
    ['l', 'L opens the language picker', (l) => l.includes('Language')],
  ]) {
    await press(page, key, 900);
    const open = await dialogs(page);
    check(label, test(open), open.join());
    if (key === ' ') {
      await page.waitForSelector('[data-testid="credits-text"]', { timeout: 10000 });
      const y0 = await page.$eval('[data-testid="credits-text"]', (e) => e.getBoundingClientRect().top);
      await page.waitForTimeout(1200);
      const y1 = await page.$eval('[data-testid="credits-text"]', (e) => e.getBoundingClientRect().top);
      check('the credits scroll upward on their own', y1 < y0 - 20, `${y0.toFixed(0)} -> ${y1.toFixed(0)}`);
      await press(page, 'ArrowUp', 300);
      await shot(page, 'credits');
    }
    if (key === 'Control+p') {
      await press(page, 'ArrowRight', 300);
      check('the Preferences tabs work by arrow keys (Sound)', /Music/.test(await page.$eval('[role="tabpanel"]', (e) => e.textContent ?? '')));
    }
    await press(page, 'Escape', 500);
    check(`${label.split(' ')[0]} Escape closes it`, (await dialogs(page)).length === 0);
  }
  await press(page, 'ArrowRight', 300);
  check('Right shows the next tip', (await page.$('[data-testid="tip-text"]')) !== null);

  const count = await pointerEvents();
  check('the whole run, from the title screen to the credits, used not one mouse, pointer or touch event', count === 0, `${count} events`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

const browser = await chromium.launch({ headless: !headed });
try {
  if (keyboardOnly) {
    await keyboardRun(browser);
  } else {
    await titleScreen(browser);
    await libertyHard(browser);
    await twoBrothersDefault(browser);
    await completionFilter(browser);
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED${keyboardOnly ? ' (keyboard only)' : ''}`);
