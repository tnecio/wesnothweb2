import { describe, expect, it } from 'vitest';
import { MusicList, WmlConfig } from '@wesnothweb2/engine';
import { MusicPlayer, type MusicBackend } from './musicPlayer.js';

/** A backend that records what it is asked and lets a test finish or fail a track by hand. */
class FakeBackend implements MusicBackend {
  playing = false;
  readonly calls: string[] = [];
  left: number | null = null;
  onEnded?: () => void;
  onStarted?: () => void;
  onError?: (url: string, message: string) => void;
  onTick?: () => void;

  start(url: string, fadeInMs: number): void {
    this.playing = true;
    this.calls.push(`start ${url} ${fadeInMs}`);
    this.onStarted?.();
  }
  async fadeOutAndStop(ms: number): Promise<void> {
    this.calls.push(`fadeOut ${ms}`);
    this.playing = false;
  }
  stop(): void {
    this.playing = false;
    this.calls.push('stop');
  }
  pause(): void {
    this.calls.push('pause');
  }
  resume(): void {
    this.calls.push('resume');
  }
  prefetch(url: string | null): void {
    this.calls.push(`prefetch ${url}`);
  }
  remaining(): number | null {
    return this.left;
  }
  finish(): void {
    this.playing = false;
    this.onEnded?.();
  }
}

function cfg(attrs: Record<string, string | number | boolean>): WmlConfig {
  const c = new WmlConfig();
  for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
  return c;
}

function lcg(seed: number): (max: number) => number {
  let x = seed >>> 0;
  return (max) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return Math.floor((x / 0x100000000) * (max + 1));
  };
}

function setup(...tracks: string[]) {
  const list = new MusicList({ random: lcg(11) });
  tracks.forEach((name, i) => list.playConfig(cfg({ name, ...(i > 0 ? { append: true } : {}) }), true));
  const backend = new FakeBackend();
  const events: string[] = [];
  const player = new MusicPlayer(list, backend, (id) => (id.startsWith('missing') ? null : `/m/${id}`), (e) => events.push(e));
  return { list, backend, player, events };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('MusicPlayer', () => {
  it('plays nothing before the first gesture, then what the list asks for', () => {
    const { list, backend, player } = setup('a.ogg');
    list.commit();
    player.sync();
    expect(backend.calls).toEqual([]);
    player.unlock();
    expect(backend.calls).toEqual(['prefetch null', 'start /m/a.ogg 0']);
  });

  it('starts a list set while silent, unfaded, on the next sync (the thinker picking a track)', () => {
    const { backend, player } = setup('a.ogg');
    player.unlock();
    expect(backend.calls).toEqual(['prefetch null', 'start /m/a.ogg 0']);
  });

  it('moves on when the track ends', () => {
    const { list, backend, player } = setup('a.ogg', 'b.ogg');
    player.unlock();
    const first = list.current!.id;
    backend.finish();
    expect(list.current!.id).not.toBe(first);
    expect(backend.calls.at(-1)).toBe(`start /m/${list.current!.id} 0`);
  });

  it('fades the old track out by its ms_after before an immediate change, and fades the new one in', async () => {
    const { list, backend, player } = setup();
    list.playConfig(cfg({ name: 'a.ogg', ms_after: 1500 }), true);
    player.unlock();
    backend.calls.length = 0;
    list.playConfig(cfg({ name: 'b.ogg', ms_before: 400, immediate: true, append: true }), true);
    player.sync();
    await flush();
    expect(backend.calls).toEqual(['prefetch null', 'fadeOut 1500', 'start /m/b.ogg 400']);
  });

  it('a request that arrives during a fade-out replaces the pending start', async () => {
    const { list, backend, player } = setup('a.ogg');
    player.unlock();
    backend.calls.length = 0;
    let release: () => void = () => {};
    backend.fadeOutAndStop = async (ms) => {
      backend.calls.push(`fadeOut ${ms}`);
      await new Promise<void>((resolve) => (release = resolve));
      backend.playing = false;
    };
    list.playConfig(cfg({ name: 'b.ogg', immediate: true, append: true }), true);
    player.sync();
    list.playConfig(cfg({ name: 'c.ogg', immediate: true, append: true }), true);
    player.sync();
    release();
    await flush();
    expect(backend.calls.filter((c) => c.startsWith('start'))).toEqual(['start /m/c.ogg 0']);
  });

  it('a play-once stinger interrupts, and the list follows it when it ends', async () => {
    const { list, backend, player } = setup('a.ogg', 'b.ogg');
    player.unlock();
    list.playOnce('stinger.ogg');
    player.sync();
    await flush();
    expect(backend.calls.at(-1)).toBe('start /m/stinger.ogg 0');
    backend.finish();
    expect(['a.ogg', 'b.ogg']).toContain(list.current!.id);
  });

  it('stays silent after the last track of an emptied list', () => {
    const { list, backend, player } = setup('a.ogg');
    player.unlock();
    list.clear();
    backend.calls.length = 0;
    backend.finish();
    player.sync();
    expect(backend.calls).toEqual([]);
  });

  it('logs a missing file once and skips to the next; gives up after three in a row', () => {
    const { list, backend, player, events } = setup('missing1.ogg', 'missing2.ogg');
    player.unlock();
    expect(events.filter((e) => e === 'error').length).toBeLessThanOrEqual(2);
    expect(events).toContain('gave-up');
    expect(backend.calls.filter((c) => c.startsWith('start'))).toEqual([]);
    // A fresh request from the game is tried again.
    list.playConfig(cfg({ name: 'ok.ogg', immediate: true }), true);
    player.sync();
    expect(backend.calls.at(-1)).toBe('start /m/ok.ogg 0');
  });

  it('a backend error skips the track', () => {
    const { list, backend, player } = setup('a.ogg', 'b.ogg');
    player.unlock();
    const failing = list.current!.id;
    backend.playing = false;
    backend.onError?.(`/m/${failing}`, 'decode');
    expect(list.current!.id).not.toBe(failing);
  });

  it('prefetches the next choice near the end, once, and it is the track that then plays', () => {
    const { list, backend, player } = setup('a.ogg', 'b.ogg', 'c.ogg');
    player.unlock();
    backend.left = 60;
    backend.onTick?.();
    expect(backend.calls.filter((c) => c.startsWith('prefetch /m/'))).toEqual([]);
    backend.left = 15;
    backend.onTick?.();
    backend.onTick?.();
    const prefetches = backend.calls.filter((c) => c.startsWith('prefetch /m/'));
    expect(prefetches).toHaveLength(1);
    backend.finish();
    expect(prefetches[0]).toBe(`prefetch /m/${list.current!.id}`);
  });

  it('music off stops and silences; on plays the current track again', async () => {
    const { list, backend, player } = setup('a.ogg');
    player.unlock();
    backend.calls.length = 0;
    player.setMusicOn(false);
    expect(backend.calls).toContain('stop');
    player.sync();
    expect(backend.calls.filter((c) => c.startsWith('start'))).toEqual([]);
    player.setMusicOn(true);
    await flush();
    expect(backend.calls.at(-1)).toBe(`start /m/${list.current!.id} 0`);
  });

  it('pauses while the window is hidden and does not pick a track meanwhile', () => {
    const { backend, player } = setup('a.ogg');
    player.unlock();
    backend.calls.length = 0;
    player.setBackgrounded(true);
    player.setBackgrounded(true);
    player.setBackgrounded(false);
    expect(backend.calls).toEqual(['pause', 'resume']);
  });
});
