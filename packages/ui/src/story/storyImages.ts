/**
 * Phase 16 N2: the story screen's per-scenario asset table
 * (`apps/web/public/story/<id>.json`, built by
 * `apps/web/scripts/build-story-assets.mjs`) and picking the right-sized
 * copy of each image.
 */
import type { WmlConfigJson } from '@wesnothweb2/engine';
import { GAME_IMAGES } from '../gameData.js';

export interface StoryImageVariant {
  /** Path under `/derived-images/`. */
  readonly src: string;
  readonly w: number;
  readonly h: number;
  readonly bytes: number;
}

export interface StoryImageEntry {
  /** Rooted path under `/game-images/` (the original file). */
  readonly src: string;
  readonly w: number;
  readonly h: number;
  readonly bytes: number;
  /** Re-encoded copies, narrowest first. */
  readonly variants: readonly StoryImageVariant[];
  /**
   * Translated twins, by resource language code (`get_localized_path`): a standalone replacement
   * (`image`) or an `overlay` drawn over this image (journey maps with place names in the language).
   */
  readonly localized?: Readonly<Record<string, { readonly image?: StoryImageEntry; readonly overlay?: StoryImageEntry }>>;
}

export interface StoryAssets {
  readonly scenarioId: string;
  readonly scenarioName: string;
  /** The scenario's `[story]` configs, in order. */
  readonly story: readonly WmlConfigJson[];
  /** Keyed by the image path as written in WML. */
  readonly images: Readonly<Record<string, StoryImageEntry>>;
}

export interface CampaignCredits {
  readonly name: string;
  readonly credits: readonly { readonly title: string; readonly names: readonly string[] }[];
}

export interface PickedImage {
  readonly url: string;
  readonly bytes: number;
}

/**
 * Fetches `/story/<campaignDir>/<scenarioId>.json` (`campaignDir` is a `CampaignInfo.assetDir` -- required,
 * not inferred from `scenarioId`, since a bare `[scenario] id=` is only unique within its own campaign).
 * Null when the scenario has no story (404, or the dev server's HTML fallback page) or the request fails --
 * the story still resolves from the snapshot, just without images.
 */
export async function fetchStoryAssets(scenarioId: string, campaignDir: string): Promise<StoryAssets | null> {
  try {
    const res = await fetch(`/story/${campaignDir}/${scenarioId}.json`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as StoryAssets;
  } catch {
    return null;
  }
}

export const GAME_IMAGES_BASE = GAME_IMAGES;
export const DERIVED_IMAGES_BASE = '/derived-images';

/**
 * The smallest copy at least `drawnWidth * devicePixelRatio` pixels wide,
 * or the widest available (original included) when nothing is that wide.
 * Among copies of equal usefulness the smaller file wins, so a re-encoded
 * full-width variant beats an uncompressed original.
 */
export function pickStoryImage(entry: StoryImageEntry, drawnWidth: number, devicePixelRatio = 1): PickedImage {
  const needed = Math.ceil(drawnWidth * devicePixelRatio);
  const candidates = [
    ...entry.variants.map((v) => ({ url: `${DERIVED_IMAGES_BASE}/${v.src}`, w: v.w, bytes: v.bytes })),
    { url: `${GAME_IMAGES_BASE}/${entry.src}`, w: entry.w, bytes: entry.bytes },
  ];
  const wideEnough = candidates.filter((c) => c.w >= needed);
  const pool = wideEnough.length > 0 ? wideEnough : candidates.filter((c) => c.w === Math.max(...candidates.map((x) => x.w)));
  const best = pool.reduce((a, b) => (b.w < a.w || (b.w === a.w && b.bytes < a.bytes) ? b : a));
  return { url: best.url, bytes: best.bytes };
}

/**
 * `get_localized_path` over the built table: for the first of `codes` (the language's own list, then
 * `en_US`) that has a localized twin, the standalone image replaces `entry`; an overlay is drawn over it.
 */
export function localizedEntry(entry: StoryImageEntry, codes: readonly string[]): { image: StoryImageEntry; overlay?: StoryImageEntry } {
  for (const code of codes) {
    const twin = entry.localized?.[code];
    if (twin?.image) return { image: twin.image };
    if (twin?.overlay) return { image: entry, overlay: twin.overlay };
  }
  return { image: entry };
}
