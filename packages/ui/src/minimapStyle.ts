/**
 * Phase 22: the minimap's look (`MinimapStyle`), from data the game already ships -- kept apart
 * from the component so it is testable in node:
 *
 *  - terrain images: each `[terrain_type]`'s `symbol_image` (`terrain_type::minimap_image`), as
 *    `terrain/<symbol_image>.png`. A combined `Base^Overlay` code that is not a terrain type of its
 *    own takes the base's image and the overlay's (`terrain_type(base, overlay)`).
 *  - colour coding: the colour range named by the terrain's id, and by each underlying terrain's
 *    (`team_rgb_range`, which holds terrain ranges -- "cave", "reef", ... -- next to team colours).
 *  - side colours: `team::get_minimap_color`, the side's colour range `rep`.
 *  - orb colours: the player's orb preferences (Phase 20) plus upstream's ally/enemy defaults.
 */
import type { ColorData, MinimapRgb, MinimapStyle } from '@wesnothweb2/renderer';

type WmlJson = { attrs?: Record<string, unknown> };

export interface MinimapStyleSources {
  /** Every `[terrain_type]`, as the snapshot ships them (`terrainTypeConfigs`). */
  terrainTypeConfigs: readonly WmlJson[];
  /** Team and terrain colour ranges (`/team-colors.json`), or null before they load. */
  colors: ColorData | null;
  /** Side number -> colour range id (a side's resolved `color=`). */
  sideColorId(side: number): string;
  /** Colour range ids of the three own-unit orb states (the Phase 20 preferences). */
  orbColorIds: Readonly<Record<'unmoved' | 'partial' | 'moved', string>>;
  /** The terrain type behind a code: its id and its underlying terrains' codes (`union_type`), for colour coding. */
  terrainInfo(code: string): { id: string; unionType: readonly string[] } | null;
}

/** Upstream's `ally_orb_color` / `enemy_orb_color` defaults (`data/game_config.cfg`). */
const ALLY_ORB = 'lightblue';
const ENEMY_ORB = 'black';
const FALLBACK: MinimapRgb = [128, 128, 128];

export function createMinimapStyle(src: MinimapStyleSources): MinimapStyle {
  const symbolByCode = new Map<string, string>();
  for (const cfg of src.terrainTypeConfigs) {
    const code = cfg.attrs?.['string'];
    const symbol = cfg.attrs?.['symbol_image'];
    if (typeof code === 'string' && typeof symbol === 'string' && symbol !== '') symbolByCode.set(code, symbol);
  }
  const image = (symbol: string | undefined): string | null => (symbol ? `terrain/${symbol}.png` : null);
  const ranges = src.colors?.ranges ?? {};
  const rep = (id: string): MinimapRgb | null => ranges[id]?.rep ?? null;

  return {
    terrainImages(code) {
      const own = symbolByCode.get(code);
      if (own) return { base: image(own), overlay: null };
      const caret = code.indexOf('^');
      if (caret < 0) return { base: null, overlay: null };
      return { base: image(symbolByCode.get(code.slice(0, caret))), overlay: image(symbolByCode.get(code.slice(caret))) };
    },
    terrainColors(code) {
      const info = src.terrainInfo(code);
      if (!info) return { own: null, underlying: null };
      const underlying: MinimapRgb[] = [];
      for (const u of info.unionType) {
        const id = src.terrainInfo(u)?.id;
        const color = id ? rep(id) : null;
        if (!color) return { own: rep(info.id), underlying: null };
        underlying.push(color);
      }
      return { own: rep(info.id), underlying };
    },
    sideColor: (side) => rep(src.sideColorId(side)) ?? FALLBACK,
    orbColors: {
      unmoved: rep(src.orbColorIds.unmoved) ?? [0, 255, 0],
      partial: rep(src.orbColorIds.partial) ?? [255, 165, 0],
      moved: rep(src.orbColorIds.moved) ?? [255, 0, 0],
      ally: rep(ALLY_ORB) ?? [0, 128, 255],
      enemy: rep(ENEMY_ORB) ?? [0, 0, 0],
    },
    unownedVillage: ranges['white']?.min ?? [255, 255, 255],
  };
}
