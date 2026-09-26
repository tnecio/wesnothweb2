import { describe, expect, it } from 'vitest';
import { TString, type ResolvedStoryPart, type StoryBackgroundLayer, type StoryFloatingImage } from '@wesnothweb2/engine';
import { layoutBackgroundLayer, layoutStoryPart, titleOrigin } from './storyLayout.js';

function layer(over: Partial<StoryBackgroundLayer>): StoryBackgroundLayer {
  return { image: 'x.webp', scaleHorizontally: true, scaleVertically: true, tileHorizontally: false, tileVertically: false, keepAspectRatio: true, baseLayer: false, ...over };
}

function floating(over: Partial<StoryFloatingImage>): StoryFloatingImage {
  return { file: 'dot.png', x: 0, y: 0, delay: 0, resizeWithBackground: false, centered: false, ...over };
}

function part(backgroundLayers: StoryBackgroundLayer[], floatingImages: StoryFloatingImage[] = []): ResolvedStoryPart {
  return {
    showTitle: false,
    title: '',
    text: '',
    titleT: TString.literal(''),
    textT: TString.literal(''),
    textLayout: 'bottom',
    textAlignment: 'left',
    titleAlignment: 'left',
    titlePosition: { x: 0, y: 0 },
    music: '',
    sound: '',
    voice: '',
    backgroundLayers,
    floatingImages,
  };
}

/** Dead Water's journey map layers: scale_vertically=yes scale_horizontally=no keep_aspect_ratio=yes. */
const DW_FLAGS = { scaleVertically: true, scaleHorizontally: false, keepAspectRatio: true };

