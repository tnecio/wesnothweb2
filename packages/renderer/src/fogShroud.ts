/**
 * Fog/shroud hex overlay image selection: a TS port of
 * `display::get_fog_shroud_images` (src/display.cpp) plus the base
 * covering-image choice from `display::draw_hex` (the `get_variant`
 * lambda over `shroud_images_`/`fog_images_`).
 *
 * A hex's overlay is:
 *  - if shrouded or fogged: one base image fully covering the hex, picked
 *    by a simple positional "noise" function so adjacent hexes don't all
 *    show the exact same fog texture (`void.png` for shroud; one of
 *    `fog1.png`/`fog2.png`/`fog3.png` for fog).
 *  - if NOT shrouded (clear or merely fogged): directional transition
 *    images layered on top for each contiguous run of shrouded/fogged
 *    neighbours, so the edge of what you can see fades smoothly instead
 *    of cutting off hard. `display::draw_hex` calls this only when the
 *    hex itself isn't shrouded (a shrouded hex has no terrain, and no
 *    daylight peeking through, to fade into).
 *
 * NOT ported: the debug-only "-all"/full-surround special-case fallback
 * search order quirks beyond the one exact rule upstream documents
 * (try `-all.png`; if missing, fall back to the direction-walk from
 * index 0) -- this project's real asset set only defines `fog-all.png`
 * (no `void-all.png`), matching what's implemented here.
 */

/** Mirrors upstream's `visibility` enum ordering (`FOG = 0, SHROUD = 1, CLEAR = 2`). */
export type HexVisibility = 'shrouded' | 'fogged' | 'clear';

/** One hex's shroud/fog state, as fed to `SnapshotBoard.updateFogShroud`. */
export interface FogShroudHex {
  x: number;
  y: number;
  visibility: HexVisibility;
}

/** The 6 hex directions in upstream's `map_location::direction` order, used for both neighbour indexing and filename suffixes. */
export const HEX_DIRECTIONS = ['n', 'ne', 'se', 's', 'sw', 'nw'] as const;
export type HexDirection = (typeof HEX_DIRECTIONS)[number];

export const SHROUD_BASE_IMAGES = ['terrain/void/void.png'] as const;
export const FOG_BASE_IMAGES = ['terrain/fog/fog1.png', 'terrain/fog/fog2.png', 'terrain/fog/fog3.png'] as const;

/** Mirrors the `get_variant` lambda: picks a stable pseudo-random member of `variants` from a hex's own coordinates. */
export function pickVariant<T>(variants: readonly T[], x: number, y: number): T {
  const idx = Math.abs(x + y) % variants.length;
  return variants[idx]!;
}

/** The base image(s) covering an entire shrouded or fogged hex; empty for a clear hex. */
export function baseOverlayImages(visibility: HexVisibility, x: number, y: number): string[] {
  if (visibility === 'shrouded') return [pickVariant(SHROUD_BASE_IMAGES, x, y)];
  if (visibility === 'fogged') return [pickVariant(FOG_BASE_IMAGES, x, y)];
  return [];
}

/**
 * Mirrors `get_fog_shroud_images`: directional transition images fading
 * into `neighbors`' shroud/fog, layered onto a hex that is itself NOT
 * shrouded. `exists` checks whether a given transition asset is a real
 * file (this project's real fog/void art doesn't define every possible
 * direction combination) -- pass `DEFAULT_FOG_SHROUD_ASSETS.has`, or a
 * caller-supplied set for testing.
 */
