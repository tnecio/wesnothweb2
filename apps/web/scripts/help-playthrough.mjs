/**
 * The help browser (Phase 24), in a real browser:
 *
 *   node apps/web/scripts/help-playthrough.mjs [--base http://localhost:5173] [--headed] [--only menu,game,phone] [--shots dir]
 *
 * - menu: the title screen's Help button and F1; the introduction; a section's page and the tree; the search
 *   box; the Merman Fighter page (the values in `docs/reference/help/`); links; back and next; Escape closes.
 * - game (Dead Water 1): F1; the context menu's Unit Type Description and Terrain Description; a side panel
 *   link; `[open_help]` in an event, which waits for the help to close before the event goes on.
 * - phone: the tree is an overlay that Show Topics opens and choosing a topic closes.
 *
 * `--shots dir` saves screenshots of the introduction, the Merman Fighter page and the Terrains section, for
 * a side-by-side look against `docs/reference/help/`. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';
import { hexPoint, openScenario, skipToPlay, untilPlayable, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const headed = args.includes('--headed');
const only = arg('only', 'menu,game,phone').split(',');
const shots = arg('shots', null);

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const HELP = '.help';
const title = (page) => page.$eval('.help .topic-title', (e) => e.textContent.trim()).catch(() => null);
const pageText = (page) => page.$eval('.help .page', (e) => e.textContent).catch(() => '');
const helpOpen = async (page) => (await page.$(HELP)) !== null;
async function waitTitle(page, expected, timeout = 30000) {
  await page.waitForFunction((t) => document.querySelector('.help .topic-title')?.textContent.trim() === t, expected, { timeout }).catch(() => {});
  return title(page);
}

const browser = await chromium.launch({ headless: !headed });
try {
  if (only.includes('menu')) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && /\[help\]/.test(m.text()) && errors.push(m.text()));
    await page.goto(base);
    await page.waitForSelector('[data-testid="title-help"]', { timeout: 60000 });

    await page.click('[data-testid="title-help"]');
    check('the title screen Help button opens the help at the introduction', (await waitTitle(page, 'Introduction')) === 'Introduction');
    const top = await page.$$eval('.help .tree > li > .node', (ns) => ns.map((n) => n.textContent.trim()));
    check('the tree lists the toplevel sections in upstream order', top[0] === 'Introduction' && top.includes('Units') && top.at(-1) === 'License', top.join(', '));
    if (shots) await page.screenshot({ path: `${shots}/port-contents.png` });

    await page.click('.help .node:has-text("Terrains")');
    await waitTitle(page, 'Terrains');
    if (shots) await page.screenshot({ path: `${shots}/port-terrains.png` });

    await page.click('.help .node:has-text("Units")');
    check('a section opens its own page', (await waitTitle(page, 'Units')) === 'Units');
    check('...listing its subsections', /Merfolk/.test(await pageText(page)));
    check('...and unfolds in the tree', (await page.$('.help .node:has-text("Merfolk")')) !== null);

    await page.fill('.help input.filter', 'merman fight');
    await page.waitForTimeout(300);
    const filtered = await page.$$eval('.help .node', (ns) => ns.map((n) => n.textContent.trim()));
    check('the search box keeps only the matches and the sections holding them', filtered.join('|') === 'Units|Merfolk|Merman Fighter', filtered.join('|'));
    await page.click('.help .node:has-text("Merman Fighter")');
    await waitTitle(page, 'Merman Fighter');
    const unit = await pageText(page);
    check('the Merman Fighter page shows its stats', /HP:\s36\s+Moves:\s6\s+Cost:\s14/.test(unit), unit.slice(0, 200));
    check('...its attack and its resistances', unit.includes('trident') && unit.includes('6×3') && /cold\s*20%/.test(unit));
    await page.fill('.help input.filter', '');
    if (shots) {
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${shots}/port-unit.png` });
    }

    await page.click('.help .page a.link:has-text("Merfolk")');
    check('a link in the page opens its topic', (await waitTitle(page, 'Merfolk')) === 'Merfolk');
    await page.click('.help button[aria-label="Back"]');
    check('back returns to the previous page', (await waitTitle(page, 'Merman Fighter')) === 'Merman Fighter');
    await page.click('.help button[aria-label="Next"]');
    check('next goes forward again', (await waitTitle(page, 'Merfolk')) === 'Merfolk');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Escape closes the help', !(await helpOpen(page)));
    await page.keyboard.press('F1');
    check('F1 on the title screen opens it', (await waitTitle(page, 'Introduction')) === 'Introduction');
    await page.click('.help .footer button');
    check('Close closes it', !(await helpOpen(page)));
    check('no page errors (menu)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  }

  if (only.includes('game')) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && /\[help\]/.test(m.text()) && errors.push(m.text()));
    await openScenario(page, base, 'dead_water');
    await waitBoardReady(page);
    await skipToPlay(page);
    await untilPlayable(page);

    await page.keyboard.press('F1');
    check('F1 in a game opens the help', (await waitTitle(page, 'Introduction')) === 'Introduction');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    const kai = await page.evaluate(() => {
      const u = window.__wesnoth.session.board.allUnits().find((v) => v.id === 'Kai Krellis');
      return { x: u.location.x, y: u.location.y, type: u.type.name };
    });
    await page.evaluate(([x, y]) => window.__wesnothDebug.scrollToHex(x, y, 'warp'), [kai.x, kai.y]);
    let p = await hexPoint(page, kai.x, kai.y);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Unit Type Description' }).click();
    check("the context menu's Unit Type Description opens the unit's page", (await waitTitle(page, kai.type)) === kai.type, kai.type);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    p = await hexPoint(page, kai.x, kai.y);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Terrain Description' }).click();
    await page.waitForTimeout(1500);
    const terrainTitle = await title(page);
    const code = await page.evaluate(([x, y]) => window.__wesnoth.session.terrainCodeAt(x, y), [kai.x, kai.y]);
    // Kai starts on his keep.
    check('...and Terrain Description the terrain under it', !!terrainTitle && /Keep/.test(terrainTitle) && /K/.test(code), `${terrainTitle} (${code})`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    p = await hexPoint(page, kai.x, kai.y);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(500);
    const traitLink = page.locator('.unit-info button.help-link').filter({ hasText: /./ });
    const count = await traitLink.count();
    check('the side panel shows help links for the selected unit', count >= 3, `${count} links`);
    const race = page.locator('.unit-info button.help-link', { hasText: 'Merfolk' }).first();
    if ((await race.count()) > 0) {
      await race.click();
      check('...and its race link opens the race page', (await waitTitle(page, 'Merfolk')) === 'Merfolk');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // `[open_help]` in an event: the help shows, and the event goes on (its next message) only once it is closed.
    await page.evaluate(() =>
      window.__wesnoth.addEvent(`[event]
name=moveto
[open_help]
topic=unit_Merman Fighter
[/open_help]
[message]
speaker=narrator
message="After the help."
[/message]
[/event]`),
    );
    const dest = await page.evaluate(([kx, ky]) => {
      const { session } = window.__wesnoth;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1]]) {
        const r = session.routePreview(kx + dx, ky + dy);
        if (r && r.marks.at(-1).turns <= 1) return { x: kx + dx, y: ky + dy };
      }
      return null;
    }, [kai.x, kai.y]);
    check('Kai has a hex next to him to move to', !!dest);
    if (dest) {
      const d = await hexPoint(page, dest.x, dest.y);
      await page.mouse.click(d.x, d.y);
      check('[open_help] opens the help at its topic', (await waitTitle(page, 'Merman Fighter', 60000)) === 'Merman Fighter');
      await page.waitForTimeout(1000);
      check('...and the event waits: its next message is not shown yet', (await page.$('.window[role="dialog"]')) === null);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.window[role="dialog"]', { timeout: 30000 }).catch(() => {});
      const msg = await page.$eval('.window[role="dialog"]', (e) => e.textContent).catch(() => '');
      check('...closing the help lets the event go on', /After the help\./.test(msg), msg.slice(0, 80));
      await page.keyboard.press('Enter');
    }
    check('no page errors (game)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  }

  if (only.includes('phone')) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base);
    await page.waitForSelector('[data-testid="title-help"]', { timeout: 60000 });
    await page.tap('[data-testid="title-help"]');
    await waitTitle(page, 'Introduction');
    check('on a phone the help opens on the page, the tree hidden', (await page.$('.help .tree-panel')) === null);
    await page.tap('.help .toggle');
    await page.waitForTimeout(300);
    check('Show Topics opens the tree over the page', (await page.$('.help .tree-panel')) !== null);
    await page.tap('.help .node:has-text("Gameplay")');
    check('choosing a topic shows it', (await waitTitle(page, 'Gameplay')) === 'Gameplay');
    check('...and closes the tree', (await page.$('.help .tree-panel')) === null);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check('no sideways scrolling', !overflow);
    check('no page errors (phone)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
