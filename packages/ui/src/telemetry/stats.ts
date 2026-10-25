/**
 * Phase 30: the game's one `Telemetry`, wired to the browser -- the player's consent, the running game's context
 * (`setGameContext`), the build, the language and the device -- and the crash hook. `installTelemetry` runs once
 * at start-up (`apps/web/src/main.ts`).
 */
import { buildInfo, gameContext, onCapturedError } from '../errors/errorReporting.svelte.js';
import { locale } from '../i18n/locale.js';
import { statsConsent } from './consent.svelte.js';
import { Telemetry, browserFamily, browserSend, crashSignature, deviceClass, type EnvironmentInfo } from './telemetry.js';

/** The statistics and bug-report server (`apps/stats`): set by the deploy, absent in development and CI. */
export function statsUrl(): string | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const url = env['VITE_STATS_URL']?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

/** The build, language and device class every event and report carries. */
export function environmentInfo(): EnvironmentInfo {
  const build = buildInfo();
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const shortSide = typeof screen !== 'undefined' ? Math.min(screen.width, screen.height) : 0;
  return {
    build: build.commit ? `${build.version}+${build.commit.slice(0, 8)}` : build.version,
    lang: locale.current,
    device: deviceClass(coarse, shortSide),
    browser: typeof navigator !== 'undefined' ? browserFamily(navigator.userAgent) : 'other',
  };
}

export const telemetry = new Telemetry({
  url: statsUrl(),
  consented: () => statsConsent.value === 'yes',
  context: () => {
    const ctx = gameContext();
    return { campaignId: ctx.campaignId, scenarioId: ctx.scenarioId, difficulty: ctx.difficulty, turn: ctx.turn, runId: ctx.runId };
  },
  environment: environmentInfo,
  send: browserSend,
});

let installed = false;

/** Sends what is queued every 30 seconds and when the page is hidden; counts crashes. */
export function installTelemetry(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  onCapturedError((error) => telemetry.track('crash', { message: error.message.slice(0, 300), signature: crashSignature(error.message, error.stack), source: error.source }));
  setInterval(() => void telemetry.flush(), 30000);
  window.addEventListener('pagehide', () => void telemetry.flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void telemetry.flush(true);
  });
}
