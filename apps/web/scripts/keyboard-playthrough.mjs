/**
 * Phase 15 milestone: the play loop driven by the keyboard alone.
 *
 *   node apps/web/scripts/keyboard-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 * Not one click anywhere: every action below is a keypress, dispatched by
 * `GameShell`'s hotkey handler (`packages/ui/src/commands.ts`).
 *
 * The loop is split across the two debug campaigns because no single one
 * offers all four actions in one turn: the economy scenario has a keep and
 * a castle ring but its enemy leader sits six hexes away (nothing to attack
 * this turn), while the combat scenario has two adjacent leaders but no
 * castle to recruit from.
 *
 *   synthetic_economy: recruit (ctrl+r, arrows, Enter, cursor, Enter)
 *                      move   (cursor, Enter, cursor, Enter)
 *                      end turn (ctrl+space)
 *   synthetic_combat:  attack (cursor, Enter, cursor, Enter, Enter)
 *
 * Exits non-zero if any step fails to change the game state it should.
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

/** A top-bar figure, e.g. `Gold 40` -> 40. */
async function stat(page, label) {
  const text = await page.$eval('.top-bar .status', (el) => el.textContent ?? '');
  const match = new RegExp(`${label}\\s*([0-9]+)`).exec(text.replace(/\s+/g, ' '));
  return match ? Number(match[1]) : null;
}

/** The whole turn figure, e.g. `Turn 1/20 (side 1)` -- the side is what changes when both sides are human. */
async function turnStat(page) {
  const text = await page.$eval('.top-bar .status', (el) => el.textContent ?? '');
  const match = /Turn\s*([0-9]+\/[0-9]+|[0-9]+)\s*\(side\s*([0-9]+)\)/.exec(text.replace(/\s+/g, ' '));
  return match ? `Turn ${match[1]} (side ${match[2]})` : text.replace(/\s+/g, ' ').slice(0, 40);
}

async function sidePanelText(page) {
  const text = await page.$$eval('aside, .side-panel', (els) => els.map((e) => e.textContent ?? '').join(' '));
  return text.replace(/\s+/g, ' ');
}

async function openDialogs(page) {
  return page.$$eval('.modal-box', (els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

async function press(page, key, settleMs = 400) {
  await page.keyboard.press(key);
  await page.waitForTimeout(settleMs);
}

const browser = await chromium.launch({ headless: !headed });
try {
  // ---- synthetic_economy: recruit, move, end turn ------------------------
  {
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

      const goldBefore = await stat(page, 'Gold');
      const unitsBefore = await stat(page, 'Units');

      // Recruit: ctrl+r opens the dialog, Enter takes the highlighted type,
      // then the cursor places it on a castle hex.
      await press(page, 'Control+r', 600);
      check('ctrl+r opens the recruit dialog', (await openDialogs(page)).includes('Recruit unit'));
      await press(page, 'ArrowDown');
      await press(page, 'Enter', 600);
      check('Enter closes the recruit dialog', (await openDialogs(page)).length === 0);
      await press(page, 'ArrowDown'); // summon the cursor on the leader's keep (3,3)
      await press(page, 'ArrowDown'); // step down onto the castle hex (3,4)
      await press(page, 'Enter', 1500); // place the recruit

      const goldAfter = await stat(page, 'Gold');
      const unitsAfter = await stat(page, 'Units');
      check('recruit added a unit', unitsAfter === unitsBefore + 1, `units ${unitsBefore} -> ${unitsAfter}`);
      check('recruit spent gold', goldAfter !== null && goldAfter < goldBefore, `gold ${goldBefore} -> ${goldAfter}`);

      // Move: select the leader (cursor up onto its keep), then step it west.
      await press(page, 'ArrowUp'); // cursor back to the keep (3,3)
      await press(page, 'Enter', 600); // select the leader
      check('Enter selects the unit under the cursor', (await sidePanelText(page)).includes('selected'));
      await press(page, 'ArrowLeft'); // cursor to the castle hex west (2,3)
      await press(page, 'Enter', 2000); // move there
      const afterMove = await sidePanelText(page);
      check('leader moved to the cursor hex', afterMove.includes('(2, 3)'), afterMove.slice(0, 80));

      // End turn. Both sides here are `controller=human`, so the turn number
      // stays 1 and it is the active side that changes.
      const turnBefore = await turnStat(page);
      await press(page, 'Control+Space', 4000);
      const turnAfter = await turnStat(page);
      check('ctrl+space ends the turn', turnAfter !== turnBefore && /side 2/.test(turnAfter), `"${turnBefore}" -> "${turnAfter}"`);
      check('no console errors (economy)', errors.length === 0, errors.slice(0, 2).join(' | '));
    } finally {
      await context.close();
    }
  }

  // ---- synthetic_combat: attack ------------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    try {
      await openScenario(page, base, 'synthetic_combat');
      await waitBoardReady(page);
      await skipToPlay(page);
      await page.waitForTimeout(800);

      await press(page, 'ArrowRight'); // summon the cursor on the hero (1,2)
      await press(page, 'Enter', 600); // select it
      await press(page, 'ArrowRight'); // cursor onto the adjacent orc (2,2)
      await press(page, 'Enter', 1200); // open the attack dialog
      check('Enter on an enemy opens the attack dialog', (await openDialogs(page)).includes('Attack'));
      await press(page, 'Enter', 6000); // confirm the attack
      check('Enter confirms the attack', (await openDialogs(page)).length === 0);
      const panel = await sidePanelText(page);
      check('the attack was fought', /attack|damage|misses|hits/i.test(panel), panel.slice(0, 120));
      check('no console errors (combat)', errors.length === 0, errors.slice(0, 2).join(' | '));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} step(s) failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nkeyboard-only playthrough: every step passed');
}
