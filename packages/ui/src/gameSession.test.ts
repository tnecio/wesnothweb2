import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  Location,
  Unit,
  Direction,
  WmlConfig,
  getAdjacentTiles,
  ALL_DIRECTIONS,
  directionBetween,
  distanceBetween,
  parseConfig,
  isBackstabActive,
  createTypeResolver,
  type GameBoardSnapshot,
  type CutsceneBeat,
  type WmlConfigJson,
} from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

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
// committed snapshots are used below. Phase 21: nested one level further
// under each campaign's own directory (`CampaignInfo.assetDir`), since a
// bare scenario id is only unique within its own campaign (Dead Water and
// Under the Burning Suns both ship a `13_Epilogue`, used below too).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');
const nextSnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/02_Flight.json');
const economySnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/economy/synth_economy_01.json');
const abilitiesSnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/abilities/synth_abilities_01.json');
const wolfCoastSnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/03_Wolf_Coast.json');
const utbsTimeAreaSnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/Under_the_Burning_Suns/03_Stirring_in_the_Night.json');
const combatSnapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/combat/synth_combat_01.json');

/** Real Dead Water scenario 3 -- chained here to exercise `{RECALL_LOYAL_UNITS}` (a real `prestart`-event macro expanding to several `[recall] id=X` calls) against a real recall list carried two scenarios deep. */
function loadWolfCoastSnapshot(): GameBoardSnapshot {
  return readScenarioSnapshot(wolfCoastSnapshotPath);
}

/** Real Under the Burning Suns scenario 3 -- its real prestart event declares a `[time_area] id=campfires x=14,16,13 y=10,15,20 radius=2` covering three campfire clusters with their own always-dawn-lit schedule (Phase 12's `[time_area]` testbed). */
function loadUtbsTimeAreaSnapshot(): GameBoardSnapshot {
  return readScenarioSnapshot(utbsTimeAreaSnapshotPath);
}

function loadSnapshot(): GameBoardSnapshot {
  return readScenarioSnapshot(snapshotPath);
}

function loadNextSnapshot(): GameBoardSnapshot {
  return readScenarioSnapshot(nextSnapshotPath);
}

/** Real "Economy Debug" synthetic scenario -- gold=40/income=2 (side 1), gold=50/income=1 (side 2), both village_gold=1, one real village at (5,5) -- see synthetic-campaigns/economy/. */
function loadEconomySnapshot(): GameBoardSnapshot {
  return readScenarioSnapshot(economySnapshotPath);
}

/** Real "Abilities & Specials Debug" synthetic scenario -- see synthetic-campaigns/abilities/. */
function loadAbilitiesSnapshot(): GameBoardSnapshot {
  return readScenarioSnapshot(abilitiesSnapshotPath);
}

/**
 * Real "Combat Debug" synthetic scenario -- two adjacent leaders, plus (as
 * of Phase 14) a real `[set_menu_item] id=reset_hp` `prestart` event whose
 * `[command]` is a real `[heal_unit]` with no `[filter]` (so it heals
 * whichever unit is at the right-clicked hex) -- see
 * synthetic-campaigns/combat/scenarios/01_combat.cfg.
 */
function loadCombatSnapshot(): GameBoardSnapshot {
  return readScenarioSnapshot(combatSnapshotPath);
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

/**
 * Phase 17: collects every cutscene beat the session hands to the
 * display (and answers each one immediately, as a display that had
 * finished playing it would).
 */
function recordBeats(session: GameSession): CutsceneBeat[] {
  const beats: CutsceneBeat[] = [];
  session.interactionHost = {
    async handle(interaction) {
      if (interaction.kind === 'beat') beats.push(interaction.beat);
      return {};
    },
  };
  return beats;
}

describe('GameSession.runStartupEvents (real Dead_Water scenario 1)', () => {
  it('spawns the real event-placed units and records real dialogue, and renderUnits reflects them', async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.board.allUnits()).toHaveLength(2); // just the two leaders, pre-events

    const messages = await session.runStartupEvents();
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
    const messagesAgain = await session.runStartupEvents();
    expect(messagesAgain).toHaveLength(0);
    expect(session.board.allUnits()).toHaveLength(unitCountAfterFirst);
  });

  it('real, reported bug: unit sprites always rendered in raw magenta instead of the unit\'s side color -- renderUnits now carries each unit\'s real flag_rgb (defaulting to "magenta") for SnapshotBoard to recolor with', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.renderUnits.find((u) => u.id === 'Kai Krellis')!;
    expect(kaiKrellis.flagRgb).toBe('magenta'); // real Merman Child King unit_type sets no flag_rgb= override
  });

  it("real, reported bug: Gwabbo's scripted retreat ({MOVE_UNIT id=Gwabbo 20 10}, a [move_unit] action) actually relocates him, using his real Merman Netcaster movement stats end-to-end", async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    const gwabbo = session.board.allUnits().find((u) => u.id === 'Gwabbo')!;
    expect(gwabbo).toBeDefined();
    expect(gwabbo.location.wmlX).toBe(20);
    expect(gwabbo.location.wmlY).toBe(10);
    // A scripted cutscene move, not a player move -- no movement-point cost.
    expect(gwabbo.movesLeft).toBe(gwabbo.maxMoves);
  });

  it('real, reported bug: no in-game dialog ever showed the scenario objectives -- runStartupEvents now sets scenarioObjectives from the real [objectives] in the scenario', async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.scenarioObjectives).toBeNull();
    await session.runStartupEvents();

    const objectives = session.scenarioObjectives;
    expect(objectives).not.toBeNull();
    expect(objectives!.objectives).toContainEqual({ description: 'Defeat enemy leader', condition: 'win', showTurnCounter: false });
    expect(objectives!.objectives).toContainEqual({ description: 'Turns run out', condition: 'lose', showTurnCounter: true });
    expect(objectives!.goldCarryover).toEqual([{ bonus: true, carryoverPercentage: 40 }]);
  });

  it("real, reported bug: Gwabbo's first message showed him already at the keep -- the event now stops at each line, so the live board is simply right at that moment", async () => {
    const session = new GameSession(loadSnapshot());
    const boardAtEachLine: Array<{ speaker: string; gwabboAt: string | null }> = [];
    // Phase 17: standing in for the player, answering each line as it is
    // reached -- exactly how `GameShell` drives it.
    session.interactionHost = {
      async handle(interaction) {
        if (interaction.kind === 'message') {
          const gwabbo = session.board.allUnits().find((u) => u.id === 'Gwabbo');
          boardAtEachLine.push({
            speaker: interaction.message.speaker,
            gwabboAt: gwabbo ? `${gwabbo.location.wmlX},${gwabbo.location.wmlY}` : null,
          });
        }
        return {};
      },
    };

    await session.runStartupEvents();

    // Fully resolved, Gwabbo has retreated to the keep...
    const gwabbo = session.board.allUnits().find((u) => u.id === 'Gwabbo')!;
    expect(gwabbo.location.wmlX).toBe(20);
    expect(gwabbo.location.wmlY).toBe(10);

    // ...but at his own line he was still at his spawn hex, and before
    // that he was not on the board at all. (His retreat is scripted to
    // happen after the line, in the same real event body.)
    const own = boardAtEachLine.findIndex((l) => l.speaker === 'Gwabbo');
    expect(own).toBeGreaterThan(0);
    expect(boardAtEachLine[own]!.gwabboAt).toBe('34,20');
    expect(boardAtEachLine[0]!.gwabboAt).toBeNull();
  });
});

describe('GameSession.endTurn (hotseat cycling)', () => {
  it('cycles active side, increments turnNumber only on wraparound, and refreshes the incoming side\'s moves/attacks', async () => {
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

    await session.endTurn();
    expect(session.activeSide).toBe(2); // Dead_Water scenario 1 has sides 1 and 2 -- no wrap yet.
    expect(session.turnNumber).toBe(1);
    for (const unit of session.board.unitsForSide(2)) {
      expect(unit.movesLeft).toBe(unit.maxMoves);
      expect(unit.attacksLeft).toBe(unit.maxAttacksPerTurn);
    }
    // Side 1's leader was NOT refreshed by side 2's turn starting.
    expect(leader1.movesLeft).toBe(0);

    await session.endTurn();
    expect(session.activeSide).toBe(1); // wrapped past the highest side number (2) back to 1.
    expect(session.turnNumber).toBe(2); // ...which is exactly when the turn counter increments.
    expect(leader1.movesLeft).toBe(leader1.maxMoves);
    expect(leader1.attacksLeft).toBe(leader1.maxAttacksPerTurn);
  });

  it('clears any selection/pending state', async () => {
    const session = new GameSession(loadSnapshot());
    const leader1 = session.board.unitsForSide(1)[0]!;
    session.selectUnit(leader1);
    expect(session.selectedUnit).not.toBeNull();
    await session.endTurn();
    expect(session.selectedUnit).toBeNull();
  });
});

describe('GameSession auto-plays controller=ai sides (real Dead_Water scenario 1, side 2 is controller=ai)', () => {
  it('a single endTurn() call from side 1 auto-plays the whole of side 2\'s AI turn and lands back on side 1, turn 2', async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.board.getTeam(2)!.controller).toBe('ai'); // sanity: this scenario really does mark side 2 as AI.

    const message = await session.endTurn();

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

  it("real, reported bug: AI turns played no animation at all -- endTurn() now sets lastAiAnimations to every real AiAnimationEvent side 2's turn produced", async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.lastAiAnimations).toBeNull();

    await session.endTurn();

    // Real Dead_Water scenario 1's side 2 leader (Mal-Kevek) starts with
    // real movement and no reachable target turn 1 -- the movement
    // fallback should always find SOMETHING to do (advance toward the
    // distant Kai Krellis), so this is a real, non-vacuous check of the
    // end-to-end wiring (endTurn -> playAiSide -> aiManager.playTurn's
    // real animation field), not just "didn't crash".
    expect(session.lastAiAnimations).not.toBeNull();
    expect(session.lastAiAnimations!.length).toBeGreaterThan(0);
    for (const event of session.lastAiAnimations!) {
      expect(['move', 'attack', 'recruit']).toContain(event.kind);
    }
  });
});

