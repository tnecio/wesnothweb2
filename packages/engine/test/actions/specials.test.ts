/**
 * Phase 27b S2-S3: weapon specials through the ability pipeline (`battle_context_unit_stats`), on real mainline
 * units -- each special as its macro in `data/core/macros/weapon_specials.cfg` defines it, filters included.
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../helpers/realContent.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location, relativeDirection } from '../../src/model/Location.js';
import { AttackType } from '../../src/model/UnitType.js';
import { parseConfig } from '../../src/index.js';
import { buildBattleContext, chooseDefenderWeaponIndex, fillWeaponChoices } from '../../src/actions/combatStats.js';
import { SpecialsContext, resistanceAgainst } from '../../src/actions/abilities.js';
import { roundDamage } from '../../src/actions/gameConfig.js';
import { calculateHealing } from '../../src/actions/heal.js';

const real = loadRealContent();

function board(rows: readonly string[] = ['Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg']): GameBoard {
  const b = new GameBoard(real.map(rows));
  b.addTeam(new Team(1, { teamName: 'one' }));
  b.addTeam(new Team(2, { teamName: 'two' }));
  return b;
}

function place(b: GameBoard, type: string, side: number, x: number, y: number): Unit {
  const u = Unit.create(real.unitType(type), side, new Location(x, y));
  b.addUnit(u);
  b.assignUnitId(u);
  return u;
}

const weaponIndex = (u: Unit, name: string): number => u.attacks.findIndex((a) => a.id === name);

function fight(b: GameBoard, attacker: Unit, weapon: string, defender: Unit, defenderWeapon?: string) {
  const ai = weaponIndex(attacker, weapon);
  const di = defenderWeapon === undefined ? chooseDefenderWeaponIndex({ board: b, attacker, defender }, ai) : weaponIndex(defender, defenderWeapon);
  return buildBattleContext({ board: b, attacker, attackerWeapon: attacker.attacks[ai], defender, defenderWeapon: di >= 0 ? defender.attacks[di] : undefined });
}

describe('chance to hit', () => {
  it("magical: 70% whatever the target's defense, on offense and defense", () => {
    const b = board();
    const mage = place(b, 'Mage', 1, 1, 1);
    const spearman = place(b, 'Spearman', 2, 2, 1);
    expect(fight(b, mage, 'missile', spearman).attacker.chanceToHit).toBe(70);
    // The staff is not magical: the spearman's 40% flat defense.
    expect(fight(b, mage, 'staff', spearman).attacker.chanceToHit).toBe(60);
  });

  it('marksman: at least 60%, only on offense', () => {
    const b = board(['Ch, Ch, Gg', 'Gg, Gg, Gg']);
    const marksman = place(b, 'Elvish Marksman', 1, 0, 0);
    const spearman = place(b, 'Spearman', 2, 1, 0);
    // The spearman stands on a castle (60% defense): marksman lifts the 40% to 60.
    expect(fight(b, marksman, 'longbow', spearman).attacker.chanceToHit).toBe(60);
    // Defending against the spearman's javelin, the longbow is not marksman.
    const answer = fight(b, spearman, 'javelin', marksman, 'longbow');
    expect(answer.defender.chanceToHit).toBe(40);
  });
});

describe('damage', () => {
  it("charge doubles both sides' damage, only when attacking", () => {
    const b = board();
    const horseman = place(b, 'Horseman', 1, 1, 1);
    const spearman = place(b, 'Spearman', 2, 2, 1);
    const stats = fight(b, horseman, 'spear', spearman, 'spear');
    const lance = horseman.attacks[weaponIndex(horseman, 'spear')]!;
    const spear = spearman.attacks[weaponIndex(spearman, 'spear')]!;
    const plain = (base: number, res: number) => roundDamage(base, 100 * res, 10000);
    expect(stats.attacker.damage).toBe(plain(lance.damage * 2, resistanceAgainst(b, spearman, lance.type, false)));
    expect(stats.defender.damage).toBe(plain(spear.damage * 2, resistanceAgainst(b, horseman, spear.type, true)));
    // The spear is firststrike: the defender strikes first.
    expect(stats.defender.firststrike).toBe(true);
  });

  it("backstab doubles damage with an enemy of the target behind it, by the special's own formula", () => {
    const b = board();
    const thief = place(b, 'Thief', 1, 1, 1);
    const spearman = place(b, 'Spearman', 2, 2, 1);
    const without = fight(b, thief, 'dagger', spearman).attacker.damage;
    // An ally of the thief behind the spearman, in the thief's direction of attack.
    const behind = spearman.location.getDirection(relativeDirection(thief.location, spearman.location));
    place(b, 'Spearman', 1, behind.x, behind.y);
    expect(fight(b, thief, 'dagger', spearman).attacker.damage).toBe(without * 2);
  });

  it('leadership: a higher-level adjacent ally adds 25% per level', () => {
    const b = board();
    const spearman = place(b, 'Spearman', 1, 1, 1);
    const target = place(b, 'Spearman', 2, 2, 1);
    expect(fight(b, spearman, 'spear', target).attacker.leadershipBonus).toBe(0);
    place(b, 'Lieutenant', 1, 0, 1);
    expect(fight(b, spearman, 'spear', target).attacker.leadershipBonus).toBe(25);
  });

  it('steadfast doubles resistance up to 50%, only when defending', () => {
    const b = board();
    const dwarf = place(b, 'Dwarvish Guardsman', 2, 2, 1);
    const spearman = place(b, 'Spearman', 1, 1, 1);
    const base = dwarf.resistanceAgainst('pierce');
    const doubled = 100 - Math.min(50, 2 * (100 - base));
    expect(resistanceAgainst(b, dwarf, 'pierce', false)).toBe(doubled);
    expect(resistanceAgainst(b, dwarf, 'pierce', true)).toBe(base);
    void spearman;
  });
});

describe('strikes and rounds', () => {
  it('berserk fights 30 rounds', () => {
    const b = board();
    const ulf = place(b, 'Dwarvish Ulfserker', 1, 1, 1);
    const target = place(b, 'Spearman', 2, 2, 1);
    expect(fight(b, ulf, 'berserker frenzy', target).attacker.rounds).toBe(30);
  });

  it('swarm strikes fewer the more the unit is hurt', () => {
    const b = board(['Ww, Ww, Ww', 'Ww, Ww, Ww']);
    const fish = place(b, 'Cuttle Fish', 1, 0, 0);
    const target = place(b, 'Cuttle Fish', 2, 1, 0);
    const full = fight(b, fish, 'tentacle', target).attacker;
    expect(full.swarm).toBe(true);
    expect(full.numBlows).toBe(full.swarmMax);
    fish.hitpoints = Math.floor(fish.maxHitpoints / 2);
    expect(fight(b, fish, 'tentacle', target).attacker.numBlows).toBeLessThan(full.swarmMax);
  });
});

describe('effects on hit, and immunities', () => {
  it('drains, but not from the undead', () => {
    const b = board();
    const bat = place(b, 'Vampire Bat', 1, 1, 1);
    const spearman = place(b, 'Spearman', 2, 2, 1);
    const s = fight(b, bat, 'fangs', spearman).attacker;
    expect([s.drains, s.drainPercent]).toEqual([true, 50]);
    const corpse = place(b, 'Walking Corpse', 2, 1, 2);
    expect(fight(b, bat, 'fangs', corpse).attacker.drains).toBe(false);
  });

  it('slow, but not an already slowed unit', () => {
    const b = board();
    const shaman = place(b, 'Elvish Shaman', 1, 1, 1);
    const spearman = place(b, 'Spearman', 2, 2, 1);
    expect(fight(b, shaman, 'entangle', spearman).attacker.slows).toBe(true);
    spearman.setStatus('slowed', true);
    expect(fight(b, shaman, 'entangle', spearman).attacker.slows).toBe(false);
  });

  it('plague turns its victim into its own kind, but not on a village', () => {
    const b = board(['Gg, Gg, Gg^Vh', 'Gg, Gg, Gg']);
    const corpse = place(b, 'Walking Corpse', 1, 1, 0);
    const spearman = place(b, 'Spearman', 2, 0, 0);
    const s = fight(b, corpse, 'touch', spearman).attacker;
    expect([s.plagues, s.plagueType]).toEqual([true, 'Walking Corpse']);
    const onVillage = place(b, 'Spearman', 2, 2, 0);
    expect(fight(b, corpse, 'touch', onVillage).attacker.plagues).toBe(false);
  });
});

describe("a campaign's own specials", () => {
  const custom = (wml: string): AttackType => AttackType.fromConfig(parseConfig(`name=spell\ntype=arcane\nrange=ranged\ndamage=10\nnumber=2\n[specials]\n${wml}\n[/specials]`));

  it('[chance_to_hit] with a [filter_opponent] applies only against a matching opponent', () => {
    const b = board();
    const caster = place(b, 'Mage', 1, 1, 1);
    caster.attacks = [custom('[chance_to_hit]\nid=bane\nvalue=100\n[filter_opponent]\nrace=undead\n[/filter_opponent]\n[/chance_to_hit]')];
    const living = place(b, 'Spearman', 2, 2, 1);
    const undead = place(b, 'Walking Corpse', 2, 1, 2);
    expect(fight(b, caster, 'spell', living).attacker.chanceToHit).toBe(60);
    expect(fight(b, caster, 'spell', undead).attacker.chanceToHit).toBe(100);
  });

  it('[attacks] add= and [damage] add=', () => {
    const b = board();
    const caster = place(b, 'Mage', 1, 1, 1);
    caster.attacks = [custom('[attacks]\nid=more\nadd=1\n[/attacks]\n[damage]\nid=harder\nadd=4\n[/damage]')];
    const target = place(b, 'Spearman', 2, 2, 1);
    const s = fight(b, caster, 'spell', target).attacker;
    expect(s.numBlows).toBe(3);
    expect(s.damage).toBe(roundDamage(14, 100 * resistanceAgainst(b, target, 'arcane', false), 10000));
  });

  it('[damage_type] replacement_type= deals another type', () => {
    const b = board();
    const caster = place(b, 'Mage', 1, 1, 1);
    caster.attacks = [custom('[damage_type]\nid=fiery\nreplacement_type=fire\n[/damage_type]')];
    const target = place(b, 'Walking Corpse', 2, 2, 1);
    const s = fight(b, caster, 'spell', target).attacker;
    expect(s.damage).toBe(roundDamage(10, 100 * resistanceAgainst(b, target, 'fire', false), 10000));
  });

  it('[disable]: a disabled weapon is never chosen to answer', () => {
    const b = board();
    const attacker = place(b, 'Spearman', 1, 1, 1);
    const defender = place(b, 'Spearman', 2, 2, 1);
    defender.attacks = defender.attacks.map((a) =>
      a.range === 'melee' ? AttackType.fromConfig(parseConfig(`name=${a.id}\ntype=${a.type}\nrange=melee\ndamage=${a.damage}\nnumber=${a.numAttacks}\n[specials]\n[disable]\nid=retaliation_only_not\nactive_on=defense\n[/disable]\n[/specials]`)) : a,
    );
    expect(chooseDefenderWeaponIndex({ board: b, attacker, defender }, weaponIndex(attacker, 'spear'))).toBe(-1);
  });
});

describe('healing through the pipeline (heal.cpp)', () => {
  it("a curer on the patient's side cures; an allied side's only slows the poison", () => {
    const b = board();
    b.getTeam(2)!.teamName = 'one';
    const patient = place(b, 'Spearman', 1, 1, 1);
    patient.hitpoints = 10;
    patient.setStatus('poisoned', true);
    const mage = place(b, 'White Mage', 2, 2, 1);
    // Side 1's turn: the White Mage is an ally, not of this side, so the poison is only slowed.
    const ally = calculateHealing(b, 1).find((o) => o.unit === patient)!;
    expect(ally?.curePoison ?? false).toBe(false);
    mage.side = 1;
    const own = calculateHealing(b, 1).find((o) => o.unit === patient)!;
    expect([own.curePoison, own.healers]).toEqual([true, [mage]]);
  });

  it("heals +8 heals this side's units next to the healer", () => {
    const b = board();
    const patient = place(b, 'Spearman', 1, 1, 1);
    patient.hitpoints = 10;
    patient.resting = false;
    const mage = place(b, 'White Mage', 1, 2, 1);
    expect(calculateHealing(b, 1).find((o) => o.unit === patient)).toMatchObject({ amount: 8, healers: [mage] });
    expect(calculateHealing(b, 2).find((o) => o.unit === patient)).toBeUndefined();
  });
});

describe('what the player is shown (S5)', () => {
  it("a special is inactive in a fight where its filter fails, active in the side panel's listing", () => {
    const b = board();
    const thief = place(b, 'Thief', 1, 1, 1);
    const spearman = place(b, 'Spearman', 2, 2, 1);
    const dagger = thief.attacks[weaponIndex(thief, 'dagger')]!;
    const fightCtx = new SpecialsContext(b, { un: thief, loc: thief.location, at: dagger }, { un: spearman, loc: spearman.location });
    expect(fightCtx.specialTooltips(fightCtx.attacker).map((t) => [t.name, t.active])).toEqual([['backstab', false]]);
    const listing = new SpecialsContext(b, { un: thief, loc: thief.location, at: dagger }, { loc: Location.NULL });
    listing.isForListing = true;
    expect(listing.specialTooltips(listing.attacker).map((t) => t.active)).toEqual([true]);
  });

  it('fill_weapon_choices skips weapons with attack_weight=0 and those the answer disables, and picks the best', () => {
    const b = board();
    const mage = place(b, 'Mage', 1, 1, 1);
    const spearman = place(b, 'Spearman', 2, 2, 1);
    const { choices, best } = fillWeaponChoices({ board: b, attacker: mage, defender: spearman });
    expect(choices.map((c) => mage.attacks[c.attackerWeaponIndex]!.id).sort()).toEqual(['missile', 'staff']);
    expect(mage.attacks[choices[best]!.attackerWeaponIndex]!.id).toBe('missile');
    mage.attacks = mage.attacks.map((a) => (a.id === 'staff' ? AttackType.fromConfig(parseConfig('name=staff\ntype=impact\nrange=melee\ndamage=5\nnumber=1\nattack_weight=0')) : a));
    expect(fillWeaponChoices({ board: b, attacker: mage, defender: spearman }).choices.map((c) => mage.attacks[c.attackerWeaponIndex]!.id)).toEqual(['missile']);
  });
});
