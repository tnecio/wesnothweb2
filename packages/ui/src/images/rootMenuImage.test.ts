import { describe, expect, it } from 'vitest';
import { rootMenuImage } from './rootMenuImage.js';

describe('rootMenuImage', () => {
  it('roots a data/ path relative to wesnoth/data', () => {
    expect(rootMenuImage('data/campaigns/Liberty/images/portraits/baldras.webp~SCALE(300,300)')).toBe('campaigns/Liberty/images/portraits/baldras.webp~SCALE(300,300)');
    expect(rootMenuImage('data/core/images/story/wesmere.webp')).toBe('core/images/story/wesmere.webp');
  });
  it('leaves an unrooted image search path alone', () => {
    expect(rootMenuImage('units/human-outlaws/fugitive.png~RC(magenta>red)')).toBe('units/human-outlaws/fugitive.png~RC(magenta>red)');
    expect(rootMenuImage('misc/laurel.png')).toBe('misc/laurel.png');
  });
  it('roots the image inside a BLIT too', () => {
    expect(rootMenuImage('engine/misc/laurel.png~BLIT(data/campaigns/X/images/a.png)~CROP(0,0,10,10)')).toBe(
      'engine/misc/laurel.png~BLIT(campaigns/X/images/a.png)~CROP(0,0,10,10)',
    );
  });
});
