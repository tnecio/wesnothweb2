/**
 * Phase 18b: the synced command log, replay, and undo/redo.
 *
 * Milestone 1 -- a recorded game replays from its log to a bit-identical
 * state (per-command digests included), and a divergence is reported at
 * the command where it happens. Milestone 2 -- undo and redo restore the
 * exact prior state.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Location, parseConfig, type GameBoardSnapshot, type RecordedCommand, type WmlConfigJson } from '@wesnothweb2/engine';
import { GameSession, type SaveGameData } from './gameSession.js';
import { fromWesnothSave } from './save/wesnothSave.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (name: string): GameBoardSnapshot =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, `apps/web/public/scenarios/${name}.json`), 'utf8')) as GameBoardSnapshot;

/** Dead Water 1 with both sides played by the AI, for `turns` turns. */
async function aiVsAi(seed: number, turns: number): Promise<GameSession> {
  const session = new GameSession(load('01_Invasion'), { seed });
  session.board.getTeam(1)!.controller = 'ai';
  await session.runStartupEvents();
  session.playAiSide(1, []);
  await session.endTurn(turns * 2);
  return session;
}

/** Replays `data`'s whole log headless and returns the replaying session. */
function replayAll(snapshot: GameBoardSnapshot, data: SaveGameData, prepare?: (s: GameSession) => void): GameSession {
  const replay = GameSession.forReplay(snapshot, data)!;
  expect(replay).not.toBeNull();
  prepare?.(replay);
  for (const rec of data.replay!.commands) replay.replayCommand(rec);
  return replay;
}

/**
 * A hotseat game played through the player-facing API only -- recruit
 * what the castle holds, walk every unit toward the enemy leader, attack
 * whatever is adjacent -- so the human command paths are what gets recorded.
 */
async function scriptedHotseat(snapshot: GameBoardSnapshot, seed: number, turns: number): Promise<GameSession> {
  const session = new GameSession(snapshot, { seed });
  await session.runStartupEvents();
  for (let t = 0; t < turns * 2 && !session.scenarioResult; t++) {
    const side = session.activeSide;
    for (const option of session.recruitOptions) {
      const tile = session.autoRecruitTile;
      if (!tile || !option.affordable) continue;
      session.selectRecruitType(option.typeId);
      await session.handleHexClick(tile.x, tile.y);
    }
    const enemyLeader = session.board.allUnits().find((u) => u.side !== side && u.canRecruit);
    for (const unit of session.board.unitsForSide(side)) {
      if (session.scenarioResult || session.board.unitAt(unit.location) !== unit) continue;
      session.selectUnit(unit);
      if (!unit.canRecruit && enemyLeader && session.reachable.length > 0) {
        const target = enemyLeader.location;
        const best = [...session.reachable].sort(
          (a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y),
        )[0]!;
        await session.handleHexClick(best.x, best.y);
      }
      if (session.board.unitAt(unit.location) !== unit) continue;
      session.selectUnit(unit);
      const foe = session.attackCandidates[0];
      if (foe) {
        await session.handleHexClick(foe.location.x, foe.location.y);
        await session.confirmAttack();
        while (session.pendingAdvancement) session.chooseAdvancement(session.pendingAdvancement.options[0]!.id);
      }
    }
    if (!session.scenarioResult) await session.endTurn();
  }
  return session;
}

