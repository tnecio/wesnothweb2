// node --test apps/web/scripts/lib/  (run by CI's lint job)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixWebpAlphaFlag, webpHidesAlpha } from './webpAlpha.mjs';

const portraits = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../wesnoth/data/campaigns/Heir_To_The_Throne/images/portraits');

test('Konrad\'s young portrait hides its transparency, and the fix sets only the header flag', () => {
  const bytes = fs.readFileSync(path.join(portraits, 'konrad-young.webp'));
  assert.equal(webpHidesAlpha(bytes), true);
  const fixed = fixWebpAlphaFlag(bytes);
  assert.equal(webpHidesAlpha(fixed), false);
  assert.equal(fixed.length, bytes.length);
  const changed = [...fixed].map((b, i) => (b !== bytes[i] ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(changed, [20]);
  assert.equal(fixed[20] & 0x10, 0x10);
});

test('a portrait whose header is right is left alone (the same buffer)', () => {
  const bytes = fs.readFileSync(path.join(portraits, 'konrad-human.webp'));
  assert.equal(webpHidesAlpha(bytes), false);
  assert.equal(fixWebpAlphaFlag(bytes), bytes);
});

test('anything that is not an extended WebP is left alone', () => {
  for (const bytes of [Buffer.from('not an image at all, just some text here'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]) {
    assert.equal(webpHidesAlpha(bytes), false);
    assert.equal(fixWebpAlphaFlag(bytes), bytes);
  }
});
