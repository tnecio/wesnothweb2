/**
 * The game in WebKit as an iPhone shows it (Playwright's WebKit with its `iPhone 15` profile): the closest this
 * VM gets to Safari on iOS, where players reported crashes.
 *
 *   node apps/web/scripts/webkit-playthrough.mjs [--base http://localhost:5173]
 *
 * Needs Playwright's WebKit and its system libraries: `npx playwright install webkit` and
 * `sudo npx playwright install-deps webkit` (once per machine).
 *
 *   1. The title screen loads with no error.
 *   2. An error in another origin's script (what Safari's content blockers and extensions put into pages:
 *      the opaque "Script error.") and a request nobody waited for failing on the network (iOS cancels them
 *      in the background: "Load failed") do not bring up the error screen -- the reported "crashes".
 *   3. The game's own error does (`?crashtest`).
 *   4. The South Guard starts: its board is drawn, with no page error.
 */
import { webkit, devices } from 'playwright';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:5173';
const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await webkit.launch();
const errorScreen = async (page) => (await page.locator('text=Something went wrong').count()) > 0;

async function open(url) {
  const context = await browser.newContext({ ...devices['iPhone 15'] });
  await context.route('https://injected.example/**', (route) => route.fulfill({ contentType: 'text/javascript', body: 'setTimeout(function () { null.oops(); }, 0);' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('wesnothweb2.statsConsent', 'no'));
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('[data-testid="title-screen"]', { timeout: 120000 });
  return { page, errors };
}

try {
  let { page, errors } = await open(base);
  await page.waitForTimeout(3000);
  check('the title screen loads with no error', errors.length === 0 && !(await errorScreen(page)), errors.slice(0, 2).join(' | '));

  await page.evaluate(() => {
    const s = document.createElement('script');
    s.src = 'https://injected.example/x.js';
    document.head.appendChild(s);
  });
  await page.route('**/never-there.json', (route) => route.abort('failed'));
  await page.evaluate(() => {
    void fetch('/never-there.json');
  });
  await page.waitForTimeout(3000);
  check("another origin's script error and a failed request do not bring up the error screen", !(await errorScreen(page)));
  await page.context().close();

  ({ page } = await open(`${base}/?crashtest`));
  await page.waitForTimeout(8000);
  check("the game's own error (?crashtest) does", await errorScreen(page));
  await page.context().close();

  ({ page, errors } = await open(base));
  await page.getByRole('button', { name: /Campaign/ }).first().click();
  await page.waitForSelector('[data-testid="campaign-list"]', { timeout: 15000 });
  await page.locator('[data-testid="campaign-list"] [role="option"]').first().click();
  await page.click('[data-testid="campaign-play"]');
  await page.waitForURL(/\/play\/the_south_guard/, { timeout: 30000 });
  await page.waitForFunction(() => !!window.__wesnoth?.session, null, { timeout: 300000 });
  await page.waitForSelector('canvas', { timeout: 300000 });
  await page.waitForTimeout(5000);
  check('The South Guard starts, with no page error', errors.length === 0 && !(await errorScreen(page)), errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
