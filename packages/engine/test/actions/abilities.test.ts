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
import { ActiveAbilityList, abilityEffect, getAbilities, getAbilityBool, resistanceAgainst, underLeadership } from '../../src/actions/abilities.js';
import { illuminatedLawfulBonus } from '../../src/actions/illumination.js';
import { unitMatchesFilter } from '../../src/events/filter.js';
import { parseConfig } from '../../src/index.js';
import { loadTerrainData } from '../ai/helpers.js';

/**
 * `abilities.ts` tests (Phase 27b; first written for the older `abilityEffects.ts`), verified against the ACTUAL real ability
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

describe('underLeadership (real ABILITY_LEADERSHIP macro)', () => {
  it('boosts an adjacent lower-level ally by 25% per level difference, and does not boost the leader itself', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0);
    const leaderType = makeUnitType('leader', 3, 30, moveType, [{ tag: 'leadership', config: leadershipAbilityConfig() }]);
    const soldierType = makeUnitType('soldier', 1, 20, moveType, []);

    const leader = Unit.create(leaderType, 1, new Location(1, 2));
    const soldier = Unit.create(soldierType, 1, new Location(0, 2));
    board.addUnit(leader);
    board.addUnit(soldier);

    expect(underLeadership(board, soldier)).toBe(50); // 25 * (3 - 1)
    expect(underLeadership(board, leader)).toBe(0); // affect_self=no
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

    expect(underLeadership(board, peer)).toBe(0);
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

    expect(underLeadership(board, otherSideSoldier)).toBe(0);
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

    expect(underLeadership(board, soldier)).toBe(75);
  });
});

describe('resistanceAgainst (real ABILITY_STEADFAST macro)', () => {
  it('doubles a positive resistance up to 50%, only while defending (active_on=defense)', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0, { blade: 70 }); // 70 = takes 70% damage = 30% resistant
    const dwarfType = makeUnitType('steadfast-dwarf', 3, 30, moveType, [{ tag: 'resistance', config: steadfastAbilityConfig() }]);
    const dwarf = Unit.create(dwarfType, 1, new Location(0, 0));
    board.addUnit(dwarf);

    // Defending: 30% resistance doubled to 60%, clamped by max_value=50 -> 50% resistance -> resistance_against returns 50.
    expect(resistanceAgainst(board, dwarf, 'blade', /* defendingUnitIsAttacker */ false)).toBe(50);
    // Attacking (active_on=defense doesn't match): unaffected.
    expect(resistanceAgainst(board, dwarf, 'blade', /* defendingUnitIsAttacker */ true)).toBe(70);
  });

  it('leaves resistance unaffected outside [filter_base_value]\'s 0-50% range (vulnerabilities, and already->=50% resistances)', () => {
    const board = makeRowBoard();
    const vulnerableMoveType = flatMoveType(0, { fire: 150 }); // 150 = takes 150% damage = a -50% vulnerability, not "greater_than=0"
    const vulnerableType = makeUnitType('vulnerable-dwarf', 3, 30, vulnerableMoveType, [{ tag: 'resistance', config: steadfastAbilityConfig() }]);
    const vulnerable = Unit.create(vulnerableType, 1, new Location(0, 0));
    board.addUnit(vulnerable);
    expect(resistanceAgainst(board, vulnerable, 'fire', false)).toBe(150);

    const alreadyResistantMoveType = flatMoveType(0, { impact: 40 }); // 40 = 60% resistant, already outside "less_than=50"
    const alreadyResistantType = makeUnitType('already-resistant-dwarf', 3, 30, alreadyResistantMoveType, [
      { tag: 'resistance', config: steadfastAbilityConfig() },
    ]);
    const alreadyResistant = Unit.create(alreadyResistantType, 1, new Location(0, 1));
    board.addUnit(alreadyResistant);
    expect(resistanceAgainst(board, alreadyResistant, 'impact', false)).toBe(40);
  });

  it('a unit with no resistance ability is unaffected (falls back to the plain move-type value)', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0, { blade: 70 });
    const plainType = makeUnitType('plain', 1, 20, moveType, []);
    const plain = Unit.create(plainType, 1, new Location(0, 0));
    board.addUnit(plain);
    expect(resistanceAgainst(board, plain, 'blade', false)).toBe(70);
  });
});

