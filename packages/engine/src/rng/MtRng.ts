/**
 * TS port of `randomness::mt_rng` (`src/mt_rng.hpp`/`.cpp`): a thin wrapper
 * around `std::mt19937` (ported bit-exact in `MersenneTwister.ts`) that adds
 * hex-string seed (de)serialization and a call counter, for use as the
 * "synced"/deterministic RNG source (see `RngDeterministic.ts`) whose state
 * gets saved/restored across save games and replays.
 *
 * Not ported: the `mt_rng(const config& cfg)` constructor, which reads
 * `random_seed`/`random_calls` straight out of a save-file `[config]` node.
 * That's a save-game-loading concern layered on top of the WML `Config`
 * type (out of this module's scope); callers can reconstruct the same
 * effect with `new MtRng(0).seedRandom(cfg.randomSeed, cfg.randomCalls)`.
 */

import { MersenneTwister, MT19937_DEFAULT_SEED } from './MersenneTwister.js';

/** Cryptographically-fine entropy source for the non-deterministic default constructor. */
function nextEntropySeed(): number {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } };
  if (g.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    g.crypto.getRandomValues(buf);
    return buf[0]! >>> 0;
  }
  // Fallback (e.g. very old Node without webcrypto global): not
  // cryptographically strong, but this path is never used for anything
  // that has to be bit-exact or reproducible -- deterministic play always
  // goes through an explicit seed.
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/** Mirrors `randomness::mt_rng`. */
export class MtRng {
  private randomSeed: number;
  private mt: MersenneTwister;
  private randomCalls: number;

  /**
   * Mirrors the two non-`config` C++ constructors:
   *  - `mt_rng()` (no args): seeds from entropy, matching upstream's
   *    `seed_rng::next_seed()`.
   *  - `mt_rng(uint32_t seed)`: seeds explicitly.
   */
  constructor(seed?: number) {
    this.randomSeed = (seed !== undefined ? seed : nextEntropySeed()) >>> 0;
    this.mt = new MersenneTwister(this.randomSeed);
    this.randomCalls = 0;
  }

  /** Mirrors `mt_rng::get_next_random()`. */
  getNextRandom(): number {
    const result = this.mt.next();
    this.randomCalls++;
    return result;
  }

  /**
   * Mirrors `mt_rng::rotate_random()`: reseeds to a fresh, related seed
   * (the next raw output of the *current* generator state) and resets the
   * call counter to 0, while staying within the same overall sequence.
   * Used when moving to the next scenario.
   */
  rotateRandom(): void {
    this.seedRandomNumeric(this.mt.next(), 0);
  }

  /** Mirrors the private `mt_rng::seed_random(uint32_t, unsigned int)`. */
  private seedRandomNumeric(seed: number, callCount: number): void {
    this.randomSeed = seed >>> 0;
    this.mt.seed(this.randomSeed);
    this.mt.discard(callCount);
    this.randomCalls = callCount;
  }

  /**
   * Mirrors `mt_rng::seed_random(const std::string&, unsigned int)`: parses
   * `seedStr` as hex (no leading `0x`), falling back to seed 42 if it
   * doesn't parse as upstream's `std::istringstream >> std::hex` does.
   */
  seedRandom(seedStr: string, callCount = 0): void {
    let seed: number;
    const trimmed = seedStr.trim();
    // istringstream >> hex parses a leading run of hex digits and leaves
    // the rest; an empty/non-hex-leading string fails the extraction.
    const match = /^[0-9a-fA-F]+/.exec(trimmed);
    if (match) {
      seed = parseInt(match[0], 16) >>> 0;
    } else {
      seed = 42;
    }
    this.seedRandomNumeric(seed, callCount);
  }

  /** Convenience wrapper for the common "reseed with a fresh numeric seed" case. */
  seedRandomNum(seed: number, callCount = 0): void {
    this.seedRandomNumeric(seed, callCount);
  }

  getRandomSeed(): number {
    return this.randomSeed;
  }

  /** Mirrors `mt_rng::get_random_seed_str()`: zero-padded 8-digit lowercase hex. */
  getRandomSeedStr(): string {
    return (this.randomSeed >>> 0).toString(16).padStart(8, '0');
  }

  getRandomCalls(): number {
    return this.randomCalls;
  }

  /**
   * Mirrors `mt_rng::operator==`: same seed, same call count, and same
   * underlying generator state (approximated here via seed+calls, since a
   * freshly-reseeded-and-discarded generator with the same seed and call
   * count is, for `mt_rng`'s usage, always in the same state as another
   * such generator -- there is no other way to mutate `mt_` in this class).
   */
  equals(other: MtRng): boolean {
    return this.randomSeed === other.randomSeed && this.randomCalls === other.randomCalls;
  }

  static readonly DEFAULT_SEED = MT19937_DEFAULT_SEED;
}
