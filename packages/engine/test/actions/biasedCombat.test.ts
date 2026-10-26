/**
 * Phase 30: "Reduced RNG" (`random_mode=biased`), `attack.cpp`'s `use_prng_` branch of `perform_hit`.
 * Hand-built units with 0% terrain defense variations, as `combat.test.ts`, so outcomes are hand-verifiable.
 */
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
import { dealBiasedHits, executeAttack } from '../../src/actions/combat.js';

function weapon(damage: number, strikes: number): AttackType {
  const cfg = new WmlConfig();
  cfg.setAttribute('name', 'test-weapon');
  cfg.setAttribute('type', 'blade');
  cfg.setAttribute('range', 'melee');
  cfg.setAttribute('damage', damage);
  cfg.setAttribute('number', strikes);
  return AttackType.fromConfig(cfg);
}

/** Attacker (`strikes` x `damage`) against a defender that is hit `chanceToHit`% of the time and cannot strike back. */
function fight(chanceToHit: number, damage: number, strikes: number, defenderHp: number) {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveCfg = new WmlConfig();
  moveCfg.addChild('defense').setAttribute('Gg', chanceToHit);
  const moveType = MoveType.fromConfig(moveCfg, terrainData);
  const type = (id: string, hp: number, w: AttackType) => new UnitType(id, id, '', 'neutral', 1, hp, 5, 5, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, [w], []);
  const map = GameMap.fromMapString('Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1));
  board.addTeam(new Team(2));
  const attacker = Unit.create(type('attacker', 100, weapon(damage, strikes)), 1, new Location(0, 0));
  const defender = Unit.create(type('defender', defenderHp, weapon(0, 0)), 2, new Location(0, 1));
  board.addUnit(attacker);
  board.addUnit(defender);
  return { board, attacker, defender };
}

const hitsOf = (queue: boolean[]) => queue.filter(Boolean).length;

describe('dealBiasedHits (attack.cpp, use_prng_)', () => {
  it('deals floor(cth * strikes / 100) hits, plus one with the remainder as its chance', () => {
    for (const [cth, strikes] of [[70, 3], [50, 2], [60, 3], [30, 4], [80, 5], [40, 1]] as const) {
      const total = cth * strikes;
      const counts = new Map<number, number>();
      for (let seed = 1; seed <= 400; seed++) {
        const queue = dealBiasedHits(new RngDeterministic(new MtRng(seed)), cth, strikes);
        expect(queue).toHaveLength(strikes);
        counts.set(hitsOf(queue), (counts.get(hitsOf(queue)) ?? 0) + 1);
      }
      const floor = Math.trunc(total / 100);
      const allowed = total % 100 === 0 ? [floor] : [floor, floor + 1];
      expect([...counts.keys()].every((k) => allowed.includes(k))).toBe(true);
      // The extra hit comes about (remainder)% of the time.
      if (total % 100 > 0) expect(Math.abs((counts.get(floor + 1) ?? 0) / 400 - (total % 100) / 100)).toBeLessThan(0.08);
    }
  });

  it('draws exactly as upstream: one roll for the remainder (when there is one), then one per hit', () => {
    const gen = new MtRng(7);
    const queue = dealBiasedHits(new RngDeterministic(gen), 70, 3); // 210: two hits, and a 10% roll for a third
    expect(gen.getRandomCalls()).toBe(1 + hitsOf(queue));
    const exact = new MtRng(7);
    dealBiasedHits(new RngDeterministic(exact), 50, 2); // 100: one hit, no remainder roll
    expect(exact.getRandomCalls()).toBe(1);
    const none = new MtRng(7);
    expect(dealBiasedHits(new RngDeterministic(none), 0, 4)).toEqual([false, false, false, false]);
    expect(none.getRandomCalls()).toBe(0);
  });

  it('places the hits as upstream does: indexes[get_random_int(0, size - 1)], taken out of the pool', () => {
    const queue = dealBiasedHits(new RngDeterministic(new MtRng(99)), 50, 4); // two hits
    const ref = new RngDeterministic(new MtRng(99));
    const expected = [false, false, false, false];
    const indexes = [0, 1, 2, 3];
    for (let i = 0; i < 2; i++) {
      const n = ref.getRandomInt(0, indexes.length - 1);
      expected[indexes[n]!] = true;
      indexes.splice(n, 1);
    }
    expect(queue).toEqual(expected);
  });
});

describe('executeAttack with biasedHits', () => {
  it('50% x 2 strikes always hits exactly once', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { board, defender } = fight(50, 5, 2, 40);
      const result = executeAttack(board, new RngDeterministic(new MtRng(seed)), new Location(0, 0), 0, new Location(0, 1), undefined, { biasedHits: true });
      expect(result.blows.filter((b) => b.hit)).toHaveLength(1);
      expect(defender.hitpoints).toBe(35);
    }
  });

  it('60% x 3 strikes (180) hits once or twice -- once plus an 80% chance of a second -- never zero or three times', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 100; seed++) {
      const { board } = fight(60, 1, 3, 40);
      const result = executeAttack(board, new RngDeterministic(new MtRng(seed)), new Location(0, 0), 0, new Location(0, 1), undefined, { biasedHits: true });
      seen.add(result.blows.filter((b) => b.hit).length);
    }
    expect([...seen].sort()).toEqual([1, 2]);
  });

  it('without the option, the rolls are the usual independent ones', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) {
      const { board } = fight(50, 1, 2, 40);
      const result = executeAttack(board, new RngDeterministic(new MtRng(seed)), new Location(0, 0), 0, new Location(0, 1));
      seen.add(result.blows.filter((b) => b.hit).length);
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });
});
