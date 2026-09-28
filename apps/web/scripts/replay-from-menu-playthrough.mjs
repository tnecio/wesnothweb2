/**
 * Verifies "Show replay" behaves the same wherever a save is loaded from, fixing a real gap (and a real
 * regression Phase 21's campaign-directory fix introduced along the way):
 *
 *   1. The title screen's Load dialog now offers "Show replay" (it used to be disabled outright: replay
 *      needed a running `GameShell` to switch into, and the title screen has none). `GameShell` now
 *      accepts `startInReplay`, so `PlayPage` can mount straight into the replay screen from a cold URL
 *      (`?save=<name>&replay=1`) -- the exact mechanism `?difficulty=`/`?scenario=` already use.
 *   2. The in-game Load dialog's "Show replay", when the chosen save belongs to a DIFFERENT campaign than
 *      the one currently open, now hands off through that same URL (`onOpenSave(..., replay=true)`)
 *      instead of calling `startReplay` directly. Before this fix it called `startReplay` regardless of
 *      campaign, which -- once scenario snapshots were nested under their own campaign directory
 *      (`CampaignInfo.assetDir`) -- fetched from the *currently open* campaign's directory for a scenario
 *      id that lives in someone else's, a guaranteed 404. Caught only by writing this check.
 *
 * Run: node apps/web/scripts/replay-from-menu-playthrough.mjs [--base http://localhost:5173] [--headed]
 */
import { chromium } from 'playwright';
import { skipToPlay, waitBoardReady, confirmEndTurnIfAsked } from './lib/browserFlows.mjs';

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

const sessionInfo = (page) =>
  page.evaluate(() => {
    const s = window.__wesnoth?.session;
    return s ? { scenario: s.snapshot.scenario.id, campaign: s.snapshot.assetDir } : null;
  });
const waitSession = (page) => page.waitForFunction(() => window.__wesnoth?.session, null, { timeout: 180000 });

/**
 * Ends the active side's turn (Ctrl+Space): a real, recorded `[end_turn]` replay command, with no
 * coordinate math needed. Ending a turn can trigger a scenario's own dialogue (Dead Water 1's does), so
 * this clears it the same way `skipToPlay` does rather than leaving it to block every later hotkey.
 */
async function recordOneAction(page) {
  await page.keyboard.press('Control+Space');
  await confirmEndTurnIfAsked(page);
  await page.waitForTimeout(1500);
  await skipToPlay(page, 20000).catch(() => {}); // best-effort: some scenarios keep talking past one end-turn
}

/**
 * Presses `key` until `selector` appears, rather than trusting a fixed quiet window: `GameShell` ignores
 * hotkeys while events are running (an AI turn still playing out after `recordOneAction`'s end-turn, say),
 * so a single press can land in a window where it is silently swallowed.
 */
async function pressUntil(page, key, selector, attempts = 20) {
  const target = page.locator(selector).first();
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.keyboard.press(key);
    try {
      await target.waitFor({ timeout: 3000 });
      return;
    } catch {
      if (attempt === attempts - 1) throw new Error(`"${key}" never showed ${selector}`);
    }
  }
}

/** Opens Save Game and stores `name`. */
async function saveAs(page, name) {
  await pressUntil(page, 'Control+s', '.modal-box[aria-label="Save Game"]');
  await page.locator('.modal-box[aria-label="Save Game"] input[type=text]').fill(name);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
}

async function deleteSave(page, name) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const req = indexedDB.open('wesnothweb2-saves');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('saves', 'readwrite');
          tx.objectStore('saves').delete(n);
          tx.oncomplete = () => (db.close(), resolve());
        };
      }),
    name,
  );
}

const browser = await chromium.launch({ headless: !headed });
try {
  // ── Part 1: a cold replay opened from the title screen ──────────────────────────────────────────
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(`${base}/play/liberty`);
    await waitBoardReady(page);
    await skipToPlay(page);
    await recordOneAction(page);

    await saveAs(page, 'menu-replay-check');
    const recorded = await page.evaluate(() => window.__wesnoth.session.toSaveData().replay?.commands.length ?? 0);
    check('the save actually has a recorded action to replay', recorded > 0, `${recorded} commands`);

    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('button', { name: /Quit to Menu/ }).click();
    await page.getByRole('button', { name: 'Yes' }).click();
    await page.waitForSelector('[data-testid="title-screen"]', { timeout: 15000 });

    await pressUntil(page, 'Control+o', '[data-testid="show-replay"]');
    check('the title screen\'s Load dialog offers "Show replay"', true);
    await page.check('[data-testid="show-replay"]');
    await page.getByText('menu-replay-check').first().click();
    await page.getByRole('button', { name: 'Load', exact: true }).last().click();
    await page.waitForURL(/\/play\/liberty\?save=menu-replay-check&replay=1/, { timeout: 15000 });
    await waitSession(page);
    await page.waitForSelector('[data-testid="replay-bar"]', { timeout: 15000 });
    check('...and loading it opens straight into the replay screen, not a resumed game', true);
    const progress = await page.locator('[data-testid="replay-progress"]').innerText();
    check('the replay bar shows the recorded action(s)', /\/\s*\d+/.test(progress) && !progress.startsWith('0 / 0'), progress);
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    await deleteSave(page, 'menu-replay-check');
    await context.close();
  }

  // ── Part 2: in-game "Show replay" of a save from a DIFFERENT campaign hands off correctly ───────
  // (this is the exact path that broke: `startReplay` used to run directly, fetching through the
  // currently-open campaign's own directory for a scenario id that lives in the other one's)
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // A debug-campaign save with a real recorded action, made once, from the menu (a different campaign
    // than the one we open below -- its own assetDir, "combat", is what exercises the fix).
    await page.goto(`${base}/play/synthetic_combat`);
    await waitBoardReady(page);
    await skipToPlay(page);
    await recordOneAction(page);
    await saveAs(page, 'cross-campaign-replay-check');

    // Now open a DIFFERENT campaign (Liberty) and use its own in-game Load dialog to show that save's replay.
    await page.goto(`${base}/play/liberty`);
    await waitBoardReady(page);
    await skipToPlay(page);
    await pressUntil(page, 'Control+o', '[data-testid="show-replay"]');
    await page.check('[data-testid="show-replay"]');
    await page.getByText('cross-campaign-replay-check').first().click();
    await page.getByRole('button', { name: 'Load', exact: true }).last().click();
    await page.waitForURL(/\/play\/synthetic_combat\?save=cross-campaign-replay-check&replay=1/, { timeout: 15000 });
    // `waitSession` alone would resolve immediately on the STALE Liberty session still in `window.__wesnoth`
    // from before this client-side navigation remounted `PlayPage`; wait for the new one specifically.
    await page.waitForFunction(() => window.__wesnoth?.session?.snapshot?.assetDir === 'combat', null, { timeout: 30000 });
    const info = await sessionInfo(page);
    check('the handoff reopens the SAVE\'s own campaign (combat), not the one that was open (Liberty)', info?.campaign === 'combat', JSON.stringify(info));
    await page.waitForSelector('[data-testid="replay-bar"]', { timeout: 15000 });
    check('...and lands in the replay screen there, not a 404', true);
    check('no page errors (the pre-fix regression: a 404 fetching the wrong campaign directory)', errors.length === 0, errors.slice(0, 3).join(' | '));

    await deleteSave(page, 'cross-campaign-replay-check');
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
