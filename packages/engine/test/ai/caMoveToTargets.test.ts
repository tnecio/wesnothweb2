import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { CompositeAspect, facetFromConfig } from '../../src/ai/composite/aspect.js';
import { MoveToTargetsCandidateAction } from '../../src/ai/default/caMoveToTargets.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'move_to_targets');
  cfg.setAttribute('score', 3000);
  cfg.setAttribute('max_score', 3000);
  return cfg;
}

function makeCtx() {
  const board = makeBoard(terrainData);
  return { ctx: new AiContext(makeAiHost(board), 1, new Map()), board };
}

describe('MoveToTargetsCandidateAction', () => {
  it('always claims its configured score (mirrors upstream: evaluate() is unconditional)', () => {
    const { ctx } = makeCtx();
    const ca = new MoveToTargetsCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(3000);
  });

  it('advances a unit towards the unclaimed village target', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const unit = Unit.create(type, 1, Location.fromWml(1, 4));
    board.addUnit(unit);
    // No leader on this board -- the "leader" own-side targets (threat/village-via-leader) are skipped, but a
    // scenario without a leader still has no targets at all, so give this test a leader too.
    const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const ca = new MoveToTargetsCandidateAction(ctx, makeCfg());
    ca.execute();

    expect(unit.location.equals(Location.fromWml(1, 4))).toBe(false);
    expect(unit.movesLeft).toBe(0);
  });

  it('a guardian unit stays put and burns its turn instead of chasing a target', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const guard = Unit.create(type, 1, Location.fromWml(3, 4));
    guard.setStatus('guardian', true);
    board.addUnit(guard);
    const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const ca = new MoveToTargetsCandidateAction(ctx, makeCfg());
    ca.execute();

    expect(guard.location.equals(Location.fromWml(3, 4))).toBe(true);
    expect(guard.movesLeft).toBe(0);
  });

  it('a scout is given extra weight towards village targets via scout_village_targeting', () => {
    const { ctx, board } = makeCtx();
    const scoutType = makeUnitType('scout', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1), 10, 'scout');
    const scout = Unit.create(scoutType, 1, Location.fromWml(1, 4));
    board.addUnit(scout);
    const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const ca = new MoveToTargetsCandidateAction(ctx, makeCfg());
    ca.execute();

    // The scout should have made real progress towards the village at (4,4) -- it's the only non-leader target
    // reachable from (1,4), and scouts weight village targets heavily.
    expect(scout.location.equals(Location.fromWml(1, 4))).toBe(false);
  });

  it('[avoid] excludes a target hex from ever being moved to', () => {
    const board = makeBoard(terrainData);
    const avoidCfg = new WmlConfig();
    avoidCfg.setAttribute('x', 4);
    avoidCfg.setAttribute('y', 4);
    const aspects = new Map([['avoid', new CompositeAspect('avoid', facetFromConfig((() => {
      const facet = new WmlConfig();
      facet.addChild('value', avoidCfg);
      return facet;
    })()))]]);
    const ctx = new AiContext(makeAiHost(board), 1, aspects);
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const unit = Unit.create(type, 1, Location.fromWml(1, 4));
    board.addUnit(unit);
    const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const ca = new MoveToTargetsCandidateAction(ctx, makeCfg());
    ca.execute();

    expect(unit.location.equals(Location.fromWml(4, 4))).toBe(false); // never actually reaches the avoided village
  });
});
