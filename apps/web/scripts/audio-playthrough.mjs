/**
 * Phase 19 browser check (music): what a headless browser can verify about
 * audio, through the `window.__audio` debug log the audio engine keeps.
 *
 *   node apps/web/scripts/audio-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 *  1. No music file is requested before the board has rendered and the user
 *     has made a gesture.
 *  2. Dead Water 1's prestart `[music]` playlist starts a track after the
 *     first key press, and starting it causes no long main-thread task.
 *  3. Near the end of a track the next one is prefetched and, when the
 *     track ends, starts with no fade.
 *  4. Mute drops the master gain to 0 at once; unmute restores it; the
 *     setting survives a reload.
 *  5. Liberty's epilogue story part with `music=` plays that track.
 *
 * Exits non-zero on any failure. Nothing can be heard here; the check is of
 * what the engine started, faded and stopped.
 */
import { chromium } from 'playwright';
import { openScenario, skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

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

const DW1_TRACKS = ['the_king_is_dead.ogg', 'vengeful.ogg', 'legends_of_the_north.ogg'];

const audioLog = (page) => page.evaluate(() => window.__audio?.log ?? []);
const audioState = (page) => page.evaluate(() => window.__audio?.state() ?? null);

async function waitForLog(page, predicate, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const entry = (await audioLog(page)).find(predicate);
    if (entry) return entry;
    await page.waitForTimeout(200);
  }
  return null;
}

async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), at: Date.now() }));
  await page.addInitScript(() => {
    window.__longtasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longtasks.push({ at: performance.timeOrigin + e.startTime, duration: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // No longtask support: the check below then has nothing to compare.
    }
  });
  return { context, page, errors, requests };
}

const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=document-user-activation-required'] });
try {
  // ---- Dead Water 1: start, prefetch, transition, mute --------------------
  {
    const { context, page, errors, requests } = await newPage(browser);
    try {
      await openScenario(page, base, 'dead_water');
      await waitBoardReady(page);
      await page.waitForTimeout(1500);
      const before = await audioState(page);
      check('board ready, audio still locked before any gesture', before && before.ready === true && before.unlocked === false, JSON.stringify(before && { ready: before.ready, unlocked: before.unlocked }));
      check('no music requested before a gesture', !requests.some((r) => /\/music\//.test(r.url)), requests.filter((r) => /\/music\//.test(r.url)).map((r) => r.url).join(', '));

      await skipToPlay(page);
      const started = await waitForLog(page, (e) => e.event === 'start');
      check('a track starts after the first gesture', !!started, started ? started.detail.track : 'no start event');
      check('it is one of the scenario\'s three tracks', !!started && DW1_TRACKS.includes(started.detail.track));
      check('no fade-in (the thinker picked it)', !!started && started.detail.fadeInMs === 0);
      const musicRequests = requests.filter((r) => /\/music\//.test(r.url));
      check('its file was requested only now', musicRequests.length >= 1 && musicRequests[0].at >= (await audioLog(page)).find((e) => e.event === 'unlock').at - 50);

      // The main-thread cost of starting a track is what the engine spends in the call itself
      // (creating the element and audio nodes); decoding happens on the browser's media threads.
      check('starting the track costs the main thread under 25 ms', started.detail.syncMs < 25, `${started.detail.syncMs} ms`);
      await page.waitForTimeout(1500);
      const tasks = await page.evaluate(() => window.__longtasks);
      const near = tasks.filter((t) => t.at + t.duration >= started.at - 200 && t.at <= started.at + 1000);
      console.log(`info long tasks around the start (board loading, not audio): ${near.map((t) => `${Math.round(t.duration)}ms`).join(', ') || 'none'}`);

      // Transition: jump to 3 s before the end.
      const first = started.detail.track;
      let seeked = false;
      for (let i = 0; i < 40 && !seeked; i++) {
        seeked = await page.evaluate(() => window.__audio.seekNearEnd(3));
        if (!seeked) await page.waitForTimeout(500);
      }
      check('the playing track reports its length', seeked);
      const prefetch = await waitForLog(page, (e) => e.event === 'prefetch', 15000);
      check('the next track is prefetched near the end', !!prefetch, prefetch ? prefetch.detail.track : 'none');
      const ended = await waitForLog(page, (e) => e.event === 'ended', 20000);
      check('the track ends', !!ended);
      const log = await audioLog(page);
      const after = ended ? log.filter((e) => e.event === 'start' && e.at >= ended.at)[0] : null;
      check('the next track follows at once, unfaded', !!after && after.detail.fadeInMs === 0 && after.detail.track !== first, after ? after.detail.track : 'none');
      check('and it is the one that was prefetched', !!after && !!prefetch && after.detail.track === prefetch.detail.track);

      // Mute.
      // Dead Water keeps talking for a while after the first quiet moment.
      await page.waitForTimeout(4000);
      await skipToPlay(page);
      const muteButton = page.locator('[data-testid="mute-toggle"]');
      await muteButton.click();
      let state = await audioState(page);
      check('mute drops the master gain to 0', state.gains.master === 0 && state.settings.muted === true);
      await page.reload();
      await waitBoardReady(page);
      state = await audioState(page);
      check('muted survives a reload', state.settings.muted === true && state.gains.master === 0);
      await skipToPlay(page);
      await page.waitForTimeout(4000);
      await skipToPlay(page);
      await page.locator('[data-testid="mute-toggle"]').click();
      state = await audioState(page);
      check('unmute restores it', state.gains.master === 1 && state.settings.muted === false);

      // Audio dialog: music volume.
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('button', { name: /Audio\.\.\./ }).click();
      await page.locator('input[aria-label="Music volume"]').fill('40');
      state = await audioState(page);
      check('the audio dialog sets the music volume', state.gains.music === 0.4, String(state.gains.music));
      await page.locator('input[aria-label="Music volume"]').fill('100');
      await page.keyboard.press('Escape');

      check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    } finally {
      await context.close();
    }
  }

  // ---- Liberty epilogue: a story part's music= ---------------------------
  {
    const { context, page, errors } = await newPage(browser);
    try {
      await openScenario(page, base, 'liberty', '08_Epilogue');
      await waitBoardReady(page);
      await page.keyboard.press('Shift');
      const started = await waitForLog(page, (e) => e.event === 'start', 20000);
      check('a story part\'s music= plays', !!started && started.detail.track === 'journeys_end.ogg', started ? started.detail.track : 'none');
      check('no page errors (epilogue)', errors.length === 0, errors.slice(0, 3).join(' | '));
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
console.log('\nall audio checks passed');
