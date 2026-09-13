import { describe, expect, it } from 'vitest';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import { performAttack } from '../../src/actions/attackSequence.js';

/**
 * `performAttack` (Phase 29's shared move/attack choreography extraction --
 * see its own module doc comment) event-order tests: this is the piece
 * `GameSession.confirmAttack` (human) and the real AI's `combat` candidate
 * action (Phase 29, later) both go through, so a real, previously-
 * undetected gap (the Phase 7 heuristic AI's `executeAttack` calls fired
 * NO events at all beyond `sighted`) can't silently recur.
 */

function flatMoveType(terrainData: TerrainTypeData, defensePercent: number): MoveType {
  const cfg = new WmlConfig();
  const defense = cfg.addChild('defense');
  defense.setAttribute('Gg', defensePercent);
  return MoveType.fromConfig(cfg, terrainData);
}

function makeUnitType(id: string, hitpoints: number, moveType: MoveType, weapon: AttackType): UnitType {
  return new UnitType(id, id, '', 'neutral', 1, hitpoints, 5, 5, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, [weapon], []);
}

function makeWeapon(damage: number, numAttacks: number): AttackType {
  const cfg = new WmlConfig();
  cfg.setAttribute('name', 'test-weapon');
  cfg.setAttribute('type', 'blade');
  cfg.setAttribute('range', 'melee');
  cfg.setAttribute('damage', damage);
  cfg.setAttribute('number', numAttacks);
  return AttackType.fromConfig(cfg);
}

function makeBoard(): { board: GameBoard; terrainData: TerrainTypeData } {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const mapText = 'Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg';
  const board = new GameBoard(GameMap.fromMapString(mapText, terrainData));
  board.addTeam(new Team(1));
  board.addTeam(new Team(2));
  return { board, terrainData };
}

describe('performAttack event ordering', () => {
  it('raises attack end (queued) after a non-lethal exchange, and fires no last breath/die', () => {
    const { board, terrainData } = makeBoard();
    const moveType = flatMoveType(terrainData, 100); // 100 = always hit, per combat.test.ts's own convention (defenseModifier returns chance-to-be-hit)
    const attackerType = makeUnitType('attacker', 30, moveType, makeWeapon(5, 1));
    const defenderType = makeUnitType('defender', 30, moveType, makeWeapon(0, 0));
    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);

    const raised: Array<{ name: string; loc1: Location; loc2: Location }> = [];
    const fired: Array<{ name: string; loc1: Location; loc2: Location }> = [];
    const rng = new RngDeterministic(new MtRng(1));

    const result = performAttack(board, rng, new Location(0, 0), 0, new Location(0, 1), undefined, {
      raise: (name, loc1, loc2) => raised.push({ name, loc1, loc2 }),
      fire: (name, loc1, loc2) => fired.push({ name, loc1, loc2 }),
    });

    expect(result.defenderDied).toBe(false);
    expect(fired).toHaveLength(0);
    expect(raised.map((r) => r.name)).toEqual(['attack end']);
    expect(raised[0]!.loc1.equals(new Location(0, 0))).toBe(true);
    expect(raised[0]!.loc2.equals(new Location(0, 1))).toBe(true);
  });

  it('fires last breath then die (immediately, while the dead unit is still on the board) before raising attack end, on a lethal exchange', () => {
    const { board, terrainData } = makeBoard();
    const moveType = flatMoveType(terrainData, 100);
    const attackerType = makeUnitType('attacker', 30, moveType, makeWeapon(50, 1));
    const defenderType = makeUnitType('defender', 20, moveType, makeWeapon(0, 0));
    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);

    const events: string[] = [];
    let defenderStillOnBoardAtLastBreath = false;
    const rng = new RngDeterministic(new MtRng(1));

    const result = performAttack(board, rng, new Location(0, 0), 0, new Location(0, 1), undefined, {
      raise: (name) => events.push(`raise:${name}`),
      fire: (name, loc1, loc2) => {
        events.push(`fire:${name}`);
        if (name === 'last breath') defenderStillOnBoardAtLastBreath = board.unitAt(loc1) === defender || board.unitAt(loc2) !== undefined;
      },
    });

    expect(result.defenderDied).toBe(true);
    expect(events).toEqual(['fire:last breath', 'fire:die', 'raise:attack end']);
    expect(defenderStillOnBoardAtLastBreath).toBe(true);
  });

  it('with no raise/fire callbacks given, still resolves the attack correctly (both are optional)', () => {
    const { board, terrainData } = makeBoard();
    const moveType = flatMoveType(terrainData, 100);
    const attackerType = makeUnitType('attacker', 30, moveType, makeWeapon(8, 1));
    const defenderType = makeUnitType('defender', 30, moveType, makeWeapon(0, 0));
    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);
    const rng = new RngDeterministic(new MtRng(1));
    expect(() => performAttack(board, rng, new Location(0, 0), 0, new Location(0, 1), undefined)).not.toThrow();
    expect(defender.hitpoints).toBe(22);
  });
});
