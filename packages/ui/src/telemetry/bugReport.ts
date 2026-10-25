/**
 * Phase 30: a bug report as the player sends it from "Report a bug" (or the error screen's "Send report"): what
 * they wrote, where in the game they are, and what they chose to attach -- the current game and the recent
 * warnings and errors. Sent to the statistics Worker (`apps/stats`, `POST /v1/reports`), which stores it and
 * emails the developer. When it cannot be sent, the same report can be copied or downloaded as text.
 *
 * Unlike the statistics, a report is not covered by the statistics consent: the player sends each one
 * deliberately, and the dialog says what it holds.
 */
import { EVENT_SCHEMA_VERSION, type BugReport } from './schema.js';
import type { EnvironmentInfo } from './telemetry.js';

export interface BugReportInput {
  description: string;
  expected?: string;
  contact?: string;
  /** Attach the current game as save data (when there is one). */
  includeSave: boolean;
  /** Attach the recent console warnings and errors. */
  includeLog: boolean;
}

/** What the game knows when the report is built (`GameContext`, the log, the error on screen if any). */
export interface BugReportSources {
  environment: EnvironmentInfo;
  userAgent?: string;
  page?: string;
  context: { campaignId?: string; scenarioId?: string; scenarioName?: string; turn?: number; runId?: string; saveData?: () => unknown };
  log: () => string[];
  crash?: { message: string; stack?: string; source?: string } | null;
}

export function buildBugReport(input: BugReportInput, from: BugReportSources): BugReport {
  const trim = (s: string | undefined) => (s && s.trim() !== '' ? s.trim() : undefined);
  let save: unknown;
  if (input.includeSave && from.context.saveData) {
    try {
      save = from.context.saveData();
    } catch {
      save = undefined;
    }
  }
  return {
    v: EVENT_SCHEMA_VERSION,
    kind: from.crash ? 'crash' : 'bug',
    build: from.environment.build,
    lang: from.environment.lang,
    device: from.environment.device,
    userAgent: from.userAgent,
    description: input.description.trim(),
    expected: trim(input.expected),
    contact: trim(input.contact),
    context: {
      campaign: from.context.campaignId,
      scenario: from.context.scenarioId,
      scenarioName: from.context.scenarioName,
      turn: from.context.turn,
      run: from.context.runId,
      page: from.page,
    },
    error: from.crash ? { message: from.crash.message, stack: from.crash.stack, source: from.crash.source } : undefined,
    log: input.includeLog ? from.log() : undefined,
    save,
  };
}

/** The report as text, for Copy / Download when it cannot be sent. */
export function bugReportText(report: BugReport): string {
  const c = report.context;
  const lines = [
    `Wesnoth web port -- ${report.kind === 'crash' ? 'error' : 'bug'} report`,
    `Build: ${report.build}`,
    `Page: ${c.page ?? ''}`,
    `Browser: ${report.userAgent ?? ''}`,
    `Campaign: ${c.campaign ?? '-'}; scenario: ${c.scenario ?? '-'}${c.scenarioName ? ` (${c.scenarioName})` : ''}; turn: ${c.turn ?? '-'}`,
    ...(report.contact ? [`Contact: ${report.contact}`] : []),
    '',
    'What happened:',
    report.description,
    ...(report.expected ? ['', 'Expected:', report.expected] : []),
    ...(report.error ? ['', `Error (${report.error.source ?? '?'}): ${report.error.message}`, report.error.stack ?? '(no stack)'] : []),
    ...(report.log ? ['', `Recent console warnings and errors (${report.log.length}):`, ...report.log] : []),
    ...(report.save !== undefined ? ['', 'Save data (JSON):', JSON.stringify(report.save)] : []),
  ];
  return lines.join('\n');
}

/** Sends `report`; resolves to its reference id, or rejects (offline, refused, too large). */
export async function sendBugReport(statsUrl: string, report: BugReport, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${statsUrl}/v1/reports`, { method: 'POST', body: JSON.stringify(report), headers: { 'Content-Type': 'text/plain' }, credentials: 'omit' });
  if (!res.ok) throw new Error(`the report server answered ${res.status}`);
  const body = (await res.json()) as { id?: unknown };
  if (typeof body.id !== 'string') throw new Error('the report server gave no reference');
  return body.id;
}
