import { describe, expect, it } from 'vitest';
import { simulateCombat, swarmBlows, type BattleContextUnitStats } from '../../src/actions/attackPrediction.js';

/**
 * Ground-truth verification for the combat-prediction matrix engine,
 * independent of any C++ oracle: these cases are chosen so the correct
 * answer is derivable by hand (binomial probability), not just "whatever
 * the port produces." This module has zero test coverage as written by
 * the agent that built it (cut off by a rate limit before writing tests --
 * see docs/PROGRESS.md) despite being the highest-risk code in the
 * project, so this fills that gap before trusting any of it.
 */

function noWeaponStats(hp: number, maxHp: number): BattleContextUnitStats {
  return {
    isAttacker: false,
    isPoisoned: false,
    isSlowed: false,
    slows: false,
    drains: false,
    petrifies: false,
    poisons: false,
    firststrike: false,
    canAdvance: false,
    experience: 0,
    maxExperience: 100,
    level: 1,
    rounds: 1,
    hp,
    maxHp,
    chanceToHit: 0,
    damage: 0,
    slowDamage: 0,
    drainPercent: 0,
    drainConstant: 0,
    numBlows: 0,
    swarmMin: 0,
    swarmMax: 0,
  };
}

function attackerStats(overrides: Partial<BattleContextUnitStats> & { hp: number; maxHp: number; chanceToHit: number; damage: number; numBlows: number }): BattleContextUnitStats {
  return {
    isAttacker: true,
    isPoisoned: false,
    isSlowed: false,
    slows: false,
    drains: false,
    petrifies: false,
    poisons: false,
    firststrike: false,
    canAdvance: false,
    experience: 0,
    maxExperience: 100,
    level: 1,
    rounds: 1,
    slowDamage: overrides.damage,
    drainPercent: 0,
    drainConstant: 0,
    swarmMin: overrides.numBlows,
    swarmMax: overrides.numBlows,
    ...overrides,
  };
}

describe('attackPrediction ground-truth cases (hand-computable, no oracle needed)', () => {
  it('a guaranteed single hit against an unarmed defender is certain, not probabilistic', () => {
    // 100% chance to hit, 1 blow, 10 damage, defender full HP 30, no counter-attack.
    const attacker = attackerStats({ hp: 30, maxHp: 30, chanceToHit: 100, damage: 10, numBlows: 1 });
    const defender = noWeaponStats(30, 30);

    const { attacker: a, defender: d } = simulateCombat(attacker, defender);

    // Defender certainly ends at 20 HP.
    expect(d.hpDist[20]).toBeCloseTo(1.0, 10);
    expect(d.hpDist.reduce((s, p) => s + p, 0)).toBeCloseTo(1.0, 10);
    // Attacker takes no damage back (defender has no weapon).
    expect(a.hpDist[30]).toBeCloseTo(1.0, 10);
    expect(a.untouched).toBeCloseTo(1.0, 10);
  });

  it('two independent 50% blows against an unarmed defender follow the exact binomial distribution', () => {
    // P(0 hits)=0.25 -> hp stays 30; P(1 hit)=0.5 -> hp=20; P(2 hits)=0.25 -> hp=10.
    const attacker = attackerStats({ hp: 30, maxHp: 30, chanceToHit: 50, damage: 10, numBlows: 2 });
    const defender = noWeaponStats(30, 30);

    const { defender: d } = simulateCombat(attacker, defender);

    expect(d.hpDist[30]).toBeCloseTo(0.25, 6);
    expect(d.hpDist[20]).toBeCloseTo(0.5, 6);
    expect(d.hpDist[10]).toBeCloseTo(0.25, 6);
    expect(d.hpDist[0]).toBeCloseTo(0, 6);
    expect(d.hpDist.reduce((s, p) => s + p, 0)).toBeCloseTo(1.0, 6);
  });

  it('lethal damage is absorbed into hp=0 (the dead state), not driven negative', () => {
    // 100% hit, 3 blows of 15 damage against 30 hp -- second blow already lethal,
    // hp distribution must land entirely on 0, never go negative or split.
    const attacker = attackerStats({ hp: 30, maxHp: 30, chanceToHit: 100, damage: 15, numBlows: 3 });
    const defender = noWeaponStats(30, 30);

    const { defender: d } = simulateCombat(attacker, defender);

    expect(d.hpDist[0]).toBeCloseTo(1.0, 10);
    for (let hp = 1; hp < d.hpDist.length; hp++) expect(d.hpDist[hp]).toBeCloseTo(0, 10);
  });

  it('a symmetric fair fight is exactly symmetric in expectation', () => {
    // Two identical units, 50% to hit, 1 blow each, same damage/hp -- by
    // symmetry the two post-fight HP distributions must be identical.
    const a = attackerStats({ hp: 20, maxHp: 20, chanceToHit: 50, damage: 5, numBlows: 1 });
    const b: BattleContextUnitStats = { ...a, isAttacker: false };

    const { attacker: ra, defender: rb } = simulateCombat(a, b);

    for (let hp = 0; hp <= 20; hp++) {
      expect(ra.hpDist[hp]).toBeCloseTo(rb.hpDist[hp]!, 6);
    }
    // Total probability mass conserved on both sides.
    expect(ra.hpDist.reduce((s, p) => s + p, 0)).toBeCloseTo(1.0, 6);
    expect(rb.hpDist.reduce((s, p) => s + p, 0)).toBeCloseTo(1.0, 6);
  });

  it('a 0% chance to hit means the defender is never touched', () => {
    const attacker = attackerStats({ hp: 30, maxHp: 30, chanceToHit: 0, damage: 99, numBlows: 4 });
    const defender = noWeaponStats(25, 30);

    const { defender: d } = simulateCombat(attacker, defender);

    expect(d.hpDist[25]).toBeCloseTo(1.0, 10);
  });
});

describe('swarmBlows ground truth', () => {
  it('returns max blows at full health', () => {
    expect(swarmBlows(1, 4, 33, 33)).toBe(4);
  });

  it('returns min blows at zero health', () => {
    expect(swarmBlows(1, 4, 0, 33)).toBe(1);
  });

  it('interpolates linearly for a simple half-health case', () => {
    // Mirrors swarm_blows: min + floor((max-min)*hp/maxHp).
    expect(swarmBlows(0, 4, 16, 32)).toBe(2);
  });
});
