import { describe, expect, it } from 'vitest';
import { splitTodTintColors } from '../src/todTint.js';

describe('splitTodTintColors', () => {
  it('a neutral tod (0,0,0) is a no-op on both layers', () => {
    expect(splitTodTintColors({ red: 0, green: 0, blue: 0 })).toEqual({ positive: 0x000000, negative: 0x000000 });
  });

  it('a purely positive shift (e.g. midday +25/+25/0) goes entirely to the positive layer', () => {
    expect(splitTodTintColors({ red: 25, green: 25, blue: 0 })).toEqual({ positive: 0x191900, negative: 0x000000 });
  });

  it('a purely negative shift (e.g. a dark schedule -60/-45/-25) goes entirely to the negative layer, as its absolute value', () => {
    expect(splitTodTintColors({ red: -60, green: -45, blue: -25 })).toEqual({ positive: 0x000000, negative: 0x3c2d19 });
  });

  it('mixed-sign channels split correctly, each landing on its own layer', () => {
    // red positive, green negative, blue zero.
    const { positive, negative } = splitTodTintColors({ red: 10, green: -20, blue: 0 });
    expect(positive).toBe(0x0a0000); // red=10 only.
    expect(negative).toBe(0x001400); // green=20 (abs of -20) only.
  });

  it('clamps out-of-range channel values to a valid byte', () => {
    expect(splitTodTintColors({ red: 999, green: -999, blue: 0 })).toEqual({ positive: 0xff0000, negative: 0x00ff00 });
  });
});
