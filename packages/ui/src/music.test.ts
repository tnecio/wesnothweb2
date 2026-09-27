import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MusicList, WmlConfig, type GameBoardSnapshot } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';
import { fromWesnothSave, toWesnothSave } from './save/wesnothSave.js';

/**
 * Phase 19, Stage 1: the music playlist through a real session -- the
 * scenario's own `[music]`s at start, `[music]` events, the playlist
 * handed to the next scenario, saves, and the victory/defeat stinger.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function scenario(id: string): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, `apps/web/public/scenarios/Dead_Water/${id}.json`), 'utf8')) as GameBoardSnapshot;
}

/** A list whose track choice is a fixed sequence, so the tests are deterministic. */
function list(...draws: number[]): MusicList {
  let i = 0;
  return new MusicList({ random: (max) => Math.min(draws[i++ % draws.length]!, max) });
}

function named(name: string, append = false): WmlConfig {
  const c = new WmlConfig();
  c.setAttribute('name', name);
  if (append) c.setAttribute('append', true);
  return c;
}

function names(l: MusicList): string[] {
  return Array.from({ length: l.length }, (_, i) => l.track(i)!.id);
}

/** The scenario with its own top-level `[music]` tags, as Sceptre of Fire 2 and UtBS 9 have (Dead Water sets its music in `prestart`). */
function withMusic(id: string, ...tracks: string[]): GameBoardSnapshot {
  const snapshot = scenario(id);
  snapshot.scenarioConfigJson.children = snapshot.scenarioConfigJson.children.filter((c) => c.tag !== 'music');
  tracks.forEach((name, i) => {
    snapshot.scenarioConfigJson.children.push({ tag: 'music', config: { attrs: { name, ...(i > 0 ? { append: true } : {}) }, children: [] } });
  });
  return snapshot;
}

function fireMusic(session: GameSession, music: Record<string, string | boolean | number>): void {
  const event = new WmlConfig();
  event.setAttribute('name', 'test_music');
  const m = event.addChild('music');
  for (const [k, v] of Object.entries(music)) m.setAttribute(k, v);
  session['eventPump'].manager.addFromWml(event);
  session['eventPump'].fire('test_music');
}

const DW1_TRACKS = ['the_king_is_dead.ogg', 'vengeful.ogg', 'legends_of_the_north.ogg'];

describe('scenario start', () => {
  it("the scenario's own [music] tags make the playlist, and one of them starts", () => {
    const music = list(1);
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music });
    expect(session.music).toBe(music);
    expect(names(music)).toEqual(DW1_TRACKS);
    expect(music.current?.id).toBe('vengeful.ogg');
    expect(music.request).toMatchObject({ seq: 1, fadeInMs: 0 });
  });

  it('a scenario with no [music] keeps the playlist it was handed', () => {
    const music = list(0);
    music.playConfig(named('battle.ogg'), true);
    music.commit();
    const before = music.request!.seq;
    new GameSession(withMusic('01_Invasion'), { music });
    expect(names(music)).toEqual(['battle.ogg']);
    expect(music.request!.seq).toBe(before);
  });

  it("Dead Water 1's prestart [music]s fill the playlist, and the player's next pick starts one", async () => {
    const music = list(2);
    const session = new GameSession(scenario('01_Invasion'), { music });
    expect(music.length).toBe(0);
    await session.runStartupEvents();
    expect(names(music)).toEqual(DW1_TRACKS);
    // Nothing is committed: the list is heard once the player finds nothing playing.
    expect(music.current).toBeNull();
    music.trackEnded();
    expect(music.current?.id).toBe('legends_of_the_north.ogg');
    expect(music.request).toMatchObject({ fadeOutMs: 0, fadeInMs: 0 });
  });
});

describe('[music] events', () => {
  it('replaces the list, and plays the new track at once with immediate=yes', () => {
    const music = list(0);
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music });
    fireMusic(session, { name: 'battle.ogg', immediate: true });
    expect(names(music)).toEqual(['battle.ogg']);
    expect(music.current?.id).toBe('battle.ogg');
  });

  it('without immediate, the current track plays on and the change is heard when it ends', () => {
    const music = list(0);
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music });
    const playing = music.current!.id;
    fireMusic(session, { name: 'battle.ogg' });
    expect(music.current?.id).toBe(playing);
    music.trackEnded();
    expect(music.current?.id).toBe('battle.ogg');
  });
});

