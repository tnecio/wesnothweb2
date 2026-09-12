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
import { executeAttack, isBackstabActive } from '../../src/actions/combat.js';

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

function makeUnitType(id: string, hitpoints: number, moveType: MoveType, weapon: AttackType | AttackType[]): UnitType {
  const weapons = Array.isArray(weapon) ? weapon : [weapon];
  return new UnitType(id, id, '', 'neutral', 1, hitpoints, 5, 5, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, weapons, []);
}

function makeWeapon(damage: number, numAttacks: number, range: 'melee' | 'ranged' = 'melee'): AttackType {
  const cfg = new WmlConfig();
  cfg.setAttribute('name', 'test-weapon');
  cfg.setAttribute('type', 'blade');
  cfg.setAttribute('range', range);
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

describe('executeAttack range matching (real, reported bug: melee/ranged retaliation)', () => {
  /**
   * Real Wesnoth (`attack.cpp`'s `choose_defender_weapon`, verified
   * directly): `def.range() != att.range()` -- a defender can only counter
   * with a weapon whose `range=` STRING label matches the attacker's, not
   * merely one whose (largely vestigial, for standard adjacent-hex combat)
   * numeric min/max distance happens to cover the current distance. A
   * melee attacker facing a defender with ONLY a ranged weapon should draw
   * no counter-attack at all.
   */
  it('a melee attacker vs. a defender with only a ranged weapon draws no counter-attack', () => {
    const { board, terrainData } = makeBoard();
    const moveType = flatMoveType(terrainData, 100);
    const attackerType = makeUnitType('spearman', 30, moveType, makeWeapon(8, 1, 'melee'));
    const defenderType = makeUnitType('archer', 30, moveType, makeWeapon(5, 3, 'ranged'));
    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);

    const rng = new RngDeterministic(new MtRng(1));
    const result = executeAttack(board, rng, new Location(0, 0), 0, new Location(0, 1));

    expect(result.blows.every((b) => b.attackerTurn)).toBe(true);
    expect(attacker.hitpoints).toBe(30); // never struck back
  });

  it('a melee attacker vs. a defender with BOTH melee and ranged weapons draws a melee counter, not the ranged one', () => {
    const { board, terrainData } = makeBoard();
    const moveType = flatMoveType(terrainData, 100);
    const attackerType = makeUnitType('spearman', 30, moveType, makeWeapon(8, 1, 'melee'));
    const defenderType = makeUnitType('swordsman-archer', 30, moveType, [makeWeapon(2, 1, 'melee'), makeWeapon(99, 3, 'ranged')]);
    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);

    const rng = new RngDeterministic(new MtRng(1));
    const result = executeAttack(board, rng, new Location(0, 0), 0, new Location(0, 1));

    const counterBlow = result.blows.find((b) => !b.attackerTurn);
    expect(counterBlow).toBeDefined();
    // The 99-damage ranged weapon would have one-shot the attacker (30 hp) --
    // its damage never applying proves the melee (2-damage) weapon was chosen.
    expect(attacker.hitpoints).toBeGreaterThan(0);
  });

  it('two ranged attackers can exchange ranged counter-fire (range compatibility, not "melee always wins")', () => {
    const { board, terrainData } = makeBoard();
    const moveType = flatMoveType(terrainData, 100);
    const attackerType = makeUnitType('archer-1', 30, moveType, makeWeapon(4, 1, 'ranged'));
    const defenderType = makeUnitType('archer-2', 30, moveType, makeWeapon(3, 1, 'ranged'));
    const attacker = Unit.create(attackerType, 1, new Location(0, 0));
    const defender = Unit.create(defenderType, 2, new Location(0, 1));
    board.addUnit(attacker);
    board.addUnit(defender);

    const rng = new RngDeterministic(new MtRng(1));
    const result = executeAttack(board, rng, new Location(0, 0), 0, new Location(0, 1));

    expect(result.blows.some((b) => !b.attackerTurn)).toBe(true);
    expect(attacker.hitpoints).toBeLessThan(30);
  });
});

