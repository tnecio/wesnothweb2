/**
 * Phase 30: the player's answer to "send anonymous gameplay statistics?" (user decision: opt-in), as stored --
 * the reactive store is `consent.svelte.ts`.
 */
export type StatsConsent = 'unasked' | 'yes' | 'no';

export const STATS_CONSENT_KEY = 'wesnothweb2.statsConsent';

/** Reads what `setStatsConsent` wrote; anything else is `unasked`. */
export function parseStatsConsent(raw: string | null | undefined): StatsConsent {
  return raw === 'yes' || raw === 'no' ? raw : 'unasked';
}
