/**
 * The game in real Safari, driven through `safaridriver` (macOS's own WebDriver server): desktop Safari, or
 * Mobile Safari in an iOS simulator. Run by the Safari workflow (.github/workflows/safari.yml) on GitHub's
 * macOS runners; it speaks W3C WebDriver over HTTP directly, so it needs no client library.
 *
 *   safaridriver --port 4444 &
 *   node apps/web/scripts/safari-webdriver.mjs [--base http://localhost:5173] [--driver http://localhost:4444]
 *       [--simulator "iPhone 16"] [--out safari-results] [--timeout-minutes 15]
 *
 * For each of the title screen, The South Guard 1 and Of Pearls and Pirates 1 it:
 *   - waits until the page is ready (the title screen, or the board with play started);
 *   - fails if the game's error screen is up, or the page reported an error (collected from `error` and
 *     `unhandledrejection` once the page has loaded: earlier ones only show as the error screen);
 *   - saves a screenshot and the board's mean colour (results.json), to compare with another browser's.
 *
 * Needs the dev server (`window.__wesnoth` is how it knows play has started).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = opt('--base', 'http://localhost:5173');
const driver = opt('--driver', 'http://localhost:4444');
const simulator = opt('--simulator', null);
const out = opt('--out', 'safari-results');
const timeout = Number(opt('--timeout-minutes', '15')) * 60000;
const label = simulator ? `iOS simulator (${simulator})` : 'desktop Safari';
mkdirSync(out, { recursive: true });

const failures = [];
const results = { target: label, checks: [] };
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  results.checks.push({ name, ok, detail });
  if (!ok) failures.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(`${driver}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.value ?? json).slice(0, 500)}`);
  return json.value;
}

const capabilities = simulator
  ? { browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceName': simulator }
  : { browserName: 'safari' };
const session = await wd('POST', '/session', { capabilities: { alwaysMatch: capabilities } });
const sid = session.sessionId;
console.log(`${label}: ${session.capabilities.browserName} ${session.capabilities.browserVersion} on ${session.capabilities.platformName}`);
results.browser = session.capabilities;

const run = (script, ...scriptArgs) => wd('POST', `/session/${sid}/execute/sync`, { script, args: scriptArgs });
async function waitFor(what, script, ms = timeout) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      if (await run(script)) return true;
    } catch {
      // The page can be between documents.
    }
    await sleep(1000);
  }
  throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
}
async function press(key) {
  await wd('POST', `/session/${sid}/actions`, {
    actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: key }, { type: 'keyUp', value: key }] }],
  });
}
const ESCAPE = '';
const ENTER = '';

/** Collects the page's errors from now on (in `window.__safariErrors`). */
const collectErrors = () =>
  run(`
    if (!window.__safariErrors) {
      window.__safariErrors = [];
      addEventListener('error', (e) => __safariErrors.push('error: ' + (e.error && e.error.stack || e.message)));
      addEventListener('unhandledrejection', (e) => __safariErrors.push('rejection: ' + (e.reason && e.reason.stack || e.reason)));
    }`);
const pageErrors = () => run('return window.__safariErrors || []');
const errorScreen = () => run(`const s = document.querySelector('[data-testid="error-screen"] .message'); return s ? s.textContent : null`);

async function screenshot(name) {
  const png = Buffer.from(await wd('GET', `/session/${sid}/screenshot`), 'base64');
  writeFileSync(join(out, `${name}.png`), png);
  return png;
}
/** The mean colour of the middle of the screen (the board, once play has started). */
function meanColour(png) {
  const img = PNG.sync.read(png);
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor(img.height * 0.3); y < img.height * 0.7; y++) {
    for (let x = Math.floor(img.width * 0.2); x < img.width * 0.8; x++) {
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] += img.data[i + c];
      n++;
    }
  }
  return sum.map((v) => Math.round(v / n));
}

/** Dismisses the story screens and opening dialogues, as `skipToPlay` does in the Playwright checks. */
async function skipToPlay() {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < timeout) {
    const state = await run(`
      if (document.querySelector('.story')) return 'story';
      if (document.querySelector('.window[role="dialog"], [data-testid="gui-dialog"]')) return 'dialogue';
      const ok = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'OK');
      if (ok) { ok.click(); return 'ok'; }
      return null;`).catch(() => 'navigating');
    if (state === 'story') await press(ESCAPE);
    else if (state === 'dialogue') await press(ENTER);
    if (state) quiet = 0;
    else if (++quiet >= 3) return;
    await sleep(500);
  }
  throw new Error('still in a pre-play screen');
}

async function scenario(name, path) {
  const started = Date.now();
  try {
    await wd('POST', `/session/${sid}/url`, { url: `${base}${path}` });
    await waitFor('the page', 'return document.readyState === "complete"', 120000);
    await collectErrors();
    await waitFor('the game session', 'return !!(window.__wesnoth && window.__wesnoth.session) || !!document.querySelector(\'[data-testid="error-screen"]\')');
    await waitFor('the board', 'return !document.querySelector(\'[data-testid="board-loading"]\') || !!document.querySelector(\'[data-testid="error-screen"]\')');
    if (!(await errorScreen())) await skipToPlay();
    await sleep(5000);
    const seconds = Math.round((Date.now() - started) / 1000);
    const shot = await screenshot(name);
    const colour = meanColour(shot);
    const shown = await errorScreen();
    const errors = await pageErrors();
    results[name] = { seconds, colour, errors, errorScreen: shown };
    check(`${name} starts, with no error`, !shown && errors.length === 0, shown ?? errors.slice(0, 2).join(' | '));
    console.log(`     ${seconds} s to play; board mean RGB ${colour.join(',')}`);
  } catch (e) {
    await screenshot(name).catch(() => {});
    check(`${name} starts, with no error`, false, String(e.message ?? e));
  }
}

try {
  if (!simulator) await wd('POST', `/session/${sid}/window/rect`, { width: 1280, height: 800 }).catch(() => {});
  // No statistics prompt: it would cover the screen, and these runs are not players.
  await wd('POST', `/session/${sid}/url`, { url: base });
  await run("localStorage.setItem('wesnothweb2.statsConsent', 'no')");
  await wd('POST', `/session/${sid}/url`, { url: base });
  try {
    await collectErrors();
    await waitFor('the title screen', 'return !!document.querySelector(\'[data-testid="title-screen"]\') || !!document.querySelector(\'[data-testid="error-screen"]\')', 300000);
    await sleep(3000);
    await screenshot('title');
    const shown = await errorScreen();
    const errors = await pageErrors();
    check('the title screen loads with no error', !shown && errors.length === 0, shown ?? errors.slice(0, 2).join(' | '));
  } catch (e) {
    await screenshot('title').catch(() => {});
    check('the title screen loads with no error', false, String(e.message ?? e));
  }
  results.webgl = await run(`
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) };`).catch((e) => String(e));
  console.log(`     WebGL 2: ${JSON.stringify(results.webgl)}`);

  await scenario('south-guard-1', '/play/the_south_guard?difficulty=EASY');
  await scenario('pearls-and-pirates-1', '/play/of_pearls_and_pirates?difficulty=NORMAL');
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
  await wd('DELETE', `/session/${sid}`).catch(() => {});
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
