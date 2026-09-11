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
 *
 * ## Phase 5 interactivity (packages/ui)
 *
 * `onHexClick` (constructor option) makes every terrain hex tile
 * pointer-interactive and reports its engine-convention (0-based) `(x,y)`
 * on click. Deliberately only the TERRAIN tiles are made interactive, not
 * unit sprites: terrain tiles tile the whole board with no gaps, so a
 * click anywhere always resolves to exactly one hex, and PixiJS's default
 * `eventMode` ('passive') on non-interactive unit sprites lets clicks pass
 * straight through to the terrain tile beneath -- callers (packages/ui's
 * `GameSession`) look up "is there a unit at this hex" themselves via the
 * live `GameBoard`, rather than this renderer needing to know about game
 * rules. `updateUnits`/`setHighlights` let a caller re-render after a real
 * move/attack (via `packages/engine`'s actions) without rebuilding the
 * whole board or losing the terrain layer's click handlers.
 */

import * as PIXI from 'pixi.js';
import { hexCorners, hexToPixel, HEX_SIZE, type HexCoord } from './hexGeometry.js';
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

/** An engine-convention (0-based) hex coordinate, as used by `setHighlights`/`onHexClick`. */
export interface HexPoint {
  x: number;
  y: number;
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

/** Every real village overlay code starts with `V` (`^Vh`, `^Vhh`, `^Vc`, `^Ve`, `^Vm`, `^Vu`, ...) -- see `wesnoth/data/core/terrain.cfg`'s village terrain_types. Colored distinctly from its base terrain so a village is visible at all under this placeholder flat-color renderer (full per-terrain imagery is Phase 9, not built yet) -- otherwise e.g. `Gg^Vh` renders identically to plain `Gg` grass. */
const VILLAGE_COLOR = 0xc9963c;

function colorForTerrain(code: string): number {
  const [base = code, overlay] = code.split('^');
  if (overlay && overlay.toUpperCase().startsWith('V')) return VILLAGE_COLOR;
  const letter = base.replace(/^_/, '_').charAt(0).toUpperCase();
  return TERRAIN_COLORS[letter] ?? 0x555555;
}

export interface SnapshotBoardOptions {
  /** Base URL images are served from (see ImageCache.setImageBaseUrl). */
  imageBaseUrl?: string;
  /** Called with a hex's engine-convention (0-based) (x,y) when a terrain tile is clicked -- see module doc comment. */
  onHexClick?: (x: number, y: number) => void;
  /** Called with a hex's engine-convention (0-based) (x,y) when the pointer moves over a terrain tile -- lets a caller show a live coordinate readout, useful for describing positions precisely (e.g. reporting a bug). */
  onHexHover?: (x: number, y: number) => void;
}

/** What `setHighlights` should currently draw, replacing whatever it drew last call. */
export interface HighlightState {
  /** The selected unit's own hex, outlined. */
  selected?: HexPoint | null;
  /** Hexes the selected unit could move to this turn. */
  reachable?: readonly HexPoint[];
  /** Adjacent enemy hexes the selected unit could attack. */
  attackTargets?: readonly HexPoint[];
  /** Vacant castle tiles the selected leader could recruit onto. */
  recruitTiles?: readonly HexPoint[];
}

/** One currently-OWNED village -- unowned villages need no marker (the terrain colour alone already marks them as villages, see `colorForTerrain`). */
export interface VillageOwnerPoint extends HexPoint {
  readonly side: number;
}

export class SnapshotBoard {
  readonly stage = new PIXI.Container();
  private readonly terrainLayer = new PIXI.Container();
  /** Owned-village flag markers -- sits above terrain, below highlight/unit layers (a unit standing on a village shouldn't have its sprite obscured by the flag, but the flag should still read clearly against bare terrain). */
  private readonly villageLayer = new PIXI.Container();
  private readonly highlightLayer = new PIXI.Container();
  private readonly unitLayer = new PIXI.Container();
  /**
   * Holds ONLY the selected-unit ring, added to the stage AFTER
   * `unitLayer` -- see `setHighlights`' doc comment on why this is a
   * separate layer from `highlightLayer` (which stays under `unitLayer`,
   * correctly, for the reachable/attack-target hex fills).
   */
  private readonly selectionLayer = new PIXI.Container();
  private units: SnapshotUnit[];
  private readonly teamColor: Map<number, string>;
  private readonly onHexClick?: (x: number, y: number) => void;
  private readonly onHexHover?: (x: number, y: number) => void;

  constructor(
    private readonly snapshot: ScenarioSnapshot,
    options: SnapshotBoardOptions = {},
  ) {
    if (options.imageBaseUrl) setImageBaseUrl(options.imageBaseUrl);
    this.onHexClick = options.onHexClick;
    this.onHexHover = options.onHexHover;
    this.units = snapshot.units;
    this.teamColor = new Map(snapshot.teams.map((t) => [t.side, t.color]));
    this.stage.addChild(this.terrainLayer, this.villageLayer, this.highlightLayer, this.unitLayer, this.selectionLayer);
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
      if (this.onHexClick || this.onHexHover) {
        const hx = hex.x;
        const hy = hex.y;
        g.eventMode = 'static';
        if (this.onHexClick) {
          g.cursor = 'pointer';
          g.on('pointertap', () => this.onHexClick?.(hx, hy));
        }
        if (this.onHexHover) {
          g.on('pointerover', () => this.onHexHover?.(hx, hy));
        }
      }
      this.terrainLayer.addChild(g);
    }
  }

  private async renderUnits(): Promise<void> {
    this.unitLayer.removeChildren();

    for (const unit of this.units) {
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
        marker.circle(0, 28, 6).fill({ color: sideMarkerColor(this.teamColor.get(unit.side)) });
        marker.x = cx;
        marker.y = cy;
        this.unitLayer.addChild(marker, sprite);
      } else {
        const fallback = new PIXI.Graphics();
        fallback.circle(cx, cy, 16).fill({ color: sideMarkerColor(this.teamColor.get(unit.side)) });
        this.unitLayer.addChild(fallback);
      }
    }
  }

  /**
   * Re-renders the unit layer from an updated live unit list (positions,
   * hitpoints, deaths after a real move/attack) without touching the
   * terrain layer (and its click handlers) or re-fetching already-cached
   * textures unnecessarily (`ImageCache.resolve` is memoized).
   */
  async updateUnits(units: SnapshotUnit[]): Promise<void> {
    this.units = units;
    await this.renderUnits();
  }

  /**
   * Draws (replacing any previous) a small owning-side flag marker on
   * every currently-owned village -- live game state (changes as villages
   * get captured), so this is a separate, re-callable update like
   * `updateUnits`/`setHighlights`, not baked into the one-time
   * `renderTerrain()`. An unowned village needs no marker here (the
   * terrain layer's own placeholder village colour already marks it as a
   * village at all -- see `colorForTerrain`); this only shows WHO owns it.
   */
  updateVillageOwnership(owners: readonly VillageOwnerPoint[]): void {
    this.villageLayer.removeChildren();
    for (const v of owners) {
      const coord = toHexCoord(v.x, v.y);
      const { x: cx, y: cy } = hexToPixel(coord);
      const flag = new PIXI.Graphics();
      // A small flag: a pole plus a triangular pennant, near the top of
      // the hex (matches real Wesnoth's village-flag placement) -- offsets
      // relative to HEX_SIZE so it scales with the same tile size
      // everything else on this board uses.
      const poleTop = cy - HEX_SIZE * 0.85;
      const poleBottom = cy - HEX_SIZE * 0.15;
      const poleX = cx - HEX_SIZE * 0.15;
      flag.moveTo(poleX, poleTop).lineTo(poleX, poleBottom).stroke({ width: 2, color: 0x000000, alpha: 0.8 });
      flag.poly([poleX, poleTop, poleX + HEX_SIZE * 0.4, poleTop + HEX_SIZE * 0.18, poleX, poleTop + HEX_SIZE * 0.36]);
      flag.fill({ color: sideMarkerColor(this.teamColor.get(v.side)) });
      flag.stroke({ width: 1, color: 0x000000, alpha: 0.7 });
      this.villageLayer.addChild(flag);
    }
  }

  /**
   * Draws (replacing any previous) selection/move-range/attack-target
   * highlights. Pass `{}` to clear.
   *
   * The `selected` ring is drawn into `selectionLayer`, which sits ABOVE
   * `unitLayer` in the stage (see constructor) -- previously it was drawn
   * into `highlightLayer`, which sits BELOW `unitLayer`, so a selected
   * unit's own sprite (added after, in `renderUnits`) fully or partially
   * covered its own selection ring. Real user-reported symptom: "no
   * indicator of unit selection". The `reachable`/`attackTargets` fills
   * correctly stay in `highlightLayer` (under units) -- those are meant to
   * tint the empty hexes around a unit, not obscure sprites.
   */
  setHighlights(state: HighlightState): void {
    this.highlightLayer.removeChildren();
    this.selectionLayer.removeChildren();

    // A colour-coded fill alone isn't reliably visible: Dead Water's map is
    // almost entirely water and sand/keep hexes, so the original flat blue
    // reachable-fill on blue ocean (and the gold selection ring on a tan
    // keep hex, below) were both real, close-to-invisible contrast
    // failures, not just "could be nicer" -- confirmed by screenshot, not
    // guessed. Every highlighted hex now also gets a solid white outline
    // (full alpha, on TOP of the low-alpha colour fill) so it reads
    // against any terrain hue/brightness; the fill colour still carries
    // the semantic meaning (blue=move, red=attack, green=recruit) for
    // anyone who can see it, but the white border is what actually
    // guarantees visibility.
    const drawFill = (hex: HexPoint, color: number, alpha: number): void => {
      const coord = toHexCoord(hex.x, hex.y);
      const { x: cx, y: cy } = hexToPixel(coord);
      const corners = hexCorners(cx, cy);
      const points = corners.flatMap((p) => [p.x, p.y]);
      const g = new PIXI.Graphics();
      g.poly(points);
      g.fill({ color, alpha });
      g.stroke({ width: 2, color: 0xffffff, alpha: 0.85 });
      this.highlightLayer.addChild(g);
    };

    for (const hex of state.reachable ?? []) drawFill(hex, 0x3fa9f5, 0.45);
    for (const hex of state.attackTargets ?? []) drawFill(hex, 0xe23b3b, 0.5);
    for (const hex of state.recruitTiles ?? []) drawFill(hex, 0x3fdf6a, 0.45);

    if (state.selected) {
      const coord = toHexCoord(state.selected.x, state.selected.y);
      const { x: cx, y: cy } = hexToPixel(coord);
      const corners = hexCorners(cx, cy);
      const points = corners.flatMap((p) => [p.x, p.y]);

      // A dark outer stroke behind a bright inner one. The inner colour
      // was gold (0xffd54a) -- confirmed by screenshot to nearly disappear
      // against Dead Water's tan keep/sand hexes, which are a close match
      // for that hue. White has no such blind spot: paired with the black
      // outer stroke it stays legible against every terrain colour and
      // every unit sprite, at the cost of the "selection = gold" colour
      // association (not worth keeping over actual visibility).
      const outer = new PIXI.Graphics();
      outer.poly(points);
      outer.stroke({ width: 6, color: 0x000000, alpha: 0.75 });
      this.selectionLayer.addChild(outer);

      const inner = new PIXI.Graphics();
      inner.poly(points);
      inner.stroke({ width: 3, color: 0xffffff, alpha: 1 });
      this.selectionLayer.addChild(inner);
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