export function fogShroudTransitionImages(neighbors: readonly HexVisibility[], exists: (name: string) => boolean): string[] {
  const tiles = neighbors.map((v) => (v === 'shrouded' ? 'shroud' : v === 'fogged' ? 'fog' : 'clear') as 'shroud' | 'fog' | 'clear');
  const names: string[] = [];

  for (const v of ['fog', 'shroud'] as const) {
    const prefix = v === 'fog' ? 'terrain/fog/fog' : 'terrain/void/void';

    let start = 0;
    while (start < 6 && tiles[start] === v) start++;
    if (start === 6) {
      const allName = `${prefix}-all.png`;
      if (exists(allName)) {
        names.push(allName);
        continue;
      }
      start = 0;
    }

    let i = (start + 1) % 6;
    let cap1 = 0;
    while (i !== start && cap1 !== 6) {
      if (tiles[i] === v) {
        let stream = prefix;
        let name = '';
        let cap2 = 0;
        while (v === tiles[i] && cap2 !== 6) {
          stream += `-${HEX_DIRECTIONS[i]}`;
          if (!exists(`${stream}.png`)) {
            if (name === '') i = (i + 1) % 6;
            break;
          }
          name = stream;
          i = (i + 1) % 6;
          cap2++;
        }
        if (name !== '') names.push(`${name}.png`);
      } else {
        i = (i + 1) % 6;
      }
      cap1++;
    }
  }

  return names;
}

/** The full overlay (base cover, then transitions) for one hex -- what a renderer should blit, in order, on top of terrain. */
export function hexOverlayImages(
  x: number,
  y: number,
  visibility: HexVisibility,
  neighbors: readonly HexVisibility[],
  exists: (name: string) => boolean,
): string[] {
  const base = baseOverlayImages(visibility, x, y);
  if (visibility === 'shrouded') return base;
  return [...base, ...fogShroudTransitionImages(neighbors, exists)];
}

/**
 * The real transition asset filenames this project ships under
 * `core/images/terrain/{fog,void}/` (from `wesnoth/data/core/images/
 * terrain/{fog,void}/`), used as the default `exists` predicate --
 * avoids a filesystem/network probe per hex per direction-combination
 * attempt.
 */
export const DEFAULT_FOG_SHROUD_ASSETS: ReadonlySet<string> = new Set([
  'terrain/fog/fog-all.png',
  'terrain/fog/fog-n-ne-se-s.png',
  'terrain/fog/fog-n-ne-se.png',
  'terrain/fog/fog-n-ne.png',
  'terrain/fog/fog-n.png',
  'terrain/fog/fog-ne-se-s.png',
  'terrain/fog/fog-ne-se.png',
  'terrain/fog/fog-ne.png',
  'terrain/fog/fog-nw-n-ne.png',
  'terrain/fog/fog-nw-n.png',
  'terrain/fog/fog-nw.png',
  'terrain/fog/fog-s-sw-nw-n.png',
  'terrain/fog/fog-s-sw-nw.png',
  'terrain/fog/fog-s-sw.png',
  'terrain/fog/fog-s.png',
  'terrain/fog/fog-se-s-sw.png',
  'terrain/fog/fog-se-s.png',
  'terrain/fog/fog-se.png',
  'terrain/fog/fog-sw-nw-n.png',
  'terrain/fog/fog-sw-nw.png',
  'terrain/fog/fog-sw.png',
  'terrain/void/void-n-ne-se.png',
  'terrain/void/void-n-ne.png',
  'terrain/void/void-n.png',
  'terrain/void/void-ne-se-s.png',
  'terrain/void/void-ne-se.png',
  'terrain/void/void-ne.png',
  'terrain/void/void-nw-n-ne.png',
  'terrain/void/void-nw-n.png',
  'terrain/void/void-nw.png',
  'terrain/void/void-s-sw-nw.png',
  'terrain/void/void-s-sw.png',
  'terrain/void/void-s.png',
  'terrain/void/void-se-s-sw.png',
  'terrain/void/void-se-s.png',
  'terrain/void/void-se.png',
  'terrain/void/void-sw-nw-n.png',
  'terrain/void/void-sw-nw.png',
  'terrain/void/void-sw.png',
]);

export function defaultAssetExists(name: string): boolean {
  return DEFAULT_FOG_SHROUD_ASSETS.has(name);
}
