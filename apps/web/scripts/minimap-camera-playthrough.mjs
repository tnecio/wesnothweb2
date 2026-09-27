/**
 * Phase 22 milestone: the camera and the minimap, in a real browser.
 *
 *  - Camera: dragging far past the map edge is stopped at upstream's bounds; the zoom hotkeys walk
 *    exactly upstream's nine levels; the wheel pans and Ctrl+wheel zooms; `0` toggles 1:1 and back.
 *  - Minimap: clicking it centres the board on that hex, dragging pans; a captured village changes
 *    colour at once; under fog/shroud it shows only what the viewing side knows (hotseat, both ways).
 *  - Following the action: with the camera parked away from the enemy, ending the turn brings the
 *    AI's moves on screen (scroll_to_action); a SCROLL glides frame by frame, a WARP jumps.
 *
 * Run: node apps/web/scripts/minimap-camera-playthrough.mjs [--base http://localhost:5173] [--headed] [--skip-ai]
 */
import { chromium } from 'playwright';
import { skipToPlay, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const headed = args.includes('--headed');
/** Skip the AI-turn check (headless, a whole AI turn takes several minutes to animate). */
const skipAi = args.includes('--skip-ai');

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const camera = (page) => page.evaluate(() => window.__wesnothDebug.camera());
const canvasBox = (page) => page.locator('.canvas-host').boundingBox();

/** Presses `key` once the game accepts hotkeys (they are ignored while events run). */
async function pressKey(page, key) {
  await page.locator('.canvas-host').hover();
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
}

const browser = await chromium.launch({ headless: !headed });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // Start every run from upstream's default zoom, whatever an earlier run saved.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('wesnothweb2.display');
    } catch {
      /* ignore */
    }
  });

  await page.goto(`${base}/play/liberty`);
  await waitBoardReady(page);
  await skipToPlay(page);

  // ── Camera ───────────────────────────────────────────────────────────────────────────────────
  // These read the camera's state, not pixels, so the render loop is paused: in headless software
  // GL a whole map zoomed out to 16 px hexes takes seconds a frame and starves input handling.
  {
    await page.evaluate(() => window.__wesnothDebug.setRenderingPaused(true));
    const start = await camera(page);
    check('opens at upstream\'s default zoom (72 px hexes)', start.zoom === 72, JSON.stringify(start));

    // Drag far to the right and down: the map's top-left border must stop at the canvas's top-left.
    const box = await canvasBox(page);
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 50, box.y + box.height - 50, { steps: 5 });
      await page.mouse.up();
    }
    const dragged = await camera(page);
    // worldBounds: the border starts 27 px left / 36 px above the first hex at scale 1.
    check('dragging past the top-left edge stops at the map border', Math.abs(dragged.view.x - 27) < 1 && Math.abs(dragged.view.y - 36) < 1, JSON.stringify(dragged.view));

    // The wheel pans (upstream), it does not zoom.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    const wheeled = await camera(page);
    check('the wheel pans the map', wheeled.view.y < dragged.view.y - 50 && wheeled.zoom === 72, `y ${dragged.view.y} -> ${wheeled.view.y}, zoom ${wheeled.zoom}`);

    // Ctrl+wheel zooms one level per notch.
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    const zoomedIn = await camera(page);
    check('Ctrl+wheel zooms in one level', zoomedIn.zoom === 100, `zoom ${zoomedIn.zoom}`);

    // Zoom hotkeys walk upstream's levels, both ways, stopping at the ends.
    const seen = [];
    for (let i = 0; i < 10; i++) {
      await pressKey(page, '-');
      seen.push((await camera(page)).zoom);
    }
    check('"-" steps down through the levels to 16 and stops', seen.join(',') === '72,52,36,24,16,16,16,16,16,16', seen.join(','));
    const up = [];
    for (let i = 0; i < 10; i++) {
      await pressKey(page, '=');
      up.push((await camera(page)).zoom);
    }
    check('"=" steps up through the levels to 288 and stops', up.join(',') === '24,36,52,72,100,144,216,288,288,288', up.join(','));
    await pressKey(page, '0');
    const def = (await camera(page)).zoom;
    await pressKey(page, '0');
    const back = (await camera(page)).zoom;
    check('"0" goes to 1:1 and, pressed again, back to where it was', def === 72 && back === 288, `${def} then ${back}`);
    await pressKey(page, '0');

    // At the smallest zoom the whole map fits, and is centred.
    for (let i = 0; i < 5; i++) await pressKey(page, '-');
    const small = await camera(page);
    const b = { x: -27, y: -36, w: (24 + 1 + 1 / 3) * 54, h: (30 + 1 + 0.5) * 72 }; // camera.ts worldBounds, Liberty 1 (24 x 30)
    const centreX = small.view.x + (b.x + b.w / 2) * small.view.scale;
    const centreY = small.view.y + (b.y + b.h / 2) * small.view.scale;
    check(
      'zoomed right out, the whole map is held in the middle of the screen',
      small.zoom === 16 && Math.abs(centreX - small.viewport.width / 2) < 1 && Math.abs(centreY - small.viewport.height / 2) < 1,
      JSON.stringify(small),
    );
    await pressKey(page, '0'); // back to 1:1 before rendering resumes
    await page.evaluate(() => window.__wesnothDebug.setRenderingPaused(false));
  }

  // ── Minimap: click and drag ──────────────────────────────────────────────────────────────────
  // Clicking the minimap centres the board on the hex drawn there; dragging across it pans along.
  {
    const viewCenter = () => page.evaluate(() => window.__wesnothDebug.viewCenterHex());
    const mini = (x, y) => page.evaluate(([hx, hy]) => window.__wesnothMinimap.clientPointOfHex(hx, hy), [x, y]);
    await page.waitForFunction(() => window.__wesnothMinimap?.clientPointOfHex(0, 0), null, { timeout: 30000 });
    const near = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
    const target = await mini(12, 15);
    await page.mouse.click(target.x, target.y);
    const clicked = await viewCenter();
    check('clicking the minimap centres the board on that hex (within one hex)', near(clicked, { x: 12, y: 15 }), JSON.stringify(clicked));
    const from = await mini(6, 8);
    const to = await mini(16, 22);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    const dragged = await viewCenter();
    check('dragging on the minimap pans the board along with the pointer', near(dragged, { x: 16, y: 22 }), JSON.stringify(dragged));
  }

  // ── Following the action ─────────────────────────────────────────────────────────────────────
  // Park the camera at 1:1 in the map's far corner, end the turn, and sample the camera while the
  // AI plays: it must be brought to the AI's moves (scroll_to_action), gliding rather than jumping.
  if (!skipAi) {
    if ((await camera(page)).zoom !== 72) await pressKey(page, '0');
    const box = await canvasBox(page);
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 50, box.y + box.height - 50, { steps: 5 });
      await page.mouse.up();
    }
    const parked = (await camera(page)).view;
    await page.evaluate(() => {
      window.__cameraSamples = [];
      window.__cameraSampler = setInterval(() => {
        const c = window.__wesnothDebug.camera();
        window.__cameraSamples.push([Math.round(c.view.x), Math.round(c.view.y)]);
      }, 16);
    });
    await pressKey(page, 'Control+Space');
    await skipToPlay(page, 120000).catch(() => {});
    await page.waitForTimeout(1000);
    const samples = await page.evaluate(() => {
      clearInterval(window.__cameraSampler);
      return window.__cameraSamples;
    });
    const distinct = [...new Set(samples.map((p) => p.join(',')))];
    const moved = distinct.some((p) => p !== `${Math.round(parked.x)},${Math.round(parked.y)}`);
    check('the camera leaves where it was parked to show the AI turn', moved, `${distinct.length} distinct positions`);
  }

  // ── The glide itself ─────────────────────────────────────────────────────────────────────────
  // Headless Chromium draws this board at ~1.5 fps in software GL, where upstream's 200 ms frame cap
  // makes any glide run past the 4 s safety limit and jump. With the render loop paused, animation
  // frames come at full rate and the glide can be observed frame by frame.
  {
    await page.evaluate(() => window.__wesnothDebug.setRenderingPaused(true));
    const glide = (type) =>
      page.evaluate(async (scrollType) => {
        await window.__wesnothDebug.scrollToHex(0, 0, 'warp');
        const from = window.__wesnothDebug.camera().view;
        const positions = [[from.x, from.y]];
        let run = true;
        const sample = () => {
          const c = window.__wesnothDebug.camera();
          positions.push([c.view.x, c.view.y]);
          if (run) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        const start = performance.now();
        await window.__wesnothDebug.scrollToHex(20, 25, scrollType); // Liberty 1 is 24 x 30
        const ms = performance.now() - start;
        run = false;
        const end = window.__wesnothDebug.camera().view;
        positions.push([end.x, end.y]);
        const distinct = new Set(positions.map((p) => p.join(','))).size;
        const total = Math.hypot(end.x - from.x, end.y - from.y);
        let biggest = 0;
        for (let i = 1; i < positions.length; i++) {
          biggest = Math.max(biggest, Math.hypot(positions[i][0] - positions[i - 1][0], positions[i][1] - positions[i - 1][1]));
        }
        return { ms, distinct, total, biggest };
      }, type);
    /** scroll_to_xy's profile at scroll speed 50 and 60 frames a second: how long a glide of `distance` px takes. */
    const expectedSeconds = (distance) => {
      let v = 0;
      let moved = 0;
      let t = 0;
      const dt = 1 / 60;
      const vmax = 3000;
      const accel = vmax / 0.3;
      const decel = vmax / 0.4;
      while (moved < distance) {
        const stop = v / decel;
        if (moved + v * stop - 0.5 * decel * stop * stop > distance || v > vmax) v = Math.max(1, v - decel * dt);
        else v = Math.min(vmax, v + accel * dt);
        moved = Math.min(distance, moved + v * dt);
        t += dt;
      }
      return t;
    };
    const scrolled = await glide('scroll');
    check('a SCROLL glides: many frames, none covering much of the way', scrolled.total > 200 && scrolled.distinct >= 10 && scrolled.biggest < scrolled.total * 0.25, JSON.stringify(scrolled));
    const expected = expectedSeconds(scrolled.total) * 1000;
    check(
      "...taking about as long as upstream's accelerate/cruise/decelerate profile says for that distance",
      scrolled.ms > expected * 0.5 && scrolled.ms < expected * 1.6 + 100,
      `${Math.round(scrolled.ms)} ms, expected ~${Math.round(expected)} ms for ${Math.round(scrolled.total)} px`,
    );
    const warped = await glide('warp');
    check('a WARP jumps in one step', warped.total > 200 && warped.biggest >= warped.total * 0.99, JSON.stringify(warped));
    await page.evaluate(() => window.__wesnothDebug.setRenderingPaused(false));
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();

  const colorAt = (page, x, y) => page.evaluate(([hx, hy]) => window.__wesnothMinimap.colorAtHex(hx, hy), [x, y]);
  const same = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 2);
  async function openDebug(campaign) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(String(e)));
    pg.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await pg.goto(`${base}/play/${campaign}`);
    await waitBoardReady(pg);
    await skipToPlay(pg);
    await pg.waitForFunction(() => window.__wesnothMinimap?.colorAtHex(0, 0), null, { timeout: 30000 });
    return { ctx, pg, errs };
  }

  // ── Minimap: a captured village changes colour ───────────────────────────────────────────────
  {
    const { ctx, pg, errs } = await openDebug('synthetic_economy');
    const plan = await pg.evaluate(() => {
      const s = window.__wesnoth.session;
      const side = s.viewingSide;
      const unit = s.board.unitsForSide(side).find((u) => u.movesLeft > 0);
      s.selectUnit(unit);
      const village = s.board.map.villages.find((v) => s.board.villageOwner(v) !== side && s.reachable.some((h) => h.x === v.x && h.y === v.y));
      s.clearSelection();
      return { unit: { x: unit.location.x, y: unit.location.y }, village: village && { x: village.x, y: village.y } };
    });
    check('the economy debug map has a village the player can reach this turn', !!plan.village, JSON.stringify(plan));
    const before = await colorAt(pg, plan.village.x, plan.village.y);
    const unitColor = await colorAt(pg, plan.unit.x, plan.unit.y);
    await pg.evaluate(async ([u, v]) => {
      await window.__wesnoth.clickHex(u.x, u.y);
      await window.__wesnoth.clickHex(v.x, v.y);
    }, [plan.unit, plan.village]);
    const captured = await pg
      .waitForFunction(
        (v) => {
          const s = window.__wesnoth.session;
          const loc = s.board.map.villages.find((l) => l.x === v.x && l.y === v.y);
          return s.board.villageOwner(loc) === s.viewingSide;
        },
        plan.village,
        { timeout: 30000 },
      )
      .then(() => true, () => false);
    check('the move captured the village', captured);
    await pg.waitForTimeout(500);
    const after = await colorAt(pg, plan.village.x, plan.village.y);
    // Upstream marks an unowned village with the `white` range's min, a dark grey (30, 30, 30).
    check('an unowned village is marked in upstream\'s unowned grey', same(before, [30, 30, 30]), `${before}`);
    check('...and once captured, in the player\'s side colour, without a reload', same(after, unitColor), `${after} vs ${unitColor}`);
    check('no page errors (economy)', errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ── Minimap: only what the viewing side knows ────────────────────────────────────────────────
  // Fog debug: two leaders in opposite corners of a shrouded 10 x 10 map, both sides human (hotseat).
  {
    const { ctx, pg, errs } = await openDebug('synthetic_fog');
    const leaders = await pg.evaluate(() => {
      const s = window.__wesnoth.session;
      return s.board.allUnits().map((u) => ({ side: u.side, x: u.location.x, y: u.location.y }));
    });
    const hero = leaders.find((l) => l.side === 1);
    const villain = leaders.find((l) => l.side === 2);
    const heroColor1 = await colorAt(pg, hero.x, hero.y);
    const villainColor1 = await colorAt(pg, villain.x, villain.y);
    // Side 1 cannot see side 2's corner: that hex is drawn as shroud, not as a unit.
    check('side 1\'s own leader is on its minimap', !!heroColor1 && !same(heroColor1, [31, 31, 23]), `${heroColor1}`);
    check('side 2\'s leader, under side 1\'s shroud, is not', !same(villainColor1, heroColor1), `${villainColor1}`);
    await pressKey(pg, 'Control+Space');
    await skipToPlay(pg, 60000).catch(() => {});
    await pg.waitForFunction(() => window.__wesnoth.session.viewingSide === 2, null, { timeout: 60000 });
    await pg.waitForTimeout(500);
    const villainColor2 = await colorAt(pg, villain.x, villain.y);
    const heroColor2 = await colorAt(pg, hero.x, hero.y);
    check('in hotseat, side 2\'s turn shows side 2\'s leader...', !!villainColor2 && !same(villainColor2, villainColor1), `${villainColor1} -> ${villainColor2}`);
    check('...and no longer shows side 1\'s, now under side 2\'s shroud', !same(heroColor2, heroColor1), `${heroColor1} -> ${heroColor2}`);
    check('no page errors (fog)', errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
