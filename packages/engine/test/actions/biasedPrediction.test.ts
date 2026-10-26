/**
 * Phase 30: the damage calculations under Reduced RNG (`attackPrediction.ts`'s `biasedFight`), checked against
 * hand-computed odds and against thousands of real fights (`executeAttack` with `biasedHits`).
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../helpers/realContent.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import { buildBattleContext, chooseDefenderWeaponIndex } from '../../src/actions/combatStats.js';
import { executeAttack } from '../../src/actions/combat.js';
import { biasedPatterns, plainBattleStats, simulateCombat } from '../../src/actions/attackPrediction.js';

const real = loadRealContent();

describe('biasedPatterns', () => {
  it('deals the hits as dealBiasedHits does: 70% x 3 is two hits (90%) or three (10%), every placement alike', () => {
    const patterns = biasedPatterns(70, 3);
    const byHits = new Map<number, number>();
    for (const p of patterns) byHits.set(p.hits.filter(Boolean).length, (byHits.get(p.hits.filter(Boolean).length) ?? 0) + p.prob);
    expect(byHits.get(2)).toBeCloseTo(0.9, 12);
    expect(byHits.get(3)).toBeCloseTo(0.1, 12);
    expect(patterns.filter((p) => p.hits.filter(Boolean).length === 2).every((p) => Math.abs(p.prob - 0.3) < 1e-12)).toBe(true);
    expect(patterns.reduce((sum, p) => sum + p.prob, 0)).toBeCloseTo(1, 12);
  });
});

describe('the prediction under Reduced RNG, hand-computed', () => {
  it('50% x 2 strikes against a target one hit kills: a sure kill (unbiased: 75%)', () => {
    const attacker = plainBattleStats(10, 2, 30, 30, 50);
    const defender = plainBattleStats(0, 0, 10, 10, 0);
    expect(simulateCombat(attacker, defender, true, { biased: true }).defender.hpDist[0]).toBeCloseTo(1, 12);
    expect(simulateCombat(attacker, defender).defender.hpDist[0]).toBeCloseTo(0.75, 12);
  });

  it('60% x 3 strikes of 1 damage: one hit (20%) or two (80%), never none or three', () => {
    const { defender } = simulateCombat(plainBattleStats(1, 3, 30, 30, 60), plainBattleStats(0, 0, 10, 10, 0), true, { biased: true });
    expect(defender.hpDist[9]).toBeCloseTo(0.2, 12);
    expect(defender.hpDist[8]).toBeCloseTo(0.8, 12);
    expect(defender.hpDist[10]).toBe(0);
    expect(defender.untouched).toBe(0);
  });
});

/** The real fight, `runs` times on fresh units: each side's final hp distribution. */
function realFights(attackerType: string, weapon: string, defenderType: string, runs: number, setup?: (a: Unit, d: Unit) => void) {
  const aDist = new Map<number, number>();
  const dDist = new Map<number, number>();
  let stats: ReturnType<typeof buildBattleContext> | null = null;
  for (let seed = 1; seed <= runs; seed++) {
    const board = new GameBoard(real.map(['Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg']));
    board.addTeam(new Team(1, { teamName: 'one' }));
    board.addTeam(new Team(2, { teamName: 'two' }));
    const a = Unit.create(real.unitType(attackerType), 1, new Location(1, 1));
    const d = Unit.create(real.unitType(defenderType), 2, new Location(2, 1));
    for (const u of [a, d]) {
      board.addUnit(u);
      board.assignUnitId(u);
    }
    setup?.(a, d);
    const ai = a.attacks.findIndex((w) => w.id === weapon);
    const di = chooseDefenderWeaponIndex({ board, attacker: a, defender: d }, ai);
    stats ??= buildBattleContext({ board, attacker: a, attackerWeapon: a.attacks[ai], defender: d, defenderWeapon: di >= 0 ? d.attacks[di] : undefined });
    executeAttack(board, new RngDeterministic(new MtRng(seed)), a.location, ai, d.location, di, { biasedHits: true });
    const add = (m: Map<number, number>, hp: number) => m.set(Math.max(0, hp), (m.get(Math.max(0, hp)) ?? 0) + 1 / runs);
    add(aDist, a.hitpoints);
    add(dDist, d.hitpoints);
  }
  return { stats: stats!, aDist, dDist };
}

function expectClose(predicted: readonly number[], measured: Map<number, number>, tolerance: number): void {
  for (let hp = 0; hp < predicted.length; hp++) {
    expect(Math.abs((predicted[hp] ?? 0) - (measured.get(hp) ?? 0)), `hp ${hp}`).toBeLessThan(tolerance);
  }
  for (const hp of measured.keys()) expect(predicted[hp] ?? 0, `hp ${hp} never predicted`).toBeGreaterThan(0);
}

describe('the prediction under Reduced RNG matches real fights', () => {
  const RUNS = 3000;
  const TOLERANCE = 0.035;
  for (const [label, attacker, weapon, defender, setup] of [
    ['firststrike (a spearman defending)', 'Orcish Grunt', 'sword', 'Spearman', undefined],
    ['drain (a vampire bat)', 'Vampire Bat', 'fangs', 'Peasant', undefined],
    ['slow (an elvish shaman)', 'Elvish Shaman', 'entangle', 'Orcish Archer', undefined],
    ['berserk against a weak fighter', 'Dwarvish Ulfserker', 'berserker frenzy', 'Elvish Fighter', undefined],
    ['berserk without a counter', 'Dwarvish Ulfserker', 'berserker frenzy', 'Dark Adept', undefined],
    ['swarm, wounded', 'Cuttle Fish', 'tentacle', 'Merman Fighter', (a: Unit) => (a.hitpoints = Math.ceil(a.maxHitpoints / 2))],
  ] as const) {
    it(label, () => {
      const { stats, aDist, dDist } = realFights(attacker, weapon, defender, RUNS, setup);
      const predicted = simulateCombat(stats.attacker, stats.defender, true, { biased: true });
      expectClose(predicted.attacker.hpDist, aDist, TOLERANCE);
      expectClose(predicted.defender.hpDist, dDist, TOLERANCE);
    });
  }
});
