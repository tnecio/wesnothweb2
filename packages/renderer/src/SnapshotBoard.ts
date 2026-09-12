/**
 * Renders a static scenario snapshot (see apps/web/scripts/build-scenario-
 * snapshot.mjs) as a PixiJS board: flat-coloured terrain hexes plus real
 * unit sprite art loaded through ImageCache/ipf.
 *
 * Deliberately NOT what Phase 4 (docs/IMPLEMENTATION_PLAN.md) means by
 * "rendering" -- there is no terrain image compositing/layering here (that
 * needs the terrain_graphics rule-matching system, out of scope until
 * Phase 4), no fog of war. This exists to prove two things
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
 *
 * ## Animation playback (Phase 10, 2026-09-11)
 *
 * `playAnimations` is the actually-plays-it half of Phase 10 -- see
 * `animation/unitAnimation.ts`'s and `animation/playback.ts`'s own module
 * doc comments for the selection/sampling logic this drives. It needs
 * unit sprites to be stable, addressable objects across calls (so a
 * sprite mid-lunge is the SAME PixiJS object the next animation frame
 * updates, not a freshly-built one), which is why `renderUnits` was
 * changed from "destroy and rebuild every sprite on every update" to a
 * reconciling `unitSprites`/`unitMarkers` map keyed by `SnapshotUnit.
 * underlyingId` (falling back to a position-based synthetic key for a
 * unit with none, e.g. the very first paint from the static pre-game
 * snapshot -- see `SnapshotUnit.underlyingId`'s own doc comment). This
 * was also a real, if secondary, visual fix on its own: every prior
 * `updateUnits` call flickered the whole unit layer (every sprite gone
 * for one frame, then redrawn), not just the units that actually moved.
 *
 * `playAnimations` and `updateUnits` must not race: a caller that wants
 * an animated transition should `await playAnimations(...)` BEFORE
 * calling `updateUnits` with the final settled state -- `updateUnits`
 * unconditionally snaps every sprite straight to its target's `(x, y)`,
 * which would cut an in-flight animation short if it ran concurrently.
 * `GameShell.svelte` is the one caller that does this today (for a
 * human-confirmed attack's blows, via `GameSession.lastAttackAnimation`);
 * AI-played attacks and plain movement are still instant, see that
 * component's own comment on why.
 */

