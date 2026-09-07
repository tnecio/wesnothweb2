import { describe, expect, it } from 'vitest';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData, GRASS_LAND } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import { executeAttack } from '../../src/actions/combat.js';

/**
 * Combat resolution tests. Full real-unit-type loading (base_unit/gender
 * inheritance flattening) is a documented, deferred gap -- see UnitType.
 * ts's module doc comment -- so, following the same hybrid pattern already
 * established by test/pathfind/pathfindRealMap.test.ts, these use hand-
 * built UnitType/AttackType with deliberately simple, hand-verifiable
 * stats (0% terrain defense, no specials) rather than real mainline units,
 * so expected outcomes can be computed independently and aren't
 * accidentally "verified" against the same code that produces them.
 */

function flatTerrainData(): TerrainTypeData {
  // Only need GRASS_LAND resolvable for defenseModifier() to not fall back
  // to a default; MoveType.fromConfig below sets its own flat 0% defense
  // table regardless of terrain id, so this is just enough plumbing.
  return TerrainTypeData.fromConfigs([]);
}

/**
 * A move type with a defense entry for the "Gg" terrain code used by
 * `makeBoard()`'s map. With an empty TerrainTypeData (see flatTerrainData),
 * TerrainTypeData.getTerrainInfo falls back to TerrainType.fromDefault(code),
 * whose `.id` is the terrain code's own string form (writeTerrainCode) --
 * NOT an arbitrary label. A first attempt at this test keyed the defense
 * table by a made-up "flat" id, which resolveValue's table.get() never
 * matched, so every lookup silently fell through to DEFENSE_PARAMS'
 * defaultValue (99, the UNREACHABLE sentinel) regardless of the intended
 * percentage -- caught by this test itself asserting an exact expected
 * chanceToHit rather than just "some value in range".
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
  const terrainData = flatTerrainData();
  // Map text embeds its own 1-tile border (see Map.ts's module doc comment,
  // confirmed against the real Home_1.map earlier in this project): a
  // naive 2x2 grid parses to a 0x0 *playable* area, silently making every
  // location on it invalid/off-map -- caught by this test itself when
  // defenseModifier() came back reading a bogus off-map terrain code
  // instead of the intended "Gg". 4x4 raw gives a 2x2 playable interior,
  // comfortably containing both (0,0) and (0,1).
  const mapText = 'Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg';
  const map = GameMap.fromMapString(mapText, terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1));
  board.addTeam(new Team(2));
  return { board, terrainData };
}

describe('executeAttack (hand-built units, hand-verifiable outcomes)', () => {
  it('a 0%-defense target is always hit by a 100%-accurate-equivalent weapon, and damage matches the weapon exactly', () => {
    const { board, terrainData } = makeBoard();
    // defensePercent is the *terrain's* chance-to-be-hit contribution
    // (Wesnoth convention: defenseModifier returns "chance to be hit", so
    // 100 here means "always hit", i.e. 0% actual defense).
    const moveType = flatMoveType(terrainData, 100);
    const attackerType = makeUnitType('attacker', 30, moveType, makeWeapon(8, 1));
    const defenderType = makeUnitType('defender', 30, moveType, makeWeapon(0, 0));

    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);

    const rng = new RngDeterministic(new MtRng(12345));
    const result = executeAttack(board, rng, new Location(0, 0), 0, new Location(0, 1));

    expect(result.blows).toHaveLength(1);
    expect(result.blows[0]!.attackerTurn).toBe(true);
    expect(result.blows[0]!.chanceToHit).toBe(100);
    expect(result.blows[0]!.hit).toBe(true);
    expect(result.blows[0]!.damage).toBe(8);
    expect(defender.hitpoints).toBe(22); // 30 - 8, exactly, no roll-dependence at 100% cth
    expect(attacker.hitpoints).toBe(30); // defender had no weapon, took no damage back
    expect(result.defenderDied).toBe(false);
  });

  it('a 0%-chance-to-hit weapon never lands, regardless of RNG seed', () => {
    const { board, terrainData } = makeBoard();
    const moveType = flatMoveType(terrainData, 0); // "0 chance to be hit" == impossible to hit
    const attackerType = makeUnitType('attacker', 30, moveType, makeWeapon(99, 1));
    const defenderType = makeUnitType('defender', 30, moveType, makeWeapon(0, 0));
    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);

    for (const seed of [1, 2, 3, 999999]) {
      defender.hitpoints = 30;
      attacker.attacksLeft = 1;
      const rng = new RngDeterministic(new MtRng(seed));
      const result = executeAttack(board, rng, new Location(0, 0), 0, new Location(0, 1));
      expect(result.blows[0]!.hit).toBe(false);
      expect(defender.hitpoints).toBe(30);
    }
  });

  it('lethal damage kills the defender, removes it from the board, and awards kill XP to the attacker', () => {
    const { board, terrainData } = makeBoard();
    const moveType = flatMoveType(terrainData, 100);
    const attackerType = makeUnitType('attacker', 30, moveType, makeWeapon(50, 1));
    const defenderType = makeUnitType('defender', 20, moveType, makeWeapon(0, 0));
    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);

    const rng = new RngDeterministic(new MtRng(7));
    const result = executeAttack(board, rng, new Location(0, 0), 0, new Location(0, 1));

    expect(result.defenderDied).toBe(true);
    expect(board.unitAt(new Location(0, 1))).toBeUndefined();
    expect(attacker.experience).toBeGreaterThan(0);
  });

  it('is fully deterministic given the same seed: two independent runs from identical starting state produce identical results', () => {
    function run(seed: number) {
      const { board, terrainData } = makeBoard();
      const moveType = flatMoveType(terrainData, 50);
      const attackerType = makeUnitType('attacker', 30, moveType, makeWeapon(6, 3));
      const defenderType = makeUnitType('defender', 30, moveType, makeWeapon(4, 2));
      const attacker = Unit.create(attackerType, 1, new Location(0, 0));
      const defender = Unit.create(defenderType, 2, new Location(0, 1));
      board.addUnit(attacker);
      board.addUnit(defender);
      const rng = new RngDeterministic(new MtRng(seed));
      const result = executeAttack(board, rng, new Location(0, 0), 0, new Location(0, 1));
      return { result, attackerHp: attacker.hitpoints, defenderHp: defender.hitpoints };
    }

    const runA = run(42);
    const runB = run(42);
    expect(runA.attackerHp).toBe(runB.attackerHp);
    expect(runA.defenderHp).toBe(runB.defenderHp);
    expect(runA.result.blows.map((b) => b.hit)).toEqual(runB.result.blows.map((b) => b.hit));

    const runC = run(43);
    // Different seed should (overwhelmingly likely, with 5 total rolls at
    // 50%) produce a different hit/miss sequence -- guards against the RNG
    // wiring being a no-op that always takes the same branch.
    expect(runA.result.blows.map((b) => b.hit)).not.toEqual(runC.result.blows.map((b) => b.hit));
  });
});
