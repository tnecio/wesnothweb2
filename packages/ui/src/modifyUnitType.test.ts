/**
 * Phase 27a S5: `[modify_unit_type]` (`unit_types.apply_scenario_fix`), applied to the unit types for the scenario
 * that has it, and gone in one that does not (`remove_scenario_fixes`).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, runActionSequence } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenario = (campaign: string, id: string) => readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios', campaign, `${id}.json`));
const typeOf = (s: GameSession, id: string) => (s as unknown as { resolveType: (id: string) => { advancesTo: readonly string[]; cost: number; experienceNeededBase: number } }).resolveType(id);

describe('[modify_unit_type]', () => {
  it("Dead Water: the campaign's Cuttle Fish can become a Kraken, at 80 experience", async () => {
    const s = new GameSession(scenario('Dead_Water', '01_Invasion'), { seed: 1 });
    expect(typeOf(s, 'Cuttle Fish').advancesTo).toContain('Kraken');
    expect(typeOf(s, 'Cuttle Fish').experienceNeededBase).toBe(80);
    // A Cuttle Fish placed now has those too.
    await s.runStartupEvents();
    runActionSequence(parseConfig('[unit]\nside=1\ntype=Cuttle Fish\nid=squid\nx,y=10,10\n[/unit]'), s['eventPump'].ctx);
    const squid = s.board.allUnits().find((u) => u.id === 'squid')!;
    expect(squid.advancesTo).toContain('Kraken');
  });

  it("Of Pearls and Pirates 3 makes Peasants cost 16 and Woodsmen 20 -- the first scenario, without the fix, does not", () => {
    const third = new GameSession(scenario('Of_Pearls_and_Pirates', '03_Desolation'), { seed: 1 });
    expect(typeOf(third, 'Peasant').cost).toBe(16);
    expect(typeOf(third, 'Woodsman').cost).toBe(20);
    expect(third.snapshot.unitTypes['Peasant']?.cost).toBe(16);
    const first = new GameSession(scenario('Of_Pearls_and_Pirates', '01_Pirates'), { seed: 1 });
    expect(typeOf(first, 'Peasant').cost).toBe(8);
  });
});
