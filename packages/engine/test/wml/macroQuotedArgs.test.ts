import { describe, expect, it } from 'vitest';
import { parseWml } from '../../src/wml/index.js';

/**
 * Verified against the real engine (`wesnoth --preprocess` on the same
 * source): a macro argument that is one quoted string is bound without its
 * quotes. Real content relies on it -- `WATER_342_180_TILE_VARIANTS "" ... ""`
 * (new-macros.cfg) substitutes two empty args back-to-back into
 * `...~CROP(0,0,72,72){MASKIPF}{IPF}:{DURATION}`; keeping the quotes gave
 * `""""`, which tokenizes to one literal `"` and broke every water tile.
 */
describe('quoted macro arguments', () => {
  const inner = (body: string) => `#define INNER A B\nname=${body}\n#enddef\n`;

  it('two adjacent "" args contribute nothing (matches wesnoth --preprocess)', () => {
    const cfg = parseWml(inner('x~CROP(0,0){A}{B}:1') + '[a]\n{INNER "" ""}\n[/a]', { dir: '/tmp' });
    expect(cfg.child('a')!.getString('name')).toBe('x~CROP(0,0):1');
  });

  it('the same through a nested macro body', () => {
    const src = inner('x{A}{B}:1') + '#define OUTER\n{INNER "" ""}\n#enddef\n[a]\n{OUTER}\n[/a]';
    expect(parseWml(src, { dir: '/tmp' }).child('a')!.getString('name')).toBe('x:1');
  });

  it('a multi-line quoted arg stays one quoted string (real units.cfg passes "~CHAN(\\n...)" this way)', () => {
    const src = '#define M I P\nimage={I}{P}\n#enddef\n[a]\n{M horse.png "~CHAN(\n  red,\n  green)"}\n[/a]';
    expect(parseWml(src, { dir: '/tmp' }).child('a')!.getString('image')).toBe('horse.png~CHAN(\n  red,\n  green)');
  });

  it('an escaped "" inside a quoted arg survives to the tokenizer', () => {
    const src = '#define M T\nv={T}\n#enddef\n[a]\n{M "say ""hi"" now"}\n[/a]';
    expect(parseWml(src, { dir: '/tmp' }).child('a')!.getString('v')).toBe('say "hi" now');
  });
});
