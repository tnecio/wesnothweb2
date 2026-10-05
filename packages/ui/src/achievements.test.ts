/** Phase 25: a real achievement earned in a real scenario, announced, and still earned in the next game. */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoRespond, memoryAchievementStore, type Interaction } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';
import { ACHIEVEMENT_GROUPS } from './persistentVariables.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenario = path.join(repoRoot, 'apps/web/public/scenarios/The_South_Guard/01_Born_to_the_Banner.json');

describe('achievements (achievements.cpp, wesnoth.achievements)', () => {
  it('ships the groups of data/achievements.cfg with their icons rooted', () => {
    const tsg = ACHIEVEMENT_GROUPS.find((g) => g.contentFor === 'the_south_guard');
    expect(tsg?.achievements.map((a) => a.id)).toContain('tsg_s01');
    for (const group of ACHIEVEMENT_GROUPS) for (const a of group.achievements) expect(a.icon).toMatch(/^(core|campaigns)\//);
  });

  it("The South Guard 1: Urza Mathin's last breath earns Thug Beater, with its popup, and it stays earned", async () => {
    const store = memoryAchievementStore();
    const session = new GameSession(readScenarioSnapshot(scenario), { achievementStore: store });
    await session.runStartupEvents();
    // The battle starts (the scenario's own `play_battle`), which brings Urza Mathin on.
    // @ts-expect-error -- private, as below.
    session.eventPump.fire('play_battle', undefined, undefined, undefined, autoRespond);
    const mathin = session.board.allUnits().find((u) => u.id === 'Urza Mathin')!;
    expect(mathin).toBeDefined();
    const shown: Interaction[] = [];
    // @ts-expect-error -- private: the scenario's own event, fired as an attack would fire it.
    session.eventPump.fire('last breath', mathin.location, mathin.location, undefined, (i: Interaction) => {
      shown.push(i);
      return autoRespond(i);
    });
    const popup = shown.find((i) => i.kind === 'message' && i.message.title === 'Scenario 1: Thug Beater');
    expect(popup).toBeDefined();
    expect(store.read()['the_south_guard']?.['tsg_s01']?.done).toBe(true);

    // A new game reads it back, as a reload does.
    const later = new GameSession(readScenarioSnapshot(scenario), { achievementStore: store });
    const view = later.achievementsView().find((g) => g.contentFor === 'the_south_guard')!;
    expect(view.completed).toBe(1);
    expect(view.achievements.find((a) => a.id === 'tsg_s01')?.achieved).toBe(true);
  });

  it('nothing is saved while a replay is shown', async () => {
    const store = memoryAchievementStore();
    const session = new GameSession(readScenarioSnapshot(scenario), { achievementStore: store });
    await session.runStartupEvents();
    const replay = GameSession.forReplay(session.snapshot, session.toSaveData(), { achievementStore: store })!;
    expect(replay).not.toBeNull();
    // @ts-expect-error -- private, as above.
    replay.eventPump.ctx.achievements.set('the_south_guard', 'tsg_s01');
    expect(store.read()['the_south_guard']?.['tsg_s01']).toBeUndefined();
  });
});
