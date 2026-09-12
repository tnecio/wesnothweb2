import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Location, Unit, getAdjacentTiles, createTypeResolver, type GameBoardSnapshot } from '@wesnothweb2/engine';
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
const economySnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/synth_economy_01.json');
const abilitiesSnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/synth_abilities_01.json');
const wolfCoastSnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/03_Wolf_Coast.json');

/** Real Dead Water scenario 3 -- chained here to exercise `{RECALL_LOYAL_UNITS}` (a real `prestart`-event macro expanding to several `[recall] id=X` calls) against a real recall list carried two scenarios deep. */
function loadWolfCoastSnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(wolfCoastSnapshotPath, 'utf8')) as GameBoardSnapshot;
}

function loadSnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as GameBoardSnapshot;
}

function loadNextSnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(nextSnapshotPath, 'utf8')) as GameBoardSnapshot;
}

/** Real "Economy Debug" synthetic scenario -- gold=40/income=2 (side 1), gold=50/income=1 (side 2), both village_gold=1, one real village at (5,5) -- see synthetic-campaigns/economy/. */
function loadEconomySnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(economySnapshotPath, 'utf8')) as GameBoardSnapshot;
}

/** Real "Abilities & Specials Debug" synthetic scenario -- see synthetic-campaigns/abilities/. */
function loadAbilitiesSnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(abilitiesSnapshotPath, 'utf8')) as GameBoardSnapshot;
}

/**
 * Kai Krellis and Mal-Kevek are real Dead_Water scenario 1 leaders (real
 * stats, real multi-weapon Dark Sorcerer), but aren't adjacent at t=0
 * (opposite corners of the real map) -- repositioned adjacent here so
 * `attackCandidates`/`handleHexClick`'s attack branch has a real target.
 * Shared by the weapon-selection and post-attack-movement test blocks
 * below.
 */
function withAdjacentLeaders(): { session: GameSession; malKevek: import('@wesnothweb2/engine').Unit; kaiKrellis: import('@wesnothweb2/engine').Unit } {
  const session = new GameSession(loadSnapshot());
  const malKevek = session.board.allUnits().find((u) => u.type.id === 'Dark Sorcerer')!;
  const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
  session.board.removeUnitAt(malKevek.location);
  malKevek.location = new Location(kaiKrellis.location.x + 1, kaiKrellis.location.y);
  session.board.addUnit(malKevek);
  return { session, malKevek, kaiKrellis };
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

  it("real, reported bug: Gwabbo's scripted retreat ({MOVE_UNIT id=Gwabbo 20 10}, a [move_unit] action) actually relocates him, using his real Merman Netcaster movement stats end-to-end", () => {
    const session = new GameSession(loadSnapshot());
    session.runStartupEvents();
    const gwabbo = session.board.allUnits().find((u) => u.id === 'Gwabbo')!;
    expect(gwabbo).toBeDefined();
    expect(gwabbo.location.wmlX).toBe(20);
    expect(gwabbo.location.wmlY).toBe(10);
    // A scripted cutscene move, not a player move -- no movement-point cost.
    expect(gwabbo.movesLeft).toBe(gwabbo.maxMoves);
  });

  it("real, reported bug: Gwabbo's first message showed him already at the keep -- messageUnitSnapshot now reflects his real spawn position at that point in the story, not the fully-resolved final board", () => {
    const session = new GameSession(loadSnapshot());
    const messages = session.runStartupEvents();
    const gwabbo = session.board.allUnits().find((u) => u.id === 'Gwabbo')!;
    // Fully resolved: Gwabbo has already retreated to the keep.
    expect(gwabbo.location.wmlX).toBe(20);
    expect(gwabbo.location.wmlY).toBe(10);

    const gwabboMessageIndex = messages.findIndex((m) => m.speaker === 'Gwabbo');
    expect(gwabboMessageIndex).toBeGreaterThan(0);

    // At his OWN message, he's present (his [unit] already ran) but still
    // at his real spawn hex -- the retreat is scripted to happen only
    // after this message, in the same real event body.
    const atOwnMessage = session.messageUnitSnapshot(messages[gwabboMessageIndex]!);
    const gwabboSnapshot = atOwnMessage.find((u) => u.id === 'Gwabbo');
    expect(gwabboSnapshot).toBeDefined();
    expect(gwabboSnapshot!.x).not.toBe(gwabbo.location.x);
    expect(gwabboSnapshot!.y).not.toBe(gwabbo.location.y);

    // Before his own message, he doesn't exist yet at all.
    const beforeHisSpawn = session.messageUnitSnapshot(messages[0]!);
    expect(beforeHisSpawn.some((u) => u.id === 'Gwabbo')).toBe(false);

    // A checkpoint's snapshot carries the same real per-unit fields
    // `renderUnits` does (type/side/abilities/etc are all read straight
    // off the live unit, only position/hp are the captured-at-the-time
    // values) -- not just a bare position.
    expect(gwabboSnapshot!.typeId).toBe('Merman Netcaster');
    expect(gwabboSnapshot!.side).toBe(1);
    expect(gwabboSnapshot!.loyal).toBe(true);
  });
});

