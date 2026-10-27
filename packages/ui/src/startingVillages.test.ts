/**
 * `{STARTING_VILLAGES side radius}` on a real scenario: Son of the Black Eye 1 gives Kapou'e the villages within 7
 * hexes of his keep and Alber those within 19 of his ("south of the river"); the rest stay neutral. Real, reported
 * bug: `[capture_village]` read its filter without the macro's variables, and Alber began with every village.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distanceBetween } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('{STARTING_VILLAGES}', () => {
  it("Son of the Black Eye 1: each side's villages are the ones near its keep, the rest neutral", async () => {
    const s = new GameSession(readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Son_Of_The_Black_Eye/01_End_of_Peace.json')), { seed: 1 });
    await s.runStartupEvents();
    const board = s.board;
    const start = (side: number) => board.map.startingPosition(side);
    for (const village of board.map.villages) {
      const expected = distanceBetween(village, start(2)) <= 19 ? 2 : distanceBetween(village, start(1)) <= 7 ? 1 : undefined;
      expect(board.villageOwner(village), String(village)).toBe(expected);
    }
    expect([board.villageCount(1), board.villageCount(2)]).toEqual([2, 6]);
  }, 120_000);
});
