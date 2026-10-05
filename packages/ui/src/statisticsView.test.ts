import { describe, expect, it } from 'vitest';
import { actualAndExpected, damageString, probabilityString, tally } from './statisticsView.js';

describe('statistics dialog figures (statistics_dialog.cpp)', () => {
  it('write_actual_and_expected', () => {
    expect(actualAndExpected(0, 0)).toBe('+0% (0 + 0)');
    expect(actualAndExpected(30, 25)).toBe('+20% (25 + 5)');
    expect(actualAndExpected(20, 25)).toBe('-20% (25 − 5)');
    expect(actualAndExpected(4, 3.5)).toBe('+14% (3.5 + 1)');
  });

  it('damage: expected kept times 1000, shown to a tenth', () => {
    expect(damageString(16, 16000)).toBe('+0% (16 + 0)');
    expect(damageString(10, 12340)).toBe('-19% (12.3 − 2)');
  });

  it('get_probability_string', () => {
    expect(probabilityString(0.9996)).toBe('100');
    expect(probabilityString(0.5)).toBe('50.0');
    expect(probabilityString(0.12345)).toBe('12.3');
  });

  it('tally: two strikes at 50%, one hit, is exactly the median', () => {
    const cell = tally(new Map([[50, { strikes: 2, hits: 1 }]]), true);
    expect(cell.hitrate).toBe('+0% (1 + 0)');
    expect(cell.percentile).toBeCloseTo(0.5, 9);
    expect(cell.byCth).toEqual([{ cth: 50, rate: '50.0', strikes: 2 }]);
  });

  it('tally: every strike landing is lucky for the striker, unlucky for the one struck', () => {
    const byCth = new Map([
      [60, { strikes: 4, hits: 4 }],
      [40, { strikes: 3, hits: 3 }],
    ]);
    const inflicted = tally(byCth, true);
    // P(at most 7 of 7) = 1; P(fewer) = 1 - 0.6^4 * 0.4^3.
    const all = 0.6 ** 4 * 0.4 ** 3;
    expect(inflicted.percentile).toBeCloseTo((1 - all + 1) / 2, 9);
    expect(tally(byCth, false).score).toBeCloseTo(1 - inflicted.percentile!, 9);
    expect(tally(new Map(), true).percentile).toBeNull();
  });
});
