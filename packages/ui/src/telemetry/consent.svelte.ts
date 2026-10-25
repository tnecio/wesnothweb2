/**
 * Phase 32: whether the player agreed to send anonymous gameplay statistics (user decision: opt-in). Asked once
 * on the title screen, changeable in Preferences, kept per browser. Until the answer is `yes` nothing is queued
 * or sent (`telemetry.ts`). Remembering the answer itself needs no consent: it is the player's own setting.
 *
 * Bug reports are not covered by this: the player sends each one deliberately.
 */
import { STATS_CONSENT_KEY, parseStatsConsent, type StatsConsent } from './consent.js';

export type { StatsConsent } from './consent.js';

function load(): StatsConsent {
  try {
    return parseStatsConsent(localStorage.getItem(STATS_CONSENT_KEY));
  } catch {
    return 'unasked';
  }
}

/** The answer (reactive: the title screen's question and Preferences read it). */
export const statsConsent = $state<{ value: StatsConsent }>({ value: typeof localStorage === 'undefined' ? 'unasked' : load() });

export function setStatsConsent(value: 'yes' | 'no'): void {
  statsConsent.value = value;
  try {
    localStorage.setItem(STATS_CONSENT_KEY, value);
  } catch {
    // Storage unavailable (a private window): the answer holds for this visit.
  }
}
