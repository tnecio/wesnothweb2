/**
 * Phase 28c C1: the mainline tags the remaining campaigns share, in a real browser on Dead Water 1.
 *
 *   node apps/web/scripts/shared-tags-playthrough.mjs [--base http://localhost:5173] [--headed] [--shots dir]
 *
 * One `moveto` event, fired by moving Kai, runs in turn:
 * - `[story]`: the story screen over the game, and the event waits until it is read;
 * - a `[message]` after it, shown only then;
 * - `[print]`: a label over the map (`[data-testid="overlay-label"]`);
 * - `[floating_text]`: a label rising from Kai's hex (screenshot only: it is drawn on the canvas);
 * - `[unit_overlay]`: the hero icon on Kai;
 * - `[select_unit]`: Kai in the side panel;
 * - `[end_turn]`: the turn ends by itself once the event is over.
 *
 * `--shots dir` saves the story, the labels and the overlay. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { openScenario, skipToPlay, untilPlayable, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const shots = arg('shots', null);

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const EVENT = `[event]
name=moveto
first_time_only=yes
[filter]
id=Kai Krellis
[/filter]
[story]
[part]
story="A story told in an event."
[/part]
[/story]
[message]
speaker=narrator
message="After the story."
[/message]
[print]
text="<b>Shared tags</b>"
size=28
duration=60000
[/print]
[floating_text]
x,y=$x1,$y1
text="+50 gold"
color=255,215,0
[/floating_text]
[unit_overlay]
id=Kai Krellis
image=misc/hero-icon.png
[/unit_overlay]
[select_unit]
id=Kai Krellis
[/select_unit]
[end_turn]
[/end_turn]
[/event]`;

const browser = await chromium.launch({ headless: !args.includes('--headed') });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openScenario(page, base, 'dead_water');
  await waitBoardReady(page);
  await skipToPlay(page);
  await untilPlayable(page);
  await page.evaluate((wml) => window.__wesnoth.addEvent(wml), EVENT);

  // Move Kai one hex.
  await page.evaluate(async () => {
    const w = window.__wesnoth;
    const kai = w.session.board.allUnits().find((u) => u.id === 'Kai Krellis');
    await w.clickHex(kai.location.x, kai.location.y);
    const dest = w.session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y);
    void w.clickHex(dest.x, dest.y);
  });

  const story = await page.waitForSelector('.story[role="dialog"]', { timeout: 60000 }).catch(() => null);
  check('[story] in an event shows the story screen', !!story);
  check('...with its text', /A story told in an event\./.test((await story?.textContent()) ?? ''));
  check('...and the event waits: its next message is not shown yet', (await page.$('.window[role="dialog"]')) === null);
  if (shots) await page.screenshot({ path: `${shots}/c1-story.png` });
  // The part fades in before it takes a key, and the VM is slow: press until the story closes.
  for (let i = 0; i < 20 && (await page.$('.story[role="dialog"]')); i++) {
    await page.waitForTimeout(1500);
    await page.keyboard.press('Enter');
  }
  const message = await page.waitForSelector('.window[role="dialog"]', { timeout: 120000 }).catch(() => null);
  check('...then the event goes on to its [message]', /After the story\./.test((await message?.textContent()) ?? ''));
  await page.waitForTimeout(1000);
  await page.keyboard.press('Enter');

  const overlay = await page.waitForSelector('[data-testid="overlay-label"]', { timeout: 60000 }).catch(() => null);
  check('[print] shows its label over the map', /Shared tags/.test((await overlay?.textContent()) ?? ''));
  if (shots) await page.screenshot({ path: `${shots}/c1-labels.png` });

  const kai = await page.evaluate(() => {
    const u = window.__wesnoth.session.board.allUnits().find((v) => v.id === 'Kai Krellis');
    return { overlays: [...u.overlays] };
  });
  check('[unit_overlay] gives Kai the hero icon', kai.overlays.includes('misc/hero-icon.png'), kai.overlays.join(','));

  // [end_turn]: the turn passes to the AI (side 2) with no End Turn pressed, and the player's turn 2 begins.
  // The AI's turn and its animations take minutes under software WebGL.
  const passed = await page
    .waitForFunction(() => window.__wesnoth.session.activeSide !== 1, null, { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  check('[end_turn] ends the turn once the event is over', passed);
  // The other sides' turn events speak (Mal-Kevek's opening lines): answer them as they come.
  let turn2 = false;
  for (const deadline = Date.now() + 900000; !turn2 && Date.now() < deadline; ) {
    if (await page.$('.window[role="dialog"]')) await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    turn2 = await page.evaluate(() => window.__wesnoth.session.turnNumber === 2 && window.__wesnoth.session.activeSide === 1);
    if (process.env.C1_TRACE) console.log('state', JSON.stringify(await page.evaluate(() => ({ turn: window.__wesnoth.session.turnNumber, side: window.__wesnoth.session.activeSide, canAct: window.__wesnoth.movementPreview().canAct }))));
  }
  check("...and the player's turn 2 begins after the other sides'", turn2);
  if (shots) {
    await page.evaluate(async () => {
      const u = window.__wesnoth.session.board.allUnits().find((v) => v.id === 'Kai Krellis');
      await window.__wesnothDebug.scrollToHex(u.location.x, u.location.y, 'warp');
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${shots}/c1-overlay.png` });
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
