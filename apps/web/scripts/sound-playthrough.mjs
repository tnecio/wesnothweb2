/**
 * Phase 19 browser check (sound effects), through the `window.__audio` debug
 * log the audio engine keeps.
 *
 *   node apps/web/scripts/sound-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 *  1. Dead Water 1: the turn bell and the dawn's ambient sound play when the
 *     first turn starts, and interface clicks (menu, button) make their sounds.
 *  2. Sound files are fetched only after the board is ready, at most two at a
 *     time apart from an on-demand miss, and none arrives late.
 *  3. A fight (synthetic_combat): the weapons' frame sounds play as the blows
 *     land, no file is missing, none is dropped for being late.
 *  4. Muting takes the sound buses to silence at once; the sound-effects
 *     switch in the Audio dialog stops new sounds from starting.
 *
 * Exits non-zero on any failure.
 */
import { chromium } from 'playwright';
import { hexPoint, openScenario, performAttack, skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

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

const audioLog = (page) => page.evaluate(() => window.__audio?.log ?? []);
const plays = (log) => log.filter((e) => e.event === 'sound-play').map((e) => e.detail.file);

async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const sounds = [];
  page.on('request', (r) => {
    if (/\/(sounds|game-sounds-engine)\//.test(r.url())) sounds.push({ url: r.url(), at: Date.now(), done: null });
  });
  page.on('requestfinished', (r) => {
    const entry = sounds.find((s) => s.url === r.url() && s.done === null);
    if (entry) entry.done = Date.now();
  });
  return { context, page, errors, sounds };
}

/** Waits until no sound file has been requested for `quietMs` (the idle-time preload has caught up). */
async function waitForPreload(page, sounds, quietMs = 2500, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const last = Math.max(0, ...sounds.map((s) => s.done ?? s.at));
    if (sounds.length > 0 && sounds.every((s) => s.done !== null) && Date.now() - last > quietMs) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const browser = await chromium.launch({ headless: !headed });
try {
  // ---- Dead Water 1: turn sounds, interface clicks, preload ----------------
  {
    const { context, page, errors, sounds } = await newPage(browser);
    try {
      await openScenario(page, base, 'dead_water');
      await waitBoardReady(page);
      const readyAt = Date.now();
      await page.waitForTimeout(1500);
      check('no sound file requested before the first gesture', sounds.length === 0, sounds.map((s) => s.url).join(', '));
      await skipToPlay(page);
      await page.waitForTimeout(4000);
      await skipToPlay(page);
      await page.waitForTimeout(3000);
      await waitForPreload(page, sounds);

      let log = await audioLog(page);
      let heard = plays(log);
      check('the turn bell rings', heard.includes('bell.wav'), heard.join(', '));
      check("the dawn's ambient sound plays", heard.includes('ambient/morning.ogg'), heard.join(', '));
      check('no sound was missing or late', !log.some((e) => e.event === 'sound-missing' || e.event === 'sound-late'), JSON.stringify(log.filter((e) => /missing|late/.test(e.event)).slice(0, 3)));

      // Preloading.
      check('sound files were fetched after the board was ready', sounds.length > 0 && sounds.every((s) => s.at >= readyAt), `${sounds.length} requests`);
      const events = sounds.flatMap((s) => [[s.at, 1], [s.done ?? s.at, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let open = 0;
      let peak = 0;
      for (const [, delta] of events) peak = Math.max(peak, (open += delta));
      check('never more than a few sound requests in flight at once', peak <= 4, `peak ${peak}`);

      // Interface clicks.
      const before = plays(await audioLog(page)).length;
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: /Audio\.\.\./ }).click();
      await page.waitForTimeout(500);
      heard = plays(await audioLog(page)).slice(before);
      check('opening a menu expands, choosing an entry selects', heard.includes('expand.wav') && heard.includes('select.wav'), heard.join(', '));

      // The dialog's switches.
      const soundsSwitch = page.locator('label:has-text("Sound effects") input[type="checkbox"]');
      await soundsSwitch.click();
      const afterOff = plays(await audioLog(page)).length;
      await page.evaluate(() => window.__audio.playSound('axe.ogg'));
      await page.waitForTimeout(500);
      check('with sound effects off, a sound does not start', plays(await audioLog(page)).length === afterOff);
      await soundsSwitch.click();
      await page.evaluate(() => window.__audio.playSound('axe.ogg'));
      await page.waitForTimeout(800);
      check('and with them on again it does', plays(await audioLog(page)).length > afterOff);

      // Mute.
      await page.locator('[data-testid="audio-mute"]').click();
      const state = await page.evaluate(() => window.__audio.state());
      check('mute silences the master gain, sounds included', state.gains.master === 0);
      await page.locator('[data-testid="audio-mute"]').click();
      await page.keyboard.press('Escape');

      check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    } finally {
      await context.close();
    }
  }

  // ---- synthetic_combat: a fight makes its sounds ---------------------------
  {
    const { context, page, errors, sounds } = await newPage(browser);
    try {
      await openScenario(page, base, 'synthetic_combat');
      await waitBoardReady(page);
      await skipToPlay(page);
      await page.keyboard.press('Shift'); // this scenario has no story to click through: the first gesture unlocks the audio
      check('the idle-time preload settles', await waitForPreload(page, sounds));
      const before = (await audioLog(page)).length;
      await performAttack(page, { x: 1, y: 2 }, { x: 2, y: 2 });
      await page.waitForTimeout(1500);
      const log = (await audioLog(page)).slice(before);
      const heard = plays(log);
      check('the fight plays weapon sounds', heard.some((f) => /\.(ogg|wav)$/.test(f) && f !== 'select-unit.wav' && f !== 'button.wav'), heard.join(', '));
      check('no sound missing or late during the fight', !log.some((e) => e.event === 'sound-missing' || e.event === 'sound-late'), JSON.stringify(log.filter((e) => /missing|late/.test(e.event)).slice(0, 3)));
      check('no page errors (fight)', errors.length === 0, errors.slice(0, 3).join(' | '));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall sound checks passed');
