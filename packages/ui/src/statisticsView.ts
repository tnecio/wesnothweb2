/**
 * Phase 25: what the statistics dialog shows (`gui2::dialogs::statistics_dialog`), worked out from a side's
 * `StatsT`: the damage and hits figures as upstream writes them, and `tally`'s a-priori probability of the
 * hits a side scored, computed as upstream does by fighting one long simulated attack per chance to hit.
 * Pure (tested in node); the dialog only lays it out.
 */
import { Combatant, STATS_DECIMAL_SHIFT, plainBattleStats, type HitrateMap } from '@wesnothweb2/engine';

/** `std::ostream`'s default format for a double: up to six significant digits, no trailing zeros. */
function streamDouble(x: number): string {
  return String(Number(x.toPrecision(6)));
}

/**
 * `write_actual_and_expected`: the difference as a signed percentage, then the expected figure and what
 * was added or taken from it to give the actual one -- `+12% (25 + 3)`.
 */
export function actualAndExpected(actual: number, expected: number): string {
  if (expected === 0) return '+0% (0 + 0)';
  const percent = Math.round(((actual - expected) * 100) / expected);
  const signed = percent > 0 || (percent === 0 && !Object.is(percent, -0)) ? `+${percent}` : `${Object.is(percent, -0) ? '-0' : percent}`;
  const diff = Math.round(Math.abs(expected - actual));
  return `${signed}% (${streamDouble(expected)} ${actual >= expected ? '+' : '−'} ${diff})`;
}

/** `add_damage_row`'s `damage_str`: expected damage is kept times `decimal_shift`, shown to one decimal. */
export function damageString(damage: number, expected: number): string {
  const shifted = Math.trunc((expected * 20 + STATS_DECIMAL_SHIFT) / (2 * STATS_DECIMAL_SHIFT));
  return actualAndExpected(damage, shifted * 0.1);
}

/** `get_probability_string`: a percentage to one decimal, `100` when within half a tenth of it. */
export function probabilityString(prob: number): string {
  return prob > 0.9995 ? '100' : (100 * prob).toFixed(1);
}

/** One cell of the Hits table (`hitrate_table_element`). */
export interface HitsCell {
  /** `<actual> / <expected>`, as `actualAndExpected`. */
  readonly hitrate: string;
  /** The a-priori percentile in [0, 1], or null before any strike (an em dash). */
  readonly percentile: number | null;
  /** The percentile as the colour scale reads it: for a side, more hits taken is worse. */
  readonly score: number | null;
  /** The tooltip's dynamic part: the actual hit rate at each chance to hit. */
  readonly byCth: readonly { cth: number; rate: string; strikes: number }[];
}

/**
 * `tally`: hits against expected hits over every chance to hit, and how likely it was to score at most
 * that many -- one simulated defender with as many hitpoints as there were strikes, attacked at each chance
 * to hit by an attacker with one point of damage per strike.
 */
export function tally(byCth: HitrateMap, moreIsBetter: boolean): HitsCell {
  let overallHits = 0;
  let expectedHits = 0;
  let overallStrikes = 0;
  const rows: { cth: number; rate: string; strikes: number }[] = [];
  for (const [cth, rate] of [...byCth.entries()].sort(([a], [b]) => a - b)) {
    overallHits += rate.hits;
    expectedHits += cth * 0.01 * rate.strikes;
    overallStrikes += rate.strikes;
    rows.push({ cth, rate: probabilityString(rate.hits / rate.strikes), strikes: rate.strikes });
  }
  const hitrate = actualAndExpected(overallHits, expectedHits);
  if (overallStrikes === 0) return { hitrate, percentile: null, score: null, byCth: rows };

  let defender = new Combatant(plainBattleStats(0, 0, overallStrikes, overallStrikes, 0));
  for (const [cth, rate] of [...byCth.entries()].sort(([a], [b]) => a - b)) {
    const attacker = new Combatant(plainBattleStats(1, rate.strikes, 1, 1, cth));
    defender = new Combatant(plainBattleStats(0, 0, overallStrikes, overallStrikes, 0), defender);
    attacker.fight(defender);
  }
  const dist = defender.hpDist;
  const exactly = (n: number): number => dist[dist.length - 1 - n] ?? 0;
  let lt = 0;
  for (let i = 0; i < overallHits; i++) lt += exactly(i);
  const eq = exactly(overallHits);
  const gt = 1 - (lt + eq);
  const percentile = (lt + (1 - gt)) / 2;
  return { hitrate, percentile, score: moreIsBetter ? percentile : 1 - percentile, byCth: rows };
}
