/**
 * Phase 30: the Combat menu's random modes through the session -- the milestone of `IMPLEMENTATION_PLAN.md`'s
 * Phase 30: the same attack, reloaded from a save, gives the same result under Predictable and Reduced RNG, and
 * may differ under Default RNG. Real scenario: Dead Water 1.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdjacentTiles, type GameBoardSnapshot, type RandomMode } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession, type SaveGameData } from './gameSession.js';
import { randomModeFromParam, randomModeParam } from './menu/randomModes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarios = path.resolve(here, '../../../apps/web/public/scenarios/Dead_Water');
const snapshot = (): GameBoardSnapshot => readScenarioSnapshot(path.join(scenarios, '01_Invasion.json'));

/** A started game with an enemy brought next to Kai Krellis, saved just before he attacks it. */
async function beforeAttack(randomMode: RandomMode): Promise<SaveGameData> {
  const session = new GameSession(snapshot(), { seed: 5, randomMode, actionSeeds: 'entropy' });
  await session.runStartupEvents();
  const kai = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
  const enemy = session.board.unitsForSide(2).find((u) => !u.canRecruit) ?? session.board.unitsForSide(2)[0]!;
  const spot = getAdjacentTiles(kai.location).find((l) => session.board.map.onBoard(l) && !session.board.unitAt(l))!;
  session.board.moveUnit(enemy.location, spot);
  return session.toSaveData();
}

/** Loads `save` and has Kai attack the enemy beside him: the blows' hits. */
async function attackFrom(save: SaveGameData): Promise<string> {
  const session = GameSession.fromSaveData(snapshot(), save, { actionSeeds: 'entropy' });
  const kai = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
  session.selectUnit(kai);
  const foe = session.attackCandidates[0]!;
  const hpBefore = foe.hitpoints;
  await session.handleHexClick(foe.location.x, foe.location.y);
  await session.confirmAttack();
  return `${hpBefore}->${foe.hitpoints}/kai ${kai.hitpoints}`;
}

describe('Phase 30: random modes in the session', () => {
  it('the URL names round-trip, and anything unknown is Default RNG', () => {
    for (const mode of ['per_action', 'deterministic', 'biased'] as const) expect(randomModeFromParam(randomModeParam(mode))).toBe(mode);
    expect(randomModeFromParam('nonsense')).toBe('per_action');
    expect(randomModeFromParam(null)).toBe('per_action');
  });

  it('the mode is saved and loaded', async () => {
    for (const mode of ['per_action', 'deterministic', 'biased'] as const) {
      const save = await beforeAttack(mode);
      expect(save.randomMode).toBe(mode);
      expect(GameSession.fromSaveData(snapshot(), save).toSaveData().randomMode).toBe(mode);
    }
  }, 120_000);

  it('milestone: reloading before an attack repeats it under Predictable and Reduced RNG, and can change it under Default', async () => {
    for (const mode of ['deterministic', 'biased'] as const) {
      const save = await beforeAttack(mode);
      const first = await attackFrom(save);
      for (let i = 0; i < 3; i++) expect(await attackFrom(save), mode).toBe(first);
    }
    const save = await beforeAttack('per_action');
    const outcomes = new Set<string>();
    for (let i = 0; i < 12; i++) outcomes.add(await attackFrom(save));
    expect(outcomes.size).toBeGreaterThan(1);
  }, 240_000);

  it('the mode goes on into the next scenario, as upstream carries random_mode over', async () => {
    const finished = new GameSession(snapshot(), { randomMode: 'biased' });
    await finished.runStartupEvents();
    const enemyLeader = finished.board.unitsForSide(2).find((u) => u.canRecruit)!;
    finished.board.removeUnitAt(enemyLeader.location);
    // @ts-expect-error -- the private check, as gameSession.test.ts's carry-over tests force a win.
    finished.checkForGameEnd();
    expect(finished.scenarioResult).toBe('victory');
    const next = GameSession.startNextScenario(finished, readScenarioSnapshot(path.join(scenarios, '02_Flight.json')));
    expect(next.toSaveData().randomMode).toBe('biased');
  }, 120_000);
});
