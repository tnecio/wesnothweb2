/**
 * Phase 32: the statistics Worker's handler, with in-memory stand-ins for D1, R2, email and the rate limiter.
 */
import { describe, expect, it } from 'vitest';
import { cleanUp, handle, type Database, type Deps, type Statement } from '../src/handler.js';

const ORIGIN = 'https://wesnoth.fun';

interface Fakes {
  deps: Deps;
  rows: { sql: string; values: unknown[] }[];
  objects: Map<string, string>;
  mails: { subject: string; text: string }[];
}

function fakes(overrides: Partial<Deps> = {}): Fakes {
  const rows: Fakes['rows'] = [];
  const objects = new Map<string, string>();
  const mails: Fakes['mails'] = [];
  const db: Database = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement: Statement & { sql: string; values: unknown[] } = { sql, values, run: async () => void rows.push({ sql, values }) };
          return statement;
        },
      };
    },
    async batch(statements) {
      for (const s of statements) await s.run();
    },
  };
  const deps: Deps = {
    db,
    reports: { put: async (key, value) => void objects.set(key, value) },
    mail: async (subject, text) => void mails.push({ subject, text }),
    eventLimiter: null,
    reportLimiter: null,
    allowedOrigins: `${ORIGIN},http://localhost:5173`,
    reportsEnabled: true,
    now: () => new Date('2026-10-25T12:00:00Z'),
    newId: () => '2026-10-25-abcd1234',
    ...overrides,
  };
  return { deps, rows, objects, mails };
}

const event = (extra: Record<string, unknown> = {}) => ({ v: 1, type: 'scenario_start', t: 1792900000000, build: 'v0.20.0', lang: 'en_US', device: 'desktop', browser: 'firefox', run: 'r-1', campaign: 'the_south_guard', scenario: '01_Born_to_the_Banner', difficulty: 'EASY', turn: 1, ...extra });