describe('GameSession.endTurn (hotseat cycling)', () => {
  it('cycles active side, increments turnNumber only on wraparound, and refreshes the incoming side\'s moves/attacks', () => {
    const session = new GameSession(loadSnapshot());
    // Real Dead_Water scenario 1's side 2 is controller=ai, which -- since
    // this session's AI now really plays automatically (endTurn's own doc
    // comment) -- would otherwise skip straight past side 2 to turn 2 in
    // one endTurn() call. This test is specifically about the underlying
    // hotseat cycling/refresh mechanics (not the AI), so force side 2 back
    // to human to keep testing them step by step in isolation.
    session.board.getTeam(2)!.controller = 'human';
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

describe('GameSession auto-plays controller=ai sides (real Dead_Water scenario 1, side 2 is controller=ai)', () => {
  it('a single endTurn() call from side 1 auto-plays the whole of side 2\'s AI turn and lands back on side 1, turn 2', () => {
    const session = new GameSession(loadSnapshot());
    expect(session.board.getTeam(2)!.controller).toBe('ai'); // sanity: this scenario really does mark side 2 as AI.

    const message = session.endTurn();

    // One endTurn() call skipped straight past side 2 (auto-played) to
    // side 1's next turn, not just to side 2 as the old hotseat-only
    // model would have.
    expect(session.activeSide).toBe(1);
    expect(session.turnNumber).toBe(2);
    expect(message).toContain('Turn 2');
    // The AI's own turn-2 banner line should still be in the log (unshifted
    // before side 1's), proving side 2 actually got a turn in between.
    expect(session.log.some((l) => l.includes('Turn 1') && l.includes('side 2'))).toBe(true);
  });

  it("real, reported bug: AI turns played no animation at all -- endTurn() now sets lastAiAnimations to every real AiAnimationEvent side 2's turn produced", () => {
    const session = new GameSession(loadSnapshot());
    expect(session.lastAiAnimations).toBeNull();

    session.endTurn();

    // Real Dead_Water scenario 1's side 2 leader (Mal-Kevek) starts with
    // real movement and no reachable target turn 1 -- the movement
    // fallback should always find SOMETHING to do (advance toward the
    // distant Kai Krellis), so this is a real, non-vacuous check of the
    // end-to-end wiring (endTurn -> playAiSide -> playAiTurn's real
    // animation field), not just "didn't crash".
    expect(session.lastAiAnimations).not.toBeNull();
    expect(session.lastAiAnimations!.length).toBeGreaterThan(0);
    for (const event of session.lastAiAnimations!) {
      expect(['move', 'attack', 'recruit']).toContain(event.kind);
    }
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

  it('real, reported bug: recruiting never played any animation -- sets lastRecruitAnimation to the new unit + the recruiting leader', () => {
    const session = new GameSession(loadSnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const typeId = session.recruitOptions[0]!.typeId;
    const target = session.recruitTiles[0]!;

    expect(session.lastRecruitAnimation).toBeNull();
    session.selectRecruitType(typeId);
    session.handleHexClick(target.x, target.y);

    expect(session.lastRecruitAnimation).not.toBeNull();
    expect(session.lastRecruitAnimation!.leader).toBe(leader);
    expect(session.lastRecruitAnimation!.unit.location.x).toBe(target.x);
    expect(session.lastRecruitAnimation!.unit.location.y).toBe(target.y);
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

  it('carries a recall-list survivor through a SECOND scenario transition even if never recalled in between, and a real prestart {RECALL_LOYAL_UNITS} macro places it on the board via the real [recall] action -- regression for a real dropped-hero bug', () => {
    // Scenario 1 -> 2, exactly as the test above, forcing victory the same way.
    const scenario1 = new GameSession(loadSnapshot());
    scenario1.runStartupEvents();
    scenario1.board.getTeam(1)!.gold = 150;
    scenario1.turnNumber = 5;
    const enemy1Leader = scenario1.board.unitsForSide(2).find((u) => u.canRecruit)!;
    scenario1.board.removeUnitAt(enemy1Leader.location);
    // @ts-expect-error -- calling the private checkForGameEnd directly, same pattern as the other victory-forcing tests in this file.
    scenario1.checkForGameEnd();
    expect(scenario1.scenarioResult).toBe('victory');

    const scenario2 = GameSession.startNextScenario(scenario1, loadNextSnapshot());
    const recallIdsIntoScenario2 = scenario2.board.recallList(1).map((u) => u.id);
    expect(recallIdsIntoScenario2.length).toBeGreaterThan(0); // sanity: scenario 2 really does start with survivors on its recall list.

    // Force scenario 2's own victory WITHOUT ever recalling anyone -- the
    // whole point of this test is what happens to a recall-list survivor
    // that sits untouched through an entire scenario. Real scenario 2 has
    // THREE enemy sides (2/3/4, all "bad guys"), not just one -- every
    // leader must fall for checkVictory to actually end the scenario.
    for (const side of scenario2.board.teams().map((t) => t.side)) {
      if (side === 1) continue;
      for (const leader of scenario2.board.unitsForSide(side).filter((u) => u.canRecruit)) {
        scenario2.board.removeUnitAt(leader.location);
      }
    }
    // @ts-expect-error -- see above.
    scenario2.checkForGameEnd();
    expect(scenario2.scenarioResult).toBe('victory');

    const scenario3 = GameSession.startNextScenario(scenario2, loadWolfCoastSnapshot());
    const recallIdsIntoScenario3 = scenario3.board.recallList(1).map((u) => u.id);
    // The real bug this regresses: before computeCarryoverRecruits also
    // scanned board.recallList (not just board.unitsForSide), this list
    // would have been empty here -- every one of scenario 2's un-recalled
    // survivors would have silently vanished.
    for (const id of recallIdsIntoScenario2) {
      expect(recallIdsIntoScenario3).toContain(id);
    }

    // Real Dead Water scenario 3 fires `{RECALL_LOYAL_UNITS}` at prestart
    // (see synthetic-campaigns-adjacent apps/web/scripts' real WML, or
    // wesnoth/data/campaigns/Dead_Water/scenarios/03_Wolf_Coast.cfg
    // directly) -- a real macro expanding to `[recall] id=Cylanna [/recall]`
    // etc. This exercises that through the real event pump, the real
    // [recall] action handler, and the real checkRecruitLocation/recallUnit
    // placement logic, not a synthetic fixture.
    scenario3.runStartupEvents();
    const recallIdsAfterPrestart = scenario3.board.recallList(1).map((u) => u.id);
    // Named heroes only (`id !== ''`) -- an empty id is ambiguous (several
    // anonymous citizens share it), so it can't tell a real [recall]
    // placement apart from an ordinary same-scenario board unit.
    const placedFromRecall = scenario3.board.unitsForSide(1).filter((u) => u.id !== '' && recallIdsIntoScenario3.includes(u.id));
    expect(placedFromRecall.length).toBeGreaterThan(0);
    // Whichever named heroes {RECALL_LOYAL_UNITS} successfully placed are no
    // longer on the recall list (removed by the real [recall] handler).
    for (const placed of placedFromRecall) {
      expect(recallIdsAfterPrestart).not.toContain(placed.id);
    }
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
    // Real, reported bug: recalling never played any animation either
    // (real Wesnoth's actions::place_recruit -- and its unit_recruited
    // animation call -- handles recruit and recall identically).
    expect(next.lastRecruitAnimation).not.toBeNull();
    expect(next.lastRecruitAnimation!.leader).toBe(leader);
    expect(next.lastRecruitAnimation!.unit).toBe(placedUnit);
  });
});

describe('GameSession weapon selection (attackerWeaponOptions / selectAttackerWeapon)', () => {
  it('offers every usable weapon for a real multi-weapon attacker (Dark Sorcerer: staff/chill wave/shadow wave), defaulting to the first', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    expect(malKevek.attacks.length).toBeGreaterThan(1); // real content: 3 real weapons.

    session.selectUnit(malKevek);
    expect(session.attackCandidates).toContain(kaiKrellis);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);

    const options = session.attackerWeaponOptions;
    expect(options.length).toBe(malKevek.attacks.length);
    expect(options.map((o) => o.name)).toEqual(malKevek.attacks.map((a) => a.name));
    expect(options[0]!.selected).toBe(true);
    expect(options.filter((o) => o.selected)).toHaveLength(1);
    expect(session.pendingAttack!.attackerWeaponIndex).toBe(0);
  });

  it('selectAttackerWeapon switches the pending preview to a real, different weapon\'s real stats', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);

    const secondWeapon = malKevek.attacks[1]!;
    session.selectAttackerWeapon(1);

    expect(session.pendingAttack!.attackerWeaponIndex).toBe(1);
    // numAttacks (strike count) isn't modified by combat conditions, unlike
    // damagePerBlow (real resistance/time-of-day adjustments -- see
    // combatStats.ts -- can legitimately differ from the weapon's own raw
    // `damage`, so that's not asserted exactly here).
    expect(session.pendingAttack!.preview.attacker.numBlows).toBe(secondWeapon.numAttacks);
    expect(session.pendingAttack!.preview.attacker.damagePerBlow).toBeGreaterThan(0);
    expect(session.attackerWeaponOptions.find((o) => o.index === 1)!.selected).toBe(true);
    expect(session.attackerWeaponOptions.find((o) => o.index === 0)!.selected).toBe(false);
  });

  it('ignores an out-of-range weapon index (no crash, no change)', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);

    const before = session.pendingAttack!.attackerWeaponIndex;
    session.selectAttackerWeapon(99);
    expect(session.pendingAttack!.attackerWeaponIndex).toBe(before);
  });

  it('returns an empty list when there is no pending attack', () => {
    const session = new GameSession(loadSnapshot());
    expect(session.attackerWeaponOptions).toEqual([]);
  });
});

describe('GameSession.confirmAttack zeroes the attacker\'s movement (real Wesnoth: attacking ends a unit\'s move)', () => {
  it('sets movesLeft to 0 after a real attack, even though the attacker never moved and had full movement left', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    expect(malKevek.movesLeft).toBe(malKevek.maxMoves); // hasn't moved this turn.
    expect(malKevek.movesLeft).toBeGreaterThan(0);

    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    expect(session.pendingAttack).not.toBeNull();
    session.confirmAttack();

    expect(malKevek.movesLeft).toBe(0);
  });

  it('deselects the attacker after confirming, so its (now zeroed) reachable set is not offered until re-selected', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    session.confirmAttack();

    expect(session.selectedUnit).toBeNull();
    expect(session.reachable).toEqual([]);

    // Re-selecting the same unit shows it correctly has nowhere left to move.
    session.selectUnit(malKevek);
    expect(session.reachable).toEqual([]);
  });

  it('does not touch movesLeft when the attacker died in the exchange (nothing left to zero)', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    // Force a guaranteed kill of the attacker by zeroing its hp pre-combat --
    // executeAttack's own RNG still runs, so instead just assert the guard
    // doesn't throw/misbehave when attackerDied is true, using a very low-hp
    // attacker against Kai Krellis's real damage to make death overwhelmingly
    // likely, and only assert the non-crashing/consistent-state outcome
    // (this project doesn't have a way to force RNG results in GameSession
    // itself, see combat.test.ts for where deterministic RNG is exercised).
    malKevek.hitpoints = 1;
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const message = session.confirmAttack();
    expect(message).not.toBeNull();
    // Whether or not malKevek actually died this particular RNG draw, the
    // session must not have thrown and must be in a consistent state.
    expect(session.selectedUnit).toBeNull();
  });
});

