/**
 * Phase 32: the statistics and bug-report Worker (https://wesnoth-stats.tnec.io), as plain functions over the
 * bindings it is given, so tests can run it in node with stand-ins (`index.ts` wires the real ones).
 *
 *   POST /v1/events   a batch of gameplay statistics events (opt-in in the game) -> D1 `events`
 *   POST /v1/reports  one bug report -> its JSON in R2 `wesnoth-reports`, a row in D1 `reports`, an email
 *   GET  /v1/health   "ok"
 *
 * Only the game's own origins may call it (CORS). Requests are limited per IP and in size, and every event and
 * report is checked against `packages/ui/src/telemetry/schema.ts`. No IP or user agent is stored for events;
 * a report holds what the player chose to send.
 */
import { MAX_EVENTS_PER_BATCH, MAX_REPORT_BYTES, validateEvent, validateReport, type BugReport, type StatsEvent } from '../../../packages/ui/src/telemetry/schema.js';

/** The parts of D1 used here (`D1Database`). */
export interface Database {
  prepare(sql: string): { bind(...values: unknown[]): Statement };
  batch(statements: Statement[]): Promise<unknown>;
}
export interface Statement {
  run(): Promise<unknown>;
}

/** The parts of R2 used here (`R2Bucket`). */
export interface ReportStore {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

/** A rate limiter (`RateLimit` binding): `success` is false once the key is over its limit. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Deps {
  db: Database;
  reports: ReportStore;
  /** Sends the developer a plain-text email; null when email is not set up (then reports are only stored). */
  mail: ((subject: string, text: string) => Promise<void>) | null;
  eventLimiter: Limiter | null;
  reportLimiter: Limiter | null;
  /** Comma-separated origins allowed to call (`ALLOWED_ORIGINS`). */
  allowedOrigins: string;
  /** False turns reports off (`REPORTS_ENABLED=false`), if they are ever abused. */
  reportsEnabled: boolean;
  now?: () => Date;
  newId?: () => string;
}

/** The largest event batch accepted, in bytes. */
const MAX_EVENTS_BYTES = 64 * 1024;

function corsHeaders(origin: string | null, deps: Deps): Record<string, string> {
  const allowed = deps.allowedOrigins.split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(status: number, body: unknown, cors: Record<string, string>): Response {
  if (status === 204) return new Response(null, { status, headers: cors });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' },
  });
}

/** The request body as text, or null when it is longer than `max` bytes. */
async function readBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > max) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength > max ? null : text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function overLimit(limiter: Limiter | null, request: Request): Promise<boolean> {
  if (!limiter) return false;
  const key = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return !(await limiter.limit({ key })).success;
}

const EVENT_COLUMNS = ['received', 't', 'v', 'type', 'build', 'lang', 'device', 'browser', 'run', 'campaign', 'scenario', 'difficulty', 'turn', 'data'] as const;
const COMMON = new Set(['t', 'v', 'type', 'build', 'lang', 'device', 'browser', 'run', 'campaign', 'scenario', 'difficulty', 'turn']);

function eventRow(event: StatsEvent, received: string): unknown[] {
  const extra = Object.fromEntries(Object.entries(event).filter(([k]) => !COMMON.has(k)));
  return EVENT_COLUMNS.map((column) => {
    if (column === 'received') return received;
    if (column === 'data') return Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    return event[column] ?? null;
  });
}

async function handleEvents(request: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  if (await overLimit(deps.eventLimiter, request)) return reply(429, 'too many requests', cors);
  const text = await readBody(request, MAX_EVENTS_BYTES);
  if (text === null) return reply(413, 'too large', cors);
  const body = parseJson(text);
  const list = Array.isArray(body) ? body : typeof body === 'object' && body !== null && Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events : null;
  if (!list || list.length === 0 || list.length > MAX_EVENTS_PER_BATCH) return reply(400, 'expected 1-20 events', cors);
  const events = list.map(validateEvent);
  if (events.some((e) => e === null)) return reply(400, 'invalid event', cors);
  const received = (deps.now?.() ?? new Date()).toISOString();
  const sql = `INSERT INTO events (${EVENT_COLUMNS.join(', ')}) VALUES (${EVENT_COLUMNS.map(() => '?').join(', ')})`;
  await deps.db.batch(events.map((e) => deps.db.prepare(sql).bind(...eventRow(e!, received))));
  return reply(204, null, cors);
}

