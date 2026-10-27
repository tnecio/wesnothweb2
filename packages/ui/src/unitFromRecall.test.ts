/**
 * Of Pearls and Pirates 1: side 1's leader Thea (`[side]`'s `type=`/`id=`) has no starting position, so she
 * begins on the recall list; the prestart `[unit] id=Thea x,y=15,12` puts that same Thea on the map
 * (`unit_creator::add_unit`). Real, reported bug: a second Thea was made, and the first could be recalled too.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('[unit] and the recall list', () => {
  it('Of Pearls and Pirates 1 starts with one Thea, on the map, and none to recall', async () => {
    const s = new GameSession(readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Of_Pearls_and_Pirates/01_Pirates.json')), { seed: 1 });
    await s.runStartupEvents();
    expect(s.board.allUnits().filter((u) => u.id === 'Thea')).toHaveLength(1);
    expect(s.board.recallList(1).filter((u) => u.id === 'Thea')).toEqual([]);
  }, 120_000);
});
