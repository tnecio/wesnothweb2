/**
 * Phase 28b milestone, on Dead Water scenario 1:
 *
 * - mouse: hovering an enemy with nothing selected shows its reach; with Kai selected, hovering a hex
 *   four turns away shows the footsteps with the turn numbers; clicking it queues the order, and Kai
 *   walks on at the start of the next two turns until a new order cancels it;
 * - mouse: moving onto an enemy from a hex next to it shows the attack indicator and the route there;
 *   the attack dialog opens before any move, dismissing it leaves Kai where he was, confirming moves
 *   then attacks;
 * - touch: tapping a hex next to the enemy and then the enemy is the same order; an ambush on the
 *   way stops Kai and cancels the attack.
 *
 * - continue move: a move stopped by sighting an enemy (fog on) walks on with `t`;
 * - with "Disable automatic moves" on, a standing order is not carried on at the next turn.
 *
 *   node apps/web/scripts/movement-orders-playthrough.mjs [--base http://localhost:5173]
 *     [--only orders,mouse-attack,touch-attack,continue,no-auto-moves]
 */
import { chromium } from 'playwright';
import { hexPoint, skipToPlay, waitBoardReady, confirmEndTurnIfAsked } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:5173';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const runs = (part) => !only || only.includes(part);

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const kaiState = (page) =>
  page.evaluate(() => {
    const kai = window.__wesnoth.session.board.allUnits().find((u) => u.id === 'Kai Krellis');
    return { x: kai.location.x, y: kai.location.y, goto: kai.goto ? { x: kai.goto.x, y: kai.goto.y } : null, attacksLeft: kai.attacksLeft };
  });

/**
 * Answers dialogue until the player has been able to act (`canAct`: no event, animation or dialogue
 * running) for 8 s -- Dead Water's opening and the other side's turns pause between speakers, and a
 * new turn plays the other side's animations and the standing orders before the player gets control.
 */
async function untilPlayable(page, timeout = 300000) {
  const started = Date.now();
  let quietSince = Date.now();
  while (Date.now() - started < timeout) {
    if ((await page.$('.window[role="dialog"]')) || (await page.$('.story'))) {
      await skipToPlay(page, 120000);
      quietSince = Date.now();
    } else if (!(await page.evaluate(() => window.__wesnoth?.movementPreview().canAct ?? false))) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince > 8000) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('untilPlayable: the game never became playable');
}

/** After End Turn: answers the other side's dialogue until it is the player's turn after `turn`, then lets it settle. */
async function backToPlayer(page, turn) {
  const started = Date.now();
  while (Date.now() - started < 300000) {
    const done = await page.evaluate((t) => window.__wesnoth.session.turnNumber > t && window.__wesnoth.session.activeSide === 1, turn);
    if (done) break;
    if (await page.$('.window[role="dialog"]')) await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  }
  await untilPlayable(page);
}

