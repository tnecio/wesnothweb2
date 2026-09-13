import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { LeaderSharesKeepCandidateAction } from '../../src/ai/default/caLeaderSharesKeep.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'leader_shares_keep');
  cfg.setAttribute('score', 10000);
  cfg.setAttribute('max_score', 10000);
  return cfg;
}

describe('LeaderSharesKeepCandidateAction', () => {
  it('moves an own leader off its keep when an allied side has a leader', () => {
    const board = makeBoard(terrainData);
    board.getTeam(1)!.teamName = 'good';
    board.addTeam(new Team(3, { teamName: 'good' })); // allied side, same team_name as side 1
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const leader = Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true }); // on the keep
    board.addUnit(leader);
    const allyLeader = Unit.create(type, 3, Location.fromWml(5, 5), { canRecruit: true });
    board.addUnit(allyLeader);

    const ctx = new AiContext(makeAiHost(board), 1, new Map());
    const ca = new LeaderSharesKeepCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(10000);
    ca.execute();
    expect(board.map.isKeep(leader.location)).toBe(false); // moved off the keep
  });

  it('does nothing when no allied side has a leader', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const leader = Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true });
    board.addUnit(leader);
    const ctx = new AiContext(makeAiHost(board), 1, new Map());
    const ca = new LeaderSharesKeepCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });

  it('does nothing when the own leader is not standing on a keep at all', () => {
    const board = makeBoard(terrainData);
    board.getTeam(1)!.teamName = 'good';
    board.addTeam(new Team(3, { teamName: 'good' }));
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const leader = Unit.create(type, 1, Location.fromWml(5, 5), { canRecruit: true }); // off any keep
    board.addUnit(leader);
    board.addUnit(Unit.create(type, 3, Location.fromWml(6, 6), { canRecruit: true }));
    const ctx = new AiContext(makeAiHost(board), 1, new Map());
    const ca = new LeaderSharesKeepCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });
});
