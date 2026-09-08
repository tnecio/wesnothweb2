import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameBoardSnapshot } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';

/**
 * Real-content tests for the new (post-Phase-5 playability feedback)
 * `GameSession` behaviour: running the scenario's real startup events,
 * hotseat end-turn cycling, and recruiting. Loads the actual committed
 * `apps/web/public/scenario-snapshot.json` (real Dead_Water scenario 1
 * data, same file the browser fetches) rather than a synthetic fixture --
 * consistent with this project's general preference for testing against
 * real content over hand-rolled stand-ins wherever practical. Colocated in
 * `src/` (not a separate `test/` dir) because `packages/ui/tsconfig.json`
 * sets `rootDir: "src"` -- see docs/PROGRESS.md's note on the TS6059
 * rootDir/include trap this avoids.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPath = path.join(repoRoot, 'apps/web/public/scenario-snapshot.json');

function loadSnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as GameBoardSnapshot;
}

describe('GameSession.runStartupEvents (real Dead_Water scenario 1)', () => {
  it('spawns the real event-placed units and records real dialogue, and renderUnits reflects them', () => {
    const session = new GameSession(loadSnapshot());
    expect(session.board.allUnits()).toHaveLength(2); // just the two leaders, pre-events

    const messages = session.runStartupEvents();
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.map((m) => m.message).join(' | ')).toContain('Is something wrong, priestess?');

    // More than the two leaders now, and renderUnits resolves a real image
    // for every one of them (not just the two originally in snapshot.units) --
    // this is the fix for event-spawned units having no sprite.
    const rendered = session.renderUnits;
    expect(rendered.length).toBeGreaterThan(2);
    for (const u of rendered) {
      expect(session.snapshot.unitTypes[u.typeId]).toBeDefined();
    }

    // Calling it again is a documented no-op (doesn't double-spawn or re-record).
    const unitCountAfterFirst = session.board.allUnits().length;
    const messagesAgain = session.runStartupEvents();
    expect(messagesAgain).toHaveLength(0);
    expect(session.board.allUnits()).toHaveLength(unitCountAfterFirst);
  });
});

describe('GameSession.endTurn (hotseat cycling)', () => {
  it('cycles active side, increments turnNumber only on wraparound, and refreshes the incoming side\'s moves/attacks', () => {
    const session = new GameSession(loadSnapshot());
    expect(session.activeSide).toBe(1);
    expect(session.turnNumber).toBe(1);

    // Deplete side 1's leader before ending the turn, to prove endTurn's
    // refresh (not just "units start full anyway") is what restores it.
    const leader1 = session.board.unitsForSide(1)[0]!;
    leader1.movesLeft = 0;
    leader1.attacksLeft = 0;

    session.endTurn();
    expect(session.activeSide).toBe(2); // Dead_Water scenario 1 has sides 1 and 2 -- no wrap yet.
    expect(session.turnNumber).toBe(1);
    for (const unit of session.board.unitsForSide(2)) {
      expect(unit.movesLeft).toBe(unit.maxMoves);
      expect(unit.attacksLeft).toBe(unit.maxAttacksPerTurn);
    }
    // Side 1's leader was NOT refreshed by side 2's turn starting.
    expect(leader1.movesLeft).toBe(0);

    session.endTurn();
    expect(session.activeSide).toBe(1); // wrapped past the highest side number (2) back to 1.
    expect(session.turnNumber).toBe(2); // ...which is exactly when the turn counter increments.
    expect(leader1.movesLeft).toBe(leader1.maxMoves);
    expect(leader1.attacksLeft).toBe(leader1.maxAttacksPerTurn);
  });

  it('clears any selection/pending state', () => {
    const session = new GameSession(loadSnapshot());
    const leader1 = session.board.unitsForSide(1)[0]!;
    session.selectUnit(leader1);
    expect(session.selectedUnit).not.toBeNull();
    session.endTurn();
    expect(session.selectedUnit).toBeNull();
  });
});

describe('GameSession recruiting (real recruit.ts actions, real recruit= lists)', () => {
  it('lists the real recruitable types for a leader standing on its keep with a vacant castle tile, and places a real unit there on click', () => {
    const session = new GameSession(loadSnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    expect(leader).toBeDefined();
    expect(session.board.map.isKeep(leader.location)).toBe(true);

    session.selectUnit(leader);
    expect(session.recruitTiles.length).toBeGreaterThan(0);

    const options = session.recruitOptions;
    const team = session.board.getTeam(1)!;
    expect(options.map((o) => o.typeId).sort()).toEqual([...team.canRecruit].sort());
    expect(options.every((o) => o.affordable)).toBe(true); // stub unit-type costs are 0 -- see build-scenario-snapshot.mjs's own doc comment.

    const typeId = options[0]!.typeId;
    const target = session.recruitTiles[0]!;
    const goldBefore = team.gold;
    const unitCountBefore = session.board.allUnits().length;

    session.selectRecruitType(typeId);
    const message = session.handleHexClick(target.x, target.y);

    expect(message).toContain('Recruited');
    expect(session.board.allUnits()).toHaveLength(unitCountBefore + 1);
    const placed = session.board.allUnits().find((u) => u.location.x === target.x && u.location.y === target.y);
    expect(placed?.type.id).toBe(typeId);
    expect(team.gold).toBe(goldBefore - (session.snapshot.unitTypes[typeId]?.cost ?? 0));

    // The just-filled tile is no longer offered.
    expect(session.recruitTiles.some((t) => t.x === target.x && t.y === target.y)).toBe(false);
  });

  it('refuses to recruit when the side cannot afford the unit', () => {
    const session = new GameSession(loadSnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const team = session.board.getTeam(1)!;
    // Real stub unit-type costs are all 0 (see build-scenario-snapshot.mjs),
    // so force an unaffordable situation directly to exercise the gate.
    team.gold = -1;

    const typeId = session.recruitOptions[0]!.typeId;
    const target = session.recruitTiles[0]!;
    const unitCountBefore = session.board.allUnits().length;

    session.selectRecruitType(typeId);
    const message = session.handleHexClick(target.x, target.y);

    expect(message).toMatch(/not enough gold/i);
    expect(session.board.allUnits()).toHaveLength(unitCountBefore);
    expect(team.gold).toBe(-1);
  });

  it('refuses to recruit onto a hex that is not a vacant, connected castle tile', () => {
    const session = new GameSession(loadSnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const typeId = session.recruitOptions[0]!.typeId;
    const unitCountBefore = session.board.allUnits().length;

    session.selectRecruitType(typeId);
    // The leader's own occupied hex is never a valid recruit target.
    const message = session.handleHexClick(leader.location.x, leader.location.y);

    expect(message).toMatch(/cannot recruit/i);
    expect(session.board.allUnits()).toHaveLength(unitCountBefore);
  });
});
