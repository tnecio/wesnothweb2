import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Location, type GameBoardSnapshot } from '@wesnothweb2/engine';
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
