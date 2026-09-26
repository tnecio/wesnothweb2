import { describe, expect, it } from 'vitest';
import type { SoundGroup } from '@wesnothweb2/engine';
import { squareParentheticalSplit } from '@wesnothweb2/renderer/src/animation/frame.js';
import { CHANNELS, LATE_MS, SoundPlayer, type SoundBackend, type SoundHandle } from './soundEffects.js';

class FakeBackend implements SoundBackend {
  readonly decoded = new Set<string>();
  readonly loads: { url: string; priority: string; resolve: (ok: boolean) => void }[] = [];
  readonly started: { url: string; group: SoundGroup; repeats: number; volume: number; end: () => void }[] = [];
  readonly stopped: string[] = [];
  readonly volumes: { url: string; volume: number }[] = [];

  ready(url: string): boolean {
    return this.decoded.has(url);
  }
  load(url: string, priority: 'high' | 'low'): Promise<boolean> {
    return new Promise((resolve) => this.loads.push({ url, priority, resolve: (ok) => (ok && this.decoded.add(url), resolve(ok)) }));
  }
  start(url: string, group: SoundGroup, repeats: number, volume: number, onEnded: () => void): SoundHandle {
    this.started.push({ url, group, repeats, volume, end: onEnded });
    return {
      stop: () => {
        this.stopped.push(url);
        onEnded();
      },
      setVolume: (v) => this.volumes.push({ url, volume: v }),
    };
  }
}

