/** Phase 25: a game's statistics are recorded, saved, and carried through the campaign. */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenario1 = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');
const scenario2 = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/02_Flight.json');

async function recruitOne(session: GameSession): Promise<string> {
  const leader = session.board.unitsForSide(1).find((u) => u.canRecruit)!;
  session.selectUnit(leader);
  const typeId = session.recruitOptions[0]!.typeId;
  const target = session.recruitTiles[0]!;
  session.selectRecruitType(typeId);
  await session.handleHexClick(target.x, target.y);
  return typeId;
}

describe('GameSession statistics (statistics_t)', () => {
  it('records a recruit under the side, keeps it through a save, and takes it into the next scenario', async () => {
    const session = new GameSession(readScenarioSnapshot(scenario1));
    await session.runStartupEvents();
    const typeId = await recruitOne(session);
    const saveId = session.board.getTeam(1)!.saveId || '1';
    expect(session.statistics.getStats(saveId).recruits.get(typeId)).toBe(1);
    expect(session.campaignStats.masterRecord.map((s) => s.scenarioName)).toEqual([session.scenarioName]);

    const reloaded = GameSession.fromSaveData(session.snapshot, session.toSaveData());
    expect(reloaded.statistics.getStats(saveId).recruits.get(typeId)).toBe(1);

    const enemyLeader = session.board.unitsForSide(2).find((u) => u.canRecruit)!;
    session.board.removeUnitAt(enemyLeader.location);
    // @ts-expect-error -- private, called directly as the carryover tests do.
    session.checkForGameEnd();
    const next = GameSession.startNextScenario(session, readScenarioSnapshot(scenario2));
    expect(next.campaignStats.masterRecord).toHaveLength(2);
    expect(next.statistics.calculateStats(saveId).recruits.get(typeId)).toBe(1);
    expect(next.statistics.getStats(saveId).recruits.size).toBe(0);
  });
});