import * as PIXI from 'pixi.js';
import { Direction } from '@wesnothweb2/engine/src/model/Location.js';
import { parseTerrainCode, NONE_TERRAIN, type TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import { hexCorners, hexToPixel, HEX_SIZE, type HexCoord } from './hexGeometry.js';
import { ImageCache, hexedRef, setImageBaseUrl } from './images/ImageCache.js';
import { joinRef } from './images/ipf.js';
import { sampleAnimation, animationDurationMs } from './animation/playback.js';
import type { UnitAnimationDef } from './animation/unitAnimation.js';
import { makeLayerSprite, type TerrainLayer } from './terrainPositioning.js';
import { buildTerrainTiles, getTerrainFramesAt, type TerrainMapQuery } from './terrain/terrainBuilder.js';
import type { BuildingRule } from './terrain/terrainGraphicsRules.js';

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
  /**
   * A stable per-instance key for sprite identity across `updateUnits`
   * calls (see that method's own doc comment on why this replaced full
   * sprite teardown/rebuild). NOT the real engine `Unit.underlyingId`
   * field -- that defaults to 0 and isn't reliably unique (most units
   * loaded from a scenario never get an explicit one; see
   * `RecallOption.index`'s own doc comment in `gameSession.ts` for the
   * same underlying issue elsewhere). `GameSession.renderUnits` instead
   * assigns each live `Unit` OBJECT a fresh session-local key the first
   * time it's seen (`renderKeyFor`, keyed by object identity via a
   * `WeakMap`), which stays stable for exactly as long as that unit's
   * sprite should. Optional so a caller that only has the static,
   * pre-game snapshot shape (no live `Unit` to key by) still satisfies
   * this interface; such a unit just gets a synthetic per-render key
   * (see `spriteKey`), which is harmless since animation only ever runs
   * against live, GameSession-sourced units.
   */
  underlyingId?: number;
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

/** One unit's persistent PixiJS presence -- see `SnapshotBoard`'s own module doc comment on why sprites are kept stable across `renderUnits`/`updateUnits` calls instead of rebuilt each time. */
interface UnitVisual {
  /** Holds `marker` (+ `sprite`, if any) -- repositioned/moved as one unit so the marker stays glued to the sprite during animation. */
  readonly container: PIXI.Container;
  sprite: PIXI.Sprite | null;
  marker: PIXI.Graphics;
  /**
   * A same-texture, tinted, alpha-modulated copy of `sprite`, drawn on
   * top -- the real `blend_with`/`blend_ratio` hit-flash mechanism
   * (e.g. `[defend]`'s red pulse), approximated with PixiJS `tint`
   * rather than a true solid-colour recolour (real Wesnoth draws a
   * pure-white-recoloured copy tinted to `blend_with`; a multiply-tint
   * overlay reads as a believable flash without needing a custom
   * shader). Created lazily the first time `playAnimations` samples a
   * non-zero `blendRatio` for this unit; hidden (`alpha = 0`) the rest
   * of the time, including whenever `renderUnits` settles a unit (a
   * flash should never persist past the animation that caused it).
   */
  overlay: PIXI.Sprite | null;
  /** The `SnapshotUnit.image`/`.side` this visual was last built from, to detect when a rebuild (not just a reposition) is needed. */
  lastImage: string | null;
  lastSide: number;
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
  /**
   * The real, parsed `[terrain_graphics]` rule list (see
   * `terrain/terrainGraphicsRules.ts` -- typically fetched as JSON built by
   * `apps/web/scripts/build-terrain-graphics-rules.mjs` and revived via
   * `reviveBuildingRules`). When omitted, `renderTerrain` falls back to the
   * flat-coloured placeholder (`colorForTerrain`) -- useful for tests/tools
   * that don't want to fetch the ~17MB rule set, or haven't built it yet.
   */
  terrainGraphicsRules?: readonly BuildingRule[];
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

/**
 * One unit's part of a `playAnimations` call -- see `SnapshotBoard`'s own
 * module doc comment. `key` must match the `spriteKey` of a unit
 * currently on the board (see `SnapshotUnit.underlyingId`) or this cue is
 * silently skipped (nothing to animate). `anim` is the real,
 * already-selected `UnitAnimationDef` (via `unitAnimation.ts`'s
 * `chooseAnimation`) if the unit type declared a matching one, or
 * `undefined` if not -- real mainline unit types very often DON'T
 * declare an explicit `[movement_anim]`/`[defend]` for every case (see
 * that module's own doc comment on the fallback chain this project
 * doesn't synthesize), so `playAnimations` still gives `undefined` cues a
 * short, real (if synthetic) visual beat rather than silently doing
 * nothing -- see its own doc comment.
 */
export interface UnitAnimationCue {
  readonly key: string;
  readonly anim: UnitAnimationDef | undefined;
  readonly direction: Direction;
  /** Where this unit visually starts, engine-convention (0-based). */
  readonly srcHex: HexPoint;
  /** The "other" hex for `offset=` interpolation -- the lunge target for an attacker, the attacker's own hex for a defender's reaction, or the unit's own real next hex for a movement step. Equal to `srcHex` for a non-positional animation (standing/defend-in-place/etc). */
  readonly dstHex: HexPoint;
  /** Where the sprite should rest once this cue finishes: `'src'` (default if omitted) for a lunge-and-return (attack/defend -- the unit ends up back where it started), `'dst'` for a real relocation (movement -- the unit ends up at its new hex). */
  readonly restAt?: 'src' | 'dst';
}

/** A stable per-unit key for sprite identity -- see `SnapshotUnit.underlyingId`'s own doc comment. Exported so callers building `UnitAnimationCue`s key them identically to how `renderUnits` will look them up. */
export function spriteKey(unit: Pick<SnapshotUnit, 'underlyingId' | 'typeId' | 'x' | 'y'>): string {
  return unit.underlyingId !== undefined ? `u:${unit.underlyingId}` : `p:${unit.typeId}:${unit.x},${unit.y}`;
}

export class SnapshotBoard {
  readonly stage = new PIXI.Container();
  private readonly terrainLayer = new PIXI.Container();
  /** Owned-village flag markers -- sits above terrain, below highlight/unit layers (a unit standing on a village shouldn't have its sprite obscured by the flag, but the flag should still read clearly against bare terrain). */
  private readonly villageLayer = new PIXI.Container();
  private readonly highlightLayer = new PIXI.Container();
  private readonly unitLayer = new PIXI.Container();
  /**
   * Real per-hex `[terrain_graphics]` image layers whose `basey` puts them
   * in FRONT of unit sprites (upstream's `rule_image::is_background() ==
   * false` -- rare in practice, mostly tall structural pieces like bridge
   * railings). Sits above `unitLayer` so those pieces actually draw over
   * units standing "behind" them, below `selectionLayer` so the selected-
   * unit ring still reads clearly on top of everything.
   */
  private readonly terrainForegroundLayer = new PIXI.Container();
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
  /** Persistent per-unit sprite/marker, keyed by `spriteKey` -- see module doc comment on why (animation needs a stable object to animate, not a fresh one every `updateUnits`). */
  private readonly unitVisuals = new Map<string, UnitVisual>();
  /**
   * Serializes every `renderUnits()` run (see `render`/`updateUnits`,
   * the only callers) so overlapping calls can't race. `renderUnits`
   * itself is async (`buildUnitVisual` awaits real texture loading), and
   * a caller (`GameBoardView.svelte`'s reactive `$effect`) can legitimately
   * call `updateUnits` again before a previous call has finished (e.g.
   * selecting a unit and immediately moving it). Without this queue, two
   * overlapping runs could each fail to find an existing `UnitVisual` for
   * the same unit (neither has reached its own `unitVisuals.set(...)`
   * yet) and each build a fresh sprite -- one of the two ends up
   * orphaned in `unitLayer` (added to the stage, but overwritten in the
   * map by the other, so never cleaned up), producing a real, reported
   * bug: a moved unit's sprite duplicated, with a stale copy left behind
   * at its origin hex. Chaining every call through one `Promise` chain
   * makes runs strictly sequential, each seeing whatever `this.units` is
   * current when its turn comes.
   */
  private renderQueue: Promise<void> = Promise.resolve();

  private readonly terrainGraphicsRules?: readonly BuildingRule[];

  constructor(
    private readonly snapshot: ScenarioSnapshot,
    options: SnapshotBoardOptions = {},
  ) {
    if (options.imageBaseUrl) setImageBaseUrl(options.imageBaseUrl);
    this.onHexClick = options.onHexClick;
    this.onHexHover = options.onHexHover;
    this.terrainGraphicsRules = options.terrainGraphicsRules;
    this.units = snapshot.units;
    this.teamColor = new Map(snapshot.teams.map((t) => [t.side, t.color]));
    this.stage.addChild(
      this.terrainLayer,
      this.villageLayer,
      this.highlightLayer,
      this.unitLayer,
      this.terrainForegroundLayer,
      this.selectionLayer,
    );
  }

  /** Queues a `renderUnits()` run behind any already in flight -- see `renderQueue`'s own doc comment. */
  private queueRenderUnits(): Promise<void> {
    this.renderQueue = this.renderQueue.then(() => this.renderUnits());
    return this.renderQueue;
  }

  async render(): Promise<void> {
    await this.renderTerrain();
    await this.queueRenderUnits();
  }

  /** Builds the `TerrainMapQuery` `terrain/terrainBuilder.ts` needs directly from the snapshot's flat hex list -- see that module's own doc comment for why this is a client-side adapter rather than a real `GameMap`. */
  private buildTerrainMapQuery(): TerrainMapQuery {
    const byKey = new Map<string, TerrainCode>();
    for (const hex of this.snapshot.terrain) byKey.set(`${hex.x},${hex.y}`, parseTerrainCode(hex.code));
    const { width, height } = this.snapshot.map;
    return {
      width,
      height,
      terrainAt: (x, y) => byKey.get(`${x},${y}`) ?? NONE_TERRAIN,
      onBoard: (x, y) => byKey.has(`${x},${y}`),
    };
  }

  /**
   * One hex's real, click/hover-interactive placeholder polygon -- kept
   * even when real terrain images render on top (see `renderTerrain`):
   * a stacked layer's own hex-alpha-mask means its VISIBLE footprint never
   * exceeds the hex it was resolved for (see `terrainPositioning.ts`'s own
   * doc comment), so routing clicks by hex geometry here, independent of
   * whatever's drawn on top, stays correct. Non-interactive terrain image
   * sprites (PixiJS default `eventMode`) let pointer events pass straight
   * through to this polygon, exactly like unit sprites already do.
   */
  private buildHexHitArea(x: number, y: number, cx: number, cy: number, flatColorCode: string | null): PIXI.Graphics {
    const g = new PIXI.Graphics();
    const corners = hexCorners(cx, cy);
    g.poly(corners.flatMap((p) => [p.x, p.y]));
    if (flatColorCode !== null) {
      g.fill({ color: colorForTerrain(flatColorCode) });
      g.stroke({ width: 1, color: 0x000000, alpha: 0.15 });
    } else {
      g.fill({ color: 0x000000, alpha: 0 });
    }
    if (this.onHexClick || this.onHexHover) {
      g.eventMode = 'static';
      if (this.onHexClick) {
        g.cursor = 'pointer';
        g.on('pointertap', () => this.onHexClick?.(x, y));
      }
      if (this.onHexHover) {
        g.on('pointerover', () => this.onHexHover?.(x, y));
      }
    }
    return g;
  }

  private async renderTerrain(): Promise<void> {
    if (!this.terrainGraphicsRules || this.terrainGraphicsRules.length === 0) {
      this.renderTerrainFlat();
      return;
    }
    await this.renderTerrainReal(this.terrainGraphicsRules);
  }

  /** The pre-Phase-9 flat-coloured placeholder -- see `SnapshotBoardOptions.terrainGraphicsRules`'s own doc comment on when this still applies. */
  private renderTerrainFlat(): void {
    for (const hex of this.snapshot.terrain) {
      const { x: cx, y: cy } = hexToPixel(toHexCoord(hex.x, hex.y));
      this.terrainLayer.addChild(this.buildHexHitArea(hex.x, hex.y, cx, cy, hex.code));
    }
  }

  /**
   * Real per-hex `[terrain_graphics]` image compositing (Phase 9): matches
   * `rules` against the snapshot's map once (`buildTerrainTiles`), resolves
   * every hex's final layers for a fixed time-of-day (no ToD system yet --
   * Phase 12; an empty string matches any `tods=`-unfiltered variant, which
   * is the overwhelming majority of real content), preloads every image
   * reference those layers need, then builds one `makeLayerSprite` per
   * layer -- background layers into `terrainLayer` (under units),
   * foreground layers (rare -- tall structural pieces) into
   * `terrainForegroundLayer` (over units).
   */
  private async renderTerrainReal(rules: readonly BuildingRule[]): Promise<void> {
    const query = this.buildTerrainMapQuery();
    const offMapCode = parseTerrainCode('_off^_usr');
    const tiles = buildTerrainTiles(rules as BuildingRule[], query, { offMapCode });

    const perHex: Array<{ x: number; y: number; cx: number; cy: number; bg: TerrainLayer[]; fg: TerrainLayer[] }> = [];
    const refs = new Set<string>();
    for (const hex of this.snapshot.terrain) {
      const { background, foreground } = getTerrainFramesAt(tiles, hex.x, hex.y, '');
      const { x: cx, y: cy } = hexToPixel(toHexCoord(hex.x, hex.y));
      perHex.push({ x: hex.x, y: hex.y, cx, cy, bg: [...background], fg: [...foreground] });
      for (const layer of [...background, ...foreground]) {
        for (const frame of layer.frames) refs.add(hexedRef(joinRef(frame.path, frame.mods)));
      }
    }

    await ImageCache.preload(refs);

    for (const hex of perHex) {
      this.terrainLayer.addChild(this.buildHexHitArea(hex.x, hex.y, hex.cx, hex.cy, null));
      for (const layer of hex.bg) {
        const sprite = makeLayerSprite(layer, hex.cx, hex.cy);
        if (sprite) this.terrainLayer.addChild(sprite);
      }
      for (const layer of hex.fg) {
        const sprite = makeLayerSprite(layer, hex.cx, hex.cy);
        if (sprite) this.terrainForegroundLayer.addChild(sprite);
      }
    }
  }

  /**
   * Builds a fresh `sprite`+`marker` pair for `unit` (a real sprite plus a
   * small side-colour marker dot beneath it, matching upstream's own
   * "team recolor via magenta palette swap" placeholder -- see the marker
   * comment below for why it's a plain dot rather than a real recolor).
   * Does NOT touch the layer/position; callers add `visual.container` to
   * `unitLayer` and set its `x`/`y` themselves.
   */
  private async buildUnitVisual(unit: SnapshotUnit): Promise<UnitVisual> {
    const container = new PIXI.Container();
    const marker = new PIXI.Graphics();
    let sprite: PIXI.Sprite | null = null;

    if (unit.image) {
      const texture = await ImageCache.resolve(unit.image);
      if (texture) {
        sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5, 0.5);
      }
    }

    // Team recolor (magenta palette swap) needs the unit's *_ColorMap
    // team-color reference resolved via ImageCache's TC modifier, which
    // requires knowing the recolor target up front -- deferred for this
    // slice (real content still renders, just not recoloured per side);
    // draw a small side-colour marker underneath instead so sides are
    // visually distinguishable without it. No sprite at all (image
    // missing/unresolvable) -- fall back to a bigger, undecorated dot so
    // the unit is still visible and clickable-by-proxy.
    if (sprite) {
      marker.circle(0, 28, 6).fill({ color: sideMarkerColor(this.teamColor.get(unit.side)) });
      container.addChild(marker, sprite);
    } else {
      marker.circle(0, 0, 16).fill({ color: sideMarkerColor(this.teamColor.get(unit.side)) });
      container.addChild(marker);
    }

    return { container, sprite, marker, overlay: null, lastImage: unit.image, lastSide: unit.side };
  }

  /**
   * Approximates the real `blend_with`/`blend_ratio` hit-flash (e.g.
   * `[defend]`'s red pulse on a landed blow, real or the generic
   * engine-injected fallback -- see `unitAnimation.ts`'s own doc comment)
   * by drawing a same-texture, tinted copy of `visual.sprite` on top of
   * it at `alpha = ratio`. Lazily creates the overlay sprite the first
   * time it's actually needed (most cues never blend at all) and hides
   * it (`alpha = 0`) rather than destroying it once no longer needed, so
   * repeated blends within one animation don't keep allocating sprites.
   * A no-op if there's no base `sprite` to overlay (the image-missing
   * fallback-circle case) or no `ratio`/`color` to show.
   */
  private applyBlend(visual: UnitVisual, ratio: number, color: number | null): void {
    if (!visual.sprite) return;
    if (ratio <= 0 || color === null) {
      if (visual.overlay) visual.overlay.alpha = 0;
      return;
    }
    if (!visual.overlay) {
      const overlay = new PIXI.Sprite(visual.sprite.texture);
      overlay.anchor.set(0.5, 0.5);
      visual.container.addChild(overlay);
      visual.overlay = overlay;
    }
    visual.overlay.texture = visual.sprite.texture;
    visual.overlay.scale.x = visual.sprite.scale.x;
    visual.overlay.tint = color;
    visual.overlay.alpha = Math.min(1, ratio);
  }

  /**
   * Reconciles `unitLayer` against `this.units`: reuses each unit's
   * existing `UnitVisual` (by `spriteKey`) where one already exists
   * (rebuilding only if its image/side actually changed -- e.g. an
   * advancement), creates one for a newly-appeared unit, and removes/
   * destroys any whose unit is no longer present (dead, or off this
   * board). See module doc comment for why this replaced the previous
   * "destroy and rebuild everything" approach.
   */
  private async renderUnits(): Promise<void> {
    const seen = new Set<string>();

    for (const unit of this.units) {
      const key = spriteKey(unit);
      seen.add(key);
      const coord = toHexCoord(unit.x, unit.y);
      const { x: cx, y: cy } = hexToPixel(coord);

      let visual = this.unitVisuals.get(key);
      if (!visual) {
        visual = await this.buildUnitVisual(unit);
        this.unitVisuals.set(key, visual);
        this.unitLayer.addChild(visual.container);
      } else if (visual.lastImage !== unit.image || visual.lastSide !== unit.side) {
        visual.container.removeChildren();
        const rebuilt = await this.buildUnitVisual(unit);
        visual.container.addChild(...rebuilt.container.removeChildren());
        visual.sprite = rebuilt.sprite;
        visual.marker = rebuilt.marker;
        visual.overlay = null; // the old overlay sprite (if any) was just destroyed along with its old container children.
        visual.lastImage = unit.image;
        visual.lastSide = unit.side;
      }
      if (visual.overlay) visual.overlay.alpha = 0; // a hit-flash should never outlive the animation that caused it.
      visual.container.x = cx;
      visual.container.y = cy;
      if (visual.sprite) {
        visual.sprite.scale.x = Math.abs(visual.sprite.scale.x); // undo any hflip a prior animation left behind.
      }
    }

    for (const [key, visual] of this.unitVisuals) {
      if (seen.has(key)) continue;
      this.unitLayer.removeChild(visual.container);
      visual.container.destroy({ children: true });
      this.unitVisuals.delete(key);
    }
  }

  /**
   * Plays every cue in `cues` concurrently in real time (e.g. an
   * attacker's lunge and a defender's reaction, for one blow -- or just
   * one cue, for one leg of a movement glide), resolving once all of
   * them have finished. See `UnitAnimationCue`'s own doc comment for
   * what each cue needs (including `restAt`, which decides whether the
   * sprite ends the cue back at `srcHex` or relocated to `dstHex`), and
   * the module doc comment for the "don't race `updateUnits`" contract.
   *
   * A cue with no real `anim` (the unit type declared no matching
   * `[attack_anim]`/`[defend]`/`[movement_anim]`/etc) still gets a short,
   * honest synthetic beat rather than silently doing nothing, IF its
   * `srcHex`/`dstHex` differ: `restAt: 'dst'` (movement) glides straight
   * there over `defaultDurationMs`; the default (an attack lunge/
   * reaction) bounces out partway and back. A cue with equal `srcHex`/
   * `dstHex` (e.g. a defender with no `[defend]`) just holds in place for
   * the same duration, so a blow/step without real per-unit art still
   * reads as "something happened here" rather than nothing at all.
   *
   * `speedMultiplier` compresses real WALL-CLOCK playback time (2 = plays
   * in half the time) while still sampling a real `anim` across its full
   * authored internal timeline (so frame/offset progression looks like a
   * faster version of the same animation, not a truncated one) -- see the
   * `animT` scaling below. Default 1 (real authored speed); `GameShell.
   * svelte` requests a faster one for movement specifically.
   */
  async playAnimations(cues: readonly UnitAnimationCue[], defaultDurationMs = 400, speedMultiplier = 1): Promise<void> {
    const active = cues
      .map((cue) => {
        const visual = this.unitVisuals.get(cue.key);
        if (!visual) return null;
        const src = hexToPixel(toHexCoord(cue.srcHex.x, cue.srcHex.y));
        const dst = hexToPixel(toHexCoord(cue.dstHex.x, cue.dstHex.y));
        const duration = (cue.anim ? animationDurationMs(cue.anim) : defaultDurationMs) / speedMultiplier;
        return { cue, visual, src, dst, duration: Math.max(1, duration) };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    if (active.length === 0) return;

    // Pre-resolve every real texture this playback will need up front, so
    // no frame swap stalls on a still-loading image mid-animation.
    for (const { cue } of active) {
      if (!cue.anim) continue;
      const paths = new Set<string>();
      for (const frame of cue.anim.frames) {
        const seq = cue.direction === Direction.NorthEast || cue.direction === Direction.SouthEast
          || cue.direction === Direction.NorthWest || cue.direction === Direction.SouthWest
          ? (frame.imageDiagonal.length > 0 ? frame.imageDiagonal : frame.image)
          : frame.image;
        for (const step of seq) paths.add(step.value);
      }
      await Promise.all([...paths].map((p) => ImageCache.resolve(p)));
    }

    const totalMs = Math.max(...active.map((a) => a.duration));
    const start = performance.now();

    await new Promise<void>((resolve) => {
      const tick = async (): Promise<void> => {
        const elapsed = performance.now() - start;

        for (const { cue, visual, src, dst, duration } of active) {
          const t = Math.min(elapsed, duration);
          if (cue.anim) {
            // `t` is wall-clock time (already compressed by speedMultiplier);
            // scale it back up to the animation's own real internal
            // timeline so a real anim's frame/offset progression plays
            // faster, not truncated -- see this method's own doc comment.
            const animT = t * speedMultiplier;
            const sample = sampleAnimation(cue.anim, cue.direction, animT, src, dst);
            if (sample.imagePath) {
              const texture = await ImageCache.resolve(sample.imagePath);
              if (texture && visual.sprite && visual.sprite.texture !== texture) visual.sprite.texture = texture;
            }
            if (visual.sprite) visual.sprite.scale.x = sample.hflip ? -Math.abs(visual.sprite.scale.x) : Math.abs(visual.sprite.scale.x);
            visual.container.x = sample.x;
            visual.container.y = sample.y;
            this.applyBlend(visual, sample.blendRatio, sample.blendColor);
          } else if (cue.srcHex.x !== cue.dstHex.x || cue.srcHex.y !== cue.dstHex.y) {
            // No real anim: a synthetic beat appropriate to what this cue
            // means. `restAt: 'dst'` (movement) glides straight there,
            // offset 0 -> 1 over the full duration; the default (`'src'`,
            // an attack lunge/reaction) bounces out partway and back:
            // 0 -> 0.35 -> 0.
            const offset =
              cue.restAt === 'dst'
                ? t / duration
                : t <= duration / 2
                  ? (t / (duration / 2)) * 0.35
                  : 0.35 * (1 - (t - duration / 2) / (duration / 2));
            visual.container.x = offset * dst.x + (1 - offset) * src.x;
            visual.container.y = offset * dst.y + (1 - offset) * src.y;
          }
        }

        if (elapsed >= totalMs) {
          // Settle each sprite at its own real resting hex -- `dst` for a
          // `restAt: 'dst'` cue (movement: the unit's real new hex), `src`
          // otherwise (attack: both the attacker's lunge-and-return and
          // the defender's in-place reaction end where they started).
          for (const { cue, visual, src, dst } of active) {
            const rest = cue.restAt === 'dst' ? dst : src;
            visual.container.x = rest.x;
            visual.container.y = rest.y;
            if (visual.overlay) visual.overlay.alpha = 0;
          }
          resolve();
          return;
        }
        requestAnimationFrame(() => void tick());
      };
      requestAnimationFrame(() => void tick());
    });
  }

  /**
   * Re-renders the unit layer from an updated live unit list (positions,
   * hitpoints, deaths after a real move/attack) without touching the
   * terrain layer (and its click handlers) or re-fetching already-cached
   * textures unnecessarily (`ImageCache.resolve` is memoized).
   */
  async updateUnits(units: SnapshotUnit[]): Promise<void> {
    this.units = units;
    await this.queueRenderUnits();
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
