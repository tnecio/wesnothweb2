import { describe, expect, it } from 'vitest';
import { MtRng } from '../../src/rng/MtRng.js';
import { SyncedRng } from '../../src/rng/SyncedRng.js';

function make(mode: 'per_action' | 'deterministic', seeds: string[]) {
  const asked: string[] = [];
  const rng = new SyncedRng(new MtRng(1), new MtRng(2), mode, () => {
    const s = seeds.shift()!;
    asked.push(s);
    return s;
  });
  return { rng, asked };
}

describe('SyncedRng', () => {
  it('draws from the unsynced stream outside an action, without asking for a seed', () => {
    const { rng, asked } = make('per_action', ['00000005']);
    const expected = new MtRng(2).getNextRandom();
    expect(rng.nextRandom()).toBe(expected);
    expect(asked).toEqual([]);
  });

  it('seeds each action lazily from the provider, exactly like a fresh mt_rng with that seed', () => {
    const { rng, asked } = make('per_action', ['0000002a', '0000002b']);
    rng.beginAction();
    expect(rng.actionDrew).toBe(false);
    const a = [rng.nextRandom(), rng.nextRandom()];
    expect(rng.actionDrew).toBe(true);
    expect(rng.actionCalls).toBe(2);
    rng.endAction();
    rng.beginAction();
    rng.endAction(); // an action that never draws asks for no seed
    rng.beginAction();
    const b = rng.nextRandom();
    rng.endAction();
    const ref42 = new MtRng(0x2a);
    const ref43 = new MtRng(0x2b);
    expect(a).toEqual([ref42.getNextRandom(), ref42.getNextRandom()]);
    expect(b).toBe(ref43.getNextRandom());
    expect(asked).toEqual(['0000002a', '0000002b']);
  });

  it('uses the whole-game stream inside actions in deterministic mode', () => {
    const { rng, asked } = make('deterministic', []);
    rng.beginAction();
    const v = rng.nextRandom();
    rng.endAction();
    expect(v).toBe(new MtRng(1).getNextRandom());
    expect(rng.game.getRandomCalls()).toBe(1);
    expect(asked).toEqual([]);
  });

  it('reports every synced draw, and refuses nested actions', () => {
    const { rng } = make('deterministic', []);
    let draws = 0;
    rng.onSyncedDraw = () => draws++;
    rng.nextRandom();
    rng.beginAction();
    rng.nextRandom();
    rng.nextRandom();
    expect(() => rng.beginAction()).toThrow();
    rng.endAction();
    expect(draws).toBe(2);
  });
});
