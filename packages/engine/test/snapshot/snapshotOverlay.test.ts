import { describe, expect, it } from 'vitest';
import { applySnapshotOverlay, diffSnapshots, scenarioFileName } from '../../src/snapshot/snapshotOverlay.js';
import type { GameBoardSnapshot } from '../../src/snapshot/gameBoardSnapshot.js';

const snap = (over: Record<string, unknown> = {}): GameBoardSnapshot =>
  ({ generatedBy: 'x', difficulty: 'NORMAL', scenario: { id: 's', name: 'S' }, teams: [{ gold: 100 }], units: [{ id: 'a' }], unitTypeConfigs: { big: 1 }, terrainFlags: {}, ...over }) as unknown as GameBoardSnapshot;

describe('snapshot overlays', () => {
  it('carries exactly the keys that differ, and applying it reproduces the full snapshot', () => {
    const base = snap();
    const easy = snap({ difficulty: 'EASY', teams: [{ gold: 200 }] });
    const overlay = diffSnapshots(base, easy);
    expect(Object.keys(overlay).sort()).toEqual(['difficulty', 'teams']);
    expect(applySnapshotOverlay(base, overlay)).toEqual(easy);
  });

  it('does not modify the base', () => {
    const base = snap();
    applySnapshotOverlay(base, { teams: [] });
    expect(base.teams).toEqual([{ gold: 100 }]);
  });

  it('ignores the generatedBy comment', () => {
    expect(diffSnapshots(snap(), snap({ generatedBy: 'other' }))).toEqual({});
  });

  it('patches keyed tables entry by entry, including removals', () => {
    const base = snap({ unitTypeConfigs: { a: 1, b: 2, c: 3 } });
    const hard = snap({ unitTypeConfigs: { a: 1, b: 20, d: 4 } });
    const overlay = diffSnapshots(base, hard);
    expect(overlay).toEqual({ patches: { unitTypeConfigs: { b: 20, c: null, d: 4 } } });
    expect(applySnapshotOverlay(base, overlay)).toEqual(hard);
  });

  it('refuses a difficulty that changes something overlays do not carry', () => {
    expect(() => diffSnapshots(snap(), snap({ terrainFlags: { x: 1 } }))).toThrow(/terrainFlags/);
  });

  it('names the file for a difficulty, under its campaign directory', () => {
    expect(scenarioFileName('Dead_Water', '01_Invasion', 'NORMAL', 'NORMAL')).toBe('Dead_Water/01_Invasion.json');
    expect(scenarioFileName('Dead_Water', '01_Invasion', undefined, 'NORMAL')).toBe('Dead_Water/01_Invasion.json');
    expect(scenarioFileName('Dead_Water', '01_Invasion', 'HARD', 'NORMAL')).toBe('Dead_Water/01_Invasion@HARD.json');
    expect(scenarioFileName('combat', 'synth_combat_01', undefined, undefined)).toBe('combat/synth_combat_01.json');
  });

  it('disambiguates a scenario id two campaigns both use (Dead Water and Under the Burning Suns both ship 13_Epilogue)', () => {
    expect(scenarioFileName('Dead_Water', '13_Epilogue', undefined, 'NORMAL')).toBe('Dead_Water/13_Epilogue.json');
    expect(scenarioFileName('Under_the_Burning_Suns', '13_Epilogue', undefined, 'NORMAL')).toBe('Under_the_Burning_Suns/13_Epilogue.json');
  });
});
