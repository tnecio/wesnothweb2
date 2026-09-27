/**
 * Phase 23 milestone: a whole scenario on a phone, with touch alone.
 *
 *   node apps/web/scripts/mobile-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 * Emulates a Pixel 7 (412x839, touch, coarse pointer) and plays `synthetic_keyboard` from the story
 * screen to the victory screen and into the next scenario with taps only: skip the story, answer the
 * prompt, close the objectives, select the hero, move it (a first tap marks the hex, a second moves),
 * attack, and continue. A capture-phase listener counts every mouse pointer event and wheel the page
 * receives; the run fails unless there are none.
 *
 * Along the way: the layout (no sideways scrolling, every status figure and End Turn on screen, the
 * unit card in the minimap's place while a unit is selected), pinch zoom, two-finger pan, a long
 * press opening the context menu, collapsing the top bar and infobox, and turning the phone on its
 * side and back without losing the game.
 *
 * Board positions are read from the dev hooks (`__wesnoth`, `__wesnothDebug`); every input is a
 * touch (Playwright's `touchscreen` and CDP `Input.dispatchTouchEvent` for more than one finger).
 */
import { chromium, devices } from 'playwright';
import { openScenario, waitBoardReady, hexPoint } from './lib/browserFlows.mjs';

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

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ ...devices['Pixel 7'] });
await context.addInitScript(() => {
  window.__mouseEvents = 0;
  // Presses only: Chromium itself sends one mouse `pointermove` at (0, 0) when a page loads.
  for (const type of ['pointerdown', 'pointerup']) {
    window.addEventListener(type, (e) => e.pointerType === 'mouse' && (window.__mouseEvents += 1), true);
  }
  window.addEventListener('wheel', () => (window.__mouseEvents += 1), true);
  try {
    localStorage.removeItem('wesnothweb2.display');
  } catch {
    /* ignore */
  }
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

/** One finger, down and up, at a point. */
const tapAt = (p) => page.touchscreen.tap(p.x, p.y);
async function tap(selector, wait = 500) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`tap: nothing to tap at ${selector}`);
  await tapAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.waitForTimeout(wait);
}
async function tapHex(hex, wait = 800) {
  await tapAt(await hexPoint(page, hex.x, hex.y));
  await page.waitForTimeout(wait);
}
/** Several fingers at once (CDP): `points` is an array of {x, y}; an empty array lifts them all. */
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) });

const camera = () => page.evaluate(() => window.__wesnothDebug.camera());
const units = () =>
  page.evaluate(() =>
    window.__wesnoth.session.board.allUnits().map((u) => ({ id: u.id, side: u.side, x: u.location.x, y: u.location.y, hp: u.hitpoints })),
  );
const panelText = () => page.$eval('[data-testid="side-panel"]', (e) => e.textContent ?? '');
const visible = (selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
  }, selector);
/** Shown and at least partly on screen (a long card or the minimap may run on below the fold of the scrolling infobox). */
const shown = (selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
  }, selector);

