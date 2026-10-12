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
 *   node apps/web/scripts/presentation-playthrough.mjs [--base http://localhost:5173]
 *     [--only unit-effects,standing-idle,combat-anims]
 *     [--shots <dir>]
 */
import { chromium } from 'playwright';
import { openScenario, performAttack, skipToPlay, untilPlayable, waitBoardReady } from './lib/browserFlows.mjs';

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
} finally {
  await browser.close();
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED`);
process.exitCode = failures.length === 0 ? 0 : 1;
