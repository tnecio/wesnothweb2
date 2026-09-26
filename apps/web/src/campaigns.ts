/**
 * The campaign manifest (`public/campaigns.json`) -- what the menu page
 * lists and what the play page resolves a campaign id into a first
 * scenario to fetch. Deliberately tiny/flat: this project has no nested
 * campaign metadata (difficulty levels, images, `[campaign]` WML) yet, just
 * enough to pick one and find its entry-point scenario snapshot under
 * `public/scenarios/<id>.json`.
 */
import { TString, type TStringJson } from '@wesnothweb2/engine';

export interface Campaign {
  id: string;
  /** The English name (what a save file records). */
  name: string;
  /** The English description. */
  description: string;
  /** The name and description as translatable strings, for showing to the player. */
  nameT: TString;
  descriptionT: TString;
  /** The scenario id (matches a `public/scenarios/<id>.json` file) this campaign starts on. */
  firstScenario: string;
  /**
   * How real Wesnoth identifies this campaign, for save files that the
   * real game can open (Phase 26): `[campaign]`'s own `id=`, `abbrev=`
   * (the stem of every save name) and `define=` (the `#ifdef` flag
   * without which the game loads a save and then cannot find the
   * campaign's units). Absent for this project's synthetic debug
   * campaigns, which have no upstream counterpart.
   */
  wesnothId?: string;
  abbrev?: string;
  define?: string;
}

export async function fetchCampaigns(): Promise<Campaign[]> {
  const res = await fetch('/campaigns.json');
  if (!res.ok) throw new Error(`fetch campaigns.json: ${res.status}`);
  const data = (await res.json()) as { campaigns: Array<Omit<Campaign, 'name' | 'description' | 'nameT' | 'descriptionT'> & { name: string | TStringJson; description: string | TStringJson }> };
  const text = (v: string | TStringJson): TString => (typeof v === 'string' ? TString.literal(v) : TString.fromJSON(v));
  return data.campaigns.map((c) => {
    const nameT = text(c.name);
    const descriptionT = text(c.description);
    return { ...c, name: nameT.baseStr(), description: descriptionT.baseStr(), nameT, descriptionT };
  });
}
