import { describe, expect, it } from 'vitest';
import { loadSnapshot, playGame } from './ai-benchmark.js';

// A single AI-vs-AI game plays several full RCA turns for both sides (attack-combination search included), so each
// case here budgets well past vitest's 5s default -- these are still fast in absolute terms (a few seconds each).
const GAME_TIMEOUT_MS = 90_000;

describe('ai-benchmark', () => {
  it(
    'plays synth_combat_02 (both sides AI) to completion within a generous turn/time budget',
    async () => {
      const snapshot = loadSnapshot('synth_combat_02');
      const result = await playGame(snapshot, 1, 30);

      expect(result.winner).not.toBe('timeout'); // a leader dies well before turn 30 on this small map
      expect(result.turns).toBeGreaterThan(0);
      expect(result.turns).toBeLessThanOrEqual(30);
      expect(result.actions).toBeGreaterThan(0);
      // Generous budget: this is a perf *regression* tripwire, not a tight bound -- see the module doc comment on
      // diffing this across runs (e.g. before/after Phase 29 S7's Lua CAs land) rather than treating it as a hard SLA.
      expect(result.msPerTurn).toBeLessThan(10_000);
    },
    GAME_TIMEOUT_MS,
  );

  it(
    'is fully deterministic: the same seed produces an identical result every time',
    async () => {
      const snapshot = loadSnapshot('synth_combat_02');
      const a = await playGame(snapshot, 42, 30);
      const b = await playGame(snapshot, 42, 30);

      expect(a.winner).toBe(b.winner);
      expect(a.turns).toBe(b.turns);
      expect(a.actions).toBe(b.actions);
    },
    GAME_TIMEOUT_MS,
  );

  it(
    'two independent games both complete (mirrors the plan\'s own "2 games x N turns" smoke test)',
    async () => {
      const snapshot = loadSnapshot('synth_combat_02');
      const results = await Promise.all([1, 2].map((seed) => playGame(snapshot, seed, 30)));
      for (const r of results) {
        expect(r.winner).not.toBe('timeout');
        expect(r.turns).toBeGreaterThan(0);
      }
    },
    GAME_TIMEOUT_MS,
  );
});
