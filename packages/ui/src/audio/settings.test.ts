import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIO_SETTINGS, busGains, parseAudioSettings } from './settings.js';

describe('parseAudioSettings', () => {
  it('reads what was saved and repairs the rest', () => {
    const s = parseAudioSettings(JSON.stringify({ musicVolume: 35, soundVolume: 999, uiOn: false, muted: 'yes', bellVolume: -4 }));
    expect(s.musicVolume).toBe(35);
    expect(s.soundVolume).toBe(100);
    expect(s.bellVolume).toBe(0);
    expect(s.uiOn).toBe(false);
    expect(s.muted).toBe(false);
  });

  it('falls back to the defaults for nothing or garbage', () => {
    expect(parseAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings('{not json')).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings('42')).toEqual(DEFAULT_AUDIO_SETTINGS);
  });
});

describe('busGains', () => {
  it('multiplies the volume by the scenario scale and zeroes what is switched off', () => {
    const s = { ...DEFAULT_AUDIO_SETTINGS, musicVolume: 50, soundOn: false };
    expect(busGains(s, { music: 50, sound: 100 })).toMatchObject({ master: 1, music: 0.25, sound: 0, ui: 1, bell: 1 });
  });

  it('mute drops the master to 0 and leaves the rest', () => {
    expect(busGains({ ...DEFAULT_AUDIO_SETTINGS, muted: true })).toMatchObject({ master: 0, music: 1 });
  });
});
