import { describe, expect, it } from 'vitest';
import { localizedEntry, type StoryImageEntry } from './storyImages';

const image = (src: string): StoryImageEntry => ({ src, w: 1280, h: 960, bytes: 1, variants: [] });

describe('localizedEntry (get_localized_path over the built table)', () => {
  const base: StoryImageEntry = {
    ...image('maps/dw.webp'),
    localized: { es: { overlay: image('l10n/es/dw--overlay.webp') }, it: { image: image('l10n/it/dw.webp') } },
  };

  it('draws an overlay over the original', () => {
    const r = localizedEntry(base, ['es', 'en_US']);
    expect(r.image).toBe(base);
    expect(r.overlay?.src).toBe('l10n/es/dw--overlay.webp');
  });

  it('a standalone twin replaces the original and takes no overlay', () => {
    const r = localizedEntry(base, ['it', 'en_US']);
    expect(r.image.src).toBe('l10n/it/dw.webp');
    expect(r.overlay).toBeUndefined();
  });

  it('honours the priority list, and falls back to the original', () => {
    expect(localizedEntry(base, ['fr', 'es', 'en_US']).overlay?.src).toBe('l10n/es/dw--overlay.webp');
    expect(localizedEntry(base, ['pl_PL', 'en_US'])).toEqual({ image: base });
    expect(localizedEntry({ ...base, localized: undefined }, ['es'])).toEqual({ image: { ...base, localized: undefined } });
  });
});
