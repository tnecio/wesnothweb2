/**
 * Phase 20 milestone 1, in a real browser:
 *
 *   node apps/web/scripts/i18n-playthrough.mjs [--base http://localhost:5173] [--headed] [--lang pl_PL]
 *
 * Opens Dead Water 1 in English and stops on a line of its opening dialogue, switches the language
 * to Polish (through the same `locale.setLanguage` the Menu > Language picker calls; a dialogue
 * covers the menu, so the script cannot click it), and checks that what is on screen changes to the
 * catalogue's own translation, without a reload:
 *
 *   - the dialogue line that is open,
 *   - the menu labels and the End Turn button,
 *   - a selected unit's type name in the side panel,
 *   - the objectives dialog, while it is open (labels and objective text).
 *
 * Expected strings come from the shipped catalogue (`public/i18n/<lang>/<domain>.json`, itself built
 * from upstream's `.po`), keyed by the English text found on screen -- so the script proves the UI
 * shows exactly the translation upstream's catalogue holds, not a string of its own. It then
 * switches back and checks English returns. A marker set on `window` must survive throughout.
 *
 * Exits non-zero if any step fails; screenshots land in `i18n-screenshots/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openScenario, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const lang = arg('lang', 'pl_PL');
const outDir = arg('out', 'i18n-screenshots');
const headed = args.includes('--headed');
fs.mkdirSync(outDir, { recursive: true });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const catalogue = (domain) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/i18n', lang, `${domain}.json`), 'utf8')).entries;
const cat = { wesnoth: catalogue('wesnoth'), lib: catalogue('wesnoth-lib'), dw: catalogue('wesnoth-dw'), units: catalogue('wesnoth-units') };
/** The translation of an English msgid, or null when the catalogue has none. */
const tr = (domain, msgid) => (typeof cat[domain][msgid] === 'string' ? cat[domain][msgid] : null);

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

async function dialogText(page) {
  const box = await page.$('.window[role="dialog"]');
  if (!box) return null;
  const title = (await page.$eval('.window .title', (e) => e.textContent).catch(() => '')) ?? '';
  const body = (await page.$eval('.window .text', (e) => e.textContent).catch(() => '')) ?? '';
  return { title: norm(title), body: norm(body) };
}

async function waitForDialog(page, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const d = await dialogText(page);
    if (d) return d;
    await page.waitForTimeout(150);
  }
  return null;
}

async function setLanguage(page, code) {
  await page.evaluate((c) => window.__wesnothI18n.setLanguage(c), code);
  await page.waitForTimeout(400);
}

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

