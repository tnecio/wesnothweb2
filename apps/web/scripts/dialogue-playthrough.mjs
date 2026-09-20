/**
 * Phase 17 milestone, in a real browser:
 *
 *   node apps/web/scripts/dialogue-playthrough.mjs [--base http://localhost:5173] [--headed]
 *
 * Three things the old post-hoc message replay could not do at all:
 *
 *   synthetic_dialogue  an `[option]` prompt answered from the keyboard,
 *                       branching the event that was blocked on it, and a
 *                       `[text_input]` typed into and echoed back.
 *   Dead Water 5        the `start` event's ghost flies in
 *                       (`[move_unit_fake]`) and is on the board before
 *                       its own line is shown, with the rest of the
 *                       scenario's dialogue following in source order.
 *   Dead Water 1        the opening dialogue interleaved with the units
 *                       the same event spawns and moves.
 *
 * Why the choice half runs on a synthetic scenario: Two Brothers 3's real
 * password puzzle offers its options to Arvith, who arrives on the recall
 * list from scenario 2, so a browser opening scenario 3 cold has no
 * speaker and upstream's own `get_speaker` rule skips the message. That
 * scenario's branch-taking is covered on the real content in
 * `packages/ui/src/phase17Milestone.test.ts`; this script covers the UI.
 *
 * Exits non-zero if any step fails. Screenshots land in
 * `dialogue-screenshots/` for eyeballing the layout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { openScenario, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const outDir = arg('out', 'dialogue-screenshots');
fs.mkdirSync(outDir, { recursive: true });
const headed = args.includes('--headed');

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** The dialogue box currently on screen, or null. */
async function currentDialog(page) {
  const box = await page.$('.window[role="dialog"]');
  if (!box) return null;
  const text = (await box.innerText()).replace(/\s+/g, ' ').trim();
  const options = await page.$$eval('.option-label', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  const selected = await page.$$eval('.option.selected .option-label', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  const input = await page.$('#wml-text-input');
  return { text, options, selected: selected[0] ?? null, hasInput: input !== null };
}

async function waitForDialog(page, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const dialog = await currentDialog(page);
    if (dialog) return dialog;
    await page.waitForTimeout(150);
  }
  return null;
}

/** Escapes any story screens the scenario opens with. */
async function skipStory(page) {
  for (let i = 0; i < 15 && (await page.$('.story')); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  }
}

async function openAndStart(page, campaign, scenario) {
  await openScenario(page, base, campaign, scenario);
  await waitBoardReady(page);
  await skipStory(page);
}

/** Runs `body` against a fresh page, reporting any console/page errors under `label`. */
async function withPage(browser, label, body) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  try {
    await body(page);
    check(`no console errors (${label})`, errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: !headed });

try {
  // ---- the choice UI, on the synthetic dialogue scenario ----------------
  await withPage(browser, 'choices', async (page) => {
    await openAndStart(page, 'synthetic_dialogue', 'synth_dialogue_01');

    const first = await waitForDialog(page);
    check('a [foreach] in prestart fed the opening line', /Aldrin Beryl Cyrus.*40 gold/.test(first?.text ?? ''), first?.text.slice(0, 80));

    // Walk to the option prompt. The ghost's [move_unit_fake] flight and
    // the [scroll_to] happen between these two lines.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const villain = await waitForDialog(page);
    check('the line after the fake move is shown, in order', /Something drifted past/.test(villain?.text ?? ''), villain?.text.slice(0, 60));

    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const prompt = await waitForDialog(page);
    check('the [option] prompt offers its three roads', prompt?.options.length === 3, JSON.stringify(prompt?.options ?? []));
    check('the first option starts selected', prompt?.selected === prompt?.options[0], String(prompt?.selected));
    await page.screenshot({ path: path.join(outDir, 'option-prompt.png') });

    // Arrow keys move the highlight; Enter answers with it.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    const moved = await currentDialog(page);
    check('ArrowDown moves the highlight', moved?.selected === prompt?.options[1], String(moved?.selected));

    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const branch = await waitForDialog(page);
    check('the event resumes down the chosen branch', /The river it is\. Choice 2 of 3/.test(branch?.text ?? ''), branch?.text.slice(0, 70));

    // ...and the [text_input] that follows it.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const asked = await waitForDialog(page);
    check('the [text_input] prompt has a text field', asked?.hasInput === true, asked?.text.slice(0, 50));
    await page.screenshot({ path: path.join(outDir, 'text-input.png') });

    await page.fill('#wml-text-input', 'Stonewatch');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const echoed = await waitForDialog(page);
    check('what was typed reaches the WML variable', /So it was named Stonewatch/.test(echoed?.text ?? ''), echoed?.text.slice(0, 60));

    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    check('the scenario reaches play', (await currentDialog(page)) === null);
  });

  // ---- Dead Water 5: the opening cutscene, on real content --------------
  await withPage(browser, 'Dead Water 5', async (page) => {
    await openAndStart(page, 'dead_water', '05_Tirigaz');

    // The ghost's flight happens before any dialogue: capture the board
    // mid-cutscene, then the line it leads into.
    await page.screenshot({ path: path.join(outDir, 'dw5-ghost-flight.png') });
    const first = await waitForDialog(page, 60000);
    check('the ghost speaks only after its flight', /Found\. Them\./.test(first?.text ?? ''), first?.text.slice(0, 60));
    await page.screenshot({ path: path.join(outDir, 'dw5-first-line.png') });

    const lines = [];
    for (let i = 0; i < 25; i++) {
      const dialog = await currentDialog(page);
      if (!dialog) break;
      lines.push(dialog.text.slice(0, 40));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
    }
    check('the scenario reaches play after its cutscene', (await currentDialog(page)) === null, `${lines.length} lines shown`);
  });

  // ---- Dead Water 1: dialogue interleaved with the units it spawns ------
  await withPage(browser, 'Dead Water 1', async (page) => {
    await openAndStart(page, 'dead_water');

    const lines = [];
    for (let i = 0; i < 20; i++) {
      // Generous per line: this opening is a real cutscene (`[unit]
      // animate=yes`, `[move_unit]`, `[delay]`), and on a cold cache the
      // first animation of each newly spawned type spends seconds
      // compositing its sprites on the main thread -- Phase 28a's known
      // OffscreenCanvas follow-up, measured in docs/PROGRESS.md.
      const dialog = await waitForDialog(page, i === 0 ? 60000 : 30000);
      if (!dialog) break;
      lines.push(dialog.text.replace(/\s+/g, ' ').slice(0, 40));
      if (i === 2) await page.screenshot({ path: path.join(outDir, 'dw1-gwabbo.png') });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }
    check('the opening dialogue plays in order', lines.length >= 8, `${lines.length} lines`);
    check('Gwabbo speaks his own line third', /Back, you fiend/.test(lines[2] ?? ''), lines[2]);
  });
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} step(s) failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nblocking dialogue, choices and cutscene ordering: every step passed');
}
