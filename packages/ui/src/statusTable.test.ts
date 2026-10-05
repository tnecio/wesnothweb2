/** The status table's rows (`game_stats::pre_show`, `team::knows_upkeep`, `team_data`). */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenario = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

describe('status table (game_stats)', () => {
  it('lists every side with its leader, team and economy, as team_data counts it', () => {
    const session = new GameSession(readScenarioSnapshot(scenario));
    const rows = session.gameStats;
    expect(rows.map((r) => r.side)).toEqual(session.board.teams().filter((t) => !t.hidden).map((t) => t.side));
    const own = rows.find((r) => r.side === session.viewingSide)!;
    const team = session.board.getTeam(own.side)!;
    const units = session.board.unitsForSide(own.side);
    expect(own.known).toBe(true);
    expect(own.gold).toBe(team.gold);
    expect(own.units).toBe(units.length);
    expect(own.upkeep).toBe(units.reduce((s, u) => s + u.upkeepCost, 0));
    expect(own.leaderName).toBe(session.unitDisplayName(units.find((u) => u.canRecruit)!));
    expect(own.baseIncome).toBe(team.income + 2);
    expect(own.startGold).toBe(team.startGold);
    // A leader on its keep with no villages: income is the base income, less upkeep beyond support.
    const support = session.board.villageCount(own.side) * team.supportPerVillage;
    expect(own.netIncome).toBe(own.baseIncome + session.board.villageCount(own.side) * team.incomePerVillage - Math.max(0, own.upkeep - support));
  });

  it("an enemy's economy is unknown under the viewing side's fog, and its unseen leader is Unknown", () => {
    const session = new GameSession(readScenarioSnapshot(scenario));
    const viewer = session.board.getTeam(session.viewingSide)!;
    const enemy = session.board.teams().find((t) => viewer.isEnemy(t))!;
    const leader = session.board.unitsForSide(enemy.side).find((u) => u.canRecruit)!;
    // Fog everywhere for the viewer, and nothing cleared: the enemy leader cannot be seen.
    viewer.fog.enabled = true;
    viewer.refog();
    const row = session.gameStats.find((r) => r.side === enemy.side)!;
    expect(row.known).toBe(false);
    expect(row.gold).toBeNull();
    expect(row.totalVillages).toBeNull();
    const visible = !viewer.fogged(leader.location);
    expect(row.leaderName).toBe(visible ? session.unitDisplayName(leader) : 'Unknown');
    expect(session.leaderHexOf(enemy.side)).toEqual({ x: leader.location.x, y: leader.location.y });
  });

  it('without fog or shroud every side is known and villages read n/total', () => {
    const session = new GameSession(readScenarioSnapshot(scenario));
    for (const t of session.board.teams()) {
      t.fog.enabled = false;
      t.shroud.enabled = false;
    }
    for (const row of session.gameStats) {
      expect(row.known).toBe(true);
      expect(row.totalVillages).toBe(session.board.map.villages.length);
    }
  });
});