describe('GameSession recruiting (real recruit.ts actions, real recruit= lists)', () => {
  it('real, reported gameplay bug (bugs6.md): offers exactly the four types Dead Water 1 declares -- not the leader\'s own "Merman Child King"', () => {
    const session = new GameSession(loadSnapshot());
    // Exactly what the real game's own save of this scenario records for
    // side 1 (see packages/ui/src/save/fixtures/): no Child King.
    expect([...session.board.getTeam(1)!.canRecruit].sort()).toEqual([
      'Mermaid Initiate',
      'Merman Citizen',
      'Merman Fighter',
      'Merman Hunter',
    ]);
    // Same for the enemy side, which used to be offered its own Dark Sorcerer.
    expect([...session.board.getTeam(2)!.canRecruit].sort()).toEqual([
      'Skeleton',
      'Skeleton Archer',
      'Soulless',
      'Vampire Bat',
      'Walking Corpse',
    ]);
  });

  it('real, reported bug (bugs6.md): shows "Mermaid Initiate", not the translators\' "female^Mermaid Initiate" disambiguation', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);

    const initiate = session.recruitOptions.find((o) => o.typeId === 'Mermaid Initiate');
    expect(initiate).toBeDefined();
    expect(initiate!.name).toBe('Mermaid Initiate');
    for (const option of session.recruitOptions) expect(option.name).not.toContain('^');
  });

  it('lists the real recruitable types for a leader standing on its keep with a vacant castle tile, and places a real unit there on click', async () => {
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
    const message = await session.handleHexClick(target.x, target.y);

    expect(message).toContain('Recruited');
    expect(session.board.allUnits()).toHaveLength(unitCountBefore + 1);
    const placed = session.board.allUnits().find((u) => u.location.x === target.x && u.location.y === target.y);
    expect(placed?.type.id).toBe(typeId);
    expect(team.gold).toBe(goldBefore - (session.snapshot.unitTypes[typeId]?.cost ?? 0));

    // The just-filled tile is no longer offered.
    expect(session.recruitTiles.some((t) => t.x === target.x && t.y === target.y)).toBe(false);
  });

  it('bugs6.md: autoRecruitTile is the first vacant recruit tile by x, then y, and moves on once it is filled', async () => {
    const session = new GameSession(loadSnapshot());
    const byXY = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x - b.x || a.y - b.y;
    const first = [...session.recruitTiles].sort(byXY)[0]!;
    expect(session.autoRecruitTile).toEqual(first);

    session.selectRecruitType(session.recruitOptions[0]!.typeId);
    await session.handleHexClick(first.x, first.y);
    expect(session.autoRecruitTile).toEqual([...session.recruitTiles].sort(byXY)[0] ?? null);
    expect(session.autoRecruitTile).not.toEqual(first);
  });

  it('real, reported bug (bugs4.md #4/#6/#8): recruitOptions/recruitTiles/recruiting itself are available WITHOUT the leader being the selected unit -- only requires it being the active side\'s turn and the leader standing on a keep with a vacant connected tile', async () => {
    const session = new GameSession(loadSnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    expect(session.selectedUnit).toBeNull(); // deliberately never selected anything

    expect(session.recruitTiles.length).toBeGreaterThan(0);
    expect(session.recruitOptions.length).toBeGreaterThan(0);

    const team = session.board.getTeam(1)!;
    const typeId = session.recruitOptions[0]!.typeId;
    const target = session.recruitTiles[0]!;
    const goldBefore = team.gold;

    session.selectRecruitType(typeId);
    const message = await session.handleHexClick(target.x, target.y);

    expect(message).toContain('Recruited');
    const placed = session.board.allUnits().find((u) => u.location.x === target.x && u.location.y === target.y);
    expect(placed?.type.id).toBe(typeId);
    // The real bug this regresses: `team.gold` (the authoritative figure
    // the recruit validation itself reads) actually drops here, exactly
    // like this assertion expects -- the reported symptom ("status bar
    // still shows the old higher amount") was `TopBar.svelte` reading the
    // wrong field (`EconomyInfo.startGold`, deliberately frozen at
    // scenario start) instead of this live `team.gold`, not a bug in the
    // recruit action itself. See TopBar.svelte's own doc comment on its
    // `gold` prop.
    expect(team.gold).toBe(goldBefore - (session.snapshot.unitTypes[typeId]?.cost ?? 0));
    expect(leader.canRecruit).toBe(true); // unaffected -- just confirms we're still looking at the real leader
  });

  it('real, reported bug (bugs5.md #1): recruiting/recalling no longer auto-selects the leader afterward -- most noticeable recruiting via the context menu with nothing selected beforehand, where the leader used to become selected as an unwanted side effect', async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.selectedUnit).toBeNull();

    const typeId = session.recruitOptions[0]!.typeId;
    const target = session.recruitTiles[0]!;
    session.selectRecruitType(typeId);
    await session.handleHexClick(target.x, target.y);

    expect(session.selectedUnit).toBeNull(); // still nothing selected -- recruiting must not have changed it

    // Also true starting from a DIFFERENT unit selected (not the leader) --
    // recruiting must not steal the selection away from it either.
    const other = session.board.unitsForSide(1).find((u) => !u.canRecruit);
    if (other) {
      session.selectUnit(other);
      const typeId2 = session.recruitOptions[0]?.typeId;
      const target2 = session.recruitTiles[0];
      if (typeId2 && target2) {
        session.selectRecruitType(typeId2);
        await session.handleHexClick(target2.x, target2.y);
        expect(session.selectedUnit).toBe(other);
      }
    }
  });

  it('real, reported bug: recruiting never played any animation -- yields a unitAppear beat for the new unit and the recruiting leader', async () => {
    const session = new GameSession(loadSnapshot());
    const beats = recordBeats(session);
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const typeId = session.recruitOptions[0]!.typeId;
    const target = session.recruitTiles[0]!;

    session.selectRecruitType(typeId);
    await session.handleHexClick(target.x, target.y);

    const appear = beats.find((b) => b.kind === 'unitAppear');
    expect(appear).toBeDefined();
    if (appear?.kind !== 'unitAppear') throw new Error('expected a unitAppear beat');
    expect(appear.by).toBe(leader);
    expect(appear.unit.location.x).toBe(target.x);
    expect(appear.unit.location.y).toBe(target.y);
  });

  it('real, reported bug: recruited units never got any character traits, and the unit infobox never showed trait information -- a freshly recruited unit now gets 2 real traits (e.g. strong/quick/intelligent/resilient), surfaced in unitInfo().traits', async () => {
    const session = new GameSession(loadSnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const typeId = session.recruitOptions[0]!.typeId;
    const target = session.recruitTiles[0]!;

    session.selectRecruitType(typeId);
    await session.handleHexClick(target.x, target.y);

    const placed = session.board.allUnits().find((u) => u.location.x === target.x && u.location.y === target.y)!;
    expect(placed.traitNames).toHaveLength(2);
    expect(session.unitInfo(placed).traits).toEqual(placed.traitNames);
  });

  it('refuses to recruit when the side cannot afford the unit', async () => {
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
    const message = await session.handleHexClick(target.x, target.y);

    expect(message).toMatch(/not enough gold/i);
    expect(session.board.allUnits()).toHaveLength(unitCountBefore);
    expect(team.gold).toBe(-1);
  });

  it('refuses to recruit onto a hex that is not a vacant, connected castle tile', async () => {
    const session = new GameSession(loadSnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const typeId = session.recruitOptions[0]!.typeId;
    const unitCountBefore = session.board.allUnits().length;

    session.selectRecruitType(typeId);
    // The leader's own occupied hex is never a valid recruit target.
    const message = await session.handleHexClick(leader.location.x, leader.location.y);

    expect(message).toMatch(/cannot recruit/i);
    expect(session.board.allUnits()).toHaveLength(unitCountBefore);
  });
});

describe('GameSession.toSaveData / loadSaveData (round-trip, see persistence.ts for the IndexedDB/gzip layer this feeds)', () => {
  it('round-trips turn/side/gold/unit-position/hp/moves state exactly', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();

    // Change enough real state that a naive "just rebuild from snapshot" reload would visibly differ.
    await session.endTurn(); // side 1 -> side 2
    const team1 = session.board.getTeam(1)!;
    team1.gold = 77;
    const someUnit = session.board.allUnits()[0]!;
    someUnit.hitpoints = Math.max(1, someUnit.hitpoints - 5);
    someUnit.movesLeft = 0;

    const saved = session.toSaveData();
    expect(saved.version).toBe(2);
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

  it('records the difficulty the scenario was built for (Phase 21), so a load fetches the same build', () => {
    const session = new GameSession(loadSnapshot());
    expect(session.toSaveData().difficulty).toBe('NORMAL');
    const hard = { ...loadSnapshot(), difficulty: 'HARD' };
    expect(new GameSession(hard).toSaveData().difficulty).toBe('HARD');
    // A debug scenario has none: the field is absent, not "undefined" in the JSON.
    const { difficulty: _unused, ...debug } = loadSnapshot();
    expect('difficulty' in new GameSession(debug as GameBoardSnapshot).toSaveData()).toBe(false);
  });

  it('round-trips a latched scenarioResult and keeps the loaded session blocked from further input', async () => {
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
    expect(await reloaded.handleHexClick(0, 0)).toBeNull();
    expect(await reloaded.endTurn()).toBe('');
  });

  it('real, reported bug (save version 1): a veteran came back a rookie -- XP/level/traits/statuses/facing now survive a round trip', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();

    // Make one unit as un-default as a real mid-campaign unit gets.
    const unit = session.board.unitsForSide(1).find((u) => !u.canRecruit)!;
    unit.experience = 17;
    unit.level = 2;
    unit.maxExperience = 56;
    unit.facing = Direction.NorthWest;
    unit.resting = false;
    unit.setStatus('poisoned', true);
    unit.setStatus('slowed', true);
    const traitCfg = new WmlConfig();
    traitCfg.setAttribute('id', 'strong');
    unit.modifications = [{ kind: 'trait', cfg: traitCfg }];

    const reloaded = new GameSession(loadSnapshot());
    reloaded.loadSaveData(session.toSaveData());

    const back = reloaded.board.unitAt(unit.location)!;
    expect(back.experience).toBe(17);
    expect(back.level).toBe(2);
    expect(back.maxExperience).toBe(56);
    expect(back.facing).toBe(Direction.NorthWest);
    expect(back.resting).toBe(false);
    expect(back.hasStatus('poisoned')).toBe(true);
    expect(back.hasStatus('slowed')).toBe(true);
    expect(back.modifications.map((m) => m.kind)).toEqual(['trait']);
    expect(back.modifications[0]!.cfg.getString('id')).toBe('strong');
  });

  it('real, reported bug (save version 1): captured villages reverted to unowned on load, taking the side\'s income with them', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();

    // Capture a village that side 1 does not start with.
    const village = session.board.map.villages.find((loc) => session.board.villageOwner(loc) === undefined)!;
    session.board.captureVillage(village, 1);
    const villagesBefore = session.board.villageCount(1);
    expect(villagesBefore).toBeGreaterThan(0);

    const reloaded = new GameSession(loadSnapshot());
    reloaded.loadSaveData(session.toSaveData());

    expect(reloaded.board.villageOwner(village)).toBe(1);
    expect(reloaded.board.villageCount(1)).toBe(villagesBefore);
  });

  it('real, reported bug (save version 1): the RNG stream restarted on load, so post-load combat diverged from the game that was saved', async () => {
    // The whole-game stream only advances in deterministic mode; per-action
    // mode seeds each action afresh (see the Phase 18b tests).
    const session = new GameSession(loadSnapshot(), { randomMode: 'deterministic' });
    await session.runStartupEvents();
    // Play a real turn so the stream has actually advanced: side 2 is
    // `controller=ai` here, and its recruiting/fighting draws randomness.
    await session.endTurn();

    const saved = session.toSaveData();
    expect(saved.rng).toBeDefined();
    // Non-vacuous only if the stream has actually advanced by now: with
    // calls still at 0 a fresh session would trivially match.
    expect(saved.rng!.calls).toBeGreaterThan(0);
    // What the saved session itself would draw next...
    // @ts-expect-error -- private: this is exactly the stream a load has to resume.
    const expectedDraws = [session.mtRng.getNextRandom(), session.mtRng.getNextRandom(), session.mtRng.getNextRandom()];

    const reloaded = new GameSession(loadSnapshot());
    reloaded.loadSaveData(saved);
    // The save carries the mode with it.
    // @ts-expect-error -- private, as above.
    expect(reloaded.rng.mode).toBe('deterministic');
    // @ts-expect-error -- private, as above.
    const actualDraws = [reloaded.mtRng.getNextRandom(), reloaded.mtRng.getNextRandom(), reloaded.mtRng.getNextRandom()];

    expect(actualDraws).toEqual(expectedDraws);
  });

  it('round-trips the live ToD schedule (Schedule.test.ts covers the deeper [time_area]/[replace_schedule] mutation cases; this just confirms the wiring)', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    const someUnit = session.board.allUnits()[0]!;
    const beforeTod = session.timeOfDayAt(someUnit.location);

    const saved = session.toSaveData();
    expect(saved.schedule).toBeDefined();

    const reloaded = new GameSession(loadSnapshot());
    reloaded.loadSaveData(saved);
    expect(reloaded.timeOfDayAt(someUnit.location)).toEqual(beforeTod);
  });
});

