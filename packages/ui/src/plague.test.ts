import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';

/**
 * A real, reported bug: a player's unit killed by a Walking Corpse or Soulless during the AI's turn did not
 * rise as a Walking Corpse, and none took the victim's shape. `synthetic-campaigns/plague` puts twelve side 1
 * units at 1 HP next to side 2's (AI) plague units; ending turn 1 lets the AI kill them.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshot = () => readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/plague/synth_plague_01.json'));

/** Each station's row and the corpse its victim becomes (`undead_variation`), or null for none. */
const STATIONS: Record<number, { victim: string; corpse: string | null }> = {
  3: { victim: 'Spearman', corpse: '' },
  5: { victim: 'Merman Fighter', corpse: 'swimmer' },
  7: { victim: 'Dwarvish Fighter', corpse: 'dwarf' },
  9: { victim: 'Cavalryman', corpse: 'mounted' },
  11: { victim: 'Drake Fighter', corpse: 'drake' },
  13: { victim: 'Troll Whelp', corpse: 'troll' },
  15: { victim: 'Saurian Skirmisher', corpse: 'saurian' },
  17: { victim: 'Wose', corpse: 'wose' },
  19: { victim: 'Gryphon Rider', corpse: 'gryphon' },
  21: { victim: 'Peasant', corpse: null }, // on a village
  23: { victim: 'Walking Corpse', corpse: null }, // unplagueable
  25: { victim: 'Elvish Scout', corpse: 'mounted' },
};

interface Outcome {
  corpse: { type: string; side: number; variation: string; full: boolean } | null;
}

/** Ends side 1's turn so the AI plays side 2, and reports what stands on each killed victim's hex. */
async function playAiTurn(seed: number): Promise<Map<number, Outcome>> {
  const session = new GameSession(snapshot(), { seed });
  await session.runStartupEvents();
  const victims = new Map<number, ReturnType<typeof session.board.allUnits>[number]>();
  for (const row of Object.keys(STATIONS).map(Number)) {
    const victim = session.board.allUnits().find((u) => u.id === `Victim ${row}`)!;
    expect(victim.type.id).toBe(STATIONS[row]!.victim);
    victims.set(row, victim);
  }
  const before = new Set(session.board.allUnits());
  await session.endTurn();
  expect(session.activeSide).toBe(1);
  const outcomes = new Map<number, Outcome>();
  for (const [row, victim] of victims) {
    if (session.board.allUnits().includes(victim)) continue; // survived this seed
    const there = session.board.unitAt(victim.location);
    const risen = there && !before.has(there) ? there : null;
    outcomes.set(row, {
      corpse: risen ? { type: risen.type.id, side: risen.side, variation: risen.variation, full: risen.hitpoints === risen.maxHitpoints } : null,
    });
  }
  return outcomes;
}

describe('plague kills during the AI turn (synthetic plague scenario)', () => {
  it("every victim rises as a side 2 Walking Corpse in its own shape, except on a village or when unplagueable", async () => {
    const seen = new Map<number, Outcome>();
    for (let seed = 1; seed <= 30 && seen.size < Object.keys(STATIONS).length; seed++) {
      for (const [row, outcome] of await playAiTurn(seed)) if (!seen.has(row)) seen.set(row, outcome);
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(Object.keys(STATIONS).map(Number));
    for (const [row, { victim, corpse }] of Object.entries(STATIONS)) {
      const got = seen.get(Number(row))!.corpse;
      expect({ victim, got }).toEqual({
        victim,
        got: corpse === null ? null : { type: 'Walking Corpse', side: 2, variation: corpse, full: true },
      });
    }
  }, 900_000);

  it('a corpse is drawn and animated as its variation, not as the plain Walking Corpse', async () => {
    const session = new GameSession(snapshot());
    await session.runStartupEvents();
    const corpse = session.board.allUnits().find((u) => u.id === 'Plague 3')!;
    const plain = session.renderUnits.find((u) => u.id === 'Plague 3')!.image;
    expect(corpse.type.id).toBe('Walking Corpse');
    // Make it a mounted corpse, as a plague kill of a Cavalryman does.
    const mod = WmlConfig.fromJSON({ attrs: {}, children: [{ tag: 'effect', config: { attrs: { apply_to: 'variation', name: 'mounted' }, children: [] } }] });
    corpse.addModification('variation', mod);
    expect(corpse.variation).toBe('mounted');
    const drawn = session.renderUnits.find((u) => u.id === 'Plague 3')!.image;
    expect(drawn).toBe(corpse.type.image);
    expect(drawn).not.toBe(plain);
    expect(session.unitInfo(corpse).image).toBe(drawn);
    // Its animations come from the variation's own config (create_sub_type), not the base type's.
    const raw = WmlConfig.fromJSON(session.rawUnitTypeConfig('Walking Corpse', 'mounted')!);
    expect(raw.getString('variation_id')).toBe('mounted');
    expect(raw.children('variation')).toHaveLength(0);
    expect(raw.getString('image')).toBe(drawn);
  });
});
