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
  /**
   * The directory this campaign's scenario and story JSON are filed under
   * (`apps/web/public/scenarios/<assetDir>/<scenarioId>.json`, `public/story/<assetDir>/<scenarioId>.json`):
   * `wesnothId` for a real campaign (its own directory under `wesnoth/data/campaigns/`), or the matching
   * `synthetic-campaigns/` directory for a debug one. Every fetch of a scenario or its story assets needs
   * this, because a bare `[scenario] id=` is only unique *within* its own campaign -- Dead Water and Under
   * the Burning Suns both ship a `13_Epilogue` -- so the id alone cannot name the right file (a real bug,
   * found 2026-09-27: one campaign's build was silently clobbering the other's).
   */
  assetDir: string;
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
  /** A synthetic debug campaign: kept and playable, but listed apart from the real ones. */
  debug?: boolean;
  /** `[campaign] rank=`: the order upstream lists campaigns in (lowest first). */
  rank?: number;
  /** Image paths from `[campaign]` (image path functions intact): list `icon`, description `image`, dialog `background`. */
  icon?: string;
  image?: string;
  background?: string;
  /** Dates for the Timeline sort: `year`, or `startYear` (and `endYear`), e.g. `501 YW`. */
  year?: string;
  startYear?: string;
  endYear?: string;
  /** `[campaign] description_alignment=`. */
  descriptionAlignment?: string;
  /** `[difficulty]` blocks in file order (easiest first); absent for a campaign with no difficulty choice. */
  difficulties?: readonly CampaignDifficulty[];
}

/** One `[difficulty]` of a campaign. `define` is the preprocessor symbol (`EASY`, `HARD`, ...) its scenarios are built with. */
export interface CampaignDifficulty {
  define: string;
  label: TString;
  description: TString;
  image?: string;
  default?: boolean;
  /** `auto_markup=no`: the description is shown as written, not wrapped in grey parentheses. */
  autoMarkup?: boolean;
}

/** The difficulty a campaign starts at when none is chosen (`default=yes`, else the first); undefined without difficulties. */
export function defaultDifficulty(campaign: CampaignInfo | null | undefined): string | undefined {
  const all = campaign?.difficulties;
  if (!all || all.length === 0) return undefined;
  return (all.find((d) => d.default) ?? all[0]!).define;
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