/** The email for a new report: enough to judge it at a glance; the whole report is in R2. */
export function reportEmail(id: string, report: BugReport): { subject: string; text: string } {
  const where = [report.context.campaign, report.context.scenario].filter(Boolean).join(' / ') || 'no game';
  const subject = `[wesnoth ${report.kind}] ${where}${report.context.turn !== undefined ? `, turn ${report.context.turn}` : ''}: ${report.description.split('\n')[0]!.slice(0, 80)}`;
  const text = [
    `Report ${id} (${report.kind}), build ${report.build}`,
    `Where: ${where}${report.context.scenarioName ? ` (${report.context.scenarioName})` : ''}${report.context.turn !== undefined ? `, turn ${report.context.turn}` : ''}`,
    `Device: ${report.device ?? '-'}, language ${report.lang ?? '-'}`,
    report.contact ? `Contact: ${report.contact}` : 'No contact given.',
    report.error ? `Error: ${report.error.message}` : '',
    '',
    'What happened:',
    report.description.slice(0, 2000),
    ...(report.expected ? ['', 'Expected:', report.expected.slice(0, 2000)] : []),
    '',
    `Attached: ${report.save !== undefined ? 'the game (save data)' : 'no save'}; ${report.log?.length ?? 0} log lines.`,
    `Fetch it: node apps/stats/scripts/report.mjs ${id}`,
  ];
  return { subject, text: text.filter((line, i) => line !== '' || i > 4).join('\n') };
}

async function handleReport(request: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  if (!deps.reportsEnabled) return reply(503, 'reports are switched off', cors);
  if (await overLimit(deps.reportLimiter, request)) return reply(429, 'too many requests', cors);
  const text = await readBody(request, MAX_REPORT_BYTES);
  if (text === null) return reply(413, 'too large', cors);
  const report = validateReport(parseJson(text));
  if (!report) return reply(400, 'invalid report', cors);
  const now = deps.now?.() ?? new Date();
  const id = deps.newId?.() ?? `${now.toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  const stored = JSON.stringify({ id, received: now.toISOString(), ...report });
  await deps.reports.put(`reports/${id}.json`, stored, { httpMetadata: { contentType: 'application/json' } });
  await deps.db
    .prepare('INSERT INTO reports (id, received, kind, build, campaign, scenario, turn, summary, has_save, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, now.toISOString(), report.kind, report.build, report.context.campaign ?? null, report.context.scenario ?? null, report.context.turn ?? null, report.description.slice(0, 200), report.save !== undefined ? 1 : 0, stored.length)
    .run();
  if (deps.mail) {
    const { subject, text: body } = reportEmail(id, report);
    try {
      await deps.mail(subject, body);
    } catch (err) {
      // The report is stored either way; a failed email only means it is found by the script, not the inbox.
      console.error('report email failed', err);
    }
  }
  return reply(201, { id }, cors);
}

/** Answers one request. */
export async function handle(request: Request, deps: Deps): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, deps);
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/v1/health') return reply(200, 'ok', cors);
  // Browsers send an Origin with every cross-origin request; one from anywhere else is refused.
  if (origin && Object.keys(cors).length === 0) return reply(403, 'origin not allowed', {});
  if (request.method === 'OPTIONS') return reply(204, null, cors);
  if (request.method === 'POST' && pathname === '/v1/events') return handleEvents(request, deps, cors);
  if (request.method === 'POST' && pathname === '/v1/reports') return handleReport(request, deps, cors);
  return reply(404, 'not found', cors);
}

/** The daily clean-up (Cron Trigger): events older than 13 months, reports older than 12 (their rows; R2 has a lifecycle rule). */
export async function cleanUp(db: Database, now: Date = new Date()): Promise<void> {
  const monthsAgo = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, now.getUTCDate())).toISOString();
  await db.batch([db.prepare('DELETE FROM events WHERE received < ?').bind(monthsAgo(13)), db.prepare('DELETE FROM reports WHERE received < ?').bind(monthsAgo(12))]);
}
