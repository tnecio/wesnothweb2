import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameBoardSnapshot, SoundRequest } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';

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
