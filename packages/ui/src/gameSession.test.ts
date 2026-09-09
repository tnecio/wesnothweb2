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

// Snapshot paths moved from the old fixed `apps/web/public/scenario-
// snapshot.json` to `apps/web/public/scenarios/<scenario-id>.json` when
// `build-scenario-snapshot.mjs` became generic over which scenario it
// builds (needed for real scenario-to-scenario chaining, see
// `GameSession.startNextScenario`) -- both scenario 1 and 2's real,
// committed snapshots are used below.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/01_Invasion.json');
const nextSnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/02_Flight.json');

function loadSnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as GameBoardSnapshot;
}

function loadNextSnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(nextSnapshotPath, 'utf8')) as GameBoardSnapshot;
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

describe('GameSession.toSaveData / loadSaveData (round-trip, see persistence.ts for the IndexedDB/gzip layer this feeds)', () => {
  it('round-trips turn/side/gold/unit-position/hp/moves state exactly', () => {
    const session = new GameSession(loadSnapshot());
    session.runStartupEvents();

    // Change enough real state that a naive "just rebuild from snapshot" reload would visibly differ.
    session.endTurn(); // side 1 -> side 2
    const team1 = session.board.getTeam(1)!;
    team1.gold = 77;
    const someUnit = session.board.allUnits()[0]!;
    someUnit.hitpoints = Math.max(1, someUnit.hitpoints - 5);
    someUnit.movesLeft = 0;

    const saved = session.toSaveData();
    expect(saved.version).toBe(1);
    expect(saved.units.length).toBe(session.board.allUnits().length);

    // A fresh session (as if the page were reloaded), then load the save into it.
    const reloaded = new GameSession(loadSnapshot());
    reloaded.loadSaveData(saved);

    expect(reloaded.turnNumber).toBe(session.turnNumber);
    expect(reloaded.activeSide).toBe(session.activeSide);
    expect(reloaded.board.getTeam(1)!.gold).toBe(77);
    expect(reloaded.board.allUnits()).toHaveLength(session.board.allUnits().length);
    const reloadedUnit = reloaded.board.unitAt(someUnit.location);
    expect(reloadedUnit?.hitpoints).toBe(someUnit.hitpoints);
    expect(reloadedUnit?.movesLeft).toBe(0);
    expect(reloadedUnit?.type.id).toBe(someUnit.type.id);
  });

  it('round-trips a latched scenarioResult and keeps the loaded session blocked from further input', () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.board.removeUnitAt(kaiKrellis.location);
    // @ts-expect-error -- see the victory/defeat describe block above for why this is called directly.
    session.checkForGameEnd();
    expect(session.scenarioResult).toBe('defeat');

    const saved = session.toSaveData();
    const reloaded = new GameSession(loadSnapshot());
    reloaded.loadSaveData(saved);

    expect(reloaded.scenarioResult).toBe('defeat');
    expect(reloaded.handleHexClick(0, 0)).toBeNull();
    expect(reloaded.endTurn()).toBe('');
  });
});

describe('GameSession victory/defeat (real leader-death check, see checkVictory)', () => {
  it('sets scenarioResult to "defeat" when the player-side leader dies, and blocks further input', () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    expect(session.scenarioResult).toBeNull();

    // Kill the player's leader directly (bypassing combat RNG, which isn't
    // what's under test here) and run the same check confirmAttack() would.
    session.board.removeUnitAt(kaiKrellis.location);
    // @ts-expect-error -- calling the private checkForGameEnd directly is the simplest way to exercise it without fighting real combat RNG for a guaranteed kill.
    session.checkForGameEnd();

    expect(session.scenarioResult).toBe('defeat');
    expect(session.log[0]).toMatch(/defeat/i);

    // The scenario is over -- every mutating entry point should now no-op.
    const unitCountBefore = session.board.allUnits().length;
    expect(session.handleHexClick(0, 0)).toBeNull();
    expect(session.endTurn()).toBe('');
    expect(session.board.allUnits()).toHaveLength(unitCountBefore);
    expect(session.activeSide).toBe(1); // endTurn() no-opped, so this never advanced.
  });

  it('sets scenarioResult to "victory" when the enemy leader dies', () => {
    const session = new GameSession(loadSnapshot());
    const enemyLeader = session.board.unitsForSide(2).find((u) => u.canRecruit)!;

    session.board.removeUnitAt(enemyLeader.location);
    // @ts-expect-error -- see the defeat test above for why this is called directly.
    session.checkForGameEnd();

    expect(session.scenarioResult).toBe('victory');
    expect(session.log[0]).toMatch(/victory/i);
  });

  it('checkForGameEnd is idempotent -- does not overwrite an already-latched result', () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.board.removeUnitAt(kaiKrellis.location);
    // @ts-expect-error -- see above.
    session.checkForGameEnd();
    expect(session.scenarioResult).toBe('defeat');
    const logLengthAfterFirst = session.log.length;

    // @ts-expect-error -- see above.
    session.checkForGameEnd();
    expect(session.scenarioResult).toBe('defeat');
    expect(session.log).toHaveLength(logLengthAfterFirst); // no duplicate log entry.
  });
});

