/**
 * The app's one audio engine: a Web Audio context with a gain bus per
 * category (music, sound effects, UI sounds, the turn bell) under a master
 * gain, the player's settings, and the music player following the app's
 * playlist. Nothing here runs until the first user gesture *and* the board
 * being ready (browsers refuse autoplay, and music must not compete with the
 * board's images for bandwidth at startup).
 *
 * Everything it starts, fades and stops goes into `log`, also reachable as
 * `window.__audio` -- what a headless browser check reads, since it cannot
 * hear anything.
 */
import { MusicList, type SoundRequest, type SoundSourceSpec } from '@wesnothweb2/engine';
import { squareParentheticalSplit } from '@wesnothweb2/renderer/src/animation/frame.js';
import { audioExists, audioUrl } from './audioPaths.js';
import { MusicPlayer } from './musicPlayer.js';
import { busGains, loadAudioSettings, saveAudioSettings, type AudioSettings, type BusGains, type VolumeScale } from './settings.js';
import { SoundPlayer } from './soundEffects.js';
import { SoundSourceManager, type SourceHost } from './soundSources.js';
import { WebAudioMusicBackend } from './webAudioMusic.js';
import { WebAudioSoundBackend } from './webAudioSounds.js';

export interface AudioLogEntry {
  /** Milliseconds since the engine was made. */
  t: number;
  /** Wall-clock time (`Date.now()`), to line entries up with other measurements. */
  at: number;
  event: string;
  detail?: Record<string, unknown>;
}

const LOG_LIMIT = 500;
const SYNC_INTERVAL_MS = 250;
const SOURCE_INTERVAL_MS = 150;
/** Time constant of a gain change: quick enough to feel immediate, slow enough not to click. */
const GAIN_SMOOTHING = 0.015;

export class AudioEngine {
  /** The playlist every scenario's session shares (upstream's global `current_track_list`). */
  readonly music: MusicList = new MusicList({
    random: (max) => Math.floor(Math.random() * (max + 1)),
    exists: (id) => audioExists('music', id),
  });
  readonly log: AudioLogEntry[] = [];
  volumeScale: VolumeScale = { music: 100, sound: 100 };
  /** The running campaign's wesnoth id, so its own music is found before core's. */
  campaign: string | undefined;

  private settingsValue: AudioSettings = loadAudioSettings();
  private readonly startedAt = Date.now();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: { music: GainNode; sound: GainNode; ui: GainNode; bell: GainNode } | null = null;
  private player: MusicPlayer | null = null;
  private effects: SoundPlayer | null = null;
  private sources: SoundSourceManager | null = null;
  private sourceHost: SourceHost | null = null;
  private sourceSpecs: readonly SoundSourceSpec[] = [];
  private sourceTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPreload: string[] = [];
  private backend: WebAudioMusicBackend | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private boardReady = false;
  private targets: BusGains = busGains(this.settingsValue);

  get settings(): Readonly<AudioSettings> {
    return this.settingsValue;
  }

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  private record(event: string, detail?: Record<string, unknown>): void {
    this.log.push({ t: Date.now() - this.startedAt, at: Date.now(), event, ...(detail ? { detail } : {}) });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  /** What each bus is currently set to (the target of its last change). */
  state(): { unlocked: boolean; ready: boolean; gains: BusGains; settings: AudioSettings; playing: string | null } {
    return {
      unlocked: this.unlocked,
      ready: this.boardReady,
      gains: this.targets,
      settings: { ...this.settingsValue },
      playing: this.music.current?.id ?? null,
    };
  }

  /** Changes settings, applies them to the buses at once and remembers them. */
  updateSettings(patch: Partial<AudioSettings>): void {
    const before = this.settingsValue;
    this.settingsValue = { ...before, ...patch };
    // Upstream: the player's own slider sets the mixer volume outright, ending any `[volume]` scale on it.
    if (patch.musicVolume !== undefined) this.volumeScale = { ...this.volumeScale, music: 100 };
    if (patch.soundVolume !== undefined) this.volumeScale = { ...this.volumeScale, sound: 100 };
    saveAudioSettings(this.settingsValue);
    this.applyGains();
    if (patch.musicOn !== undefined && patch.musicOn !== before.musicOn) this.player?.setMusicOn(patch.musicOn);
    if (patch.stopInBackground === false) this.player?.setBackgrounded(false);
    this.record('settings', { ...patch });
  }

  /** The game's sound sources (`GameSession.soundSources`) and where the view is; they play once the audio is unlocked. */
  setSoundSources(specs: readonly SoundSourceSpec[]): void {
    this.sourceSpecs = specs;
    this.sources?.setSources(specs);
  }

  setSourceHost(host: SourceHost | null): void {
    this.sourceHost = host;
    this.startSources();
  }

  /** Silences every sound source (the game is being left). */
  stopSoundSources(): void {
    this.sourceSpecs = [];
    this.sources?.stopAll();
  }

  /** `sound::stop_sound(id)`: silences what a sound source (or the story's voice) is playing. */
  stopSource(sourceId: string): void {
    this.effects?.stopSource(sourceId);
  }

  private startSources(): void {
    if (this.sources || !this.effects || !this.sourceHost) return;
    const effects = this.effects;
    this.sources = new SoundSourceManager(
      {
        play: (request) => this.playSound(request),
        stopSource: (id) => effects.stopSource(id),
        isSourcePlaying: (id) => effects.isSourcePlaying(id),
        setSourceVolume: (id, volume) => effects.setSourceVolume(id, volume),
      },
      { viewCenter: () => this.sourceHost?.viewCenter() ?? null, isFogged: (x, y) => this.sourceHost?.isFogged(x, y) ?? false, isShrouded: (x, y) => this.sourceHost?.isShrouded(x, y) ?? false },
    );
    this.sources.setSources(this.sourceSpecs);
    this.sourceTimer = setInterval(() => this.sources?.tick(), SOURCE_INTERVAL_MS);
  }

  /** `[volume]`: the scenario's percentages of the player's own volumes. */
  setVolumeScale(scale: Partial<VolumeScale>): void {
    this.volumeScale = { ...this.volumeScale, ...scale };
    this.applyGains();
    this.record('volume-scale', { ...this.volumeScale });
  }

  private applyGains(): void {
    this.targets = busGains(this.settingsValue, this.volumeScale);
    if (!this.ctx || !this.master || !this.buses) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.targets.master, now, GAIN_SMOOTHING);
    for (const name of ['music', 'sound', 'ui', 'bell'] as const) this.buses[name].gain.setTargetAtTime(this.targets[name], now, GAIN_SMOOTHING);
  }

