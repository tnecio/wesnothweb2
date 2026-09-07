/**
 * Bit-exact TS port of the specific PRNG upstream Wesnoth actually uses:
 * NOT a from-scratch algorithm of Wesnoth's own, but the standard library's
 * `std::mt19937` (32-bit Mersenne Twister, MT19937), as used directly by
 * `randomness::mt_rng` (`src/mt_rng.hpp`/`.cpp`, member `mt_`). `mt_rng`
 * itself is a thin wrapper (seeding/call-counting) around this generator --
 * see `MtRng.ts`.
 *
 * `std::mt19937` is specified by the C++ standard (since C++11) with fixed
 * parameters that make it identical to the original Matsumoto & Nishimura
 * "mt19937ar" (2002) reference algorithm:
 *
 *   w=32, n=624, m=397, r=31
 *   a=0x9908B0DF
 *   u=11, d=0xFFFFFFFF
 *   s=7,  b=0x9D2C5680
 *   t=15, c=0xEFC60000
 *   l=18
 *   f=1812433253
 *   default_seed=5489
 *
 * Verified bit-exact against a throwaway native oracle (`std::mt19937`
 * compiled with g++, mirroring `mt_rng.cpp`'s exact usage including
 * `.seed()`/`.discard()`) for several seeds, and cross-checked against the
 * well-known, independently-published std::mt19937 default-seed (5489)
 * test vector (e.g. the sequence quoted in cppreference's `std::mt19937`
 * documentation): 3499211612, 581869302, 3890346734, 3586334585,
 * 545404204, ... -- see `test/rng/MersenneTwister.test.ts`.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/** `std::mt19937`'s default seed, used by `mt_19937`'s default constructor. */
export const MT19937_DEFAULT_SEED = 5489;

/** Bit-exact port of `std::mt19937` (32-bit Mersenne Twister). */
export class MersenneTwister {
  private mt = new Uint32Array(N);
  private index = N + 1;

  constructor(seed: number = MT19937_DEFAULT_SEED) {
    this.seed(seed);
  }

  /** Equivalent to `std::mt19937::seed(seed)`. Re-initializes all state from `seed`. */
  seed(seed: number): void {
    // Reference `init_genrand`: mt[0] = seed; mt[i] = f*(mt[i-1] ^ (mt[i-1] >> 30)) + i
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < N; i++) {
      // Indices 0..N-1 of a fixed-length N=624 Uint32Array: always in
      // bounds (non-null assertions needed only because
      // `noUncheckedIndexedAccess` can't see that statically).
      const prevVal = this.mt[i - 1]!;
      const prev = prevVal ^ (prevVal >>> 30);
      // f * prev + i, mod 2^32. Math.imul gives the correct low-32-bit
      // product even though f*prev can exceed Number.MAX_SAFE_INTEGER.
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.index = N;
  }

  /** Regenerates the full state array (the "twist" step). */
  private twist(): void {
    for (let i = 0; i < N; i++) {
      const x = (this.mt[i]! & UPPER_MASK) | (this.mt[(i + 1) % N]! & LOWER_MASK);
      let xA = x >>> 1;
      if (x & 1) {
        xA ^= MATRIX_A;
      }
      this.mt[i] = (this.mt[(i + M) % N]! ^ xA) >>> 0;
    }
    this.index = 0;
  }

  /** Equivalent to `std::mt19937::operator()()`. Returns the next raw 32-bit output. */
  next(): number {
    if (this.index >= N) {
      this.twist();
    }
    let y = this.mt[this.index++]!;
    // Tempering.
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /**
   * Equivalent to `std::mt19937::discard(z)`: advances the state as if
   * `next()` had been called `count` times, without returning the values.
   * The standard permits an optimized skip-ahead, but a plain loop of
   * `next()` calls is observably identical (verified against the native
   * oracle's `.discard()` behavior -- see test file), which is all that
   * matters for bit-exactness here.
   */
  discard(count: number): void {
    for (let i = 0; i < count; i++) {
      this.next();
    }
  }
}
