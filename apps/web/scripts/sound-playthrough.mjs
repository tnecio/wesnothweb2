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
 *  4. Sound sources (synthetic_audio): one heard from everywhere, two placed
 *     ones that start when the view is near them, follow it as it moves and
 *     stop when it leaves; turn 2's [volume], [remove_sound_source] and [sound].
 *  5. Muting takes the sound buses to silence at once; the sound-effects
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
      await page.getByRole('button', { name: /Preferences\.\.\./ }).click();
      await page.getByRole('tab', { name: 'Sound' }).click();
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

  // ---- synthetic_audio: sound sources follow the view -----------------------
  {
    const { context, page, errors, sounds } = await newPage(browser);
    try {
      await openScenario(page, base, 'synthetic_audio');
      await waitBoardReady(page);
      await skipToPlay(page);
      await page.keyboard.press('Shift');
      await waitForPreload(page, sounds);
      await page.waitForTimeout(1500);

      const centerX = () => page.evaluate(() => window.__wesnothDebug.viewCenterHex()?.x ?? null);
      const drag = async (dx) => {
        await page.mouse.move(800, 300);
        await page.mouse.down();
        await page.mouse.move(800 + dx, 300, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(600);
      };
      const sourcePlays = async (id) => (await audioLog(page)).filter((e) => e.event === 'sound-play' && e.detail.source?.startsWith(`${id}#`));
      const stops = async (id) => (await audioLog(page)).filter((e) => e.event === 'sound-stop' && e.detail.source?.startsWith(`${id}#`));

      const start = await centerX();
      check('the view starts mid-map', start !== null && start > 12 && start < 26, `centre x ${start}`);
      check('the source with no location plays, at full volume', (await sourcePlays('drums')).some((e) => e.detail.volume === 100));
      check('the placed sources are silent while the view is far from them', (await sourcePlays('camp')).length === 0 && (await sourcePlays('birds')).length === 0);

      // Bring the near source into view: drag the map right until its hex is at the centre.
      for (let i = 0; i < 12 && (await centerX()) > 6; i++) await drag(500);
      const near = await centerX();
      await page.waitForTimeout(1200);
      check('the view reached the camp', near <= 6, `centre x ${near}`);
      const camp = await sourcePlays('camp');
      check('the camp starts once the view is near it', camp.length > 0);
      const campLoudest = Math.max(0, ...(await audioLog(page)).filter((e) => (e.event === 'sound-play' || e.event === 'sound-reposition') && e.detail.source?.startsWith('camp#')).map((e) => e.detail.volume));
      check('it starts quietly from a distance and follows the view up to close to full volume', camp.length > 0 && camp[0].detail.volume < 60 && campLoudest >= 80, `first ${camp[0]?.detail.volume}, loudest ${campLoudest}`);

      // Then far away again: it goes quiet, and the far source comes up.
      for (let i = 0; i < 24 && (await centerX()) < 34; i++) await drag(-500);
      const far = await centerX();
      await page.waitForTimeout(1500);
      check('the view reached the far end', far >= 34, `centre x ${far}`);
      check('the camp stops when the view leaves it', (await stops('camp')).length > 0);
      check('the far source starts when the view is on it', (await sourcePlays('birds')).length > 0);

      // Turn 2: two End Turns (both sides are human).
      const before = (await audioLog(page)).length;
      await page.keyboard.press('Control+Space');
      await page.waitForTimeout(1500);
      await page.keyboard.press('Control+Space');
      await page.waitForTimeout(3000);
      const after = (await audioLog(page)).slice(before);
      check("turn 2 removes the drums", after.some((e) => e.event === 'sound-stop' && e.detail.source?.startsWith('drums#')));
      check("turn 2's [sound] plays with its repeat", after.some((e) => e.event === 'sound-play' && e.detail.file === 'open-chest.wav' && e.detail.repeats === 1), after.filter((e) => e.event === 'sound-play').map((e) => e.detail.file).join(', '));
      const state = await page.evaluate(() => window.__audio.state());
      check("turn 2's [volume] scales the music and the effects", state.gains.music === 0.5 && Math.abs(state.gains.sound - 0.2) < 1e-9, `music ${state.gains.music}, sound ${state.gains.sound}`);
      check('and the music switches to the [music] immediate=yes track with its fade-in', after.some((e) => e.event === 'start' && e.detail.track === 'sad.ogg' && e.detail.fadeInMs === 1500));

      // The player's own slider ends the scale on that channel.
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('button', { name: /Preferences\.\.\./ }).click();
      await page.getByRole('tab', { name: 'Sound' }).click();
      await page.locator('input[aria-label="Music volume"]').fill('80');
      const reset = await page.evaluate(() => window.__audio.state());
      check("the player's own music volume replaces the scenario's scale", reset.gains.music === 0.8 && Math.abs(reset.gains.sound - 0.2) < 1e-9, `music ${reset.gains.music}, sound ${reset.gains.sound}`);
      check('no page errors (sources)', errors.length === 0, errors.slice(0, 3).join(' | '));
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
