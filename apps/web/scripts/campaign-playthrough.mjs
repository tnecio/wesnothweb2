/**
 * Phase 28c: a newly added campaign, started the way a player starts it, in a real browser.
 *
 *   node apps/web/scripts/campaign-playthrough.mjs --campaign <id>[,<id>...] [--scenario <id>[,<id>...]] [--base http://localhost:5173] [--headed] [--shots dir]
 *
 * For each campaign (its `campaigns.json` id): the title screen's Campaigns dialog, the campaign chosen, Play
 * at its default difficulty; through the story and the opening dialogue to the board; End Turn, the other sides'
 * turns (their dialogue answered) and back to the player's turn 2 -- with no page error and no failed request
 * for the game's own files. `--shots dir` saves the board at turn 1. `--scenario` instead opens each named
 * scenario of the (one) campaign straight from its page URL (`?scenario=`), for ones later in a campaign.
 * Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { DIALOGUE, confirmEndTurnIfAsked, skipToPlay, untilPlayable, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const shots = arg('shots', null);
const campaigns = (arg('campaign', '') ?? '').split(',').filter(Boolean);
if (campaigns.length === 0) throw new Error('usage: campaign-playthrough.mjs --campaign <id>[,<id>...]');
const scenarios = (arg('scenario', '') ?? '').split(',').filter(Boolean);
if (scenarios.length > 0 && campaigns.length !== 1) throw new Error('--scenario needs exactly one --campaign');
/** What each run starts: a campaign from the menu, or one of its scenarios by URL. */
const runs = scenarios.length > 0 ? scenarios.map((scenario) => ({ id: campaigns[0], scenario })) : campaigns.map((id) => ({ id, scenario: null }));

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch({ headless: !args.includes('--headed') });
try {
  for (const { id: campaignId, scenario } of runs) {
    const id = scenario ? `${campaignId}/${scenario}` : campaignId;
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    const missing = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => {
      if (!r.url().startsWith(base)) return;
      if (r.status() >= 400) missing.push(`${r.status()} ${r.url().slice(base.length)}`);
      // The dev server answers a missing file with its index page (200, text/html): an image or data file that comes back as HTML is missing too.
      else if (/\.(png|webp|jpg|json|ogg|cfg)(\?|$)/.test(new URL(r.url()).pathname) && (r.headers()['content-type'] ?? '').includes('text/html'))
        missing.push(`html ${r.url().slice(base.length)}`);
    });
    if (scenario) {
      await page.goto(`${base}/play/${campaignId}?scenario=${encodeURIComponent(scenario)}`);
    } else {
      await page.goto(`${base}/`);
      await page.waitForSelector('[data-testid="title-help"]', { timeout: 120000 });
      await page.keyboard.press('c');
      await page.waitForSelector(`[data-testid="campaign-${id}"]`, { timeout: 30000 });
      await page.click(`[data-testid="campaign-${id}"]`);
      await page.click('[data-testid="campaign-play"]');
      const opened = await page
        .waitForURL(new RegExp(`/play/${id}`), { timeout: 30000 })
        .then(() => true)
        .catch(() => false);
      check(`${id}: Play opens the campaign`, opened, page.url());
    }

    try {
      await waitBoardReady(page);
      await skipToPlay(page, 900000);
      // Some campaigns open with a cutscene scenario and long dialogue: minutes at this VM's frame rate.
      await untilPlayable(page, 900000);
    } catch (e) {
      check(`${id}: reaches the board and the player's turn`, false, String(e).slice(0, 200));
      if (shots) await page.screenshot({ path: `${shots}/${id.replace('/', '-')}-stuck.png` });
      await page.close();
      continue;
    }
    const first = await page.evaluate(() => ({ scenario: window.__wesnoth.session.snapshot.scenario.id, turn: window.__wesnoth.session.turnNumber }));
    check(`${id}: its first scenario reaches the player's turn`, first.turn === 1 && (!scenario || first.scenario === scenario), JSON.stringify(first));
    if (shots) await page.screenshot({ path: `${shots}/${id.replace('/', '-')}.png` });

    // A tutorial (HttT Classic's) keeps the turn going with [disallow_end_turn] until the player has done
    // what it teaches: that it is in force is the check there.
    const blocked = await page.evaluate(() => window.__wesnoth.session.endTurnBlocked);
    if (blocked !== null) {
      check(`${id}: the scenario disallows ending the first turn`, true, blocked);
      check(`${id}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
      check(`${id}: no failed requests`, missing.length === 0, missing.slice(0, 5).join(' | '));
      await page.close();
      continue;
    }
    // A message can still open after the quiet spell (TDG 7's opening): answer it and try again.
    for (let attempt = 0; ; attempt++) {
      const clicked = await page.getByRole('button', { name: 'End Turn' }).click({ timeout: 60000 }).then(() => true, () => false);
      if (clicked) break;
      // The click may have landed and opened the end-turn question, which then covers the button.
      if (await confirmEndTurnIfAsked(page, 0)) break;
      if (attempt >= 30) {
        if (shots) await page.screenshot({ path: `${shots}/${id.replace('/', '-')}-covered.png` });
        throw new Error(`${id}: End Turn stayed covered`);
      }
      await untilPlayable(page, 900000);
    }
    await confirmEndTurnIfAsked(page);
    let turn2 = false;
    for (const deadline = Date.now() + 900000; !turn2 && Date.now() < deadline; ) {
      if (await page.$(DIALOGUE)) await page.keyboard.press('Enter');
      await confirmEndTurnIfAsked(page, 0);
      await page.waitForTimeout(2000);
      turn2 = await page.evaluate(() => {
        const s = window.__wesnoth.session;
        return (s.turnNumber === 2 && s.activeSide === s.playerSide) || s.scenarioResult !== null;
      });
      if (process.env.CAMPAIGN_TRACE) {
        console.log('state', JSON.stringify(await page.evaluate(() => {
          const s = window.__wesnoth.session;
          return { turn: s.turnNumber, side: s.activeSide, player: s.playerSide, canAct: window.__wesnoth.movementPreview().canAct, phase: window.__wesnoth.movementPreview().phase, dialog: document.querySelector('[role="dialog"]')?.textContent?.slice(0, 80) ?? null };
        })));
      }
    }
    if (!turn2 && shots) await page.screenshot({ path: `${shots}/${id.replace('/', '-')}-no-turn-2.png` });
    check(`${id}: End Turn plays the other sides and comes back to the player`, turn2);
    check(`${id}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    check(`${id}: no failed requests`, missing.length === 0, missing.slice(0, 5).join(' | '));
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