describe('Phase 18b: the command log', () => {
  it('records [start], [init_side], every action and [end_turn], each with a digest', async () => {
    const session = await aiVsAi(7, 2);
    const kinds = session.replayLog.map((r) => r.command.kind);
    expect(kinds[0]).toBe('start');
    expect(kinds[1]).toBe('init_side');
    expect(kinds).toContain('move');
    expect(kinds).toContain('recruit');
    expect(kinds).toContain('end_turn');
    expect(session.replayLog.every((r) => typeof r.digest === 'string')).toBe(true);
    // Upstream's shape: every [end_turn] is followed by the next side's [init_side].
    kinds.forEach((k, i) => {
      if (k === 'end_turn' && i + 1 < kinds.length) expect(kinds[i + 1]).toBe('init_side');
    });
  }, 60_000);

  it('gives each action that draws random numbers its own recorded seed', async () => {
    const session = await aiVsAi(7, 2);
    const recruits = session.replayLog.filter((r) => r.command.kind === 'recruit');
    expect(recruits.length).toBeGreaterThan(0);
    // At most one seed per action; merfolk recruits draw (traits, names),
    // undead ones do not (one must-have trait, no names) and so ask for none.
    for (const r of session.replayLog) expect(r.dependents.filter((d) => d.kind === 'random_seed').length).toBeLessThanOrEqual(1);
    const drawing = recruits.filter((r) => r.command.kind === 'recruit' && r.command.type.startsWith('Mer'));
    expect(drawing.length).toBeGreaterThan(0);
    for (const r of drawing) expect(r.dependents.filter((d) => d.kind === 'random_seed')).toHaveLength(1);
    for (const r of recruits.filter((r) => r.command.kind === 'recruit' && r.command.type === 'Skeleton')) expect(r.dependents).toEqual([]);
    const seeds = session.replayLog.flatMap((r) => r.dependents.filter((d) => d.kind === 'random_seed').map((d) => (d.kind === 'random_seed' ? d.seed : '')));
    expect(new Set(seeds).size).toBe(seeds.length);
  }, 60_000);

  it('keeps the log and its starting point across a save and a load', async () => {
    const session = await aiVsAi(11, 1);
    const saved = JSON.parse(JSON.stringify(session.toSaveData())) as SaveGameData;
    expect(saved.replay?.commands.length).toBe(session.replayLog.length);
    expect(saved.replay?.start?.startupEventsRun).toBe(false);
    const reloaded = GameSession.fromSaveData(load('01_Invasion'), saved);
    expect(reloaded.replayLog).toEqual(session.replayLog);
    expect(reloaded.stateDigest()).toBe(session.stateDigest());
  }, 60_000);
});

describe('Phase 18b milestone 1: replays are bit-identical', () => {
  it('Dead Water 1, AI against AI for two turns, replays command by command to the same state', async () => {
    const session = await aiVsAi(3, 2);
    const data = session.toSaveData();
    const replay = replayAll(load('01_Invasion'), data, (s) => {
      s.board.getTeam(1)!.controller = 'ai';
    });
    expect(replay.syncIssues).toEqual([]);
    expect(replay.replayLog.map((r) => r.digest)).toEqual(session.replayLog.map((r) => r.digest));
    expect(replay.describeState()).toBe(session.describeState());
  }, 60_000);

  it.each([
    ['synth_combat_01', ['attack']],
    ['synth_economy_01', ['recruit', 'move']],
  ])('a hotseat game on %s played through the player API replays exactly (it includes %j)', async (name, mustInclude) => {
    const snapshot = load(name);
    const session = await scriptedHotseat(snapshot, 5, 5);
    const kinds = new Set(session.replayLog.map((r) => r.command.kind));
    for (const kind of mustInclude) expect(kinds).toContain(kind);
    const replay = replayAll(snapshot, session.toSaveData());
    expect(replay.syncIssues).toEqual([]);
    expect(replay.describeState()).toBe(session.describeState());
  }, 60_000);

  it('flags an injected divergence at the command where it happens', async () => {
    const session = await aiVsAi(3, 2);
    const data = JSON.parse(JSON.stringify(session.toSaveData())) as SaveGameData;
    const commands = data.replay!.commands;
    const index = commands.findIndex((r) => r.command.kind === 'attack' && r.dependents.some((d) => d.kind === 'random_seed'));
    expect(index).toBeGreaterThan(0);
    const dep = commands[index]!.dependents.find((d) => d.kind === 'random_seed')!;
    (dep as { seed: string }).seed = dep.kind === 'random_seed' && dep.seed === '00000001' ? '00000002' : '00000001';

    const replay = GameSession.forReplay(load('01_Invasion'), data)!;
    replay.board.getTeam(1)!.controller = 'ai';
    for (const rec of commands.slice(0, index + 1)) replay.replayCommand(rec);
    expect(replay.syncIssues.map((i) => i.index)).toEqual([index]);
    expect(replay.syncIssues[0]!.command).toBe('attack');
  }, 60_000);

  it('reports a missing recorded seed rather than inventing one silently', async () => {
    const session = await aiVsAi(3, 1);
    const data = JSON.parse(JSON.stringify(session.toSaveData())) as SaveGameData;
    const commands = data.replay!.commands;
    const index = commands.findIndex((r) => r.command.kind === 'recruit');
    commands[index]!.dependents = [];
    const replay = GameSession.forReplay(load('01_Invasion'), data)!;
    for (const rec of commands.slice(0, index + 1)) replay.replayCommand(rec);
    expect(replay.syncIssues[0]).toMatchObject({ index, command: 'recruit' });
    expect(replay.syncIssues[0]!.message).toMatch(/random_seed/);
  }, 60_000);
});

