/**
 * Phase 16 N2: the story screen's per-scenario asset table
 * (`apps/web/public/story/<id>.json`, built by
 * `apps/web/scripts/build-story-assets.mjs`) and picking the right-sized
 * copy of each image.
 */
import type { WmlConfigJson } from '@wesnothweb2/engine';

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
}

export interface StoryAssets {
  readonly scenarioId: string;
  readonly scenarioName: string;
  /** The scenario's `[story]` configs, in order. */
  readonly story: readonly WmlConfigJson[];
  /** Keyed by the image path as written in WML. */
  readonly images: Readonly<Record<string, StoryImageEntry>>;
}

export interface PickedImage {
  readonly url: string;
  readonly bytes: number;
}

export const GAME_IMAGES_BASE = '/game-images';
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
