/**
 * Phase 18: map items' image lookup and halo frames.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rootedImagePath, setCampaignImages, setEngineImages } from '../src/images/compositor.js';
import { parseHaloFrames } from '../src/mapItems.js';

describe("campaign images searched before core (the campaign's [binary_path])", () => {
  afterEach(() => setCampaignImages([]));

  it('a path the campaign has resolves into it, modifiers kept; others stay core', () => {
    setCampaignImages([{ root: 'campaigns/Dead_Water/images', files: ['items/storm-trident-buried.png'] }]);
    expect(rootedImagePath('items/storm-trident-buried.png')).toBe('campaigns/Dead_Water/images/items/storm-trident-buried.png');
    expect(rootedImagePath('items/storm-trident-buried.png~FL(horiz)')).toBe('campaigns/Dead_Water/images/items/storm-trident-buried.png~FL(horiz)');
    expect(rootedImagePath('items/chest.png')).toBe('core/images/items/chest.png');
    setCampaignImages([]);
    expect(rootedImagePath('items/storm-trident-buried.png')).toBe('core/images/items/storm-trident-buried.png');
  });
});

describe("engine-only images searched last (the game root's images/)", () => {
  afterEach(() => {
    setCampaignImages([]);
    setEngineImages([]);
  });

  it('a path only the engine has resolves to engine/, after the campaign; others stay core', () => {
    setEngineImages(['misc/tod-bright.png', 'misc/unit-marker.png']);
    expect(rootedImagePath('misc/tod-bright.png')).toBe('engine/misc/tod-bright.png');
    expect(rootedImagePath('misc/unit-marker.png~O(0.5)')).toBe('engine/misc/unit-marker.png~O(0.5)');
    expect(rootedImagePath('items/chest.png')).toBe('core/images/items/chest.png');
    setCampaignImages([{ root: 'campaigns/X/images', files: ['misc/unit-marker.png'] }]);
    expect(rootedImagePath('misc/unit-marker.png')).toBe('campaigns/X/images/misc/unit-marker.png');
  });

  it('a missing .png or .jpg is found as .webp, as load_image_file does (HttT 1 asks for a converted portrait)', () => {
    setCampaignImages([{ root: 'campaigns/Heir_To_The_Throne/images', files: ['portraits/delfador-elvish-unknown.webp'] }]);
    expect(rootedImagePath('portraits/delfador-elvish-unknown.png')).toBe('campaigns/Heir_To_The_Throne/images/portraits/delfador-elvish-unknown.webp');
    expect(rootedImagePath('portraits/delfador-elvish-unknown.jpg~FL()')).toBe('campaigns/Heir_To_The_Throne/images/portraits/delfador-elvish-unknown.webp~FL()');
    expect(rootedImagePath('portraits/other.png')).toBe('core/images/portraits/other.png');
  });

  it("searches each of the campaign's binary paths in order, and reads `a//b` as `a/b`", () => {
    setCampaignImages([
      { root: 'campaigns/The_Deceivers_Gambit/images', files: ['units/delfador/L3/delfador.png'] },
      { root: 'internal/Rogue_Mage/images', files: ['units/rogue-mage/rogue-mage.png', 'portraits/rogue-mage.webp'] },
    ]);
    expect(rootedImagePath('units/delfador/L3//delfador.png~RC(magenta>red)')).toBe('campaigns/The_Deceivers_Gambit/images/units/delfador/L3/delfador.png~RC(magenta>red)');
    expect(rootedImagePath('units/rogue-mage/rogue-mage.png')).toBe('internal/Rogue_Mage/images/units/rogue-mage/rogue-mage.png');
    expect(rootedImagePath('portraits/rogue-mage.png')).toBe('internal/Rogue_Mage/images/portraits/rogue-mage.webp');
    expect(rootedImagePath('internal/Rogue_Mage/images/portraits/rogue-mage.webp')).toBe('internal/Rogue_Mage/images/portraits/rogue-mage.webp');
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