describe('across scenarios', () => {
  it('the next scenario continues with the same list, and its own [music] replaces the playlist', () => {
    const music = list(0);
    const first = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music });
    fireMusic(first, { name: 'battle.ogg', immediate: true });
    const next = scenario('02_Flight');
    next.scenarioConfigJson.children = next.scenarioConfigJson.children.filter((c) => c.tag !== 'music');
    first.scenarioResult = 'victory';
    const second = GameSession.startNextScenario(first, next);
    expect(second.music).toBe(music);
    expect(names(second.music)).toEqual(['battle.ogg']);
  });
});

describe('saves', () => {
  it('a save records the playlist, and loading it into a fresh list restores it', () => {
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music: list(0) });
    fireMusic(session, { name: 'battle.ogg', shuffle: false });
    session['eventPump'].ctx.music.playConfig(named('sad.ogg', true), true);
    const saved = session.toSaveData();
    expect(saved.music?.map((m) => m.attrs['name'])).toEqual(['battle.ogg', 'sad.ogg']);

    const restoredList = list(0);
    const restored = GameSession.fromSaveData(withMusic('01_Invasion', ...DW1_TRACKS), saved, { music: restoredList });
    expect(names(restored.music)).toEqual(['battle.ogg', 'sad.ogg']);
    expect(restored.music.track(0)?.shuffle).toBe(false);
    expect(restored.music.current?.id).toBe('battle.ogg');
  });

  it('a save without a playlist starts the scenario music', () => {
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music: list(0) });
    const saved = session.toSaveData();
    delete saved.music;
    const restored = GameSession.fromSaveData(withMusic('01_Invasion', ...DW1_TRACKS), saved, { music: list(0) });
    expect(names(restored.music)).toEqual(DW1_TRACKS);
  });

  it("survives the trip through a Wesnoth save's [music] tags", () => {
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music: list(0) });
    fireMusic(session, { name: 'battle.ogg', ms_before: 700, shuffle: false });
    const cfg = toWesnothSave(session.toSaveData(), scenario('01_Invasion'), { id: 'dead_water', name: 'Dead Water', abbrev: 'DW' } as never);
    const tags = cfg.child('snapshot')!.children('music');
    expect(tags.map((m) => m.getString('name'))).toEqual(['battle.ogg']);
    expect(tags[0]!.getNumber('ms_before')).toBe(700);
    const back = fromWesnothSave(cfg);
    expect(back.save.music?.map((m) => m.attrs['name'])).toEqual(['battle.ogg']);
  });
});

describe('the victory/defeat stinger', () => {
  function finish(session: GameSession, result: 'victory' | 'defeat', endlevel: Record<string, string | boolean> = {}): void {
    const ctx = session['eventPump'].ctx;
    const cfg = new WmlConfig();
    cfg.setAttribute('name', 'finish');
    const el = cfg.addChild('endlevel');
    el.setAttribute('result', result);
    for (const [k, v] of Object.entries(endlevel)) el.setAttribute(k, v);
    session['eventPump'].manager.addFromWml(cfg);
    session['eventPump'].fire('finish');
    // @ts-expect-error -- the private end-of-turn check, as the other tests call it.
    session.checkForGameEnd();
    expect(ctx.endLevel).toBeDefined();
  }

  it('a defeat empties the playlist and plays a default defeat track once', () => {
    const music = list(1);
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music });
    finish(session, 'defeat');
    expect(music.length).toBe(0);
    expect(music.current?.id).toBe('defeat2.ogg');
    expect(music.current?.once).toBe(true);
  });

  it('a victory plays one of the default victory tracks', () => {
    const music = list(0);
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music });
    finish(session, 'victory');
    expect(music.current?.id).toBe('victory.ogg');
  });

  it("uses the scenario's own victory_music= over the defaults", () => {
    const music = list(0);
    const snapshot = withMusic('01_Invasion', ...DW1_TRACKS);
    snapshot.scenarioConfigJson.attrs['victory_music'] = 'sad.ogg,love_theme.ogg';
    const session = new GameSession(snapshot, { music });
    finish(session, 'victory');
    expect(music.current?.id).toBe('sad.ogg');
  });

  it('an [endlevel] music= overrides both', () => {
    const music = list(0);
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music });
    finish(session, 'victory', { music: 'transience.ogg' });
    expect(music.current?.id).toBe('transience.ogg');
  });

  it('a victory with carryover_report=no plays nothing, but a defeat still does', () => {
    const music = list(0);
    const session = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music });
    const before = music.request!.seq;
    finish(session, 'victory', { carryover_report: false });
    expect(music.request!.seq).toBe(before);
    expect(music.length).toBe(3);

    const music2 = list(0);
    const session2 = new GameSession(withMusic('01_Invasion', ...DW1_TRACKS), { music: music2 });
    finish(session2, 'defeat', { carryover_report: false });
    expect(music2.current?.id).toBe('defeat.ogg');
  });
});