describe('GameSession.confirmAttack logs one line per real blow, not just a summary', () => {
  it('adds exactly one log line per AttackBlowResult, each naming the real striker/target, plus the summary line on top', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const logLengthBefore = session.log.length;

    session.confirmAttack();

    // At least one blow always happens (both combatants have >0 numAttacks
    // in this real matchup); the exact count depends on strike counts and
    // firststrike/berserk, not asserted here -- see combat.test.ts for
    // that. What's under test is that every blow got its own line.
    const addedLines = session.log.length - logLengthBefore;
    expect(addedLines).toBeGreaterThan(1); // summary line + at least one blow line.

    // The summary is unshifted LAST, so it's the newest entry (index 0);
    // the blow lines fill indices 1..addedLines-1, oldest blow furthest down.
    expect(session.log[0]).toMatch(/attacked .+ blows landed/);
    const blowLines = session.log.slice(1, addedLines);
    expect(blowLines.length).toBeGreaterThan(0);
    for (const line of blowLines) {
      // Every blow line names one of the two real combatants as striker and the other as target, and states hit/miss with a real % chance.
      expect(line).toMatch(/% chance to hit\)\.?/);
      expect(line.includes(malKevek.type.name) || line.includes(kaiKrellis.type.name) || /misses|hits/.test(line)).toBe(true);
    }
  });

  it('a hit line reports real, non-negative damage; a miss line reports zero implicitly (no "for N damage" clause)', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    session.confirmAttack();

    const blowLines = session.log.filter((l) => /% chance to hit\)/.test(l) && !/attacked .+ blows landed/.test(l));
    expect(blowLines.length).toBeGreaterThan(0);
    for (const line of blowLines) {
      if (line.includes(' hits ')) {
        const match = line.match(/for (\d+) damage/);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeGreaterThanOrEqual(0);
      } else {
        expect(line).toMatch(/ misses /);
        expect(line).not.toMatch(/for \d+ damage/);
      }
    }
  });
});