/** synth_economy_01 with a village next to side 1's leader-adjacent spearman, and a moveto event that allows undo. */
async function economySession(extraEvents: WmlConfigJson[] = []): Promise<GameSession> {
  const snapshot = load('synth_economy_01');
  snapshot.scenarioConfigJson.children.push(...extraEvents.map((config) => ({ tag: 'event', config })));
  const session = new GameSession(snapshot, { seed: 1 });
  await session.runStartupEvents();
  return session;
}

/** The first hex `unit` can reach that is an unowned village, if any. */
function reachableVillage(session: GameSession): { x: number; y: number } | undefined {
  return session.reachable.find((h) => session.board.map.isVillage(new Location(h.x, h.y)) && session.board.villageOwner(new Location(h.x, h.y)) === undefined);
}

describe('Phase 18b milestone 2: undo and redo', () => {
  it('undoes a move that took a village -- position, moves, facing, owner, income -- and redoes it to the same state', async () => {
    const session = await economySession();
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const village = reachableVillage(session);
    expect(village).toBeDefined();
    const before = session.describeState();
    const beforeLog = session.replayLog.length;
    const income = session.economyInfo.netIncome;

    await session.handleHexClick(village!.x, village!.y);
    expect(session.board.villageOwner(new Location(village!.x, village!.y))).toBe(1);
    const after = session.describeState();
    expect(session.canUndo).toBe(true);

    expect(session.undo()).toMatch(/Undid move/);
    expect(session.describeState()).toBe(before);
    expect(session.economyInfo.netIncome).toBe(income);
    expect(session.replayLog.length).toBe(beforeLog);
    expect(session.canRedo).toBe(true);

    expect(await session.redo()).toMatch(/Redid move/);
    expect(session.describeState()).toBe(after);
    expect(session.replayLog.length).toBe(beforeLog + 1);
    expect(session.canUndo).toBe(true);
  });

  it('a recruit draws its traits at random and so cannot be undone (upstream: "Removed the possibility to undo unit recruits")', async () => {
    const session = await economySession();
    const option = session.recruitOptions.find((o) => o.affordable)!;
    session.selectRecruitType(option.typeId);
    const tile = session.autoRecruitTile!;
    await session.handleHexClick(tile.x, tile.y);
    expect(session.board.unitAt(new Location(tile.x, tile.y))).toBeDefined();
    expect(session.canUndo).toBe(false);
  });

  it('a new action clears what could be redone, and an attack or end of turn clears everything', async () => {
    const session = await economySession();
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const [a, b] = session.reachable;
    await session.handleHexClick(a!.x, a!.y);
    session.undo();
    expect(session.canRedo).toBe(true);
    session.selectUnit(leader);
    await session.handleHexClick(b!.x, b!.y);
    expect(session.canRedo).toBe(false);
    expect(session.canUndo).toBe(true);
    await session.endTurn();
    expect(session.canUndo).toBe(false);
  });

  it('[allow_undo] keeps a move with a moveto event undoable and [on_undo] reverts what the event did; without it, the move is final', async () => {
    const counting = (allow: boolean): WmlConfigJson => ({
      attrs: { name: 'moveto', first_time_only: 'no' },
      children: [
        { tag: 'set_variable', config: { attrs: { name: 'steps', add: 1 }, children: [] } },
        ...(allow
          ? [
              { tag: 'allow_undo', config: { attrs: {}, children: [] } },
              { tag: 'on_undo', config: { attrs: {}, children: [{ tag: 'set_variable', config: { attrs: { name: 'steps', sub: 1 }, children: [] } }] } },
            ]
          : []),
      ],
    });

    const allowed = await economySession([counting(true)]);
    const leader = allowed.board.unitsForSide(1).find((u) => u.canRecruit)!;
    allowed.selectUnit(leader);
    const hex = allowed.reachable[0]!;
    await allowed.handleHexClick(hex.x, hex.y);
    expect(allowed.getVariable('steps')).toBe(1);
    expect(allowed.canUndo).toBe(true);
    allowed.undo();
    expect(allowed.getVariable('steps')).toBe(0);
    await allowed.redo();
    expect(allowed.getVariable('steps')).toBe(1);

    const blocked = await economySession([counting(false)]);
    const leader2 = blocked.board.unitsForSide(1).find((u) => u.canRecruit)!;
    blocked.selectUnit(leader2);
    await blocked.handleHexClick(blocked.reachable[0]!.x, blocked.reachable[0]!.y);
    expect(blocked.getVariable('steps')).toBe(1);
    expect(blocked.canUndo).toBe(false);
  });

  it('recall and dismissal undo back into the same recall-list slot, and redo recalls the same unit', async () => {
    const session = await economySession();
    // Give side 1 a recall list by carrying two units off the board.
    const extras = session.board.unitsForSide(1).filter((u) => !u.canRecruit);
    const side1 = session.board.unitsForSide(1);
    expect(side1.length).toBeGreaterThan(0);
    const template = side1[0]!;
    for (const id of ['r1', 'r2', 'r3']) {
      const clone = GameSession.fromSaveData(load('synth_economy_01'), session.toSaveData()).board.unitsForSide(1)[0]!;
      clone.id = id;
      clone.canRecruit = false;
      clone.location = Location.NULL;
      session.board.addToRecallList(1, clone);
    }
    void extras;
    void template;
    const ids = () => session.board.recallList(1).map((u) => u.id);
    const gold = session.board.getTeam(1)!.gold;
    const tile = session.autoRecruitTile!;

    session.selectRecallUnit(1);
    await session.handleHexClick(tile.x, tile.y);
    expect(ids()).toEqual(['r1', 'r3']);
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(ids()).toEqual(['r1', 'r2', 'r3']);
    expect(session.board.getTeam(1)!.gold).toBe(gold);
    await session.redo();
    expect(session.board.unitAt(new Location(tile.x, tile.y))?.id).toBe('r2');

    session.dismissRecallUnit(0);
    expect(ids()).toEqual(['r3']);
    session.undo();
    expect(ids()).toEqual(['r1', 'r3']);
  });

  it('the undo stack survives a save and a load', async () => {
    const session = await economySession();
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const village = reachableVillage(session)!;
    const before = session.describeState();
    await session.handleHexClick(village.x, village.y);
    const saved = JSON.parse(JSON.stringify(session.toSaveData())) as SaveGameData;
    const reloaded = GameSession.fromSaveData(load('synth_economy_01'), saved);
    expect(reloaded.canUndo).toBe(true);
    reloaded.undo();
    expect(reloaded.describeState()).toBe(before);
  });

  it('undone commands leave the log, so a replay of the final log still matches', async () => {
    const session = await economySession();
    const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
    session.selectUnit(leader);
    const [a, b] = session.reachable;
    await session.handleHexClick(a!.x, a!.y);
    session.undo();
    session.selectUnit(leader);
    await session.handleHexClick(b!.x, b!.y);
    await session.endTurn();
    const replay = replayAll(load('synth_economy_01'), session.toSaveData());
    expect(replay.syncIssues).toEqual([]);
    expect(replay.describeState()).toBe(session.describeState());
    const moves = session.replayLog.filter((r: RecordedCommand) => r.command.kind === 'move');
    expect(moves).toHaveLength(1);
  });
});

