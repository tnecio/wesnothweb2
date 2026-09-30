import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import type { AiManager } from '@wesnothweb2/engine';

/**
 * Phase 29 S9 milestone: every shipped scenario that uses `[micro_ai]` (zone_guardian, messenger_escort, coward,
 * forest_animals) plays two turns with no Lua or AI error, its micro AIs set up by the `[micro_ai]` tag in an
 * event or from a unit's own `[ai]` (`ZONE_GUARDIAN`). Some add theirs later than this plays (The South Guard 1
 * once the battle starts, Liberty 3 on a later side turn, Under the Burning Suns 2 on a move): those only have
 * to play cleanly.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenarios: ReadonlyArray<readonly [string, string, string, boolean?]> = [
  ['Liberty', '01_The_Raid', 'messenger_escort'],
  ['Liberty', '03_A_Strategy_of_Hope', 'zone_guardian', false],
  ['Liberty', '04_Unlawful_Orders', 'coward'],
  ['Liberty', '06_The_Hunters', 'messenger_escort'],
  ['Under_the_Burning_Suns', '01_The_Morning_After', 'forest_animals'],
  ['Under_the_Burning_Suns', '02_Across_the_Harsh_Sands', 'zone_guardian', false],
  ['The_South_Guard', '01_Born_to_the_Banner', 'zone_guardian', false],
  ['The_South_Guard', '03_Vale_of_Tears', 'zone_guardian'],
];

describe('shipped scenarios with micro AIs', () => {
  for (const [campaign, id, aiType, setUpAtStart = true] of scenarios) {
    it(`${campaign}/${id}: ${aiType} is set up and plays`, { timeout: 300_000 }, async () => {
      const problems: string[] = [];
      const snapshot = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios', campaign, `${id}.json`));
      const session = new GameSession(snapshot, {
        seed: 5,
        onLog: (level, message) => {
          if (level === 'error' || (level === 'warn' && /micro_ai|not available in this port|Lua/.test(message))) problems.push(`${level}: ${message}`);
        },
      });
      await session.runStartupEvents();
      const manager = (session as unknown as { aiManager: AiManager }).aiManager;
      const microAiCas = session.board
        .teams()
        .flatMap((t) => manager.toConfig(t.side).children('stage').flatMap((s) => s.children('candidate_action')))
        .filter((ca) => ca.getString('id').startsWith(`mai_${aiType}`));
      if (setUpAtStart) expect(microAiCas.length).toBeGreaterThan(0);
      for (let turn = 0; turn < 2 && !session.scenarioResult; turn++) await session.endTurn();
      expect(problems).toEqual([]);
    });
  }
});