describe('GameSession.currentTimeOfDay (real [time] schedule, threaded into real combat)', () => {
  it('reads the real Dead Water scenario 1 default schedule, advancing by real game turn as endTurn wraps', () => {
    const session = new GameSession(loadSnapshot());
    // Side 2 is controller=ai; force it back to human here to test ToD's
    // per-turn (not per-side) progression step by step, independent of
    // the AI auto-play feature (covered separately -- see "GameSession
    // auto-plays controller=ai sides" below).
    session.board.getTeam(2)!.controller = 'human';
    expect(session.currentTimeOfDay.id).toBe('dawn'); // turn 1, current_time defaults to 0.
    expect(session.currentTimeOfDay.lawfulBonus).toBe(0);

    session.endTurn(); // -> side 2, still turn 1.
    expect(session.currentTimeOfDay.id).toBe('dawn'); // ToD is per-turn, not per-side -- unchanged mid-turn-1.

    session.endTurn(); // wraps -> turn 2.
    expect(session.currentTimeOfDay.id).toBe('morning');
    expect(session.currentTimeOfDay.lawfulBonus).toBe(25); // real value, see Schedule.test.ts.
  });

  it('a lawful attacker deals more real damage during a lawful-favoring phase than during a neutral one, all else equal', () => {
    // Same real matchup (Kai Krellis, lawful, vs Mal-Kevek adjacent),
    // compared at turn 1 (dawn, lawful_bonus=0) vs turn 2 (morning,
    // lawful_bonus=25) -- buildPreview's real combatModifier() should
    // reflect the schedule difference in the predicted damage per blow.
    const { session: dawnSession, malKevek: dawnMalKevek, kaiKrellis: dawnKaiKrellis } = withAdjacentLeaders();
    dawnSession.selectUnit(dawnKaiKrellis);
    dawnSession.handleHexClick(dawnMalKevek.location.x, dawnMalKevek.location.y);
    const dawnDamage = dawnSession.pendingAttack!.preview.attacker.damagePerBlow;

    const { session: morningSession, malKevek, kaiKrellis } = withAdjacentLeaders();
    // Side 2 (Mal-Kevek's) is controller=ai -- force it to human so the AI
    // doesn't itself attack with the now-adjacent Mal-Kevek before this
    // test gets to manually preview Kai Krellis's attack on him.
    morningSession.board.getTeam(2)!.controller = 'human';
    morningSession.endTurn();
    morningSession.endTurn(); // -> turn 2, morning, lawful_bonus=25.
    expect(morningSession.currentTimeOfDay.id).toBe('morning');
    morningSession.activeSide = 1; // Kai Krellis's side, so selecting/attacking with him is allowed regardless of whose turn endTurn() left active.
    morningSession.selectUnit(kaiKrellis);
    morningSession.handleHexClick(malKevek.location.x, malKevek.location.y);
    const morningDamage = morningSession.pendingAttack!.preview.attacker.damagePerBlow;

    expect(morningDamage).toBeGreaterThan(dawnDamage);
  });
});

