/**
 * Tests for `Rng`'s helper methods (`get_random_int`, `get_random_double`,
 * `get_random_bool`, `get_random_element` -- ported from `src/random.cpp`).
 * Expected values come from a second throwaway native oracle that layers
 * the exact same helper math (`rng_mirror`, mirroring `randomness::rng`)
 * on top of `std::mt19937`, compiled with g++ 12.2. Concretely tested via
 * `RngDeterministic`, the only concrete `Rng` subclass this project needs.
 */

import { describe, expect, it } from 'vitest';
import { MtRng } from '../../src/rng/MtRng.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';

function makeRng(seed: number): RngDeterministic {
  return new RngDeterministic(new MtRng(seed));
}

describe('Rng (via RngDeterministic)', () => {
  it('getRandomInt(1, 6) ("dice roll") matches the native oracle for seed 12345', () => {
    const rng = makeRng(12345);
    const out: number[] = [];
    for (let i = 0; i < 20; i++) out.push(rng.getRandomInt(1, 6));
    expect(out).toEqual([1, 4, 4, 4, 1, 2, 5, 3, 4, 3, 4, 2, 5, 6, 6, 5, 2, 4, 6, 1]);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('getRandomInt(-10, 10) (negative range) matches the native oracle for seed 12345', () => {
    const rng = makeRng(12345);
    const out: number[] = [];
    for (let i = 0; i < 20; i++) out.push(rng.getRandomInt(-10, 10));
    expect(out).toEqual([5, 5, -7, -7, 5, 6, -9, 10, -10, 7, 8, 6, -6, 7, 7, 9, -9, -4, 7, 5]);
  });

  it('getRandomInt(min, min) always returns min (degenerate range)', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 10; i++) {
      expect(rng.getRandomInt(7, 7)).toBe(7);
    }
  });

  it('getRandomDouble matches the native oracle for seed 5489, to full double precision', () => {
    const rng = makeRng(5489);
    const out: number[] = [];
    for (let i = 0; i < 10; i++) out.push(rng.getRandomDouble());
    const expected = [
      0.81472369190305471, 0.13547700410708785, 0.90579193411394954, 0.83500858978368342,
      0.12698681186884642, 0.96886777109466493, 0.91337585565634072, 0.22103404277004302,
      0.63235924998298287, 0.30816705035977066,
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(out[i]).toBeCloseTo(expected[i]!, 15);
      // Exact bit-for-bit, not just "close": the whole point of the ported
      // bit-manipulation trick is to avoid any floating point rounding
      // divergence from upstream.
      expect(out[i]).toBe(expected[i]);
    }
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('getRandomBool(0.3) matches the native oracle for seed 5489', () => {
    const rng = makeRng(5489);
    const out: boolean[] = [];
    for (let i = 0; i < 20; i++) out.push(rng.getRandomBool(0.3));
    expect(out).toEqual(
      [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0].map(Boolean),
    );
  });

  it('getRandomBool(0) is always false and getRandomBool(1) is always true', () => {
    const rng = makeRng(2026);
    for (let i = 0; i < 20; i++) {
      expect(rng.getRandomBool(0)).toBe(false);
    }
    for (let i = 0; i < 20; i++) {
      expect(rng.getRandomBool(1)).toBe(true);
    }
  });

  it('getRandomElement over weights [0.1, 0.2, 0.3, 0.4] matches the native oracle for seed 999', () => {
    const rng = makeRng(999);
    const weights = [0.1, 0.2, 0.3, 0.4];
    const out: number[] = [];
    for (let i = 0; i < 15; i++) out.push(rng.getRandomElement(weights));
    expect(out).toEqual([3, 1, 2, 3, 1, 1, 3, 0, 0, 1, 2, 0, 2, 3, 2]);
  });

  it('getRandomCalls counts each nextRandom()-consuming helper call', () => {
    const rng = makeRng(1);
    expect(rng.getRandomCalls()).toBe(0);
    rng.getRandomInt(1, 10);
    expect(rng.getRandomCalls()).toBe(1);
    rng.getRandomDouble();
    expect(rng.getRandomCalls()).toBe(2);
    rng.getRandomBool(0.5);
    expect(rng.getRandomCalls()).toBe(3);
  });

  it('two RngDeterministic instances seeded identically produce identical helper-method sequences', () => {
    const a = makeRng(31337);
    const b = makeRng(31337);
    for (let i = 0; i < 30; i++) {
      expect(a.getRandomInt(0, 100)).toBe(b.getRandomInt(0, 100));
    }
  });
});
