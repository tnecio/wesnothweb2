/** Storage for `completion.ts`: the completed-campaigns record, kept in the saves database's settings store. */
import { readSetting, writeSetting } from '../persistence.js';
import { withCompleted, type CompletedCampaigns } from './completion.js';

const KEY = 'completedCampaigns';

export async function loadCompletedCampaigns(): Promise<CompletedCampaigns> {
  try {
    return await readSetting<CompletedCampaigns>(KEY, {});
  } catch (err) {
    console.error('[menu] could not read completed campaigns:', err);
    return {};
  }
}

/** Records a win (`playcampaign.cpp`: on victory with no next scenario). `difficulty` is `''` when the campaign has none. */
export async function markCampaignCompleted(campaignId: string, difficulty: string): Promise<void> {
  const done = await loadCompletedCampaigns();
  const next = withCompleted(done, campaignId, difficulty);
  if (next !== done) await writeSetting(KEY, next);
}