/** A weapon with one real `[specials][backstab]` child, matching the real `[damage] id=backstab multiply=2` macro shape (see `wesnoth/data/core/macros/weapon_specials.cfg`). */
function makeBackstabWeapon(damage: number): AttackType {
  const cfg = new WmlConfig();
  cfg.setAttribute('name', 'backstab-weapon');
  cfg.setAttribute('type', 'blade');
  cfg.setAttribute('range', 'melee');
  cfg.setAttribute('damage', damage);
  cfg.setAttribute('number', 1);
  const specials = cfg.addChild('specials');
  const backstab = new WmlConfig();
  backstab.setAttribute('id', 'backstab');
  backstab.setAttribute('multiply', 2);
  specials.addChild('damage', backstab);
  return AttackType.fromConfig(cfg);
}

describe('isBackstabActive / real combat backstab damage (2026-09-11: geometric proxy for the real [filter_opponent] condition)', () => {
  // Wider board than makeBoard() -- needs 4 in a row (attacker, defender,
  // flanker, plus border headroom), not just 2.
  function makeRowBoard(): { board: GameBoard; terrainData: TerrainTypeData } {
    const terrainData = flatTerrainData();
    const mapText = Array.from({ length: 6 }, () => 'Gg, Gg, Gg, Gg, Gg, Gg').join('\n');
    const map = GameMap.fromMapString(mapText, terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));
    board.addTeam(new Team(2));
    return { board, terrainData };
  }

  it('is true when an ally of the attacker flanks the defender in a straight line, false without one', () => {
    const { board } = makeRowBoard();
    const t = makeUnitType('u', 20, flatMoveType(flatTerrainData(), 100), makeWeapon(1, 1));
    const attacker = Unit.create(t, 1, new Location(0, 2));
    const defender = Unit.create(t, 2, new Location(1, 2));
    board.addUnit(attacker);
    board.addUnit(defender);
    expect(isBackstabActive(board, attacker.location, defender.location)).toBe(false); // no flanker yet.

    // (0,2) -> (1,2) is a SE step; on this odd-column-offset grid the SE
    // direction continued one more step from (1,2) lands on (2,3), not
    // (2,2) -- verified via Location.toCubic() diffs, not assumed.
    const enemyFlanker = Unit.create(t, 2, new Location(2, 3)); // same side as defender -- not a flank.
    board.addUnit(enemyFlanker);
    expect(isBackstabActive(board, attacker.location, defender.location)).toBe(false);

    board.removeUnitAt(enemyFlanker.location);
    const allyFlanker = Unit.create(t, 1, new Location(2, 3)); // same side as attacker -- real flank.
    board.addUnit(allyFlanker);
    expect(isBackstabActive(board, attacker.location, defender.location)).toBe(true);

    allyFlanker.setStatus('petrified', true);
    expect(isBackstabActive(board, attacker.location, defender.location)).toBe(false); // incapacitated flanker doesn't count.
  });

  it('real combat: a backstab-wielding attacker deals double damage with a flanking ally present, single damage without one', () => {
    const { board } = makeRowBoard();
    const moveType = flatMoveType(flatTerrainData(), 100); // always-hit, for a deterministic damage-only comparison.
    const attackerType = makeUnitType('backstabber', 30, moveType, makeBackstabWeapon(6));
    const defenderType = makeUnitType('target', 99, moveType, makeWeapon(0, 0));
    const allyType = makeUnitType('ally', 20, moveType, makeWeapon(0, 0));

    const attacker = Unit.create(attackerType, 1, new Location(0, 3));
    const defender = Unit.create(defenderType, 2, new Location(1, 3));
    board.addUnit(attacker);
    board.addUnit(defender);

    const rng = new RngDeterministic(new MtRng(7));
    const noFlankResult = executeAttack(board, rng, new Location(0, 3), 0, new Location(1, 3));
    expect(noFlankResult.blows[0]!.damage).toBe(6); // no flanker: real weapon damage, unmultiplied.

    defender.hitpoints = 99;
    attacker.attacksLeft = 1;
    // Straight-line continuation of the (0,3)->(1,3) SE step is (2,4), not
    // (2,3) -- same odd-column-offset geometry as the test above.
    const ally = Unit.create(allyType, 1, new Location(2, 4));
    board.addUnit(ally);
    const rng2 = new RngDeterministic(new MtRng(7));
    const flankResult = executeAttack(board, rng2, new Location(0, 3), 0, new Location(1, 3));
    expect(flankResult.blows[0]!.damage).toBe(12); // flanking ally present: real backstab doubling.
  });
});
