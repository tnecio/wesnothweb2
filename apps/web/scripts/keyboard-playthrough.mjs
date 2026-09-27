/**
 * Phase 15 milestone: the play loop driven by the keyboard alone.
 *
 *   node apps/web/scripts/keyboard-playthrough.mjs [--base http://localhost:5173] [--headed]
 *   node apps/web/scripts/keyboard-playthrough.mjs --keyboard-only     (Phase 20: a whole scenario)
 *
 * `--keyboard-only` (Phase 20 milestone 2) plays `synthetic_keyboard` from the story screen to the
 * victory screen and on into the next scenario, then opens the save, load and language dialogs, all
 * with keys; a capture-phase listener counts every mouse, pointer and touch event the page receives
 * and the run fails unless the count is zero. Along the way it checks that a screen reader would be
 * told about each hex the cursor visits (the polite live region), that dialogs are labelled, and that
 * each screen leaves focus on the control that continues.
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
 *   synthetic_economy: recruit (ctrl+r, arrows, Enter -- lands on the first free castle hex)
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

/** Phase 20 milestone 2: a whole scenario with the keyboard alone. */
async function keyboardOnly(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Count every pointer-ish event the page receives, before anything can handle it.
  await context.addInitScript(() => {
    window.__pointerEvents = 0;
    // (A `click` with `detail` 0 is what the browser synthesizes when Enter or Space activates a focused button: a key, not a mouse.)
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'contextmenu', 'wheel']) {
      window.addEventListener(type, (e) => (e.type === 'click' && e.detail === 0 ? 0 : (window.__pointerEvents += 1)), true);
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const announcement = () => page.$eval('[data-testid="cursor-announcement"]', (e) => e.textContent ?? '').catch(() => '');
  const focused = () => page.evaluate(() => `${document.activeElement?.tagName ?? ''}.${document.activeElement?.className ?? ''}|${document.activeElement?.textContent?.trim().slice(0, 30) ?? ''}`);
  const dialogLabels = () => page.$$eval('[role="dialog"], [role="alertdialog"]', (els) => els.map((e) => e.getAttribute('aria-label') ?? e.getAttribute('aria-labelledby') ?? ''));

  try {
    await openScenario(page, base, 'synthetic_keyboard');
    await waitBoardReady(page);

    // story: Escape skips it
    await page.waitForSelector('.story', { timeout: 30000 });
    check('the story screen is a labelled dialog', (await dialogLabels()).some((l) => l !== ''), (await dialogLabels()).join(', '));
    await press(page, 'Escape', 700);
    check('Escape skips the story', (await page.$('.story')) === null);

    // the message with an [option] prompt: arrows choose, Enter answers
    await page.waitForSelector('.window[role="dialog"] .option', { timeout: 15000 });
    check('the dialogue is a labelled dialog with a described body', (await page.$('.window[aria-describedby="wml-message-text"]')) !== null);
    await press(page, 'ArrowDown', 300);
    const highlighted = (await page.$$eval('.window .option', (els) => els.filter((e) => e.classList.contains('selected')).map((x) => (x.textContent ?? '').trim()))).join();
    check('ArrowDown moves the highlighted option', highlighted === 'The road to the south', highlighted);
    await press(page, 'Enter', 800);
    check('Enter answers the prompt', (await page.$('.window[role="dialog"]')) === null);

    // objectives (shown once the startup events and their dialogue are done): focus is on OK, Enter closes it
    await page.waitForSelector('.modal-box', { timeout: 15000 });
    check('the objectives dialog has focus on its OK button', /advance/.test(await focused()), await focused());
    await press(page, 'Enter', 700);

    // play: N selects the hero; the cursor announces every hex it visits
    await press(page, 'n', 500);
    check('N selects the next unit (the hero)', /Debug Hero/.test(await sidePanelText(page)));
    await press(page, 'ArrowRight', 400);
    const first = await announcement();
    check('the cursor announces its hex (terrain, unit, side, hit points, moves)', /Debug Hero, Mage, side 1, \d+ of \d+ HP, \d+ of \d+ moves/.test(first), first);
    await press(page, 'ArrowRight', 400);
    const free = await announcement();
    check('...and says when Enter would move there', /you can move here/.test(free), free);
    await press(page, 'Enter', 1500); // moves adjacent to the enemy leader (a move deselects, as upstream)
    await press(page, 'Enter', 600); // the cursor is on the hero's new hex: select it again
    check('Enter on the hero selects it again', /Debug Hero/.test(await sidePanelText(page)));
    await press(page, 'ArrowRight', 400);
    const target = await announcement();
    check('...and when Enter would attack a unit', /Debug Villain.*side 2.*you can attack it/.test(target), target);

    // attack, retrying next turn if the 3% miss happens
    let ended = false;
    for (let attempt = 0; attempt < 4 && !ended; attempt++) {
      await press(page, 'Enter', 1200);
      check(`Enter on the enemy opens the attack dialog (attempt ${attempt + 1})`, (await dialogLabels()).includes('Attack'), (await dialogLabels()).join(', '));
      check('the attack dialog names each side', /Side 1[\s\S]*Side 2/.test(await page.$eval('.modal-box', (e) => e.textContent ?? '')));
      await press(page, 'Enter', 6000); // confirm
      // an advancement choice may open (the hero is one kill from levelling up)
      if ((await page.$('.modal-box')) && /Advance/.test(await page.$eval('.modal-box', (e) => e.textContent ?? '').catch(() => ''))) {
        check('the advancement dialog opens for the level-up', true);
        await press(page, 'ArrowDown', 300);
        await press(page, 'Enter', 1500);
      }
      ended = (await page.$('.end-overlay')) !== null;
      if (!ended) {
        await press(page, 'Escape', 300); // clear the selection
        await press(page, 'Control+Space', 2500); // end side 1's turn
        await press(page, 'Control+Space', 2500); // side 2 (also human) ends its own
        await press(page, 'n', 500);
        await press(page, 'ArrowRight', 300);
        await press(page, 'ArrowRight', 300);
      }
    }
    check('the fight ends the scenario: the victory screen shows', ended);
    if (ended) {
      const overlay = await page.$eval('.end-overlay', (e) => `${e.getAttribute('role')}|${e.textContent ?? ''}`);
      check('it is an alert dialog naming the result', /^alertdialog\|.*(Victory)/.test(overlay.replace(/\s+/g, ' ')), overlay.slice(0, 60));
      check('focus is on Continue', /continue/.test(await focused()), await focused());
      await press(page, 'Enter', 4000);
      await page.waitForFunction(() => document.querySelector('.scenario-name')?.textContent?.includes('2/2'), null, { timeout: 30000 }).catch(() => {});
      check('Enter continues into the next scenario', /2\/2/.test(await page.$eval('.scenario-name', (e) => e.textContent ?? '').catch(() => '')));
    }

    // save, load and the language picker, by keys
    await press(page, 'Control+s', 600);
    check('Ctrl+S opens the save dialog with focus in its name field', (await dialogLabels()).includes('Save Game') && /INPUT/.test(await focused()), await focused());
    await press(page, 'Escape', 400);
    check('Escape closes it and focus returns', (await dialogLabels()).length === 0);
    await press(page, 'Control+o', 600);
    check('Ctrl+O opens the load dialog', (await dialogLabels()).length > 0, (await dialogLabels()).join(', '));
    await press(page, 'Escape', 400);
    // Tab to the Menu button, open its dropdown with Enter, Tab on to the Language entry
    for (let i = 0; i < 40 && !/menu-button.*\|Menu/.test(await focused()); i++) await press(page, 'Tab', 100);
    check('Tab reaches the Menu button', /menu-button.*\|Menu/.test(await focused()), await focused());
    await press(page, 'Enter', 300);
    check('Enter opens the menu (aria-expanded)', (await page.$eval('.menu-button.open', (e) => e.getAttribute('aria-expanded')).catch(() => null)) === 'true');
    for (let i = 0; i < 12 && !/Language/.test(await focused()); i++) await press(page, 'Tab', 100);
    check('Tab reaches the menu\'s Language entry', /Language/.test(await focused()), await focused());
    await press(page, 'Enter', 500);
    check('Enter opens the language picker with the current language focused', (await dialogLabels()).includes('Language') && /INPUT/.test(await focused()), await focused());
    const before = await page.evaluate(() => document.documentElement.lang);
    await press(page, 'ArrowDown', 1200);
    const after = await page.evaluate(() => document.documentElement.lang);
    check('an arrow key picks another language, live', before !== after, `${before} -> ${after}`);
    await press(page, 'ArrowUp', 1200);
    await press(page, 'Escape', 400);

    check('not one mouse, pointer or touch event reached the page', (await page.evaluate(() => window.__pointerEvents)) === 0, String(await page.evaluate(() => window.__pointerEvents)));
    check('no console errors (keyboard only)', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: !headed });
if (args.includes('--keyboard-only')) {
  try {
    await keyboardOnly(browser);
  } finally {
    await browser.close();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} step(s) failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nwhole scenario, story to victory and beyond, with the keyboard alone: every step passed');
  }
  process.exit(process.exitCode ?? 0);
}
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

      // Recruit: ctrl+r opens the dialog, Enter takes the highlighted type
      // and places it straight away on the first free castle hex by x, y --
      // (2,3) here -- with no hex click (bugs6.md).
      await press(page, 'Control+r', 600);
      check('ctrl+r opens the recruit dialog', (await openDialogs(page)).some((l) => /recruit unit/i.test(l)));
      await press(page, 'ArrowDown');
      await press(page, 'Enter', 1500);
      check('Enter closes the recruit dialog', (await openDialogs(page)).length === 0);
      const recruitedAt = await page.evaluate(() =>
        window.__wesnoth.session.board.unitsForSide(1).some((u) => !u.canRecruit && u.location.x === 2 && u.location.y === 3),
      );
      check('the recruit landed on the first free castle hex (2,3)', recruitedAt);

      const goldAfter = await stat(page, 'Gold');
      const unitsAfter = await stat(page, 'Units');
      check('recruit added a unit', unitsAfter === unitsBefore + 1, `units ${unitsBefore} -> ${unitsAfter}`);
      check('recruit spent gold', goldAfter !== null && goldAfter < goldBefore, `gold ${goldBefore} -> ${goldAfter}`);

      // Move: select the leader on its keep, then step it south.
      await press(page, 'ArrowDown'); // summon the cursor on the leader's keep (3,3)
      await press(page, 'Enter', 600); // select the leader
      check('Enter selects the unit under the cursor', (await sidePanelText(page)).includes('selected'));
      await press(page, 'ArrowDown'); // cursor to the castle hex south (3,4)
      await press(page, 'Enter', 2000); // move there
      const leaderAt = await page.evaluate(() => {
        const l = window.__wesnoth.session.board.unitsForSide(1).find((u) => u.canRecruit);
        return l ? `${l.location.x},${l.location.y}` : null;
      });
      check('leader moved to the cursor hex', leaderAt === '3,4', String(leaderAt));

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
