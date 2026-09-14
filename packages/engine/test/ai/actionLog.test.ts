import { describe, expect, it } from 'vitest';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { findPath } from '../../src/pathfind/pathfind.js';
import { AiContext } from '../../src/ai/context.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

// bugs4.md #2/#3: a side's whole turn resolves before any animation plays back, so every logged
// animation must freeze where the action happened, not where its units end up by the end of the turn.
describe('AiContext action log freezes action locations', () => {
  it('a recruit event keeps the leader at its keep even after that leader moves away later in the same turn', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 50);
    const recruitType = makeUnitType('cheap', 10, moveType, makeWeapon(2, 1), 5);
    const keep = Location.fromWml(1, 1);
    const leader = Unit.create(makeUnitType('leader', 30, moveType, makeWeapon(3, 1), 0), 1, keep, { canRecruit: true });
    board.addUnit(leader);
    const ctx = new AiContext(makeAiHost(board, { resolveType: () => recruitType }), 1, new Map());

    ctx.executeRecruit(board.getTeam(1)!, recruitType, Location.fromWml(2, 1), keep);
    ctx.executeMove(leader, findPath(board, leader, Location.fromWml(4, 4)).steps);

    expect(leader.location.equals(keep)).toBe(false);
    const anim = ctx.drainActionLog().find((a) => a.kind === 'recruit')?.animation;
    expect(anim?.kind).toBe('recruit');
    if (anim?.kind === 'recruit') {
      expect(anim.leaderLocation.equals(keep)).toBe(true);
      expect(anim.unitLocation.equals(Location.fromWml(2, 1))).toBe(true);
    }
  });

  it('an attack event keeps the attacker where it attacked from even after it moves away later in the same turn', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 50);
    const attackFrom = Location.fromWml(3, 3);
    const attacker = Unit.create(makeUnitType('brute', 40, moveType, makeWeapon(1, 1)), 1, attackFrom);
    board.addUnit(attacker);
    board.addUnit(Unit.create(makeUnitType('tank', 40, moveType, makeWeapon(1, 1)), 2, Location.fromWml(4, 3)));
    const ctx = new AiContext(makeAiHost(board), 1, new Map());

    ctx.executeAttack(attackFrom, 0, Location.fromWml(4, 3), -1);
    ctx.executeMove(attacker, findPath(board, attacker, Location.fromWml(2, 3)).steps);

    expect(attacker.location.equals(attackFrom)).toBe(false);
    const anim = ctx.drainActionLog().find((a) => a.kind === 'attack')?.animation;
    expect(anim?.kind).toBe('attack');
    if (anim?.kind === 'attack') {
      expect(anim.attackerLocation.equals(attackFrom)).toBe(true);
      expect(anim.defenderLocation.equals(Location.fromWml(4, 3))).toBe(true);
    }
  });
});
