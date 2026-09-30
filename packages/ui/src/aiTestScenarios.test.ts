import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

/**
 * Phase 29 S10/S11: upstream's AI test scenarios -- the `[test]`s under `data/ai/micro_ais/scenarios/` (one per
 * micro AI) and `data/ai/scenarios/` -- built to `public/scenarios/ai_test/` by `build-scenario-snapshot.mjs`, play
 * three turns with no Lua or AI error. The human side passes its turns, as a player would who only watches.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = path.join(repoRoot, 'apps/web/public/scenarios/ai_test');
const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : [];
const TURNS = 3;
/**
 * Too slow to run here yet: `fast` puts 200 units on the map, and the default AI's attack analysis on the side
 * without the Fast micro AI takes minutes a turn once the armies meet.
 */
const TOO_SLOW = new Set(['fast']);

describe.skipIf(ids.length === 0)('upstream AI test scenarios', () => {
  for (const id of ids) {
    it.skipIf(TOO_SLOW.has(id))(`${id} plays ${TURNS} turns cleanly`, { timeout: 600_000 }, async () => {
      const problems: string[] = [];
      const session = new GameSession(readScenarioSnapshot(path.join(dir, `${id}.json`)), {
        seed: 7,
        onLog: (level, message) => {
          if (level === 'error' || (level === 'warn' && /micro_ai|not available in this port|Lua|\[ai\]/.test(message))) problems.push(`${level}: ${message}`);
        },
      });
      await session.runStartupEvents();
      for (let turn = 0; turn < TURNS && !session.scenarioResult; turn++) await session.endTurn();
      expect(problems).toEqual([]);
    });
  }
});
