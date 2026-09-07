/**
 * Renders a static scenario snapshot (see apps/web/scripts/build-scenario-
 * snapshot.mjs) as a PixiJS board: flat-coloured terrain hexes plus real
 * unit sprite art loaded through ImageCache/ipf.
 *
 * Deliberately NOT what Phase 4 (docs/IMPLEMENTATION_PLAN.md) means by
 * "rendering" -- there is no terrain image compositing/layering here (that
 * needs the terrain_graphics rule-matching system, out of scope until
 * Phase 4), no animation, no fog of war. This exists to prove two things
 * end-to-end in a real browser: (1) real WML-derived scenario data
 * (packages/engine) can drive (2) the fidelity-tested image pipeline
 * ported forward in Phase 0 (ipf.ts/ImageCache.ts) -- see the "vertical
 * slice" note in docs/PROGRESS.md for why this shortcut was taken instead
 * of waiting for full Phase 4.
 *
 * Coordinate reconciliation: packages/engine's Location uses 0-based (x,y)
 * where ODD x is the shifted-down column (see Location.ts's own doc
 * comment, verified against map_location.cpp). This module's hexGeometry.ts
 * uses 1-based (x,y) where EVEN x is shifted down. These are the SAME
 * convention: shifting from 0-based to 1-based flips odd<->even exactly
 * once, so `location.wmlX`/`wmlY` (Location's existing 1-based accessors)
 * are what hexGeometry.ts's HexCoord expects, with no further transform.
 * Do not feed it `location.x`/`location.y` directly -- half the columns
 * will render on the wrong row.
 */

import * as PIXI from 'pixi.js';
import { hexCorners, hexToPixel, type HexCoord } from './hexGeometry.js';
import { ImageCache, setImageBaseUrl } from './images/ImageCache.js';

export interface SnapshotTerrainHex {
  x: number; // engine-convention 0-based
  y: number;
  code: string; // e.g. "Gg", "Wot", "Hd^Fds" -- see Terrain.ts's writeTerrainCode
}

export interface SnapshotUnit {
  id: string | null;
  name: string | null;
  typeId: string;
  image: string | null;
  side: number;
  x: number; // engine-convention 0-based
  y: number;
  canRecruit: boolean;
  hitpoints: number;
  maxHitpoints: number;
}

export interface SnapshotTeam {
  side: number;
  controller: string;
  gold: number;
  teamName: string;
  color: string;
}

export interface ScenarioSnapshot {
  scenario: { id: string; name: string };
  map: { width: number; height: number };
  terrain: SnapshotTerrainHex[];
  teams: SnapshotTeam[];
  units: SnapshotUnit[];
}

/** 0-based engine (x,y) -> 1-based renderer HexCoord -- see module doc comment. */
function toHexCoord(x: number, y: number): HexCoord {
  return { x: x + 1, y: y + 1 };
}

/**
 * Approximate terrain base-code -> fill colour. Real terrain rendering
 * (Phase 4) resolves an image per terrain via terrain_graphics rules; this
 * is a presentational placeholder standing in for that, keyed on the first
 * letter(s) of the terrain code's base (before any `^overlay`).
 */
const TERRAIN_COLORS: Record<string, number> = {
  G: 0x4a7c3f, // grass
  D: 0xc9a86a, // desert/sand
  H: 0x8a7355, // hills
  M: 0x6e6a63, // mountains
  W: 0x2f6fa3, // water (shallow/deep alike)
  F: 0x2d5a2d, // forest base (rare as a base code; usually an overlay)
  C: 0x8a8a8a, // castle
  K: 0xa08a5a, // keep
  U: 0x4a4a4a, // underground/cave floor
  X: 0x333333, // cave wall
  R: 0x9a8a6a, // road
  S: 0x9c8a5a, // swamp/sand variants
  I: 0xdfeaf5, // ice/snow
  A: 0x2a2a2a, // off-map / void
  _: 0x2a2a2a,
};

function colorForTerrain(code: string): number {
  const base = code.split('^')[0] ?? code;
  const letter = base.replace(/^_/, '_').charAt(0).toUpperCase();
  return TERRAIN_COLORS[letter] ?? 0x555555;
}

export interface SnapshotBoardOptions {
  /** Base URL images are served from (see ImageCache.setImageBaseUrl). */
  imageBaseUrl?: string;
}

export class SnapshotBoard {
  readonly stage = new PIXI.Container();
  private readonly terrainLayer = new PIXI.Container();
  private readonly unitLayer = new PIXI.Container();

  constructor(private readonly snapshot: ScenarioSnapshot, options: SnapshotBoardOptions = {}) {
    if (options.imageBaseUrl) setImageBaseUrl(options.imageBaseUrl);
    this.stage.addChild(this.terrainLayer, this.unitLayer);
  }

  async render(): Promise<void> {
    this.renderTerrain();
    await this.renderUnits();
  }

  private renderTerrain(): void {
    for (const hex of this.snapshot.terrain) {
      const coord = toHexCoord(hex.x, hex.y);
      const { x: cx, y: cy } = hexToPixel(coord);
      const corners = hexCorners(cx, cy);

      const g = new PIXI.Graphics();
      g.poly(corners.flatMap((p) => [p.x, p.y]));
      g.fill({ color: colorForTerrain(hex.code) });
      g.stroke({ width: 1, color: 0x000000, alpha: 0.15 });
      this.terrainLayer.addChild(g);
    }
  }

  private async renderUnits(): Promise<void> {
    const teamColor = new Map(this.snapshot.teams.map((t) => [t.side, t.color]));

    for (const unit of this.snapshot.units) {
      const coord = toHexCoord(unit.x, unit.y);
      const { x: cx, y: cy } = hexToPixel(coord);

      const sprite = unit.image ? await this.spriteFor(unit.image) : null;
      if (sprite) {
        sprite.anchor.set(0.5, 0.5);
        sprite.x = cx;
        sprite.y = cy;
        // Team recolor (magenta palette swap) needs the unit's *_ColorMap
        // team-color reference resolved via ImageCache's TC modifier, which
        // requires knowing the recolor target up front -- deferred for this
        // slice (real content still renders, just not recoloured per side);
        // draw a small side-colour marker underneath instead so sides are
        // visually distinguishable without it.
        const marker = new PIXI.Graphics();
        marker.circle(0, 28, 6).fill({ color: sideMarkerColor(teamColor.get(unit.side)) });
        marker.x = cx;
        marker.y = cy;
        this.unitLayer.addChild(marker, sprite);
      } else {
        const fallback = new PIXI.Graphics();
        fallback.circle(cx, cy, 16).fill({ color: sideMarkerColor(teamColor.get(unit.side)) });
        this.unitLayer.addChild(fallback);
      }
    }
  }

  private async spriteFor(imagePath: string): Promise<PIXI.Sprite | null> {
    const texture = await ImageCache.resolve(imagePath);
    return texture ? new PIXI.Sprite(texture) : null;
  }
}

function sideMarkerColor(colorName: string | undefined): number {
  switch (colorName) {
    case '1':
      return 0xe61c1c; // red -- Wesnoth's side-1 default
    case 'teal':
      return 0x1ca7a7;
    case '2':
      return 0x1c4fe6;
    default:
      return 0xcccccc;
  }
}