describe('GameSession income/upkeep/village economy (real synth_economy_01: gold=40/income=2/village_gold=1)', () => {
  /**
   * Real Wesnoth's `play_controller.cpp`: `if (turn() > 1) { current_team()
   * .new_turn(); ... }` -- the whole game's first turn (every side's very
   * first go) grants no income and charges no upkeep; from turn 2 onward, a
   * side's gold changes the moment ITS turn begins (not at the end of the
   * turn before it). `team::new_turn` is `gold += total_income()` where
   * `total_income() = base_income() + villages*village_gold`, and
   * `base_income() = income= (raw WML, 2 here) + game_config::base_income`
   * (a hardcoded 2). See `GameSession.endTurn`'s own doc comment for the
   * full derivation, cited directly against `wesnoth/src/game_config.cpp`/
   * `play_controller.cpp`/`team.cpp`.
   */
  it('grants no income/upkeep on turn 1, but applies real total_income the moment turn 2 begins', () => {
    const session = new GameSession(loadEconomySnapshot());
    expect(session.activeSide).toBe(1);
    expect(session.turnNumber).toBe(1);
    expect(session.board.getTeam(1)!.gold).toBe(40);
    expect(session.economyInfo.netIncome).toBe(0); // turn 1: no preview yet, matching "no income applied yet".

    session.endTurn(); // -> side 2, still turn 1.
    expect(session.turnNumber).toBe(1);
    expect(session.board.getTeam(2)!.gold).toBe(50); // untouched -- still turn 1.

    session.endTurn(); // wraps -> side 1, turn 2 begins: side 1's income now applies.
    expect(session.turnNumber).toBe(2);
    expect(session.activeSide).toBe(1);
    // total_income = income(2) + base_income(2) + 0 villages*1 = 4. No units
    // beyond the (upkeep-free) leader, so no upkeep expense.
    expect(session.board.getTeam(1)!.gold).toBe(40 + 4);

    session.endTurn(); // -> side 2, still turn 2: side 2's income now applies too.
    expect(session.activeSide).toBe(2);
    expect(session.turnNumber).toBe(2);
    // total_income = income(1) + base_income(2) + 0 villages*1 = 3.
    expect(session.board.getTeam(2)!.gold).toBe(50 + 3);
  });

  it('economyInfo previews startGold/incomePerVillage always, and netIncome only once turnNumber > 1', () => {
    const session = new GameSession(loadEconomySnapshot());
    expect(session.economyInfo).toEqual({ startGold: 40, incomePerVillage: 1, villagesOwned: 0, netIncome: 0 });

    session.endTurn();
    session.endTurn(); // now turn 2, side 1 active -- income already applied by endTurn itself.
    expect(session.economyInfo.startGold).toBe(40); // startGold never changes, unlike current gold.
    expect(session.economyInfo.netIncome).toBe(4); // matches what just got applied (previewing the NEXT turn's income, which happens to equal this turn's since nothing changed).
  });

  it('walking a unit onto a real village (real executeMove -> GameBoard.captureVillage) captures it, and the next turn\'s income reflects the extra village_gold', () => {
    const session = new GameSession(loadEconomySnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    const villageLoc = session.board.map.villages[0]!;
    expect(session.board.villageOwner(villageLoc)).toBeUndefined();

    // Real click-driven move (handleHexClick's select-then-move branch),
    // not a direct board mutation -- proves the actual UI glue path
    // (GameSession -> executeMove -> GameBoard.captureVillage) captures
    // the village, not just the isolated engine action in move.test.ts.
    session.selectUnit(leader);
    expect(session.reachable.some((h) => h.x === villageLoc.x && h.y === villageLoc.y)).toBe(true);
    session.handleHexClick(villageLoc.x, villageLoc.y);

    expect(leader.location.equals(villageLoc)).toBe(true);
    expect(session.board.villageOwner(villageLoc)).toBe(1);
    expect(session.economyInfo.villagesOwned).toBe(1);

    session.endTurn();
    session.endTurn(); // turn 2, side 1's income now includes the captured village.
    // total_income = income(2) + base_income(2) + 1 village*1 = 5.
    expect(session.board.getTeam(1)!.gold).toBe(40 + 5);
  });

  it('upkeep charges gold for unit levels beyond what owned villages support, mirroring play_controller\'s expense = side_upkeep - support', () => {
    const session = new GameSession(loadEconomySnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    // Recruit a real level-1 Spearman (cost 14g, matching synthetic-
    // campaigns/economy's own recruit= list) -- its upkeep (its level, 1,
    // since it's not a leader) isn't covered by any owned village (0 owned).
    session.selectUnit(leader);
    session.selectRecruitType('Spearman');
    const recruitTile = session.recruitTiles[0]!;
    session.handleHexClick(recruitTile.x, recruitTile.y);
    expect(session.board.getTeam(1)!.gold).toBe(40 - 14);

    session.endTurn();
    session.endTurn(); // turn 2, side 1's turn: income(2)+base(2)+0 villages = 4, upkeep = 1 level - 0 support = 1 expense.
    expect(session.board.getTeam(1)!.gold).toBe(40 - 14 + 4 - 1);
  });
});

describe('GameSession.endTurn applies real healing (rest/heals-ability/poison) -- previously a no-op gap on top of a real healer-detection bug', () => {
  it("real Cylanna (a Mermaid Priestess, abilities_list=heals_8,cures) actually heals a damaged adjacent ally's HP on endTurn -- regression for both the missing endTurn healing call and the id-vs-tag ability-matching bug", () => {
    const session = new GameSession(loadSnapshot());
    session.runStartupEvents();
    const cylanna = session.board.allUnits().find((u) => u.id === 'Cylanna')!;
    expect(cylanna).toBeDefined();
    expect(cylanna.type.abilities.some((a) => a.tag === 'heals')).toBe(true); // sanity: the ability-matching fix itself.

    const kaiKrellis = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    // Real spawn positions place Kai Krellis and Cylanna adjacent already
    // (confirmed by inspection); assert it rather than assume, so this
    // test fails clearly instead of silently passing for the wrong reason
    // if a future content change moves them apart.
    expect(getAdjacentTiles(cylanna.location).some((loc) => loc.equals(kaiKrellis.location))).toBe(true);

    kaiKrellis.hitpoints = kaiKrellis.maxHitpoints - 20;
    const hpBefore = kaiKrellis.hitpoints;

    // Side 2 is controller=ai -- force it to human so this healing-focused
    // test isn't coupled to whatever the AI decides to do with Mal-Kevek
    // in between (e.g. moving him within reach of Kai Krellis).
    session.board.getTeam(2)!.controller = 'human';
    // Cycle back around to side 1's turn -- endTurn's own doc comment on
    // why healing (unlike income) isn't gated on turnNumber > 1: real
    // Wesnoth's do_healing() flag exempts only the very first side-turn
    // of the whole game, which this session already started in (before
    // any endTurn() call) -- side 2's turn (the first endTurn() call
    // below) already gets a real healing pass.
    session.endTurn(); // -> side 2.
    session.endTurn(); // -> side 1 again, turn 2: Cylanna's real heals ability should now fire for real.

    expect(kaiKrellis.hitpoints).toBeGreaterThan(hpBefore);
    expect(kaiKrellis.hitpoints).toBe(Math.min(kaiKrellis.maxHitpoints, hpBefore + 8)); // real heals_8 value.
    expect(session.log.some((l) => l.includes('heals 8 HP') && l.includes('Cylanna'))).toBe(true);
  });
});

describe('GameSession.unitInfo (real, reported bug: UI missing weapon type/abilities info)', () => {
  it("Kai Krellis' real single melee weapon (scepter/impact) shows up with type/range, and he has no abilities", () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const info = session.unitInfo(kaiKrellis);

    expect(info.attacks).toHaveLength(1);
    expect(info.attacks[0]!.name).toBe('scepter');
    expect(info.attacks[0]!.type).toBe('impact');
    expect(info.attacks[0]!.range).toBe('melee');
    expect(info.abilities).toEqual([]);
  });

  it('real, reported bug: XP is not present in the unit infobox -- unitInfo now reports the unit\'s real experience/maxExperience', () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    kaiKrellis.experience = 3;
    const info = session.unitInfo(kaiKrellis);

    expect(info.xp).toBe(3);
    expect(info.maxXp).toBe(kaiKrellis.maxExperience);
    expect(info.maxXp).toBeGreaterThan(0);
  });

  it("real Cylanna's abilities_list=heals_8,cures resolve to real player-facing names, not just tag ids", () => {
    const session = new GameSession(loadSnapshot());
    session.runStartupEvents();
    const cylanna = session.board.allUnits().find((u) => u.id === 'Cylanna')!;
    const info = session.unitInfo(cylanna);

    expect(info.abilities.length).toBeGreaterThanOrEqual(2);
    const names = info.abilities.map((a) => a.name);
    expect(names).toContain('heals +8');
    expect(names).toContain('cures');
    // Every real ability carries a real, non-empty description (the whole point of showing it in the UI).
    for (const a of info.abilities) expect(a.description.length).toBeGreaterThan(0);
  });

  it("Mal-Kevek's real 3 weapons (staff/chill wave/shadow wave) each report their real type and range", () => {
    const { session, malKevek } = withAdjacentLeaders();
    const info = session.unitInfo(malKevek);

    expect(info.attacks).toHaveLength(3);
    const byName = Object.fromEntries(info.attacks.map((a) => [a.name, a]));
    expect(byName['staff']).toMatchObject({ type: 'impact', range: 'melee' });
    expect(byName['chill wave']).toMatchObject({ type: 'cold', range: 'ranged' });
    expect(byName['shadow wave']).toMatchObject({ type: 'arcane', range: 'ranged' });
  });
});

