import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_PREFS, parseDisplayPrefs, turboSpeed } from './displayPrefs.js';

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

  it('Phase 23: the phone layout opens the top bar and infobox unless they were collapsed', () => {
    expect(parseDisplayPrefs(null)).toMatchObject({ topBarCollapsed: false, infoboxCollapsed: false });
    expect(parseDisplayPrefs('{"infoboxCollapsed": true, "topBarCollapsed": "yes"}')).toMatchObject({ topBarCollapsed: false, infoboxCollapsed: true });
  });

  it("Phase 28b: automatic moves are on unless disabled (upstream's disable_auto_moves, off)", () => {
    expect(parseDisplayPrefs(null).disableAutoMoves).toBe(false);
    expect(parseDisplayPrefs('{"disableAutoMoves": true}').disableAutoMoves).toBe(true);
  });

  it("Phase 24: upstream's defaults, and Accelerated speed only at one of the slider's steps", () => {
    expect(parseDisplayPrefs(null)).toMatchObject({
      turbo: false,
      turboSpeed: 2,
      skipAiMoves: false,
      turnDialog: false,
      saveReplays: true,
      deleteSaves: false,
      floatingLabels: true,
      showSideColors: true,
      animateMap: true,
      animateWater: true,
      showCombat: true,
      askDelete: true,
      showAttackMissIndicator: false,
      monteCarlo: true,
    });
    expect(parseDisplayPrefs('{"turboSpeed": 8}').turboSpeed).toBe(8);
    expect(parseDisplayPrefs('{"turboSpeed": 7}').turboSpeed).toBe(2);
  });

  it('display::turbo_speed: the chosen speed while Accelerated speed is on, else 1', () => {
    expect(turboSpeed({ ...DEFAULT_DISPLAY_PREFS, turboSpeed: 4 })).toBe(1);
    expect(turboSpeed({ ...DEFAULT_DISPLAY_PREFS, turbo: true, turboSpeed: 4 })).toBe(4);
  });
});