describe('WML variables across a save and a scenario boundary (Phase 17)', () => {
  it('round-trips the scenario\'s variables and the choices made so far', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    // Stand-ins for whatever the scenario's own events recorded.
    session.setVariable('first_password', 3);
    session.setVariable('rescued.0.name', 'Nym');

    const restored = GameSession.fromSaveData(loadSnapshot(), session.toSaveData());

    expect(restored.getVariable('first_password')).toBe(3);
    expect(restored.getVariable('rescued.0.name')).toBe('Nym');
  });

  it('carries variables into the next scenario -- what the Two Brothers password puzzle needs', async () => {
    const finished = new GameSession(loadSnapshot());
    await finished.runStartupEvents();
    finished.setVariable('first_password', 2);
    const enemyLeader = finished.board.unitsForSide(2).find((u) => u.canRecruit)!;
    finished.board.removeUnitAt(enemyLeader.location);
    // @ts-expect-error -- private, called directly as the other carryover tests do.
    finished.checkForGameEnd();

    const next = GameSession.startNextScenario(finished, loadNextSnapshot());

    expect(next.getVariable('first_password')).toBe(2);
  });
});

describe('GameSession victory/defeat (real leader-death check, see checkVictory)', () => {
  it('sets scenarioResult to "defeat" when the player-side leader dies, and blocks further input', async () => {
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
    expect(await session.handleHexClick(0, 0)).toBeNull();
    expect(await session.endTurn()).toBe('');
    expect(session.board.allUnits()).toHaveLength(unitCountBefore);
    expect(session.activeSide).toBe(1); // endTurn() no-opped, so this never advanced.
  });

  it('sets scenarioResult to "victory" when the enemy leader dies', async () => {
    const session = new GameSession(loadSnapshot());
    const enemyLeader = session.board.unitsForSide(2).find((u) => u.canRecruit)!;

    session.board.removeUnitAt(enemyLeader.location);
    // @ts-expect-error -- see the defeat test above for why this is called directly.
    session.checkForGameEnd();

    expect(session.scenarioResult).toBe('victory');
    expect(session.log[0]).toMatch(/victory/i);
  });

  it('checkForGameEnd is idempotent -- does not overwrite an already-latched result', async () => {
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
  it('reads the real 01_Invasion -> 02_Flight chain, and null for a scenario with none', async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.nextScenarioId).toBe('02_Flight');

    const noNext = loadSnapshot();
    delete (noNext.scenarioConfigJson.attrs as Record<string, unknown>)['next_scenario'];
    expect(new GameSession(noNext).nextScenarioId).toBeNull();
  });
});

describe('GameSession.startNextScenario (real 01_Invasion -> 02_Flight gold + recall carryover)', () => {
  it('throws if the finished session did not end in victory', async () => {
    const finished = new GameSession(loadSnapshot());
    expect(() => GameSession.startNextScenario(finished, loadNextSnapshot())).toThrow();
  });

  it('carries real gold and real surviving non-leader units into a fresh session on the next scenario', async () => {
    const finished = new GameSession(loadSnapshot());
    await finished.runStartupEvents(); // spawns Cylanna/Gwabbo/citizens, matching a real playthrough.
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

  it('carries a recall-list survivor through a SECOND scenario transition even if never recalled in between, and a real prestart {RECALL_LOYAL_UNITS} macro places it on the board via the real [recall] action -- regression for a real dropped-hero bug', async () => {
    // Scenario 1 -> 2, exactly as the test above, forcing victory the same way.
    const scenario1 = new GameSession(loadSnapshot());
    await scenario1.runStartupEvents();
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
    await scenario3.runStartupEvents();
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
  it('offers the real recall list once carried over, and places a recalled unit with its saved hp on click', async () => {
    const finished = new GameSession(loadSnapshot());
    await finished.runStartupEvents();
    const someSurvivor = finished.board.unitsForSide(1).find((u) => !u.canRecruit)!;
    someSurvivor.hitpoints = 3;
    finished.board.getTeam(1)!.gold = 150;
    finished.turnNumber = 5;
    const enemyLeader = finished.board.unitsForSide(2).find((u) => u.canRecruit)!;
    finished.board.removeUnitAt(enemyLeader.location);
    // @ts-expect-error -- see above.
    finished.checkForGameEnd();

    const next = GameSession.startNextScenario(finished, loadNextSnapshot());
    // Phase 18c: a carried-over unit starts the next scenario healed
    // (`game_board::new_scenario` -> `unit::new_scenario`)...
    expect(someSurvivor.hitpoints).toBe(someSurvivor.maxHitpoints);
    // ...so damage it here instead: a recall (not a recruit) keeps its hp.
    someSurvivor.hitpoints = 3;
    const beats = recordBeats(next);
    const leader = next.board.unitsForSide(1).find((u) => u.canRecruit)!;
    next.selectUnit(leader);
    expect(next.recruitTiles.length).toBeGreaterThan(0);

    const options = next.recallOptions;
    const recalled = options.find((o) => o.typeId === someSurvivor.type.id && o.hp === 3);
    expect(recalled).toBeDefined();

    const target = next.recruitTiles[0]!;
    const goldBefore = next.board.getTeam(1)!.gold;
    next.selectRecallUnit(recalled!.index);
    const message = await next.handleHexClick(target.x, target.y);

    expect(message).toContain('Recalled');
    const placedUnit = next.board.allUnits().find((u) => u.location.x === target.x && u.location.y === target.y && u.hitpoints === 3);
    expect(placedUnit).toBeDefined();
    expect(next.board.recallList(1)).toHaveLength(options.length - 1);
    expect(next.board.getTeam(1)!.gold).toBe(goldBefore - recalled!.cost);
    // Real, reported bug: recalling never played any animation either
    // (real Wesnoth's actions::place_recruit -- and its unit_recruited
    // animation call -- handles recruit and recall identically).
    const appear = beats.find((b) => b.kind === 'unitAppear');
    expect(appear).toBeDefined();
    if (appear?.kind !== 'unitAppear') throw new Error('expected a unitAppear beat');
    expect(appear.by).toBe(leader);
    expect(appear.unit).toBe(placedUnit);
  });
});

describe('GameSession recall dialog actions (real, reported bug: no way to rename/dismiss a recall-list unit)', () => {
  it('dismissRecallUnit permanently removes exactly the targeted recall-list entry, by position', async () => {
    const session = new GameSession(loadSnapshot());
    const resolveType = createTypeResolver(session.snapshot);
    const fighterType = resolveType('Merman Fighter');
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const a = Unit.create(fighterType, 1, new Location(-1, -1));
    const b = Unit.create(fighterType, 1, new Location(-1, -1));
    session.board.addToRecallList(1, a);
    session.board.addToRecallList(1, b);
    session.selectUnit(kaiKrellis);

    session.dismissRecallUnit(0);

    expect(session.board.recallList(1)).toEqual([b]);
  });

  it("renameRecallUnit sets the unit's display name, ignoring a blank name", async () => {
    const session = new GameSession(loadSnapshot());
    const resolveType = createTypeResolver(session.snapshot);
    const fighterType = resolveType('Merman Fighter');
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const a = Unit.create(fighterType, 1, new Location(-1, -1));
    session.board.addToRecallList(1, a);
    session.selectUnit(kaiKrellis);

    session.renameRecallUnit(0, 'Aeducan');
    expect(a.name).toBe('Aeducan');

    session.renameRecallUnit(0, '   ');
    expect(a.name).toBe('Aeducan'); // unchanged -- a blank name is ignored, not a real rename.
  });
});

describe('GameSession weapon selection (attackerWeaponOptions / selectAttackerWeapon)', () => {
  it('offers every usable weapon for a real multi-weapon attacker (Dark Sorcerer: staff/chill wave/shadow wave), defaulting to the first', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    expect(malKevek.attacks.length).toBeGreaterThan(1); // real content: 3 real weapons.

    session.selectUnit(malKevek);
    expect(session.attackCandidates).toContain(kaiKrellis);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);

    const options = session.attackerWeaponOptions;
    expect(options.length).toBe(malKevek.attacks.length);
    expect(options.map((o) => o.name)).toEqual(malKevek.attacks.map((a) => a.name));
    expect(options[0]!.selected).toBe(true);
    expect(options.filter((o) => o.selected)).toHaveLength(1);
    expect(session.pendingAttack!.attackerWeaponIndex).toBe(0);
  });

  it('selectAttackerWeapon switches the pending preview to a real, different weapon\'s real stats', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);

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

  it('ignores an out-of-range weapon index (no crash, no change)', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);

    const before = session.pendingAttack!.attackerWeaponIndex;
    session.selectAttackerWeapon(99);
    expect(session.pendingAttack!.attackerWeaponIndex).toBe(before);
  });

  it('returns an empty list when there is no pending attack', async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.attackerWeaponOptions).toEqual([]);
  });
});

describe('GameSession.confirmAttack zeroes the attacker\'s movement (real Wesnoth: attacking ends a unit\'s move)', () => {
  it('sets movesLeft to 0 after a real attack, even though the attacker never moved and had full movement left', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    expect(malKevek.movesLeft).toBe(malKevek.maxMoves); // hasn't moved this turn.
    expect(malKevek.movesLeft).toBeGreaterThan(0);

    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    expect(session.pendingAttack).not.toBeNull();
    await session.confirmAttack();

    expect(malKevek.movesLeft).toBe(0);
  });

  it('deselects the attacker after confirming, so its (now zeroed) reachable set is not offered until re-selected', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    await session.confirmAttack();

    expect(session.selectedUnit).toBeNull();
    expect(session.reachable).toEqual([]);

    // Re-selecting the same unit shows it correctly has nowhere left to move.
    session.selectUnit(malKevek);
    expect(session.reachable).toEqual([]);
  });

  it('does not touch movesLeft when the attacker died in the exchange (nothing left to zero)', async () => {
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
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const message = await session.confirmAttack();
    expect(message).not.toBeNull();
    // Whether or not malKevek actually died this particular RNG draw, the
    // session must not have thrown and must be in a consistent state.
    expect(session.selectedUnit).toBeNull();
  });
});

