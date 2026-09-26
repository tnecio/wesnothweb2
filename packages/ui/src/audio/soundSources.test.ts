import { describe, expect, it } from 'vitest';
import { Location, type SoundRequest, type SoundSourceSpec } from '@wesnothweb2/engine';
import { SoundSourceManager, type SourceHost, type SourcePlayer } from './soundSources.js';

function spec(overrides: Partial<SoundSourceSpec> = {}): SoundSourceSpec {
  return {
    id: 'fire',
    sounds: 'fire.ogg',
    delayMs: 1000,
    chance: 100,
    loop: 0,
    fullRange: 3,
    fadeRange: 14,
    checkFogged: true,
    checkShrouded: true,
    locations: [new Location(10, 10)],
    ...overrides,
  };
}

class FakePlayer implements SourcePlayer {
  readonly played: SoundRequest[] = [];
  readonly stopped: string[] = [];
  readonly volumes: { id: string; volume: number }[] = [];
  playing = new Set<string>();
  play(request: SoundRequest): void {
    this.played.push(request);
    this.playing.add(request.sourceId!);
  }
  stopSource(id: string): void {
    this.stopped.push(id);
    this.playing.delete(id);
  }
  isSourcePlaying(id: string): boolean {
    return this.playing.has(id);
  }
  setSourceVolume(id: string, volume: number): void {
    this.volumes.push({ id, volume });
  }
}

function make(options: { center?: { x: number; y: number } | null; random?: (max: number) => number; fogged?: string[]; shrouded?: string[] } = {}) {
  const player = new FakePlayer();
  const state = { center: options.center === undefined ? { x: 10, y: 10 } : options.center, clock: 0 };
  const host: SourceHost = {
    viewCenter: () => state.center,
    isFogged: (x, y) => (options.fogged ?? []).includes(`${x},${y}`),
    isShrouded: (x, y) => (options.shrouded ?? []).includes(`${x},${y}`),
  };
  const manager = new SoundSourceManager(player, host, options.random ?? (() => 0), () => state.clock);
  return { player, manager, state };
}

describe('SoundSourceManager', () => {
  it('plays a new source at once at full volume when the view is on it, looping as asked', () => {
    const { player, manager } = make();
    manager.setSources([spec({ loop: -1 })]);
    expect(player.played).toMatchObject([{ files: 'fire.ogg', repeats: -1, group: 'sources', volume: 100 }]);
  });

  it('a source with no locations plays everywhere at full volume', () => {
    const { player, manager } = make({ center: null });
    manager.setSources([spec({ locations: [] })]);
    expect(player.played[0]!.volume).toBe(100);
  });

  it('is quiet when the view is far, fading with distance beyond the full range', () => {
    const { player, manager } = make({ center: { x: 10, y: 20 } });
    manager.setSources([spec()]);
    // Distance 10: full range 3, so 7 of 14 fade hexes: half way to silent.
    expect(player.played[0]!.volume).toBeCloseTo(((255 - Math.trunc((7 / 14) * 255)) / 255) * 100, 3);
  });

  it('does not play when the view is beyond the fade range (and still waits out the delay)', () => {
    const { player, manager, state } = make({ center: { x: 10, y: 40 } });
    manager.setSources([spec()]);
    expect(player.played).toEqual([]);
    state.clock = 500;
    manager.tick();
    expect(player.played).toEqual([]);
    state.center = { x: 10, y: 10 };
    state.clock = 900;
    manager.tick(); // the view moved: sources follow it, silent ones get their chance next pass
    state.clock = 1200;
    manager.tick();
    expect(player.played).toHaveLength(1);
  });

  it('waits out its delay between plays, and only starts again when the last sound has ended', () => {
    const { player, manager, state } = make();
    manager.setSources([spec()]);
    expect(player.played).toHaveLength(1);
    player.playing.clear();
    state.clock = 500;
    manager.tick();
    expect(player.played).toHaveLength(1);
    state.clock = 1500;
    manager.tick();
    expect(player.played).toHaveLength(2);
    manager.tick();
    expect(player.played).toHaveLength(2); // still playing
  });

  it('rolls its chance each pass: no play when the roll is above it', () => {
    let roll = 60;
    const { player, manager, state } = make({ random: () => roll - 1 });
    manager.setSources([spec({ chance: 50 })]);
    expect(player.played).toEqual([]);
    roll = 50;
    state.clock = 10;
    manager.tick();
    expect(player.played).toHaveLength(1);
  });

  it('uses the nearest of several locations', () => {
    const { player, manager } = make({ center: { x: 30, y: 30 } });
    manager.setSources([spec({ locations: [new Location(0, 0), new Location(30, 32)] })]);
    expect(player.played[0]!.volume).toBeGreaterThan(80);
  });

  it('a fogged or shrouded location is silent when the source checks, and audible when it does not', () => {
    const fogged = make({ fogged: ['10,10'] });
    fogged.manager.setSources([spec()]);
    expect(fogged.player.played).toEqual([]);
    const shrouded = make({ shrouded: ['10,10'] });
    shrouded.manager.setSources([spec({ checkShrouded: false })]);
    expect(shrouded.player.played).toHaveLength(1);
  });

  it('a playing source follows the view, and is stopped when the view leaves it', () => {
    const { player, manager, state } = make();
    manager.setSources([spec()]);
    const id = player.played[0]!.sourceId!;
    state.center = { x: 10, y: 16 };
    manager.tick();
    expect(player.volumes).toHaveLength(1);
    expect(player.volumes[0]!.id).toBe(id);
    expect(player.volumes[0]!.volume).toBeLessThan(100);
    state.center = { x: 10, y: 60 };
    manager.tick();
    expect(player.stopped).toContain(id);
  });

  it('a replaced source starts afresh and silences the old sound; a removed one is silenced', () => {
    const { player, manager } = make();
    const first = spec();
    manager.setSources([first]);
    const firstId = player.played[0]!.sourceId!;
    manager.setSources([first]); // unchanged: nothing happens
    expect(player.played).toHaveLength(1);
    manager.setSources([spec({ sounds: 'other.ogg' })]);
    expect(player.stopped).toContain(firstId);
    expect(player.played.at(-1)).toMatchObject({ files: 'other.ogg' });
    expect(player.played.at(-1)!.sourceId).not.toBe(firstId);
    const secondId = player.played.at(-1)!.sourceId!;
    manager.setSources([]);
    expect(player.stopped).toContain(secondId);
  });

  it('stopAll silences everything', () => {
    const { player, manager } = make();
    manager.setSources([spec(), spec({ id: 'wind', sounds: 'wind.ogg' })]);
    manager.stopAll();
    expect(player.stopped).toHaveLength(2);
  });
});
