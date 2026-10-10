/**
 * Phase 29a: an AI side's turn is shown action by action, in a real browser, as upstream draws each action
 * before the AI chooses the next (`stage_rca.cpp`).
 *
 *   node apps/web/scripts/ai-turn-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 * On Dead Water 1 and Liberty 1, one End Turn:
 *
 *   1. The AI's actions reach the display one at a time (several steps), and the board view changes
 *      several times while the AI's turn is still on -- not once, at the end.
 *   2. The board view matches the game when the turn comes back.
 *   3. Dead Water: a `recruit` [message] on the AI's first action (its recruits) is shown while the AI's turn
 *      is still on, and the AI goes on after it is dismissed.
 *   4. No page errors.
 *
 * Also prints the longest the page went without a frame during the AI's turn.
 * Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { confirmEndTurnIfAsked, openScenario, skipToPlay, untilPlayable, waitBoardReady } from './lib/browserFlows.mjs';

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

const RECRUITED = 'An AI unit was recruited.';

const runs = [
  { campaign: 'dead_water', scenario: null, label: 'Dead Water 1', message: true },
  { campaign: 'liberty', scenario: '01_The_Raid', label: 'Liberty 1', message: false },
];

const browser = await chromium.launch({ headless: !headed });
try {
  for (const run of runs) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openScenario(page, base, run.campaign, run.scenario ?? undefined);
    await waitBoardReady(page);
    await skipToPlay(page, 900000);
    await untilPlayable(page, 900000);

    if (run.message) {
      await page.evaluate((text) =>
        window.__wesnoth.addEvent(`[event]
name=recruit
[filter]
side=2
[/filter]
[message]
speaker=narrator
message="${text}"
[/message]
[/event]`),
      RECRUITED);
    }

    // Every frame while another side's turn is on: the units the board view shows, and the frame gaps.
    await page.evaluate(() => {
      const w = window.__wesnoth;
      window.__aiTurn = { shownStates: [], maxGap: 0, steps0: w.aiSteps() };
      let last = performance.now();
      let lastShown = '';
      const watch = () => {
        const now = performance.now();
        if (w.otherSidesTurn !== null) {
          window.__aiTurn.maxGap = Math.max(window.__aiTurn.maxGap, now - last);
          const shown = w.shownUnits().join(' ');
          if (shown !== lastShown) window.__aiTurn.shownStates.push(w.aiSteps());
          lastShown = shown;
        }
        last = now;
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });

    const state = () =>
      page.evaluate(() => {
        const w = window.__wesnoth;
        const dialog = document.querySelector('.window[role="dialog"]');
        return {
          turn: w.session.turnNumber,
          side: w.session.activeSide,
          other: w.otherSidesTurn,
          steps: w.aiSteps(),
          ended: !!w.session.scenarioResult,
          dialog: dialog ? dialog.textContent.replace(/\s+/g, ' ') : null,
        };
      });

    const start = await state();
    await page.keyboard.press('Control+Space');
    await confirmEndTurnIfAsked(page);
    let messageAt = null;
    let back = null;
    for (let i = 0; i < 2400 && !back; i++) {
      await page.waitForTimeout(250);
      const now = await state();
      if (now.dialog !== null) {
        if (now.dialog.includes(RECRUITED) && !messageAt) messageAt = now;
        await page.keyboard.press('Enter');
        continue;
      }
      if (now.ended || (now.turn > start.turn && now.side === start.side && now.other === null)) back = now;
    }
    check(`${run.label}: the turn comes back to the player`, !!back, JSON.stringify(back ?? (await state())));
    const watched = await page.evaluate(() => window.__aiTurn);
    const steps = (back?.steps ?? 0) - start.steps;
    check(`${run.label}: the AI's actions are shown one at a time`, steps > 1, `${steps} steps`);
    const midTurn = new Set(watched.shownStates.filter((s) => s > watched.steps0)).size;
    check(`${run.label}: the board view changes during the AI's turn, step by step`, midTurn > 1, `board changed after ${midTurn} different steps`);
    const synced = await page.evaluate(() => {
      const w = window.__wesnoth;
      const session = w.session.renderUnits.map((u) => `${u.side}:${u.typeId}@${u.x},${u.y}:${u.hitpoints}`).sort();
      return JSON.stringify(session) === JSON.stringify(w.shownUnits());
    });
    check(`${run.label}: the board view matches the game when the turn comes back`, synced);
    if (run.message) {
      check(`${run.label}: an AI recruit's message is shown during the AI's turn`, !!messageAt && messageAt.side !== start.side && messageAt.other !== null, JSON.stringify(messageAt));
      check(`${run.label}: ...and the AI goes on after it`, !!messageAt && !!back && back.steps > messageAt.steps, `message at step ${messageAt?.steps}, turn ended at ${back?.steps}`);
    }
    console.log(`info ${run.label}: longest frame gap during the AI's turn ${Math.round(watched.maxGap)} ms`);
    check(`${run.label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
