/**
 * Phase 32: building, writing out and sending a bug report (`bugReport.ts`).
 */
import { describe, expect, it } from 'vitest';
import { buildBugReport, bugReportText, sendBugReport, type BugReportSources } from './bugReport.js';
import { validateReport } from './schema.js';

const sources = (overrides: Partial<BugReportSources> = {}): BugReportSources => ({
  environment: { build: 'v0.20.0', lang: 'en_US', device: 'desktop', browser: 'firefox' },
  userAgent: 'Mozilla/5.0 Firefox/140.0',
  page: 'https://wesnoth.tnec.io/play/the_south_guard',
  context: { campaignId: 'the_south_guard', scenarioId: '01_Born_to_the_Banner', scenarioName: 'Born to the Banner', turn: 2, runId: 'run-1', saveData: () => ({ version: 2, turnNumber: 2 }) },
  log: () => ['12:00:00.000 WARN [wml] something odd'],
  ...overrides,
});

describe('a bug report', () => {
  it('holds what the player wrote, where they are, and what they chose to attach', () => {
    const report = buildBugReport({ description: '  The quintain spoke first.  ', expected: '', contact: ' me@example.com ', includeSave: true, includeLog: true }, sources());
    expect(report).toMatchObject({
      kind: 'bug',
      build: 'v0.20.0',
      description: 'The quintain spoke first.',
      contact: 'me@example.com',
      context: { campaign: 'the_south_guard', scenario: '01_Born_to_the_Banner', turn: 2, run: 'run-1' },
      log: ['12:00:00.000 WARN [wml] something odd'],
      save: { version: 2, turnNumber: 2 },
    });
    expect(report.expected).toBeUndefined();
    expect(validateReport(JSON.parse(JSON.stringify(report)))).not.toBeNull();
  });

  it('leaves out the game and the log when the player unticks them', () => {
    const report = buildBugReport({ description: 'x', includeSave: false, includeLog: false }, sources());
    expect(report.save).toBeUndefined();
    expect(report.log).toBeUndefined();
  });

  it('from the error screen, is a crash report with the error', () => {
    const report = buildBugReport({ description: 'It froze when I attacked.', includeSave: false, includeLog: true }, sources({ crash: { message: 'x is undefined', stack: 'at f (a.js:1:2)', source: 'error' } }));
    expect(report.kind).toBe('crash');
    expect(report.error).toEqual({ message: 'x is undefined', stack: 'at f (a.js:1:2)', source: 'error' });
    expect(bugReportText(report)).toMatch(/Error \(error\): x is undefined\nat f \(a\.js:1:2\)/);
  });

  it('as text, has the build, the place, the description and the save', () => {
    const text = bugReportText(buildBugReport({ description: 'Stuck on turn 2.', includeSave: true, includeLog: false }, sources()));
    expect(text).toMatch(/^Wesnoth web port -- bug report\nBuild: v0\.20\.0/);
    expect(text).toMatch(/Campaign: the_south_guard; scenario: 01_Born_to_the_Banner \(Born to the Banner\); turn: 2/);
    expect(text).toMatch(/What happened:\nStuck on turn 2\./);
    expect(text).toMatch(/Save data \(JSON\):\n\{"version":2,"turnNumber":2\}/);
  });

  it('is sent as text/plain to /v1/reports, and answers the reference', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: '2026-10-25-abcd1234' }), { status: 201 });
    }) as unknown as typeof fetch;
    const id = await sendBugReport('https://stats.wesnoth.fun', buildBugReport({ description: 'x', includeSave: false, includeLog: false }, sources()), fetchImpl);
    expect(id).toBe('2026-10-25-abcd1234');
    expect(calls[0]!.url).toBe('https://stats.wesnoth.fun/v1/reports');
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
  });

  it('a refused report rejects, so the dialog offers copy and download', async () => {
    const fetchImpl = (async () => new Response('too large', { status: 413 })) as unknown as typeof fetch;
    await expect(sendBugReport('https://stats.wesnoth.fun', buildBugReport({ description: 'x', includeSave: false, includeLog: false }, sources()), fetchImpl)).rejects.toThrow(/413/);
  });
});
