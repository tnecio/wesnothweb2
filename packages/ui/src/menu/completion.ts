/**
 * Which campaigns the player has finished, and at which difficulty (Phase 21): upstream's
 * `prefs::completed_campaigns` (campaign id -> set of difficulty defines), and the laurel and filter rules
 * of `campaign_selection.cpp` / `campaign_difficulty.cpp`, ported exactly. Pure; storage is `completedStore.ts`.
 */
import type { CampaignInfo } from '../save/campaign.js';

/** Campaign id -> the difficulty defines it was won at (`''` for a campaign that has no difficulties). */
export type CompletedCampaigns = Readonly<Record<string, readonly string[]>>;

export type Laurel = 'easy' | 'normal' | 'hardest';

/** Where the laurel images live (`game_config::images::victory_laurel*`), as engine image paths. */
export const LAUREL_IMAGES: Readonly<Record<Laurel, string>> = {
  easy: 'engine/misc/laurel-bronze.png',
  normal: 'engine/misc/laurel-silver.png',
  hardest: 'engine/misc/laurel.png',
};

/** `prefs::is_campaign_completed(id)`: won at any difficulty. */
export function isCampaignCompleted(done: CompletedCampaigns, campaignId: string): boolean {
  return (done[campaignId]?.length ?? 0) > 0;
}

/** `prefs::is_campaign_completed(id, difficulty)`. */
export function isCompletedAt(done: CompletedCampaigns, campaignId: string, difficulty: string): boolean {
  return done[campaignId]?.includes(difficulty) ?? false;
}

/** `prefs::add_completed_campaign`: a copy of `done` with `difficulty` recorded for `campaignId`. */
export function withCompleted(done: CompletedCampaigns, campaignId: string, difficulty: string): CompletedCampaigns {
  const have = done[campaignId] ?? [];
  return have.includes(difficulty) ? done : { ...done, [campaignId]: [...have, difficulty] };
}

/** How a campaign's completion breaks down, as `campaign_selection.cpp` computes it for the laurel and the filter. */
export interface CompletionSummary {
  /** Won at any difficulty. */
  completed: boolean;
  /** The last-listed difficulty was won (any, for a campaign with one). */
  hardest: boolean;
  /** Two or more difficulties, only the first of which was won. */
  easy: boolean;
  /** Won, but neither of the above. */
  mid: boolean;
}

export function summarizeCompletion(campaign: CampaignInfo, done: CompletedCampaigns): CompletionSummary {
  const completed = isCampaignCompleted(done, campaign.id);
  const ds = campaign.difficulties ?? [];
  const at = (i: number): boolean => isCompletedAt(done, campaign.id, ds[i]!.define);
  const onlyFirst = ds.length > 1 && !ds.slice(1).some((_, i) => at(i + 1));
  const easy = onlyFirst && at(0);
  const hardest = ds.length > 0 && at(ds.length - 1);
  return { completed, hardest, easy, mid: completed && !hardest && !easy };
}

/**
 * The laurel beside a campaign in the list (`add_campaign_to_tree`): gold when the last difficulty was won,
 * bronze when only the first of several was, silver for any other completion; none if not completed.
 */
export function campaignLaurel(campaign: CampaignInfo, done: CompletedCampaigns): Laurel | null {
  const s = summarizeCompletion(campaign, done);
  if (!s.completed) return null;
  if (s.hardest) return 'hardest';
  if (s.easy) return 'easy';
  return 'normal';
}

/**
 * The laurel on one difficulty of a campaign (`campaign_difficulty.cpp` / the campaign dialog's menu),
 * given its position among `count` difficulties: the last (or only) one is gold, the first bronze, others silver.
 */
export function difficultyLaurel(index: number, count: number): Laurel {
  if (index + 1 >= count) return 'hardest';
  if (index === 0) return 'easy';
  return 'normal';
}

/** The completion filter's five options, in upstream's order. */
export const COMPLETION_FILTERS = ['not-completed', 'bronze', 'silver', 'gold', 'all-completed'] as const;
export type CompletionFilter = (typeof COMPLETION_FILTERS)[number];

/** `sort_campaigns`'s completion test: shown if any *selected* option matches this campaign. */
export function passesCompletionFilter(summary: CompletionSummary, selected: ReadonlySet<CompletionFilter>): boolean {
  return (
    (!summary.completed && selected.has('not-completed')) ||
    (summary.completed && selected.has('all-completed')) ||
    (summary.hardest && selected.has('gold')) ||
    (summary.easy && selected.has('bronze')) ||
    (summary.mid && selected.has('silver'))
  );
}
