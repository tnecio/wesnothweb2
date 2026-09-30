/**
 * What the player sees and hears around the other sides' turns, in a real browser:
 *
 *   node apps/web/scripts/turn-end-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 * On Dead Water 1 (side 2 is the AI):
 *
 *   1. The turn bell rings once the AI's turn has been shown and the turn is the player's again,
 *      not while the AI's moves are still being computed or played out.
 *   2. A scenario ended by an event that goes on to speak (`[endlevel]` then a `[message]`, on the
 *      AI's turn): the message is shown first, and the victory screen only once it is dismissed.
 *
 * Exits non-zero if any step fails.
 */
import { chromium } from 'playwright';
import { confirmEndTurnIfAsked, openScenario, skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

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

/**
 * Ends the player's turn and waits until it is the player's again, on screen too -- or until a message
 * matching `stopAt` is up, or the scenario ended. Other dialogue is dismissed. With software rendering
 * (a headless VM) the opening cutscene can still be playing when `skipToPlay` returns, and End Turn is
 * ignored until it is over, so it is pressed again while nothing happens.
 */
async function endTurnAndWait(page, stopAt = null) {
  const state = () =>
    page.evaluate(() => {
      const w = window.__wesnoth;
      const dialog = document.querySelector('.window[role="dialog"]');
      return {
        turn: w.session.turnNumber,
        side: w.session.activeSide,
        other: w.otherSidesTurn,
        ended: !!w.session.scenarioResult,
        dialog: dialog ? dialog.textContent.replace(/\s+/g, ' ') : null,
      };
    });
  const start = await state();
  await page.keyboard.press('Control+Space');
  await confirmEndTurnIfAsked(page);
  let quiet = 0;
  for (let i = 0; i < 1200; i++) {
    await page.waitForTimeout(500);
    const now = await state();
    if (now.dialog !== null) {
      if (stopAt && stopAt.test(now.dialog)) return now;
      await page.keyboard.press('Enter');
      quiet = 0;
      continue;
    }
    if (now.ended || (now.turn > start.turn && now.side === 1 && now.other === null)) return now;
    if (now.turn === start.turn && now.side === 1 && now.other === null && ++quiet >= 10) {
      await page.keyboard.press('Control+Space');
      await confirmEndTurnIfAsked(page);
      quiet = 0;
    }
  }
  throw new Error(`endTurnAndWait: the turn did not come back (${JSON.stringify(await state())})`);
}

const browser = await chromium.launch({ headless: !headed });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openScenario(page, base, 'dead_water');
  await waitBoardReady(page);
  await skipToPlay(page);

  // Every sound played, with whether another side's turn was still on at the time.
  await page.evaluate(() => {
    window.__played = [];
    // Only what is played once the AI's turn has begun (the opening cutscene may still be ringing turn 1 in).
    window.__sawOtherSide = false;
    const watch = () => {
      if (window.__wesnoth.otherSidesTurn !== null) window.__sawOtherSide = true;
      requestAnimationFrame(watch);
    };
    watch();
    const audio = window.__wesnoth.audio;
    const play = audio.playSound.bind(audio);
    audio.playSound = (request) => {
      if (window.__sawOtherSide) window.__played.push({ group: request.group, files: request.files, otherSidesTurn: window.__wesnoth.otherSidesTurn });
      return play(request);
    };
  });

  // 1. The bell.
  await endTurnAndWait(page);
  await page.waitForTimeout(2000);
  const played = await page.evaluate(() => window.__played);
  const bells = played.filter((p) => p.group === 'bell');
  check('the turn bell rings when the turn comes back', bells.length === 1, JSON.stringify(played));
  check('...after the AI\'s turn has been shown, not while it is computed or played out', bells.every((b) => b.otherSidesTurn === null), JSON.stringify(bells));

  // 2. The end, and the words after it.
  await page.evaluate(() =>
    window.__wesnoth.addEvent(`[event]
name=side 2 turn 2
[endlevel]
result=victory
[/endlevel]
[message]
speaker=narrator
message="The last words, after the end."
[/message]
[/event]`),
  );
  await endTurnAndWait(page, /The last words, after the end\./);
  const box = await page.$('.window[role="dialog"]');
  const text = box ? (await box.innerText()).replace(/\s+/g, ' ') : '';
  check('the message after [endlevel] is shown', /The last words, after the end\./.test(text), text.slice(0, 120));
  check('...with no end screen over or behind it yet', (await page.$('.end-overlay')) === null);
  await page.keyboard.press('Enter');
  const overlay = await page.waitForSelector('.end-overlay', { timeout: 30000 }).catch(() => null);
  check('dismissing it shows the victory screen', !!overlay && /victory/i.test(await overlay.innerText()));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
