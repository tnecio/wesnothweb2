/**
 * The credits screen's text (`gui2::dialogs::end_credits::pre_show`, `about.cpp`): every credit group in order,
 * a campaign's own group first when the screen was opened for it, each with its header, its sections' titles
 * and their names. Pure; `credits.json` is built by `build-campaigns.mjs`.
 */
import { TString, type TStringJson } from '@wesnothweb2/engine';
import type { CampaignCredits } from '../story/storyImages.js';

export interface CreditsGroupJson {
  /** A campaign group's `[campaign] id=`. */
  id?: string;
  header?: string | TStringJson;
  sort?: boolean;
  images: string[];
  sections: { title: string | TStringJson; names: string[] }[];
}

export interface CreditsJson {
  /** Pictures the credits fall back to (`game_title_background`), as `data/...` paths. */
  backgrounds: string[];
  groups: CreditsGroupJson[];
}

export type CreditsLine = { kind: 'gap' } | { kind: 'header' | 'title' | 'name'; text: string };

const text = (v: string | TStringJson): TString => (typeof v === 'string' ? TString.literal(v) : TString.fromJSON(v));

/**
 * The lines to scroll. `translate` reads a `TString` (so a language switch re-translates); `compare` orders
 * the sections of a `sort=yes` group by their shown titles (`about_group::operator<`).
 */
export function creditsLines(
  data: CreditsJson,
  translate: (t: TString) => string,
  compare: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
  focusOn?: string,
): CreditsLine[] {
  const build = (group: CreditsGroupJson): CreditsLine[] => {
    const lines: CreditsLine[] = [{ kind: 'gap' }];
    const header = group.header === undefined ? '' : translate(text(group.header));
    if (header !== '') lines.push({ kind: 'header', text: header });
    const sections = group.sections.map((s) => ({ title: translate(text(s.title)), names: s.names }));
    if (group.sort) sections.sort((a, b) => compare(a.title, b.title));
    for (const s of sections) {
      lines.push({ kind: 'gap' }, { kind: 'title', text: s.title });
      for (const name of s.names) lines.push({ kind: 'name', text: name });
    }
    return lines;
  };
  const focused = data.groups.filter((g) => focusOn !== undefined && g.id === focusOn);
  const rest = data.groups.filter((g) => !focused.includes(g));
  return [...focused, ...rest].flatMap(build);
}

/** `about::get_background_images`: the focused campaign's own pictures, else the general ones. */
export function creditsBackground(data: CreditsJson, random: (max: number) => number, focusOn?: string): string | undefined {
  const own = data.groups.find((g) => focusOn !== undefined && g.id === focusOn)?.images ?? [];
  const pool = own.length > 0 ? own : data.backgrounds;
  return pool.length === 0 ? undefined : pool[random(pool.length - 1)];
}

/** `end_credits::key_press_callback`: Up doubles the scroll speed (up to 400), Down halves it (down to 50). */
export function changeScrollSpeed(speed: number, key: 'up' | 'down'): number {
  if (key === 'up' && speed < 400) return speed * 2;
  if (key === 'down' && speed > 50) return Math.floor(speed / 2);
  return speed;
}

export const DEFAULT_SCROLL_SPEED = 100;

/**
 * A campaign's own group as the outro shows it (`about::get_campaign_credits`): its translated name and each
 * section's title with its names. Undefined when the campaign has no credits group (a debug campaign).
 */
export function campaignCredits(data: CreditsJson, wesnothId: string | undefined, translate: (t: TString) => string): CampaignCredits | undefined {
  const group = wesnothId === undefined ? undefined : data.groups.find((g) => g.id === wesnothId);
  if (!group) return undefined;
  return {
    name: group.header === undefined ? '' : translate(text(group.header)),
    credits: group.sections.map((s) => ({ title: translate(text(s.title)), names: s.names })),
  };
}
