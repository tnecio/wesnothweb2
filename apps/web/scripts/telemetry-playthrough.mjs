/**
 * Phase 30: the opt-in statistics and "Report a bug", end to end in the real app.
 *
 *   # the stats Worker, locally, accepting this page's origin:
 *   (cd apps/stats && npx wrangler d1 migrations apply wesnoth-stats --local &&
 *    npx wrangler dev --local --port 8787 --var MAIL_TO:dev@example.com --var ALLOWED_ORIGINS:http://localhost:5191)
 *   # the game, built to send to it:
 *   (cd apps/web && VITE_STATS_URL=http://localhost:8787 npx vite --port 5191 --strictPort)
 *   node apps/web/scripts/telemetry-playthrough.mjs [--base http://localhost:5191] [--stats http://localhost:8787] [--shots <dir>]
 *
 * Checks, on the debug keyboard scenario (it opens in seconds):
 *   1. The title screen asks once; answering No sends nothing, through a whole game and Quit to Menu.
 *   2. Answering Yes: a new game sends scenario_start, Quit to Menu sends quit (by beacon), opening a save
 *      sends game_load, and a crash (`?crashtest`) sends crash -- each with the campaign, scenario and run.
 *   3. Report a bug from the game's Menu reaches the Worker with the game attached, and answers a reference.
 *   4. With the Worker unreachable, the dialog offers Copy / Download instead.
 * Run it alone: it is slow under software rendering and should not share the machine with other browser runs.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openScenario, skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const base = arg('base', 'http://localhost:5191');
const stats = arg('stats', 'http://localhost:8787');
const shots = arg('shots', null);

const statsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../stats');

/**
 * What the local Worker stored (its D1, as `wrangler dev --local` keeps it): events go by `sendBeacon` when a
 * page is left, which the browser hands over without the page seeing it, so the database is where to look.
 */
function storedEvents(afterId = 0) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'wesnoth-stats', '--local', '--json', '--command', `SELECT * FROM events WHERE id > ${afterId} ORDER BY id`], { cwd: statsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].results.map((r) => ({ ...r, ...(r.data ? JSON.parse(r.data) : {}) }));
}
const lastEventId = () => storedEvents().at(-1)?.id ?? 0;

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch();

/** A fresh browser profile, recording every request to the stats server (events and reports). */
async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  const sent = { events: [], reports: [] };
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (req) => {
    if (!req.url().startsWith(stats) || req.method() !== 'POST') return;
    const body = req.postData();
    if (req.url().endsWith('/v1/events')) sent.events.push(...JSON.parse(body ?? '[]'));
    if (req.url().endsWith('/v1/reports')) sent.reports.push(JSON.parse(body ?? '{}'));
  });
  return { context, page, errors, sent };
}

async function quitToMenu(page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: /Quit to Menu/ }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await page.waitForSelector('[data-testid="title-screen"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
}

async function startGame(page) {
  await openScenario(page, base, 'synthetic_keyboard');
  await waitBoardReady(page);
  await skipToPlay(page);
}

