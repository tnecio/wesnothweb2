/**
 * Phase 18: map items' image lookup and halo frames.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rootedImagePath, setCampaignImages } from '../src/images/compositor.js';
import { parseHaloFrames } from '../src/mapItems.js';

describe("campaign images searched before core (the campaign's [binary_path])", () => {
  afterEach(() => setCampaignImages(null));

  it('a path the campaign has resolves into it, modifiers kept; others stay core', () => {
    setCampaignImages('campaigns/Dead_Water/images', ['items/storm-trident-buried.png']);
    expect(rootedImagePath('items/storm-trident-buried.png')).toBe('campaigns/Dead_Water/images/items/storm-trident-buried.png');
    expect(rootedImagePath('items/storm-trident-buried.png~FL(horiz)')).toBe('campaigns/Dead_Water/images/items/storm-trident-buried.png~FL(horiz)');
    expect(rootedImagePath('items/chest.png')).toBe('core/images/items/chest.png');
    setCampaignImages(null);
    expect(rootedImagePath('items/storm-trident-buried.png')).toBe('core/images/items/storm-trident-buried.png');
  });
});

describe('parseHaloFrames (halo.cpp)', () => {
  it('splits frames, 100 ms unless given, and expands [a~b] ranges', () => {
    expect(parseHaloFrames('halo/fire-aura.png')).toEqual([{ image: 'halo/fire-aura.png', durationMs: 100 }]);
    expect(parseHaloFrames('halo/a.png:50,halo/b.png')).toEqual([
      { image: 'halo/a.png', durationMs: 50 },
      { image: 'halo/b.png', durationMs: 100 },
    ]);
    expect(parseHaloFrames('halo/f[1~3].png:75').map((f) => f.image)).toEqual(['halo/f1.png', 'halo/f2.png', 'halo/f3.png']);
  });
});
