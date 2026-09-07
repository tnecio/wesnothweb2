/**
 * Tests for `MtRng`, the port of `randomness::mt_rng` (`src/mt_rng.cpp`):
 * hex-string seeding, call-count tracking/discard-on-load, and
 * `rotate_random()`. Expected raw values are the same native-oracle
 * vectors used in `MersenneTwister.test.ts` (that oracle mirrors
 * `mt_rng.cpp`'s exact `seed_random`/`get_next_random`/`rotate_random`
 * behavior, not just bare `std::mt19937`).
 */

import { describe, expect, it } from 'vitest';
import { MtRng } from '../../src/rng/MtRng.js';

describe('MtRng', () => {
  it('numeric constructor seeds directly and get_next_random matches the native oracle (seed 5489)', () => {
    const rng = new MtRng(5489);
    expect(rng.getRandomSeed()).toBe(5489);
    expect(rng.getRandomCalls()).toBe(0);
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push(rng.getNextRandom());
    expect(out).toEqual([3499211612, 581869302, 3890346734, 3586334585, 545404204]);
    expect(rng.getRandomCalls()).toBe(5);
  });

  it('seedRandom parses a plain hex string (no 0x prefix), matching seed_random(str)', () => {
    const rng = new MtRng(0);
    rng.seedRandom('deadbeef');
    expect(rng.getRandomSeed()).toBe(0xdeadbeef);
    expect(rng.getRandomCalls()).toBe(0);
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push(rng.getNextRandom());
    expect(out).toEqual([956529277, 3842322136, 3319553134, 1843186657, 2704993644]);
  });

  it('seedRandom falls back to seed 42 on unparseable hex, matching upstream\'s failure path', () => {
    const rng = new MtRng(0);
    rng.seedRandom('not-hex-at-all!!');
    expect(rng.getRandomSeed()).toBe(42);
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push(rng.getNextRandom());
    expect(out).toEqual([1608637542, 3421126067, 4083286876, 787846414, 3143890026]);
  });

  it('seedRandom with a call_count discards that many draws and sets random_calls_ accordingly', () => {
    const rng = new MtRng(0);
    rng.seedRandomNum(12345, 5);
    expect(rng.getRandomCalls()).toBe(5);
    const out: number[] = [];
    for (let i = 0; i < 20; i++) out.push(rng.getNextRandom());
    expect(out).toEqual([
      170765737, 878579710, 3549516158, 2438360421, 2285257250, 2557845021, 4107320065,
      4142558326, 1983958385, 2805374267, 3967425166, 3216529513, 1605979227, 2807061239,
      665605494, 3211410640, 3832587122, 4128781001, 115061003, 36027469,
    ]);
    expect(rng.getRandomCalls()).toBe(25);
  });

  it('getRandomSeedStr returns zero-padded 8-digit lowercase hex', () => {
    const rng = new MtRng(0xdeadbeef);
    expect(rng.getRandomSeedStr()).toBe('deadbeef');

    const small = new MtRng(0xab);
    expect(small.getRandomSeedStr()).toBe('000000ab');
  });

  it('rotate_random reseeds from the *next* raw output (continuing current state) and resets the call counter to 0', () => {
    // Regression note: an earlier version of this test wrongly assumed
    // rotate_random() reuses the just-returned get_next_random() value as
    // the new seed. It doesn't -- upstream's `rotate_random` is
    // `seed_random(mt_(), 0)`, which draws a *fresh* raw value by calling
    // the underlying std::mt19937 directly (bypassing get_next_random()'s
    // call-count bookkeeping), continuing from wherever the generator's
    // state already is. Caught by cross-checking against a native oracle
    // that reproduces this exact call sequence (get_next_random() once,
    // then rotate_random()), rather than assuming the naive reading.
    const rng = new MtRng(777);
    const firstPull = rng.getNextRandom();
    expect(firstPull).toBe(655685735);

    rng.rotateRandom();
    expect(rng.getRandomSeed()).toBe(2776480559);
    expect(rng.getRandomCalls()).toBe(0);

    const out: number[] = [];
    for (let i = 0; i < 10; i++) out.push(rng.getNextRandom());
    expect(out).toEqual([
      239481816, 1551480350, 401439687, 811263764, 3004251348, 3150729236, 3331614151,
      3646838451, 1359824133, 3578921774,
    ]);
  });

  it('two independently constructed generators with the same seed produce identical sequences', () => {
    const a = new MtRng(2026);
    const b = new MtRng(2026);
    for (let i = 0; i < 50; i++) {
      expect(a.getNextRandom()).toBe(b.getNextRandom());
    }
  });

  it('equals() reflects same seed + same call count (equivalent generator state)', () => {
    const a = new MtRng(42);
    const b = new MtRng(42);
    expect(a.equals(b)).toBe(true);
    a.getNextRandom();
    expect(a.equals(b)).toBe(false);
    b.getNextRandom();
    expect(a.equals(b)).toBe(true);

    // Reaching the same (seed, calls) state via a different path (seed +
    // discard instead of live draws) is still "equal", matching upstream's
    // operator== which compares the actual mt19937 state, not the path.
    const c = new MtRng(0);
    c.seedRandomNum(42, 1);
    expect(a.equals(c)).toBe(true);
  });

  it('no-arg constructor seeds from entropy (non-deterministic, but always produces valid draws)', () => {
    const rng = new MtRng();
    const v = rng.getNextRandom();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
  });
});