function post(path: string, body: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin) headers['Origin'] = origin;
  return new Request(`https://stats.wesnoth.fun${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('POST /v1/events', () => {
  it('stores a valid batch, one row per event, with its type\'s own fields as JSON', async () => {
    const f = fakes();
    const res = await handle(post('/v1/events', [event(), event({ type: 'scenario_end', result: 'victory', turnsLimit: 12, minutes: 9 })]), f.deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(f.rows).toHaveLength(2);
    expect(f.rows[0]!.sql).toMatch(/^INSERT INTO events/);
    expect(f.rows[0]!.values).toContain('the_south_guard');
    expect(f.rows[0]!.values.at(-1)).toBeNull();
    expect(JSON.parse(f.rows[1]!.values.at(-1) as string)).toEqual({ result: 'victory', turnsLimit: 12, minutes: 9 });
  });

  it('Phase 30: keeps the combat mode of a scenario start and end in its JSON', async () => {
    const f = fakes();
    await handle(post('/v1/events', [event({ rng: 'reduced' }), event({ type: 'scenario_end', result: 'defeat', minutes: 3, rng: 'predictable' })]), f.deps);
    expect(JSON.parse(f.rows[0]!.values.at(-1) as string)).toEqual({ rng: 'reduced' });
    expect(JSON.parse(f.rows[1]!.values.at(-1) as string)).toEqual({ result: 'defeat', minutes: 3, rng: 'predictable' });
  });

  it('drops unknown fields', async () => {
    const f = fakes();
    await handle(post('/v1/events', [event({ ip: '1.2.3.4', userAgent: 'x' })]), f.deps);
    expect(f.rows[0]!.values.join(' ')).not.toMatch(/1\.2\.3\.4/);
  });

  it('refuses an unknown type, a wrong field type, an overlong string, a wrong schema version, and an empty or overfull batch', async () => {
    for (const bad of [[event({ type: 'mouse_moved' })], [event({ turn: 'three' })], [event({ campaign: 'x'.repeat(200) })], [event({ v: 2 })], [], Array.from({ length: 21 }, () => event())]) {
      const f = fakes();
      const res = await handle(post('/v1/events', bad), f.deps);
      expect(res.status).toBe(400);
      expect(f.rows).toHaveLength(0);
    }
  });

  it('refuses a body that is not JSON', async () => {
    expect((await handle(post('/v1/events', 'not json'), fakes().deps)).status).toBe(400);
  });

  it('answers 429 once the rate limiter says so', async () => {
    const f = fakes({ eventLimiter: { limit: async () => ({ success: false }) } });
    expect((await handle(post('/v1/events', [event()]), f.deps)).status).toBe(429);
    expect(f.rows).toHaveLength(0);
  });
});

const report = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  kind: 'bug',
  build: 'v0.20.0',
  lang: 'en_US',
  device: 'phone',
  userAgent: 'Mozilla/5.0',
  description: 'The quintain spoke before the fight.\nThen the fight played.',
  context: { campaign: 'the_south_guard', scenario: '01_Born_to_the_Banner', scenarioName: 'Born to the Banner', turn: 2, run: 'r-1' },
  log: ['WARN something'],
  save: { version: 1 },
  ...extra,
});

describe('POST /v1/reports', () => {
  it('stores the report in R2, indexes it in D1, emails a summary and answers its id', async () => {
    const f = fakes();
    const res = await handle(post('/v1/reports', report()), f.deps);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: '2026-10-25-abcd1234' });
    const stored = JSON.parse(f.objects.get('reports/2026-10-25-abcd1234.json')!);
    expect(stored.description).toMatch(/quintain/);
    expect(stored.save).toEqual({ version: 1 });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.sql).toMatch(/^INSERT INTO reports/);
    expect(f.mails).toHaveLength(1);
    expect(f.mails[0]!.subject).toBe('[wesnoth bug] the_south_guard / 01_Born_to_the_Banner, turn 2: The quintain spoke before the fight.');
    expect(f.mails[0]!.text).toMatch(/report\.mjs 2026-10-25-abcd1234/);
    expect(f.mails[0]!.text).toMatch(/Attached: the game/);
  });

  it('keeps the report when the email fails', async () => {
    const f = fakes({
      mail: async () => {
        throw new Error('not verified');
      },
    });
    const res = await handle(post('/v1/reports', report()), f.deps);
    expect(res.status).toBe(201);
    expect(f.objects.size).toBe(1);
  });

  it('refuses a report with no description, or of no known kind', async () => {
    for (const bad of [report({ description: '  ' }), report({ kind: 'feature' }), { hello: 1 }]) {
      const f = fakes();
      expect((await handle(post('/v1/reports', bad), f.deps)).status).toBe(400);
      expect(f.objects.size).toBe(0);
    }
  });

  it('refuses a report over 2 MB', async () => {
    const f = fakes();
    const res = await handle(post('/v1/reports', report({ save: 'x'.repeat(2 * 1024 * 1024) })), f.deps);
    expect(res.status).toBe(413);
    expect(f.objects.size).toBe(0);
  });

  it('answers 503 while reports are switched off', async () => {
    expect((await handle(post('/v1/reports', report()), fakes({ reportsEnabled: false }).deps)).status).toBe(503);
  });
});

describe('CORS and routing', () => {
  it('refuses a request from another origin', async () => {
    const f = fakes();
    const res = await handle(post('/v1/events', [event()], 'https://evil.example'), f.deps);
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(f.rows).toHaveLength(0);
  });

  it('answers the preflight for an allowed origin', async () => {
    const res = await handle(new Request('https://stats.wesnoth.fun/v1/reports', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } }), fakes().deps);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/POST/);
  });

  it('answers the health check, and 404 elsewhere', async () => {
    expect(await (await handle(new Request('https://stats.wesnoth.fun/v1/health'), fakes().deps)).text()).toBe('ok');
    expect((await handle(new Request('https://stats.wesnoth.fun/admin', { headers: { Origin: ORIGIN } }), fakes().deps)).status).toBe(404);
  });
});

describe('the daily clean-up', () => {
  it('deletes events after 13 months and report rows after 12', async () => {
    const f = fakes();
    await cleanUp(f.deps.db, new Date('2026-10-25T03:17:00Z'));
    expect(f.rows.map((r) => [r.sql.split(' ')[2], r.values[0]])).toEqual([
      ['events', '2025-09-25T00:00:00.000Z'],
      ['reports', '2025-10-25T00:00:00.000Z'],
    ]);
  });
});
