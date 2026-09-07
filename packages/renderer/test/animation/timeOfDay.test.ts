import { describe, expect, it } from 'vitest';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { applyTodTint, NEUTRAL_TOD_COLOR, todColorFromTimeConfig } from '../../src/animation/timeOfDay.js';

describe('todColorFromTimeConfig (time_of_day ctor port, time_of_day.cpp ~L28-36)', () => {
  it('reads red=/green=/blue= verbatim', () => {
    const cfg = new WmlConfig();
    cfg.setAttribute('red', -50);
    cfg.setAttribute('green', -25);
    cfg.setAttribute('blue', 20);
    expect(todColorFromTimeConfig(cfg)).toEqual({ r: -50, g: -25, b: 20 });
  });

  it('defaults every channel to 0 (matches Underground/Indoors real [time] blocks with no explicit red=/green=/blue=)', () => {
    expect(todColorFromTimeConfig(new WmlConfig())).toEqual(NEUTRAL_TOD_COLOR);
  });
});

describe('applyTodTint (adjust_surface_color port, sdl/utils.cpp ~L406-421)', () => {
  it('adds the tint to each RGB channel and clamps to [0,255], leaving alpha untouched', () => {
    const data = new Uint8ClampedArray([10, 20, 250, 128]);
    applyTodTint(data, { r: 50, g: -30, b: 30 });
    expect([...data]).toEqual([60, 0, 255, 128]);
  });

  it('is a no-op for a neutral (0,0,0) tint, even over multiple pixels', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 255, 250, 250, 250, 0]);
    applyTodTint(data, NEUTRAL_TOD_COLOR);
    expect([...data]).toEqual([1, 2, 3, 255, 250, 250, 250, 0]);
  });

  it('applies independently across multiple pixels', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 200, 200, 200, 255]);
    applyTodTint(data, { r: 10, g: 10, b: 10 });
    expect([...data]).toEqual([10, 10, 10, 255, 210, 210, 210, 255]);
  });
});
