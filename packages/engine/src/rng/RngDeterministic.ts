/**
 * TS port of `randomness::rng_deterministic` (`src/random_deterministic.hpp`/
 * `.cpp`): the concrete `Rng` that draws from an explicit, caller-owned
 * `MtRng`. This is what synced play (multiplayer/replay, and Wesnoth's
 * "Deterministic SP mode") uses so that every client/replay reproduces
 * identical results from the same seed -- the whole reason this RNG port
 * has to be bit-exact.
 *
 * Not ported: `rng_proxy` (a generic `std::function`-backed `rng`, trivial
 * and not needed without the C++ callback-injection use sites it served)
 * and `set_random_determinstic` (an RAII helper that swaps upstream's
 * global `randomness::generator` pointer for the duration of a scope --
 * there is no such ambient global RNG in this port; callers hold and pass
 * an explicit `Rng` instance instead, which is the better fit for a
 * strictly-layered TS engine anyway).
 */

import { Rng } from './Rng.js';
import type { MtRng } from './MtRng.js';

/** Mirrors `randomness::rng_deterministic`. */
export class RngDeterministic extends Rng {
  constructor(private readonly generator: MtRng) {
    super();
  }

  protected nextRandomImpl(): number {
    return this.generator.getNextRandom();
  }
}
