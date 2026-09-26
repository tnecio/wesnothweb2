/**
 * Plays what a `MusicList` asks for -- the half of `sound.cpp`'s
 * `music_thinker` that is not the playlist. The list decides which track
 * comes next; this watches it, hands tracks to a backend (the browser's
 * audio elements, or a fake in tests), and reports when one has ended.
 *
 * - A new `request` (a `[music] immediate=`, a commit, a play-once stinger)
 *   fades the old track out by its `ms_after`, then starts the new one.
 * - Nothing playing while the list is not empty -- the track ended, or a
 *   list was set in silence -- asks the list for its next choice, unfaded.
 * - The next choice is prefetched shortly before the current track ends.
 * - Nothing starts until `unlock()` (the first user gesture), and a track
 *   that will not load is logged once and skipped, giving up after a few
 *   in a row so a broken install does not loop.
 */
import type { MusicList, MusicRequest } from '@wesnothweb2/engine';

export interface MusicBackend {
  /** Starts the track at `url`, its gain rising from silence over `fadeInMs`. */
  start(url: string, fadeInMs: number): void;
  /** Fades the playing track out over `ms` and releases it. */
  fadeOutAndStop(ms: number): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Fetches `url` ahead of use (null: drop any earlier one). */
  prefetch(url: string | null): void;
  /** Whether a track is loaded and has not finished. */
  readonly playing: boolean;
  /** Seconds left in the playing track, if known. */
  remaining(): number | null;
  onEnded?: () => void;
  onStarted?: () => void;
  onError?: (url: string, message: string) => void;
  /** Called a few times a second while a track plays. */
  onTick?: () => void;
}

export type MusicLogger = (event: string, detail?: Record<string, unknown>) => void;

/** Seconds before the end of a track at which the next one is fetched. */
export const PREFETCH_LEAD_SECONDS = 20;
const MAX_CONSECUTIVE_ERRORS = 3;

export class MusicPlayer {
  private unlocked = false;
  private musicOn = true;
  private handledSeq = 0;
  private generation = 0;
  /** A track is being started (a fade-out may be under way). */
  private starting = false;
  private errors = 0;
  private prefetchedFor = 0;
  private paused = false;
  private readonly reported = new Set<string>();

  constructor(
    private readonly list: MusicList,
    private readonly backend: MusicBackend,
    private readonly urlFor: (id: string) => string | null,
    private readonly log: MusicLogger = () => {},
  ) {
    backend.onEnded = () => this.ended();
    backend.onStarted = () => {
      this.errors = 0;
    };
    backend.onError = (url, message) => this.failed(url, message);
    backend.onTick = () => this.tick();
  }

  /** The first user gesture has happened: whatever the list wants now can start. */
  unlock(): void {
    this.unlocked = true;
    this.sync();
  }

  /** `prefs::set_music`: off stops the music, on plays the current track again. */
  setMusicOn(on: boolean): void {
    if (on === this.musicOn) return;
    this.musicOn = on;
    if (!on) {
      this.generation++;
      this.starting = false;
      this.backend.stop();
      this.backend.prefetch(null);
      this.log('music-off');
      return;
    }
    this.errors = 0;
    const current = this.list.current;
    if (current && this.unlocked) void this.handle({ seq: this.handledSeq, track: current, fadeOutMs: 0, fadeInMs: current.msBefore });
    else this.sync();
  }

  /** `stop_music_in_background`: the window went out of sight or came back. */
  setBackgrounded(hidden: boolean): void {
    if (hidden === this.paused) return;
    this.paused = hidden;
    if (hidden) this.backend.pause();
    else this.backend.resume();
    this.log(hidden ? 'pause' : 'resume');
  }

  /** Follows the list: call regularly (a few times a second is plenty). */
  sync(): void {
    if (!this.unlocked || !this.musicOn) return;
    const request = this.list.request;
    if (request && request.seq !== this.handledSeq) {
      this.handledSeq = request.seq;
      void this.handle(request);
      return;
    }
    if (this.starting || this.paused || this.backend.playing || this.list.length === 0 || this.errors >= MAX_CONSECUTIVE_ERRORS) return;
    this.list.trackEnded();
    const next = this.list.request;
    if (next && next.seq !== this.handledSeq) {
      this.handledSeq = next.seq;
      void this.handle(next);
    }
  }

  private async handle(request: MusicRequest): Promise<void> {
    const generation = ++this.generation;
    const track = request.track;
    const url = this.urlFor(track.id);
    if (!url) {
      this.failed(track.id, 'no such file');
      return;
    }
    this.starting = true;
    this.backend.prefetch(null);
    this.prefetchedFor = 0;
    if (this.backend.playing) {
      this.log('fade-out', { ms: request.fadeOutMs });
      await this.backend.fadeOutAndStop(request.fadeOutMs);
    }
    if (generation !== this.generation) return;
    this.starting = false;
    const began = performance.now();
    this.backend.start(url, request.fadeInMs);
    this.log('start', { track: track.id, fadeInMs: request.fadeInMs, url, syncMs: Math.round(performance.now() - began) });
  }

  private ended(): void {
    this.log('ended');
    this.errors = 0;
    this.list.trackEnded();
    this.sync();
  }

  private failed(what: string, message: string): void {
    if (!this.reported.has(what)) {
      this.reported.add(what);
      this.log('error', { what, message });
    }
    this.starting = false;
    this.errors++;
    if (this.errors >= MAX_CONSECUTIVE_ERRORS) {
      this.log('gave-up');
      return;
    }
    this.list.trackEnded();
    this.sync();
  }

  private tick(): void {
    const remaining = this.backend.remaining();
    if (remaining === null || remaining > PREFETCH_LEAD_SECONDS || this.prefetchedFor === this.handledSeq) return;
    this.prefetchedFor = this.handledSeq;
    const next = this.list.peekNext();
    const url = next ? this.urlFor(next.id) : null;
    if (url) {
      this.log('prefetch', { track: next!.id });
      this.backend.prefetch(url);
    }
  }
}
