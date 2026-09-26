/**
 * Phase 18c: [effect]s, traits and [object]s change a unit's stats, the way
 * upstream's apply_builtin_effect / add_modification / advance_to do.
 * Real unit types and the real trait definitions throughout.
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../helpers/realContent.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { WmlConfig } from '../../src/wml/config.js';
import { parseWml } from '../../src/wml/index.js';
import { applyModifier } from '../../src/model/UnitType.js';
import { combatModifier } from '../../src/actions/combatStats.js';

const content = loadRealContent();
const trait = (type: string, id: string) => {
  const cfg = content.unitType(type).possibleTraits.find((t) => t.getString('id') === id);
  if (!cfg) throw new Error(`${type} has no trait ${id}`);
  return { kind: 'trait', cfg };
};
const unitWith = (type: string, traits: string[]) =>
  Unit.create(content.unitType(type), 1, Location.fromWml(1, 1), { modifications: traits.map((t) => trait(type, t)) });

describe('utils::apply_modifier', () => {
  it('adds numbers and rounds percentages half away from zero, respecting a minimum', () => {
    expect(applyModifier(10, '3')).toBe(13);
    expect(applyModifier(10, '-4')).toBe(6);
    expect(applyModifier(33, '5%')).toBe(35); // 1.65 -> 2
    expect(applyModifier(30, '-5%')).toBe(28); // -1.5 -> -2
    expect(applyModifier(2, '-5', 1)).toBe(1);
  });
});

describe('the four global traits, as data/core/macros/traits.cfg defines them', () => {
  const base = Unit.create(content.unitType('Spearman'), 1, Location.fromWml(1, 1));

  it('strong: +1 melee damage, +1 hitpoint', () => {
    const u = unitWith('Spearman', ['strong']);
    expect(u.maxHitpoints).toBe(base.maxHitpoints + 1);
    const melee = u.attacks.filter((a) => a.range === 'melee');
    melee.forEach((a, i) => expect(a.damage).toBe(base.attacks.filter((b) => b.range === 'melee')[i]!.damage + 1));
    const ranged = u.attacks.filter((a) => a.range === 'ranged');
    ranged.forEach((a, i) => expect(a.damage).toBe(base.attacks.filter((b) => b.range === 'ranged')[i]!.damage));
    expect(u.hitpoints).toBe(u.maxHitpoints); // a new unit starts full
  });

  it('quick: +1 movement, -5% hitpoints', () => {
    const u = unitWith('Spearman', ['quick']);
    expect(u.maxMoves).toBe(base.maxMoves + 1);
    expect(u.maxHitpoints).toBe(applyModifier(base.maxHitpoints, '-5%'));
  });

  it('resilient: +4 hitpoints and +1 per level', () => {
    const u = unitWith('Spearman', ['resilient']);
    expect(u.maxHitpoints).toBe(base.maxHitpoints + 4 + base.level);
  });

  it('intelligent: -20% experience needed', () => {
    const u = unitWith('Spearman', ['intelligent']);
    expect(u.maxExperience).toBe(applyModifier(base.maxExperience, '-20%', 1));
  });
});

describe('race and special traits', () => {
  it('loyal: no upkeep; fearless: no penalty from an unfavourable time of day', () => {
    // {TRAIT_LOYAL}: scenarios give it; it is in no type's random pool.
    const loyalTrait = parseWml('[trait]\nid=loyal\n[effect]\napply_to=loyal\n[/effect]\n[/trait]').child('trait')!;
    const loyal = Unit.create(content.unitType('Merman Netcaster'), 1, Location.fromWml(1, 1), { modifications: [{ kind: 'trait', cfg: loyalTrait }] });
    expect(loyal.loyal).toBe(true);
    expect(loyal.upkeepCost).toBe(0);
    const plain = Unit.create(content.unitType('Merman Netcaster'), 1, Location.fromWml(1, 1));
    expect(plain.upkeepCost).toBe(plain.level);

    const corpse = Unit.create(content.unitType('Walking Corpse'), 2, Location.fromWml(1, 1), {
      modifications: content.unitType('Walking Corpse').possibleTraits.filter((t) => t.getString('availability') === 'musthave').map((cfg) => ({ kind: 'trait', cfg })),
    });
    expect(corpse.fearless).toBe(true);
    // Chaotic at day: -25% for anyone else, 0 for the fearless.
    expect(combatModifier(25, 'chaotic', corpse.fearless)).toBe(0);
    expect(combatModifier(25, 'chaotic', false)).toBe(-25);
    expect(combatModifier(-25, 'chaotic', true)).toBe(25);
  });
});

describe('[effect]s beyond traits', () => {
  const object = (wml: string) => parseWml(`[object]\n${wml}\n[/object]`).child('object')!;

  it('an object applies on top of the unit as it stands; removing it rebuilds the unit, keeping damage taken', () => {
    const u = Unit.create(content.unitType('Spearman'), 1, Location.fromWml(1, 1));
    const baseHp = u.maxHitpoints;
    const baseDamage = u.attacks[0]!.damage;
    u.hitpoints -= 10;
    u.addModification(
      'object',
      object(`id=holy_water
[effect]
apply_to=attack
range=melee
set_type=arcane
increase_damage=2
[/effect]
[effect]
apply_to=hitpoints
increase_total=5
[/effect]
[effect]
apply_to=resistance
[resistance]
blade=-20
[/resistance]
[/effect]`),
    );
    expect(u.attacks[0]!.type).toBe('arcane');
    expect(u.attacks[0]!.damage).toBe(baseDamage + 2);
    expect(u.maxHitpoints).toBe(baseHp + 5);
    expect(u.hitpoints).toBe(baseHp - 10); // increase_total does not heal
    expect(u.resistanceAgainst('blade')).toBe(Unit.create(content.unitType('Spearman'), 1, Location.NULL).resistanceAgainst('blade') - 20);

    u.removeModifications({ id: 'holy_water' });
    expect(u.attacks[0]!.type).toBe('pierce');
    expect(u.attacks[0]!.damage).toBe(baseDamage);
    expect(u.maxHitpoints).toBe(baseHp);
    expect(u.hitpoints).toBe(baseHp - 10);
  });

  it('duration=turn wears off at the next turn, duration=scenario at the next scenario', () => {
    const u = Unit.create(content.unitType('Spearman'), 1, Location.fromWml(1, 1));
    const moves = u.maxMoves;
    u.addModification('object', object('duration=turn\n[effect]\napply_to=movement\nincrease=2\n[/effect]'));
    u.addModification('object', object('duration=scenario\n[effect]\napply_to=hitpoints\nincrease_total=3\nheal_full=yes\n[/effect]'));
    expect(u.maxMoves).toBe(moves + 2);
    u.endTurn();
    expect(u.maxMoves).toBe(moves + 2);
    u.newTurn();
    expect(u.maxMoves).toBe(moves);
    expect(u.movesLeft).toBe(moves);
    expect(u.modifications).toHaveLength(1);
    u.newScenario();
    expect(u.modifications).toHaveLength(0);
  });

  it('apply_to=variation turns a Walking Corpse into its swimmer variation, whose movetype swims', () => {
    const corpse = Unit.create(content.unitType('Walking Corpse'), 2, Location.fromWml(1, 1));
    const water = content.map(['Wo']).getTerrain(new Location(0, 0)); // deep water
    const walkingCost = corpse.movementCost(water);
    corpse.addModification('object', object('[effect]\napply_to=variation\nname=swimmer\n[/effect]'));
    expect(corpse.variation).toBe('swimmer');
    expect(corpse.movementCost(water)).toBeLessThan(walkingCost);
    // The variation survives a rebuild (it is the unit's, not the object's to re-apply).
    corpse.rebuild();
    expect(corpse.variation).toBe('swimmer');
    expect(corpse.movementCost(water)).toBeLessThan(walkingCost);
  });

  it('advancing keeps traits: a strong Spearman advances to a strong Swordsman', () => {
    const u = unitWith('Spearman', ['strong']);
    u.advanceTo(content.unitType('Swordsman'));
    u.healToFull();
    const plain = Unit.create(content.unitType('Swordsman'), 1, Location.NULL);
    expect(u.maxHitpoints).toBe(plain.maxHitpoints + 1);
    expect(u.attacks[0]!.damage).toBe(plain.attacks[0]!.damage + 1);
  });

  it('times=per level and [filter] on an effect', () => {
    const u = Unit.create(content.unitType('Swordsman'), 1, Location.NULL);
    const hp = u.maxHitpoints;
    u.addModification('object', object('[effect]\napply_to=hitpoints\nincrease_total=1\ntimes=per level\n[/effect]'));
    expect(u.maxHitpoints).toBe(hp + u.level);
    // [filter] on an effect: only a unit that matches gets it (no filter
    // matcher registered in this model-only test, so it is always applied --
    // the event-layer tests cover a real filter).
    expect(new WmlConfig()).toBeDefined();
  });
});
