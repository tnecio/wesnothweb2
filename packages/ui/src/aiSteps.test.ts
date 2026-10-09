/**
 * Phase 29a: an AI side's turn is handed to the display one action at a time (`InteractionHost.aiStep`), as
 * upstream's RCA loop draws each action before choosing the next (`stage_rca.cpp`).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoRespond, type Unit, type WmlConfigJson } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession, type TurnTimelineEntry } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const deadWater1 = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

async function session(extraEvents: WmlConfigJson[] = []): Promise<GameSession> {
  const snapshot = readScenarioSnapshot(deadWater1);
  snapshot.scenarioConfigJson.children.push(...extraEvents.map((config) => ({ tag: 'event', config })));
  const s = new GameSession(snapshot, { seed: 3 });
  await s.runStartupEvents();
  return s;
}

/** A host that answers like a headless run and records each AI step, with the board as it was then. */
function recordingHost(s: GameSession) {
  const steps: { timeline: readonly TurnTimelineEntry[]; boardOk: boolean; messages: string[] }[] = [];
  s.interactionHost = {
    handle: async (interaction) => autoRespond(interaction),
    aiStep: async (timeline) => {
      // The board is already as the step left it: each unit the step moved (and that is still alive) is where its walk ended.
      const lastHex = new Map<Unit, { x: number; y: number }>();
      for (const entry of timeline) {
        if (entry.kind !== 'ai') continue;
        for (const event of entry.events) if (event.kind === 'move') lastHex.set(event.unit, event.path[event.path.length - 1]!);
      }
      const alive = new Set(s.board.allUnits());
      const boardOk = [...lastHex].every(([unit, at]) => !alive.has(unit) || (unit.location.x === at.x && unit.location.y === at.y));
      const messages = s.takeDeferredInteractions().flatMap((i) => (i.kind === 'message' ? [i.message.message] : []));
      steps.push({ timeline, boardOk, messages });
    },
  };
  return steps;
}

const count = (timeline: readonly TurnTimelineEntry[]) => ({
  ai: timeline.flatMap((e) => (e.kind === 'ai' ? e.events : [])).length,
  heals: timeline.flatMap((e) => (e.kind === 'heals' ? e.outcomes : [])).length,
});

describe('AI turns, action by action (Phase 29a)', () => {
  it('hands each action to the display as it happens, and the game is the same as a headless one', async () => {
    const headless = await session();
    await headless.endTurn();
    await headless.endTurn();

    const shown = await session();
    const steps = recordingHost(shown);
    await shown.endTurn();
    const afterFirst = steps.length;
    const leftOver1 = shown.lastTurnTimeline ?? [];
    await shown.endTurn();

    // The same game: board, log and replay.
    expect(shown.describeState()).toBe(headless.describeState());
    expect(shown.log).toEqual(headless.log);
    expect(JSON.stringify(shown.toSaveData().replay)).toBe(JSON.stringify(headless.toSaveData().replay));

    // Several steps a turn, each with something to show, each seen with the board as it left it.
    expect(afterFirst).toBeGreaterThan(1);
    expect(steps.length).toBeGreaterThan(afterFirst);
    for (const step of steps) {
      expect(count(step.timeline).ai).toBeGreaterThan(0);
      expect(step.boardOk).toBe(true);
    }
    // Nothing is lost: the steps plus what is left after the turn are all its animations.
    const first = await session();
    await first.endTurn();
    const all = count(first.lastTurnTimeline ?? []);
    const stepped = count([...steps.slice(0, afterFirst).flatMap((s) => s.timeline), ...leftOver1]);
    expect(stepped).toEqual(all);
  }, 120_000);

  it("an AI unit's moveto [message] arrives with the step that raised it, not after the turn", async () => {
    const moveto: WmlConfigJson = {
      attrs: { name: 'moveto', first_time_only: 'yes' },
      children: [
        { tag: 'filter', config: { attrs: { side: 2 }, children: [] } },
        { tag: 'message', config: { attrs: { speaker: 'narrator', message: 'An AI unit moved' }, children: [] } },
      ],
    };
    const s = await session([moveto]);
    const steps = recordingHost(s);
    await s.endTurn();
    await s.endTurn();

    const at = steps.findIndex((step) => step.messages.includes('An AI unit moved'));
    expect(at).toBeGreaterThanOrEqual(0);
    // It came with the first step that moved a side-2 unit, and steps went on after it.
    const firstMove = steps.findIndex((step) => step.timeline.some((e) => e.kind === 'ai' && e.events.some((ev) => ev.kind === 'move')));
    expect(at).toBe(firstMove);
    expect(steps.length).toBeGreaterThan(at + 1);
    expect(s.takeDeferredInteractions()).toEqual([]);
  }, 120_000);
});
