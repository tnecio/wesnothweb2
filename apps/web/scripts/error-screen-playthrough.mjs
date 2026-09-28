/**
 * Phase 28 S6 milestone: a run-time error shows the error screen, whose report carries the error, its stack,
 * the build and where the player was, and "Load latest autosave" resumes the game.
 *
 *   node apps/web/scripts/error-screen-playthrough.mjs [--base http://localhost:5173]
 *
 * The error comes from `?crashtest` (apps/web/src/main.ts), which throws a few seconds after the page loads.
 */
import { chromium } from 'playwright';
import { skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:5173';

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();

  // Play into turn 1 first, so the player-turn autosave exists.
  // The opening dialogue starts once the board is ready, and the start-of-scenario save comes after it.
  await page.goto(`${base}/play/liberty`);
  await skipToPlay(page);
  await waitBoardReady(page);
  await skipToPlay(page);
  await page.waitForTimeout(3000);

  await page.goto(`${base}/play/liberty?crashtest`);
  await skipToPlay(page).catch(() => {});
  const screen = page.getByTestId('error-screen');
  await screen.waitFor({ timeout: 60000 }).catch(() => {});
  check('an uncaught error shows the error screen', await screen.isVisible());
  check('it shows the error', (await screen.textContent())?.includes('Crash test') ?? false);

  await page.getByTestId('error-copy').click();
  const report = await page.evaluate(() => navigator.clipboard.readText());
  check('the report names the error and has its stack', report.includes('Crash test') && /at .+:\d+/.test(report), report.split('\n')[8]);
  check('the report names the build', /^Build: \S+/m.test(report), report.split('\n')[1]);
  check('the report says where the player was', /Campaign: liberty; scenario: 01_The_Raid/.test(report), report.split('\n')[5]);

  const load = page.getByTestId('error-load-autosave');
  // Found asynchronously, once the game has registered where the player is.
  await load.waitFor({ timeout: 15000 }).catch(() => {});
  check('"Load latest autosave" is offered', await load.isVisible());
  if (await load.isVisible()) {
    await load.click();
    await page.waitForURL(/save=/, { timeout: 30000 });
    await waitBoardReady(page);
    check('...and it reopens the game from that save', page.url().includes('save=') && !(await page.getByTestId('error-screen').isVisible()), page.url());
  }
  await context.close();
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
