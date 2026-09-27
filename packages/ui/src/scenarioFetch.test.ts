import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySnapshotOverlay, type GameBoardSnapshot, type SnapshotOverlay } from '@wesnothweb2/engine';
import { fetchScenarioSnapshot } from './scenarioFetch.js';

const publicDir = path.resolve(__dirname, '../../../apps/web/public');
const scenariosDir = path.join(publicDir, 'scenarios');

interface ManifestCampaign {
  id: string;
  wesnothId?: string;
  firstScenario: string;
  difficulties?: { define: string; default?: boolean }[];
}
const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'campaigns.json'), 'utf8')) as { campaigns: ManifestCampaign[] };

describe('fetchScenarioSnapshot', () => {
  const base = { difficulty: 'NORMAL', teams: ['n'], scenario: { id: 's' } } as unknown as GameBoardSnapshot;
  const overlay: SnapshotOverlay = { difficulty: 'HARD', teams: ['h'] as never };
  const calls: string[] = [];
  const stub = (): void => {
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      const body = url.endsWith('s.json') ? base : url.endsWith('s@HARD.json') ? overlay : null;
      return { ok: body !== null, status: body ? 200 : 404, json: async () => body };
    });
  };
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it('fetches only the whole file when no difficulty (or the default one) is asked for', async () => {
    stub();
    expect((await fetchScenarioSnapshot('s')).difficulty).toBe('NORMAL');
    expect((await fetchScenarioSnapshot('s', 'NORMAL', 'NORMAL')).difficulty).toBe('NORMAL');
    expect(calls).toEqual(['/scenarios/s.json', '/scenarios/s.json']);
  });

  it('applies the overlay for another difficulty', async () => {
    stub();
    const got = await fetchScenarioSnapshot('s', 'HARD', 'NORMAL');
    expect(got).toEqual(applySnapshotOverlay(base, overlay));
    expect(calls.sort()).toEqual(['/scenarios/s.json', '/scenarios/s@HARD.json']);
  });

  it('reads the base first to learn its difficulty when the default is not known', async () => {
    stub();
    expect((await fetchScenarioSnapshot('s', 'NORMAL')).difficulty).toBe('NORMAL');
    expect(calls).toEqual(['/scenarios/s.json']);
    expect((await fetchScenarioSnapshot('s', 'HARD')).difficulty).toBe('HARD');
  });

  it('reports a missing file', async () => {
    stub();
    await expect(fetchScenarioSnapshot('missing')).rejects.toThrow(/missing.json: 404/);
  });
});

/** The shipped build output (`rebuild-snapshots.mjs`): every campaign difficulty is reachable for every scenario. */
describe('shipped scenario snapshots', () => {
  const files = new Set(fs.readdirSync(scenariosDir));
  const bases = [...files].filter((f) => !f.includes('@'));

  it('records the default difficulty in every real campaign scenario, and none in a debug one', () => {
    for (const c of manifest.campaigns) {
      const def = c.difficulties?.find((d) => d.default)?.define ?? c.difficulties?.[0]?.define;
      const first = JSON.parse(fs.readFileSync(path.join(scenariosDir, `${c.firstScenario}.json`), 'utf8')) as GameBoardSnapshot;
      expect(first.difficulty, c.id).toBe(def);
    }
  });

  it('has an overlay for each non-default difficulty of a campaign scenario, that applies to its difficulty', () => {
    for (const c of manifest.campaigns) {
      const ds = c.difficulties ?? [];
      if (ds.length < 2) continue;
      const def = (ds.find((d) => d.default) ?? ds[0]!).define;
      const id = c.firstScenario;
      const baseSnap = JSON.parse(fs.readFileSync(path.join(scenariosDir, `${id}.json`), 'utf8')) as GameBoardSnapshot;
      for (const d of ds.filter((x) => x.define !== def)) {
        const name = `${id}@${d.define}.json`;
        expect(files.has(name), name).toBe(true);
        const overlay = JSON.parse(fs.readFileSync(path.join(scenariosDir, name), 'utf8')) as SnapshotOverlay;
        expect(applySnapshotOverlay(baseSnap, overlay).difficulty, name).toBe(d.define);
      }
    }
  });

  it('has no overlay without a base', () => {
    for (const f of files) if (f.includes('@')) expect(bases.includes(`${f.split('@')[0]}.json`), f).toBe(true);
  });

  it('builds Two Brothers at its own default (EASY), not a hardcoded NORMAL', () => {
    const tb = manifest.campaigns.find((c) => c.wesnothId === 'Two_Brothers')!;
    const snap = JSON.parse(fs.readFileSync(path.join(scenariosDir, `${tb.firstScenario}.json`), 'utf8')) as GameBoardSnapshot;
    expect(snap.difficulty).toBe('EASY');
  });
});
