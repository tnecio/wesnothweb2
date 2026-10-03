import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

/**
 * Phase 28c milestone for every campaign added in the batches (The South Guard has its own file): each
 * scenario loads and its opening events run without an error or an unsupported tag, and one scenario per
 * campaign plays to its end with the AI on every side, as `theSouthGuard.test.ts` and `replay.test.ts` do.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenarioList = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/scenario-list.json'), 'utf8')) as Record<string, string[]>;

interface CampaignCase {
  /** The scenario played to its end, AI against AI. */
  playThrough: string;
  /**
   * Scenarios that, started on their own, miss something an earlier one carried over (a stored unit, a
   * variable): the problems that alone causes, as upstream would report them.
   */
  expectedProblems?: Record<string, readonly string[]>;
}

/** Batch B1 (`IMPLEMENTATION_PLAN.md`, Phase 28c). */
const CAMPAIGNS: Record<string, CampaignCase> = {
  The_Hammer_of_Thursagan: { playThrough: '01_At_the_East_Gate' },
  Northern_Rebirth: {
    playThrough: '01_Breaking_the_Chains',
    // Krash or Ro'Arthian lead the northern group, carried over from earlier scenarios: on its own, neither is
    // there to store, and upstream's [move_unit_fake] raises the same error.
    expectedProblems: { '13a_Showdown': ['error: [move_unit_fake] missing required type=', 'error: [move_unit_fake] missing required type='] },
  },
  Winds_of_Fate: { playThrough: '01_The_Hunt' },
  Of_Pearls_and_Pirates: {
    playThrough: '01_Pirates',
    // The naga that fled in scenario 2 comes back: on its own, the variable holds only what 4 sets on it.
    expectedProblems: { '04_Lee_Shore': ["error: [unstore_unit]: variable 'stored_naga' doesn't contain unit data"] },
  },
  Dusk_of_Dawn: { playThrough: '01_First_Steps' },
  Descent_Into_Darkness: {
    playThrough: '01_Saving_Parthyn',
    // Darken Volk, stored in scenario 5, is put back on the recall list.
    expectedProblems: { '07a_A_Small_Favor': ["error: [unstore_unit]: variable 'darken_volk_store' doesn't contain unit data"] },
  },
};

function start(campaign: string, id: string): { session: GameSession; problems: string[] } {
  const problems: string[] = [];
  const session = new GameSession(readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios', campaign, `${id}.json`)), {
    onLog: (level, message) => {
      if (level === 'error' || (level === 'warn' && /not supported|not implemented|extension point/.test(message))) problems.push(`${level}: ${message}`);
    },
  });
  return { session, problems };
}

for (const [campaign, spec] of Object.entries(CAMPAIGNS)) {
  describe(campaign, () => {
    for (const id of scenarioList[campaign] ?? []) {
      it(`${id}: opens without errors`, async () => {
        const { session, problems } = start(campaign, id);
        await session.runStartupEvents();
        expect(problems).toEqual(spec.expectedProblems?.[id] ?? []);
      }, 120_000);
    }

    it(`${spec.playThrough} plays to its end, AI against AI`, async () => {
      const { session, problems } = start(campaign, spec.playThrough);
      await session.runStartupEvents();
      for (const team of session.board.teams()) if (team.controller === 'human') team.controller = 'ai';
      session.playAiSide(session.activeSide, []);
      const limit = (session.turnLimit ?? 0) > 0 ? session.turnLimit! : 40;
      for (let guard = 0; guard <= limit + 1 && !session.scenarioResult; guard++) await session.endTurn();
      expect(session.scenarioResult).not.toBeNull();
      expect(problems).toEqual([]);
    }, 900_000);
  });
}
