import { describe, expect, it } from 'vitest';
import { audioUrl } from './audioPaths.js';
import { GAME_IMAGES } from '../gameData.js';

describe("audioUrl: the campaign's binary paths, then core", () => {
  it('finds a sound in a resource the campaign includes (TSG and TDG include internal/Weather)', () => {
    expect(audioUrl('sounds', 'weather-rain.ogg', 'The_South_Guard')).toBe(`${GAME_IMAGES}/internal/Weather/sounds/weather-rain.ogg`);
    expect(audioUrl('sounds', 'weather-rain.ogg', 'Dead_Water')).toBeNull();
  });

  it('falls back to core for a file no binary path of the campaign has', () => {
    expect(audioUrl('music', 'heroes_rite.ogg', 'Heir_To_The_Throne')).toBe(`${GAME_IMAGES}/core/music/heroes_rite.ogg`);
  });
});
