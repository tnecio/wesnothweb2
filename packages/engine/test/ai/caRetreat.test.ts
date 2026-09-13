import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType } from '../../src/model/UnitType.js';
import { AiContext } from '../../src/ai/context.js';
import { CompositeAspect, facetFromConfig } from '../../src/ai/composite/aspect.js';
import { RetreatCandidateAction } from '../../src/ai/default/caRetreat.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'retreat');
  cfg.setAttribute('score', 160000);
  cfg.setAttribute('max_score', 160000);
  return cfg;
}

function makeCtx() {
  const board = makeBoard(terrainData);
  return { ctx: new AiContext(makeAiHost(board), 1, new Map()), board };
}

/** A 1-move weakling -- short-legged enough that, from the corner of this board opposite its leader, it truly
 * cannot reach any hex adjacent to the leader (unlike `makeUnitType`'s default 5-move units, which can cross this
 * whole 6x6 board and would always trivially "be in reach of the leader", making retreat's own leader-proximity
 * short-circuit fire regardless of where anyone stands). */
function makeShortLeggedType(id: string, hitpoints: number, damage: number, numAttacks: number): UnitType {
  return new UnitType(
    id, id, '', 'neutral', 1, hitpoints, 1, 5, 0, 1, 5, -1, 500, [], '', false, false, false,
    flatMoveType(terrainData, 50), [makeWeapon(damage, numAttacks)], [],
  );
}

describe('RetreatCandidateAction', () => {
  it('retreats a full-health unit badly outmatched by a nearby enemy, away from the leader', () => {
    const { ctx, board } = makeCtx();
    const weakType = makeShortLeggedType('weakling', 10, 1, 1);
    const unit = Unit.create(weakType, 1, Location.fromWml(4, 4));
    board.addUnit(unit);
    const bruteType = makeUnitType('brute', 40, flatMoveType(terrainData, 50), makeWeapon(15, 3));
    board.addUnit(Unit.create(bruteType, 2, Location.fromWml(5, 4)));
    // Leader far away (and the weakling too short-legged to ever reach its neighborhood) so "can reach leader"
    // never short-circuits the retreat.
    const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const ca = new RetreatCandidateAction(ctx, makeCfg());
    const score = ca.evaluate();
    expect(score).toBe(160000);
    ca.execute();

    expect(unit.movesLeft).toBe(0); // its turn is over either way (moved or stopped in place)
  });

  it('does not retreat a unit that is within reach of its own leader', () => {
    const { ctx, board } = makeCtx();
    const weakType = makeUnitType('weakling', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const unit = Unit.create(weakType, 1, Location.fromWml(2, 2));
    board.addUnit(unit);
    const bruteType = makeUnitType('brute', 40, flatMoveType(terrainData, 50), makeWeapon(15, 3));
    board.addUnit(Unit.create(bruteType, 2, Location.fromWml(3, 2)));
    const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const ca = new RetreatCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });

  it('does not retreat when caution is 0', () => {
    const board = makeBoard(terrainData);
    const zeroCautionCfg = new WmlConfig();
    zeroCautionCfg.setAttribute('value', 0);
    const aspects = new Map([['caution', new CompositeAspect('caution', facetFromConfig(zeroCautionCfg))]]);
    const ctx = new AiContext(makeAiHost(board), 1, aspects);

    const weakType = makeShortLeggedType('weakling', 10, 1, 1);
    board.addUnit(Unit.create(weakType, 1, Location.fromWml(4, 4)));
    const bruteType = makeUnitType('brute', 40, flatMoveType(terrainData, 50), makeWeapon(15, 3));
    board.addUnit(Unit.create(bruteType, 2, Location.fromWml(5, 4)));
    const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const ca = new RetreatCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });
});