describe('GameSession.confirmAttack logs one line per real blow, not just a summary', () => {
  it('adds exactly one log line per AttackBlowResult, each naming the real striker/target, plus the summary line on top', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const logLengthBefore = session.log.length;

    await session.confirmAttack();

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

  it('a hit line reports real, non-negative damage; a miss line reports zero implicitly (no "for N damage" clause)', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    await session.confirmAttack();

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
  it('reads the real Dead Water scenario 1 default schedule, advancing by real game turn as endTurn wraps', async () => {
    const session = new GameSession(loadSnapshot());
    // Side 2 is controller=ai; force it back to human here to test ToD's
    // per-turn (not per-side) progression step by step, independent of
    // the AI auto-play feature (covered separately -- see "GameSession
    // auto-plays controller=ai sides" below).
    session.board.getTeam(2)!.controller = 'human';
    expect(session.currentTimeOfDay.id).toBe('dawn'); // turn 1, current_time defaults to 0.
    expect(session.currentTimeOfDay.lawfulBonus).toBe(0);

    await session.endTurn(); // -> side 2, still turn 1.
    expect(session.currentTimeOfDay.id).toBe('dawn'); // ToD is per-turn, not per-side -- unchanged mid-turn-1.

    await session.endTurn(); // wraps -> turn 2.
    expect(session.currentTimeOfDay.id).toBe('morning');
    expect(session.currentTimeOfDay.lawfulBonus).toBe(25); // real value, see Schedule.test.ts.
  });

  it('a lawful attacker deals more real damage during a lawful-favoring phase than during a neutral one, all else equal', async () => {
    // Same real matchup (Kai Krellis, lawful, vs Mal-Kevek adjacent),
    // compared at turn 1 (dawn, lawful_bonus=0) vs turn 2 (morning,
    // lawful_bonus=25) -- buildPreview's real combatModifier() should
    // reflect the schedule difference in the predicted damage per blow.
    const { session: dawnSession, malKevek: dawnMalKevek, kaiKrellis: dawnKaiKrellis } = withAdjacentLeaders();
    dawnSession.selectUnit(dawnKaiKrellis);
    await dawnSession.handleHexClick(dawnMalKevek.location.x, dawnMalKevek.location.y);
    const dawnDamage = dawnSession.pendingAttack!.preview.attacker.damagePerBlow;

    const { session: morningSession, malKevek, kaiKrellis } = withAdjacentLeaders();
    // Side 2 (Mal-Kevek's) is controller=ai -- force it to human so the AI
    // doesn't itself attack with the now-adjacent Mal-Kevek before this
    // test gets to manually preview Kai Krellis's attack on him.
    morningSession.board.getTeam(2)!.controller = 'human';
    await morningSession.endTurn();
    await morningSession.endTurn(); // -> turn 2, morning, lawful_bonus=25.
    expect(morningSession.currentTimeOfDay.id).toBe('morning');
    morningSession.activeSide = 1; // Kai Krellis's side, so selecting/attacking with him is allowed regardless of whose turn endTurn() left active.
    morningSession.selectUnit(kaiKrellis);
    await morningSession.handleHexClick(malKevek.location.x, malKevek.location.y);
    const morningDamage = morningSession.pendingAttack!.preview.attacker.damagePerBlow;

    expect(morningDamage).toBeGreaterThan(dawnDamage);
  });
});

describe('GameSession.timeOfDayAt real [time_area] (Under the Burning Suns scenario 3: campfires lit against the long dark)', () => {
  it('a campfire hex reads its own always-lit schedule while the rest of the map follows the global (very dark) one', async () => {
    const session = new GameSession(loadUtbsTimeAreaSnapshot());
    await session.runStartupEvents(); // real prestart event declares [time_area] id=campfires x=14,16,13 y=10,15,20 radius=2.

    const campfireHex = Location.fromWml(14, 10); // one of the area's own declared centres.
    const farAwayHex = Location.fromWml(1, 1); // far outside any campfire's radius=2.

    const campfireTod = session.timeOfDayAt(campfireHex);
    const globalTod = session.currentTimeOfDay;
    const farAwayTod = session.timeOfDayAt(farAwayHex);

    expect(campfireTod.id).not.toBe(globalTod.id);
    expect(farAwayTod.id).toBe(globalTod.id);
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
  it('grants no income/upkeep on turn 1, but applies real total_income the moment turn 2 begins', async () => {
    const session = new GameSession(loadEconomySnapshot());
    expect(session.activeSide).toBe(1);
    expect(session.turnNumber).toBe(1);
    expect(session.board.getTeam(1)!.gold).toBe(40);
    expect(session.economyInfo.netIncome).toBe(0); // turn 1: no preview yet, matching "no income applied yet".

    await session.endTurn(); // -> side 2, still turn 1.
    expect(session.turnNumber).toBe(1);
    expect(session.board.getTeam(2)!.gold).toBe(50); // untouched -- still turn 1.

    await session.endTurn(); // wraps -> side 1, turn 2 begins: side 1's income now applies.
    expect(session.turnNumber).toBe(2);
    expect(session.activeSide).toBe(1);
    // total_income = income(2) + base_income(2) + 0 villages*1 = 4. No units
    // beyond the (upkeep-free) leader, so no upkeep expense.
    expect(session.board.getTeam(1)!.gold).toBe(40 + 4);

    await session.endTurn(); // -> side 2, still turn 2: side 2's income now applies too.
    expect(session.activeSide).toBe(2);
    expect(session.turnNumber).toBe(2);
    // total_income = income(1) + base_income(2) + 0 villages*1 = 3.
    expect(session.board.getTeam(2)!.gold).toBe(50 + 3);
  });

  it('economyInfo previews startGold/incomePerVillage always, and netIncome only once turnNumber > 1', async () => {
    const session = new GameSession(loadEconomySnapshot());
    expect(session.economyInfo).toMatchObject({ startGold: 40, incomePerVillage: 1, villagesOwned: 0, netIncome: 0 });
    // Real, reported bug: the status bar had no way to show unit count or
    // upkeep at all -- see TopBar.svelte (Phase 14).
    expect(session.economyInfo.unitCount).toBe(session.board.unitsForSide(session.activeSide).length);
    expect(session.economyInfo.upkeepTotal).toBeGreaterThanOrEqual(0);
    expect(session.economyInfo.upkeepCharged).toBeGreaterThanOrEqual(0);

    await session.endTurn();
    await session.endTurn(); // now turn 2, side 1 active -- income already applied by endTurn itself.
    expect(session.economyInfo.startGold).toBe(40); // startGold never changes, unlike current gold.
    expect(session.economyInfo.netIncome).toBe(4); // matches what just got applied (previewing the NEXT turn's income, which happens to equal this turn's since nothing changed).
  });

  it('walking a unit onto a real village (real executeMove -> GameBoard.captureVillage) captures it, and the next turn\'s income reflects the extra village_gold', async () => {
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
    await session.handleHexClick(villageLoc.x, villageLoc.y);

    expect(leader.location.equals(villageLoc)).toBe(true);
    expect(session.board.villageOwner(villageLoc)).toBe(1);
    expect(session.economyInfo.villagesOwned).toBe(1);

    await session.endTurn();
    await session.endTurn(); // turn 2, side 1's income now includes the captured village.
    // total_income = income(2) + base_income(2) + 1 village*1 = 5.
    expect(session.board.getTeam(1)!.gold).toBe(40 + 5);
  });

  it('upkeep charges gold for unit levels beyond what owned villages support, mirroring play_controller\'s expense = side_upkeep - support', async () => {
    const session = new GameSession(loadEconomySnapshot());
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    // Recruit a real level-1 Spearman (cost 14g, matching synthetic-
    // campaigns/economy's own recruit= list) -- its upkeep (its level, 1,
    // since it's not a leader) isn't covered by any owned village (0 owned).
    session.selectUnit(leader);
    session.selectRecruitType('Spearman');
    const recruitTile = session.recruitTiles[0]!;
    await session.handleHexClick(recruitTile.x, recruitTile.y);
    expect(session.board.getTeam(1)!.gold).toBe(40 - 14);

    await session.endTurn();
    await session.endTurn(); // turn 2, side 1's turn: income(2)+base(2)+0 villages = 4, upkeep = 1 level - 0 support = 1 expense.
    expect(session.board.getTeam(1)!.gold).toBe(40 - 14 + 4 - 1);
  });
});

describe('GameSession.endTurn applies real healing (rest/heals-ability/poison) -- previously a no-op gap on top of a real healer-detection bug', () => {
  it("real Cylanna (a Mermaid Priestess, abilities_list=heals_8,cures) actually heals a damaged adjacent ally's HP on endTurn -- regression for both the missing endTurn healing call and the id-vs-tag ability-matching bug", async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    const cylanna = session.board.allUnits().find((u) => u.id === 'Cylanna')!;
    expect(cylanna).toBeDefined();
    expect(cylanna.abilities.some((a) => a.tag === 'heals')).toBe(true); // sanity: the ability-matching fix itself.

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
    await session.endTurn(); // -> side 2.
    await session.endTurn(); // -> side 1 again, turn 2: Cylanna's real heals ability should now fire for real.

    expect(kaiKrellis.hitpoints).toBeGreaterThan(hpBefore);
    // Real heals_8 value, plus the +2 rest heal: Kai stood still through turn
    // 1, and upstream marks a side's units resting at every side-turn start,
    // the scenario's first included (`do_init_side`).
    expect(kaiKrellis.hitpoints).toBe(Math.min(kaiKrellis.maxHitpoints, hpBefore + 8 + 2));
    expect(session.log.some((l) => l.includes('heals 10 HP') && l.includes('Cylanna'))).toBe(true);
  });
});

describe('GameSession.unitInfo (real, reported bug: UI missing weapon type/abilities info)', () => {
  it("Kai Krellis' real single melee weapon (scepter/impact) shows up with type/range, and he has no abilities", async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const info = session.unitInfo(kaiKrellis);

    expect(info.attacks).toHaveLength(1);
    expect(info.attacks[0]!.name).toBe('scepter');
    expect(info.attacks[0]!.type).toBe('impact');
    expect(info.attacks[0]!.range).toBe('melee');
    expect(info.abilities).toEqual([]);
  });

  it('real, reported bug: XP is not present in the unit infobox -- unitInfo now reports the unit\'s real experience/maxExperience', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    kaiKrellis.experience = 3;
    const info = session.unitInfo(kaiKrellis);

    expect(info.xp).toBe(3);
    expect(info.maxXp).toBe(kaiKrellis.maxExperience);
    expect(info.maxXp).toBeGreaterThan(0);
  });

  it("real Cylanna's abilities_list=heals_8,cures resolve to real player-facing names, not just tag ids", async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    const cylanna = session.board.allUnits().find((u) => u.id === 'Cylanna')!;
    const info = session.unitInfo(cylanna);

    expect(info.abilities.length).toBeGreaterThanOrEqual(2);
    const names = info.abilities.map((a) => a.name);
    expect(names).toContain('heals +8');
    expect(names).toContain('cures');
    // Every real ability carries a real, non-empty description (the whole point of showing it in the UI).
    for (const a of info.abilities) expect(a.description.length).toBeGreaterThan(0);
  });

  it("Mal-Kevek's real 3 weapons (staff/chill wave/shadow wave) each report their real type and range", async () => {
    const { session, malKevek } = withAdjacentLeaders();
    const info = session.unitInfo(malKevek);

    expect(info.attacks).toHaveLength(3);
    const byName = Object.fromEntries(info.attacks.map((a) => [a.name, a]));
    expect(byName['staff']).toMatchObject({ type: 'impact', range: 'melee' });
    expect(byName['chill wave']).toMatchObject({ type: 'cold', range: 'ranged' });
    expect(byName['shadow wave']).toMatchObject({ type: 'arcane', range: 'ranged' });
  });
});

describe('GameSession.unitInfo Phase 14 infobox fields (image/level/alignment/race/resistances/statuses)', () => {
  it("Kai Krellis reports his real level/alignment/race, and his portrait image matches the scenario snapshot's unit-type table", async () => {
    const snapshot = loadSnapshot();
    const session = new GameSession(snapshot);
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const info = session.unitInfo(kaiKrellis);

    expect(info.level).toBe(kaiKrellis.type.level);
    expect(info.alignment).toBe(kaiKrellis.alignment);
    expect(info.raceId).toBe('merman');
    expect(info.raceName).toBe('Merfolk');
    expect(info.image).toBe(snapshot.unitTypes[kaiKrellis.type.id]?.image ?? null);
  });

  it('resistances is a fixed six-row table (blade/pierce/impact/fire/cold/arcane), each value matching Unit.resistanceAgainst directly', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const info = session.unitInfo(kaiKrellis);

    expect(info.resistances.map((r) => r.damageType)).toEqual(['blade', 'pierce', 'impact', 'fire', 'cold', 'arcane']);
    for (const r of info.resistances) {
      expect(r.resistance).toBe(kaiKrellis.resistanceAgainst(r.damageType));
    }
  });

  it('real, reported gap: no way to see whether a unit is poisoned/slowed/petrified -- unitInfo().statuses now surfaces exactly those three, by display name', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    expect(session.unitInfo(kaiKrellis).statuses).toEqual([]);

    kaiKrellis.setStatus('poisoned', true);
    kaiKrellis.setStatus('slowed', true);
    expect(session.unitInfo(kaiKrellis).statuses).toEqual(['Slowed', 'Poisoned']);

    kaiKrellis.setStatus('slowed', false);
    kaiKrellis.setStatus('petrified', true);
    expect(session.unitInfo(kaiKrellis).statuses).toEqual(['Poisoned', 'Petrified']);

    // A status this project tracks but the infobox deliberately doesn't badge (not called out by the plan).
    kaiKrellis.setStatus('guardian', true);
    expect(session.unitInfo(kaiKrellis).statuses).toEqual(['Poisoned', 'Petrified']);
  });
});

describe('GameSession.hoveredHexInfo (Phase 14 infobox: terrain info for the hovered hex)', () => {
  it('reports real terrain name for an on-board hex, with defensePercent null when nothing is selected', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const info = session.hoveredHexInfo(kaiKrellis.location.x, kaiKrellis.location.y);

    expect(info).not.toBeNull();
    expect(info!.terrainName).toBe(session.board.map.terrainName(kaiKrellis.location));
    expect(info!.defensePercent).toBeNull();
  });

  it('once a unit is selected, defensePercent matches defensePercentAt for the same hex', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kaiKrellis);
    const target = session.reachable[0]!;
    const info = session.hoveredHexInfo(target.x, target.y);

    expect(info!.defensePercent).toBe(session.defensePercentAt(target.x, target.y));
  });

  it('returns null for an off-board hex', async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.hoveredHexInfo(-1, -1)).toBeNull();
  });
});