describe('GameSession unit inspection (real, reported bug: no way to see information about enemy units)', () => {
  it('clicking an enemy that is NOT an attack target (nothing of mine selected) inspects it without selecting/acting on it', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    // No unit selected yet.
    session.handleHexClick(malKevek.location.x, malKevek.location.y);

    expect(session.inspectedUnit).toBe(malKevek);
    expect(session.selectedUnit).toBeNull(); // enemy click never selects for movement/action
    expect(session.unitInfo(session.inspectedUnit!).name).toBe(session.unitDisplayName(malKevek));
  });

  it('clicking a non-attackable enemy while my own unit is selected inspects it WITHOUT disturbing the current selection/highlights', () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const malKevek = session.board.allUnits().find((u) => u.type.id === 'Dark Sorcerer')!;
    // Real content: not adjacent at t=0 -- so clicking Mal-Kevek here hits
    // the "enemy, but not an attack candidate" branch, not the attack branch.
    session.selectUnit(kaiKrellis);
    const reachableBefore = session.reachable;

    const result = session.handleHexClick(malKevek.location.x, malKevek.location.y);

    expect(session.inspectedUnit).toBe(malKevek);
    expect(session.selectedUnit).toBe(kaiKrellis); // untouched
    expect(session.reachable).toEqual(reachableBefore); // untouched
    expect(result).toContain('Mal-Kevek');
  });

  it('selecting a different unit of mine clears any prior inspection', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.handleHexClick(malKevek.location.x, malKevek.location.y);
    expect(session.inspectedUnit).toBe(malKevek);

    session.selectUnit(kaiKrellis);
    expect(session.inspectedUnit).toBeNull();
  });

  it('clicking empty ground with nothing selected clears any prior inspection', () => {
    const { session, malKevek } = withAdjacentLeaders();
    session.handleHexClick(malKevek.location.x, malKevek.location.y);
    expect(session.inspectedUnit).toBe(malKevek);

    // Any real empty hex on the map -- (0, 0) is off-board/water on this map, just needs to have no unit.
    const emptyLoc = new Location(0, 0);
    expect(session.board.unitAt(emptyLoc)).toBeUndefined();
    session.handleHexClick(emptyLoc.x, emptyLoc.y);
    expect(session.inspectedUnit).toBeNull();
  });
});