  /** The board has rendered: audio may start (once a gesture has also happened). */
  setBoardReady(): void {
    if (this.boardReady) return;
    this.boardReady = true;
    this.startPlayer();
    this.flushPreload();
  }

  /** Whether the player wants this kind of sound at all (`prefs::sound()`, `ui_sound_on()`, `turn_bell()`). */
  private soundWanted(group: SoundRequest['group']): boolean {
    const s = this.settingsValue;
    if (group === 'ui') return s.uiOn;
    if (group === 'bell' || group === 'timer') return s.bellOn;
    return s.soundOn;
  }

  /** `sound::play_sound` and friends: a sound effect, dropped if the audio is not unlocked yet or the player has that kind off. */
  playSound(request: SoundRequest): void {
    if (!this.effects || !this.soundWanted(request.group)) return;
    this.effects.play(request);
  }

  /** `sound::play_UI_sound`. */
  playUi(file: string): void {
    this.playSound({ files: file, repeats: 0, group: 'ui' });
  }

  /**
   * Fetches and decodes sounds a scenario is likely to need, at low priority
   * once the board has rendered, so the first fight does not wait for them.
   */
  preloadSounds(files: readonly string[]): void {
    this.pendingPreload.push(...files);
    this.flushPreload();
  }

  private flushPreload(): void {
    if (!this.effects || !this.boardReady || this.pendingPreload.length === 0) return;
    this.effects.preload(this.pendingPreload.splice(0));
  }

  /** A user gesture: browsers allow audio from here on. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.record('unsupported');
      return;
    }
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const bus = (): GainNode => {
      const node = ctx.createGain();
      node.connect(this.master!);
      return node;
    };
    this.buses = { music: bus(), sound: bus(), ui: bus(), bell: bus() };
    this.applyGains();
    void ctx.resume();
    this.record('unlock', { state: ctx.state });
    this.effects = new SoundPlayer({
      backend: new WebAudioSoundBackend(ctx, { sound: this.buses.sound, sources: this.buses.sound, ui: this.buses.ui, bell: this.buses.bell, timer: this.buses.bell }),
      split: squareParentheticalSplit,
      urlFor: (file) => audioUrl('sounds', file, this.campaign),
      log: (event, detail) => this.record(`sound-${event}`, detail),
    });
    this.startPlayer();
    this.startSources();
    this.flushPreload();
  }

  /** For browser checks: jumps the playing track to `secondsBeforeEnd` from its end, to see the transition without waiting minutes. */
  debugSeekNearEnd(secondsBeforeEnd: number): boolean {
    return this.backend?.seekNearEnd(secondsBeforeEnd) ?? false;
  }

  private startPlayer(): void {
    if (!this.ctx || !this.buses || !this.boardReady || this.player) return;
    const backend = new WebAudioMusicBackend(this.ctx, this.buses.music);
    this.backend = backend;
    this.player = new MusicPlayer(this.music, backend, (id) => audioUrl('music', id, this.campaign), (event, detail) => this.record(event, detail));
    if (!this.settingsValue.musicOn) this.player.setMusicOn(false);
    document.addEventListener('visibilitychange', () => this.player?.setBackgrounded(document.hidden && this.settingsValue.stopInBackground));
    this.timer = setInterval(() => this.player?.sync(), SYNC_INTERVAL_MS);
    this.player.unlock();
  }
}

let engine: AudioEngine | null = null;

/** The app's audio engine, made on first use. */
export function getAudioEngine(): AudioEngine {
  if (!engine) {
    engine = new AudioEngine();
    if (typeof window !== 'undefined') (window as unknown as { __audio: unknown }).__audio = {
        log: engine.log,
        state: () => engine!.state(),
        seekNearEnd: (seconds: number) => engine!.debugSeekNearEnd(seconds),
        playSound: (files: string, group: SoundRequest['group'] = 'sound') => engine!.playSound({ files, repeats: 0, group }),
      };
  }
  return engine;
}