describe('GameSession.renderUnits moves-orb reachability (real, reported bug: a unit with an unspent attack but nowhere left to use it showed the yellow "partial" orb instead of red "moved")', () => {
  it('real Dead_Water scenario 1: moving Kai Krellis to (25,10) leaves him with 1 attack left but no adjacent enemy and no more moves -- canMove/canAttackHere are both false, so his orb reads "moved", not "partial"', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kaiKrellis);
    expect(session.reachable.some((l) => l.x === 25 && l.y === 10)).toBe(true);

    await session.handleHexClick(25, 10);

    expect(kaiKrellis.movesLeft).toBe(0);
    expect(kaiKrellis.attacksLeft).toBe(1); // an attack is still nominally available...
    const snap = session.renderUnits.find((u) => u.id === 'Kai Krellis')!;
    expect(snap.canMove).toBe(false);
    expect(snap.canAttackHere).toBe(false); // ...but there's no adjacent enemy to use it on.
  });

  it('real, reported bug: enemy units carry no moves-left orb data at all -- only the viewing player\'s own units do', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const malKevek = session.board.allUnits().find((u) => u.type.id === 'Dark Sorcerer')!;
    expect(kaiKrellis.side).toBe(session.playerSide);
    expect(malKevek.side).not.toBe(session.playerSide);

    const mine = session.renderUnits.find((u) => u.id === kaiKrellis.id)!;
    const theirs = session.renderUnits.find((u) => u.side === malKevek.side)!;

    expect(mine.movesLeft).toBe(kaiKrellis.movesLeft);
    expect(mine.maxMoves).toBe(kaiKrellis.maxMoves);
    expect(mine.attacksLeft).toBe(kaiKrellis.attacksLeft);
    expect(mine.maxAttacksPerTurn).toBe(kaiKrellis.maxAttacksPerTurn);
    expect(typeof mine.canMove).toBe('boolean');

    expect(theirs.movesLeft).toBeUndefined();
    expect(theirs.maxMoves).toBeUndefined();
    expect(theirs.attacksLeft).toBeUndefined();
    expect(theirs.maxAttacksPerTurn).toBeUndefined();
    expect(theirs.canMove).toBeUndefined();
    expect(theirs.canAttackHere).toBeUndefined();
  });
});

describe('selection around a move (real, reported bug, bugs6.md: the reach overlay stayed on the map while the unit walked)', () => {
  it('the mover is deselected BEFORE its walk plays, and an ordinary move leaves it deselected', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kaiKrellis);
    const dest = session.reachable.find((h) => !(h.x === kaiKrellis.location.x && h.y === kaiKrellis.location.y))!;

    // What the board would draw at the instant the walk animation starts.
    let seenDuringWalk: { selected: unknown; reachable: number } | null = null;
    session.interactionHost = {
      async handle(interaction) {
        if (interaction.kind === 'beat' && interaction.beat.kind === 'moveUnit') {
          seenDuringWalk = { selected: session.selectedUnit, reachable: session.reachable.length };
        }
        return {};
      },
    };

    await session.handleHexClick(dest.x, dest.y);

    // Upstream clears the route, the reach highlight and the selected hex
    // before animating (mouse_handler::move_unit_along_current_route).
    expect(seenDuringWalk).toEqual({ selected: null, reachable: 0 });
    // Dead Water 1 has no fog, so nothing interrupts this move: it stays deselected.
    expect(session.selectedUnit).toBeNull();
  });
});

describe('GameSession.renderUnits idle facing (real, reported bug: the idle sprite never mirrored to face the unit\'s last move/attack direction)', () => {
  it('a real move sets Unit.facing, and renderUnits carries that same facing through to the SnapshotUnit', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kaiKrellis);
    const dest = session.reachable.find((h) => !(h.x === kaiKrellis.location.x && h.y === kaiKrellis.location.y));
    expect(dest).toBeDefined();

    await session.handleHexClick(dest!.x, dest!.y);

    expect(kaiKrellis.facing).not.toBe(Direction.Indeterminate);
    const snap = session.renderUnits.find((u) => u.id === 'Kai Krellis')!;
    expect(snap.facing).toBe(kaiKrellis.facing);
  });
});

describe('GameSession.reachable defensePercent (real, reported bug: the map only showed a reachable hex\'s terrain defense on hover, never all of a selected unit\'s real options at a glance)', () => {
  it('real Dead_Water scenario 1: every one of Kai Krellis\' reachable hexes carries its own real terrain defense, matching defensePercentAt for the same hex', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kaiKrellis);

    expect(session.reachable.length).toBeGreaterThan(0);
    for (const hex of session.reachable) {
      expect(hex.defensePercent).toBe(session.defensePercentAt(hex.x, hex.y));
      expect(hex.defensePercent).toBeGreaterThanOrEqual(0);
      expect(hex.defensePercent).toBeLessThanOrEqual(100);
    }
    // Real Dead_Water scenario 1 is mostly water/coast -- confirms this isn't a flat, unvarying number.
    const distinctValues = new Set(session.reachable.map((h) => h.defensePercent));
    expect(distinctValues.size).toBeGreaterThan(1);
  });
});

describe('GameSession.hexVisibility (real, reported bugs: hard shroud edges + border hexes wrongly revealed)', () => {
  it('is empty when playerSide uses neither fog nor shroud (the common case -- no overlay work at all)', async () => {
    const session = new GameSession(loadSnapshot());
    expect(session.hexVisibility).toEqual([]);
  });

  it('covers the one-hex border ring beyond the playable map, not just on-board hexes', async () => {
    // Real, reported bug: SnapshotBoard.renderTerrain builds terrain
    // containers for -1..w()/-1..h() (the same border ring
    // ShroudClearer.clearLoc already extends real vision-clearing into),
    // but hexVisibility only ever covered 0..w()-1/0..h()-1 -- so a
    // border hex just past a shrouded map edge always rendered fully
    // revealed (no overlay computed for it at all).
    const session = new GameSession(loadSnapshot());
    const team = session.board.getTeam(session.playerSide)!;
    team.shroud.enabled = true;

    const hv = session.hexVisibility;
    const xs = hv.map((h) => h.x);
    const ys = hv.map((h) => h.y);
    expect(Math.min(...xs)).toBe(-1);
    expect(Math.max(...xs)).toBe(session.board.map.w());
    expect(Math.min(...ys)).toBe(-1);
    expect(Math.max(...ys)).toBe(session.board.map.h());
    expect(hv.length).toBe((session.board.map.w() + 2) * (session.board.map.h() + 2));
  });

  it('a border hex reads shrouded/clear consistent with the real Team.shrouded query at that same location (border hexes are not special-cased to always show revealed)', async () => {
    const session = new GameSession(loadSnapshot());
    const team = session.board.getTeam(session.playerSide)!;
    team.shroud.enabled = true;
    // Untouched shroud: every hex, including the border ring, starts fully covered.
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kaiKrellis); // no-op for shroud, just gives a real board reference point

    const borderHex = session.hexVisibility.find((h) => h.x === -1 && h.y === -1)!;
    expect(borderHex.visibility).toBe('shrouded');
    expect(session.board.isShrouded(session.playerSide, new Location(-1, -1))).toBe(true);
  });
});

describe('GameSession unit inspection (real, reported bug: no way to see information about enemy units)', () => {
  it('clicking an enemy that is NOT an attack target (nothing of mine selected) inspects it without selecting/acting on it', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    // No unit selected yet.
    await session.handleHexClick(malKevek.location.x, malKevek.location.y);

    expect(session.inspectedUnit).toBe(malKevek);
    expect(session.selectedUnit).toBeNull(); // enemy click never selects for movement/action
    expect(session.unitInfo(session.inspectedUnit!).name).toBe(session.unitDisplayName(malKevek));
  });

  it('clicking a non-attackable enemy while my own unit is selected selects it instead, showing its reach (select_hex)', async () => {
    const session = new GameSession(loadSnapshot());
    const kaiKrellis = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    const malKevek = session.board.allUnits().find((u) => u.type.id === 'Dark Sorcerer')!;
    // Real content: not adjacent at t=0 -- so clicking Mal-Kevek here hits
    // the "enemy, but not an attack candidate" branch, not the attack branch.
    session.selectUnit(kaiKrellis);

    const result = await session.handleHexClick(malKevek.location.x, malKevek.location.y);

    expect(session.inspectedUnit).toBe(malKevek);
    expect(session.selectedUnit).toBeNull();
    expect(session.attackCandidates).toEqual([]);
    expect(session.reachable.length).toBeGreaterThan(0);
    expect(result).toContain('Mal-Kevek');
  });

  it("an enemy's reach is shown with its full moves, as it gets them back before it moves again (unit_movement_resetter)", async () => {
    const session = new GameSession(loadSnapshot());
    const malKevek = session.board.allUnits().find((u) => u.type.id === 'Dark Sorcerer')!;
    await session.handleHexClick(malKevek.location.x, malKevek.location.y);
    const full = session.reachable.length;
    expect(full).toBeGreaterThan(0);

    malKevek.movesLeft = 0; // spent on its own turn
    await session.handleHexClick(malKevek.location.x, malKevek.location.y);
    expect(session.reachable.length).toBe(full);
    expect(malKevek.movesLeft).toBe(0); // shown, not given back

    const emptyLoc = new Location(0, 0);
    await session.handleHexClick(emptyLoc.x, emptyLoc.y);
    expect(session.reachable).toEqual([]);
  });

  it('selecting a different unit of mine clears any prior inspection', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    await session.handleHexClick(malKevek.location.x, malKevek.location.y);
    expect(session.inspectedUnit).toBe(malKevek);

    session.selectUnit(kaiKrellis);
    expect(session.inspectedUnit).toBeNull();
  });

  it('clicking empty ground with nothing selected clears any prior inspection', async () => {
    const { session, malKevek } = withAdjacentLeaders();
    await session.handleHexClick(malKevek.location.x, malKevek.location.y);
    expect(session.inspectedUnit).toBe(malKevek);

    // Any real empty hex on the map -- (0, 0) is off-board/water on this map, just needs to have no unit.
    const emptyLoc = new Location(0, 0);
    expect(session.board.unitAt(emptyLoc)).toBeUndefined();
    await session.handleHexClick(emptyLoc.x, emptyLoc.y);
    expect(session.inspectedUnit).toBeNull();
  });

  it('real, reported bug: clicking a hex under fog/shroud does NOT reveal the unit secretly standing there', async () => {
    const { session, malKevek } = withAdjacentLeaders();
    const team = session.board.getTeam(session.playerSide)!;
    team.shroud.enabled = true; // never cleared -- every hex, including malKevek's, starts fully shrouded.
    expect(session.board.isShrouded(session.playerSide, malKevek.location)).toBe(true);

    const result = await session.handleHexClick(malKevek.location.x, malKevek.location.y);

    expect(session.inspectedUnit).toBeNull();
    expect(session.selectedUnit).toBeNull();
    expect(result).toBeNull();
  });
});

