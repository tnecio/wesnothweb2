/**
 * Shared Playwright flows for the browser measurement/verification scripts
 * (measure-load.mjs, image-golden.mjs). They drive the real app on a running
 * dev server and rely on the dev-only hooks `GameBoardView.svelte` installs:
 * `[data-board-ready]` and `window.__wesnothDebug` (`imageCache`,
 * `hexClientPoint`).
 */

/** Opens `/play/<campaign>` (optionally `?scenario=<id>`). */
export async function openScenario(page, base, campaign, scenario) {
  const query = scenario ? `?scenario=${encodeURIComponent(scenario)}` : '';
  await page.goto(`${base}/play/${campaign}${query}`);
}

/** Resolves once the board has rendered its terrain (`[data-board-ready="true"]`). */
export async function waitBoardReady(page, timeout = 180000) {
  await page.waitForSelector('.board-view[data-board-ready="true"]', { timeout });
}

/** Clicks through story, objectives and startup dialogue until none is showing. */
// Generous: in Dead Water each startup message re-syncs the board's units, and while
// ImageCache work runs on the main thread a single advance can take several seconds.
export async function skipToPlay(page, timeout = 360000) {
  const started = Date.now();
  const actions = { story: 0, message: 0, ok: 0 };
  let quietRounds = 0;
  while (Date.now() - started < timeout) {
    if (await page.$('.story')) {
      await page.keyboard.press('Escape');
      actions.story++;
      quietRounds = 0;
    } else if (await page.$('.window[role="dialog"]')) {
      await page.keyboard.press('Enter');
      actions.message++;
      quietRounds = 0;
    } else {
      const ok = page.getByRole('button', { name: 'OK', exact: true });
      if ((await ok.count()) > 0) {
        // The button can go away mid-click (a navigation re-renders the page): the loop looks again.
        await ok.first().click({ timeout: 30000 }).catch(() => {});
        actions.ok++;
        quietRounds = 0;
      } else if (++quietRounds >= 3) {
        return;
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`skipToPlay: still in a pre-play screen after timeout (pressed ${JSON.stringify(actions)})`);
}

/**
 * Answers dialogue until the player has been able to act (`canAct`: no event, animation or dialogue
 * running) for 8 s -- Dead Water's opening and the other side's turns pause between speakers, and a
 * new turn plays the other side's animations and the standing orders before the player gets control.
 */
export async function untilPlayable(page, timeout = 300000) {
  const started = Date.now();
  let quietSince = Date.now();
  while (Date.now() - started < timeout) {
    // Dialogue, a story, or the objectives (whose OK can come after a long opening dialogue).
    if ((await page.$('.window[role="dialog"]')) || (await page.$('.story')) || (await page.getByRole('button', { name: 'OK', exact: true }).count()) > 0) {
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

/** Viewport coordinates of hex (x, y), engine 0-based. */
export async function hexPoint(page, x, y) {
  const point = await page.evaluate(([hx, hy]) => window.__wesnothDebug?.hexClientPoint(hx, hy) ?? null, [x, y]);
  if (!point) throw new Error(`hexPoint(${x}, ${y}): board or dev hook not available`);
  return point;
}

/**
 * Selects the unit at `from`, targets the enemy at `to` and confirms the
 * attack dialog; resolves once the exchange's animations have finished
 * (the dialog closed and no new `anim:frames` measure for a while).
 */
export async function performAttack(page, from, to) {
  const a = await hexPoint(page, from.x, from.y);
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(300);
  const b = await hexPoint(page, to.x, to.y);
  await page.mouse.click(b.x, b.y);
  const attack = page.getByRole('button', { name: 'Attack', exact: true });
  await attack.waitFor({ timeout: 30000 });
  await attack.click();
  // Wait until animation measures stop arriving.
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    const count = await page.evaluate(() => performance.getEntriesByName('anim:frames').length);
    if (count > 0 && count === last) return;
    last = count;
  }
}

/**
 * End Turn with nothing done this turn asks "You have not started your turn yet" (`menu_handler::end_turn`,
 * upstream's default `confirm_end_turn=no_moves`). Call after pressing End Turn: answers Yes (Enter, the
 * dialog's default) if the question is up, and does nothing otherwise.
 */
export async function confirmEndTurnIfAsked(page, wait = 800) {
  await page.waitForTimeout(wait);
  const text = await page.$eval('.modal-box', (e) => e.textContent ?? '').catch(() => '');
  if (/not started your turn/.test(text)) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  }
}
