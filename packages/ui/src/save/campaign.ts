/**
 * A campaign as `apps/web/public/campaigns.json` describes it, plus the
 * upstream identity a Wesnoth-format save needs.
 *
 * The upstream fields are optional because this project's synthetic debug
 * campaigns (`synthetic-campaigns/`) have no counterpart in real Wesnoth:
 * they can be saved and loaded here like anything else, but a save of one
 * cannot be exported as a file the real game would know what to do with.
 */

import type { TString } from '@wesnothweb2/engine';
import type { WesnothCampaignInfo } from './wesnothSave.js';

export interface CampaignInfo {
  /** This project's own id, e.g. `dead_water`. */
  id: string;
  /** The English name: what a save file records, whatever language the menu is in. */
  name: string;
  description?: string;
  /** The name and description as upstream's translatable strings, for anything shown to the player. */
  nameT?: TString;
  descriptionT?: TString;
  firstScenario?: string;
  /** Upstream's `[campaign] id=`, e.g. `Dead_Water`. */
  wesnothId?: string;
  /** Upstream's `[campaign] abbrev=`, e.g. `DW` -- the stem of every save name. */
  abbrev?: string;
  /** Upstream's `[campaign] define=`, e.g. `CAMPAIGN_DEAD_WATER`. */
  define?: string;
}

/**
 * The upstream identity needed to write a real save file, or `null` when
 * this campaign has none (a synthetic debug campaign). Callers use the
 * `null` to disable "download as Wesnoth save" rather than emit a file
 * the real game would reject.
 */
export function wesnothCampaignInfo(campaign: CampaignInfo | null): WesnothCampaignInfo | null {
  if (!campaign?.wesnothId || !campaign.abbrev || !campaign.define) return null;
  return {
    wesnothId: campaign.wesnothId,
    name: campaign.name,
    abbrev: campaign.abbrev,
    define: campaign.define,
  };
}

/** The save-name stem for a campaign, falling back to its own id when it has no upstream abbreviation. */
export function campaignAbbrev(campaign: CampaignInfo | null): string {
  return campaign?.abbrev ?? campaign?.id ?? '';
}
