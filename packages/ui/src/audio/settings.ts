/**
 * The player's audio preferences (upstream's `prefs`: `music_on`,
 * `sound_on`, `UI_sound_on`, `turn_bell`, the four volumes, and
 * `stop_music_in_background`) plus a mute switch. Kept per browser.
 */
export interface AudioSettings {
  musicOn: boolean;
  soundOn: boolean;
  uiOn: boolean;
  bellOn: boolean;
  /** 0-100 each. */
  musicVolume: number;
  soundVolume: number;
  uiVolume: number;
  bellVolume: number;
  /** Everything silent, keeping the individual settings. */
  muted: boolean;
  /** Pause the music while the window is hidden (upstream's default). */
  stopInBackground: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = {
  musicOn: true,
  soundOn: true,
  uiOn: true,
  bellOn: true,
  musicVolume: 100,
  soundVolume: 100,
  uiVolume: 100,
  bellVolume: 100,
  muted: false,
  stopInBackground: true,
};

export const AUDIO_SETTINGS_KEY = 'wesnothweb2.audio';

function clampVolume(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : fallback;
}

function flag(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Reads what `saveAudioSettings` wrote; anything missing or malformed takes its default. */
export function parseAudioSettings(raw: string | null | undefined): AudioSettings {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: the defaults.
  }
  const d = DEFAULT_AUDIO_SETTINGS;
  return {
    musicOn: flag(data['musicOn'], d.musicOn),
    soundOn: flag(data['soundOn'], d.soundOn),
    uiOn: flag(data['uiOn'], d.uiOn),
    bellOn: flag(data['bellOn'], d.bellOn),
    musicVolume: clampVolume(data['musicVolume'], d.musicVolume),
    soundVolume: clampVolume(data['soundVolume'], d.soundVolume),
    uiVolume: clampVolume(data['uiVolume'], d.uiVolume),
    bellVolume: clampVolume(data['bellVolume'], d.bellVolume),
    muted: flag(data['muted'], d.muted),
    stopInBackground: flag(data['stopInBackground'], d.stopInBackground),
  };
}

export function loadAudioSettings(): AudioSettings {
  try {
    return parseAudioSettings(localStorage.getItem(AUDIO_SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

export function saveAudioSettings(settings: AudioSettings): void {
  try {
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: the settings last for this page only.
  }
}

/** What a scenario's `[volume]` says: percent of the player's own setting. */
export interface VolumeScale {
  music: number;
  sound: number;
}

export interface BusGains {
  master: number;
  music: number;
  sound: number;
  ui: number;
  bell: number;
}

/** The gain each bus should have: 0 for a switched-off or muted category, else volume x scale. */
export function busGains(settings: AudioSettings, scale: VolumeScale = { music: 100, sound: 100 }): BusGains {
  const level = (on: boolean, volume: number, percent = 100): number => (on ? (volume / 100) * (percent / 100) : 0);
  return {
    master: settings.muted ? 0 : 1,
    music: level(settings.musicOn, settings.musicVolume, scale.music),
    sound: level(settings.soundOn, settings.soundVolume, scale.sound),
    ui: level(settings.uiOn, settings.uiVolume),
    bell: level(settings.bellOn, settings.bellVolume),
  };
}
