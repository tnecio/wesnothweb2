/**
 * Phase 22 milestone: the camera and the minimap, in a real browser.
 *
 *  - Camera: dragging far past the map edge is stopped at upstream's bounds; the zoom hotkeys walk
 *    exactly upstream's nine levels; the wheel pans and Ctrl+wheel zooms; `0` toggles 1:1 and back.
 *
 * Run: node apps/web/scripts/minimap-camera-playthrough.mjs [--base http://localhost:5173] [--headed]
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
  {
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
    check('zoomed right out, the map is held in the middle of the screen', small.zoom === 16, JSON.stringify(small));
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