describe('CombatPreview/AttackerWeaponOption carry weapon type/range (real, reported bug: melee vs. ranged not shown)', () => {
  it("attackerWeaponOptions reports each real weapon's real type/range", () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);

    const byName = Object.fromEntries(session.attackerWeaponOptions.map((o) => [o.name, o]));
    expect(byName['staff']).toMatchObject({ type: 'impact', range: 'melee' });
    expect(byName['chill wave']).toMatchObject({ type: 'cold', range: 'ranged' });
  });

  it('attacking with a ranged weapon against a defender with only a melee weapon shows NO defender weapon/counter in the preview', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const chillWaveIndex = malKevek.attacks.findIndex((a) => a.name === 'chill wave');
    session.selectAttackerWeapon(chillWaveIndex);

    const preview = session.pendingAttack!.preview;
    expect(preview.attacker.weapon).toMatchObject({ name: 'chill wave', range: 'ranged' });
    expect(preview.defender.weapon).toBeUndefined(); // Kai Krellis' scepter is melee-only -- no counter.
    expect(preview.defender.numBlows).toBe(0);
  });

  it('attacking with the melee weapon against the same defender DOES show a real melee counter-weapon', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const staffIndex = malKevek.attacks.findIndex((a) => a.name === 'staff');
    session.selectAttackerWeapon(staffIndex);

    const preview = session.pendingAttack!.preview;
    expect(preview.attacker.weapon).toMatchObject({ name: 'staff', range: 'melee' });
    expect(preview.defender.weapon).toMatchObject({ name: 'scepter', range: 'melee' });
    expect(preview.defender.numBlows).toBeGreaterThan(0);
  });
});

describe('GameSession.confirmAttack real, reported bug: plague kill did not spawn a Walking Corpse', () => {
  it("Debug Plaguebearer's real specials_list=plague, when it kills the weakened Target Plague (hitpoints=6, one hit from its damage=6 touch attack), spawns a real Walking Corpse on the attacker's side", () => {
    // GameSession has no way to force a hit (see the "does not touch
    // movesLeft when the attacker died" test above for the established
    // precedent) -- so retry across seeds until the (highly likely, since
    // a single hit is lethal here) kill actually happens.
    for (let seed = 0; seed < 200; seed++) {
      const session = new GameSession(loadAbilitiesSnapshot(), { seed });
      const plaguebearer = session.board.allUnits().find((u) => u.id === 'Debug Plaguebearer')!;
      const target = session.board.allUnits().find((u) => u.id === 'Target Plague')!;
      expect(plaguebearer.type.id).toBe('Walking Corpse');
      expect(target.hitpoints).toBe(6);

      session.selectUnit(plaguebearer);
      session.handleHexClick(target.location.x, target.location.y);
      expect(session.pendingAttack).not.toBeNull();
      session.confirmAttack();

      const targetStillThere = session.board.unitAt(target.location);
      if (targetStillThere === target) continue; // target survived this seed's rolls -- try another.

      // Real, reported bug: this used to stay a plain empty hex (GameSession
      // never passed a resolveType into executeAttack, so the plague
      // special's spawn candidate was always reported unresolved).
      const spawned = session.board.unitAt(target.location);
      expect(spawned).toBeDefined();
      expect(spawned!.type.id).toBe('Walking Corpse');
      expect(spawned!.side).toBe(plaguebearer.side);
      return;
    }
    throw new Error('Target Plague never died across 200 seeds -- suspiciously unlucky, or a real regression.');
  });
});

