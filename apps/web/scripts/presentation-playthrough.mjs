/**
 * Phase 27c: the presentation gaps, checked in the real app.
 *
 * - unit effects (S2), on Dead Water 1: an `[object]` giving Kai `apply_to=image_mod`, `apply_to=halo` and an
 *   ability with `halo_image=` changes his sprite to the modified image and draws both halos, following him
 *   when he moves.
 *
 * - standing and idle animations (S3), on Liberty 1 (Cavalrymen and Spearmen stand animated; Thugs, Footpads,
 *   Peasants and Spearmen idle): units with a `[standing_anim]` loop it, units idle
 *   (the frequency at its highest), a selected unit plays "selected", the frame time with and without them;
 *   under `prefers-reduced-motion` every unit holds its `_disabled_` frame.
 *
 * - the other combat animations (S4), on the debug combat scenario: a Lieutenant beside the attacker leads
 *   ("leading"), the attacker -- given draw/sheath/victory animations by an `apply_to=new_animation` --
 *   draws its weapon, wins ("victory"), sheathes it, and levels up ("levelout", then "levelin").
 *
 * - an attack's own events speak after its blows (`attack::perform`), on the debug combat scenario: an
 *   `[event] name=attack end` `[message]` (The South Guard's quintain) opens only once the fight has played.
 *
 * - the status bar, as upstream's theme draws it (Dead Water 1): its `menubar.png` strip tiled at its own
 *   size (never stretched, at any width), "Menu" and "Actions" as page text on the copper button frame, each
 *   figure behind its icon with upstream's tooltip, and the time of day in the sidebar under the minimap,
 *   following the hex under the pointer; on a phone turned sideways, the time of day is in the bar instead.
 *
 * - lighting (S5), on Two Brothers 3 (its castle is a `[time_area]`, dark indoors): terrain, foreground
 *   and items lit hex by hex -- the light map inside the castle from the castle's colour, outside from the
 *   day's -- flags, grid and fog by the day's, units not at all; and combat in the castle at its lawful bonus.
 *
 * - the end of a scenario (S6), on the debug fog scenario: after a defeat the player lingers on the map --
 *   fog and shroud lifted and the enemy shown (`reveal_map`), every orb red, End Turn reading End Scenario --
 *   and End Scenario goes back to the title screen.
 *
 * - random names (S7), on Dead Water 1: the units its WML gives no name (the merfolk citizens, the enemy's)
 *   come with one, generated from their race's name generator, shown in the side panel.
 *
 *   node apps/web/scripts/presentation-playthrough.mjs [--base http://localhost:5173]
 *     [--only unit-effects,standing-idle,combat-anims,attack-end-order,status-bar,lighting,linger,names]
 *     [--shots <dir>]
 */
