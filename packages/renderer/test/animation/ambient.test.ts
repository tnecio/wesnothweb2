import { describe, expect, it } from 'vitest';
import { nextIdleTick } from '../../src/animation/ambient.js';

describe('nextIdleTick (get_next_idle_tick)', () => {
  const prefs = { standing: true, idle: true, idleRate: 0 };

  it('is 20 to 40 seconds away at the default rate', () => {
    expect(nextIdleTick(1000, prefs, () => 0)).toBe(21000);
    expect(nextIdleTick(1000, prefs, () => 0.99999)).toBe(1000 + 39999);
  });

  it('scales by 2^(-rate/10): rate 10 halves it, rate -10 doubles it', () => {
    expect(nextIdleTick(0, { ...prefs, idleRate: 10 }, () => 0)).toBe(10000);
    expect(nextIdleTick(0, { ...prefs, idleRate: -10 }, () => 0)).toBe(40000);
  });

  it('never comes without idle animations', () => {
    expect(nextIdleTick(0, { ...prefs, idle: false })).toBe(Infinity);
  });
});