describe('GameSession unit advancement (real, reported bug: advances_to= was never wired up -- a unit could never actually level up)', () => {
  it('a single-option advance (Merman Fighter -> Merman Warrior) happens immediately, with no pending choice', () => {
    const resolveType = createTypeResolver(new GameSession(loadSnapshot()).snapshot);
    const fighterType = resolveType('Merman Fighter');
    const dummyType = resolveType('Merman Citizen');

    // Retry across seeds for a guaranteed hit (same established pattern as
    // the plague test above -- GameSession has no way to force one).
    for (let seed = 0; seed < 50; seed++) {
      const s = new GameSession(loadSnapshot(), { seed });
      const f = Unit.create(fighterType, 1, new Location(10, 10), { canRecruit: false });
      f.experience = f.maxExperience - 1; // one real combat XP gain away from advancing.
      const d = Unit.create(dummyType, 2, new Location(11, 10));
      d.hitpoints = 1;
      s.board.addUnit(f);
      s.board.addUnit(d);
      s.selectUnit(f);
      s.handleHexClick(d.location.x, d.location.y);
      s.confirmAttack();
      if (f.type.id === 'Merman Warrior') {
        expect(s.pendingAdvancement).toBeNull();
        expect(f.hitpoints).toBe(f.maxHitpoints);
        expect(s.log[0]).toContain('advances to Merman Warrior');
        return;
      }
    }
    throw new Error('Fighter never landed a hit across 50 seeds -- suspiciously unlucky, or a real regression.');
  });

  it('a multi-option advance (Merman Citizen -> Brawler/Fighter/Hunter) blocks on pendingAdvancement until the player chooses', () => {
    const resolveType = (session: GameSession) => createTypeResolver(session.snapshot);
    for (let seed = 0; seed < 50; seed++) {
      const s = new GameSession(loadSnapshot(), { seed });
      const rt = resolveType(s);
      const citizenType = rt('Merman Citizen');
      const dummyType = rt('Merman Citizen');
      const citizen = Unit.create(citizenType, 1, new Location(10, 10), { canRecruit: false });
      citizen.experience = citizen.maxExperience - 1;
      const dummy = Unit.create(dummyType, 2, new Location(11, 10));
      dummy.hitpoints = 1;
      s.board.addUnit(citizen);
      s.board.addUnit(dummy);
      s.selectUnit(citizen);
      s.handleHexClick(dummy.location.x, dummy.location.y);
      s.confirmAttack();

      if (s.pendingAdvancement) {
        expect(s.pendingAdvancement.unit).toBe(citizen);
        const optionIds = s.pendingAdvancement.options.map((t) => t.id).sort();
        expect(optionIds).toEqual(['Merman Brawler', 'Merman Fighter', 'Merman Hunter'].sort());

        s.chooseAdvancement('Merman Hunter');
        expect(s.pendingAdvancement).toBeNull();
        expect(citizen.type.id).toBe('Merman Hunter');
        expect(citizen.hitpoints).toBe(citizen.maxHitpoints);
        expect(s.log[0]).toContain('advances to Merman Hunter');
        return;
      }
    }
    throw new Error('Citizen never landed a hit across 50 seeds -- suspiciously unlucky, or a real regression.');
  });
});

describe('GameSession advancement + victory ordering (real, reported bug: a kill that both wins the scenario and levels up the killer left the level-up unreachable)', () => {
  it('a scenario-winning kill still sets pendingAdvancement -- GameSession.confirmAttack checks advancement before checkForGameEnd, matching real Wesnoth', () => {
    const resolveType = createTypeResolver(new GameSession(loadSnapshot()).snapshot);
    const citizenType = resolveType('Merman Citizen');

    for (let seed = 0; seed < 50; seed++) {
      const s = new GameSession(loadSnapshot(), { seed });
      const malKevek = s.board.allUnits().find((u) => u.type.id === 'Dark Sorcerer')!;
      s.board.removeUnitAt(malKevek.location);
      const citizen = Unit.create(citizenType, 1, new Location(malKevek.location.x + 1, malKevek.location.y), { canRecruit: false });
      citizen.experience = citizen.maxExperience - 1;
      s.board.addUnit(citizen);
      malKevek.location = new Location(malKevek.location.x, malKevek.location.y);
      s.board.addUnit(malKevek);
      malKevek.hitpoints = 1;

      s.selectUnit(citizen);
      s.handleHexClick(malKevek.location.x, malKevek.location.y);
      if (!s.pendingAttack) continue; // not adjacent/no valid attack this seed's layout -- try another.
      s.confirmAttack();

      if (s.scenarioResult === 'victory') {
        // The whole point: the win didn't silently skip or discard the
        // pending level-up choice.
        expect(s.pendingAdvancement).not.toBeNull();
        expect(s.pendingAdvancement!.unit).toBe(citizen);

        // Resolving it afterward still works normally, and only THEN is
        // there nothing left blocking the scenario-end overlay.
        const optionId = s.pendingAdvancement!.options[0]!.id;
        s.chooseAdvancement(optionId);
        expect(s.pendingAdvancement).toBeNull();
        expect(citizen.type.id).toBe(optionId);
        return;
      }
    }
    throw new Error('Never landed the winning blow across 50 seeds -- suspiciously unlucky, or a real regression.');
  });
});
