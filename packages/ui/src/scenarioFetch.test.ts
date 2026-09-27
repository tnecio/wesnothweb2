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
  assetDir: string;
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
      const body = url.endsWith('Camp/s.json') ? base : url.endsWith('Camp/s@HARD.json') ? overlay : null;
      return { ok: body !== null, status: body ? 200 : 404, json: async () => body };
    });
  };
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it('fetches only the whole file when no difficulty (or the default one) is asked for', async () => {
    stub();
    expect((await fetchScenarioSnapshot('s', 'Camp')).difficulty).toBe('NORMAL');
    expect((await fetchScenarioSnapshot('s', 'Camp', 'NORMAL', 'NORMAL')).difficulty).toBe('NORMAL');
    expect(calls).toEqual(['/scenarios/Camp/s.json', '/scenarios/Camp/s.json']);
  });

  it('applies the overlay for another difficulty', async () => {
    stub();
    const got = await fetchScenarioSnapshot('s', 'Camp', 'HARD', 'NORMAL');
    expect(got).toEqual(applySnapshotOverlay(base, overlay));
    expect(calls.sort()).toEqual(['/scenarios/Camp/s.json', '/scenarios/Camp/s@HARD.json']);
  });

  it('reads the base first to learn its difficulty when the default is not known', async () => {
    stub();
    expect((await fetchScenarioSnapshot('s', 'Camp', 'NORMAL')).difficulty).toBe('NORMAL');
    expect(calls).toEqual(['/scenarios/Camp/s.json']);
    expect((await fetchScenarioSnapshot('s', 'Camp', 'HARD')).difficulty).toBe('HARD');
  });

  it('reports a missing file', async () => {
    stub();
    await expect(fetchScenarioSnapshot('missing', 'Camp')).rejects.toThrow(/missing.json: 404/);
  });

  it('fetches a scenario id shared by two campaigns from its OWN campaign directory, not the other one\'s', async () => {
    const dw = { difficulty: 'NORMAL', scenario: { id: '13_Epilogue' }, teams: ['dead-water'] } as unknown as GameBoardSnapshot;
    const utbs = { difficulty: 'NORMAL', scenario: { id: '13_Epilogue' }, teams: ['burning-suns'] } as unknown as GameBoardSnapshot;
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url === '/scenarios/Dead_Water/13_Epilogue.json' ? dw : url === '/scenarios/Under_the_Burning_Suns/13_Epilogue.json' ? utbs : null;
      return { ok: body !== null, status: body ? 200 : 404, json: async () => body };
    });
    expect(await fetchScenarioSnapshot('13_Epilogue', 'Dead_Water')).toEqual(dw);
    expect(await fetchScenarioSnapshot('13_Epilogue', 'Under_the_Burning_Suns')).toEqual(utbs);
  });
});

/** The shipped build output (`rebuild-snapshots.mjs`): every campaign difficulty is reachable for every scenario. */
describe('shipped scenario snapshots', () => {
  /** Every campaign directory's own files, e.g. `Dead_Water/01_Invasion.json`. */
  const files = new Set(
    fs
      .readdirSync(scenariosDir)
      .filter((d) => fs.statSync(path.join(scenariosDir, d)).isDirectory())
      .flatMap((d) => fs.readdirSync(path.join(scenariosDir, d)).map((f) => `${d}/${f}`)),
  );
  const bases = [...files].filter((f) => !f.includes('@'));
  const read = (assetDir: string, id: string): GameBoardSnapshot => JSON.parse(fs.readFileSync(path.join(scenariosDir, assetDir, `${id}.json`), 'utf8')) as GameBoardSnapshot;

  it('records the default difficulty in every real campaign scenario, and none in a debug one', () => {
    for (const c of manifest.campaigns) {
      const def = c.difficulties?.find((d) => d.default)?.define ?? c.difficulties?.[0]?.define;
      expect(read(c.assetDir, c.firstScenario).difficulty, c.id).toBe(def);
    }
  });

  it('has an overlay for each non-default difficulty of a campaign scenario, that applies to its difficulty', () => {
    for (const c of manifest.campaigns) {
      const ds = c.difficulties ?? [];
      if (ds.length < 2) continue;
      const def = (ds.find((d) => d.default) ?? ds[0]!).define;
      const baseSnap = read(c.assetDir, c.firstScenario);
      for (const d of ds.filter((x) => x.define !== def)) {
        const name = `${c.assetDir}/${c.firstScenario}@${d.define}.json`;
        expect(files.has(name), name).toBe(true);
        const overlay = JSON.parse(fs.readFileSync(path.join(scenariosDir, name), 'utf8')) as SnapshotOverlay;
        expect(applySnapshotOverlay(baseSnap, overlay).difficulty, name).toBe(d.define);
      }
    }
  });

  it('has no overlay without a base', () => {
    for (const f of files) if (f.includes('@')) expect(bases.includes(f.replace(/@[^/.]+(?=\.json$)/, '')), f).toBe(true);
  });

  it('builds Two Brothers at its own default (EASY), not a hardcoded NORMAL', () => {
    const tb = manifest.campaigns.find((c) => c.wesnothId === 'Two_Brothers')!;
    expect(read(tb.assetDir, tb.firstScenario).difficulty).toBe('EASY');
  });

  it('files a scenario id two campaigns share (13_Epilogue) separately under each campaign, not one clobbering the other', () => {
    const dw = manifest.campaigns.find((c) => c.wesnothId === 'Dead_Water')!;
    const utbs = manifest.campaigns.find((c) => c.wesnothId === 'Under_the_Burning_Suns')!;
    expect(files.has('Dead_Water/13_Epilogue.json')).toBe(true);
    expect(files.has('Under_the_Burning_Suns/13_Epilogue.json')).toBe(true);
    const dwEpilogue = JSON.parse(fs.readFileSync(path.join(scenariosDir, 'Dead_Water/13_Epilogue.json'), 'utf8')) as GameBoardSnapshot;
    const utbsEpilogue = JSON.parse(fs.readFileSync(path.join(scenariosDir, 'Under_the_Burning_Suns/13_Epilogue.json'), 'utf8')) as GameBoardSnapshot;
    // Two different scenarios that happen to share an id: their unit rosters differ.
    expect(Object.keys(dwEpilogue.unitTypes).sort()).not.toEqual(Object.keys(utbsEpilogue.unitTypes).sort());
    expect(dw.assetDir).toBe('Dead_Water');
    expect(utbs.assetDir).toBe('Under_the_Burning_Suns');
  });

  it("every campaign's assetDir is a real directory under scenarios/, with its firstScenario in it", () => {
    for (const c of manifest.campaigns) {
      expect(fs.existsSync(path.join(scenariosDir, c.assetDir)), c.id).toBe(true);
      expect(fs.existsSync(path.join(scenariosDir, c.assetDir, `${c.firstScenario}.json`)), c.id).toBe(true);
    }
  });
});
