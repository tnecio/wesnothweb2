import { describe, expect, it } from 'vitest';
import type { AttackBlowResult, AttackResult } from '@wesnothweb2/engine/src/actions/combat.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import { NONE_TERRAIN, GRASS_LAND, TerrainTypeData } from '@wesnothweb2/engine/src/model/Terrain.js';
import { AttackType, UnitType } from '@wesnothweb2/engine/src/model/UnitType.js';
import { MoveType } from '@wesnothweb2/engine/src/model/MoveType.js';
import { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import {
  buildAttackAnimationContexts,
  buildAttackBlowAnimationContexts,
  buildMovementAnimationContexts,
  strikeResultOf,
} from '../../src/animation/animationContext.js';

function makeUnitType(id: string): UnitType {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
  return new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 10, -1, 500, [], '', true, false, false, moveType, [], []);
}

function makeWeapon(id: string): AttackType {
  return AttackType.fromConfig(new WmlConfig().setAttribute('name', id));
}

function makeBlow(overrides: Partial<AttackBlowResult>): AttackBlowResult {
  return {
    attackerTurn: true,
    chanceToHit: 70,
    hit: true,
    damage: 8,
    drainAmount: 0,
    strikerDiedFromDrain: false,
    targetDied: false,
    poisoned: false,
    slowed: false,
    petrified: false,
    ...overrides,
  };
}

describe('strikeResultOf (mirrors units/udisplay.cpp unit_attack()\'s hit/miss/kill derivation)', () => {
  it('is "miss" when the blow missed', () => {
    expect(strikeResultOf(makeBlow({ hit: false, damage: 0 }))).toBe('miss');
  });
  it('is "hit" for a non-lethal hit', () => {
    expect(strikeResultOf(makeBlow({ hit: true, targetDied: false }))).toBe('hit');
  });
  it('is "kill" for a lethal hit', () => {
    expect(strikeResultOf(makeBlow({ hit: true, targetDied: true }))).toBe('kill');
  });
});

describe('buildAttackBlowAnimationContexts (mirrors units/udisplay.cpp unit_attack()\'s two add_animation calls)', () => {
  const attacker = Unit.create(makeUnitType('Attacker'), 1, new Location(2, 2));
  const defender = Unit.create(makeUnitType('Defender'), 2, new Location(3, 2));
  const attackerWeapon = makeWeapon('sword');
  const defenderWeapon = makeWeapon('claws');
  const terrainAt = () => GRASS_LAND;

  const { attackerContext, defenderContext } = buildAttackBlowAnimationContexts(
    attacker, attackerWeapon, defender, defenderWeapon, makeBlow({ damage: 6, targetDied: false }), 1, terrainAt,
  );

  it("attacker's context: loc/secondLoc/event/weapons in attacker-first order", () => {
    expect(attackerContext.loc.equals(attacker.location)).toBe(true);
    expect(attackerContext.secondLoc.equals(defender.location)).toBe(true);
    expect(attackerContext.myUnit).toBe(attacker);
    expect(attackerContext.secondUnit).toBe(defender);
    expect(attackerContext.event).toBe('attack');
    expect(attackerContext.value).toBe(6);
    expect(attackerContext.value2).toBe(1);
    expect(attackerContext.hit).toBe('hit');
    expect(attackerContext.attack).toBe(attackerWeapon);
    expect(attackerContext.secondAttack).toBe(defenderWeapon);
    expect(attackerContext.terrainAtLoc).toBe(GRASS_LAND);
  });

  it("defender's context: loc/secondLoc swapped, event=defend, but `attack` is STILL the attacker's weapon", () => {
    expect(defenderContext.loc.equals(defender.location)).toBe(true);
    expect(defenderContext.secondLoc.equals(attacker.location)).toBe(true);
    expect(defenderContext.myUnit).toBe(defender);
    expect(defenderContext.secondUnit).toBe(attacker);
    expect(defenderContext.event).toBe('defend');
    expect(defenderContext.value).toBe(6);
    expect(defenderContext.attack).toBe(attackerWeapon); // not defenderWeapon -- see doc comment
    expect(defenderContext.secondAttack).toBe(defenderWeapon);
  });
});

describe('buildAttackAnimationContexts (per-blow, swing-ordered)', () => {
  it('builds one context pair per blow with value2 counting up from 0', () => {
    const attacker = Unit.create(makeUnitType('Attacker'), 1, new Location(0, 0));
    const defender = Unit.create(makeUnitType('Defender'), 2, new Location(1, 0));
    const weapon = makeWeapon('sword');

    const fakeResult = {
      blows: [makeBlow({ hit: true, damage: 5 }), makeBlow({ hit: false, damage: 0 }), makeBlow({ hit: true, damage: 5, targetDied: true })],
    } as unknown as AttackResult;

    const pairs = buildAttackAnimationContexts(attacker, weapon, defender, undefined, fakeResult, () => NONE_TERRAIN);
    expect(pairs).toHaveLength(3);
    expect(pairs.map((p) => p.attackerContext.value2)).toEqual([0, 1, 2]);
    expect(pairs.map((p) => p.attackerContext.hit)).toEqual(['hit', 'miss', 'kill']);
    expect(pairs[2]!.defenderContext.hit).toBe('kill');
  });
});

describe('buildMovementAnimationContexts (per-step "movement" events)', () => {
  it('builds one context per step transition in the path, none for the starting hex alone', () => {
    const unitType = makeUnitType('Walker');
    const path = [new Location(0, 0), new Location(1, 0), new Location(1, 1)];
    const unit = Unit.create(unitType, 1, path[0]!);
    // A trivial stand-in terrain lookup is enough here -- this test is about
    // which (loc, secondLoc) pairs get built per step, not terrain parsing.
    const terrainAt = () => GRASS_LAND;

    const contexts = buildMovementAnimationContexts(unit, path, terrainAt);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.loc.equals(path[0]!)).toBe(true);
    expect(contexts[0]!.secondLoc.equals(path[1]!)).toBe(true);
    expect(contexts[1]!.loc.equals(path[1]!)).toBe(true);
    expect(contexts[1]!.secondLoc.equals(path[2]!)).toBe(true);
    for (const ctx of contexts) {
      expect(ctx.event).toBe('movement');
      expect(ctx.myUnit).toBe(unit);
      expect(ctx.hit).toBe('invalid');
    }
  });
});
