import { describe, expect, it } from 'vitest';
import {
  assembleSnapshot,
  campaignDatabaseFile,
  CORE_DATABASE_FILE,
  isDatabaseFile,
  splitSnapshotDatabases,
  type SnapshotDatabase,
} from '../../src/snapshot/snapshotDatabase.js';
import type { GameBoardSnapshot } from '../../src/snapshot/gameBoardSnapshot.js';

const snap = (id: string, unitTypeConfigs: Record<string, unknown>, extra: Record<string, unknown> = {}): GameBoardSnapshot =>
  ({ scenario: { id, name: id }, unitTypeConfigs, terrainTypeConfigs: [{ id: 'grass' }], ...extra }) as unknown as GameBoardSnapshot;

describe('splitSnapshotDatabases', () => {
  const spearman = { attrs: { id: 'Spearman' } };
  const inputs = [
    { campaignDir: 'A', real: true, snapshot: snap('a1', { Spearman: spearman, Hero: { attrs: { hp: 1 } } }) },
    { campaignDir: 'A', real: true, snapshot: snap('a2', { Spearman: spearman, Hero: { attrs: { hp: 1 } }, Boss: { attrs: { hp: 9 } } }) },
    // Campaign B redefines Spearman: that version belongs to B, not to core.
    { campaignDir: 'B', real: true, snapshot: snap('b1', { Spearman: { attrs: { id: 'Spearman', hp: 99 } } }) },
    { campaignDir: 'debug', real: false, snapshot: snap('d1', { Spearman: spearman }) },
  ];
  const out = splitSnapshotDatabases(inputs);
  const dbs: Record<string, SnapshotDatabase> = { [CORE_DATABASE_FILE]: out.core };
  for (const [dir, db] of out.campaigns) dbs[campaignDatabaseFile(dir)] = db;

  it('puts only what every real campaign shares in core', () => {
    expect(out.core.unitTypeConfigs).toBeUndefined();
    expect(out.core.terrainTypeConfigs).toEqual([{ id: 'grass' }]);
  });

  it('puts what one campaign shares in its own database, and leaves per-scenario entries in the scenario', () => {
    expect(Object.keys(out.campaigns.get('A')!.unitTypeConfigs!)).toEqual(['Spearman', 'Hero']);
    expect(out.files[1]!.unitTypeConfigs).toEqual({ Boss: { attrs: { hp: 9 } } });
    expect(out.files[0]!.unitTypeConfigs).toBeUndefined();
    expect(out.files[0]!.databases).toEqual([CORE_DATABASE_FILE, 'A/_campaign.json']);
  });

  it('reassembles every scenario exactly', () => {
    out.files.forEach((file, i) => {
      expect(assembleSnapshot(file, file.databases!.map((n) => dbs[n]!))).toEqual(inputs[i]!.snapshot);
    });
  });

  it('recognises database file names', () => {
    expect(isDatabaseFile('_core.json')).toBe(true);
    expect(isDatabaseFile('Liberty/_campaign.json')).toBe(true);
    expect(isDatabaseFile('Liberty/01_The_Raid.json')).toBe(false);
  });
});

describe('assembleSnapshot', () => {
  it('lets later databases and the file itself win', () => {
    const file = { scenario: { id: 's' }, unitTypes: { X: 'file' }, databases: ['core', 'camp'] } as unknown as GameBoardSnapshot;
    const out = assembleSnapshot(file, [{ unitTypes: { X: 'core', Y: 'core' } } as never, { unitTypes: { Y: 'camp' } } as never]);
    expect(out.unitTypes).toEqual({ X: 'file', Y: 'camp' });
    expect('databases' in out).toBe(false);
  });
});
