import { describe, expect, it } from 'vitest';
import {
  baseOverlayImages,
  defaultAssetExists,
  fogShroudTransitionImages,
  hexOverlayImages,
  pickVariant,
} from '../src/fogShroud.js';
import type { HexVisibility } from '../src/fogShroud.js';

const CLEAR6: HexVisibility[] = ['clear', 'clear', 'clear', 'clear', 'clear', 'clear'];

describe('pickVariant', () => {
  it('picks a stable member by (x+y) parity', () => {
    expect(pickVariant(['a', 'b', 'c'], 0, 0)).toBe('a');
    expect(pickVariant(['a', 'b', 'c'], 1, 0)).toBe('b');
    expect(pickVariant(['a', 'b', 'c'], -1, 0)).toBe('b');
  });
});

describe('baseOverlayImages', () => {
  it('is empty for a clear hex', () => {
    expect(baseOverlayImages('clear', 0, 0)).toEqual([]);
  });
  it('covers a shrouded hex with void.png', () => {
    expect(baseOverlayImages('shrouded', 3, 4)).toEqual(['terrain/void/void.png']);
  });
  it('covers a fogged hex with one of the three fog variants', () => {
    expect(baseOverlayImages('fogged', 0, 0)[0]).toMatch(/^terrain\/fog\/fog[123]\.png$/);
  });
});

describe('fogShroudTransitionImages', () => {
  it('draws nothing when every neighbour is clear', () => {
    expect(fogShroudTransitionImages(CLEAR6, defaultAssetExists)).toEqual([]);
  });

  it('draws a single-direction fog fade for one fogged neighbour', () => {
    const neighbors: HexVisibility[] = ['fogged', 'clear', 'clear', 'clear', 'clear', 'clear'];
    expect(fogShroudTransitionImages(neighbors, defaultAssetExists)).toEqual(['terrain/fog/fog-n.png']);
  });

  it('combines two consecutive fogged directions into one filename', () => {
    const neighbors: HexVisibility[] = ['fog', 'fog', 'clear', 'clear', 'clear', 'clear'].map((v) =>
      v === 'fog' ? 'fogged' : 'clear',
    ) as HexVisibility[];
    expect(fogShroudTransitionImages(neighbors, defaultAssetExists)).toEqual(['terrain/fog/fog-n-ne.png']);
  });

  it('falls back to -all.png when every neighbour matches and the asset exists (fog only)', () => {
    const allFog: HexVisibility[] = ['fogged', 'fogged', 'fogged', 'fogged', 'fogged', 'fogged'];
    expect(fogShroudTransitionImages(allFog, defaultAssetExists)).toEqual(['terrain/fog/fog-all.png']);
  });

  it('a fully shroud-surrounded hex repeats overlapping runs up to the 6-iteration cap (real upstream quirk, no void-all.png exists to short-circuit it)', () => {
    const allShroud: HexVisibility[] = ['shrouded', 'shrouded', 'shrouded', 'shrouded', 'shrouded', 'shrouded'];
    // Every 3-direction run upstream's asset set defines for void tops out
    // before completing the full ring, so the frontier index never lands
    // back on `start` and the algorithm's hard per-visibility iteration
    // cap (6, mirroring `cap1 != 6`) is what actually stops it -- here
    // that means the same two 3-direction images drawn three times over.
    // Harmless (fully opaque, redundant overlap), but real: this is
    // exactly what the ported C++ does too, not a bug introduced here.
    expect(fogShroudTransitionImages(allShroud, defaultAssetExists)).toEqual([
      'terrain/void/void-ne-se-s.png',
      'terrain/void/void-sw-nw-n.png',
      'terrain/void/void-ne-se-s.png',
      'terrain/void/void-sw-nw-n.png',
      'terrain/void/void-ne-se-s.png',
      'terrain/void/void-sw-nw-n.png',
    ]);
  });

  it('draws both fog and shroud transitions when both are present', () => {
    const mixed: HexVisibility[] = ['fogged', 'clear', 'clear', 'shrouded', 'clear', 'clear'];
    expect(fogShroudTransitionImages(mixed, defaultAssetExists)).toEqual(['terrain/fog/fog-n.png', 'terrain/void/void-s.png']);
  });

  it('stops extending a run at the first missing asset, and separately re-collects the leftover neighbour', () => {
    // fog-n-ne-se-s-sw.png doesn't exist in the real set (max run is 4), so
    // the 5-consecutive-direction fogged run yields the longest valid
    // prefix (n-ne-se-s) as one image; the "sw" neighbour that couldn't
    // extend it is picked up as its own separate 1-direction image on the
    // next outer-loop pass, exactly as the ported algorithm does upstream.
    const neighbors: HexVisibility[] = ['fogged', 'fogged', 'fogged', 'fogged', 'fogged', 'clear'];
    expect(fogShroudTransitionImages(neighbors, defaultAssetExists)).toEqual(['terrain/fog/fog-n-ne-se-s.png', 'terrain/fog/fog-sw.png']);
  });
});

describe('hexOverlayImages', () => {
  it('for a shrouded hex, returns only the base cover (no transitions -- nothing to fade into)', () => {
    const neighbors: HexVisibility[] = ['clear', 'clear', 'clear', 'clear', 'clear', 'clear'];
    expect(hexOverlayImages(0, 0, 'shrouded', neighbors, defaultAssetExists)).toEqual(['terrain/void/void.png']);
  });

  it('for a fogged hex, returns the base cover plus any transitions to more-hidden neighbours', () => {
    const neighbors: HexVisibility[] = ['shrouded', 'clear', 'clear', 'clear', 'clear', 'clear'];
    const result = hexOverlayImages(0, 0, 'fogged', neighbors, defaultAssetExists);
    expect(result[0]).toMatch(/^terrain\/fog\/fog[123]\.png$/);
    expect(result[1]).toBe('terrain/void/void-n.png');
  });

  it('for a clear hex, returns only transitions (no base cover)', () => {
    const neighbors: HexVisibility[] = ['fogged', 'clear', 'clear', 'clear', 'clear', 'clear'];
    expect(hexOverlayImages(0, 0, 'clear', neighbors, defaultAssetExists)).toEqual(['terrain/fog/fog-n.png']);
  });
});
