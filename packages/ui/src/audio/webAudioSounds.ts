/**
 * The browser's half of sound effects: each file is fetched once and decoded
 * once into an `AudioBuffer` (`decodeAudioData` runs off the main thread), kept
 * in a size-capped cache, and played through a gain node into its group's bus.
 * Nothing here touches the image workers.
 */
import type { SoundGroup } from '@wesnothweb2/engine';
import type { SoundBackend, SoundHandle } from './soundEffects.js';

/** How much decoded PCM to keep (upstream caches 256 chunks; this is the same idea in bytes). */
export const SOUND_CACHE_BYTES = 32 * 1024 * 1024;

export class WebAudioSoundBackend implements SoundBackend {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<boolean>>();
  private readonly failed = new Set<string>();
  private cachedBytes = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly buses: Readonly<Record<SoundGroup, AudioNode>>,
  ) {}

  ready(url: string): boolean {
    const buffer = this.buffers.get(url);
    if (buffer) {
      // Most recently used goes last.
      this.buffers.delete(url);
      this.buffers.set(url, buffer);
    }
    return buffer !== undefined;
  }

  load(url: string, priority: 'high' | 'low'): Promise<boolean> {
    if (this.buffers.has(url)) return Promise.resolve(true);
    if (this.failed.has(url)) return Promise.resolve(false);
    let pending = this.loading.get(url);
    if (!pending) {
      pending = this.fetchAndDecode(url, priority).finally(() => this.loading.delete(url));
      this.loading.set(url, pending);
    }
    return pending;
  }

  private async fetchAndDecode(url: string, priority: 'high' | 'low'): Promise<boolean> {
    try {
      const response = await fetch(url, { priority } as RequestInit);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(url, buffer);
      this.cachedBytes += buffer.length * buffer.numberOfChannels * 4;
      this.evict();
      return true;
    } catch {
      this.failed.add(url);
      return false;
    }
  }

  private evict(): void {
    for (const [url, buffer] of this.buffers) {
      if (this.cachedBytes <= SOUND_CACHE_BYTES) break;
      this.buffers.delete(url);
      this.cachedBytes -= buffer.length * buffer.numberOfChannels * 4;
    }
  }

  start(url: string, group: SoundGroup, repeats: number, volume: number, onEnded: () => void): SoundHandle {
    const buffer = this.buffers.get(url);
    if (!buffer) {
      onEnded();
      return { stop: () => {}, setVolume: () => {} };
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(this.buses[group]);
    let done = false;
    source.onended = () => {
      if (done) return;
      done = true;
      source.disconnect();
      gain.disconnect();
      onEnded();
    };
    if (repeats !== 0) {
      source.loop = true;
      source.start();
      // `repeats` extra plays; -1 loops until stopped.
      if (repeats > 0) source.stop(this.ctx.currentTime + buffer.duration * (repeats + 1));
    } else {
      source.start();
    }
    return {
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      },
      setVolume: (v) => gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02),
    };
  }
}
