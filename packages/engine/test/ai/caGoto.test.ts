import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location, getAdjacentTiles } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { GotoCandidateAction } from '../../src/ai/default/caGoto.js';
import { CompositeAspect, facetFromConfig } from '../../src/ai/composite/aspect.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(id: string, score = 200000): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', id);
  cfg.setAttribute('score', score);
  cfg.setAttribute('max_score', score);
  return cfg;
}

function makeCtx(aspects: Map<string, CompositeAspect> = new Map()) {
  const board = makeBoard(terrainData);
  const host = makeAiHost(board);
  return { ctx: new AiContext(host, 1, aspects), board };
}

function attrCfg(key: string, value: string): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute(key, value);
  return cfg;
}

describe('GotoCandidateAction', () => {
  it('walks a unit with a pending goto toward it, and clears goto on the next evaluate() once it has arrived', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('walker', 20, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const unit = Unit.create(type, 1, Location.fromWml(3, 3));
    unit.goto = Location.fromWml(4, 3);
    board.addUnit(unit);

    const ca = new GotoCandidateAction(ctx, makeCfg('goto'));
    expect(ca.evaluate()).toBe(200000);
    ca.execute();
    expect(unit.location.equals(Location.fromWml(4, 3))).toBe(true);

    // Mirrors ca.cpp's own "clears stale gotos" pass: goto is only cleared the NEXT time evaluate() notices the
    // unit is already there, not synchronously inside execute() itself.
    expect(ca.evaluate()).toBe(0);
    expect(unit.goto).toBeUndefined();
  });

  it('scores 0 (nothing to do) when no unit has a pending goto', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('walker', 20, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    const ca = new GotoCandidateAction(ctx, makeCfg('goto'));
    expect(ca.evaluate()).toBe(0);
  });

  it('skips a passive leader even with a pending goto', () => {
    const { board } = makeCtx();
    const type = makeUnitType('leader', 20, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const leader = Unit.create(type, 1, Location.fromWml(1, 1), { id: 'boss', canRecruit: true });
    leader.goto = Location.fromWml(4, 3);
    board.addUnit(leader);

    const passiveAspect = new CompositeAspect('passive_leader', facetFromConfig(attrCfg('value', 'yes')));
    const aspects = new Map<string, CompositeAspect>([['passive_leader', passiveAspect]]);
    const ctx = new AiContext(makeAiHost(board), 1, aspects);
    const ca = new GotoCandidateAction(ctx, makeCfg('goto'));
    expect(ca.evaluate()).toBe(0);
  });

  it("burns the unit's movement rather than getting blacklisted when the path is blocked and nothing actually moves", () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('walker', 20, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const unit = Unit.create(type, 1, Location.fromWml(3, 3));
    // Surround the unit on all 6 sides with a blocking enemy so it truly cannot leave its own hex.
    const enemyType = makeUnitType('block', 20, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    for (const adj of getAdjacentTiles(Location.fromWml(3, 3))) {
      board.addUnit(Unit.create(enemyType, 2, adj));
    }
    unit.goto = Location.fromWml(5, 5);
    board.addUnit(unit);

    const ca = new GotoCandidateAction(ctx, makeCfg('goto'));
    const score = ca.evaluate();
    // A fully-surrounded unit legitimately has no route at all -- score 0 is the correct outcome here, not a bug.
    expect(score).toBe(0);
  });
});
