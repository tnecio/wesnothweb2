import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ColorData } from '@wesnothweb2/renderer';
import { createMinimapStyle } from './minimapStyle.js';

const root = new URL('../../../', import.meta.url);
const snapshot = JSON.parse(readFileSync(new URL('apps/web/public/scenarios/Dead_Water/01_Invasion.json', root), 'utf8')) as {
  terrainTypeConfigs: { attrs: Record<string, unknown> }[];
};
const colors = JSON.parse(readFileSync(new URL('apps/web/public/team-colors.json', root), 'utf8')) as ColorData;

const style = createMinimapStyle({
  terrainTypeConfigs: snapshot.terrainTypeConfigs,
  colors,
  sideColorId: (side) => colors.defaultColors[side - 1] ?? 'red',
  orbColorIds: { unmoved: 'brightgreen', partial: 'brightorange', moved: 'red' },
  terrainInfo: (code) => (code === 'Rr' ? { id: 'road', unionType: ['Rr'] } : code === 'Uu' ? { id: 'cave', unionType: ['Uu'] } : null),
});

describe('createMinimapStyle (real terrain and colour data)', () => {
  it('uses a terrain type\'s own symbol_image', () => {
    expect(style.terrainImages('Wot')).toEqual({ base: 'terrain/water/ocean-tropical-tile.png', overlay: null });
    expect(style.terrainImages('Xv')).toEqual({ base: 'terrain/void/void.png', overlay: null });
  });

  it('draws a combined code as its base\'s image under its overlay\'s', () => {
    expect(style.terrainImages('Dd^Vdt')).toEqual({ base: 'terrain/sand/desert.png', overlay: 'terrain/village/desert-camp-tile.png' });
  });

  it('has nothing for an unknown code', () => {
    expect(style.terrainImages('Zz').base).toBeNull();
  });

  it('gives each side its colour range\'s rep, and villages without owner the white range\'s min', () => {
    expect(style.sideColor(1)).toEqual(colors.ranges['red']!.rep);
    expect(style.sideColor(2)).toEqual(colors.ranges['blue']!.rep);
    expect(style.unownedVillage).toEqual(colors.ranges['white']!.min);
  });

  it('uses upstream\'s ally (lightblue) and enemy (black) orb ranges', () => {
    expect(style.orbColors.ally).toEqual(colors.ranges['lightblue']!.rep);
    expect(style.orbColors.enemy).toEqual(colors.ranges['black']!.rep);
  });

  it('colour-codes by terrain-id ranges, and gives up on a terrain with none', () => {
    expect(style.terrainColors('Uu').underlying).toEqual([colors.ranges['cave']!.rep]);
    expect(style.terrainColors('Rr').underlying).toBeNull(); // no "road" range
  });
});
