/**
 * Phase 27c: the presentation gaps, checked in the real app.
 *
 * - unit effects (S2), on Dead Water 1: an `[object]` giving Kai `apply_to=image_mod`, `apply_to=halo` and an
 *   ability with `halo_image=` changes his sprite to the modified image and draws both halos, following him
 *   when he moves.
 *
 *   node apps/web/scripts/presentation-playthrough.mjs [--base http://localhost:5173] [--only unit-effects]
 *     [--shots <dir>]
 */
import { chromium } from 'playwright';
import { skipToPlay, untilPlayable, waitBoardReady } from './lib/browserFlows.mjs';

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
  await page.goto(`${base}/play/dead_water`);
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
} finally {
  await browser.close();
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED`);
process.exitCode = failures.length === 0 ? 0 : 1;
