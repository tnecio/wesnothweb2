/**
 * The Deceiver's Gambit: scenarios 1 and 3 declare side 1 as `[side] id=Delfador` with no `type=` -- the side is
 * his, but no leader is made; he comes from the recall list the last scenario carried over, and `{RECALL_XY
 * Delfador ...}` puts him on the map. Real, reported bug: the carryover left him out (as if the `[side]` re-made
 * him), and the campaign lost its hero: "Does not load my units... not loading Apprentice prevents me from
 * progressing".
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenario = (id: string) => readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/The_Deceivers_Gambit', `${id}.json`));

describe("The Deceiver's Gambit: Delfador carries over", () => {
  it('after scenario 0, scenario 1 starts with Delfador on the map', async () => {
    const graduation = new GameSession(scenario('00_Graduation'), { seed: 1 });
    await graduation.runStartupEvents();
    const delfador = () => [...graduation.board.allUnits(), ...graduation.board.recallList(1)].find((u) => u.id === 'Delfador');
    expect(delfador()).toBeDefined();
    // A won scenario 0, as the victory it ends in.
    (graduation as unknown as { scenarioResult: string }).scenarioResult = 'victory';

    const next = GameSession.startNextScenario(graduation, scenario('01_Stirrings_of_War'));
    expect(next.board.recallList(1).some((u) => u.id === 'Delfador')).toBe(true);
    await next.runStartupEvents();
    const onMap = next.board.allUnits().filter((u) => u.id === 'Delfador');
    expect(onMap).toHaveLength(1);
    expect(onMap[0]!.side).toBe(1);
    expect(next.board.recallList(1).some((u) => u.id === 'Delfador')).toBe(false);
  }, 120_000);
});
