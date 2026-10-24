/**
 * Phase 27a S7: a leader's `[filter_recall]` (`unit::recall_filter`) limits what it may recall -- in the recall
 * list (`get_recalls`), the recall action, the AI's recruitment and `[recall]` -- and survives a save.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, runActionSequence, type Unit } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const deadWater1 = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

async function kaiWithRecalls(filter: string | null): Promise<GameSession> {
  const s = new GameSession(readScenarioSnapshot(deadWater1), { seed: 2 });
  await s.runStartupEvents();
  const run = (wml: string) => runActionSequence(parseConfig(wml), s['eventPump'].ctx);
  run('[unit]\nside=1\ntype=Merman Fighter\nid=fighter\nx,y=recall,recall\n[/unit]');
  run('[unit]\nside=1\ntype=Merman Hunter\nid=hunter\nx,y=recall,recall\n[/unit]');
  if (filter !== null) kai(s).filterRecall = parseConfig(filter);
  s.board.getTeam(1)!.gold = 1000;
  return s;
}
const kai = (s: GameSession): Unit => s.board.allUnits().find((u) => u.id === 'Kai Krellis')!;

describe('a leader\'s [filter_recall]', () => {
  it('is read from [unit] and written back', async () => {
    const s = new GameSession(readScenarioSnapshot(deadWater1), { seed: 2 });
    await s.runStartupEvents();
    runActionSequence(
      parseConfig('[unit]\nside=1\ntype=Merman Hunter\nid=chief\ncanrecruit=yes\nx,y=recall,recall\n[filter_recall]\ntype=Merman Hunter\n[/filter_recall]\n[/unit]'),
      s['eventPump'].ctx,
    );
    const chief = s.board.recallList(1).find((u) => u.id === 'chief')!;
    expect(chief.filterRecall?.getString('type')).toBe('Merman Hunter');
    expect(chief.toConfig().child('filter_recall')?.getString('type')).toBe('Merman Hunter');
  });

  it('with none, every recall-list unit is offered', async () => {
    const s = await kaiWithRecalls(null);
    expect(s.recallOptions.map((o) => o.typeId).sort()).toEqual(['Merman Fighter', 'Merman Hunter']);
  });

  it('the recall list offers only the units it matches, keeping their list positions', async () => {
    const s = await kaiWithRecalls('type=Merman Hunter');
    expect(s.recallOptions.map((o) => [o.index, o.typeId])).toEqual([[1, 'Merman Hunter']]);
  });

  it('[recall] skips a unit the leader may not recall', async () => {
    const s = await kaiWithRecalls('type=Merman Hunter');
    runActionSequence(parseConfig('[recall]\ntype=Merman Fighter\n[/recall]'), s['eventPump'].ctx);
    expect(s.board.allUnits().some((u) => u.id === 'fighter')).toBe(false);
    runActionSequence(parseConfig('[recall]\ntype=Merman Hunter\n[/recall]'), s['eventPump'].ctx);
    expect(s.board.allUnits().some((u) => u.id === 'hunter')).toBe(true);
  });

  it('survives a save, as does extra_recruit=', async () => {
    const s = await kaiWithRecalls('type=Merman Hunter');
    kai(s).extraRecruit = ['Mermaid Initiate'];
    const reloaded = new GameSession(readScenarioSnapshot(deadWater1), { seed: 2 });
    reloaded.loadSaveData(s.toSaveData());
    expect(kai(reloaded).filterRecall?.getString('type')).toBe('Merman Hunter');
    expect(kai(reloaded).extraRecruit).toEqual(['Mermaid Initiate']);
    expect(reloaded.recallOptions.map((o) => o.typeId)).toEqual(['Merman Hunter']);
  });
});
