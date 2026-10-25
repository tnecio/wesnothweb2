/**
 * Phase 30: the opt-in statistics queue (`telemetry.ts`) and the schema both it and the Worker use.
 */
import { describe, expect, it } from 'vitest';
import { Telemetry, browserFamily, crashSignature, deviceClass, type TelemetryDeps } from './telemetry.js';
import { COMMON_FIELDS, EXTRA_FIELDS, validateEvent, validateReport } from './schema.js';
import { parseStatsConsent } from './consent.js';

function setup(overrides: Partial<TelemetryDeps> = {}) {
  const sent: { url: string; body: unknown[]; beacon: boolean }[] = [];
  let consent = true;
  const telemetry = new Telemetry({
    url: 'https://wesnoth-stats.tnec.io',
    consented: () => consent,
    context: () => ({ campaignId: 'the_south_guard', scenarioId: '01_Born_to_the_Banner', difficulty: 'EASY', turn: 3, runId: 'run-1' }),
    environment: () => ({ build: 'v0.20.0', lang: 'pl_PL', device: 'phone', browser: 'firefox' }),
    send: (url, body, beacon) => void sent.push({ url, body: JSON.parse(body) as unknown[], beacon }),
    now: () => Date.UTC(2026, 9, 25, 12, 34, 56),
    ...overrides,
  });
  return { telemetry, sent, setConsent: (v: boolean) => (consent = v) };
}

describe('the statistics queue', () => {
  it('queues and sends nothing without consent', async () => {
    const { telemetry, sent, setConsent } = setup();
    setConsent(false);
    telemetry.track('scenario_start');
    expect(telemetry.pending).toBe(0);
    await telemetry.flush();
    expect(sent).toHaveLength(0);
  });

  it('queues and sends nothing when the build names no server (development, CI)', async () => {
    const { telemetry, sent } = setup({ url: null });
    telemetry.track('scenario_start');
    await telemetry.flush(true);
    expect(sent).toHaveLength(0);
  });

  it('sends a batch with where it happened, the run and the coarse environment, the time to the minute', async () => {
    const { telemetry, sent } = setup();
    telemetry.track('scenario_start');
    telemetry.track('scenario_end', { result: 'defeat', turnsLimit: 12, minutes: 31 });
    await telemetry.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://wesnoth-stats.tnec.io/v1/events');
    expect(sent[0]!.beacon).toBe(false);
    expect(sent[0]!.body[1]).toEqual({
      v: 1,
      type: 'scenario_end',
      t: Date.UTC(2026, 9, 25, 12, 34),
      build: 'v0.20.0',
      lang: 'pl_PL',
      device: 'phone',
      browser: 'firefox',
      run: 'run-1',
      campaign: 'the_south_guard',
      scenario: '01_Born_to_the_Banner',
      difficulty: 'EASY',
      turn: 3,
      result: 'defeat',
      turnsLimit: 12,
      minutes: 31,
    });
    expect(telemetry.pending).toBe(0);
  });

  it('every event it builds passes the Worker\'s check unchanged, with no field outside the schema', async () => {
    const { telemetry, sent } = setup();
    telemetry.track('scenario_start');
    telemetry.track('scenario_end', { result: 'victory', turnsLimit: 20, minutes: 5 });
    telemetry.track('game_load', { kind: 'autosave' });
    telemetry.track('quit', { minutes: 2 });
    telemetry.track('crash', { message: 'x is undefined', signature: 'x is undefined @ GameShell.svelte:10:5', source: 'error' });
    await telemetry.flush();
    for (const event of sent[0]!.body as Record<string, unknown>[]) {
      expect(validateEvent(event)).toEqual(event);
      const allowed = new Set([...Object.keys(COMMON_FIELDS), ...Object.keys(EXTRA_FIELDS[event['type'] as keyof typeof EXTRA_FIELDS])]);
      expect(Object.keys(event).filter((k) => !allowed.has(k))).toEqual([]);
    }
  });

  it('when the page goes away, sends by beacon', async () => {
    const { telemetry, sent } = setup();
    telemetry.track('quit', { minutes: 4 });
    await telemetry.flush(true);
    expect(sent.map((s) => s.beacon)).toEqual([true]);
  });

  it('withdrawing consent drops what was queued before', async () => {
    const { telemetry, sent, setConsent } = setup();
    telemetry.track('scenario_start');
    setConsent(false);
    await telemetry.flush();
    expect(sent).toHaveLength(0);
    expect(telemetry.pending).toBe(0);
  });

  it('a failed send is dropped, not retried, and does not throw', async () => {
    let calls = 0;
    const { telemetry } = setup({
      send: () => {
        calls++;
        throw new Error('offline');
      },
    });
    telemetry.track('scenario_start');
    await telemetry.flush();
    await telemetry.flush();
    expect(calls).toBe(1);
  });

  it('a full batch of 20 goes at once', () => {
    const { telemetry, sent } = setup();
    for (let i = 0; i < 20; i++) telemetry.track('game_load', { kind: 'autosave' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toHaveLength(20);
  });
});

describe('the environment, coarsely', () => {
  it('names the device class and the browser family only', () => {
    expect(deviceClass(false, 1080)).toBe('desktop');
    expect(deviceClass(true, 412)).toBe('phone');
    expect(deviceClass(true, 800)).toBe('tablet');
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('firefox');
    expect(browserFamily('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('edge');
    expect(browserFamily('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36')).toBe('chrome');
    expect(browserFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('safari');
  });
});

describe('consent and crash signatures', () => {
  it('reads only yes or no as an answer', () => {
    expect(parseStatsConsent('yes')).toBe('yes');
    expect(parseStatsConsent('no')).toBe('no');
    expect(parseStatsConsent(null)).toBe('unasked');
    expect(parseStatsConsent('maybe')).toBe('unasked');
  });

  it('a crash signature is the message and the first code position, without the host or hashed path', () => {
    const stack = 'TypeError: x is undefined\n    at playAttack (https://wesnoth.tnec.io/assets/index-3f9a2c.js:120:44)\n    at run (https://wesnoth.tnec.io/assets/index-3f9a2c.js:80:3)';
    expect(crashSignature('x is undefined', stack)).toBe('x is undefined @ playAttack (index-3f9a2c.js:120:44)');
    expect(crashSignature('boom', undefined)).toBe('boom');
  });
});

describe('the bug report check', () => {
  it('keeps a report\'s fields, caps its texts, and refuses one with no description', () => {
    const report = validateReport({ v: 1, kind: 'bug', build: 'dev', description: 'x'.repeat(20000), context: { campaign: 'liberty', turn: 4, extra: 'dropped' }, log: ['a', 5, 'b'] });
    expect(report?.description).toHaveLength(10000);
    expect(report?.context).toEqual({ campaign: 'liberty', scenario: undefined, scenarioName: undefined, turn: 4, run: undefined, page: undefined });
    expect(report?.log).toEqual(['a', 'b']);
    expect(validateReport({ v: 1, kind: 'bug', build: 'dev', description: '' })).toBeNull();
  });
});