describe('GameSession.nextScenarioId (real next_scenario= chaining)', () => {
  it('reads the real 01_Invasion -> 02_Flight chain, and null for a scenario with none', () => {
    const session = new GameSession(loadSnapshot());
    expect(session.nextScenarioId).toBe('02_Flight');

    const noNext = loadSnapshot();
    delete (noNext.scenarioConfigJson.attrs as Record<string, unknown>)['next_scenario'];
    expect(new GameSession(noNext).nextScenarioId).toBeNull();
  });
});

describe('GameSession.startNextScenario (real 01_Invasion -> 02_Flight gold + recall carryover)', () => {
  it('throws if the finished session did not end in victory', () => {
    const finished = new GameSession(loadSnapshot());
    expect(() => GameSession.startNextScenario(finished, loadNextSnapshot())).toThrow();
  });

  it('carries real gold and real surviving non-leader units into a fresh session on the next scenario', () => {
    const finished = new GameSession(loadSnapshot());
    finished.runStartupEvents(); // spawns Cylanna/Gwabbo/citizens, matching a real playthrough.
    const team1 = finished.board.getTeam(1)!;
    team1.gold = 150; // pin to the same hand-verified number as carryover.test.ts.
    finished.turnNumber = 5;

    // Force a win the same way the victory/defeat describe block above does
    // (bypassing combat RNG, which isn't what's under test here).
    const enemyLeader = finished.board.unitsForSide(2).find((u) => u.canRecruit)!;
    finished.board.removeUnitAt(enemyLeader.location);
    // @ts-expect-error -- calling the private checkForGameEnd directly, same pattern as the victory/defeat tests above.
    finished.checkForGameEnd();
    expect(finished.scenarioResult).toBe('victory');

    const survivingNonLeaders = finished.board.unitsForSide(1).filter((u) => !u.canRecruit);
    expect(survivingNonLeaders.length).toBeGreaterThan(0); // Cylanna, Gwabbo, citizens -- sanity check the fixture actually has some.

    const next = GameSession.startNextScenario(finished, loadNextSnapshot());

    // Same hand-verified gold-carryover result as carryover.test.ts's
    // "matches a hand computation" case (teamGold=150, turn 5): 530 gold.
    expect(next.goldCarryover).not.toBeNull();
    expect(next.goldCarryover!.nextScenarioGold).toBe(530);
    expect(next.board.getTeam(1)!.gold).toBe(530);

    // Every surviving non-leader (Cylanna, Gwabbo, citizens) is now on
    // scenario 2's recall list; Kai Krellis (the leader, inline-re-declared
    // by scenario 2's own {SIDE_1}) is not -- he's freshly placed on the
    // board instead (2's own snapshot.units includes him).
    const recallIds = next.board.recallList(1).map((u) => u.id);
    for (const survivor of survivingNonLeaders) {
      expect(recallIds).toContain(survivor.id);
    }
    expect(recallIds).not.toContain('Kai Krellis');
    expect(next.board.allUnits().some((u) => u.id === 'Kai Krellis')).toBe(true);
  });
});

describe('GameSession recall UI (selectRecallUnit / recallOptions / handleHexClick recall branch)', () => {
  it('offers the real recall list once carried over, and places a recalled unit with its saved hp on click', () => {
    const finished = new GameSession(loadSnapshot());
    finished.runStartupEvents();
    const someSurvivor = finished.board.unitsForSide(1).find((u) => !u.canRecruit)!;
    someSurvivor.hitpoints = 3; // distinct from max, so recall (not recruit) is what's under test -- recall keeps saved hp.
    finished.board.getTeam(1)!.gold = 150;
    finished.turnNumber = 5;
    const enemyLeader = finished.board.unitsForSide(2).find((u) => u.canRecruit)!;
    finished.board.removeUnitAt(enemyLeader.location);
    // @ts-expect-error -- see above.
    finished.checkForGameEnd();

    const next = GameSession.startNextScenario(finished, loadNextSnapshot());
    const leader = next.board.unitsForSide(1).find((u) => u.canRecruit)!;
    next.selectUnit(leader);
    expect(next.recruitTiles.length).toBeGreaterThan(0);

    const options = next.recallOptions;
    const recalled = options.find((o) => o.typeId === someSurvivor.type.id && o.hp === 3);
    expect(recalled).toBeDefined();

    const target = next.recruitTiles[0]!;
    const goldBefore = next.board.getTeam(1)!.gold;
    next.selectRecallUnit(recalled!.index);
    const message = next.handleHexClick(target.x, target.y);

    expect(message).toContain('Recalled');
    const placedUnit = next.board.allUnits().find((u) => u.location.x === target.x && u.location.y === target.y && u.hitpoints === 3);
    expect(placedUnit).toBeDefined();
    expect(next.board.recallList(1)).toHaveLength(options.length - 1);
    expect(next.board.getTeam(1)!.gold).toBe(goldBefore - recalled!.cost);
  });
});
