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
 *   - checks the board is drawn: WebGL's pixels at its centre, read right after one of the game's draws, are not
 *     just the clear colour;
 *   - saves a screenshot, the board's mean colour and the page's console warnings (results.json).
 * Before the scenarios it tries each way the game decodes images on a terrain image (`<img>`,
 * `createImageBitmap`, `ImageDecoder`, a worker's OffscreenCanvas, the WebGL upload). Desktop Safari on the
 * runners decodes none of them (InvalidStateError, while the iOS simulator decodes all): there the board
 * checks are skipped.
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
let canDecode = true;
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

/** Collects the page's errors from now on (in `window.__safariErrors`). */
const collectErrors = () =>
  run(`
    if (!window.__safariErrors) {
      window.__safariErrors = [];
      addEventListener('error', (e) => __safariErrors.push('error: ' + (e.error && e.error.stack || e.message)));
      addEventListener('unhandledrejection', (e) => __safariErrors.push('rejection: ' + (e.reason && e.reason.stack || e.reason)));
      window.__safariConsole = [];
      for (const level of ['warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...a) => { if (__safariConsole.length < 100) __safariConsole.push(level + ': ' + a.map(String).join(' ').slice(0, 300)); original(...a); };
      }
    }`);
const consoleLines = () => run('return window.__safariConsole || []');
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

/** Whether the page is drawing: frames in a second, visibility, the board canvas's size. */
const pageState = () =>
  wd('POST', `/session/${sid}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      let frames = 0;
      const tick = () => { frames++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      setTimeout(() => {
        const c = document.querySelector('canvas');
        const state = { framesPerSecond: frames, visibility: document.visibilityState, focus: document.hasFocus(),
          canvas: c ? [c.width, c.height, c.clientWidth, c.clientHeight] : null, dpr: devicePixelRatio };
        if (!c) return done(state);
        const style = getComputedStyle(c);
        const rect = c.getBoundingClientRect();
        state.css = { display: style.display, visibility: style.visibility, opacity: style.opacity,
          rect: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
          atCentre: (document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) || {}).tagName };
        // The drawing buffer is cleared once composited, so read it right after one of the game's own draws
        // (the board redraws only when something changes: up to 5 s for one, then a resize to force one).
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return done(state);
        state.gl = { lost: gl.isContextLost(), attributes: gl.getContextAttributes() };
        const draw = gl.drawElements;
        let sampled = false;
        const finish = () => {
          gl.drawElements = draw;
          clearTimeout(nudge);
          clearTimeout(giveUp);
          done(state);
        };
        gl.drawElements = function (...a) {
          draw.apply(this, a);
          if (sampled) return;
          sampled = true;
          queueMicrotask(() => {
            const w = 64, h = 64, px = new Uint8Array(w * h * 4);
            gl.readPixels(Math.floor(gl.drawingBufferWidth / 2 - w / 2), Math.floor(gl.drawingBufferHeight / 2 - h / 2), w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const sum = [0, 0, 0, 0];
            for (let i = 0; i < px.length; i++) sum[i % 4] += px[i];
            state.gl.centreMean = sum.map((v) => Math.round(v / (w * h)));
            state.gl.error = gl.getError();
            finish();
          });
        };
        const nudge = setTimeout(() => dispatchEvent(new Event('resize')), 5000);
        const giveUp = setTimeout(() => { state.gl.centreMean = 'no draw in 10 s'; finish(); }, 10000);
      }, 1000);`,
    args: [],
  }).catch((e) => String(e.message ?? e));

/**
 * How this browser handles each step an image takes before the board draws it, on a real terrain image
 * (opaque grass): the mean RGBA each way gives, which should all be about the same.
 */
