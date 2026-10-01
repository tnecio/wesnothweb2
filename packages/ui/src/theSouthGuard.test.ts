import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { getAdjacentTiles } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

/**
 * Phase 28c milestone for The South Guard: every scenario loads and its opening events run without an
 * error or an unsupported tag (its Lua included), and a scenario plays to its end with the AI on both
 * sides, as `replay.test.ts` plays Dead Water.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = path.join(repoRoot, 'apps/web/public/scenarios/The_South_Guard');
const scenarios = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/scenario-list.json'), 'utf8')) as Record<string, string[]>)['The_South_Guard']!;

function start(id: string): { session: GameSession; problems: string[] } {
  const problems: string[] = [];
  const session = new GameSession(readScenarioSnapshot(path.join(dir, `${id}.json`)), {
    onLog: (level, message) => {
      if (level === 'error' || (level === 'warn' && /not supported|not implemented|extension point/.test(message))) problems.push(`${level}: ${message}`);
    },
  });
  return { session, problems };
}

/**
 * Scenarios that bring back a unit an earlier one stored (scenario 4's choice keeps Afalas or Ethiliel,
 * 6b brings Deoran back from 6a): started on their own, without that carryover, the variable is missing and
 * `[unstore_unit]` says so -- in upstream's words. Only that is allowed for them.
 */
const NEEDS_CARRYOVER: Record<string, string> = {
  '05a_The_Long_March': 'stored_afalas',
  '06a_Vengeance': 'stored_ethiliel',
  '06b_The_Tides_of_War': 'stored_deoran',
};

describe('The South Guard', () => {
  for (const id of scenarios) {
    it(`${id}: opens without errors`, async () => {
      const { session, problems } = start(id);
      await session.runStartupEvents();
      const carried = NEEDS_CARRYOVER[id];
      const expected = carried ? [`error: [unstore_unit]: variable '${carried}' doesn't exist`] : [];
      expect(problems).toEqual(expected);
    });
  }

  it('01_Born_to_the_Banner: in the tutorial, Mari (South_Guard,quintain) is the player\'s ally and never attacks Deoran', async () => {
    const { session } = start('01_Born_to_the_Banner');
    session.interactionHost = {
      // The first option of every question: "play the tutorial".
      async handle(interaction) {
        return interaction.kind === 'message' && interaction.options.length > 0 ? { value: 1 } : {};
      },
    };
    await session.runStartupEvents();
    const units = () => session.board.allUnits();
    const deoran = units().find((u) => u.id === 'Deoran')!;
    const mari = units().find((u) => u.id === 'Mari')!;
    expect(session.board.getTeam(mari.side)!.isEnemy(session.board.getTeam(deoran.side)!)).toBe(false);
    // The tutorial's first step: Deoran next to Mari.
    const next = getAdjacentTiles(mari.location).find((l) => session.board.map.onBoard(l) && !session.board.hasUnitAt(l))!;
    session.board.moveUnit(deoran.location, next);
    for (let turn = 0; turn < 2; turn++) await session.endTurn();
    expect(deoran.hitpoints).toBe(deoran.maxHitpoints);
  });

  it("02x_Westin: the companion is chosen in the campaign's own Lua dialog, which ends the scenario", async () => {
    const { session } = start('02x_Westin');
    let companionDialogs = 0;
    let tips = 0;
    session.interactionHost = {
      async handle(interaction) {
        if (interaction.kind !== 'guiDialog') return {};
        if (!JSON.stringify(interaction.dialog.root).includes('Leave with Sir Gerrick')) {
          tips++; // a tip shown on the way ("Understood")
          return { value: 1 };
        }
        companionDialogs++;
        // The first time, pick Sir Gerrick's portrait (the leave buttons are hidden until asked about);
        // after hearing him out, leave with him.
        return companionDialogs === 1 ? { text: 'select:characters:1' } : { value: 1 };
      },
    };
    await session.runStartupEvents();
    expect(companionDialogs).toBe(2);
    expect(tips).toBeGreaterThan(0);
    expect(session.scenarioResult).toBe('victory');
  });

  it('02_Proven_by_the_Sword plays to its end, AI against AI', async () => {
    const { session, problems } = start('02_Proven_by_the_Sword');
    await session.runStartupEvents();
    session.board.getTeam(1)!.controller = 'ai';
    session.playAiSide(1, []);
    const limit = session.turnLimit ?? 40;
    for (let guard = 0; guard <= limit + 1 && !session.scenarioResult; guard++) await session.endTurn();
    expect(session.scenarioResult).not.toBeNull();
    expect(problems).toEqual([]);
  }, 600_000);
});
