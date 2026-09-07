/**
 * TS port of `randomness::rng` (`src/random.hpp`/`.cpp`): the abstract base
 * class providing range/bool/double/weighted-element helpers on top of raw
 * 32-bit draws from a subclass-supplied generator. `RngDeterministic.ts`
 * (mirroring `random_deterministic.hpp`/`.cpp`) is the concrete subclass
 * this project actually needs for synced/replay play.
 *
 * Not ported: `rng::default_instance()`/the module-level `generator`
 * pointer and `rng_default` (`random.cpp`), which back *casual*,
 * non-reproducible randomness (UI flavor, not gameplay-affecting) seeded
 * from OS entropy via `boost::random_device`. Nothing about bit-exactness
 * applies to that path, and callers needing "just some random number, no
 * reproducibility required" can use `Math.random()`/`crypto` directly
 * rather than route through a ported C++ entropy shim.
 */

/** Mirrors `randomness::rng`. */
export abstract class Rng {
  private randomCalls = 0;

  /** Subclasses supply raw 32-bit draws here. Mirrors `next_random_impl()`. */
  protected abstract nextRandomImpl(): number;

  /** Mirrors `rng::next_random()`: raw PRNG output, counted. */
  nextRandom(): number {
    this.randomCalls++;
    return this.nextRandomImpl();
  }

  /** Mirrors `rng::get_random_calls()`. */
  getRandomCalls(): number {
    return this.randomCalls;
  }

  /**
   * Mirrors `rng::get_random_int_in_range_zero_to(int max)`: a value in
   * `[0, max]` inclusive, via `next_random() % (max + 1)`. Deliberately
   * biased/non-uniform for the same reason upstream accepts it -- see the
   * comment on the original: with `std::mt19937`'s huge range, modulo bias
   * is negligible in practice, and the important property is that it's
   * simple enough to be bit-identical across every platform/compiler.
   */
  private getRandomIntInRangeZeroTo(max: number): number {
    if (max < 0) {
      throw new RangeError('getRandomIntInRangeZeroTo: max must be >= 0');
    }
    // `next_random() % (max + 1)`, both operands treated as uint32_t.
    return this.nextRandom() % (max + 1);
  }

  /** Mirrors `rng::get_random_int(int min, int max)`: value in `[min, max]` inclusive. */
  getRandomInt(min: number, max: number): number {
    return min + this.getRandomIntInRangeZeroTo(max - min);
  }

  /**
   * Mirrors `rng::get_random_double()`: a double in `[0, 1)`, built by
   * placing 32 random bits into a double's significand via the same
   * IEEE-754 bit trick as upstream (exponent fixed to encode 1.0, then
   * subtract 1.0), rather than via a floating-point division -- kept
   * bit-for-bit equivalent so any port of code that consumes this value
   * (e.g. combat's `get_random_element`-based selection) stays exact.
   */
  getRandomDouble(): number {
    // 1023n << 52n encodes exponent 0 (bias 1023) => value in [1, 2).
    const bits = (1023n << 52n) | (BigInt(this.nextRandom() >>> 0) << 20n);
    const buf = new DataView(new ArrayBuffer(8));
    buf.setBigUint64(0, bits, false);
    return buf.getFloat64(0, false) - 1.0;
  }

  /** Mirrors `rng::get_random_bool(double probability)`. */
  getRandomBool(probability: number): boolean {
    if (probability < 0.0 || probability > 1.0) {
      throw new RangeError('getRandomBool: probability must be in [0, 1]');
    }
    return this.getRandomDouble() < probability;
  }

  /**
   * Mirrors the `rng::get_random_element<T>` template: given weights that
   * sum to 1 (each `values[i]` is the probability of selecting index `i`),
   * returns the selected index. Ported as a plain array version rather
   * than a generic-iterator template, which TS has no equivalent for.
   */
  getRandomElement(values: readonly number[]): number {
    const target = this.getRandomDouble();
    let sum = 0.0;
    let i = 0;
    sum += values[i]!;
    while (sum <= target) {
      i++;
      if (i < values.length) {
        sum += values[i]!;
      } else {
        break;
      }
    }
    return i;
  }
}