const imagePipeline = () =>
  wd('POST', `/session/${sid}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      const url = '/game-images/core/images/terrain/grass/green.png';
      const out = { ImageDecoder: typeof ImageDecoder, OffscreenCanvas: typeof OffscreenCanvas, userAgent: navigator.userAgent };
      const mean = (data) => { const s = [0, 0, 0, 0]; for (let i = 0; i < data.length; i++) s[i % 4] += data[i]; return s.map((v) => Math.round(v / (data.length / 4))); };
      const drawn = (source, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(source, 0, 0); return mean(g.getImageData(0, 0, w, h).data); };
      const glMean = (source) => {
        const c = document.createElement('canvas'); c.width = 8; c.height = 8;
        const x = Math.floor(source.width / 2) - 4, y = Math.floor(source.height / 2) - 4;
        const gl = c.getContext('webgl', { preserveDrawingBuffer: true });
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        const px = new Uint8Array(8 * 8 * 4); gl.readPixels(x, y, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return { mean: mean(px), error: gl.getError() };
      };
      const step = async (name, f) => { try { out[name] = await f(); } catch (e) { out[name] = 'threw: ' + e; } };
      (async () => {
        const blob = await (await fetch(url)).blob();
        out.type = blob.type;
        const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
        out.bytes = [blob.size, Array.from(head).join(',')];
        await step('imgFromUrl', async () => { const i = new Image(); i.src = url; await i.decode(); return drawn(i, i.width, i.height); });
        await step('createImageBitmapFromImg', async () => { const i = new Image(); i.src = url; await i.decode(); const b = await createImageBitmap(i); return [b.width, drawn(b, b.width, b.height)]; });
        await step('canvasBlobRoundTrip', async () => {
          const c = document.createElement('canvas'); c.width = 4; c.height = 4; const g = c.getContext('2d'); g.fillStyle = '#3080c0'; g.fillRect(0, 0, 4, 4);
          const made = await new Promise((r) => c.toBlob(r, 'image/png'));
          const b = await createImageBitmap(made); return [made.size, drawn(b, 4, 4)];
        });
        await step('arrayBufferBlob', async () => { const b = await createImageBitmap(new Blob([await blob.arrayBuffer()], { type: 'image/png' })); return drawn(b, b.width, b.height); });
        await step('img', async () => { const i = new Image(); i.src = URL.createObjectURL(blob); await i.decode(); return drawn(i, i.width, i.height); });
        await step('createImageBitmap', async () => { const b = await createImageBitmap(blob, { colorSpaceConversion: 'none' }); return [b.width, b.height, drawn(b, b.width, b.height)]; });
        await step('createImageBitmapToWebGL', async () => glMean(await createImageBitmap(blob, { colorSpaceConversion: 'none' })));
        await step('ImageDecoder', async () => {
          if (typeof ImageDecoder === 'undefined') return 'none';
          const d = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type, premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          const { image } = await d.decode();
          const buf = new Uint8Array(image.allocationSize()); await image.copyTo(buf);
          const r = [image.format, image.codedWidth, image.codedHeight, mean(buf)]; image.close(); d.close(); return r;
        });
        await step('worker', () => new Promise((resolve) => {
          const code = 'onmessage = async (e) => { try { const b = await createImageBitmap(e.data, { colorSpaceConversion: "none" });'
            + ' const c = new OffscreenCanvas(b.width, b.height); const g = c.getContext("2d"); g.drawImage(b, 0, 0);'
            + ' const s = [0,0,0,0]; const d = g.getImageData(0, 0, b.width, b.height).data; for (let i = 0; i < d.length; i++) s[i % 4] += d[i];'
            + ' const t = c.transferToImageBitmap(); postMessage({ inWorker: s.map((v) => Math.round(v / (d.length / 4))), bitmap: t }, [t]); } catch (err) { postMessage({ error: String(err) }); } };';
          const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
          w.onmessage = (e) => { const r = e.data; if (r.bitmap) { r.transferredTo2d = drawn(r.bitmap, r.bitmap.width, r.bitmap.height); r.transferredToWebGL = glMean(r.bitmap); delete r.bitmap; } resolve(r); w.terminate(); };
          w.onerror = (e) => resolve('worker error: ' + e.message);
          w.postMessage(blob);
          setTimeout(() => resolve('worker timed out'), 15000);
        }));
        done(out);
      })().catch((e) => done('threw: ' + e));`,
    args: [],
  }).catch((e) => String(e.message ?? e));

/**
 * Dismisses the story screens and opening dialogues, as `skipToPlay` does in the Playwright checks (by clicking:
 * the story with Escape, a message by a click anywhere). Done when nothing has come up for 8 s.
 */
async function skipToPlay() {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < timeout) {
    const state = await run(`
      if (document.querySelector('.story')) return 'story';
      const option = document.querySelector('.wml-message-open button.option');
      if (option) { option.click(); return 'option'; }
      const message = document.querySelector('.wml-message-open');
      if (message) { message.click(); return 'message'; }
      const ok = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'OK');
      if (ok) { ok.click(); return 'ok'; }
      return null;`).catch(() => 'navigating');
    if (state === 'story') await press(ESCAPE);
    if (state) quiet = 0;
    else if (++quiet >= 8) return;
    await sleep(1000);
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
    const page = await pageState();
    const logged = await consoleLines();
    results[name] = { seconds, colour, errors, errorScreen: shown, page, console: logged };
    if (logged.length > 0) console.log(`     console (${logged.length}):\n       ${logged.slice(0, 15).join('\n       ')}`);
    console.log(`     ${JSON.stringify(page)}`);
    check(`${name} starts, with no error`, !shown && errors.length === 0, shown ?? errors.slice(0, 2).join(' | '));
    console.log(`     ${seconds} s to play; board mean RGB ${colour.join(',')}`);
    if (canDecode) {
      const centre = page?.gl?.centreMean;
      check(`${name}: the board is drawn`, Array.isArray(centre) && centre.slice(0, 3).some((c) => Math.abs(c - 0x11) > 8), `WebGL centre ${JSON.stringify(centre)} (the clear colour is 17,17,17)`);
    }
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

  results.imagePipeline = await imagePipeline();
  console.log(`     image pipeline: ${JSON.stringify(results.imagePipeline)}`);
  // Desktop Safari on GitHub's macOS runners decodes no image a script asks for (every way throws
  // InvalidStateError, while the same build on an iOS simulator decodes them all): the board cannot be drawn
  // there, which is the runner's, not the game's. Its other checks still hold.
  canDecode = Array.isArray(results.imagePipeline?.img);
  if (!canDecode) console.log('     this browser decodes no image for scripts here: the board checks are skipped');

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
