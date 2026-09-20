import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameBoardSnapshot, CutsceneBeat, Interaction, InteractionResult } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';

/**
 * Phase 17's milestones, on real campaign content.
 *
 * - **Two Brothers 3** (`03_Guarded_Castle`): the castle guards demand a
 *   password, offered as four `[option]`s with no `value=`, and the
 *   scenario compares the chosen index against `$first_password` (which
 *   scenario 2 randomised). Before this phase no choice could be made at
 *   all, so the comparison always fell through to the "wrong password"
 *   branch -- which reassigns and kills the player's units.
 * - **Dead Water 5** (`05_Tirigaz`): the `start` event flies a ghost in
 *   with `[move_unit_fake]`, spawns it for real, has it speak, and only
 *   then summons the undead wave. Those have to reach the display in
 *   that order.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function loadScenario(id: string): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, `apps/web/public/scenarios/${id}.json`), 'utf8')) as GameBoardSnapshot;
}

/** What the player saw, in order: each line of dialogue and each cutscene beat. */
interface Transcript {
  readonly lines: string[];
  readonly beats: CutsceneBeat[];
  readonly entries: string[];
}

/**
 * Plays a session with a stand-in for the player: `answer` decides what
 * to do with each interaction (dismiss, pick an option, type something).
 */
function watch(session: GameSession, answer: (interaction: Interaction) => InteractionResult = () => ({})): Transcript {
  const lines: string[] = [];
  const beats: CutsceneBeat[] = [];
  const entries: string[] = [];
  session.interactionHost = {
    async handle(interaction) {
      if (interaction.kind === 'message') {
        lines.push(interaction.message.message);
        entries.push(`say:${interaction.message.speaker}`);
      } else {
        beats.push(interaction.beat);
        entries.push(`beat:${interaction.beat.kind}`);
      }
      return answer(interaction);
    },
  };
  return { lines, beats, entries };
}

/** Answers every `[message]` that has options with the same 1-based index. */
function alwaysPick(index: number): (interaction: Interaction) => InteractionResult {
  return (interaction) => (interaction.kind === 'message' && interaction.options.length > 0 ? { value: index } : {});
}

describe('Phase 17 milestone: Two Brothers 3 password puzzle', () => {
  /** The guards' challenge is the only `[message]` in the scenario with options. */
  async function playPassword(picked: number): Promise<Transcript> {
    const session = new GameSession(loadScenario('03_Guarded_Castle'));
    // Scenario 2 rolls this with `{VARIABLE_OP first_password rand "1..4"}`;
    // a real playthrough carries it in (see the carryover test in
    // gameSession.test.ts). Fixed here so the branch under test is the
    // player's choice, not the dice.
    session.setVariable('first_password', 2);
    const transcript = watch(session, alwaysPick(picked));
    await session.runStartupEvents();
    return transcript;
  }

  it('offers the four real passwords as options', async () => {
    const session = new GameSession(loadScenario('03_Guarded_Castle'));
    session.setVariable('first_password', 2);
    const offered: string[][] = [];
    session.interactionHost = {
      async handle(interaction) {
        if (interaction.kind === 'message' && interaction.options.length > 0) {
          offered.push(interaction.options.map((o) => o.label));
        }
        return { value: 1 };
      },
    };

    await session.runStartupEvents();

    expect(offered[0]).toEqual(['Sithrak!', 'Eleben!', 'Jarlom!', 'Hamik!']);
  });

  it('the right password is let through -- the guards stand aside and are removed', async () => {
    const transcript = await playPassword(2);

    expect(transcript.lines).toContain('Pass, friend.');
    expect(transcript.lines).not.toContain('Wrong! Die!');
  });

  it('a wrong password is refused', async () => {
    const transcript = await playPassword(3);

    expect(transcript.lines).toContain('Wrong! Die!');
    expect(transcript.lines).not.toContain('Pass, friend.');
  });

  it('records the choice for the replay log, in upstream\'s [input] shape', async () => {
    const session = new GameSession(loadScenario('03_Guarded_Castle'));
    session.setVariable('first_password', 2);
    watch(session, alwaysPick(4));

    await session.runStartupEvents();

    expect(session.choices[0]).toMatchObject({ value: 4 });
    expect(session.getVariable('password_picked')).toBe(undefined); // {CLEAR_VARIABLE password_picked} at the end of the event
  });
});

describe('Phase 17 milestone: Dead Water 5 opening cutscene', () => {
  it('flies the ghost in, spawns it, and only then lets it speak', async () => {
    const session = new GameSession(loadScenario('05_Tirigaz'));
    const transcript = watch(session);
    let ghostOnBoardWhenItSpoke = false;
    const outerHost = session.interactionHost!;
    session.interactionHost = {
      async handle(interaction) {
        if (interaction.kind === 'message' && interaction.message.speaker === 'ghost scout') {
          ghostOnBoardWhenItSpoke = session.board.allUnits().some((u) => u.id === 'ghost scout');
        }
        return outerHost.handle(interaction);
      },
    };

    await session.runStartupEvents();

    const fakeMove = transcript.entries.indexOf('beat:moveFakeUnits');
    const speaks = transcript.entries.indexOf('say:ghost scout');

    expect(fakeMove).toBeGreaterThanOrEqual(0);
    expect(speaks).toBeGreaterThan(fakeMove);
    expect(transcript.lines).toContain('Found. Them.');
    // The `[unit]` between the two has no `animate=`, so it yields no beat
    // of its own -- but the ghost it spawns is on the board by the time
    // the line is shown, which is the ordering that used to be wrong.
    expect(ghostOnBoardWhenItSpoke).toBe(true);

    // The fake ghost really walks: its path is routed between the two
    // waypoints the WML gives (14,20) -> (20,18), not a teleport.
    const walk = transcript.beats.find((b) => b.kind === 'moveFakeUnits');
    if (walk?.kind !== 'moveFakeUnits') throw new Error('expected a fake-move beat');
    expect(walk.walks[0]!.spec.typeId).toBe('Ghost');
    expect(walk.walks[0]!.path.length).toBeGreaterThan(2);
  });
});

describe('Phase 17 milestone: Under the Burning Suns 1 prestart', () => {
  it('runs its [foreach] over the rescue pool instead of skipping the whole block', async () => {
    const unsupported: string[] = [];
    const session = new GameSession(loadScenario('01_The_Morning_After'), {
      onLog: (level, message) => {
        if (level === 'warn' && message.includes('not supported')) unsupported.push(message);
      },
    });
    watch(session);

    await session.runStartupEvents();

    // `[foreach] array=elf_pool` walks the scenario's rescue pool in
    // prestart; it used to be skipped wholesale with this warning.
    expect(unsupported.some((m) => m.startsWith('[foreach]'))).toBe(false);
    expect(session.getVariable('total_elf_pool_gold_value')).toBeDefined();
    // Honest about what the loop still cannot finish: its body asks for
    // `[store_unit_type]`, which this port does not have, so the total it
    // accumulates stays 0. The loop itself runs.
    expect(unsupported.some((m) => m.startsWith('[store_unit_type]'))).toBe(true);
  });
});
