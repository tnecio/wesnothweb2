import { describe, expect, it } from 'vitest';
import { shuffled, stepTip } from './tips.js';

describe('tips', () => {
  it('steps and wraps as update_tip does', () => {
    expect(stepTip(0, 3, false)).toBe(1);
    expect(stepTip(2, 3, false)).toBe(0);
    expect(stepTip(0, 3, true)).toBe(2);
    expect(stepTip(1, 3, true)).toBe(0);
    expect(stepTip(0, 0, false)).toBe(0);
  });
  it('shuffles without losing or duplicating a tip, and does not change the source', () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffled(src, (() => { let i = 0; return () => [0.9, 0.1, 0.5, 0.3, 0.7, 0.2, 0.8][i++ % 7]!; })());
    expect([...out].sort()).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(out).not.toEqual(src);
  });
});
