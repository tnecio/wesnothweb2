/**
 * The browser's half of music playback: each track is an `HTMLAudioElement`,
 * so the browser fetches it progressively and decodes it on its own media
 * threads -- nothing here decodes audio or touches the image workers. The
 * element is routed through Web Audio (`MediaElementAudioSourceNode`) only
 * so the gains (volume, fades, mute) apply; the mixing itself runs on the
 * audio rendering thread. Fades are gain ramps scheduled on that thread.
 */
import type { MusicBackend } from './musicPlayer.js';

interface Slot {
  el: HTMLAudioElement;
  url: string;
  source?: MediaElementAudioSourceNode;
  gain?: GainNode;
  fading: boolean;
}

export class WebAudioMusicBackend implements MusicBackend {
  onEnded?: () => void;
  onStarted?: () => void;
  onError?: (url: string, message: string) => void;
  onTick?: () => void;

  private current: Slot | null = null;
  private next: Slot | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly bus: AudioNode,
  ) {}

  get playing(): boolean {
    return this.current !== null;
  }

  remaining(): number | null {
    const el = this.current?.el;
    return el && Number.isFinite(el.duration) ? el.duration - el.currentTime : null;
  }

  private open(url: string): Slot {
    const el = new Audio();
    el.preload = 'auto';
    el.src = url;
    return { el, url, fading: false };
  }

  private release(slot: Slot): void {
    slot.el.pause();
    slot.el.removeAttribute('src');
    slot.el.load();
    slot.source?.disconnect();
    slot.gain?.disconnect();
  }

  prefetch(url: string | null): void {
    if (this.next && this.next.url === url) return;
    if (this.next) this.release(this.next);
    this.next = null;
    if (!url) return;
    const slot = this.open(url);
    slot.el.addEventListener('error', () => {
      if (this.next === slot) {
        this.release(slot);
        this.next = null;
      }
    });
    this.next = slot;
  }

  start(url: string, fadeInMs: number): void {
    if (this.current) {
      this.release(this.current);
      this.current = null;
    }
    const slot = this.next && this.next.url === url ? this.next : this.open(url);
    if (slot === this.next) this.next = null;
    else if (this.next) {
      this.release(this.next);
      this.next = null;
    }
    slot.source = this.ctx.createMediaElementSource(slot.el);
    slot.gain = this.ctx.createGain();
    slot.source.connect(slot.gain).connect(this.bus);
    const now = this.ctx.currentTime;
    if (fadeInMs > 0) {
      slot.gain.gain.setValueAtTime(0, now);
      slot.gain.gain.linearRampToValueAtTime(1, now + fadeInMs / 1000);
    }
    slot.el.addEventListener('playing', () => this.onStarted?.(), { once: true });
    slot.el.addEventListener('timeupdate', () => {
      if (this.current === slot) this.onTick?.();
    });
    slot.el.addEventListener('ended', () => {
      if (this.current !== slot) return;
      this.current = null;
      this.release(slot);
      this.onEnded?.();
    });
    slot.el.addEventListener('error', () => {
      if (this.current !== slot) return;
      this.current = null;
      this.release(slot);
      this.onError?.(slot.url, slot.el.error?.message || 'the file could not be played');
    });
    this.current = slot;
    slot.el.play().catch((error: unknown) => {
      if (this.current !== slot || (error instanceof DOMException && error.name === 'AbortError')) return;
      this.current = null;
      this.release(slot);
      this.onError?.(slot.url, error instanceof Error ? error.message : String(error));
    });
  }

  async fadeOutAndStop(ms: number): Promise<void> {
    const slot = this.current;
    if (!slot) return;
    if (ms <= 0 || !slot.gain) {
      this.stop();
      return;
    }
    slot.fading = true;
    const now = this.ctx.currentTime;
    slot.gain.gain.cancelScheduledValues(now);
    slot.gain.gain.setValueAtTime(slot.gain.gain.value, now);
    slot.gain.gain.linearRampToValueAtTime(0, now + ms / 1000);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    if (this.current === slot) {
      this.current = null;
      this.release(slot);
    }
  }

  stop(): void {
    if (this.current) this.release(this.current);
    this.current = null;
  }

  /** Jumps the playing track to `seconds` before its end; false if none is playing or its length is unknown. */
  seekNearEnd(seconds: number): boolean {
    const el = this.current?.el;
    if (!el || !Number.isFinite(el.duration)) return false;
    el.currentTime = Math.max(0, el.duration - seconds);
    return true;
  }

  pause(): void {
    this.current?.el.pause();
  }

  resume(): void {
    void this.current?.el.play().catch(() => {});
  }
}
