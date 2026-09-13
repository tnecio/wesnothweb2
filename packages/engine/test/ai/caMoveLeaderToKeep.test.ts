import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { MoveLeaderToKeepCandidateAction } from '../../src/ai/default/caMoveLeaderToKeep.js';
import { CompositeAspect, facetFromConfig } from '../../src/ai/composite/aspect.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'move_leader_to_keep');
  cfg.setAttribute('score', 120000);
  cfg.setAttribute('max_score', 120000);
  return cfg;
}

function makeCtx(aspects: Map<string, CompositeAspect> = new Map()) {
  const board = makeBoard(terrainData);
  return { ctx: new AiContext(makeAiHost(board), 1, aspects), board };
}

function boolAspect(id: string, value: string): CompositeAspect {
  const cfg = new WmlConfig();
  cfg.setAttribute('value', value);
  return new CompositeAspect(id, facetFromConfig(cfg));
}

describe('MoveLeaderToKeepCandidateAction', () => {
  it('moves a leader off the keep toward its own keep -- no-op when already there', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const leader = Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true });
    board.addUnit(leader);
    const ca = new MoveLeaderToKeepCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0); // already on the (1,1) keep -- nothing to do
  });

  it("walks a leader standing off-keep back to the castle's keep", () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const leader = Unit.create(type, 1, Location.fromWml(2, 1), { canRecruit: true }); // on the castle, not the keep
    board.addUnit(leader);
    const ca = new MoveLeaderToKeepCandidateAction(ctx, makeCfg());
    const score = ca.evaluate();
    expect(score).toBe(120000);
    ca.execute();
    expect(leader.location.equals(Location.fromWml(1, 1))).toBe(true);
  });

  it('skips a passive (non-keep-sharing) leader', () => {
    const { board } = makeCtx();
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const leader = Unit.create(type, 1, Location.fromWml(2, 1), { canRecruit: true });
    board.addUnit(leader);
    const aspects = new Map<string, CompositeAspect>([['passive_leader', boolAspect('passive_leader', 'yes')]]);
    const ctx = new AiContext(makeAiHost(board), 1, aspects);
    const ca = new MoveLeaderToKeepCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });

  it('does NOT skip a passive leader that is also keep-sharing', () => {
    const { board } = makeCtx();
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const leader = Unit.create(type, 1, Location.fromWml(2, 1), { canRecruit: true });
    board.addUnit(leader);
    const aspects = new Map<string, CompositeAspect>([
      ['passive_leader', boolAspect('passive_leader', 'yes')],
      ['passive_leader_shares_keep', boolAspect('passive_leader_shares_keep', 'yes')],
    ]);
    const ctx = new AiContext(makeAiHost(board), 1, aspects);
    const ca = new MoveLeaderToKeepCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(120000);
  });
});