async function openDeadWater(page) {
  await page.goto(`${base}/play/dead_water`);
  await skipToPlay(page);
  await waitBoardReady(page);
  await untilPlayable(page);
  // The opening leaves its last speaker on view; start with nothing selected.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** Moves the mouse onto hex (x, y), then lets the route's images arrive. */
async function hover(page, x, y) {
  const p = await hexPoint(page, x, y);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(400);
}

async function scrollTo(page, x, y) {
  await page.evaluate(([hx, hy]) => window.__wesnothDebug.scrollToHex(hx, hy, 'warp'), [x, y]);
  await page.waitForTimeout(300);
}

/**
 * Kai at (24,10), Mal-Kevek three hexes south at (24,13), no one else within three hexes; nothing
 * selected. A click on an empty far hex re-syncs the board.
 */
async function stageFacing(page) {
  await page.evaluate(async () => {
    const { session } = window.__wesnoth;
    const board = session.board;
    const Loc = board.allUnits()[0].location.constructor;
    const kai = board.allUnits().find((u) => u.id === 'Kai Krellis');
    const mal = board.allUnits().find((u) => u.id === 'Mal-Kevek');
    const near = (u) => Math.abs(u.location.x - 24) <= 3 && Math.abs(u.location.y - 11) <= 3;
    for (const u of board.allUnits()) if (u !== kai && u !== mal && near(u)) board.moveUnit(u.location, new Loc(2 + (u.location.x % 5), 25 - (u.location.y % 3)));
    board.moveUnit(kai.location, new Loc(24, 10));
    board.moveUnit(mal.location, new Loc(24, 13));
    kai.movesLeft = kai.maxMoves;
    kai.attacksLeft = 1;
    session.clearSelection();
    await window.__wesnoth.clickHex(10, 10);
  });
  await scrollTo(page, 24, 11);
}

const browser = await chromium.launch();
try {
  // ── Mouse: reach on hover, a multi-turn order ─────────────────────────────
  if (runs('orders')) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDeadWater(page);

    const mal = await page.evaluate(() => {
      const u = window.__wesnoth.session.board.allUnits().find((v) => v.id === 'Mal-Kevek');
      return { x: u.location.x, y: u.location.y };
    });
    await scrollTo(page, mal.x, mal.y);
    await hover(page, mal.x, mal.y);
    const enemyReach = await page.evaluate(() => window.__wesnothDebug.reachCount());
    check("hovering an enemy with nothing selected shows its reach", enemyReach > 0, `${enemyReach} hexes`);
    await hover(page, mal.x - 3, mal.y - 3);
    check('...and moving off it hides it', (await page.evaluate(() => window.__wesnothDebug.reachCount())) === 0);

    const kai0 = await kaiState(page);
    await scrollTo(page, kai0.x, kai0.y);
    const k = await hexPoint(page, kai0.x, kai0.y);
    await page.mouse.click(k.x, k.y);
    await page.waitForTimeout(300);
    check('clicking Kai selects him', (await page.evaluate(() => window.__wesnoth.session.selectedUnit?.id)) === 'Kai Krellis');
    // A hex four turns away, west along Kai's row (the session knows the routes).
    const dest = await page.evaluate(([kx, ky]) => {
      const { session } = window.__wesnoth;
      for (let x = kx - 1; x >= 0; x--) {
        const r = session.routePreview(x, ky + 2);
        if (r && r.marks.at(-1).turns >= 4) return { x, y: ky + 2, turns: r.marks.at(-1).turns };
      }
      return null;
    }, [kai0.x, kai0.y]);
    check('there is a hex four turns away', !!dest, JSON.stringify(dest));
    if (!dest) throw new Error('no destination');
    await scrollTo(page, dest.x + 6, dest.y);
    await hover(page, dest.x, dest.y);
    await page.waitForFunction(() => (window.__wesnothDebug.route()?.footprints ?? 0) > 0, null, { timeout: 15000 }).catch(() => {});
    const route = await page.evaluate(() => window.__wesnothDebug.route());
    const labels = route?.marks.flatMap((m) => m.texts) ?? [];
    check('the footsteps show the whole route', (route?.footprints ?? 0) > 6, `${route?.footprints} prints`);
    check('...with the turn numbers', ['1', '2', '3', String(dest.turns)].every((t) => labels.includes(t)), labels.join(' '));
    check('...and the defense on each turn-end hex', labels.filter((t) => t.endsWith('%')).length === dest.turns, labels.join(' '));

    const d = await hexPoint(page, dest.x, dest.y);
    await page.mouse.click(d.x, d.y);
    await untilPlayable(page);
    const kai1 = await kaiState(page);
    check('the order moves Kai as far as he can go now', kai1.x !== kai0.x || kai1.y !== kai0.y, `${kai0.x},${kai0.y} -> ${kai1.x},${kai1.y}`);
    check('...and keeps the rest as a standing order', kai1.goto?.x === dest.x && kai1.goto?.y === dest.y, JSON.stringify(kai1.goto));

    let previous = kai1;
    for (const turn of [2, 3]) {
      const before = await page.evaluate(() => window.__wesnoth.session.turnNumber);
      await page.getByRole('button', { name: 'End Turn', exact: true }).click();
      await confirmEndTurnIfAsked(page);
      await backToPlayer(page, before);
      const now = await kaiState(page);
      check(`turn ${turn}: Kai walks on by himself`, now.x !== previous.x || now.y !== previous.y, `${previous.x},${previous.y} -> ${now.x},${now.y}`);
      check(`turn ${turn}: ...still under the order`, now.goto?.x === dest.x && now.goto?.y === dest.y, JSON.stringify(now.goto));
      previous = now;
    }

    // Still turn 3: clicking Kai, then Kai again, cancels the order (`move_action`), and turn 4 leaves him be.
    await scrollTo(page, previous.x, previous.y);
    const p = await hexPoint(page, previous.x, previous.y);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(300);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(300);
    check('clicking the selected unit cancels its order', (await kaiState(page)).goto === null);
    const t3 = await page.evaluate(() => window.__wesnoth.session.turnNumber);
    await page.getByRole('button', { name: 'End Turn', exact: true }).click();
    await confirmEndTurnIfAsked(page);
    await backToPlayer(page, t3);
    await page.waitForTimeout(2000);
    const kai4 = await kaiState(page);
    check('...and next turn Kai stays where he is', kai4.x === previous.x && kai4.y === previous.y, JSON.stringify(kai4));
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }

  // ── Mouse: move-and-attack ────────────────────────────────────────────────
  if (runs('mouse-attack')) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDeadWater(page);
    await stageFacing(page);

    const k = await hexPoint(page, 24, 10);
    await page.mouse.click(k.x, k.y);
    await page.waitForTimeout(300);
    await hover(page, 24, 12);
    await hover(page, 24, 13);
    const indicator = await page.evaluate(() => window.__wesnothDebug.attackIndicator());
    const route = await page.evaluate(() => window.__wesnothDebug.route());
    check('moving onto the enemy from a hex next to it shows the attack indicator', indicator === 2, `${indicator} sprites`);
    check('...and the route to that hex', route?.marks.some((m) => m.x === 24 && m.y === 12) ?? false, JSON.stringify(route?.marks));

    const m = await hexPoint(page, 24, 13);
    await page.mouse.click(m.x, m.y);
    const attack = page.getByRole('button', { name: 'Attack', exact: true });
    await attack.waitFor({ timeout: 15000 });
    check('the attack dialog opens before Kai moves', (await kaiState(page)).y === 10);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(500);
    const afterCancel = await kaiState(page);
    const stillSelected = await page.evaluate(() => window.__wesnoth.session.selectedUnit?.id === 'Kai Krellis');
    check('dismissing it does nothing: Kai stays and stays selected', afterCancel.x === 24 && afterCancel.y === 10 && stillSelected, JSON.stringify(afterCancel));

    await hover(page, 24, 12);
    await hover(page, 24, 13);
    await page.mouse.click(m.x, m.y);
    await attack.waitFor({ timeout: 15000 });
    await attack.click();
    await untilPlayable(page);
    const afterAttack = await kaiState(page);
    check('confirming moves Kai next to the enemy, then attacks', afterAttack.x === 24 && afterAttack.y === 12 && afterAttack.attacksLeft === 0, JSON.stringify(afterAttack));
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }

  // ── Touch: move-and-attack, and an ambush that cancels it ────────────────
  if (runs('touch-attack')) {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDeadWater(page);
    await stageFacing(page);
    const tap = async (x, y) => {
      const p = await hexPoint(page, x, y);
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForTimeout(400);
    };

    await tap(24, 10);
    await tap(24, 12);
    await page.waitForFunction(() => (window.__wesnothDebug.route()?.footprints ?? 0) > 0, null, { timeout: 15000 }).catch(() => {});
    check('a tap next to the enemy picks the hex (and shows the route)', ((await page.evaluate(() => window.__wesnothDebug.route()))?.footprints ?? 0) > 0);
    const targets = await page.evaluate(() => window.__wesnothDebug.attackTargets());
    check('...and marks the enemy it could attack from there red', targets.some((h) => h.x === 24 && h.y === 13), JSON.stringify(targets));
    await tap(24, 13);
    const attack = page.getByRole('button', { name: 'Attack', exact: true });
    await attack.waitFor({ timeout: 15000 });
    check('...and a tap on the enemy opens the attack from there, before moving', (await kaiState(page)).y === 10);
    const from = await page.evaluate(() => window.__wesnoth.session.pendingAttack?.from);
    check('...the attack is from the tapped hex', from?.x === 24 && from?.y === 12, JSON.stringify(from));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(500);
    check('dismissed: Kai has not moved', (await kaiState(page)).y === 10);

    // A hidden enemy next to the first step of the way (and not next to Kai).
    const ambush = await page.evaluate(() => {
      const { session } = window.__wesnoth;
      const board = session.board;
      const Loc = board.allUnits()[0].location.constructor;
      session.selectUnit(board.allUnits().find((u) => u.id === 'Kai Krellis'));
      const steps = session.routePreview(24, 12).steps;
      const first = steps[1];
      const kai = steps[0];
      // `getAdjacentTiles`: n, ne, se, s, sw, nw; odd columns sit half a hex lower.
      const around = ({ x, y }) => {
        const odd = x % 2 === 1;
        return [
          [x, y - 1],
          [x + 1, odd ? y : y - 1],
          [x + 1, odd ? y + 1 : y],
          [x, y + 1],
          [x - 1, odd ? y + 1 : y],
          [x - 1, odd ? y : y - 1],
        ];
      };
      const nextToKai = around(kai).map(([x, y]) => `${x},${y}`);
      const lurk = around(first).find(
        ([x, y]) => !board.unitAt(new Loc(x, y)) && !nextToKai.includes(`${x},${y}`) && !(x === kai.x && y === kai.y) && !steps.some((st) => st.x === x && st.y === y),
      );
      const fiend = board.allUnits().find((u) => u.id === 'fiend');
      board.moveUnit(fiend.location, new Loc(lurk[0], lurk[1]));
      fiend.hidden = true;
      session.clearSelection();
      return { first, lurk, hp: board.allUnits().find((u) => u.id === 'Mal-Kevek').hitpoints };
    });
    await tap(24, 10);
    await tap(24, 12);
    await tap(24, 13);
    await attack.waitFor({ timeout: 15000 });
    await attack.click();
    await untilPlayable(page);
    const after = await kaiState(page);
    const hp = await page.evaluate(() => window.__wesnoth.session.board.allUnits().find((u) => u.id === 'Mal-Kevek').hitpoints);
    check('an ambush on the way stops Kai', after.x === ambush.first.x && after.y === ambush.first.y, `${JSON.stringify(after)} (ambush by ${ambush.lurk})`);
    check('...and the attack does not happen', after.attacksLeft === 1 && hp === ambush.hp, `attacks ${after.attacksLeft}, hp ${ambush.hp} -> ${hp}`);
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
  // ── Continue move (t) after sighting an enemy ─────────────────────────────
  if (runs('continue')) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDeadWater(page);
    // Fog on for Kai's side; everyone else of his out of the way; Mal-Kevek hidden in the fog to the west.
    await page.evaluate(async () => {
      const { session } = window.__wesnoth;
      const board = session.board;
      const Loc = board.allUnits()[0].location.constructor;
      board.getTeam(1).fog.enabled = true;
      const kai = board.allUnits().find((u) => u.id === 'Kai Krellis');
      for (const u of board.allUnits()) if (u.side === 1 && u !== kai) board.removeUnitAt(u.location);
      const mal = board.allUnits().find((u) => u.id === 'Mal-Kevek');
      board.moveUnit(mal.location, new Loc(8, 12));
      session.clearSelection();
      await window.__wesnoth.clickHex(30, 3);
    });
    // The fog is recomputed at the next sync; the order below triggers it anyway.
    await scrollTo(page, 17, 9);
    const k = await hexPoint(page, 19, 8);
    await page.mouse.click(k.x, k.y);
    await page.waitForTimeout(300);
    const d = await hexPoint(page, 14, 10);
    await page.mouse.click(d.x, d.y);
    await untilPlayable(page);
    const stopped = await kaiState(page);
    const interrupted = await page.evaluate(() => window.__wesnoth.session.board.allUnits().find((u) => u.id === 'Kai Krellis').interruptedMove);
    check('sighting an enemy stops the move short', !(stopped.x === 14 && stopped.y === 10), JSON.stringify(stopped));
    check('...and remembers where it was headed', interrupted?.x === 14 && interrupted?.y === 10, JSON.stringify(interrupted));
    const s = await hexPoint(page, stopped.x, stopped.y);
    await page.mouse.move(s.x, s.y, { steps: 3 });
    await page.keyboard.press('t');
    await untilPlayable(page);
    const after = await kaiState(page);
    check('t continues the move to where it was headed', after.x === 14 && after.y === 10, JSON.stringify(after));
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }

  // ── "Disable automatic moves" ────────────────────────────────────────────
  if (runs('no-auto-moves')) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('wesnothweb2.display', JSON.stringify({ disableAutoMoves: true }));
      } catch {
        /* ignore */
      }
    });
    const page = await context.newPage();
    await openDeadWater(page);
    await scrollTo(page, 19, 8);
    const k = await hexPoint(page, 19, 8);
    await page.mouse.click(k.x, k.y);
    await page.waitForTimeout(300);
    await scrollTo(page, 8, 10);
    const d = await hexPoint(page, 2, 10);
    await page.mouse.click(d.x, d.y);
    await untilPlayable(page);
    const ordered = await kaiState(page);
    check('an order still leaves a standing order', ordered.goto?.x === 2 && ordered.goto?.y === 10, JSON.stringify(ordered));
    const before = await page.evaluate(() => window.__wesnoth.session.turnNumber);
    await page.getByRole('button', { name: 'End Turn', exact: true }).click();
    await confirmEndTurnIfAsked(page);
    await backToPlayer(page, before);
    const next = await kaiState(page);
    check('...but with automatic moves disabled, the next turn leaves Kai where he is', next.x === ordered.x && next.y === ordered.y && next.goto !== null, JSON.stringify(next));
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
