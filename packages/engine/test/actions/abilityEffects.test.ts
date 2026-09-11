import { describe, expect, it } from 'vitest';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType, type RegistryEntry } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { computeLeadershipBonus, computeResistanceModifier, getActiveAbilities, computeAbilityEffect } from '../../src/actions/abilityEffects.js';

/**
 * `abilityEffects.ts` tests, verified against the ACTUAL real ability
 * definitions in `data/core/macros/abilities.cfg` (`ABILITY_LEADERSHIP`,
 * `ABILITY_STEADFAST`) -- see that module's own doc comment for exactly
 * which parts of the real algorithm this is a port of. Hand-built
 * UnitType/AttackType fixtures throughout, matching this project's
 * established combat-test pattern (see `combat.test.ts`'s own doc
 * comment) -- these ability configs are built with the SAME attributes
 * the real macros set (`value=`/`cumulative=`/`affect_self=`/
 * `[affect_adjacent][filter]formula=` for leadership; `multiply=`/
 * `max_value=`/`[filter_base_value]`/`active_on=` for steadfast), not
 * abbreviated stand-ins, so a real-content regression would show up here.
 */

function terrainData(): TerrainTypeData {
  return TerrainTypeData.fromConfigs([]);
}

function flatMoveType(defensePercent: number, resistances: Record<string, number> = {}): MoveType {
  const cfg = new WmlConfig();
  const defense = cfg.addChild('defense');
  defense.setAttribute('Gg', defensePercent);
  if (Object.keys(resistances).length > 0) {
    const resistance = cfg.addChild('resistance');
    for (const [type, value] of Object.entries(resistances)) resistance.setAttribute(type, value);
  }
  return MoveType.fromConfig(cfg, terrainData());
}

function makeWeapon(damage: number, numAttacks: number, damageType = 'blade'): AttackType {
  const cfg = new WmlConfig();
  cfg.setAttribute('name', 'test-weapon');
  cfg.setAttribute('type', damageType);
  cfg.setAttribute('range', 'melee');
  cfg.setAttribute('damage', damage);
  cfg.setAttribute('number', numAttacks);
  return AttackType.fromConfig(cfg);
}

function makeUnitType(id: string, level: number, hitpoints: number, moveType: MoveType, abilities: RegistryEntry[] = []): UnitType {
  return new UnitType(id, id, '', 'neutral', level, hitpoints, 5, 5, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, [makeWeapon(1, 1)], abilities);
}

/** Matches the real `ABILITY_LEADERSHIP` macro's relevant attributes exactly (see `data/core/macros/abilities.cfg`). */
function leadershipAbilityConfig(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'leadership');
  cfg.setAttribute('value', '(25 * (level - other.level))');
  cfg.setAttribute('cumulative', false);
  cfg.setAttribute('affect_self', false);
  const affectAdjacent = cfg.addChild('affect_adjacent');
  const filter = affectAdjacent.addChild('filter');
  filter.setAttribute('formula', 'level < other.level');
  return cfg;
}

/** Matches the real `ABILITY_STEADFAST` macro's relevant attributes exactly. */
function steadfastAbilityConfig(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'steadfast');
  cfg.setAttribute('multiply', 2);
  cfg.setAttribute('max_value', 50);
  const filterBaseValue = cfg.addChild('filter_base_value');
  filterBaseValue.setAttribute('greater_than', 0);
  filterBaseValue.setAttribute('less_than', 50);
  cfg.setAttribute('affect_self', true);
  cfg.setAttribute('active_on', 'defense');
  return cfg;
}

function makeRowBoard(): GameBoard {
  const mapText = Array.from({ length: 5 }, () => 'Gg, Gg, Gg, Gg, Gg').join('\n');
  const map = GameMap.fromMapString(mapText, terrainData());
  const board = new GameBoard(map);
  board.addTeam(new Team(1));
  board.addTeam(new Team(2));
  return board;
}

