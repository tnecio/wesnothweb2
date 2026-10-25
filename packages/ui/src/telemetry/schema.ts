/**
 * Phase 32: what the game may send to the statistics Worker (`apps/stats`), and how the Worker checks it.
 * Shared by both sides, so it has no dependencies: the game builds events of these shapes, the Worker keeps
 * only these fields of these types and refuses anything else.
 *
 * Every event says where in the game it happened (campaign, scenario, difficulty, turn), in which campaign run
 * (`run`: a random id made when a campaign starts, kept in its saves), and on what (the build, the language,
 * `phone`/`desktop` and the browser family). Nothing identifies the player.
 */

export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_TYPES = ['scenario_start', 'scenario_end', 'game_load', 'quit', 'crash'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** A field's type and, for strings, its longest allowed length. */
type FieldSpec = { readonly type: 'string'; readonly max: number } | { readonly type: 'number' } | { readonly type: 'boolean' };

const str = (max: number): FieldSpec => ({ type: 'string', max });
const num: FieldSpec = { type: 'number' };

/** The fields every event has. */
export const COMMON_FIELDS = {
  v: num,
  type: str(32),
  /** Client time, rounded to the minute (ms since the epoch). */
  t: num,
  build: str(64),
  lang: str(16),
  device: str(16),
  browser: str(16),
  run: str(64),
  campaign: str(80),
  scenario: str(120),
  difficulty: str(32),
  turn: num,
} as const satisfies Record<string, FieldSpec>;

/** Each event type's own fields. */
export const EXTRA_FIELDS = {
  scenario_start: {},
  scenario_end: { result: str(16), turnsLimit: num, minutes: num },
  game_load: { kind: str(32) },
  quit: { minutes: num },
  crash: { message: str(300), signature: str(400), source: str(16) },
} as const satisfies Record<EventType, Record<string, FieldSpec>>;

export type CommonFields = { [K in keyof typeof COMMON_FIELDS]?: K extends 'v' | 't' | 'turn' ? number : string } & { v: number; type: EventType; t: number };

/** One statistics event: the common fields and its type's own (all optional but `v`, `type` and `t`). */
export type StatsEvent = CommonFields & Record<string, string | number | boolean | undefined>;

/** The most events one request may carry. */
export const MAX_EVENTS_PER_BATCH = 20;

function fits(value: unknown, spec: FieldSpec): boolean {
  if (spec.type === 'string') return typeof value === 'string' && value.length <= spec.max;
  if (spec.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'boolean';
}

/**
 * The event `raw` as the Worker keeps it: its known fields of the right types (unknown fields dropped), or null
 * when it is not an event at all -- no known type, the wrong schema version, a field of the wrong type or too
 * long, or no time.
 */
export function validateEvent(raw: unknown): StatsEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const type = input['type'];
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) return null;
  if (input['v'] !== EVENT_SCHEMA_VERSION || typeof input['t'] !== 'number') return null;
  const specs: Record<string, FieldSpec> = { ...COMMON_FIELDS, ...EXTRA_FIELDS[type as EventType] };
  const out: Record<string, string | number | boolean> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (!fits(value, spec)) return null;
    out[key] = value as string | number | boolean;
  }
  return out as StatsEvent;
}

/** A bug report: what the player wrote, where in the game, and what they chose to attach. */
export interface BugReport {
  v: number;
  /** `bug`: sent from Report a bug; `crash`: from the error screen. */
  kind: 'bug' | 'crash';
  build: string;
  lang?: string;
  device?: string;
  /** The browser's user agent: the player sends a report deliberately, and the dialog says it is included. */
  userAgent?: string;
  description: string;
  expected?: string;
  /** How to reach the player, if they give it. */
  contact?: string;
  context: { campaign?: string; scenario?: string; scenarioName?: string; turn?: number; run?: string; page?: string };
  error?: { message: string; stack?: string; source?: string };
  /** The recent console warnings and errors. */
  log?: string[];
  /** The current game as save data, if the player attached it. */
  save?: unknown;
}

/** The largest report the Worker accepts, in bytes of JSON. */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** The report `raw`, checked: the required fields there and of the right types, the free texts capped. */
export function validateReport(raw: unknown): BugReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== EVENT_SCHEMA_VERSION || (r['kind'] !== 'bug' && r['kind'] !== 'crash')) return null;
  if (typeof r['build'] !== 'string' || typeof r['description'] !== 'string' || r['description'].trim() === '') return null;
  const optionalString = (key: string, max: number): string | undefined => (typeof r[key] === 'string' ? (r[key] as string).slice(0, max) : undefined);
  const ctxIn = typeof r['context'] === 'object' && r['context'] !== null ? (r['context'] as Record<string, unknown>) : {};
  const ctxString = (key: string, max: number): string | undefined => (typeof ctxIn[key] === 'string' ? (ctxIn[key] as string).slice(0, max) : undefined);
  const errorIn = typeof r['error'] === 'object' && r['error'] !== null ? (r['error'] as Record<string, unknown>) : null;
  const report: BugReport = {
    v: EVENT_SCHEMA_VERSION,
    kind: r['kind'],
    build: r['build'].slice(0, 64),
    lang: optionalString('lang', 16),
    device: optionalString('device', 16),
    userAgent: optionalString('userAgent', 400),
    description: r['description'].slice(0, 10000),
    expected: optionalString('expected', 10000),
    contact: optionalString('contact', 200),
    context: {
      campaign: ctxString('campaign', 80),
      scenario: ctxString('scenario', 120),
      scenarioName: ctxString('scenarioName', 200),
      turn: typeof ctxIn['turn'] === 'number' ? ctxIn['turn'] : undefined,
      run: ctxString('run', 64),
      page: ctxString('page', 500),
    },
    error:
      errorIn && typeof errorIn['message'] === 'string'
        ? { message: errorIn['message'].slice(0, 2000), stack: typeof errorIn['stack'] === 'string' ? errorIn['stack'].slice(0, 20000) : undefined, source: typeof errorIn['source'] === 'string' ? errorIn['source'].slice(0, 16) : undefined }
        : undefined,
    log: Array.isArray(r['log']) ? r['log'].filter((l): l is string => typeof l === 'string').slice(-100).map((l) => l.slice(0, 1000)) : undefined,
    save: r['save'],
  };
  return report;
}
