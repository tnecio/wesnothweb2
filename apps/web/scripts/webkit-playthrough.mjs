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
 *   5. Its terrain has the colours Chromium draws (the board's mean colour, the same view): WebKit uploads a
 *      worker's `transferToImageBitmap` straight, and every translucent pixel used to draw far too bright
 *      (`ImageCache.transferredBitmapsUploadStraight`; reported on Of Pearls and Pirates 1).
 */
import { webkit, chromium, devices } from 'playwright';
import { skipToPlay } from './lib/browserFlows.mjs';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:5173';
const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await webkit.launch();

/** The board's mean colour once play has started, with the camera where the scenario puts it (a screenshot). */
async function boardColour(page) {
  await page.waitForSelector('[data-testid="board-loading"]', { state: 'detached', timeout: 600000 });
  await skipToPlay(page, 600000);
  await page.waitForTimeout(4000);
  const box = await page.locator('canvas').first().boundingBox();
  const shot = PNG.sync.read(await page.screenshot({ clip: { x: box.x + box.width * 0.2, y: box.y + box.height * 0.2, width: box.width * 0.6, height: box.height * 0.4 } }));
  const sum = [0, 0, 0];
  for (let i = 0; i < shot.data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += shot.data[i + c];
  return sum.map((v) => Math.round(v / (shot.data.length / 4)));
}
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

  const webkitColour = await boardColour(page);
  await page.context().close();
  const reference = await chromium.launch();
  try {
    const { defaultBrowserType: _unused, ...iphone } = devices['iPhone 15'];
    const cpage = await (await reference.newContext(iphone)).newPage();
    await cpage.addInitScript(() => localStorage.setItem('wesnothweb2.statsConsent', 'no'));
    await cpage.goto(`${base}/play/the_south_guard?difficulty=EASY`, { waitUntil: 'load', timeout: 120000 });
    await cpage.waitForFunction(() => !!window.__wesnoth?.session, null, { timeout: 300000 });
    await cpage.waitForSelector('canvas', { timeout: 300000 });
    const chromiumColour = await boardColour(cpage);
    const diff = Math.max(...webkitColour.map((c, i) => Math.abs(c - chromiumColour[i])));
    check("the terrain's colours are Chromium's (board mean RGB)", diff <= 6, `WebKit ${webkitColour.join(',')} vs Chromium ${chromiumColour.join(',')}`);
  } finally {
    await reference.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
