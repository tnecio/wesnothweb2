import { describe, expect, it } from 'vitest';
import {
  AccessibilityManager,
  DEFAULT_ORB_COLORS,
  clampFontScale,
  parseAccessibility,
  type AccessibilityHost,
  type OrbStatus,
} from './accessibility';

function fakeHost(saved: string | null = null): { host: AccessibilityHost; rec: { saved: string | null; scale: number | null; orbs: Record<OrbStatus, string> | null } } {
  const rec = { saved, scale: null as number | null, orbs: null as Record<OrbStatus, string> | null };
  return {
    rec,
    host: {
      load: () => rec.saved,
      save: (raw) => (rec.saved = raw),
      applyFontScale: (s) => (rec.scale = s),
      applyOrbColors: (c) => (rec.orbs = { ...c }),
    },
  };
}

describe('clampFontScale', () => {
  it('keeps upstream\'s 80-150 range, in steps of 5', () => {
    expect(clampFontScale(100)).toBe(100);
    expect(clampFontScale(10)).toBe(80);
    expect(clampFontScale(400)).toBe(150);
    expect(clampFontScale(112)).toBe(110);
    expect(clampFontScale('big')).toBe(100);
    expect(clampFontScale(Number.NaN)).toBe(100);
  });
});

describe('parseAccessibility', () => {
  it('defaults everything when nothing (or garbage) is saved', () => {
    expect(parseAccessibility(null)).toEqual({ fontScale: 100, orbColors: DEFAULT_ORB_COLORS });
    expect(parseAccessibility('{not json')).toEqual({ fontScale: 100, orbColors: DEFAULT_ORB_COLORS });
  });

  it('reads saved values, dropping unknown or malformed colours', () => {
    const raw = JSON.stringify({ fontScale: 125, orbColors: { unmoved: 'blue', partial: 'no such', moved: 42 } });
    expect(parseAccessibility(raw, new Set(['blue', 'red']))).toEqual({
      fontScale: 125,
      orbColors: { unmoved: 'blue', partial: 'brightorange', moved: 'red' },
    });
  });
});

describe('AccessibilityManager', () => {
  it('applies the saved settings at start, and remembers and applies a change', () => {
    const { host, rec } = fakeHost(JSON.stringify({ fontScale: 120 }));
    const m = new AccessibilityManager(host);
    m.init();
    expect(rec.scale).toBe(120);
    expect(rec.orbs).toEqual(DEFAULT_ORB_COLORS);
    m.update({ fontScale: 150, orbColors: { moved: 'purple' } });
    expect(rec.scale).toBe(150);
    expect(rec.orbs?.moved).toBe('purple');
    expect(JSON.parse(rec.saved!)).toEqual({ fontScale: 150, orbColors: { ...DEFAULT_ORB_COLORS, moved: 'purple' } });
    expect(m.current.fontScale).toBe(150);
  });

  it('clamps a scale outside the range', () => {
    const { host, rec } = fakeHost();
    const m = new AccessibilityManager(host);
    m.init();
    m.update({ fontScale: 1000 });
    expect(rec.scale).toBe(150);
  });
});
