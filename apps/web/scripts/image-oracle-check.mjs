/**
 * Phase 27c S1: the browser image pipeline (`ImageCache`, worker compositor and all) against the C++ engine.
 *
 *   node apps/web/scripts/image-oracle-check.mjs [--base http://localhost:5173] [--limit N] [--match text]
 *
 * Takes the image golden corpus (`packages/renderer/fixtures/imagecache-golden.json`: every image Dead Water 1,
 * Liberty 1 and a combat draw), keeps the references the oracle can render -- not the compositor's own
 * pseudo-ops (`~GLOBAL`, `~TOD`), not `~TC`/`~RC` (the oracle loads no colour data), not engine images -- and
 * adds every reference of the image path function test (`packages/renderer/fixtures/image-oracle/refs.txt`) and
 * renders them with `wl-image-oracle` (`~HEXED()` refs with `--type hexed`, the rest `--type unscaled`). Then
 * resolves each in headless Chromium against a running dev server and compares the pixels.
 *
 * A canvas stores premultiplied colour, so a translucent pixel read back can be off by the rounding of that
 * round trip: colour is compared premultiplied, within 1; alpha must be exact.
 *
 * Needs the oracle binary (`packages/oracle-tools/README.md`); exits non-zero on any mismatch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { openScenario, waitBoardReady } from './lib/browserFlows.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5173');
const limit = Number(arg('limit', '0')) || Infinity;
const match = arg('match', '');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const oracle = arg('oracle', path.join(repoRoot, 'wesnoth/build-oracle/wl-image-oracle'));
const fallbackOracle = '/home/tom/wesnothweb2/wesnoth/build-oracle/wl-image-oracle';
const oracleBin = fs.existsSync(oracle) ? oracle : fallbackOracle;
if (!fs.existsSync(oracleBin)) {
  console.error(`no oracle binary at ${oracle} (see packages/oracle-tools/README.md)`);
  process.exit(2);
}

const golden = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/renderer/fixtures/imagecache-golden.json'), 'utf8')).refs;
const usable = (ref) => !/~(GLOBAL|TOD|TC|RC)\(/.test(ref) && !/^(engine|core|campaigns)\//.test(ref) && (!match || ref.includes(match));
// ...plus every image path function, from the oracle unit test's own list (all unscaled).
const functionRefs = fs.readFileSync(path.join(repoRoot, 'packages/renderer/fixtures/image-oracle/refs.txt'), 'utf8').split('\n').filter(Boolean);
const refs = [...new Set([...Object.keys(golden), ...functionRefs])].filter(usable).slice(0, limit);
const hexed = refs.filter((r) => r.endsWith('~HEXED()'));
const unscaled = refs.filter((r) => !r.endsWith('~HEXED()') && !r.includes('~HEXED()'));

/** Oracle output per ref: `{ width, height, data }` straight RGBA, or null. */
function runOracle(list, type) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `image-oracle-${type}-`));
  const input = list.map((r) => (type === 'hexed' ? r.slice(0, -'~HEXED()'.length) : r)).join('\n');
  execFileSync(oracleBin, ['--data', path.join(repoRoot, 'wesnoth/data'), '--out', out, '--type', type], { input, stdio: ['pipe', 'ignore', 'ignore'] });
  const rows = fs.readFileSync(path.join(out, 'manifest.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'));
  const result = new Map();
  for (const [index, status, , , file] of rows) {
    const ref = list[Number(index)];
    result.set(ref, status === 'OK' ? PNG.sync.read(fs.readFileSync(path.join(out, file))) : null);
  }
  fs.rmSync(out, { recursive: true, force: true });
  return result;
}

const expected = new Map([...runOracle(hexed, 'hexed'), ...runOracle(unscaled, 'unscaled')]);
const checked = [...expected.keys()].filter((r) => expected.get(r));
console.log(`${checked.length} refs rendered by the oracle (${hexed.length} hexed, ${unscaled.length} unscaled)`);

/** Runs in the page: each ref's pixels (RGBA, base64) as the board would get them. */
const pixelsInPage = async (batch) => {
  const cache = window.__wesnothDebug.imageCache;
  const textures = await Promise.all(batch.map((ref) => cache.resolveRefForTest(ref)));
  return batch.map((ref, i) => {
    const source = textures[i]?.source?.resource;
    if (!source) return null;
    const canvas = new OffscreenCanvas(source.width, source.height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0);
    const data = g.getImageData(0, 0, source.width, source.height).data;
    let s = '';
    for (let k = 0; k < data.length; k += 0x8000) s += String.fromCharCode(...data.subarray(k, k + 0x8000));
    return { width: source.width, height: source.height, data: btoa(s) };
  });
};

const browser = await chromium.launch();
const failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await openScenario(page, base, 'synthetic_combat', undefined);
  await waitBoardReady(page);
  await page.evaluate(() => window.__wesnothDebug.setRenderingPaused?.(true));
  for (let i = 0; i < checked.length; i += 100) {
    const batch = checked.slice(i, i + 100);
    const got = await page.evaluate(pixelsInPage, batch);
    batch.forEach((ref, j) => {
      const want = expected.get(ref);
      const have = got[j];
      if (!have) return failures.push({ ref, why: 'not resolved' });
      if (have.width !== want.width || have.height !== want.height) {
        return failures.push({ ref, why: `size ${have.width}x${have.height}, oracle ${want.width}x${want.height}` });
      }
      const data = Buffer.from(have.data, 'base64');
      let alpha = 0;
      let color = 0;
      let bad = 0;
      for (let k = 0; k < data.length; k += 4) {
        const a = want.data[k + 3];
        const da = Math.abs(data[k + 3] - a);
        let dc = 0;
        for (let c = 0; c < 3; c++) dc = Math.max(dc, Math.abs(Math.round((data[k + c] * a) / 255) - Math.round((want.data[k + c] * a) / 255)));
        alpha = Math.max(alpha, da);
        color = Math.max(color, dc);
        if (da > 0 || dc > 1) bad++;
      }
      if (bad > 0) failures.push({ ref, why: `${bad} pixels differ (alpha by up to ${alpha}, premultiplied colour by up to ${color})` });
    });
    process.stdout.write(`\r${Math.min(i + 100, checked.length)}/${checked.length}`);
  }
  process.stdout.write('\n');
  await context.close();
} finally {
  await browser.close();
}

for (const f of failures.slice(0, 30)) console.log(`DIFF ${f.ref}\n  ${f.why}`);
console.log(`${checked.length - failures.length}/${checked.length} refs match the oracle`);
if (failures.length > 0) process.exitCode = 1;