describe('Phase 18b milestone 4: a replay recorded by the real Wesnoth 1.16.9 replays here', () => {
  it("Dead Water 1's real [start] (seed e5eacb0f) spawns the very same units, traits and genders here as it did in the real game", () => {
    const cfg = parseConfig(gunzipSync(fs.readFileSync(path.join(repoRoot, 'packages/ui/src/save/fixtures/dead-water-1-autosave-1.16.9.gz'))).toString('utf8'));
    const { save } = fromWesnothSave(cfg);
    expect(save.replay?.commands.map((c) => c.command.kind)).toEqual(['start', 'init_side']);

    const session = GameSession.forReplay(load('01_Invasion'), save)!;
    for (const rec of save.replay!.commands) expect(session.replayCommand(rec)).toBe(true);
    expect(session.syncIssues).toEqual([]);

    // The real game's own record of what that [start] produced.
    const real = cfg
      .child('snapshot')!
      .children('side')
      .flatMap((side) => side.children('unit'))
      .filter((u) => u.hasAttribute('x'));
    expect(real.length).toBeGreaterThan(10);
    const describe = (type: string, traits: string[], gender: string) => `${type} [${traits.join(',')}] ${gender}`;
    for (const u of real) {
      const ours = session.board.unitAt(Location.fromWml(u.getNumber('x'), u.getNumber('y')));
      const realTraits = (u.child('modifications')?.children('trait') ?? []).map((t) => t.getString('id'));
      expect(ours && describe(ours.type.id, ours.modifications.filter((m) => m.kind === 'trait').map((m) => m.cfg.getString('id')), ours.gender)).toBe(
        describe(u.getString('type'), realTraits, u.getString('gender', 'male')),
      );
    }
    expect(session.board.allUnits()).toHaveLength(real.length);
  });
});
