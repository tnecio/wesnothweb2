import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameBoardSnapshot, SoundRequest } from '@wesnothweb2/engine';
import { WmlConfig } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';
import { fromWesnothSave, toWesnothSave } from './save/wesnothSave.js';

/**
 * Phase 19, Stage 2: the sounds the game itself asks for -- the turn bell
 * when a human side's turn begins, and the time of day's ambient sound once
 * a turn -- through a real session on Dead Water 1.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function dw1(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/scenarios/01_Invasion.json'), 'utf8')) as GameBoardSnapshot;
}

function describeSounds(heard: readonly SoundRequest[]): string[] {
  return heard.map((r) => `${r.group}:${r.files}`);
}

describe('turn sounds', () => {
  it("the first human turn rings the bell and plays the dawn's ambient sound", async () => {
    const heard: SoundRequest[] = [];
    const session = new GameSession(dw1(), { onSound: (r) => heard.push(r) });
    await session.runStartupEvents();
    expect(describeSounds(heard)).toEqual(['sources:ambient/morning.ogg', 'bell:bell.wav']);
  });

  it('the ambient sound plays once per turn, and only turns whose time of day has one', async () => {
    const heard: SoundRequest[] = [];
    const session = new GameSession(dw1(), { onSound: (r) => heard.push(r) });
    await session.runStartupEvents();
    heard.length = 0;
    await session.endTurn();
    // Turn 2 is morning (no sound); the AI side's init rings no bell.
    expect(session.turnNumber).toBe(2);
    expect(describeSounds(heard).filter((s) => s.startsWith('sources'))).toEqual([]);
    expect(describeSounds(heard).filter((s) => s.startsWith('bell'))).toEqual(['bell:bell.wav']);
  });

  it('is only recorded on the context when nothing listens', async () => {
    const session = new GameSession(dw1());
    await session.runStartupEvents();
    expect(session['eventPump'].ctx.sounds.map((r) => r.group)).toEqual(['sources', 'bell']);
  });
});

function withSources(snapshot: GameBoardSnapshot, ...ids: string[]): GameBoardSnapshot {
  for (const id of ids) {
    snapshot.scenarioConfigJson.children.push({ tag: 'sound_source', config: { attrs: { id, sounds: `${id}.ogg`, x: '3', y: '4', delay: 2000 }, children: [] } });
  }
  return snapshot;
}

describe('sound sources', () => {
  it("the scenario's own [sound_source]s are in effect from the start", () => {
    const session = new GameSession(withSources(dw1(), 'wind', 'birds'));
    expect(session.soundSources.map((s) => s.id)).toEqual(['birds', 'wind']);
    expect(session.soundSources[0]!.locations.map((l) => [l.x, l.y])).toEqual([[2, 3]]);
  });

  it('a [sound_source] event replaces a source with a new spec, and [remove_sound_source] removes', () => {
    const session = new GameSession(withSources(dw1(), 'wind'));
    const before = session.soundSources[0]!;
    const event = new WmlConfig();
    event.setAttribute('name', 'go');
    const add = event.addChild('sound_source');
    add.setAttribute('id', 'wind');
    add.setAttribute('sounds', 'other.ogg');
    session['eventPump'].manager.addFromWml(event);
    session['eventPump'].fire('go');
    expect(session.soundSources).toHaveLength(1);
    expect(session.soundSources[0]).not.toBe(before);
    expect(session.soundSources[0]!.sounds).toBe('other.ogg');
  });

  it('a save records them and loading restores exactly those, not the scenario\'s', () => {
    const session = new GameSession(withSources(dw1(), 'wind'));
    const event = new WmlConfig();
    event.setAttribute('name', 'go');
    event.addChild('remove_sound_source').setAttribute('id', 'wind');
    const add = event.addChild('sound_source');
    add.setAttribute('id', 'rain');
    add.setAttribute('sounds', 'rain.ogg');
    add.setAttribute('loop', -1);
    session['eventPump'].manager.addFromWml(event);
    session['eventPump'].fire('go');
    const saved = session.toSaveData();
    expect(saved.soundSources?.map((s) => s.attrs['id'])).toEqual(['rain']);
    const restored = GameSession.fromSaveData(withSources(dw1(), 'wind'), saved);
    expect(restored.soundSources.map((s) => `${s.id}:${s.loop}`)).toEqual(['rain:-1']);
  });

  it("survives the trip through a Wesnoth save's [sound_source] tags", () => {
    const session = new GameSession(withSources(dw1(), 'wind'));
    const cfg = toWesnothSave(session.toSaveData(), dw1(), { id: 'dead_water', name: 'Dead Water', abbrev: 'DW' } as never);
    const tags = cfg.child('snapshot')!.children('sound_source');
    expect(tags.map((t) => t.getString('id'))).toEqual(['wind']);
    expect(tags[0]!.getString('x')).toBe('3');
    const back = fromWesnothSave(cfg);
    expect(back.save.soundSources?.map((s) => s.attrs['id'])).toEqual(['wind']);
  });
});

describe('[volume]', () => {
  it('reaches the app through onVolume', () => {
    const heard: { music?: number; sound?: number }[] = [];
    const session = new GameSession(dw1(), { onVolume: (scale) => heard.push(scale) });
    const event = new WmlConfig();
    event.setAttribute('name', 'go');
    const volume = event.addChild('volume');
    volume.setAttribute('music', 30);
    session['eventPump'].manager.addFromWml(event);
    session['eventPump'].fire('go');
    expect(heard).toEqual([{ music: 30 }]);
  });
});