describe('layoutBackgroundLayer', () => {
  it('scales a vertically-scaled map to full height and centers it (dw.webp 1280x960 in 1920x1080)', () => {
    // h = height = 1080; w = min(1280 * 1080 / 960, 1920) = 1440; x = 960 - 720 = 240.
    expect(layoutBackgroundLayer(layer({ image: 'maps/dw.webp', ...DW_FLAGS }), { w: 1920, h: 1080 }, { w: 1280, h: 960 })).toEqual({
      image: 'maps/dw.webp',
      x: 240,
      y: 0,
      w: 1440,
      h: 1080,
      tile: false,
    });
  });

  it('clamps width to the viewport, squeezing the aspect ratio like upstream (background.webp 4096x2160)', () => {
    // w = min(4096 * 1080 / 2160 = 2048, 1920) = 1920.
    expect(layoutBackgroundLayer(layer({ ...DW_FLAGS }), { w: 1920, h: 1080 }, { w: 4096, h: 2160 })).toMatchObject({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('on a phone viewport clamps the map to the screen width (dw.webp in 390x844)', () => {
    // h = 844; w = min(trunc(1280 * 844 / 960) = 1125, 390) = 390.
    expect(layoutBackgroundLayer(layer({ ...DW_FLAGS }), { w: 390, h: 844 }, { w: 1280, h: 960 })).toMatchObject({ x: 0, y: 0, w: 390, h: 844 });
  });

  it('fits both axes by default (scale=yes, keep_aspect_ratio=yes)', () => {
    // h = min(trunc(700 * 1920 / 1000) = 1344, 1080) = 1080; w = min(trunc(1000 * 1080 / 700) = 1542, 1920) = 1542; x = 960 - 771 = 189.
    expect(layoutBackgroundLayer(layer({}), { w: 1920, h: 1080 }, { w: 1000, h: 700 })).toMatchObject({ x: 189, y: 0, w: 1542, h: 1080 });
  });

  it('leaves an unscaled image at its size, centered', () => {
    expect(layoutBackgroundLayer(layer({ scaleHorizontally: false, scaleVertically: false }), { w: 1920, h: 1080 }, { w: 1000, h: 700 })).toMatchObject({
      x: 460,
      y: 190,
      w: 1000,
      h: 700,
    });
  });

  it('stretches without keep_aspect_ratio', () => {
    expect(layoutBackgroundLayer(layer({ keepAspectRatio: false }), { w: 1920, h: 1080 }, { w: 1000, h: 700 })).toMatchObject({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('tiles across the full axis from the origin', () => {
    expect(
      layoutBackgroundLayer(layer({ scaleHorizontally: false, scaleVertically: false, tileHorizontally: true }), { w: 1920, h: 1080 }, { w: 64, h: 64 }),
    ).toEqual({ image: 'x.webp', x: 0, y: 508, w: 1920, h: 64, tile: true });
  });
});

describe('layoutStoryPart', () => {
  const sizes: Record<string, { w: number; h: number }> = {
    'maps/background.webp': { w: 4096, h: 2160 },
    'maps/dw.webp': { w: 1280, h: 960 },
    'misc/new-battle.png': { w: 30, h: 30 },
  };
  const sizeOf = (image: string) => sizes[image];

  it("places Dead Water's journey marker in base-layer coordinates", () => {
    const layout = layoutStoryPart(
      part(
        [layer({ image: '' }), layer({ image: 'maps/background.webp', ...DW_FLAGS }), layer({ image: 'maps/dw.webp', ...DW_FLAGS, baseLayer: true })],
        [floating({ file: 'misc/new-battle.png', x: 593, y: 740, delay: 500, centered: true })],
      ),
      { w: 1920, h: 1080 },
      sizeOf,
    );
    expect(layout.layers.map((l) => l.image)).toEqual(['maps/background.webp', 'maps/dw.webp']);
    expect(layout.base).toEqual({ scaleX: 1440 / 1280, scaleY: 1080 / 960, originX: 240, originY: 0 });
    // x = trunc(593 * 1.125) + 240 - 15 = 667 + 225 = 892; y = trunc(740 * 1.125) - 15 = 832 - 15 = 817.
    expect(layout.floating).toEqual([{ file: 'misc/new-battle.png', x: 892, y: 817, w: 30, h: 30, delay: 500 }]);
  });

  it('uses the first layer as base when none is marked, and identity when it draws nothing', () => {
    const withImage = layoutStoryPart(part([layer({ image: 'maps/dw.webp', ...DW_FLAGS })], [floating({ file: 'misc/new-battle.png', x: 100, y: 100 })]), { w: 1920, h: 1080 }, sizeOf);
    expect(withImage.floating[0]).toMatchObject({ x: 112 + 240, y: 112 });

    const empty = layoutStoryPart(part([layer({ image: '' }), layer({ image: 'maps/dw.webp', ...DW_FLAGS })], [floating({ file: 'misc/new-battle.png', x: 100, y: 100 })]), { w: 1920, h: 1080 }, sizeOf);
    expect(empty.base).toEqual({ scaleX: 1, scaleY: 1, originX: 0, originY: 0 });
    expect(empty.floating[0]).toMatchObject({ x: 100, y: 100 });
  });

  it('scales floating images with resize_with_background', () => {
    const layout = layoutStoryPart(
      part([layer({ image: 'maps/dw.webp', ...DW_FLAGS })], [floating({ file: 'misc/new-battle.png', x: 0, y: 0, resizeWithBackground: true, centered: true })]),
      { w: 1920, h: 1080 },
      sizeOf,
    );
    // w = h = trunc(30 * 1.125) = 33; centered offset 16.
    expect(layout.floating[0]).toEqual({ file: 'misc/new-battle.png', x: 240 - 16, y: -16, w: 33, h: 33, delay: 0 });
  });

  it('skips images whose size is unknown', () => {
    const layout = layoutStoryPart(part([layer({ image: 'missing.webp' })], [floating({ file: 'missing.png' })]), { w: 800, h: 600 }, sizeOf);
    expect(layout.layers).toEqual([]);
    expect(layout.floating).toEqual([]);
  });
});

describe('titleOrigin', () => {
  it('positions the title by percentage of the free space', () => {
    expect(titleOrigin({ x: 0, y: 0 }, { w: 1920, h: 1080 }, { w: 300, h: 40 })).toEqual({ x: 0, y: 0 });
    expect(titleOrigin({ x: 50, y: 50 }, { w: 1920, h: 1080 }, { w: 300, h: 40 })).toEqual({ x: 810, y: 520 });
    expect(titleOrigin({ x: 100, y: 100 }, { w: 1920, h: 1080 }, { w: 300, h: 40 })).toEqual({ x: 1620, y: 1040 });
    expect(titleOrigin({ x: 50, y: 0 }, { w: 200, h: 100 }, { w: 300, h: 40 })).toEqual({ x: 0, y: 0 });
  });
});