describe('CombatPreview/AttackerWeaponOption carry weapon type/range (real, reported bug: melee vs. ranged not shown)', () => {
  it("attackerWeaponOptions reports each real weapon's real type/range", async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);

    const byName = Object.fromEntries(session.attackerWeaponOptions.map((o) => [o.name, o]));
    expect(byName['staff']).toMatchObject({ type: 'impact', range: 'melee' });
    expect(byName['chill wave']).toMatchObject({ type: 'cold', range: 'ranged' });
  });

  it('attacking with a ranged weapon against a defender with only a melee weapon shows NO defender weapon/counter in the preview', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const chillWaveIndex = malKevek.attacks.findIndex((a) => a.name === 'chill wave');
    session.selectAttackerWeapon(chillWaveIndex);

    const preview = session.pendingAttack!.preview;
    expect(preview.attacker.weapon).toMatchObject({ name: 'chill wave', range: 'ranged' });
    expect(preview.defender.weapon).toBeUndefined(); // Kai Krellis' scepter is melee-only -- no counter.
    expect(preview.defender.numBlows).toBe(0);
  });

  it('bugs6.md: a defender with no counter-weapon still carries its predicted HP outcomes', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    session.selectAttackerWeapon(malKevek.attacks.findIndex((a) => a.name === 'chill wave'));

    const { defender } = session.pendingAttack!.preview;
    expect(defender.weapon).toBeUndefined();
    const total = defender.hpDist.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    expect(defender.hpDist[defender.hp]).toBeLessThan(1); // it can be hurt
  });

  it('bugs6.md: the preview says which combatant is slowed', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    malKevek.statuses.add('slowed');
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const staffIndex = malKevek.attacks.findIndex((a) => a.name === 'staff');
    session.selectAttackerWeapon(staffIndex);

    const { attacker, defender } = session.pendingAttack!.preview;
    expect(attacker.slowed).toBe(true);
    expect(defender.slowed).toBe(false);
    expect(attacker.damagePerBlow).toBeLessThan(attacker.baseDamage!);
  });

  it('attacking with the melee weapon against the same defender DOES show a real melee counter-weapon', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const staffIndex = malKevek.attacks.findIndex((a) => a.name === 'staff');
    session.selectAttackerWeapon(staffIndex);

    const preview = session.pendingAttack!.preview;
    expect(preview.attacker.weapon).toMatchObject({ name: 'staff', range: 'melee' });
    expect(preview.defender.weapon).toMatchObject({ name: 'scepter', range: 'melee' });
    expect(preview.defender.numBlows).toBeGreaterThan(0);
  });

  it('real, reported bug (bugs4.md #10): CombatantPreview exposes the real time-of-day/leadership/charge/backstab/chance-to-hit-source inputs the combat dialogs display, not just the final numbers -- all neutral here (no ability/special/ToD-bonus in play), but the fields themselves must exist and be well-formed', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const staffIndex = malKevek.attacks.findIndex((a) => a.name === 'staff');
    session.selectAttackerWeapon(staffIndex);

    const preview = session.pendingAttack!.preview;
    expect(typeof preview.attacker.lawfulBonus).toBe('number');
    expect(typeof preview.defender.lawfulBonus).toBe('number');
    expect(preview.attacker.leadershipBonus).toBe(0); // no leader with the leadership ability adjacent
    expect(preview.defender.leadershipBonus).toBe(0);
    expect(preview.attacker.chargeActive).toBe(false); // neither staff nor scepter has [damage] id=charge
    expect(preview.attacker.backstabActive).toBe(false); // no flanking ally behind the defender
    expect(preview.defender.backstabActive).toBe(false); // never true for a defender's own retaliation
    expect(preview.attacker.chanceToHitSource).toBeNull(); // plain terrain-defense roll, no magical/marksman
    expect(preview.defender.chanceToHitSource).toBeNull();
  });

  it('real, reported bug: a chaotic unit\'s displayed lawfulBonus is its own actual (sign-flipped) damage modifier, not the schedule\'s raw lawful_bonus -- a chaotic unit in daylight actually takes a damage PENALTY, so it must show negative, not the schedule\'s own positive value', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    expect(malKevek.alignment).toBe('chaotic'); // Dark Sorcerer

    // Turn 1 is Dawn (lawful_bonus=0, real schedule) -- jump straight to
    // turn 2 (Morning, lawful_bonus=25) via `turnNumber` directly rather
    // than a real `endTurn()`, which would also auto-play side 2's (Mal-
    // Kevek's own) AI turn and disturb the adjacency this test relies on.
    session.turnNumber = 2;
    const rawLawfulBonus = session.timeOfDayAt(malKevek.location).lawfulBonus;
    expect(rawLawfulBonus).toBe(25); // the schedule's own real Morning value -- sanity-checks the setup itself

    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const staffIndex = malKevek.attacks.findIndex((a) => a.name === 'staff');
    session.selectAttackerWeapon(staffIndex);

    const preview = session.pendingAttack!.preview;
    // The real bug this regresses: before the fix, this read +25 (the raw
    // schedule value) even though malKevek, being chaotic, actually took
    // a REAL -25% damage modifier this exchange.
    expect(preview.attacker.lawfulBonus).toBe(-25);
  });

  it('real, reported bug (bugs5.md #2): backstabActive stays false when the GEOMETRIC flanking condition holds but the attacker\'s own weapon has no backstab special -- a flanking ally alone does not make backstab "active"', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();

    // Place a friendly-to-malKevek unit directly on the opposite side of
    // kaiKrellis from malKevek -- the real geometric backstab condition
    // (see combat.ts's isBackstabActive), using the same direction-index
    // logic it uses internally.
    const dirIndex = ALL_DIRECTIONS.indexOf(directionBetween(malKevek.location, kaiKrellis.location)!);
    const flankerLoc = getAdjacentTiles(kaiKrellis.location)[dirIndex]!;
    const flankerType = malKevek.type; // any real type on malKevek's own side works as the "flanker"
    const flanker = Unit.create(flankerType, malKevek.side, flankerLoc);
    session.board.addUnit(flanker);

    // Confirms the placement above actually satisfies the real geometric
    // condition -- otherwise the assertions below would pass VACUOUSLY
    // (backstabActive would already be false with no flanker at all).
    expect(isBackstabActive(session.board, malKevek.location, kaiKrellis.location)).toBe(true);

    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    const staffIndex = malKevek.attacks.findIndex((a) => a.name === 'staff'); // Dark Sorcerer's staff has no backstab special
    session.selectAttackerWeapon(staffIndex);

    const preview = session.pendingAttack!.preview;
    // The real bug this regresses: before the fix, this read `true` purely
    // from the flanker's geometric position, regardless of the weapon.
    expect(preview.attacker.backstabActive).toBe(false);
    expect(preview.attacker.damagePerBlow).toBe(malKevek.attacks[staffIndex]!.damage); // no backstab doubling either
  });
});

describe('GameSession.lastAttackAnimation hitpoints-before (real, reported bug: the HP bar only ever updated once, at the end of the whole exchange)', () => {
  it('attackerHitpointsBefore/defenderHitpointsBefore capture the REAL pre-combat totals, even though the live units already show the post-combat result by the time confirmAttack() returns', async () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    const attackerHpBefore = malKevek.hitpoints;
    const defenderHpBefore = kaiKrellis.hitpoints;

    session.selectUnit(malKevek);
    await session.handleHexClick(kaiKrellis.location.x, kaiKrellis.location.y);
    await session.confirmAttack();

    expect(session.lastAttackAnimation).not.toBeNull();
    const anim = session.lastAttackAnimation!;
    expect(anim.attackerHitpointsBefore).toBe(attackerHpBefore);
    expect(anim.defenderHitpointsBefore).toBe(defenderHpBefore);
    expect(anim.result.blows.length).toBeGreaterThan(0);
  });
});

describe('GameSession rest-heal (real, reported bug: units that neither moved nor attacked never got the +2 rest heal)', () => {
  // A unit newly placed via board.addUnit() (like a fresh recruit, or these
  // two leaders at scenario start) starts with `resting=false` -- it hasn't
  // been through a real side-turn-start yet, so its very first evaluated
  // turn boundary can never earn the heal (mirrors real Wesnoth: `resting_`
  // only ever gets set true by the per-side-turn-start reset). Every test
  // below spends one "warm-up" endTurn() cycle to reach that reset before
  // asserting anything, exactly as a real freshly-recruited unit would.

  it('a unit that neither moves nor attacks this turn heals REST_HEAL_AMOUNT (2) at the start of its own next turn', async () => {
    const session = new GameSession(loadSnapshot());
    const resolveType = createTypeResolver(session.snapshot);
    const fighterType = resolveType('Merman Fighter');
    // Far from Mal-Kevek and any village, so nothing else touches its hp this cycle.
    const unit = Unit.create(fighterType, 1, new Location(10, 10), { canRecruit: false });
    unit.hitpoints = unit.maxHitpoints - 5;
    session.board.addUnit(unit);

    await session.endTurn(); // warm-up: resting was false, so no heal yet, but is now reset true.
    expect(unit.hitpoints).toBe(unit.maxHitpoints - 5);

    // Rested the whole of this turn too (never selected/moved/attacked) --
    // one endTurn() auto-plays side 2's AI turn and lands back on side 1's
    // next turn (established pattern, see "GameSession.endTurn (hotseat
    // cycling)" above), where the heal should now apply.
    await session.endTurn();

    expect(unit.hitpoints).toBe(unit.maxHitpoints - 3);
  });

  it('real, reported bug (bugs4.md #7): the rest heal above is exposed via lastHealAnimations, not just silently applied -- so the UI can play a floating HP-change numeral/animation for it', async () => {
    const session = new GameSession(loadSnapshot());
    const resolveType = createTypeResolver(session.snapshot);
    const fighterType = resolveType('Merman Fighter');
    const unit = Unit.create(fighterType, 1, new Location(10, 10), { canRecruit: false });
    unit.hitpoints = unit.maxHitpoints - 5;
    session.board.addUnit(unit);

    await session.endTurn(); // warm-up.
    expect(session.lastHealAnimations).toBeNull(); // resting was false yet -- no heal outcome this cycle.

    await session.endTurn();
    expect(session.lastHealAnimations).not.toBeNull();
    const outcome = session.lastHealAnimations!.find((o) => o.unit === unit);
    expect(outcome).toMatchObject({ amount: 2, curePoison: false });
    expect(outcome!.healers).toEqual([]); // a plain rest heal has no contributing healer unit
  });

  it('a unit that moves (but does not attack) this turn does NOT get the rest heal next turn', async () => {
    const session = new GameSession(loadSnapshot());
    const resolveType = createTypeResolver(session.snapshot);
    const fighterType = resolveType('Merman Fighter');
    const unit = Unit.create(fighterType, 1, new Location(10, 10), { canRecruit: false });
    unit.hitpoints = unit.maxHitpoints - 5;
    session.board.addUnit(unit);

    await session.endTurn(); // warm-up.
    const hpBeforeMove = unit.hitpoints;

    session.selectUnit(unit);
    const dest = session.reachable.find((h) => !(h.x === unit.location.x && h.y === unit.location.y));
    expect(dest).toBeDefined();
    await session.handleHexClick(dest!.x, dest!.y);
    expect(unit.location.equals(new Location(dest!.x, dest!.y))).toBe(true);

    await session.endTurn();

    expect(unit.hitpoints).toBe(hpBeforeMove);
  });

  it('a unit that rests one turn, then moves the next, does NOT keep getting the rest heal forever', async () => {
    const session = new GameSession(loadSnapshot());
    const resolveType = createTypeResolver(session.snapshot);
    const fighterType = resolveType('Merman Fighter');
    const unit = Unit.create(fighterType, 1, new Location(10, 10), { canRecruit: false });
    unit.hitpoints = unit.maxHitpoints - 10;
    session.board.addUnit(unit);

    await session.endTurn(); // warm-up.
    await session.endTurn(); // rested -> +2.
    expect(unit.hitpoints).toBe(unit.maxHitpoints - 8);

    session.selectUnit(unit);
    const dest = session.reachable.find((h) => !(h.x === unit.location.x && h.y === unit.location.y));
    expect(dest).toBeDefined();
    await session.handleHexClick(dest!.x, dest!.y);
    const hpAfterMove = unit.hitpoints;

    await session.endTurn(); // moved last turn -> no rest heal this time.
    expect(unit.hitpoints).toBe(hpAfterMove);
  });
});