describe('computeLeadershipBonus (real ABILITY_LEADERSHIP macro)', () => {
  it('boosts an adjacent lower-level ally by 25% per level difference, and does not boost the leader itself', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0);
    const leaderType = makeUnitType('leader', 3, 30, moveType, [{ tag: 'leadership', config: leadershipAbilityConfig() }]);
    const soldierType = makeUnitType('soldier', 1, 20, moveType, []);

    const leader = Unit.create(leaderType, 1, new Location(1, 2));
    const soldier = Unit.create(soldierType, 1, new Location(0, 2));
    board.addUnit(leader);
    board.addUnit(soldier);

    expect(computeLeadershipBonus(board, soldier)).toBe(50); // 25 * (3 - 1)
    expect(computeLeadershipBonus(board, leader)).toBe(0); // affect_self=no
  });

  it('does not boost a same-or-higher-level adjacent unit ([affect_adjacent][filter] formula="level < other.level")', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0);
    const leaderType = makeUnitType('leader', 2, 30, moveType, [{ tag: 'leadership', config: leadershipAbilityConfig() }]);
    const peerType = makeUnitType('peer', 2, 20, moveType, []);

    const leader = Unit.create(leaderType, 1, new Location(1, 2));
    const peer = Unit.create(peerType, 1, new Location(0, 2));
    board.addUnit(leader);
    board.addUnit(peer);

    expect(computeLeadershipBonus(board, peer)).toBe(0);
  });

  it('only boosts units on the SAME side (real "all adjacent lower-level units from the same side")', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0);
    const leaderType = makeUnitType('leader', 3, 30, moveType, [{ tag: 'leadership', config: leadershipAbilityConfig() }]);
    const allySoldierType = makeUnitType('ally-soldier', 1, 20, moveType, []);

    const leader = Unit.create(leaderType, 1, new Location(1, 2));
    // Different side (2), even if not an enemy team, does not benefit -- affect_allies defaults to
    // same_side_only since leadership sets no affect_allies= itself.
    const otherSideSoldier = Unit.create(allySoldierType, 2, new Location(0, 2));
    board.addUnit(leader);
    board.addUnit(otherSideSoldier);

    expect(computeLeadershipBonus(board, otherSideSoldier)).toBe(0);
  });

  it('with two adjacent leaders, the single best (highest) bonus applies -- not both summed (real set_effect_max)', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0);
    const strongLeaderType = makeUnitType('strong-leader', 4, 30, moveType, [{ tag: 'leadership', config: leadershipAbilityConfig() }]);
    const weakLeaderType = makeUnitType('weak-leader', 2, 30, moveType, [{ tag: 'leadership', config: leadershipAbilityConfig() }]);
    const soldierType = makeUnitType('soldier', 1, 20, moveType, []);

    const soldier = Unit.create(soldierType, 1, new Location(1, 2));
    const strongLeader = Unit.create(strongLeaderType, 1, new Location(0, 2)); // +75 (25*(4-1))
    const weakLeader = Unit.create(weakLeaderType, 1, new Location(2, 3)); // +25 (25*(2-1)) -- adjacent to (1,2) per hex geometry
    board.addUnit(soldier);
    board.addUnit(strongLeader);
    board.addUnit(weakLeader);

    expect(computeLeadershipBonus(board, soldier)).toBe(75);
  });
});

describe('computeResistanceModifier (real ABILITY_STEADFAST macro)', () => {
  it('doubles a positive resistance up to 50%, only while defending (active_on=defense)', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0, { blade: 70 }); // 70 = takes 70% damage = 30% resistant
    const dwarfType = makeUnitType('steadfast-dwarf', 3, 30, moveType, [{ tag: 'resistance', config: steadfastAbilityConfig() }]);
    const dwarf = Unit.create(dwarfType, 1, new Location(0, 0));
    board.addUnit(dwarf);

    // Defending: 30% resistance doubled to 60%, clamped by max_value=50 -> 50% resistance -> resistance_against returns 50.
    expect(computeResistanceModifier(board, dwarf, 'blade', /* defendingUnitIsAttacker */ false)).toBe(50);
    // Attacking (active_on=defense doesn't match): unaffected.
    expect(computeResistanceModifier(board, dwarf, 'blade', /* defendingUnitIsAttacker */ true)).toBe(70);
  });

  it('leaves resistance unaffected outside [filter_base_value]\'s 0-50% range (vulnerabilities, and already->=50% resistances)', () => {
    const board = makeRowBoard();
    const vulnerableMoveType = flatMoveType(0, { fire: 150 }); // 150 = takes 150% damage = a -50% vulnerability, not "greater_than=0"
    const vulnerableType = makeUnitType('vulnerable-dwarf', 3, 30, vulnerableMoveType, [{ tag: 'resistance', config: steadfastAbilityConfig() }]);
    const vulnerable = Unit.create(vulnerableType, 1, new Location(0, 0));
    board.addUnit(vulnerable);
    expect(computeResistanceModifier(board, vulnerable, 'fire', false)).toBe(150);

    const alreadyResistantMoveType = flatMoveType(0, { impact: 40 }); // 40 = 60% resistant, already outside "less_than=50"
    const alreadyResistantType = makeUnitType('already-resistant-dwarf', 3, 30, alreadyResistantMoveType, [
      { tag: 'resistance', config: steadfastAbilityConfig() },
    ]);
    const alreadyResistant = Unit.create(alreadyResistantType, 1, new Location(0, 1));
    board.addUnit(alreadyResistant);
    expect(computeResistanceModifier(board, alreadyResistant, 'impact', false)).toBe(40);
  });

  it('a unit with no resistance ability is unaffected (falls back to the plain move-type value)', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0, { blade: 70 });
    const plainType = makeUnitType('plain', 1, 20, moveType, []);
    const plain = Unit.create(plainType, 1, new Location(0, 0));
    board.addUnit(plain);
    expect(computeResistanceModifier(board, plain, 'blade', false)).toBe(70);
  });
});

describe('getActiveAbilities / computeAbilityEffect (unit-level composition checks)', () => {
  it('an incapacitated (petrified) ability owner grants nothing', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0);
    const leaderType = makeUnitType('leader', 3, 30, moveType, [{ tag: 'leadership', config: leadershipAbilityConfig() }]);
    const soldierType = makeUnitType('soldier', 1, 20, moveType, []);
    const leader = Unit.create(leaderType, 1, new Location(1, 2));
    const soldier = Unit.create(soldierType, 1, new Location(0, 2));
    board.addUnit(leader);
    board.addUnit(soldier);
    leader.setStatus('petrified', true);

    expect(getActiveAbilities(board, soldier, 'leadership')).toHaveLength(0);
    expect(computeLeadershipBonus(board, soldier)).toBe(0);
  });

  it('computeAbilityEffect with no active abilities returns the base value unchanged', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0);
    const soldierType = makeUnitType('soldier', 1, 20, moveType, []);
    const soldier = Unit.create(soldierType, 1, new Location(0, 2));
    board.addUnit(soldier);
    expect(computeAbilityEffect([], 42, soldier)).toBe(42);
  });
});
