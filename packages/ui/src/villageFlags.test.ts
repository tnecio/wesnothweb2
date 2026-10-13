/**
 * Phase 27c S8: village flags as `display::get_flag` shows them -- the current owner's, but none for an
 * enemy's village under fog, and none under shroud.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshot = () => readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/fog/synth_fog_01.json'));

describe('village flags under fog and shroud', () => {
  it("shows its own and an enemy's in view, an own one under fog, but not an enemy's under fog nor any under shroud", async () => {
    const session = new GameSession(snapshot());
    await session.runStartupEvents();
    const board = session.board;
    const side = session.viewingSide;
    const enemy = board.teams().find((t) => t.side !== side)!.side;
    const villages = board.map.villages;
    const where = (pred: (loc: (typeof villages)[number]) => boolean) => villages.find(pred);
    const shrouded = where((l) => board.isShrouded(side, l));
    expect(shrouded).toBeDefined();
    // Clear the shroud of one village, leaving it fogged, and give it to the enemy, then to us.
    board.getTeam(side)!.clearShroud(shrouded!);
    expect(board.isShrouded(side, shrouded!)).toBe(false);
    expect(board.isFogged(side, shrouded!)).toBe(true);
    board.captureVillage(shrouded!, enemy);
    expect(session.villageOwnership.some((v) => v.x === shrouded!.x && v.y === shrouded!.y)).toBe(false);
    board.captureVillage(shrouded!, side);
    expect(session.villageOwnership).toContainEqual({ x: shrouded!.x, y: shrouded!.y, side });
    // A shrouded one shows nothing, whoever owns it.
    const stillShrouded = where((l) => board.isShrouded(side, l) && !l.equals(shrouded!));
    if (stillShrouded) {
      board.captureVillage(stillShrouded, side);
      expect(session.villageOwnership.some((v) => v.x === stillShrouded.x && v.y === stillShrouded.y)).toBe(false);
    }
  });
});
