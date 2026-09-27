/**
 * The campaign manifest (`public/campaigns.json`, built by `apps/web/scripts/build-campaigns.mjs`): what
 * the menu lists and what the play page resolves a campaign id into a first scenario to fetch.
 */
import { TString, type TStringJson } from '@wesnothweb2/engine';
import type { CampaignDifficulty, CampaignInfo } from './save/campaign.js';

export interface Campaign extends CampaignInfo {
  /** The name and description as translatable strings, for showing to the player. */
  nameT: TString;
  descriptionT: TString;
  /** The scenario id (matches a `public/scenarios/<id>.json` file) this campaign starts on. */
  firstScenario: string;
}

type Text = string | TStringJson;
interface CampaignJson extends Omit<Campaign, 'name' | 'description' | 'nameT' | 'descriptionT' | 'difficulties'> {
  name: Text;
  description: Text;
  difficulties?: Array<Omit<CampaignDifficulty, 'label' | 'description'> & { label: Text; description: Text }>;
}

const text = (v: Text): TString => (typeof v === 'string' ? TString.literal(v) : TString.fromJSON(v));

/** `campaigns.json` parsed: names and descriptions as `TString`s (read when drawn, so a language switch updates them). */
export function parseCampaigns(data: { campaigns: CampaignJson[] }): Campaign[] {
  return data.campaigns.map((c) => {
    const nameT = text(c.name);
    const descriptionT = text(c.description);
    return {
      ...c,
      name: nameT.baseStr(),
      description: descriptionT.baseStr(),
      nameT,
      descriptionT,
      difficulties: c.difficulties?.map((d) => ({ ...d, label: text(d.label), description: text(d.description) })),
    };
  });
}

export async function fetchCampaigns(): Promise<Campaign[]> {
  const res = await fetch('/campaigns.json');
  if (!res.ok) throw new Error(`fetch campaigns.json: ${res.status}`);
  return parseCampaigns((await res.json()) as { campaigns: CampaignJson[] });
}
