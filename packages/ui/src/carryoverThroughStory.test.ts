/**
 * Upstream's carryover keeps a side's units and gold until a scenario has that side again. Legend of Wesmere 12
 * (Revelations) is story only, with no [side]: the carryover was dropped there, and from scenario 13 on Kalenz's army
 * was gone -- Landar "doesn't exist" when 13 stores him (found by the autoplay run).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';
import { distanceBetween } from '@wesnothweb2/engine';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenario = (id: string) => readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Legend_of_Wesmere', `${id}.json`));
const win = (s: GameSession) => ((s as unknown as { scenarioResult: string }).scenarioResult = 'victory');
const host = {
  async handle(i: { kind: string; options?: unknown[] }) {
    return i.kind === 'guiDialog' || (i.kind === 'message' && (i.options?.length ?? 0) > 0) ? { value: 1 } : {};
  },
};
const has = (s: GameSession, id: string) => s.board.allUnits().some((u) => u.id === id) || s.board.recallList(1).some((u) => u.id === id);

describe('carryover through a scenario without the player side', () => {
  it("Legend of Wesmere 11 -> 12 (story only) -> 13: Kalenz's army arrives, Landar with it", async () => {
    const s = new GameSession(scenario('11_Battle_of_the_Book'), { seed: 1 });
    s.interactionHost = host as never;
    await s.runStartupEvents();
    expect(has(s, 'Landar')).toBe(true);
    const gold = s.board.getTeam(1)!.gold;
    // What Landar gained must come with him (unit_creator: the carried unit, not one made anew from the [side]).
    const landar11 = s.board.allUnits().find((u) => u.id === 'Landar')!;
    landar11.experience = 41;

    win(s);
    const revelations = GameSession.startNextScenario(s, scenario('12_Revelations'), { seed: 1 });
    expect(revelations.board.getTeam(1)).toBeUndefined();
    expect(revelations.heldCarryover?.units.map((u) => u.id)).toContain('Landar');

    // A save made there keeps what is held.
    const reloaded = GameSession.fromSaveData(scenario('12_Revelations'), JSON.parse(JSON.stringify(revelations.toSaveData())));
    expect(reloaded.heldCarryover?.units.map((u) => u.id)).toContain('Landar');

    revelations.interactionHost = host as never;
    await revelations.runStartupEvents();
    win(revelations);
    const news = GameSession.startNextScenario(revelations, scenario('13_News_from_the_Front'), { seed: 1 });
    expect(news.heldCarryover).toBeNull();
    expect(has(news, 'Landar')).toBe(true);
    expect(has(news, 'Cleodil')).toBe(true);
    const landar13 = news.board.allUnits().find((u) => u.id === 'Landar')!;
    expect(landar13).toBe(landar11);
    expect(landar13.experience).toBe(41);
    // Beside Kalenz, where the [side]'s placement=leader puts him.
    const kalenz = news.board.allUnits().find((u) => u.id === 'Kalenz')!;
    expect(distanceBetween(landar13.location, kalenz.location)).toBeLessThanOrEqual(2);
    expect(news.board.getTeam(1)!.gold).toBeGreaterThanOrEqual(Math.min(gold, news.board.getTeam(1)!.gold));
    const problems: string[] = [];
    news.interactionHost = host as never;
    await news.runStartupEvents();
    expect(problems).toEqual([]);
    expect(has(news, 'Landar')).toBe(true);
  }, 300_000);
});