describe('Abilities & Specials: ambush station (bugs6.md)', () => {
  it("side 2's Wolf Rider walking past the Ranger hidden in forest is ambushed next to it", async () => {
    const session = new GameSession(loadAbilitiesSnapshot());
    const ranger = session.board.allUnits().find((u) => u.id === 'Debug Ranger')!;
    const wolf = session.board.allUnits().find((u) => u.id === 'Ambush Wolf')!;
    expect(ranger.type.id).toBe('Elvish Ranger');

    await session.endTurn();
    expect(session.activeSide).toBe(2);
    // Phase 18a: side 2's hotseat turn is drawn through side 2's eyes, so the Ranger is hidden.
    expect(session.viewingSide).toBe(2);
    expect(session.renderUnits.some((u) => u.id === 'Debug Ranger')).toBe(false);

    session.selectUnit(wolf);
    await session.handleHexClick(0, ranger.location.y);
    // Stopped on the first hex next to the Ranger, short of its goal -- and the Ranger is revealed.
    expect(wolf.location.x).toBe(ranger.location.x + 1);
    expect(session.renderUnits.some((u) => u.id === 'Debug Ranger')).toBe(true);
  });
});

describe('Abilities & Specials: teleport station (Phase 18a)', () => {
  it("the Silver Mage reaches side 1's far village through its teleport and gets there for one move", async () => {
    const session = new GameSession(loadAbilitiesSnapshot());
    await session.runStartupEvents();
    const mage = session.board.allUnits().find((u) => u.id === 'Debug Silver Mage')!;
    const far = new Location(7, 34);
    expect(session.board.villageOwner(mage.location)).toBe(1);
    expect(session.board.villageOwner(far)).toBe(1);

    session.selectUnit(mage);
    expect(session.reachable.some((h) => h.x === far.x && h.y === far.y)).toBe(true);

    const before = mage.movesLeft;
    await session.handleHexClick(far.x, far.y);
    expect(mage.location.equals(far)).toBe(true);
    expect(before - mage.movesLeft).toBe(1);
  });
});

