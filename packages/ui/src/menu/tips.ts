/**
 * The title screen's tip of the day (`gui2::tip_of_the_day`). The source is deliberately a plain list of
 * translatable `{text, source}` pairs: for now it is upstream's own `data/tips.cfg` (`public/tips.json`,
 * built by `build-campaigns.mjs`), and what the port shows here is a decision still to make -- only this
 * loader would change.
 */
import { TString, type TStringJson } from '@wesnothweb2/engine';

export interface Tip {
  /** The tip, in Pango markup. */
  text: TString;
  /** Who it is attributed to, in Pango markup. */
  source: TString;
}

const text = (v: string | TStringJson): TString => (typeof v === 'string' ? TString.literal(v) : TString.fromJSON(v));

export function parseTips(data: { tips: { text: string | TStringJson; source: string | TStringJson }[] }): Tip[] {
  return data.tips.map((t) => ({ text: text(t.text), source: text(t.source) }));
}

export async function fetchTips(): Promise<Tip[]> {
  try {
    const res = await fetch('/tips.json');
    if (!res.ok) throw new Error(`${res.status}`);
    return parseTips((await res.json()) as Parameters<typeof parseTips>[0]);
  } catch (err) {
    console.warn('[menu] no tips:', err);
    return [];
  }
}

/** A shuffled copy (`tip_of_the_day::shuffle`): Fisher-Yates. */
export function shuffled<T>(list: readonly T[], random: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** `title_screen::update_tip`: the index after (or before) `index`, wrapping. */
export function stepTip(index: number, count: number, previous: boolean): number {
  if (count === 0) return 0;
  return previous ? (index <= 0 ? count - 1 : index - 1) : index + 1 >= count ? 0 : index + 1;
}
