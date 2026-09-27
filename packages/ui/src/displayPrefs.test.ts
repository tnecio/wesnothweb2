import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_PREFS, parseDisplayPrefs } from './displayPrefs.js';

describe('parseDisplayPrefs', () => {
  it('gives upstream\'s defaults for nothing, garbage, or the wrong shape', () => {
    expect(parseDisplayPrefs(null)).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs('{not json')).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs('[1,2]')).toEqual(DEFAULT_DISPLAY_PREFS);
  });

  it('clamps scroll speed to 1..100, as prefs::scroll_speed', () => {
    expect(parseDisplayPrefs('{"scrollSpeed": 0}').scrollSpeed).toBe(1);
    expect(parseDisplayPrefs('{"scrollSpeed": 250}').scrollSpeed).toBe(100);
    expect(parseDisplayPrefs('{"scrollSpeed": "fast"}').scrollSpeed).toBe(50);
  });

  it('keeps what was saved and fills in the rest', () => {
    const p = parseDisplayPrefs('{"grid": true, "zoom": 144, "minimap": {"drawUnits": false}}');
    expect(p.grid).toBe(true);
    expect(p.zoom).toBe(144);
    expect(p.minimap).toEqual({ ...DEFAULT_DISPLAY_PREFS.minimap, drawUnits: false });
    expect(p.mouseScrolling).toBe(true);
  });
});
