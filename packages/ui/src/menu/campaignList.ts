/**
 * Ordering and filtering of the campaign list, ported from `campaign_selection.cpp` (`sort_campaigns`,
 * `toggle_sorting_selection`, `filter_text_changed`) and `utils/irdya_datetime.cpp`. Pure.
 */
import type { CampaignInfo } from '../save/campaign.js';

/** Upstream's `wesnoth_epoch` order: before Wesnoth, Year of Wesnoth, before the Fall, after the Fall. */
const EPOCHS = ['BW', 'YW', 'BF', 'AF'] as const;

export interface IrdyaDate {
  epoch: number;
  year: number;
}

/** `irdya_date::read_date`: "501 YW"; a bare year is Year of Wesnoth; nothing (or junk) is no date. */
export function parseIrdyaDate(text: string | undefined): IrdyaDate | null {
  const m = /^\s*(\d+)(?:\s+(\S+))?/.exec(text ?? '');
  if (!m) return null;
  const epoch = m[2] === undefined ? 1 : EPOCHS.indexOf(m[2] as (typeof EPOCHS)[number]);
  return { epoch: epoch < 0 ? 1 : epoch, year: Number(m[1]) };
}

/** `irdya_date operator<` for two valid dates: by epoch, and BW / BF count backwards like BCE. */
export function dateBefore(a: IrdyaDate, b: IrdyaDate): boolean {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch;
  return a.epoch === 0 || a.epoch === 2 ? a.year > b.year : a.year < b.year;
}

/** The campaign's first date: `start_year`, else `year` (`campaign::campaign`). */
export function campaignStart(c: CampaignInfo): IrdyaDate | null {
  return parseIrdyaDate(c.startYear ?? c.year);
}

export type SortKey = 'rank' | 'name' | 'timeline';
export interface SortState {
  key: SortKey;
  ascending: boolean;
}

/**
 * `toggle_sorting_selection`: choosing a header sorts by it ascending, again descending, a third time back to
 * the rank order; choosing the other header replaces it, ascending.
 */
export function nextSort(current: SortState, clicked: 'name' | 'timeline'): SortState {
  if (current.key === clicked) return current.ascending ? { key: clicked, ascending: false } : { key: 'rank', ascending: true };
  return { key: clicked, ascending: true };
}

/**
 * The campaigns in `state`'s order. `rank` is `[campaign] rank=` (default 1000), stable within equal ranks;
 * `name` compares translated names case-insensitively in the player's locale; `timeline` by start date, a
 * campaign with no date after all that have one. `nameOf` gives the name as shown.
 */
export function sortCampaigns<C extends CampaignInfo>(campaigns: readonly C[], state: SortState, nameOf: (c: C) => string, locale?: string): C[] {
  const out = [...campaigns];
  const rank = (c: C): number => c.rank ?? 1000;
  const collator = new Intl.Collator(locale, { sensitivity: 'accent', numeric: false });
  const sign = state.ascending ? 1 : -1;
  const byRank = (a: C, b: C): number => rank(a) - rank(b);
  if (state.key === 'rank') return out.sort(byRank);
  if (state.key === 'name') return out.sort((a, b) => sign * collator.compare(nameOf(a), nameOf(b)));
  return out.sort((a, b) => {
    const da = campaignStart(a);
    const db = campaignStart(b);
    if (!da || !db) return da ? -1 : db ? 1 : 0; // undated campaigns last, whichever direction
    if (dateBefore(da, db)) return -sign;
    if (dateBefore(db, da)) return sign;
    return 0;
  });
}

/**
 * The filter box: whitespace-separated words, every one of which must appear (case-insensitively) in the
 * campaign's translated or English name, its translated or English description, or its abbreviation.
 */
export function matchesSearch(words: readonly string[], haystacks: readonly string[]): boolean {
  const lower = haystacks.map((h) => h.toLocaleLowerCase());
  return words.every((w) => lower.some((h) => h.includes(w.toLocaleLowerCase())));
}

export function searchWords(text: string): string[] {
  return text.split(' ').filter((w) => w !== '');
}