try {
  // --- 1. asked once; No sends nothing ---------------------------------
  {
    const { context, page } = await freshPage();
    const before = lastEventId();
    await page.goto(base);
    await page.waitForSelector('[data-testid="stats-consent"]', { timeout: 60000 });
    check('the title screen asks about statistics', true);
    if (shots) await page.screenshot({ path: `${shots}/consent.png` });
    await page.click('[data-testid="stats-consent-no"]');
    check('...and the question goes once answered', (await page.$('[data-testid="stats-consent"]')) === null);
    await startGame(page);
    await quitToMenu(page);
    await page.reload();
    await page.waitForSelector('[data-testid="title-screen"]');
    const stored = storedEvents(before);
    check('answering No sends nothing, through a game and Quit to Menu', stored.length === 0, `${stored.length} stored`);
    check('...and the question is not asked again', (await page.$('[data-testid="stats-consent"]')) === null);
    await context.close();
  }

  // --- 2. Yes: the events ----------------------------------------------
  const { context, page, errors } = await freshPage();
  const yesFrom = lastEventId();
  await page.goto(base);
  await page.waitForSelector('[data-testid="stats-consent"]', { timeout: 60000 });
  await page.click('[data-testid="stats-consent-yes"]');
  await startGame(page);
  const runId = await page.evaluate(() => window.__wesnoth.session.runId);
  await quitToMenu(page);
  let events = storedEvents(yesFrom);
  const types = () => events.map((e) => e.type);
  check('a new game sends scenario_start', types().includes('scenario_start'), types().join(','));
  check('Quit to Menu mid-scenario sends quit', types().includes('quit'), types().join(','));
  const start = events.find((e) => e.type === 'scenario_start');
  check(
    '...with the campaign, scenario, run and coarse environment, and nothing else',
    start?.campaign === 'synthetic_keyboard' && typeof start?.scenario === 'string' && start?.run === runId && start?.device === 'desktop' && start?.browser === 'chrome',
    JSON.stringify(start),
  );

  // Opening a save: the start-of-scenario save the game just wrote.
  const saveName = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('wesnothweb2-saves');
        req.onsuccess = () => {
          const all = req.result.transaction('saves', 'readonly').objectStore('saves').getAllKeys();
          all.onsuccess = () => resolve(all.result.find((k) => /Keyboard/i.test(String(k))) ?? all.result[0] ?? null);
        };
      }),
  );
  await page.goto(`${base}/play/synthetic_keyboard?save=${encodeURIComponent(saveName)}`);
  await waitBoardReady(page);
  await skipToPlay(page);
  const loadedRun = await page.evaluate(() => window.__wesnoth.session.runId);
  await quitToMenu(page);
  events = storedEvents(yesFrom);
  const load = events.find((e) => e.type === 'game_load');
  check('opening a save sends game_load, in the same run', load?.kind === 'opened' && load?.run === runId && loadedRun === runId, JSON.stringify(load));

  // A crash.
  await page.goto(`${base}/?crashtest`);
  await page.waitForSelector('[data-testid="error-screen"]', { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(2000);
  events = storedEvents(yesFrom);
  const crash = events.find((e) => e.type === 'crash');
  check('a crash sends crash, with its message and signature', /Crash test/.test(crash?.message ?? '') && /Crash test/.test(crash?.signature ?? ''), JSON.stringify(crash));
  check('no page errors but the crash test', errors.every((e) => /Crash test/.test(e)), errors.join(' | '));
  await context.close();

  // --- 3. Report a bug from the game ------------------------------------
  {
    const { context, page, sent } = await freshPage();
    await page.addInitScript(() => localStorage.setItem('wesnothweb2.statsConsent', 'no'));
    await startGame(page);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('button', { name: /Report a Bug/ }).click();
    await page.waitForSelector('[data-testid="bug-report"]');
    check('Report a bug: the game can be attached, and is by default', await page.isChecked('[data-testid="bug-report-include-save"]'));
    check('...Send waits for a description', await page.isDisabled('[data-testid="bug-report-send"]'));
    await page.fill('[data-testid="bug-report-description"]', 'Telemetry playthrough: a test report.');
    if (shots) await page.screenshot({ path: `${shots}/bug-report.png` });
    await page.click('[data-testid="bug-report-send"]');
    await page.waitForSelector('[data-testid="bug-report-sent"]', { timeout: 30000 });
    const report = sent.reports[0];
    check(
      '...it reaches the Worker with where the player is and the game, and the player gets a reference',
      report?.description === 'Telemetry playthrough: a test report.' && report?.context?.campaign === 'synthetic_keyboard' && report?.save?.turnNumber >= 1 && /reference is \S+/.test(await page.textContent('[data-testid="bug-report"]')),
      JSON.stringify({ ...report, save: report?.save ? '(save)' : undefined, log: report?.log?.length }),
    );
    await page.getByRole('button', { name: 'Close' }).click();

    // --- 4. unreachable: copy / download instead ------------------------
    await page.route(`${stats}/v1/reports`, (route) => route.abort());
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('button', { name: /Report a Bug/ }).click();
    await page.fill('[data-testid="bug-report-description"]', 'Unreachable.');
    await page.click('[data-testid="bug-report-send"]');
    await page.waitForSelector('[data-testid="bug-report-failed"]', { timeout: 30000 });
    check('with the server unreachable, the dialog offers Copy / Download instead', (await page.$('[data-testid="bug-report-copy"]')) !== null);
    await context.close();
  }
} catch (err) {
  check('the run finished', false, String(err).slice(0, 300));
}

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
