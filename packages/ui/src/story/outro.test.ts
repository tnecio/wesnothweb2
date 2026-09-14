import { describe, expect, it } from 'vitest';
import { buildOutroScreens, outroHoldMs } from './outro.js';

const campaign = {
  name: 'Dead Water',
  credits: [
    { title: 'Campaign design', names: ['Dan Gerhards'] },
    { title: 'Empty section', names: [] },
    { title: 'Artwork', names: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] },
  ],
};

describe('buildOutroScreens (outro.cpp)', () => {
  it('shows "The End" by default and nothing else without credits', () => {
    expect(buildOutroScreens(undefined, false, campaign)).toEqual([{ lines: [{ text: 'The End', size: 'normal' }] }]);
    expect(buildOutroScreens('', true, undefined)).toEqual([{ lines: [{ text: 'The End', size: 'normal' }] }]);
  });

  it('rolls the campaign name and credits in chunks of 5, titles on the first chunk, empty sections dropped', () => {
    const screens = buildOutroScreens('Kai Krellis led his people to safety.', true, campaign);
    expect(screens.map((s) => s.lines.map((l) => `${l.size}:${l.text}`))).toEqual([
      ['normal:Kai Krellis led his people to safety.'],
      ['large:Dead Water'],
      ['normal:Campaign design', 'small:Dan Gerhards'],
      ['normal:Artwork', 'small:A', 'small:B', 'small:C', 'small:D', 'small:E'],
      ['small:F', 'small:G'],
    ]);
  });
});

describe('outroHoldMs', () => {
  it('defaults 0/absent to 3500 ms', () => {
    expect(outroHoldMs(undefined)).toBe(3500);
    expect(outroHoldMs(0)).toBe(3500);
    expect(outroHoldMs(1200)).toBe(1200);
  });
});
