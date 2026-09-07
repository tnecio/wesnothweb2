/**
 * Bit-exactness tests for `MersenneTwister` (the TS port of `std::mt19937`,
 * as used directly by upstream's `randomness::mt_rng` -- see
 * `src/mt_rng.cpp`).
 *
 * Expected values here come from two independent sources, per this task's
 * verification requirement:
 *
 * 1. A throwaway native oracle (`std::mt19937` compiled with g++ 12.2,
 *    mirroring `mt_rng.cpp`'s exact seed()/discard()/operator() usage),
 *    run locally against several seeds. The oracle source lived at
 *    /tmp/rng_oracle/oracle.cpp for this session (not part of the repo --
 *    see docs/TESTING_STRATEGY.md's "oracle" concept, and the task's
 *    instruction to keep this out of the CMake build).
 * 2. The seed-5489 (std::mt19937's *default* seed) sequence is also a
 *    well-known, independently-published test vector -- e.g. quoted in
 *    cppreference's `std::mt19937` documentation and reproduced in many
 *    other independent MT19937 references: 3499211612, 581869302,
 *    3890346734, 3586334585, 545404204, ... This matches the native
 *    oracle's output exactly, cross-confirming both sources agree.
 */

import { describe, expect, it } from 'vitest';
import { MersenneTwister, MT19937_DEFAULT_SEED } from '../../src/rng/MersenneTwister.js';

function draw(mt: MersenneTwister, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(mt.next());
  return out;
}

describe('MersenneTwister (std::mt19937 bit-exact port)', () => {
  it('default seed is 5489, matching std::mt19937\'s default_seed', () => {
    expect(MT19937_DEFAULT_SEED).toBe(5489);
  });

  it('seed 5489 (default) matches the canonical published std::mt19937 test vector', () => {
    const mt = new MersenneTwister(5489);
    expect(draw(mt, 20)).toEqual([
      3499211612, 581869302, 3890346734, 3586334585, 545404204, 4161255391, 3922919429,
      949333985, 2715962298, 1323567403, 418932835, 2350294565, 1196140740, 809094426,
      2348838239, 4264392720, 4112460519, 4279768804, 4144164697, 4156218106,
    ]);
  });

  it('constructing with no seed defaults to seed 5489 (same as std::mt19937 default ctor)', () => {
    const mt = new MersenneTwister();
    expect(draw(mt, 5)).toEqual([3499211612, 581869302, 3890346734, 3586334585, 545404204]);
  });

  it('seed 42 matches the native std::mt19937 oracle', () => {
    const mt = new MersenneTwister(42);
    expect(draw(mt, 20)).toEqual([
      1608637542, 3421126067, 4083286876, 787846414, 3143890026, 3348747335, 2571218620,
      2563451924, 670094950, 1914837113, 669991378, 429389014, 249467210, 1972458954,
      3720198231, 1433267572, 2581769315, 613608295, 3041148567, 2795544706,
    ]);
  });

  it('seed 1 (classic MT19937 reference seed) matches the native oracle', () => {
    const mt = new MersenneTwister(1);
    expect(draw(mt, 20)).toEqual([
      1791095845, 4282876139, 3093770124, 4005303368, 491263, 550290313, 1298508491,
      4290846341, 630311759, 1013994432, 396591248, 1703301249, 799981516, 1666063943,
      1484172013, 2876537340, 1704103302, 4018109721, 2314200242, 3634877716,
    ]);
  });

  it('seed 0xdeadbeef matches the native oracle (a "realistic" save-file hex seed)', () => {
    const mt = new MersenneTwister(0xdeadbeef);
    expect(draw(mt, 20)).toEqual([
      956529277, 3842322136, 3319553134, 1843186657, 2704993644, 595827513, 938518626,
      1676224337, 3221315650, 1819026461, 2401778706, 2494028885, 767405145, 1590064561,
      2766888951, 3951114980, 2568046436, 2550998890, 2642089177, 568249289,
    ]);
  });

  it('discard(n) is bit-exactly equivalent to n consecutive next() calls (matches std::mt19937::discard)', () => {
    const noDiscard = new MersenneTwister(12345);
    const first25 = draw(noDiscard, 25);

    const discarded = new MersenneTwister(12345);
    discarded.discard(5);
    expect(draw(discarded, 20)).toEqual(first25.slice(5));
  });

  it('discard(5) from seed 12345 matches the native oracle directly', () => {
    const mt = new MersenneTwister(12345);
    mt.discard(5);
    expect(draw(mt, 20)).toEqual([
      170765737, 878579710, 3549516158, 2438360421, 2285257250, 2557845021, 4107320065,
      4142558326, 1983958385, 2805374267, 3967425166, 3216529513, 1605979227, 2807061239,
      665605494, 3211410640, 3832587122, 4128781001, 115061003, 36027469,
    ]);
  });

  it('re-seeding an already-used generator resets its sequence (matches std::mt19937::seed)', () => {
    const mt = new MersenneTwister(1);
    draw(mt, 50); // advance state arbitrarily
    mt.seed(5489);
    expect(draw(mt, 5)).toEqual([3499211612, 581869302, 3890346734, 3586334585, 545404204]);
  });

  it('all outputs are valid unsigned 32-bit integers', () => {
    const mt = new MersenneTwister(999);
    for (const v of draw(mt, 1000)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