function make(options: { decoded?: string[]; random?: (max: number) => number } = {}) {
  const backend = new FakeBackend();
  for (const url of options.decoded ?? []) backend.decoded.add(`/s/${url}`);
  let clock = 0;
  const log: string[] = [];
  const player = new SoundPlayer({
    backend,
    split: squareParentheticalSplit,
    urlFor: (file) => (file.startsWith('nope') ? null : `/s/${file}`),
    random: options.random ?? (() => 0),
    now: () => clock,
    log: (event, detail) => log.push(`${event} ${JSON.stringify(detail ?? {})}`),
  });
  return { backend, player, log, advance: (ms: number) => (clock += ms) };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('pick_one', () => {
  it('returns a single file as it is and expands bracket ranges', () => {
    const { player } = make({ random: () => 1 });
    expect(player.pickOne('a.ogg')).toBe('a.ogg');
    expect(player.pickOne('chat-[1~3].ogg')).toBe('chat-2.ogg');
    expect(player.pickOne('')).toBe('');
  });

  it('never repeats the previous pick of the same list', () => {
    const draws = [2, 0, 0, 1, 1];
    let i = 0;
    const { player } = make({ random: (max) => Math.min(draws[i++ % draws.length]!, max) });
    const picks = Array.from({ length: 5 }, () => player.pickOne('a.ogg,b.ogg,c.ogg'));
    for (let k = 1; k < picks.length; k++) expect(picks[k]).not.toBe(picks[k - 1]);
  });
});

describe('play', () => {
  it('starts a decoded sound at once with its group, repeats and volume', () => {
    const { player, backend } = make({ decoded: ['axe.ogg'] });
    player.play({ files: 'axe.ogg', repeats: 2, group: 'sound', volume: 50 });
    expect(backend.started).toMatchObject([{ url: '/s/axe.ogg', group: 'sound', repeats: 2, volume: 0.5 }]);
  });

  it('logs a file that does not exist once and plays nothing', () => {
    const { player, backend, log } = make();
    player.play({ files: 'nope.ogg', repeats: 0, group: 'sound' });
    player.play({ files: 'nope.ogg', repeats: 0, group: 'sound' });
    expect(backend.started).toEqual([]);
    expect(log.filter((l) => l.startsWith('missing'))).toHaveLength(1);
  });

  it("skips a sound when its group's channels are all busy, and frees one when a sound ends", () => {
    const { player, backend } = make({ decoded: ['a.ogg'] });
    for (let i = 0; i < CHANNELS.sound + 3; i++) player.play({ files: 'a.ogg', repeats: 0, group: 'sound' });
    expect(backend.started).toHaveLength(CHANNELS.sound);
    backend.started[0]!.end();
    player.play({ files: 'a.ogg', repeats: 0, group: 'sound' });
    expect(backend.started).toHaveLength(CHANNELS.sound + 1);
  });

  it('keeps the groups apart: a full effects group does not block the bell', () => {
    const { player, backend } = make({ decoded: ['a.ogg', 'bell.wav'] });
    for (let i = 0; i < CHANNELS.sound; i++) player.play({ files: 'a.ogg', repeats: 0, group: 'sound' });
    player.play({ files: 'bell.wav', repeats: 0, group: 'bell' });
    player.play({ files: 'bell.wav', repeats: 0, group: 'bell' });
    expect(backend.started.filter((s) => s.group === 'bell')).toHaveLength(CHANNELS.bell);
  });

  it('a sound that is not decoded yet plays when it arrives, if not too late', async () => {
    const { player, backend, advance } = make();
    player.play({ files: 'new.ogg', repeats: 0, group: 'sound' });
    expect(backend.started).toEqual([]);
    expect(backend.loads).toMatchObject([{ url: '/s/new.ogg', priority: 'high' }]);
    advance(LATE_MS - 10);
    backend.loads[0]!.resolve(true);
    await flush();
    expect(backend.started).toHaveLength(1);
  });

  it('drops a sound that arrives too late (but keeps it decoded)', async () => {
    const { player, backend, advance, log } = make();
    player.play({ files: 'new.ogg', repeats: 0, group: 'sound' });
    advance(LATE_MS + 50);
    backend.loads[0]!.resolve(true);
    await flush();
    expect(backend.started).toEqual([]);
    expect(backend.decoded.has('/s/new.ogg')).toBe(true);
    expect(log.some((l) => l.startsWith('late'))).toBe(true);
    player.play({ files: 'new.ogg', repeats: 0, group: 'sound' });
    expect(backend.started).toHaveLength(1);
  });

  it('a request that says dropIfLate=false plays however late it arrives, and one that says true is dropped even in a lenient group', async () => {
    const { player, backend, advance } = make();
    player.play({ files: 'chest.wav', repeats: 0, group: 'sound', dropIfLate: false });
    player.play({ files: 'wind.ogg', repeats: 0, group: 'sources', dropIfLate: true });
    advance(LATE_MS * 10);
    for (const load of backend.loads) load.resolve(true);
    await flush();
    expect(backend.started.map((s) => s.url)).toEqual(['/s/chest.wav']);
  });

  it('ambience and the bell play whenever they arrive, however late', async () => {
    const { player, backend, advance } = make();
    player.play({ files: 'ambient/morning.ogg', repeats: 0, group: 'sources' });
    player.play({ files: 'bell.wav', repeats: 0, group: 'bell' });
    advance(LATE_MS * 40);
    for (const load of backend.loads) load.resolve(true);
    await flush();
    expect(backend.started.map((s) => s.group).sort()).toEqual(['bell', 'sources']);
  });

  it('a file that fails to load is reported and never played', async () => {
    const { player, backend, log } = make();
    player.play({ files: 'bad.ogg', repeats: 0, group: 'sound' });
    backend.loads[0]!.resolve(false);
    await flush();
    expect(backend.started).toEqual([]);
    expect(log.some((l) => l.startsWith('missing'))).toBe(true);
  });

  it('a burst of undecoded sounds cannot overshoot the channels', async () => {
    const { player, backend } = make();
    for (let i = 0; i < CHANNELS.ui + 2; i++) player.play({ files: `f${i}.wav`, repeats: 0, group: 'ui' });
    expect(backend.loads).toHaveLength(CHANNELS.ui);
  });
});

describe('sound sources', () => {
  it("stopSource silences a source's sounds, and isSourcePlaying follows them", () => {
    const { player, backend } = make({ decoded: ['fire.ogg'] });
    player.play({ files: 'fire.ogg', repeats: -1, group: 'sources', sourceId: 'camp' });
    expect(player.isSourcePlaying('camp')).toBe(true);
    player.stopSource('camp');
    expect(backend.stopped).toEqual(['/s/fire.ogg']);
    expect(player.isSourcePlaying('camp')).toBe(false);
  });

  it('setSourceVolume turns a playing source up and down', () => {
    const { player, backend } = make({ decoded: ['fire.ogg'] });
    player.play({ files: 'fire.ogg', repeats: -1, group: 'sources', sourceId: 'camp', volume: 100 });
    player.setSourceVolume('camp', 40);
    expect(backend.volumes).toEqual([{ url: '/s/fire.ogg', volume: 0.4 }]);
  });

  it('a source whose sound is still loading counts as playing, so it is not asked again', async () => {
    const { player, backend } = make();
    player.play({ files: 'fire.ogg', repeats: 0, group: 'sources', sourceId: 'camp' });
    expect(player.isSourcePlaying('camp')).toBe(true);
    backend.loads[0]!.resolve(true);
    await flush();
    expect(player.isSourcePlaying('camp')).toBe(true);
    backend.started[0]!.end();
    expect(player.isSourcePlaying('camp')).toBe(false);
  });
});

describe('preload', () => {
  it('fetches at low priority, two at a time, skipping what is decoded or unknown', async () => {
    const { player, backend } = make({ decoded: ['have.ogg'] });
    player.preload(['have.ogg', 'nope.ogg', 'a.ogg,b.ogg', 'c.ogg', 'a.ogg']);
    expect(backend.loads.map((l) => [l.url, l.priority])).toEqual([
      ['/s/a.ogg', 'low'],
      ['/s/b.ogg', 'low'],
    ]);
    backend.loads[0]!.resolve(true);
    await flush();
    expect(backend.loads.map((l) => l.url)).toEqual(['/s/a.ogg', '/s/b.ogg', '/s/c.ogg']);
  });
});
