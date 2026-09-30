/**
 * Phase 29 S8 milestone, in the browser: the AI plays with its Lua candidate actions, and a campaign's own
 * Lua still runs, both on the one Lua kernel.
 *
 *   node apps/web/scripts/ai-lua-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 *   1. Dead Water 1: the data directory's Lua bundle is fetched, the player ends turn 1 and the AI plays
 *      side 2 (and the others) with the default RCA AI -- Lua candidate actions included -- then hands the
 *      turn back. No page error, no console error or warning from the Lua kernel or the AI.
 *   2. The South Guard 1: the campaign's Lua (its preload scripts and custom dialogs) runs to the first
 *      playable turn with a clean console.
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

/** Console messages worth failing on: errors, and warnings from the Lua kernel or the AI. */
function watchConsole(page) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && !/Failed to load resource/.test(text)) problems.push(`error: ${text.slice(0, 300)}`);
    else if (msg.type() === 'warning' && /^\[(lua|ai)\]/.test(text)) problems.push(`warning: ${text.slice(0, 300)}`);
  });
  return problems;
}

const browser = await chromium.launch({ headless: !headed });
try {
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const problems = watchConsole(page);
    const luaFetched = page.waitForResponse((r) => r.url().includes('lua/data-lua.json') && r.ok(), { timeout: 120000 });
    await openScenario(page, base, 'dead_water');
    check('the data directory\'s Lua bundle is fetched', !!(await luaFetched.catch(() => null)));
    await waitBoardReady(page);
    await skipToPlay(page);
    const before = await page.evaluate(() => ({
      turn: window.__wesnoth.session.turnNumber,
      enemyUnits: window.__wesnoth.session.board.unitsForSide(2).length,
      hasLua: !!window.__wesnoth.session.luaRuntime,
    }));
    check('the session has the Lua kernel', before.hasLua);
    const started = Date.now();
    await page.keyboard.press('Control+Space');
    await confirmEndTurnIfAsked(page);
    let after = null;
    // With software rendering (a headless VM) the opening cutscene's animated beats take seconds each, and
    // skipToPlay can return in the middle of one; End Turn is ignored until the cutscene is over. So while the
    // game is still on the player's turn with nothing on screen, End Turn is pressed again every few seconds.
    let quiet = 0;
    for (let i = 0; i < 240; i++) {
      if (await page.$('.dismiss, .window[role="dialog"]')) {
        await page.keyboard.press('Enter');
        quiet = 0;
      }
      after = await page.evaluate(() => ({
        turn: window.__wesnoth.session.turnNumber,
        side: window.__wesnoth.session.activeSide,
        enemyUnits: window.__wesnoth.session.board.unitsForSide(2).length,
      }));
      if (after.turn > before.turn && after.side === 1) break;
      if (after.turn === before.turn && after.side === 1 && ++quiet >= 10) {
        await page.keyboard.press('Control+Space');
        await confirmEndTurnIfAsked(page);
        quiet = 0;
      }
      await page.waitForTimeout(500);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    check('the AI plays its turn and hands the next one back', !!after && after.turn === before.turn + 1 && after.side === 1, `${JSON.stringify(after)} in ${seconds}s`);
    check('the AI recruited', !!after && after.enemyUnits > before.enemyUnits, `${before.enemyUnits} -> ${after?.enemyUnits}`);
    check('no errors or Lua/AI warnings in Dead Water', problems.length === 0, problems.slice(0, 5).join(' | '));
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const problems = watchConsole(page);
    await openScenario(page, base, 'the_south_guard');
    await waitBoardReady(page);
    await skipToPlay(page);
    const playable = await page.evaluate(() => window.__wesnoth.session.activeSide === 1 && !window.__wesnoth.session.scenarioResult);
    check('The South Guard 1 reaches its first turn', playable);
    check('no errors or Lua/AI warnings in The South Guard', problems.length === 0, problems.slice(0, 5).join(' | '));
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
