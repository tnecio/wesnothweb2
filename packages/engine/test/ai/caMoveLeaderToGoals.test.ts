import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { CompositeAspect, facetFromConfig } from '../../src/ai/composite/aspect.js';
import { MoveLeaderToGoalsCandidateAction } from '../../src/ai/default/caMoveLeaderToGoals.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'move_leader_to_goals');
  cfg.setAttribute('score', 200000);
  cfg.setAttribute('max_score', 200000);
  return cfg;
}

function makeCtxWithLeaderGoal(x: number, y: number, extra?: (cfg: WmlConfig) => void) {
  const board = makeBoard(terrainData);
  const goalCfg = new WmlConfig();
  goalCfg.setAttribute('x', x);
  goalCfg.setAttribute('y', y);
  extra?.(goalCfg);
  const aspects = new Map([['leader_goal', new CompositeAspect('leader_goal', facetFromConfig(goalCfg))]]);
  const ctx = new AiContext(makeAiHost(board), 1, aspects);
  return { ctx, board };
}

describe('MoveLeaderToGoalsCandidateAction', () => {
  it('moves the leader towards the leader_goal hex', () => {
    const { ctx, board } = makeCtxWithLeaderGoal(6, 6);
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    const leader = Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true });
    board.addUnit(leader);

    const ca = new MoveLeaderToGoalsCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(200000);
    ca.execute();

    expect(leader.location.equals(Location.fromWml(1, 1))).toBe(false); // it moved towards (6,6)
  });

  it('does nothing when no leader_goal aspect is configured', () => {
    const board = makeBoard(terrainData);
    const ctx = new AiContext(makeAiHost(board), 1, new Map());
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const ca = new MoveLeaderToGoalsCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });

  it('scores but does not move when the leader has already reached the goal (and stays put, consuming its move)', () => {
    const { ctx, board } = makeCtxWithLeaderGoal(1, 1);
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    const leader = Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true });
    board.addUnit(leader);

    const ca = new MoveLeaderToGoalsCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(200000);
    ca.execute();

    expect(leader.location.equals(Location.fromWml(1, 1))).toBe(true);
    expect(leader.movesLeft).toBe(0);
  });

  it('refuses to step onto a hex whose enemy threat exceeds max_risk', () => {
    const { ctx, board } = makeCtxWithLeaderGoal(6, 6, (cfg) => cfg.setAttribute('max_risk', 0));
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    const leader = Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true });
    board.addUnit(leader);
    const enemyType = makeUnitType('brute', 30, flatMoveType(terrainData, 50), makeWeapon(10, 2), 0);
    board.addUnit(Unit.create(enemyType, 2, Location.fromWml(3, 3)));

    const ca = new MoveLeaderToGoalsCandidateAction(ctx, makeCfg());
    // max_risk=0 means ANY nonzero enemy power projection disqualifies a hex, so nothing on the route may be safe.
    expect(ca.evaluate()).toBe(0);
  });
});