try {
  await openScenario(page, base, 'dead_water');
  await waitBoardReady(page);
  await page.evaluate(() => (window.__i18nMarker = 'still here'));
  for (let i = 0; i < 15 && (await page.$('.story')); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  }
  check('starts in English', (await page.evaluate(() => window.__wesnothI18n.current())) === 'en_US');

  // ---- an open dialogue line ------------------------------------------------
  // Find a line whose text is one of the catalogue's own msgids (some carry $variables and are built at run time).
  let dialogue = null;
  for (let i = 0; i < 12; i++) {
    const d = await waitForDialog(page);
    if (!d) break;
    if (tr('dw', d.body)) {
      dialogue = d;
      break;
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  }
  check('stopped on a dialogue line that has a translation', dialogue !== null, dialogue?.body.slice(0, 70));
  if (dialogue) {
    const expected = norm(tr('dw', dialogue.body));
    await page.screenshot({ path: path.join(outDir, 'dialogue-en.png') });
    await setLanguage(page, lang);
    const after = await dialogText(page);
    check('the open dialogue line is now the catalogue translation', after?.body === expected, `${after?.body.slice(0, 70)}`);
    check('...and it is a different string', after?.body !== dialogue.body);
    check('<html lang> follows', (await page.evaluate(() => document.documentElement.lang)) === lang.replace('_', '-'));
    await page.screenshot({ path: path.join(outDir, 'dialogue-translated.png') });
    await setLanguage(page, 'en_US');
    const back = await dialogText(page);
    check('switching back restores the English line', back?.body === dialogue.body, back?.body.slice(0, 70));
    await setLanguage(page, lang);
  }

  // ---- on to play; the chrome ------------------------------------------------
  let quiet = 0;
  for (let i = 0; i < 120 && quiet < 6; i++) {
    if (await page.$('.story')) {
      await page.keyboard.press('Escape');
      quiet = 0;
    } else if (await page.$('.window[role="dialog"]')) {
      await page.keyboard.press('Enter');
      quiet = 0;
    } else if (await page.$('.modal-box')) {
      const ok = page.locator('.modal-box .footer button, .modal-box .advance').first();
      if ((await ok.count()) > 0) await ok.click();
      quiet = 0;
    } else {
      quiet++;
    }
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: path.join(outDir, 'play-translated.png') });

  const endTurn = await page.$eval('.turn-actions button', (e) => e.textContent?.trim());
  check('End Turn button is translated', endTurn === tr('lib', 'End Turn'), `${endTurn} (expect ${tr('lib', 'End Turn')})`);

  await page.click('.menu-button >> nth=0');
  const entries = await page.$$eval('.dropdown .entry-label', (els) => els.map((e) => e.textContent?.trim()));
  check('menu: Save Game... is translated', entries[0] === `${tr('lib', 'Save Game')}...`, `${entries[0]}`);
  check('menu: Load Game... is translated', entries[1] === `${tr('lib', 'Load Game')}...`, `${entries[1]}`);
  await page.screenshot({ path: path.join(outDir, 'menu-translated.png') });
  await page.keyboard.press('Escape');

  // ---- a selected unit in the side panel ---------------------------------------
  // Cycle through the side's units to one whose type name the catalogue translates (units not in the
  // catalogue -- Merman Citizen, in Polish -- correctly stay English, which is checked too).
  await setLanguage(page, 'en_US');
  let typeEn = null;
  let expectedType = null;
  const seen = [];
  for (let i = 0; i < 12; i++) {
    console.log('  cycling unit', i);
    await page.keyboard.press('n');
    await page.waitForTimeout(400);
    const sub = await page.$eval('.unit-info .sub', (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).catch(() => null);
    const type = sub?.match(/^Level \d+ (.+?) ·/)?.[1];
    if (!type) continue;
    seen.push(type);
    const t = tr('units', type) ?? tr('units', `female^${type}`) ?? tr('dw', type) ?? tr('dw', `female^${type}`);
    if (t) {
      typeEn = type;
      expectedType = t;
      break;
    }
  }
  check('side panel shows selected units (English first)', seen.length > 0, seen.join(', '));
  check('found a unit whose type the catalogue translates', !!typeEn, `tried ${seen.join(', ')}`);
  if (typeEn) {
    await setLanguage(page, lang);
    const subPl = await page.$eval('.unit-info .sub', (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).catch(() => null);
    check('the unit type name is the catalogue translation', !!subPl?.includes(expectedType), `${subPl} (expect ${expectedType})`);
    await page.screenshot({ path: path.join(outDir, 'unit-translated.png') });
  }

  // ---- the objectives dialog, open across a switch ---------------------------------
  await setLanguage(page, 'en_US');
  await page.click('.menu-button >> nth=1');
  await page.getByRole('button', { name: /^Objectives/ }).click();
  await page.waitForSelector('.modal-box');
  const labelEn = await page.$eval('.section-label', (e) => e.textContent?.trim());
  const itemEn = await page.$eval('.modal-box li', (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
  check('objectives (English): default label is upstream\'s', labelEn === 'Victory:', labelEn);
  await setLanguage(page, lang);
  const labelPl = await page.$eval('.section-label', (e) => e.textContent?.trim());
  const itemPl = await page.$eval('.modal-box li', (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
  check('the open objectives dialog: label is translated', labelPl === tr('wesnoth', 'Victory:'), `${labelPl} (expect ${tr('wesnoth', 'Victory:')})`);
  const expectedItem = tr('dw', itemEn);
  check('...and its objective text', !!expectedItem && itemPl === norm(expectedItem), `${itemPl} (expect ${expectedItem})`);
  await page.screenshot({ path: path.join(outDir, 'objectives-translated.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(OK|Ok|.*)$/ }).first().press('Escape').catch(() => {});

  check('the page never reloaded', (await page.evaluate(() => window.__i18nMarker)) === 'still here');
  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} step(s) failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nlive language switch to ${lang} and back: every step passed`);
}
