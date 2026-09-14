import { describe, expect, it } from 'vitest';
import { pickStoryImage, type StoryImageEntry } from './storyImages.js';

const background: StoryImageEntry = {
  src: 'core/images/maps/background.webp',
  w: 4096,
  h: 2160,
  bytes: 4_507_208,
  variants: [
    { src: 'core/images/maps/background.w960.webp', w: 960, h: 506, bytes: 135_468 },
    { src: 'core/images/maps/background.w1920.webp', w: 1920, h: 1013, bytes: 740_144 },
  ],
};

const deadWaterMap: StoryImageEntry = {
  src: 'campaigns/Dead_Water/images/maps/dw.webp',
  w: 1280,
  h: 960,
  bytes: 1_492_606,
  variants: [
    { src: 'campaigns/Dead_Water/images/maps/dw.w960.webp', w: 960, h: 720, bytes: 124_548 },
    { src: 'campaigns/Dead_Water/images/maps/dw.w1280.webp', w: 1280, h: 960, bytes: 200_000 },
  ],
};

describe('pickStoryImage', () => {
  it('picks the narrowest copy covering the drawn width', () => {
    expect(pickStoryImage(background, 900).url).toBe('/derived-images/core/images/maps/background.w960.webp');
    expect(pickStoryImage(background, 1200).url).toBe('/derived-images/core/images/maps/background.w1920.webp');
  });

  it('accounts for device pixel ratio', () => {
    expect(pickStoryImage(background, 900, 2).url).toBe('/derived-images/core/images/maps/background.w1920.webp');
  });

  it('uses the original when only it is wide enough', () => {
    expect(pickStoryImage(background, 2560).url).toBe('/game-images/core/images/maps/background.webp');
  });

  it('prefers a smaller full-width re-encode over the original when the image is drawn wider than it is', () => {
    // 1920x1080 viewport, scale_vertically: dw.webp is drawn 1440 px wide, wider than any copy.
    expect(pickStoryImage(deadWaterMap, 1440)).toEqual({ url: '/derived-images/campaigns/Dead_Water/images/maps/dw.w1280.webp', bytes: 200_000 });
  });

  it('serves small images with no variants from the originals', () => {
    const dot: StoryImageEntry = { src: 'core/images/misc/new-battle.png', w: 30, h: 30, bytes: 578, variants: [] };
    expect(pickStoryImage(dot, 30).url).toBe('/game-images/core/images/misc/new-battle.png');
  });
});