describe('getAbilities / abilityEffect (unit-level composition checks)', () => {
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

    expect(getAbilities(board, soldier, 'leadership').length).toBe(0);
    expect(underLeadership(board, soldier)).toBe(0);
  });

  it('abilityEffect with no active abilities returns the base value unchanged', () => {
    const board = makeRowBoard();
    const moveType = flatMoveType(0);
    const soldierType = makeUnitType('soldier', 1, 20, moveType, []);
    const soldier = Unit.create(soldierType, 1, new Location(0, 2));
    board.addUnit(soldier);
    expect(abilityEffect(new ActiveAbilityList(board, soldier.location), 42).compositeValue).toBe(42);
  });
});

// --- Phase 27b: what the full pipeline adds ---

const parse = (wml: string): WmlConfig => parseConfig(wml);
const ability = (tag: string, wml: string): RegistryEntry => ({ tag, config: parse(wml) });

describe('abilities.cpp: which abilities are active', () => {
  const moveType = flatMoveType(0);
  const place = (board: GameBoard, side: number, x: number, y: number, abilities: RegistryEntry[] = [], level = 1): Unit => {
    const u = Unit.create(makeUnitType(`u${x}${y}`, level, 20, moveType, abilities), side, new Location(x, y));
    board.addUnit(u);
    return u;
  };

  it('[affect_adjacent] adjacent= limits the directions it reaches, radius= how far', () => {
    const board = makeRowBoard();
    const aura = ability('dummy', 'id=aura\naffect_self=no\n[affect_adjacent]\nadjacent=n\n[/affect_adjacent]');
    const owner = place(board, 1, 2, 2, [aura]);
    const north = place(board, 1, 2, 1);
    const south = place(board, 1, 2, 3);
    expect(getAbilities(board, north, 'dummy').length).toBe(1);
    expect(getAbilities(board, south, 'dummy').length).toBe(0);
    expect(getAbilities(board, owner, 'dummy').length).toBe(0);

    const board2 = makeRowBoard();
    place(board2, 1, 2, 2, [ability('dummy', 'id=wide\n[affect_adjacent]\nradius=2\n[/affect_adjacent]')]);
    expect(getAbilities(board2, place(board2, 1, 2, 0), 'dummy').length).toBe(1);
    expect(getAbilities(board2, place(board2, 1, 4, 4), 'dummy').length).toBe(0);
  });

  it("the owner's [filter] and the receiver's [filter_self] gate it", () => {
    const board = makeRowBoard();
    const own = place(board, 1, 0, 0, [ability('dummy', 'id=a\n[filter]\nside=2\n[/filter]'), ability('dummy', 'id=b\n[filter_self]\nside=1\n[/filter_self]')]);
    expect(getAbilities(board, own, 'dummy').items.map((i) => i.ability.id)).toEqual(['b']);
  });

  it('affect_allies=yes reaches allied sides, affect_enemies=yes enemies', () => {
    const board = makeRowBoard();
    board.getTeam(1)!.teamName = 'good';
    board.getTeam(2)!.teamName = 'bad';
    const aura = ability('dummy', 'id=aura\naffect_enemies=yes\n[affect_adjacent]\n[/affect_adjacent]');
    place(board, 1, 2, 2, [aura]);
    const enemy = place(board, 2, 2, 1);
    expect(getAbilities(board, enemy, 'dummy').length).toBe(1);
  });

  it('the deprecated top-level [filter_adjacent] still counts, with count= its directions', () => {
    const board = makeRowBoard();
    const owner = place(board, 1, 1, 1, [ability('dummy', 'id=pack\n[filter_adjacent]\nadjacent=n,s\nside=1\n[/filter_adjacent]')]);
    expect(getAbilities(board, owner, 'dummy').length).toBe(0);
    place(board, 1, 1, 0);
    expect(getAbilities(board, owner, 'dummy').length).toBe(0);
    place(board, 1, 1, 2);
    expect(getAbilities(board, owner, 'dummy').length).toBe(1);
  });

  it('a conditional skirmisher is one only where its filter holds', () => {
    const board = makeRowBoard();
    const u = place(board, 1, 0, 0, [ability('skirmisher', 'id=skirmisher\n[filter]\n[filter_location]\nx=1\n[/filter_location]\n[/filter]')]);
    expect(getAbilityBool(board, u, 'skirmisher', new Location(0, 3))).toBe(true);
    expect(getAbilityBool(board, u, 'skirmisher', new Location(3, 3))).toBe(false);
  });

  it('[filter_ability] and ability_id_active= in unit filters', () => {
    const board = makeRowBoard();
    const leader = place(board, 1, 2, 2, [{ tag: 'leadership', config: leadershipAbilityConfig() }], 3);
    const soldier = place(board, 1, 2, 3);
    expect(unitMatchesFilter(leader, parse('[filter_ability]\ntag_name=leadership\n[/filter_ability]'), board)).toBe(true);
    expect(unitMatchesFilter(soldier, parse('[filter_ability]\ntag_name=leadership\n[/filter_ability]'), board)).toBe(false);
    // Taught by the adjacent leader.
    expect(unitMatchesFilter(soldier, parse('[filter_ability]\ntag_name=leadership\nactive=yes\n[/filter_ability]'), board)).toBe(true);
    expect(unitMatchesFilter(soldier, parse('ability_id_active=leadership'), board)).toBe(true);
  });
});

