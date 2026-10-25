/**
 * Phase 32: the opt-in gameplay statistics (docs/IMPLEMENTATION_PLAN.md, Phase 32). The game reports a handful of
 * moments -- a scenario starting or ending, a save loaded, a scenario left unfinished, a crash -- so that places
 * where players get stuck (often a bug) show up in `apps/stats/scripts/stats.mjs`.
 *
 * Nothing is queued unless the player said yes (`consent.svelte.ts`) and the build names a statistics server
 * (`VITE_STATS_URL`; the deploy sets it, development and CI don't). Events are sent in batches, every 30 seconds
 * and when the page is hidden (`sendBeacon`, which outlives the page). A failed send is dropped, never retried
 * in a loop and never shown: statistics must not get in the way of playing.
 *
 * Requests are `text/plain` so the browser needs no CORS preflight and `sendBeacon` accepts them; the Worker
 * reads the body as JSON whatever its type.
 */
import { EVENT_SCHEMA_VERSION, MAX_EVENTS_PER_BATCH, type EventType, type StatsEvent } from './schema.js';

/** Where in the game an event happened: the running game's `GameContext` (`errorReporting.svelte.ts`). */
export interface EventContext {
  campaignId?: string;
  scenarioId?: string;
  difficulty?: string;
  turn?: number;
  runId?: string;
}

/** The device, coarsely: never more than this about the machine. */
export interface EnvironmentInfo {
  build: string;
  lang: string;
  device: string;
  browser: string;
}

export interface TelemetryDeps {
  /** The statistics server's base URL, or null for none (then nothing is ever queued). */
  url: string | null;
  consented: () => boolean;
  context: () => EventContext;
  environment: () => EnvironmentInfo;
  /** Sends a batch; `beacon` when the page is going away. Errors are the caller's to swallow. */
  send: (url: string, body: string, beacon: boolean) => Promise<void> | void;
  now?: () => number;
}

export type EventExtra = Record<string, string | number | boolean | undefined>;

/** Rounded to the minute: when an event happened matters to the hour, not the second. */
const minute = (ms: number) => Math.floor(ms / 60000) * 60000;

export class Telemetry {
  private queue: StatsEvent[] = [];
  private sending = false;

  constructor(private readonly deps: TelemetryDeps) {}

  /** Whether events are being collected at all. */
  get enabled(): boolean {
    return this.deps.url !== null && this.deps.consented();
  }

  /** Queues one event (nothing without consent and a server). */
  track(type: EventType, extra: EventExtra = {}): void {
    if (!this.enabled) return;
    const ctx = this.deps.context();
    const env = this.deps.environment();
    const event: Record<string, string | number | boolean> = {
      v: EVENT_SCHEMA_VERSION,
      type,
      t: minute(this.deps.now?.() ?? Date.now()),
      build: env.build,
      lang: env.lang,
      device: env.device,
      browser: env.browser,
    };
    const put = (key: string, value: string | number | boolean | undefined) => {
      if (value !== undefined && value !== '') event[key] = value;
    };
    put('run', ctx.runId);
    put('campaign', ctx.campaignId);
    put('scenario', ctx.scenarioId);
    put('difficulty', ctx.difficulty);
    put('turn', ctx.turn);
    for (const [key, value] of Object.entries(extra)) put(key, value);
    this.queue.push(event as StatsEvent);
    // A long session does not hoard events: a full batch goes at once.
    if (this.queue.length >= MAX_EVENTS_PER_BATCH) void this.flush();
  }

  /** How many events wait to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /** Sends what is queued; `beacon` when the page is being hidden or closed. */
  async flush(beacon = false): Promise<void> {
    const url = this.deps.url;
    if (!url || this.queue.length === 0 || (this.sending && !beacon)) return;
    // Withdrawing consent also drops what was queued before.
    if (!this.deps.consented()) {
      this.queue = [];
      return;
    }
    const batch = this.queue.splice(0, MAX_EVENTS_PER_BATCH);
    this.sending = true;
    try {
      await this.deps.send(`${url}/v1/events`, JSON.stringify(batch), beacon);
    } catch {
      // Dropped: see the module comment.
    } finally {
      this.sending = false;
    }
    if (this.queue.length > 0 && beacon) await this.flush(true);
  }
}

/** `phone`, `tablet` or `desktop`, from the pointer and the screen's shorter side. */
export function deviceClass(coarse: boolean, shortSide: number): string {
  if (!coarse) return 'desktop';
  return shortSide <= 600 ? 'phone' : 'tablet';
}

/** The browser family from its user agent: firefox, edge, chrome, safari or other. */
export function browserFamily(userAgent: string): string {
  if (/Firefox\//.test(userAgent)) return 'firefox';
  if (/Edg\//.test(userAgent)) return 'edge';
  if (/(Chrome|Chromium|CriOS)\//.test(userAgent)) return 'chrome';
  if (/Safari\//.test(userAgent)) return 'safari';
  return 'other';
}

/** Sends a batch from the browser: `sendBeacon` when the page goes away, else a `keepalive` fetch. */
export function browserSend(url: string, body: string, beacon: boolean): Promise<void> | void {
  if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    return;
  }
  return fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true, credentials: 'omit' }).then(() => undefined);
}

/**
 * A crash's signature: its message and the first stack frame that names a place in the code, so the same bug
 * in many games counts as one.
 */
export function crashSignature(message: string, stack: string | undefined): string {
  const frame = (stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /:\d+:\d+\)?$/.test(l));
  // A deployed build's file names carry a content hash; keep the file's name and position only.
  const place = frame ? frame.replace(/^at\s+/, '').replace(/https?:\/\/[^\s)]*\//g, '') : '';
  return `${message.slice(0, 200)}${place ? ` @ ${place}` : ''}`.slice(0, 400);
}