describe('GameSession.confirmAttack real, reported bug: plague kill did not spawn a Walking Corpse', () => {
  it("Debug Plaguebearer's real specials_list=plague, when it kills the weakened Target Plague (hitpoints=6, one hit from its damage=6 touch attack), spawns a real Walking Corpse on the attacker's side", async () => {
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
      await session.handleHexClick(target.location.x, target.location.y);
      expect(session.pendingAttack).not.toBeNull();
      await session.confirmAttack();

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
  it('a single-option advance (Merman Fighter -> Merman Warrior) happens immediately, with no pending choice', async () => {
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
      await s.handleHexClick(d.location.x, d.location.y);
      await s.confirmAttack();
      if (f.type.id === 'Merman Warrior') {
        expect(s.pendingAdvancement).toBeNull();
        expect(f.hitpoints).toBe(f.maxHitpoints);
        expect(s.log[0]).toContain('advances to Merman Warrior');
        return;
      }
    }
    throw new Error('Fighter never landed a hit across 50 seeds -- suspiciously unlucky, or a real regression.');
  });

  it('real, reported bug: lastAttackAnimation captures the PRE-advance type id, even though the live unit already shows the new type by the time confirmAttack() returns', async () => {
    // confirmAttack() resolves the whole exchange AND any resulting
    // advancement synchronously (advanceTo mutates `.type` in place) --
    // an animation built from the live `attacker`/`defender` objects
    // AFTER confirmAttack() returns would show the ALREADY-ADVANCED sprite
    // for the whole fight (e.g. an Archer drawn as a Longbowman mid-swing)
    // instead of only once the fight visually finishes. `attackerTypeId`/
    // `defenderTypeId` are captured before advancement runs, specifically
    // so a renderer can resolve sprites by these instead of the live type.
    const resolveType = createTypeResolver(new GameSession(loadSnapshot()).snapshot);
    const fighterType = resolveType('Merman Fighter');
    const dummyType = resolveType('Merman Citizen');

    for (let seed = 0; seed < 50; seed++) {
      const s = new GameSession(loadSnapshot(), { seed });
      const f = Unit.create(fighterType, 1, new Location(10, 10), { canRecruit: false });
      f.experience = f.maxExperience - 1;
      const d = Unit.create(dummyType, 2, new Location(11, 10));
      d.hitpoints = 1;
      s.board.addUnit(f);
      s.board.addUnit(d);
      s.selectUnit(f);
      await s.handleHexClick(d.location.x, d.location.y);
      await s.confirmAttack();
      if (f.type.id === 'Merman Warrior') {
        expect(s.lastAttackAnimation).not.toBeNull();
        expect(s.lastAttackAnimation!.attackerTypeId).toBe('Merman Fighter');
        expect(s.lastAttackAnimation!.attacker).toBe(f);
        expect(s.lastAttackAnimation!.attacker.type.id).toBe('Merman Warrior'); // the live reference has already moved on
        return;
      }
    }
    throw new Error('Fighter never landed a hit across 50 seeds -- suspiciously unlucky, or a real regression.');
  });

  it('a multi-option advance (Merman Citizen -> Brawler/Fighter/Hunter) blocks on pendingAdvancement until the player chooses', async () => {
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
      await s.handleHexClick(dummy.location.x, dummy.location.y);
      await s.confirmAttack();

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
  it('a scenario-winning kill still sets pendingAdvancement -- GameSession.confirmAttack checks advancement before checkForGameEnd, matching real Wesnoth', async () => {
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
      await s.handleHexClick(malKevek.location.x, malKevek.location.y);
      if (!s.pendingAttack) continue; // not adjacent/no valid attack this seed's layout -- try another.
      await s.confirmAttack();

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

describe('GameSession.menuItems / runMenuItem (Phase 14: real WML/Lua-extensible right-click context menu, [set_menu_item]/[heal_unit])', () => {
  it('surfaces the Combat debug scenario\'s real [set_menu_item] "Reset HP" entry after startup events run', async () => {
    const session = new GameSession(loadCombatSnapshot());
    await session.runStartupEvents();

    expect(session.menuItems).toEqual([{ id: 'reset_hp', label: 'Reset HP' }]);
  });

  it('runMenuItem runs the real [heal_unit] command against whichever unit is at the given hex, healing it to full', async () => {
    const session = new GameSession(loadCombatSnapshot());
    await session.runStartupEvents();
    const hero = session.board.allUnits().find((u) => u.id === 'Debug Hero')!;
    hero.hitpoints = 1;

    const message = await session.runMenuItem('reset_hp', hero.location.x, hero.location.y);

    expect(hero.hitpoints).toBe(hero.maxHitpoints);
    expect(message).toBe('Reset HP.');
    expect(session.log[0]).toBe('Reset HP.');
  });

  it('runMenuItem is a harmless no-op on an empty hex (real [heal_unit] with no matching unit)', async () => {
    const session = new GameSession(loadCombatSnapshot());
    await session.runStartupEvents();

    await expect(session.runMenuItem('reset_hp', 0, 0)).resolves.not.toThrow();
  });

  it('runMenuItem with an unknown id is a no-op (returns null, does not throw)', async () => {
    const session = new GameSession(loadCombatSnapshot());
    await session.runStartupEvents();

    expect(await session.runMenuItem('not_a_real_id', 2, 3)).toBeNull();
  });

  it('a scenario with no [set_menu_item] declarations (real Dead_Water scenario 1) reports no menu items', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();

    expect(session.menuItems).toEqual([]);
  });
});

describe('GameSession.storyParts (Phase 16)', () => {
  it("resolves real Dead Water 1's two [story] blocks: five narrated map parts, then the titled journey part", async () => {
    const snapshot = readScenarioSnapshot(snapshotPath);
    const session = new GameSession(snapshot);

    const parts = session.storyParts();

    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 5).every((p) => p.text.length > 0 && p.backgroundLayers.some((l) => l.image === 'maps/dw.webp' && l.baseLayer))).toBe(true);
    expect(parts[5]!.showTitle).toBe(true);
    expect(parts[5]!.title).toBe(snapshot.scenario.name);
    expect(parts[5]!.floatingImages.map((i) => i.delay)).toEqual([500, 500, 500, 500, 500]);
  });
});

describe('GameSession.nextScenarioId: next_scenario=null ends the campaign (Phase 16 outro)', () => {
  it("real Dead Water epilogue: its start event's [endlevel] wins with no next scenario, while scenario 1 still continues", async () => {
    const epilogue = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/13_Epilogue.json'));
    const session = new GameSession(epilogue);
    const messages = await session.runStartupEvents();

    expect(messages.length).toBeGreaterThan(0);
    expect(session.scenarioResult).toBe('victory');
    expect(session.nextScenarioId).toBeNull();
    expect(session.endLevelPresentation).toEqual({ endText: undefined, endTextDuration: undefined, endCredits: undefined });

    const first = new GameSession(readScenarioSnapshot(snapshotPath));
    expect(first.nextScenarioId).toBe('02_Flight');
  });
});

describe('Phase 18d: the turn limit (play_controller::check_time_over)', () => {
  const withTurns = (turns: number, timeOverEvent?: WmlConfigJson) => {
    const snapshot = loadEconomySnapshot();
    snapshot.scenarioConfigJson.attrs['turns'] = turns;
    if (timeOverEvent) snapshot.scenarioConfigJson.children.push({ tag: 'event', config: timeOverEvent });
    return new GameSession(snapshot);
  };

  it('running past the last turn is a defeat -- real bug: turns= was never enforced', async () => {
    const session = withTurns(1);
    expect(session.turnLimit).toBe(1);
    await session.endTurn();
    expect(session.scenarioResult).toBeNull();
    await session.endTurn(); // turn 1 wraps: time is up.
    expect(session.scenarioResult).toBe('defeat');
  });

  it('a `time over` event that adds turns keeps the game going; [modify_turns] survives a save', async () => {
    const session = withTurns(1, {
      attrs: { name: 'time over' },
      children: [{ tag: 'modify_turns', config: { attrs: { add: 1 }, children: [] } }],
    });
    await session.endTurn();
    await session.endTurn();
    expect(session.scenarioResult).toBeNull();
    expect(session.turnNumber).toBe(2);
    expect(session.turnLimit).toBe(2);
    expect(session.toSaveData().turnLimit).toBe(2);
    await session.endTurn();
    await session.endTurn(); // first_time_only: the event does not fire again.
    expect(session.scenarioResult).toBe('defeat');
  });
});

describe('Phase 18d: a map changed by WML', () => {
  it("GameMap.write reproduces the real scenario's map_data exactly", () => {
    const snapshot = loadSnapshot();
    const session = new GameSession(snapshot);
    expect(session.board.map.write().trim()).toBe(snapshot.map.data.trim());
    expect(session.terrainHexes).toBeNull();
  });

  it('survives a save and a load, villages included', () => {
    const snapshot = loadSnapshot();
    const session = new GameSession(snapshot);
    const village = session.board.map.villages[0]!;
    const plain = new Location(0, 0);
    session.board.changeTerrain(village, session.board.map.getTerrain(plain));
    expect(session.terrainHexes).not.toBeNull();
    const data = session.toSaveData();
    expect(data.mapData).toBeDefined();

    const loaded = GameSession.fromSaveData(snapshot, data);
    expect(loaded.board.map.isVillage(village)).toBe(false);
    expect(loaded.board.map.villages).toHaveLength(session.board.map.villages.length);
    expect(loaded.terrainHexes?.find((h) => h.x === village.x && h.y === village.y)?.code).toBe(session.board.map.getTerrain(plain).toString());
  });
});

describe('Phase 18d: exit hex / enter hex fire mid-move; [cancel_action] stops the unit there', () => {
  it('stops at the first hex whose enter hex event cancels -- the Liberty 3 water warning', async () => {
    const snapshot = loadEconomySnapshot();
    const unit0 = new GameSession(snapshot).board.unitsForSide(1).find((u) => !u.canRecruit) ?? new GameSession(snapshot).board.unitsForSide(1)[0]!;
    const start = unit0.location;
    snapshot.scenarioConfigJson.children.push({
      tag: 'event',
      config: WmlConfig.fromJSON({
        attrs: { name: 'enter hex', first_time_only: false },
        children: [
          { tag: 'filter', config: { attrs: { side: 1 }, children: [{ tag: 'not', config: { attrs: { x: start.wmlX, y: start.wmlY }, children: [] } }] } },
          { tag: 'cancel_action', config: { attrs: {}, children: [] } },
          { tag: 'set_variable', config: { attrs: { name: 'stopped_at', value: '$x1,$y1' }, children: [] } },
        ],
      }).toJSON(),
    });
    const session = new GameSession(snapshot);
    await session.runStartupEvents();
    const unit = session.board.unitAt(start)!;
    await session.handleHexClick(start.x, start.y);
    const far = session.reachable.find((h) => distanceBetween(new Location(h.x, h.y), start) >= 3);
    expect(far).toBeDefined();
    const movesBefore = unit.movesLeft;
    await session.handleHexClick(far!.x, far!.y);
    expect(distanceBetween(unit.location, start)).toBe(1);
    expect(session.getVariable('stopped_at')).toBe(`${unit.location.wmlX},${unit.location.wmlY}`);
    expect(unit.movesLeft).toBeGreaterThan(0);
    expect(unit.movesLeft).toBeLessThan(movesBefore);
  });
});

describe('Phase 18d: [terrain_mask] against the real 1.19 build', () => {
  it("Dead Water 2's prestart mask gives exactly the real game's map, the moved side 4 start included", async () => {
    const snapshot = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/02_Flight.json'));
    const session = new GameSession(snapshot);
    await session.runStartupEvents();
    const real = parseConfig(
      zlib.gunzipSync(fs.readFileSync(path.join(repoRoot, 'packages/ui/src/save/fixtures/dead-water-2-autosave-turn1-1.19.21.gz'))).toString('utf8'),
    )
      .child('snapshot')!
      .getString('map_data');
    const cells = (text: string) => text.trim().split('\n').map((row) => row.split(',').map((c) => c.trim()));
    expect(cells(session.board.map.write())).toEqual(cells(real));
  });
});

describe('Phase 18: map items', () => {
  it("the scenario's own [item]s are on the map, survive a save and a load, and go into a Wesnoth save", async () => {
    const snapshot = loadWolfCoastSnapshot();
    expect(new GameSession(snapshot).mapItems).toEqual([expect.objectContaining({ x: 19, y: 16, image: 'items/storm-trident-buried.png' })]);
    // One more placed by WML, then a load.
    snapshot.scenarioConfigJson.children.push({
      tag: 'event',
      config: parseConfig('[event]\nname=prestart\n[item]\nx=3\ny=3\nimage=items/chest.png\n[/item]\n[/event]').child('event')!.toJSON(),
    });
    const session = new GameSession(snapshot);
    await session.runStartupEvents();
    const data = session.toSaveData();
    expect(data.items).toHaveLength(2);
    expect(data.nextItemName).toBe(1);
    const loaded = GameSession.fromSaveData(snapshot, data);
    expect(loaded.mapItems.map((i) => i.image).sort()).toEqual(['items/chest.png', 'items/storm-trident-buried.png']);
    expect(loaded.toSaveData().nextItemName).toBe(1);
  });
});

describe('Phase 18: map labels', () => {
  it("the scenario's [label] shows; a team label covers it for that team only; both survive a load", async () => {
    const snapshot = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Liberty/01_The_Raid.json'));
    expect(new GameSession(snapshot).mapLabels).toEqual([{ x: 10, y: 0, text: 'Dallben', color: '255,255,255', tooltip: '' }]);
    const session0 = new GameSession(snapshot);
    const myTeam = session0.board.getTeam(session0.viewingSide)!.teamName;
    snapshot.scenarioConfigJson.children.push({
      tag: 'event',
      config: parseConfig(`[event]\nname=prestart\n[label]\nx=11\ny=1\ntext=Home\nteam_name=${myTeam}\n[/label]\n[label]\nx=5\ny=5\ntext=Secret\nteam_name=nobody\n[/label]\n[/event]`).child('event')!.toJSON(),
    });
    const session = new GameSession(snapshot);
    await session.runStartupEvents();
    expect(session.mapLabels.map((l) => l.text)).toEqual(['Home']);
    const loaded = GameSession.fromSaveData(snapshot, session.toSaveData());
    expect(loaded.mapLabels.map((l) => l.text)).toEqual(['Home']);
    expect(loaded.toSaveData().labels).toHaveLength(3);
  });
});

describe('Phase 18: player labels (label_terrain / clear_labels)', () => {
  it('places, clears (scenario labels are immutable) and records them, unsynced, so a replay shows them', async () => {
    const snapshot = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Liberty/01_The_Raid.json'));
    const session = new GameSession(snapshot);
    await session.runStartupEvents();
    const undoable = session.canUndo;
    session.placeLabel({ x: 3, y: 3 }, 'Ford', false, '255,0,0');
    session.placeLabel({ x: 4, y: 4 }, 'Ours', true, '255,0,0');
    expect(session.labelAt({ x: 4, y: 4 })).toEqual({ text: 'Ours', teamOnly: true });
    expect(session.mapLabels.map((l) => `${l.text}:${l.color}`).sort()).toEqual(['Dallben:255,255,255', 'Ford:255,0,0', 'Ours:255,255,255']);
    expect(session.canUndo).toBe(undoable); // labels never touch the undo stack

    const kinds = session.toSaveData().replay!.commands.map((r) => r.command.kind);
    expect(kinds.filter((k) => k === 'label')).toHaveLength(2);

    session.clearLabels();
    expect(session.mapLabels.map((l) => l.text)).toEqual(['Dallben']); // immutable (scenario) label stays

    // A replay of the log reproduces them.
    const save = session.toSaveData();
    const replay = GameSession.forReplay(snapshot, save)!;
    for (const rec of save.replay!.commands.slice(0, -1)) replay.replayCommand(rec);
    expect(replay.mapLabels.map((l) => l.text).sort()).toEqual(['Dallben', 'Ford', 'Ours']);
    replay.replayCommand(save.replay!.commands.at(-1)!);
    expect(replay.mapLabels.map((l) => l.text)).toEqual(['Dallben']);
  });
});

describe('Phase 18: label settings (hidden_label_categories)', () => {
  it('lists team, sides and categories; hiding a side hides the labels it made', async () => {
    const snapshot = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Liberty/01_The_Raid.json'));
    snapshot.scenarioConfigJson.children.push({
      tag: 'event',
      config: parseConfig('[event]\nname=prestart\n[label]\nx=2\ny=2\ntext=Camp\ncategory=places\n[/label]\n[/event]').child('event')!.toJSON(),
    });
    const session = new GameSession(snapshot);
    await session.runStartupEvents();
    session.placeLabel({ x: 5, y: 5 }, 'Mine', false, '255,0,0');
    const ids = session.labelCategories.map((c) => c.id);
    expect(ids[0]).toBe('cat:places');
    expect(ids).toContain('team');
    expect(ids).toContain(`side:${session.viewingSide}`);
    session.hiddenLabelCategories = [`side:${session.viewingSide}`, 'cat:places'];
    expect(session.mapLabels.map((l) => l.text)).toEqual(['Dallben']);
  });
});

describe('GameSession.describeHex (Phase 20: what a screen reader hears for the keyboard cursor)', () => {
  it('names the terrain, the unit standing there, and what Enter would do', () => {
    const { session, malKevek, kaiKrellis } = withAdjacentLeaders();
    // Empty hex: terrain only (no unit is selected, so there is no defense to state).
    const empty = session.describeHex(0, 0);
    expect(empty).toMatch(/^[^.]+\.$/);

    // The unit's own hex: name, type, side, hit points, moves.
    const kaiHere = session.describeHex(kaiKrellis.location.x, kaiKrellis.location.y);
    expect(kaiHere).toContain('Kai Krellis');
    expect(kaiHere).toContain(`side ${kaiKrellis.side}`);
    expect(kaiHere).toContain(`${kaiKrellis.hitpoints} of ${kaiKrellis.maxHitpoints} HP`);

    // With Kai selected, an adjacent enemy can be attacked, and a free reachable hex can be moved to.
    session.selectUnit(kaiKrellis);
    const enemy = session.describeHex(malKevek.location.x, malKevek.location.y);
    expect(enemy).toContain('you can attack it');
    expect(enemy).toContain('% defense');
    const reachable = session.reachable[0]!;
    expect(session.describeHex(reachable.x, reachable.y)).toContain('you can move here');

    // Off the board: nothing to say.
    expect(session.describeHex(-5, 400)).toBe('');
  });
});

describe('GameSession.enemyReach (Phase 22: upstream\'s "Show Enemy Moves" / "Best Possible Enemy Moves")', () => {
  it('is the union of every visible enemy\'s full-movement reach, and leaves their movement as it was', async () => {
    const { reachableHexes } = await import('@wesnothweb2/engine');
    const session = new GameSession(loadSnapshot());
    const viewer = session.board.getTeam(session.viewingSide)!;
    const enemies = session.board.allUnits().filter((u) => viewer.isEnemy(session.board.getTeam(u.side)!));
    expect(enemies.length).toBeGreaterThan(0);
    // Spend some of one enemy's movement: upstream resets it to full for the calculation only.
    enemies[0]!.movesLeft = 0;

    const expected = new Set<string>();
    for (const u of enemies) {
      const saved = u.movesLeft;
      u.movesLeft = u.maxMoves;
      for (const step of reachableHexes(session.board, u, { viewingTeam: viewer }).destinations.values()) expected.add(`${step.curr.x},${step.curr.y}`);
      u.movesLeft = saved;
    }
    const reach = session.enemyReach(false);
    expect(new Set(reach.map((h) => `${h.x},${h.y}`))).toEqual(expected);
    expect(enemies[0]!.movesLeft).toBe(0);
  });

  it('"best possible" ignores units: an enemy held by a zone of control reaches further', () => {
    const { session, malKevek } = withAdjacentLeaders();
    // Viewed from Mal-Kevek's enemy's side, Mal-Kevek sits in Kai Krellis's zone of control.
    expect(malKevek.side).not.toBe(session.viewingSide);
    const normal = new Set(session.enemyReach(false).map((h) => `${h.x},${h.y}`));
    const best = new Set(session.enemyReach(true).map((h) => `${h.x},${h.y}`));
    for (const hex of normal) expect(best.has(hex)).toBe(true);
    expect(best.size).toBeGreaterThan(normal.size);
  });

  it('an enemy the viewing side cannot see (under fog) contributes nothing', () => {
    const session = new GameSession(loadSnapshot());
    const viewer = session.board.getTeam(session.viewingSide)!;
    viewer.fog.enabled = true; // never cleared: every hex is fogged
    expect(session.enemyReach(false)).toEqual([]);
  });
});

describe('GameSession.minimapInput (Phase 22)', () => {
  it('describes the live board: size, terrain, villages with owners, and every unit', () => {
    const session = new GameSession(loadSnapshot());
    const input = session.minimapInput();
    expect(input.width).toBe(session.board.map.w());
    expect(input.height).toBe(session.board.map.h());
    expect(input.terrainAt(0, 0)).toBe(session.board.map.getTerrain(new Location(0, 0)).toString());
    expect(input.villages).toHaveLength(session.board.map.villages.length);
    expect(input.units).toHaveLength(session.board.allUnits().length);
    expect(input.viewingSide).toBe(session.viewingSide);
    // No fog or shroud in Dead Water 1: nothing to hide, so no per-hex visibility at all.
    expect(input.visibility).toBeUndefined();
  });

  it('reports a captured village\'s new owner', () => {
    const session = new GameSession(loadSnapshot());
    const village = session.board.map.villages[0]!;
    session.board.captureVillage(village, session.viewingSide);
    const entry = session.minimapInput().villages.find((v) => v.x === village.x && v.y === village.y)!;
    expect(entry.owner).toBe(session.viewingSide);
  });

  it('under fog, reports hexes as fogged and enemies as unseen', () => {
    const session = new GameSession(loadSnapshot());
    session.board.getTeam(session.viewingSide)!.fog.enabled = true;
    const input = session.minimapInput();
    expect(input.visibility!(0, 0)).toBe('fogged');
    const enemy = input.units.find((u) => input.isEnemy(u.side))!;
    expect(enemy.invisible).toBe(true);
  });
});