describe('unit_abilities::effect', () => {
  const moveType = flatMoveType(0);
  const withAbilities = (configs: string[]): { board: GameBoard; list: ActiveAbilityList } => {
    const board = makeRowBoard();
    const u = Unit.create(makeUnitType('u', 1, 20, moveType, configs.map((c) => ability('dummy', c))), 1, new Location(1, 1));
    board.addUnit(u);
    return { board, list: getAbilities(board, u, 'dummy') };
  };

  it('value= takes the highest positive plus the lowest negative', () => {
    expect(abilityEffect(withAbilities(['id=a\nvalue=10', 'id=b\nvalue=30', 'id=c\nvalue=-5']).list, 0).compositeValue).toBe(25);
  });

  it('add=/sub= keep the best per id; multiply= and divide= scale', () => {
    expect(abilityEffect(withAbilities(['id=a\nadd=3', 'id=a\nadd=5', 'id=b\nadd=1']).list, 10).compositeValue).toBe(16);
    expect(abilityEffect(withAbilities(['id=a\nsub=2', 'id=b\nmultiply=1.5']).list, 10).compositeValue).toBe(12);
    expect(abilityEffect(withAbilities(['id=a\ndivide=2']).list, 9).compositeDoubleValue).toBe(4.5);
  });

  it('priority= groups apply in turn, each starting from the last', () => {
    expect(abilityEffect(withAbilities(['id=a\nadd=10\npriority=1', 'id=b\nmultiply=2']).list, 5).compositeValue).toBe(20);
  });

  it('formulas see base_value; [filter_base_value] gates', () => {
    expect(abilityEffect(withAbilities(['id=a\nvalue="(base_value * 3)"']).list, 7).compositeValue).toBe(21);
    expect(abilityEffect(withAbilities(['id=a\nadd=5\n[filter_base_value]\ngreater_than=10\n[/filter_base_value]']).list, 7).compositeValue).toBe(7);
  });

  it('cumulative=yes adds up in the cumulable mode (leadership)', () => {
    expect(abilityEffect(withAbilities(['id=a\nvalue=10\ncumulative=yes', 'id=b\nvalue=15\ncumulative=yes']).list, 0, undefined, 'cumulable').compositeValue).toBe(25);
    expect(abilityEffect(withAbilities(['id=a\nvalue=10\ncumulative=yes', 'id=b\nvalue=15\ncumulative=yes']).list, 0).compositeValue).toBe(15);
  });

  it('max_value= alone caps; with a lower min_value= upstream gives max_value', () => {
    expect(abilityEffect(withAbilities(['id=a\nadd=50\nmax_value=30']).list, 0).compositeValue).toBe(30);
    expect(abilityEffect(withAbilities(['id=a\nadd=5\nmax_value=30\nmin_value=10']).list, 0).compositeValue).toBe(30);
  });
});

describe("tod_manager's illumination", () => {
  it("a campfire's light=25 lifts night to 0 on its hex only", () => {
    const real = loadTerrainData();
    // The outer ring is the border: the campfire is at 1,1 of a 3x3 board.
    const map = GameMap.fromMapString(['Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg^Ecf, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg'].join('\n'), real);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));
    expect(illuminatedLawfulBonus(board, new Location(1, 1), -25)).toBe(0);
    expect(illuminatedLawfulBonus(board, new Location(0, 0), -25)).toBe(-25);
    expect(illuminatedLawfulBonus(board, new Location(1, 1), 25)).toBe(25);
  });

  it('an illuminating unit lights its own and neighbouring hexes', () => {
    const board = makeRowBoard();
    const illuminates = ability('illuminates', 'id=illuminates\nvalue=25\nmax_value=25\ncumulative=no\naffect_self=yes');
    board.addUnit(Unit.create(makeUnitType('mage', 2, 20, flatMoveType(0), [illuminates]), 1, new Location(2, 2)));
    expect(illuminatedLawfulBonus(board, new Location(2, 2), -25)).toBe(0);
    expect(illuminatedLawfulBonus(board, new Location(2, 1), -25)).toBe(0);
    expect(illuminatedLawfulBonus(board, new Location(0, 0), -25)).toBe(-25);
  });
});