try {
  await openScenario(page, base, 'synthetic_keyboard');
  // While the map loads, its progress line stays (only the mouse advice is dropped on a phone).
  const loadingShown = await page
    .waitForFunction(() => {
      const el = document.querySelector('.board-view .status.busy');
      return !!el && getComputedStyle(el).display !== 'none' && /loading/i.test(el.textContent ?? '');
    }, null, { timeout: 30000 })
    .then(() => true, () => false);
  check('while the scenario loads, "loading scenario..." is shown', loadingShown);
  await waitBoardReady(page);

  // --- story: a tap on Skip ---
  await page.waitForSelector('.story', { timeout: 30000 });
  check('the story fits the phone: Skip is on screen', await visible('.story .skip'));
  await tap('.story .skip', 800);
  check('tapping Skip leaves the story', (await page.$('.story')) === null);

  // --- the prompt: tapping an option answers it ---
  await page.waitForSelector('.window[role="dialog"] .option', { timeout: 15000 });
  // The collapse switches work while a message waits, and the message follows the board's new size.
  const messageBox = () => page.$eval('.window[role="dialog"]', (w) => w.getBoundingClientRect().height);
  const boardHeight = () => page.$eval('.canvas-host', (h) => h.getBoundingClientRect().height);
  await tap('[data-testid="infobox-toggle"]', 800);
  check('during a message, the infobox switch collapses the infobox', await page.$eval('[data-testid="side-panel"]', (p) => p.classList.contains('collapsed')));
  check('...without answering the message', (await page.$('.window[role="dialog"] .option')) !== null);
  check('...and the message covers the grown board', Math.abs((await messageBox()) - (await boardHeight())) < 2, `${await messageBox()} vs ${await boardHeight()}`);
  await tap('[data-testid="top-bar-toggle"]', 800);
  check('during a message, the top bar switch works too', await page.$eval('.top-bar', (b) => b.classList.contains('collapsed')) && (await page.$('.window[role="dialog"] .option')) !== null);
  await tap('[data-testid="top-bar-toggle"]', 400);
  await tap('[data-testid="infobox-toggle"]', 800);
  await tap('.window .option >> nth=1', 1000);
  check('tapping an option answers the prompt', (await page.$('.window[role="dialog"]')) === null);

  // --- objectives: OK ---
  await page.waitForSelector('.modal-box', { timeout: 15000 });
  const box = await page.locator('.modal-box').boundingBox();
  check('the objectives dialog fills the phone screen', !!box && box.width >= 410 && box.height >= 800, JSON.stringify(box));
  await tap('.modal-box button.advance', 800);
  check('tapping OK closes it', (await page.$('.modal-box')) === null);

  // --- the layout ---
  check('nothing scrolls sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const stats = await page.$$eval('.top-bar .stat', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.right <= innerWidth && r.width > 0; }));
  check('every status figure in the top bar is on screen', stats.length >= 6 && stats.every(Boolean), `${stats.filter(Boolean).length}/${stats.length}`);
  check('End Turn is on screen without scrolling', await visible('.turn-actions button'));
  check('no gap between the infobox header\'s cells for the body to show through', await page.$eval('[data-testid="side-panel"]', (p) => getComputedStyle(p).columnGap === '0px'));
  check('with nothing selected, the infobox shows the minimap', await shown('.top-slot canvas'));

  // --- select, then move with a confirming tap ---
  let all = await units();
  const hero = all.find((u) => u.side === 1);
  const villain = all.find((u) => u.side === 2);
  await tapHex(hero);
  check('tapping the hero selects it', /Debug Hero/.test(await panelText()));
  check('...and its card takes the minimap\'s place', !(await shown('.top-slot canvas')) && (await shown('.unit-info')));
  // The free hex between the hero and the villain (engine 0-based, same row).
  const dest = { x: hero.x + 1, y: hero.y };
  await tapHex(dest);
  all = await units();
  const stayed = all.find((u) => u.id === hero.id);
  check('a first tap on a free hex only marks it', stayed.x === hero.x && stayed.y === hero.y && /Tap again/.test(await panelText()), `${stayed.x},${stayed.y}`);
  await tapHex(dest, 2500);
  all = await units();
  const moved = all.find((u) => u.id === hero.id);
  check('a second tap on it moves there', moved.x === dest.x && moved.y === dest.y, `${moved.x},${moved.y}`);
  check('deselected after the move, the minimap is back', await shown('.top-slot canvas'));

  // --- gestures (between the move and the attack, while nothing is pending) ---
  const host = await page.locator('.canvas-host').boundingBox();
  const mid = { x: host.x + host.width / 2, y: host.y + host.height / 2 };
  await page.evaluate(() => window.__wesnothDebug.setRenderingPaused(true));
  const z0 = (await camera()).zoom;
  await touch('touchStart', [{ x: mid.x - 40, y: mid.y }, { x: mid.x + 40, y: mid.y }]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [{ x: mid.x - 40 - i * 12, y: mid.y }, { x: mid.x + 40 + i * 12, y: mid.y }]);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const z1 = (await camera()).zoom;
  check('spreading two fingers zooms in, onto one of upstream\'s levels', z1 > z0 && [16, 24, 36, 52, 72, 100, 144, 216, 288].includes(z1), `${z0} -> ${z1}`);
  const before = (await camera()).view;
  await touch('touchStart', [{ x: mid.x - 60, y: mid.y }, { x: mid.x + 60, y: mid.y }]);
  for (let i = 1; i <= 5; i++) {
    await touch('touchMove', [{ x: mid.x - 60 - i * 10, y: mid.y + i * 8 }, { x: mid.x + 60 - i * 10, y: mid.y + i * 8 }]);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const after = (await camera()).view;
  check('two fingers moving together pan the map', Math.abs(after.x - before.x) > 10 || Math.abs(after.y - before.y) > 10, `${before.x.toFixed(0)},${before.y.toFixed(0)} -> ${after.x.toFixed(0)},${after.y.toFixed(0)}`);
  await touch('touchStart', [{ x: mid.x - 100, y: mid.y }, { x: mid.x + 100, y: mid.y }]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [{ x: mid.x - 100 + i * 12, y: mid.y }, { x: mid.x + 100 - i * 12, y: mid.y }]);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const z2 = (await camera()).zoom;
  check('pinching zooms back out', z2 < z1, `${z1} -> ${z2}`);
  all = await units();
  check('no gesture tapped a hex (the hero is where it was, nothing selected)', all.find((u) => u.id === hero.id).x === dest.x && !(await shown('.unit-info')));
  await page.evaluate(() => window.__wesnothDebug.setRenderingPaused(false));

  // one finger held still: the context menu
  const vp = await hexPoint(page, villain.x, villain.y);
  await touch('touchStart', [vp]);
  await page.waitForTimeout(800);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  check('a long press opens the context menu', (await page.$('.context-menu')) !== null);
  check('...with entries a finger can hit (44 px)', await page.$$eval('.context-menu button', (els) => els.length > 0 && els.every((b) => b.getBoundingClientRect().height >= 44)).catch(() => false));
  check('...and taps nothing on the board', !(await shown('.unit-info')));
  await tapAt({ x: 20, y: host.y + 20 });
  await page.waitForTimeout(400);
  check('a tap elsewhere closes it', (await page.$('.context-menu')) === null);

  // --- attack (retrying next turn if the hero misses) ---
  let ended = false;
  for (let attempt = 0; attempt < 4 && !ended; attempt++) {
    all = await units();
    const h = all.find((u) => u.id === hero.id);
    const v = all.find((u) => u.side === 2);
    if (!v) break;
    await tapHex(h);
    await tapHex(v, 1200);
    const attackButton = page.getByRole('button', { name: 'Attack', exact: true });
    check(`tapping the enemy opens the attack dialog (attempt ${attempt + 1})`, (await attackButton.count()) > 0);
    if ((await attackButton.count()) === 0) break;
    await tap('button:text-is("Attack")', 6000);
    if ((await page.$('.modal-box')) && /Advance/.test(await page.$eval('.modal-box', (e) => e.textContent ?? '').catch(() => ''))) {
      await tap('.modal-box .option', 300);
      await tap('.modal-box button.primary', 1500);
      check('the advancement choice is made by taps', (await page.$('.modal-box')) === null);
    }
    for (let i = 0; i < 20 && !(await page.$('.end-overlay')) && (await page.$('.window[role="dialog"]')); i++) await tap('.window[role="dialog"]', 800);
    ended = (await page.$('.end-overlay')) !== null;
    if (!ended) {
      // Watch the turn button through the other sides' turn: greyed out while they think.
      await page.evaluate(() => {
        window.__turnButtonStates = [];
        const record = () => {
          const b = document.querySelector('[data-testid="turn-button"]');
          if (b) window.__turnButtonStates.push(`${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`);
        };
        new MutationObserver(record).observe(document.querySelector('.turn-actions'), { subtree: true, childList: true, attributes: true, characterData: true });
      });
      const buttonReady = () => page.waitForFunction(() => { const b = document.querySelector('[data-testid="turn-button"]'); return b && !b.disabled && /End Turn/.test(b.textContent); }, null, { timeout: 60000 });
      await tap('[data-testid="turn-button"]', 300);
      await buttonReady();
      const states = await page.evaluate(() => window.__turnButtonStates);
      // Side 2 is a second human here (hotseat): end its turn too, which -- nothing done -- asks first.
      for (let i = 0; i < 3 && (await page.evaluate(() => window.__wesnoth.session.activeSide)) !== 1; i++) {
        await tap('[data-testid="turn-button"]', 600);
        if (/not started your turn/.test(await page.$eval('.modal-box', (e) => e.textContent ?? '').catch(() => ''))) await tap('.modal-box button:text-is("Yes")', 600);
        await buttonReady();
      }
      if (attempt === 0) check("during the other sides' turn End Turn is greyed out, then comes back", states.includes('End Turn (disabled)') && states[states.length - 1] === 'End Turn', states.join(' > '));
    }
  }
  check('the fight ends the scenario: the victory screen shows', ended);
  if (ended) {
    check('Continue is on screen', await visible('.end-overlay .continue'));
    await tap('.end-overlay .continue', 4000);
    await page.waitForFunction(() => document.querySelector('.scenario-name')?.textContent?.includes('2/2'), null, { timeout: 60000 }).catch(() => {});
    check('tapping Continue goes on into the next scenario', /2\/2/.test(await page.$eval('.scenario-name', (e) => e.textContent ?? '').catch(() => '')));
    await waitBoardReady(page);
    for (let i = 0; i < 30; i++) {
      if (await page.$('.story')) await tap('.story .skip', 800);
      else if (await page.$('.window[role="dialog"]')) await tap('.window[role="dialog"]', 800);
      else if (await page.$('.modal-box button.advance')) await tap('.modal-box button.advance', 800);
      else break;
    }
  }

  // --- collapsing, and turning the phone ---
  await tap('[data-testid="top-bar-toggle"]', 400);
  await tap('[data-testid="infobox-toggle"]', 600);
  check('collapsed, the top bar keeps turn and gold on one line', await page.evaluate(() => { const bar = document.querySelector('.top-bar'); return bar.getBoundingClientRect().height < 60 && [...bar.querySelectorAll('.stat')].filter((s) => getComputedStyle(s).display !== 'none').length === 2; }));
  check('collapsed, the infobox is just its header (End Turn still there)', await visible('.turn-actions button') && !(await shown('.top-slot canvas')));
  // The drawn canvas, not just its host: Pixi follows window resizes only, and collapsing is not one.
  const drawn = await page.evaluate(() => { const host = document.querySelector('.canvas-host').getBoundingClientRect(); const canvas = document.querySelector('.canvas-host canvas').getBoundingClientRect(); return { host: host.height, canvas: canvas.height, camera: window.__wesnothDebug.camera().viewport.height }; });
  check('...and the board is drawn over most of the screen', drawn.canvas > 839 * 0.75 && Math.abs(drawn.canvas - drawn.host) < 2 && Math.abs(drawn.camera - drawn.host) < 2, JSON.stringify(drawn));
  // Collapsed, a selected unit is summed up in the header in place of the status text.
  const own = (await units()).find((u) => u.side === 1);
  await tapHex(own);
  const summary = await page.$eval('[data-testid="unit-summary"]', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  check('collapsed, a selected unit is summed up in one line: name, level, HP, XP, defense, time of day', !!summary && /\d+ \d+\/\d+ \d+\/\d+ \d+% [+-]?\d+%/.test(summary), summary ?? 'none');
  await tapHex(own);
  check('...and deselected, the status text is back', (await page.$('[data-testid="unit-summary"]')) === null);
  // End Turn before doing anything asks first (upstream's default confirm_end_turn=no_moves); No keeps the turn.
  const turnBefore = await page.evaluate(() => window.__wesnoth.session.turnNumber);
  await tap('[data-testid="turn-button"]', 800);
  check('End Turn with nothing done this turn asks first', /not started your turn/.test(await page.$eval('.modal-box', (e) => e.textContent ?? '').catch(() => '')));
  await tap('.modal-box button:text-is("No")', 800);
  check('...and No keeps the turn', (await page.$('.modal-box')) === null && (await page.evaluate(() => window.__wesnoth.session.turnNumber)) === turnBefore);
  const state = () => page.evaluate(() => { const s = window.__wesnoth.session; return JSON.stringify({ turn: s.turnNumber, units: s.board.allUnits().map((u) => `${u.id}@${u.location.x},${u.location.y}:${u.hitpoints}`).sort(), gold: s.board.getTeam(1)?.gold }); });
  const s0 = await state();
  await page.setViewportSize({ width: 839, height: 412 });
  await page.waitForTimeout(1500);
  check('on its side: the same game, nothing lost', (await state()) === s0);
  check('on its side: the board is still drawn and fills the width left of the panel', await page.evaluate(() => { const r = document.querySelector('.canvas-host').getBoundingClientRect(); return r.width > 600 && r.height > 300; }));
  check('on its side: End Turn is on screen', await visible('.turn-actions button'));
  check('on its side: nothing scrolls sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await tap('[data-testid="infobox-toggle"]', 600);
  check('on its side: the infobox opens beside the board', await shown('.top-slot canvas'));
  await page.setViewportSize({ width: 412, height: 839 });
  await page.waitForTimeout(1500);
  check('upright again: the same game', (await state()) === s0);
  check('upright again: the board is drawn', (await page.locator('.board-view').getAttribute('data-board-ready')) === 'true');

  check('not one mouse pointer event or wheel reached the page', (await page.evaluate(() => window.__mouseEvents)) === 0, String(await page.evaluate(() => window.__mouseEvents)));
  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check(`the run finished (${e instanceof Error ? e.message.split('\n')[0] : e})`, false);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} step(s) failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\na whole scenario on a phone, with touch alone: every step passed');
}