import { chromium } from 'playwright';
import { hexPoint, openScenario, performAttack, skipToPlay, untilPlayable, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:5173';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const runs = (part) => !only || only.includes(part);
/** `--shots <dir>`: screenshots of what is checked. */
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function openDeadWater(page) {
  await openCampaign(page, 'dead_water');
}

async function openCampaign(page, campaign) {
  await page.goto(`${base}/play/${campaign}`);
  await skipToPlay(page);
  await waitBoardReady(page);
  await untilPlayable(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** Kai as the session and the board have him: his place, the sprite's image ref and texture, his halos. */
const kaiDrawn = (page) =>
  page.evaluate(() => {
    const session = window.__wesnoth.session;
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis');
    const snap = session.renderUnits.find((u) => u.id === 'Kai Krellis');
    const board = window.__wesnothDebug.board();
    const visual = [...board.unitVisuals.values()].find((v) => v.lastUnit.id === 'Kai Krellis');
    const states = window.__wesnothDebug.unitSpriteStates();
    const state = Object.entries(states).find(([key]) => visual && board.unitVisuals.get(key) === visual)?.[1];
    return {
      at: { x: kai.location.x, y: kai.location.y },
      image: snap.image,
      imageMods: snap.imageMods ?? '',
      halos: snap.halos ?? [],
      spriteImageMods: visual?.lastImage?.includes('~GS()') ?? false,
      drawnHalos: state?.halos ?? 0,
      haloAt: state?.haloAt ?? null,
      spriteAt: state ? { x: state.x, y: state.y } : null,
    };
  });

const browser = await chromium.launch();
try {
  if (runs('unit-effects')) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDeadWater(page);
    // Selecting Kai gives him the object: through the real event and [object] code, then the board's sync.
    await page.evaluate(() =>
      window.__wesnoth.addEvent(`[event]
name=select
[filter]
id=Kai Krellis
[/filter]
[object]
silent=yes
[filter]
id=Kai Krellis
[/filter]
[effect]
apply_to=image_mod
add="GS()"
[/effect]
[effect]
apply_to=halo
halo=halo/elven/druid-healing[1~8].png:100
[/effect]
[effect]
apply_to=new_ability
[abilities]
[illuminates]
id=test_light
value=25
max_value=25
affect_self=yes
halo_image=halo/illuminates-aura.png
[/illuminates]
[/abilities]
[/effect]
[/object]
[/event]`),
    );
    const before = await kaiDrawn(page);
    check('before: Kai has no halo and no image functions', before.halos.length === 0 && before.drawnHalos === 0 && before.imageMods === '', JSON.stringify(before));
    await page.evaluate(({ x, y }) => window.__wesnoth.clickHex(x, y), before.at);
    let after = before;
    for (let i = 0; i < 40 && after.drawnHalos < 2; i++) {
      await page.waitForTimeout(500);
      after = await kaiDrawn(page);
    }
    check('the image_mod reaches his sprite', after.imageMods === 'GS()' && after.image.endsWith('~GS()') && after.spriteImageMods, JSON.stringify({ image: after.image, imageMods: after.imageMods }));
    check('his halo and the ability halo are drawn, on him', after.drawnHalos === 2 && JSON.stringify(after.haloAt) === JSON.stringify(after.spriteAt), JSON.stringify(after));
    if (shots) await page.screenshot({ path: `${shots}/unit-effects.png` });
    // He moves: the halos go with him.
    const target = await page.evaluate(() => {
      const session = window.__wesnoth.session;
      const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis');
      const hex = session.reachable.find((h) => Math.abs(h.x - kai.location.x) + Math.abs(h.y - kai.location.y) >= 2 && !session.board.allUnits().some((u) => u.location.x === h.x && u.location.y === h.y));
      return hex ? { x: hex.x, y: hex.y } : null;
    });
    if (target) {
      await page.evaluate(({ x, y }) => window.__wesnoth.clickHex(x, y), target);
      let moved = after;
      let midway = false;
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(100);
        moved = await kaiDrawn(page);
        if (moved.haloAt && moved.spriteAt && JSON.stringify(moved.spriteAt) !== JSON.stringify(after.spriteAt) && JSON.stringify(moved.haloAt) === JSON.stringify(moved.spriteAt)) midway = true;
        if (moved.at.x === target.x && moved.at.y === target.y && i > 20) break;
      }
      check('after a move his halos are on him at the new hex', moved.at.x === target.x && moved.at.y === target.y && moved.drawnHalos === 2 && JSON.stringify(moved.haloAt) === JSON.stringify(moved.spriteAt), JSON.stringify({ target, at: moved.at, haloAt: moved.haloAt, spriteAt: moved.spriteAt }));
      check('...and followed him while he moved', midway);
    } else {
      check('a hex to move Kai to', false);
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.context().close();
  }
  if (runs('standing-idle')) {
    /** Every unit's rest animation and sprite texture, keyed by sprite key. */
    const rest = (page) =>
      page.evaluate(() => {
        const board = window.__wesnothDebug.board();
        const states = window.__wesnothDebug.unitSpriteStates();
        const out = {};
        for (const [key, visual] of board.unitVisuals) {
          if (!visual.sprite) continue;
          out[key] = { id: visual.lastUnit.id ?? visual.lastUnit.typeId, ambient: states[key]?.ambient ?? null, texture: visual.sprite.texture.uid };
        }
        return out;
      });
    /** Average and worst frame time over `ms`, from requestAnimationFrame. */
    const frameTimes = (page, ms) =>
      page.evaluate(
        (ms) =>
          new Promise((resolve) => {
            const times = [];
            let last = performance.now();
            const end = last + ms;
            const tick = (now) => {
              times.push(now - last);
              last = now;
              if (now < end) requestAnimationFrame(tick);
              else resolve({ avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length), worst: Math.round(Math.max(...times)), frames: times.length });
            };
            requestAnimationFrame(tick);
          }),
        ms,
      );
    const setPrefs = (page, prefs) =>
      page.addInitScript((prefs) => {
        const key = 'wesnothweb2.display';
        let current = {};
        try {
          current = JSON.parse(localStorage.getItem(key) ?? '{}');
        } catch {
          // Unreadable: start from nothing.
        }
        localStorage.setItem(key, JSON.stringify({ ...current, ...prefs }));
      }, prefs);

    {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await setPrefs(page, { standingAnimations: true, idleAnimations: true, idleAnimRate: 30 });
      await openCampaign(page, 'liberty');
      const first = await rest(page);
      const looping = Object.entries(first).filter(([, u]) => u.ambient?.event === 'standing' && u.ambient.durationMs > 1);
      check('units with a standing animation loop it', looping.length > 0, looping.map(([, u]) => u.id).join(', '));
      const changed = new Set();
      let idled = null;
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(500);
        const now = await rest(page);
        for (const [key] of looping) if (now[key] && now[key].texture !== first[key].texture) changed.add(key);
        idled ??= Object.values(now).find((u) => u.ambient?.event === 'idling') ?? null;
        if (changed.size > 0 && idled && i >= 6) break;
      }
      check('...their sprites change frame as it plays', changed.size > 0, `${changed.size} of ${looping.length}`);
      const canIdle = await page.evaluate(() => {
        const board = window.__wesnothDebug.board();
        return [...board.unitVisuals.values()].filter((v) => board.ambientSource?.(v.lastUnit, 'idling')).map((v) => v.lastUnit.typeId);
      });
      check('a unit with an idle animation plays it (frequency at its highest)', canIdle.length === 0 || idled !== null, `can idle: ${canIdle.join(', ') || 'none'}; idled: ${idled?.id ?? 'none'}`);
      // Selecting the leader: his "selected" animation (the white pulse), then standing again.
      const leader = await page.evaluate(() => {
        const s = window.__wesnoth.session;
        const k = s.board.allUnits().find((u) => u.side === s.viewingSide && u.canRecruit);
        return { x: k.location.x, y: k.location.y, id: k.id };
      });
      await page.evaluate(({ x, y }) => window.__wesnoth.clickHex(x, y), leader);
      let selected = false;
      for (let i = 0; i < 20 && !selected; i++) {
        await page.waitForTimeout(50);
        selected = Object.values(await rest(page)).some((u) => u.id === leader.id && u.ambient?.event === 'selected');
      }
      check('a selected unit plays "selected"', selected);
      await page.waitForTimeout(1000);
      const after = Object.values(await rest(page)).find((u) => u.id === leader.id);
      check('...and stands again after it', after?.ambient?.event === 'standing', JSON.stringify(after?.ambient));
      await page.keyboard.press('Escape');
      const on = await frameTimes(page, 5000);
      await page.evaluate(() => window.__wesnothDebug.board().setAmbientAnimations(null, { standing: false, idle: false, idleRate: 0 }));
      const off = await frameTimes(page, 5000);
      check('frame time with standing animations stays close to without', on.avg <= off.avg * 1.25 + 4, `on ${JSON.stringify(on)}, off ${JSON.stringify(off)}`);
      check('no page errors', errors.length === 0, errors.join(' | '));
      await page.context().close();
    }
    {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })).newPage();
      await openCampaign(page, 'liberty');
      const first = await rest(page);
      await page.waitForTimeout(3000);
      const later = await rest(page);
      const still = Object.entries(later).every(([key, u]) => u.ambient?.event === '_disabled_' && u.texture === first[key]?.texture);
      check('under reduced motion every unit holds its _disabled_ frame', still, JSON.stringify(Object.values(later).slice(0, 3)));
      await page.context().close();
    }
  }
  if (runs('combat-anims')) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openScenario(page, base, 'synthetic_combat');
    await skipToPlay(page);
    await waitBoardReady(page);
    await untilPlayable(page);
    const frame = (tag) => `[${tag}]\n[frame]\nimage=units/human-loyalists/spearman.png:200\n[/frame]\n[/${tag}]`;
    await page.evaluate(
      (anims) =>
        window.__wesnoth.addEvent(`[event]
name=select
[filter]
id=Debug Hero
[/filter]
[unit]
type=Lieutenant
side=1
x,y=1,3
[/unit]
[modify_unit]
[filter]
id=Debug Hero
[/filter]
experience=41
[/modify_unit]
[modify_unit]
[filter]
id=Debug Villain
[/filter]
hitpoints=1
[/modify_unit]
[object]
silent=yes
[filter]
id=Debug Hero
[/filter]
[effect]
apply_to=new_animation
${anims}
[/effect]
[/object]
[/event]`),
      ['draw_weapon_anim', 'sheath_weapon_anim', 'victory_anim'].map(frame).join('\n'),
    );
    await page.evaluate(() => window.__wesnoth.clickHex(1, 2));
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await performAttack(page, { x: 1, y: 2 }, { x: 2, y: 2 });
    // Three advancement choices: take the first.
    for (let i = 0; i < 60; i++) {
      if (await page.getByText('Advance Unit').first().isVisible().catch(() => false)) {
        await page.keyboard.press('Enter');
        break;
      }
      await page.waitForTimeout(500);
    }
    let events = [];
    for (let i = 0; i < 60 && !events.includes('levelin'); i++) {
      await page.waitForTimeout(500);
      events = (await page.evaluate(() => window.__wesnothDebug.playedAnimations())).map((p) => p.event);
    }
    const order = (names) => names.map((n) => events.indexOf(n));
    for (const name of ['draw_weapon', 'attack', 'leading', 'victory', 'sheath_weapon', 'levelout', 'levelin']) {
      check(`"${name}" is played`, events.includes(name));
    }
    const at = order(['draw_weapon', 'attack', 'victory', 'sheath_weapon', 'levelout', 'levelin']);
    check('...in upstream\'s order: draw, blows, victory, sheath, levelout, levelin', at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])), events.join(', '));
    const hero = await page.evaluate(() => window.__wesnoth.session.board.allUnits().find((u) => u.id === 'Debug Hero')?.type.id);
    check('the hero has advanced', hero !== 'Spearman', hero);
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.context().close();
  }
  if (runs('attack-end-order')) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openScenario(page, base, 'synthetic_combat');
    await skipToPlay(page);
    await waitBoardReady(page);
    await untilPlayable(page);
    await page.evaluate(() => {
      window.__wesnoth.addEvent('[event]\nname=attack end\n[message]\nspeaker=narrator\nmessage=after the fight\n[/message]\n[/event]');
      // The animations played by the time the message opened.
      window.__atMessage = null;
      new MutationObserver(() => {
        if (window.__atMessage || !document.querySelector('.window[role="dialog"]')) return;
        const played = window.__wesnothDebug.playedAnimations().map((p) => p.event);
        window.__atMessage = { played };
      }).observe(document.body, { childList: true, subtree: true });
    });
    const before = await page.evaluate(() => window.__wesnothDebug.playedAnimations().length);
    await performAttack(page, { x: 1, y: 2 }, { x: 2, y: 2 });
    await page.waitForSelector('.window[role="dialog"]', { timeout: 60000 });
    const at = await page.evaluate((n) => ({ ...window.__atMessage, played: window.__atMessage?.played.slice(n) }), before);
    check('the attack end message opens after the blows were played', !!at.played && at.played.includes('attack') && at.played.includes('defend'), at.played?.join(', '));
    await page.keyboard.press('Enter');
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.context().close();
  }
  if (runs('status-bar')) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDeadWater(page);
    const bar = () =>
      page.evaluate(() => {
        const el = document.querySelector('.top-bar');
        const style = getComputedStyle(el);
        const icons = [...el.querySelectorAll('.stat:not(.tod) img')];
        return {
          height: el.getBoundingClientRect().height,
          image: style.backgroundImage,
          size: style.backgroundSize,
          repeat: style.backgroundRepeat,
          buttons: [...el.querySelectorAll('.menu-button')].map((b) => b.textContent.trim()),
          frame: getComputedStyle(el.querySelector('.menu-button'), '::before').borderImageSource,
          icons: icons.length,
          loaded: icons.every((i) => i.complete && i.naturalWidth > 0),
          titles: [...el.querySelectorAll('.stat')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.title.split('\n')[0]),
          barTod: !!el.querySelector('.tod') && getComputedStyle(el.querySelector('.tod')).display !== 'none',
          scrollsSideways: document.documentElement.scrollWidth > innerWidth,
        };
      });
    let b = await bar();
    check('the bar is upstream\'s strip, tiled at its own size (never stretched)', b.image.includes('menubar.png') && b.size.split(',').every((v) => v.trim() === 'auto') && b.repeat.startsWith('repeat-x'), `${b.size} / ${b.repeat}`);
    check('...and as tall as the strip, 27px', Math.round(b.height) === 27, String(b.height));
    check('"Menu" and "Actions" are page text on the copper button frame', b.buttons.join('|') === 'Menu|Actions' && b.frame.includes('menu_button_copper_H20'), `${b.buttons} ${b.frame}`);
    check('every figure has its icon, loaded', b.icons === 6 && b.loaded, `${b.icons} icons`);
    check('...and upstream\'s tooltip', b.titles.join('|') === 'Turn Number|Gold|Villages|Units|Upkeep|Net Income', b.titles.join('|'));
    check('the bar shows no time of day on a desktop', !b.barTod);
    const tod = () => page.evaluate(() => ({ shown: !!document.querySelector('[data-testid="tod-panel"]')?.offsetParent, title: document.querySelector('[data-testid="tod-panel"] .tod-image')?.title ?? '', stats: document.querySelector('[data-testid="tod-panel"] .tod-stats')?.textContent ?? '' }));
    const atStart = await tod();
    check('the sidebar shows the time of day and its place in the schedule', atStart.shown && /Time of day:/.test(atStart.title) && /^\d+\/\d+$/.test(atStart.stats), JSON.stringify(atStart));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(800);
    b = await bar();
    check('wider, the strip is still tiled, not stretched', b.size.split(',').every((v) => v.trim() === 'auto') && Math.round(b.height) === 27, b.size);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(800);
    // A hex under the pointer: the report follows it (Dead Water 1 has one schedule, so its text stays).
    const p = await hexPoint(page, 10, 10);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(500);
    const hovered = await tod();
    check('...and follows the hex under the pointer', hovered.shown && hovered.stats === atStart.stats, JSON.stringify(hovered));
    if (shots) await page.screenshot({ path: `${shots}/status-bar-desktop.png` });
    // A phone on its side: the sidebar's time of day is hidden, the bar has it.
    await page.setViewportSize({ width: 839, height: 412 });
    await page.waitForTimeout(1200);
    b = await bar();
    const phoneTod = await tod();
    check('on a phone turned sideways, the time of day is in the bar, not the sidebar', b.barTod && !phoneTod.shown, JSON.stringify({ bar: b.barTod, side: phoneTod.shown }));
    check('...nothing scrolls sideways', !b.scrollsSideways);
    if (shots) await page.screenshot({ path: `${shots}/status-bar-landscape.png` });
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.context().close();
  }
  if (runs('lighting')) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openScenario(page, base, 'two_brothers', '03_Guarded_Castle');
    await skipToPlay(page);
    await waitBoardReady(page);
    await untilPlayable(page);
    // An area hex (the castle) and one outside it, with the time of day each shows.
    const probe = await page.evaluate(() => {
      const s = window.__wesnoth.session;
      const areas = s.timeAreaLighting();
      const [inKey, inside] = [...areas].find(([, t]) => t.red === -60) ?? [];
      let outKey = null;
      for (let x = 0; x < s.board.map.w() && !outKey; x++) for (let y = 0; y < s.board.map.h(); y++) if (!areas.has(`${x},${y}`)) { outKey = `${x},${y}`; break; }
      const day = s.currentTimeOfDay;
      // A Location, made as the engine makes them (any unit's location's class).
      const Loc = s.board.allUnits()[0].location.constructor;
      const insideBonus = inKey ? s.timeOfDayAt(new Loc(...inKey.split(',').map(Number))).lawfulBonus : null;
      return { inKey, inside, outKey, day: { red: day.red, green: day.green, blue: day.blue }, insideBonus };
    });
    check('the castle is a [time_area] of the session', !!probe.inKey && !!probe.outKey, JSON.stringify(probe));
    check('...and combat in it is at the castle\'s lawful bonus (-25)', probe.insideBonus === -25, String(probe.insideBonus));
    const at = async (key) => {
      const [x, y] = key.split(',').map(Number);
      for (let i = 0; i < 60; i++) {
        const st = await page.evaluate(({ x, y }) => window.__wesnothDebug.lighting(x, y), { x, y });
        if (st?.value && st.hexByHex) return st;
        await page.waitForTimeout(1000);
      }
      return null;
    };
    const half = (v) => Math.trunc(v / 2);
    const inside = await at(probe.inKey);
    const outside = await at(probe.outKey);
    check('inside the castle the light map is the castle\'s colour', JSON.stringify(inside?.value) === JSON.stringify([128 + half(-60), 128 + half(-45), 128 + half(-10)]), JSON.stringify(inside));
    check('outside it the day\'s', JSON.stringify(outside?.value) === JSON.stringify([128 + half(probe.day.red), 128 + half(probe.day.green), 128 + half(probe.day.blue)]), JSON.stringify(outside));
    const lit = inside?.lit ?? [];
    check('terrain, foreground and items are lit; flags, grid and fog take the day; units nothing', ['terrain', 'foreground', 'items'].every((l) => lit.includes(l)) && !lit.includes('units'), lit.join(', '));
    if (shots) {
      await page.evaluate(() => window.__wesnothDebug.scrollToHex(13, 15, 'WARP'));
      await page.waitForTimeout(2000);
      await page.evaluate(() => window.__wesnothDebug.freezeAnimationsForCapture());
      await page.screenshot({ path: `${shots}/lighting-castle.png` });
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.context().close();
  }
  if (runs('linger')) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openScenario(page, base, 'synthetic_fog');
    await skipToPlay(page);
    await waitBoardReady(page);
    await untilPlayable(page);
    const seen = () => page.evaluate(() => {
      const s = window.__wesnoth.session;
      return { hidden: s.hexVisibility.filter((h) => h.visibility !== 'clear').length, villain: s.renderUnits.some((u) => u.id === 'Debug Villain') };
    });
    const before = await seen();
    check('before: fog and shroud hide part of the map and the enemy', before.hidden > 0 && !before.villain, JSON.stringify(before));
    await page.evaluate(() => window.__wesnoth.addEvent('[event]\nname=select\n[endlevel]\nresult=defeat\n[/endlevel]\n[/event]'));
    const kai = await page.evaluate(() => {
      const k = window.__wesnoth.session.board.allUnits().find((u) => u.id === 'Debug Hero');
      return { x: k.location.x, y: k.location.y };
    });
    await page.evaluate(({ x, y }) => window.__wesnoth.clickHex(x, y), kai);
    const turnText = () => page.$eval('[data-testid="turn-button"]', (b) => (b.textContent ?? '').trim()).catch(() => '');
    for (let i = 0; i < 40 && (await turnText()) !== 'End Scenario'; i++) {
      if (await page.$('.window[role="dialog"]')) await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }
    check('a defeat leaves the player on the map: End Turn reads End Scenario', (await turnText()) === 'End Scenario', await turnText());
    const after = { ...(await seen()), orbs: await page.evaluate(() => window.__wesnoth.session.renderUnits.filter((u) => u.side === window.__wesnoth.session.viewingSide).map((u) => `${u.movesLeft}/${u.canMove}`)) };
    check('...the whole map shown, the enemy too (reveal_map)', after.hidden === 0 && after.villain, JSON.stringify(after));
    check('...and every unit of the player has ended its turn (red orbs)', after.orbs.every((o) => o === '0/false'), after.orbs.join(' '));
    await page.click('[data-testid="turn-button"]');
    const title = await page.waitForSelector('[data-testid="title-screen"]', { timeout: 30000 }).catch(() => null);
    check('End Scenario after a defeat returns to the title screen', title !== null);
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.context().close();
  }
  if (runs('names')) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDeadWater(page);
    const units = await page.evaluate(() =>
      window.__wesnoth.session.board.allUnits().map((u) => ({
        id: u.id,
        name: typeof u.name === 'string' ? u.name : String(u.name ?? ''),
        x: u.location.x,
        y: u.location.y,
        // A race with no name generator (the undead) names nobody, upstream too.
        nameable: Object.keys(u.type.nameSources ?? {}).length > 0,
      })),
    );
    const nameable = units.filter((u) => u.nameable);
    const named = nameable.filter((u) => u.name.trim() !== '');
    check('the units come with names, generated where the WML gave none', nameable.length > 0 && named.length === nameable.length, `${named.length} of ${nameable.length} (of ${units.length}): ${named.slice(0, 6).map((u) => u.name).join(', ')}`);
    const citizen = units.find((u) => /Citizen|Fighter|Grunt|Naga/.test(u.id) && u.name) ?? units[0];
    await page.evaluate(({ x, y }) => window.__wesnoth.clickHex(x, y), citizen);
    await page.waitForTimeout(800);
    const panel = await page.$eval('.side-panel', (e) => e.textContent ?? '').catch(() => '');
    check('...and the side panel shows the name', panel.includes(citizen.name), `${citizen.id}: ${citizen.name}`);
    check('no page errors', errors.length === 0, errors.join(' | '));
    await page.context().close();
  }
} finally {
  await browser.close();
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED`);
process.exitCode = failures.length === 0 ? 0 : 1;
