/**
 * Tests for `RngDeterministic` (port of `randomness::rng_deterministic`,
 * `src/random_deterministic.cpp`) specifically -- the synced-play RNG that
 * has to reproduce identical results across independent clients/replays
 * given the same seed. `Rng.test.ts` already pins its helper-method output
 * against the native oracle; this file focuses on the
 * determinism/save-and-resume contract that's the whole reason this RNG
 * exists.
 */

import { describe, expect, it } from 'vitest';
import { MtRng } from '../../src/rng/MtRng.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';

describe('RngDeterministic', () => {
  it('delegates raw draws to the wrapped MtRng verbatim', () => {
    const gen = new MtRng(5489);
    const rng = new RngDeterministic(gen);
    // nextRandom() (the Rng-level counted wrapper) must return exactly
    // what the underlying mt_rng would, matching rng_deterministic::
    // next_random_impl() just forwarding to generator_.get_next_random().
    expect(rng.nextRandom()).toBe(3499211612);
    expect(rng.nextRandom()).toBe(581869302);
    // Both the Rng-level and MtRng-level call counters advance together,
    // since there's only one call path here.
    expect(rng.getRandomCalls()).toBe(2);
    expect(gen.getRandomCalls()).toBe(2);
  });

  it('replay resume: seeding + discarding N calls reproduces the tail of an uninterrupted sequence', () => {
    // Simulates loading a save mid-replay: a fresh session run of 30 calls...
    const full = new RngDeterministic(new MtRng(2026));
    const fullSequence: number[] = [];
    for (let i = 0; i < 30; i++) fullSequence.push(full.getRandomInt(1, 100));

    // ...versus reconstructing state from (seed=2026, random_calls=10) as
    // a save file would store, then continuing.
    const resumedGen = new MtRng(0);
    resumedGen.seedRandomNum(2026, 10);
    const resumed = new RngDeterministic(resumedGen);
    const resumedSequence: number[] = [];
    for (let i = 0; i < 20; i++) resumedSequence.push(resumed.getRandomInt(1, 100));

    expect(resumedSequence).toEqual(fullSequence.slice(10));
  });

  it('two independent replay clients with the same seed converge on identical combat-shaped rolls', () => {
    // Simulates two lockstep-replay clients (see ARCHITECTURE.md's
    // multiplayer sketch): same seed must mean same sequence of "hit
    // chance" rolls, independent generator instances.
    const clientA = new RngDeterministic(new MtRng(0xc0ffee));
    const clientB = new RngDeterministic(new MtRng(0xc0ffee));

    const rollsA: number[] = [];
    const rollsB: number[] = [];
    for (let i = 0; i < 100; i++) {
      rollsA.push(clientA.getRandomInt(0, 99));
      rollsB.push(clientB.getRandomInt(0, 99));
    }
    expect(rollsA).toEqual(rollsB);
  });

  it('different seeds diverge (sanity check against a trivially-always-equal bug)', () => {
    const a = new RngDeterministic(new MtRng(1));
    const b = new RngDeterministic(new MtRng(2));
    const rollsA = Array.from({ length: 20 }, () => a.getRandomInt(0, 1000));
    const rollsB = Array.from({ length: 20 }, () => b.getRandomInt(0, 1000));
    expect(rollsA).not.toEqual(rollsB);
  });
});
