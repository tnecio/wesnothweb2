/**
 * Phase 28 S6: what happens when something breaks at run time.
 *
 * Uncaught errors, unhandled promise rejections and Svelte render errors are recorded here and shown by
 * `ErrorScreen.svelte`, which offers to continue, go back to the menu, reload the latest autosave, or
 * copy / download a report. Nothing is sent anywhere: the player decides what to do with the report
 * (user decision, docs/PHASE28_PLAN.md).
 *
 * The report carries the build, the browser, where in the game the error happened (the running game
 * registers a `GameContext`), the error and its stack, and the last console warnings and errors, which is
 * where WML and Lua problems are logged.
 */
import { untrack } from 'svelte';

/** Where the player is, read when a report is built. Registered by the running game. */
export interface GameContext {
  campaignId?: string;
  scenarioId?: string;
  scenarioName?: string;
  turn?: number;
  /** The current game as a save (`GameSession.toSaveData`), for reports the player chooses to include it in. */
  saveData?: () => unknown;
}

export interface CapturedError {
  message: string;
  stack?: string;
  source: 'error' | 'rejection' | 'render';
  time: number;
}

interface LogLine {
  time: number;
  level: 'warn' | 'error';
  text: string;
}

const MAX_LOG_LINES = 50;

let contextProvider: (() => GameContext) | null = null;
const log: LogLine[] = [];

/**
 * The error on screen, if any (reactive: `ErrorScreen.svelte` shows it). `contextVersion` changes when a game
 * registers its context, so the screen can look again for, say, that campaign's autosave: an error can
 * come before the game has finished starting.
 */
export const errorState = $state<{ current: CapturedError | null; count: number; contextVersion: number }>({ current: null, count: 0, contextVersion: 0 });

/** Registers (or, with null, clears) how to describe the running game. */
export function setGameContext(provider: (() => GameContext) | null): void {
  contextProvider = provider;
  // Untracked: this is called from the game's own $effect, which must not come to depend on the counter.
  untrack(() => errorState.contextVersion++);
}

export function gameContext(): GameContext {
  try {
    return contextProvider?.() ?? {};
  } catch {
    return {};
  }
}

/**
 * Errors that are not the game breaking: layout notifications, cancelled requests, audio the browser
 * would not start without a click.
 */
export function isBenign(message: string, name?: string): boolean {
  return (
    /ResizeObserver loop/.test(message) ||
    name === 'AbortError' ||
    (name === 'NotAllowedError' && /play\(\)|user didn't interact|user gesture/i.test(message))
  );
}

function describe(value: unknown): { message: string; stack?: string; name?: string } {
  if (value instanceof Error) return { message: value.message || String(value), stack: value.stack, name: value.name };
  if (typeof value === 'string') return { message: value };
  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
}

/** Records `value` and puts it on screen, unless it is benign. The first error stays shown; later ones are counted. */
export function reportError(value: unknown, source: CapturedError['source']): void {
  const { message, stack, name } = describe(value);
  if (isBenign(message, name)) return;
  errorState.count++;
  if (!errorState.current) errorState.current = { message, stack, source, time: Date.now() };
}

export function dismissError(): void {
  errorState.current = null;
}

function remember(level: LogLine['level'], args: unknown[]): void {
  const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : describe(a).message)).join(' ');
  log.push({ time: Date.now(), level, text: text.slice(0, 500) });
  if (log.length > MAX_LOG_LINES) log.shift();
}

let installed = false;

/** Catches uncaught errors and rejections, and keeps the recent console warnings and errors for reports. */
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => reportError(e.error ?? e.message, 'error'));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'rejection'));
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      remember(level, args);
      original(...args);
    };
  }
}

export interface BuildInfo {
  version: string;
  commit: string;
}

/** The build this page is running: set by the deploy (`VITE_APP_VERSION`, `VITE_APP_COMMIT`), else "dev". */
export function buildInfo(): BuildInfo {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  return { version: env['VITE_APP_VERSION'] || 'dev', commit: env['VITE_APP_COMMIT'] || '' };
}

/** The text of a report for `error`, with the current game as a save when `includeSave` (and one is available). */
export function buildReport(error: CapturedError, includeSave: boolean): string {
  const build = buildInfo();
  const ctx = gameContext();
  const lines = [
    'Wesnoth web port -- error report',
    `Build: ${build.version}${build.commit ? ` (${build.commit})` : ''}`,
    `Time: ${new Date(error.time).toISOString()}`,
    `Page: ${typeof location !== 'undefined' ? location.href : ''}`,
    `Browser: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
    `Campaign: ${ctx.campaignId ?? '-'}; scenario: ${ctx.scenarioId ?? '-'}${ctx.scenarioName ? ` (${ctx.scenarioName})` : ''}; turn: ${ctx.turn ?? '-'}`,
    `Errors this session: ${errorState.count}`,
    '',
    `Error (${error.source}): ${error.message}`,
    error.stack ?? '(no stack)',
    '',
    `Recent console warnings and errors (${log.length}):`,
    ...log.map((l) => `${new Date(l.time).toISOString().slice(11, 23)} ${l.level.toUpperCase()} ${l.text}`),
  ];
  if (includeSave && ctx.saveData) {
    try {
      lines.push('', 'Save data (JSON):', JSON.stringify(ctx.saveData()));
    } catch (e) {
      lines.push('', `Save data could not be written: ${describe(e).message}`);
    }
  }
  return lines.join('\n');
}
