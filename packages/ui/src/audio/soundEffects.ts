/**
 * Sound effects -- the half of `sound.cpp` that is `play_sound_internal` and
 * its channel groups, over a backend (Web Audio in the browser, a fake in
 * tests):
 *
 * - `pick_one`: a comma list (`[a,b]`/`[1~3]` brackets expanded) plays one
 *   entry, never the same one twice running for the same list.
 * - Channels: SDL_mixer has 32; two are the bell and timer, 8 belong to
 *   sound sources, 2 to the UI, leaving 20 for effects. A sound with no
 *   free channel in its group is skipped, as upstream skips it.
 * - A sound whose data is not decoded yet is fetched at once and played when
 *   it arrives -- unless that is more than `LATE_MS` late, when a hit sound
 *   or a click is worse than none and it is dropped (it is cached for next
 *   time). Ambience and the bell are not timing-critical and play whenever.
 * - Preloading fetches at low priority, a couple at a time.
 */
import type { SoundGroup, SoundRequest } from '@wesnothweb2/engine';

/** SDL_mixer channels per group (`sound.cpp`: 32 in all; 2 bell/timer, 8 sources, 2 UI). */
export const CHANNELS: Readonly<Record<SoundGroup, number>> = { sound: 20, sources: 8, ui: 2, bell: 1, timer: 1 };
/** A sound that would start later than this after it was asked for is dropped. */
export const LATE_MS = 150;
const PRELOAD_CONCURRENCY = 2;
/** Groups whose sounds are tied to something on screen, and so are useless late. */
const TIMING_CRITICAL: Readonly<Record<SoundGroup, boolean>> = { sound: true, ui: true, sources: false, bell: false, timer: false };

export interface SoundBackend {
  /** Whether `url` is fetched and decoded. */
  ready(url: string): boolean;
  /** Fetches and decodes `url` (once); resolves whether it can now be played. */
  load(url: string, priority: 'high' | 'low'): Promise<boolean>;
  /** Starts it; `onEnded` is called when it has finished or been stopped. Returns a function that stops it. */
  start(url: string, group: SoundGroup, repeats: number, volume: number, onEnded: () => void): () => void;
}

export type SoundLogger = (event: string, detail?: Record<string, unknown>) => void;

export interface SoundPlayerOptions {
  backend: SoundBackend;
  /** `pick_one`'s split: a comma list with bracket expansion. */
  split: (files: string) => string[];
  /** A file's URL, or null if it does not exist. */
  urlFor: (file: string) => string | null;
  /** A uniform integer in [0, max]. */
  random?: (max: number) => number;
  now?: () => number;
  log?: SoundLogger;
}

export class SoundPlayer {
  private readonly active: Record<SoundGroup, number> = { sound: 0, sources: 0, ui: 0, bell: 0, timer: 0 };
  private readonly stoppers = new Map<string, Set<() => void>>();
  private readonly previousChoice = new Map<string, number>();
  private readonly missing = new Set<string>();
  private readonly preloadQueue: string[] = [];
  private preloading = 0;
  private readonly random: (max: number) => number;
  private readonly now: () => number;
  private readonly log: SoundLogger;

  constructor(private readonly options: SoundPlayerOptions) {
    this.random = options.random ?? ((max) => Math.floor(Math.random() * (max + 1)));
    this.now = options.now ?? (() => performance.now());
    this.log = options.log ?? (() => {});
  }

  /** `pick_one`: one entry of the list, avoiding the previous pick for the same list when there is a choice. */
  pickOne(files: string): string {
    const ids = this.options.split(files);
    if (ids.length === 0) return '';
    if (ids.length === 1) return ids[0]!;
    const previous = this.previousChoice.get(files);
    let choice: number;
    if (previous !== undefined) {
      choice = this.random(ids.length - 2);
      if (choice >= previous) choice++;
    } else {
      choice = this.random(ids.length - 1);
    }
    this.previousChoice.set(files, choice);
    return ids[choice]!;
  }

  /** `play_sound_internal`. */
  play(request: SoundRequest): void {
    const { group } = request;
    const file = this.pickOne(request.files);
    if (file === '') return;
    const url = this.options.urlFor(file);
    if (!url) {
      this.reportMissing(file);
      return;
    }
    if (this.active[group] >= CHANNELS[group]) {
      this.log('busy', { group, file });
      return;
    }
    const volume = (request.volume ?? 100) / 100;
    const start = (): void => this.start(url, file, request, volume);
    if (this.options.backend.ready(url)) {
      start();
      return;
    }
    // Held while it loads, so a burst of misses cannot overshoot the group's channels.
    this.active[group]++;
    const asked = this.now();
    void this.options.backend.load(url, 'high').then((ok) => {
      this.active[group]--;
      if (!ok) {
        this.reportMissing(file);
      } else if (TIMING_CRITICAL[group] && this.now() - asked > LATE_MS) {
        this.log('late', { file, ms: Math.round(this.now() - asked) });
      } else {
        start();
      }
    });
  }

  private start(url: string, file: string, request: SoundRequest, volume: number): void {
    const { group } = request;
    this.active[group]++;
    this.log('play', { file, group, repeats: request.repeats });
    let stop: () => void = () => {};
    const ended = (): void => {
      this.active[group]--;
      if (request.sourceId) this.stoppers.get(request.sourceId)?.delete(stop);
    };
    stop = this.options.backend.start(url, group, request.repeats, volume, ended);
    if (request.sourceId) {
      let set = this.stoppers.get(request.sourceId);
      if (!set) this.stoppers.set(request.sourceId, (set = new Set()));
      set.add(stop);
    }
  }

  /** `stop_sound(id)`: silences whatever a sound source is playing. */
  stopSource(sourceId: string): void {
    for (const stop of [...(this.stoppers.get(sourceId) ?? [])]) stop();
    this.stoppers.delete(sourceId);
  }

  /** Whether a sound source's sound is still playing (`is_sound_playing`). */
  isSourcePlaying(sourceId: string): boolean {
    return (this.stoppers.get(sourceId)?.size ?? 0) > 0;
  }

  /** Fetches and decodes sounds ahead of use, at low priority and a couple at a time. */
  preload(files: readonly string[]): void {
    for (const list of files) {
      for (const file of this.options.split(list)) {
        const url = this.options.urlFor(file);
        if (url && !this.preloadQueue.includes(url) && !this.options.backend.ready(url)) this.preloadQueue.push(url);
      }
    }
    this.pumpPreload();
  }

  private pumpPreload(): void {
    while (this.preloading < PRELOAD_CONCURRENCY && this.preloadQueue.length > 0) {
      const url = this.preloadQueue.shift()!;
      this.preloading++;
      void this.options.backend.load(url, 'low').finally(() => {
        this.preloading--;
        this.pumpPreload();
      });
    }
  }

  private reportMissing(file: string): void {
    if (this.missing.has(file)) return;
    this.missing.add(file);
    this.log('missing', { file });
  }
}
