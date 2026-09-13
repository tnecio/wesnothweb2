import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { CombatCandidateAction } from '../../src/ai/default/caCombat.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'combat');
  cfg.setAttribute('score', 10000);
  cfg.setAttribute('max_score', 10000);
  return cfg;
}

function makeCtx() {
  const board = makeBoard(terrainData);
  return { ctx: new AiContext(makeAiHost(board), 1, new Map()), board };
}

describe('CombatCandidateAction', () => {
  it('takes a clearly good trade: a strong attacker against a weak, low-cost defender', () => {
    const { ctx, board } = makeCtx();
    const attackerType = makeUnitType('brute', 30, flatMoveType(terrainData, 50), makeWeapon(10, 2), 20);
    const defenderType = makeUnitType('weakling', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1), 5);
    const attacker = Unit.create(attackerType, 1, Location.fromWml(3, 3));
    const defender = Unit.create(defenderType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(defender);

    const ca = new CombatCandidateAction(ctx, makeCfg());
    const score = ca.evaluate();
    expect(score).toBe(10000);
    ca.execute();

    expect(attacker.attacksLeft).toBe(0);
    // The defender either died outright or took real damage -- either way the exchange happened.
    const survivor = board.unitAt(Location.fromWml(4, 3));
    if (survivor) expect(survivor.hitpoints).toBeLessThan(10);
  });

  it('declines a clearly bad trade: a weak attacker against a strong, high-cost defender', () => {
    const { ctx, board } = makeCtx();
    const attackerType = makeUnitType('weakling', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1), 5);
    const defenderType = makeUnitType('brute', 30, flatMoveType(terrainData, 50), makeWeapon(10, 2), 20);
    const attacker = Unit.create(attackerType, 1, Location.fromWml(3, 3));
    const defender = Unit.create(defenderType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(defender);

    const ca = new CombatCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
    ca.execute(); // no-op: nothing should change
    expect(attacker.attacksLeft).toBe(attacker.maxAttacksPerTurn);
    expect(defender.hitpoints).toBe(30);
  });

  it('moves into range before attacking when the attacker is not yet adjacent', () => {
    const { ctx, board } = makeCtx();
    const attackerType = makeUnitType('brute', 30, flatMoveType(terrainData, 50), makeWeapon(10, 2), 20);
    const defenderType = makeUnitType('weakling', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1), 5);
    const attacker = Unit.create(attackerType, 1, Location.fromWml(2, 3));
    const defender = Unit.create(defenderType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(defender);

    const ca = new CombatCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(10000);
    ca.execute();

    expect(attacker.location.equals(Location.fromWml(2, 3))).toBe(false); // it moved
    expect(attacker.movesLeft).toBe(0);
  });

  it('does nothing when there are no visible enemies at all', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 1));
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    const ca = new CombatCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });
});
