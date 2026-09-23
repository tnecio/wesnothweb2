/**
 * Phase 18b milestone, in the browser: undo/redo from the keyboard, and the
 * replay viewer.
 *
 *   node apps/web/scripts/undo-replay-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 * On the economy debug scenario (both sides human, no fog):
 *   1. the leader steps off its keep; `u` walks it back (moves restored),
 *      `r` walks it there again;
 *   2. a recruit (random traits) cannot be undone -- `u` leaves it standing;
 *   3. after a turn each way, the game is saved; loading it with "Show
 *      replay" plays every action back on the board to the very same
 *      state, with no out-of-sync report; Restart starts over; "Continue
 *      playing" hands the game back.
 *
 * Exits non-zero if any step fails.
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

async function press(page, key, settleMs = 400) {
  await page.keyboard.press(key);
  await page.waitForTimeout(settleMs);
}

const leader = (page) =>
  page.evaluate(() => {
    const l = window.__wesnoth.session.board.unitsForSide(1).find((u) => u.canRecruit);
    return l ? { at: `${l.location.x},${l.location.y}`, moves: l.movesLeft } : null;
  });

const state = (page) => page.evaluate(() => window.__wesnoth.session.describeState());

async function saveAs(page, name) {
  const dialog = page.locator('.modal-box[aria-label="Save Game"]');
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.keyboard.press('Control+s');
    try {
      await dialog.waitFor({ timeout: 3000 });
      break;
    } catch {
      if (attempt === 19) throw new Error('Save Game never opened');
    }
  }
  const field = dialog.locator('input[type=text]');
  await field.fill(name);
  await field.press('Enter');
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
}

async function openLoadDialog(page) {
  const dialog = page.locator('.modal-box[aria-label="Load Game"]');
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.keyboard.press('Control+o');
    try {
      await dialog.waitFor({ timeout: 3000 });
      return dialog;
    } catch {
      // the shell ignores hotkeys while events run; try again
    }
  }
  throw new Error('Load Game never opened');
}

async function waitReplayDone(page, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    // Dialogue raised while replaying waits for the viewer, as in play.
    if (await page.$('.window[role="dialog"]')) await page.keyboard.press('Enter');
    const text = await page.locator('[data-testid="replay-progress"]').innerText().catch(() => '');
    const [done, total] = text.split('/').map((s) => Number(s.trim()));
    if (total > 0 && done === total && (await page.locator('[data-testid="replay-continue"]').count()) > 0) return { done, total };
    await page.waitForTimeout(300);
  }
  throw new Error('replay never finished');
}

const browser = await chromium.launch({ headless: !headed });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  try {
    await openScenario(page, base, 'synthetic_economy');
    await waitBoardReady(page);
    await skipToPlay(page);
    await page.waitForTimeout(800);

    // ---- 1. undo and redo a move -------------------------------------------
    const start = await leader(page);
    await press(page, 'ArrowDown'); // cursor on the leader's keep (3,3)
    await press(page, 'Enter', 600); // select it
    await press(page, 'ArrowDown'); // the castle hex south (3,4)
    await press(page, 'Enter', 2000); // move
    const moved = await leader(page);
    check('the leader moved', moved?.at === '3,4', JSON.stringify(moved));
    await press(page, 'u', 2500);
    const undone = await leader(page);
    check('u walks it back, moves restored', undone?.at === start?.at && undone?.moves === start?.moves, `${JSON.stringify(start)} -> ${JSON.stringify(undone)}`);
    await press(page, 'r', 2500);
    const redone = await leader(page);
    check('r moves it there again', redone?.at === '3,4' && redone?.moves === moved?.moves, JSON.stringify(redone));
    await press(page, 'u', 2500); // back to the keep so it can recruit

    // ---- 2. a recruit cannot be undone -------------------------------------
    await press(page, 'Control+r', 600);
    await press(page, 'Enter', 1500);
    const recruits = () => page.evaluate(() => window.__wesnoth.session.board.unitsForSide(1).filter((u) => !u.canRecruit).length);
    const afterRecruit = await recruits();
    check('recruited a unit', afterRecruit === 1, String(afterRecruit));
    await press(page, 'u', 1000);
    check('u does not take a recruit back (its traits were rolled)', (await recruits()) === 1);

    // ---- 3. a turn each way, save, and watch the replay ---------------------
    await press(page, 'Control+Space', 3000);
    await press(page, 'Control+Space', 3000);
    const saved = await state(page);
    const logLength = await page.evaluate(() => window.__wesnoth.session.replayLog.length);
    await saveAs(page, 'replay-probe');

    const dialog = await openLoadDialog(page);
    await dialog.getByRole('button', { name: 'replay-probe' }).click();
    await dialog.locator('[data-testid="show-replay"]').check();
    await dialog.getByRole('button', { name: 'Load', exact: true }).click();
    await page.locator('[data-testid="replay-bar"]').waitFor({ timeout: 20000 });
    check('Show replay opens the replay viewer', true);
    const first = await waitReplayDone(page);
    check('the replay plays every recorded action', first.total === logLength, `${first.done}/${first.total}, log ${logLength}`);
    const status = await page.locator('aside, .side-panel').first().innerText();
    check('no out-of-sync report', !/out of sync/i.test(status), status.slice(0, 160));
    check('the replay ends in exactly the saved state', (await state(page)) === saved);

    await page.locator('[data-testid="replay-restart"]').click();
    // A short replay can run to the end again within a second, so catch the
    // counter on its way back up rather than after a fixed wait.
    let lowest = first.total;
    for (let i = 0; i < 60 && lowest === first.total; i++) {
      const text = await page.locator('[data-testid="replay-progress"]').innerText().catch(() => '');
      const done = Number(text.split('/')[0]);
      if (Number.isFinite(done)) lowest = Math.min(lowest, done);
      await page.waitForTimeout(25);
    }
    check('Restart starts over', lowest < first.total, `lowest progress seen ${lowest}/${first.total}`);
    await waitReplayDone(page);
    check('...and reaches the same state again', (await state(page)) === saved);

    await page.locator('[data-testid="replay-continue"]').click();
    await page.waitForTimeout(500);
    check('Continue playing hands the game back', (await page.locator('[data-testid="replay-bar"]').count()) === 0);
    const canPlay = await page.evaluate(() => window.__wesnoth.session.activeSide === 1 && !window.__wesnoth.session.scenarioResult);
    check('it is side 1\'s turn to play', canPlay);
    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} step(s) failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nundo/redo and replay viewer: every step passed');
}
