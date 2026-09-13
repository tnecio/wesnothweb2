import { describe, expect, it } from 'vitest';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCtx() {
  const board = makeBoard(terrainData);
  return { ctx: new AiContext(makeAiHost(board), 1, new Map()), board };
}

describe('AiContext.getAttacks / AttackAnalysis.rating', () => {
  it('rates a clearly good trade positively at both a cautious and a maximally aggressive setting', () => {
    const { ctx, board } = makeCtx();
    const attackerType = makeUnitType('brute', 30, flatMoveType(terrainData, 50), makeWeapon(10, 2), 20);
    const defenderType = makeUnitType('weakling', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1), 5);
    board.addUnit(Unit.create(attackerType, 1, Location.fromWml(3, 3)));
    board.addUnit(Unit.create(defenderType, 2, Location.fromWml(4, 3)));

    const analyses = ctx.getAttacks();
    expect(analyses.length).toBeGreaterThan(0);
    const best = analyses.find((a) => a.target.equals(Location.fromWml(4, 3)) && a.movements.length === 1)!;
    expect(best).toBeDefined();

    expect(best.targetValue).toBeGreaterThan(0);
    expect(best.chanceToKill).toBeGreaterThan(0);

    // Not asserted as monotonic in aggression: real upstream rewards a village-standing attack via a NEGATIVE
    // avgDamageTaken term scaled by (1-aggression) too, so a combo that routes the attacker onto a village (as the
    // 6-tile terrain rating around the target legitimately prefers here) can rate the cautious setting HIGHER than
    // the aggressive one -- a genuine upstream incentive (safety bonuses discounted by aggression, same as risks),
    // not a port bug. Both settings should still clearly recommend the attack.
    expect(best.rating(0.4, ctx)).toBeGreaterThan(0);
    expect(best.rating(1.0, ctx)).toBeGreaterThan(0);
  });

  it('rates a clearly bad trade non-positively', () => {
    const { ctx, board } = makeCtx();
    const attackerType = makeUnitType('weakling', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1), 5);
    const defenderType = makeUnitType('brute', 30, flatMoveType(terrainData, 50), makeWeapon(10, 2), 20);
    board.addUnit(Unit.create(attackerType, 1, Location.fromWml(3, 3)));
    board.addUnit(Unit.create(defenderType, 2, Location.fromWml(4, 3)));

    const analyses = ctx.getAttacks();
    const combo = analyses.find((a) => a.target.equals(Location.fromWml(4, 3)) && a.movements.length === 1)!;
    expect(combo).toBeDefined();
    expect(combo.rating(0.4, ctx)).toBeLessThanOrEqual(0);
  });

  it('leaves the board exactly as it found it once analyze() returns (attackers restored to their real positions)', () => {
    const { ctx, board } = makeCtx();
    const attackerType = makeUnitType('brute', 30, flatMoveType(terrainData, 50), makeWeapon(10, 2), 20);
    const defenderType = makeUnitType('weakling', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1), 5);
    const attacker = Unit.create(attackerType, 1, Location.fromWml(3, 3));
    const defender = Unit.create(defenderType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(defender);

    ctx.getAttacks(); // forces analyze() to run for every combo found

    expect(board.unitAt(Location.fromWml(3, 3))).toBe(attacker);
    expect(board.unitAt(Location.fromWml(4, 3))).toBe(defender);
    expect(attacker.hitpoints).toBe(30);
    expect(defender.hitpoints).toBe(10);
  });
});
