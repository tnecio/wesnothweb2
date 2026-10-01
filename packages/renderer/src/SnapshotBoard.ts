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
import { Direction, Location, getAdjacentTiles, relativeDirection, tilesAdjacent, writeDirection } from '@wesnothweb2/engine/src/model/Location.js';
import { hexOverlayImages, defaultAssetExists, type FogShroudHex } from './fogShroud.js';
import { splitTodTintColors } from './todTint.js';
import {
  hexCorners,
  hexToPixel,
  pixelToHex,
  HEX_COL_WIDTH,
  HEX_ROW_HEIGHT,
  TILE_SIZE,
  type HexCoord,
} from './hexGeometry.js';
import { ImageCache, setImageBaseUrl, setEngineImageBaseUrl } from './images/ImageCache.js';
import { joinRef } from './images/ipf.js';
import { resolveSideColorId, sideColorRgb } from './images/teamColor.js';
import { squareParentheticalSplit } from './animation/frame.js';
import { sampleAnimation, animationTimeline, animationSoundCues, sampleParticles, sampleUnitHalo, type OverlaySample, type SoundCue } from './animation/playback.js';
import { HEX_STEP_MS, type UnitAnimationDef } from './animation/unitAnimation.js';
import { LABEL_FONT_SIZE, parseHaloFrames, type MapItemPoint, type MapLabelPoint } from './mapItems.js';
import { makeLayerSprite } from './terrainPositioning.js';
import type { BuildingRule } from './terrain/terrainGraphicsRules.js';
import { layoutTerrain, type TerrainLayout } from './terrain/terrainLayout.js';
import { computeTerrainLayout } from './terrain/terrainLayoutClient.js';
import {
  ENERGY_BAR,
  energyBarHeight,
  energyBarFilled,
  hpColor,
  xpColor,
  DEFAULT_HP_BAR_SCALING,
  DEFAULT_XP_BAR_SCALING,
  movesOrbStatus,
  ORB_COLOR_ID,
  statusBlend,
  blendColorMatrix,
  ellipseImageBase,
} from './unitOverlays.js';
import { redToGreen } from './colorScales.js';

/**
 * Registers `'subtract'` (used by `updateTimeOfDayTint`'s negative-channel
 * layer) as a NATIVE blend equation on a WebGL renderer: colour
 * `dst - src`, alpha kept. Call once after `app.init`.
 *
 * PixiJS v8 ships `'subtract'` only as an "advanced" blend mode
 * (`PIXI.SubtractBlend`): a filter that copies the backbuffer and blends in
 * a shader. Real, playtested bug: that filter intermittently drew the
 * whole board -- terrain and unit sprites -- solid black while the map
 * scrolled or a unit was selected. A fixed blend equation reads no
 * backbuffer and needs no `useBackBuffer`, so it cannot go black.
 *
 * Installed again whenever the GL context changes: a phone drops the WebGL
 * context under memory pressure, and on restore `GlStateSystem` rebuilds its
 * blend table without `'subtract'`, which then falls back to a normal blend
 * -- the darkening layer painted as a solid colour over the whole terrain
 * (playtest, 2026-10-01: the board "blacking out" when a unit is selected).
 */
export function installSubtractBlend(renderer: PIXI.Renderer): void {
  if (!(renderer instanceof PIXI.WebGLRenderer)) return;
  const install = (gl: WebGL2RenderingContext | WebGLRenderingContext): void => {
    const map = (renderer.state as unknown as { blendModesMap: Record<string, number[]> }).blendModesMap;
    map.subtract = [gl.ONE, gl.ONE, gl.ZERO, gl.ONE, gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD];
  };
  install(renderer.gl);
  // Runs after the state system's own `contextChange` (systems register first), so it re-adds the entry.
  renderer.runners.contextChange.add({ contextChange: install });
}

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
   * This unit's real `[unit_type] flag_rgb=` (defaults to "magenta" when
   * absent), the reference palette its sprite is drawn in -- real, reported
   * bug (bugs3.md #3): unit sprites always rendered in this raw reference
   * palette, never recolored to the unit's actual side. `buildUnitVisual`/
   * the sprite-rebuild path append `~RC(flagRgb>sideColorId)` when
   * resolving the sprite texture; see `images/teamColor.ts`'s
   * `resolveSideColorId` for how `sideColorId` itself is derived.
   */
  flagRgb?: string;
  /**
   * `Unit.facing` -- which way the unit last moved/attacked, persisted
   * across turns. Drives the IDLE sprite's horizontal mirror the same way
   * `sampleAnimation`'s own direction handling already does for combat/
   * movement frames (`hflip` true for `NorthWest`/`SouthWest`, the two
   * "leftward" hex directions art is authored mirrored for rather than
   * separately drawn). Real, reported bug: the idle (non-animating) sprite
   * always reset to its unmirrored orientation on every `updateUnits`/
   * `renderUnits` pass, regardless of which way the unit was actually
   * facing -- only the COMBAT animation itself read `unit.facing`
   * correctly; the standing pose in between actions did not. `undefined`
   * (the static pre-game snapshot, or a unit that has never moved/
   * attacked) reads as "no mirror" -- `Direction.Indeterminate`.
   */
  facing?: Direction;
  /**
   * XP/moves/attacks/status fields for the real HP/XP bars, moves-left
   * orb, and status tint (`drawUnitOverlays`) -- all optional since a unit
   * built straight from the static, pre-game `ScenarioSnapshot` JSON
   * (fetched before any `GameSession` exists -- see module doc comment)
   * won't have them; `drawUnitOverlays` treats a missing value as "draw
   * nothing for this part" rather than crashing or guessing. Always
   * populated once a live `GameSession.renderUnits()` is the source.
   */
  experience?: number;
  maxExperience?: number;
  /** This unit type's real level -- used only to scale the XP bar's height down for higher levels (`energy_bar::get_height`'s `xp_bar_scaling / max(level, 1)`, `units/drawer.cpp`), matching real Wesnoth's shorter-looking XP bar on units that need much more experience per level. */
  level?: number;
  /** Whether this unit type has any real advancement path (`UnitType.advancesTo.length > 0`) -- the XP bar is hidden entirely for a unit that can never level up (`u.experience() > 0 && u.can_advance()`, `units/drawer.cpp`), same as real Wesnoth. */
  canAdvance?: boolean;
  movesLeft?: number;
  maxMoves?: number;
  attacksLeft?: number;
  maxAttacksPerTurn?: number;
  /**
   * Real reachability for the moves-left orb (`movesOrbStatus`) -- mirrors
   * `display_context::unit_can_move`'s two booleans. Real, reported bug: a
   * unit with `movesLeft > 0` but no reachable adjacent hex, and no attack
   * possible, used to show the "partial" (yellow) orb since the orb logic
   * only checked the raw moves-left counter. See `engine`'s
   * `actions/unitCanAct.ts`.
   */
  canMove?: boolean;
  canAttackHere?: boolean;
  /** Real boolean status flags this unit currently has (e.g. `poisoned`, `slowed`, `petrified`) -- see `Unit.statuses`. Only the ones the renderer actually draws something for need to be present; harmless to include others. */
  statuses?: readonly string[];
  /** `Unit.loyal` -- whether to draw the real loyal-icon overlay (`misc/loyal-icon.png`). */
  loyal?: boolean;
  /** `unit::image_ellipse` (`''` = `misc/ellipse`, `none` = no ellipse) and `emits_zoc` -- see `ellipseRef`. */
  ellipse?: string;
  emitsZoc?: boolean;
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
  /** `[side] flag=` -- see `villageFlagFrames`. */
  flag?: string;
  /** Recruitable unit type ids (engine `SnapshotTeam.recruit`); their image bundles are registered up front. */
  recruit?: string[];
}

export interface ScenarioSnapshot {
  scenario: { id: string; name: string };
  /** Phase 28c: the campaign's own `[color_range]`s, added to the colour table (`ColorData.ranges`). */
  colorRanges?: Record<string, { mid: number[]; max: number[]; min: number[]; rep: number[] }>;
  map: { width: number; height: number };
  terrain: SnapshotTerrainHex[];
  teams: SnapshotTeam[];
  units: SnapshotUnit[];
  /**
   * The campaign directory this scenario belongs to (`GameBoardSnapshot.assetDir` / `CampaignInfo.assetDir`),
   * for scoping its terrain image atlas: a bare scenario id is only unique within its own campaign, so the
   * atlas bundle lives at `/atlases/<assetDir>/<id>/terrain.json`, not `/atlases/<id>/terrain.json`.
   */
  assetDir?: string;
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
  /** The side-coloured ellipse under the unit (`unit_drawer::draw_ellipses`), or a plain dot when the unit has no sprite. See `updateEllipse`. */
  marker: PIXI.Container;
  /** What `marker` currently shows (`ellipseImageBase` plus the side's colour id), so `updateEllipse` only reloads on a change. */
  lastEllipseKey: string | null;
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
  /**
   * The real HP bar and XP bar (when shown) -- redrawn (not rebuilt) every
   * `renderUnits`/`updateUnits` pass by `updateOverlays`, since they're
   * cheap vector shapes, not textures. See `unitOverlays.ts` for the
   * color/geometry math this draws. The moves-left orb used to be drawn
   * here too (a plain procedural dot); see `orbIcon` for why it isn't
   * anymore.
   */
  bars: PIXI.Graphics;
  /**
   * The real leader crown (`misc/leader-crown.png`, drawn when `canRecruit`),
   * loyal icon (`misc/loyal-icon.png`, drawn when `loyal`), and moves-left
   * orb (`misc/orb.png`, real-content id `engine/misc/orb.png` here --
   * recolored per `MovesOrbStatus` via `~RC(magenta>ORB_COLOR_ID[status])`)
   * -- all three are real 72px-hex-canvas overlays anchored the same way
   * as the unit sprite itself (see `units/drawer.cpp`'s `textures` list,
   * which draws the orb/crown/overlays all at the same `xoff,yoff` as the
   * sprite). Real, reported bug (bugs3.md #1): the orb used to be a
   * procedurally-drawn dot at a hand-guessed offset, which didn't line up
   * with `crownIcon`/`loyalIcon`'s real, correctly-positioned assets --
   * using the real asset the same way fixes both the color (was a flat
   * approximation, `unitOverlays.ORB_COLOR`) and the alignment at once.
   * `crownIcon`/`loyalIcon` are lazily loaded the first time actually
   * needed and toggled via `.visible` afterward (most units are neither);
   * `orbIcon` is lazily loaded too, but its *texture* is swapped (not just
   * visibility) whenever `MovesOrbStatus` changes, since its own real
   * recolor depends on that, not just presence/absence -- see
   * `lastOrbRef`.
   */
  crownIcon: PIXI.Sprite | null;
  loyalIcon: PIXI.Sprite | null;
  orbIcon: PIXI.Sprite | null;
  /** The `path~mods` ref `orbIcon`'s texture was last resolved from, so `updateIcons` only re-resolves when `MovesOrbStatus` (or its visibility) actually changed. */
  lastOrbRef: string | null;
  /** `SnapshotUnit.flagRgb` this visual was last built from -- `playAnimations` needs it (together with `lastSide`) to append the same `~RC(flagRgb>sideColorId)` modifier to ANIMATION frame textures that `buildUnitVisual` already appends to the idle sprite (see that method's own doc comment). */
  flagRgb: string | undefined;
  /**
   * The full `SnapshotUnit` this visual was last drawn from -- `previewHitpoints`
   * (per-blow HP bar updates during combat animation playback) needs every
   * OTHER overlay field (`maxHitpoints`, `experience`, `canAdvance`, ...)
   * to redraw the bars consistently with a temporarily-overridden
   * hitpoints value, without disturbing the XP bar/orb from a partial redraw.
   */
  lastUnit: SnapshotUnit;
}

/** 0-based engine (x,y) -> 1-based renderer HexCoord -- see module doc comment. */
function toHexCoord(x: number, y: number): HexCoord {
  return { x: x + 1, y: y + 1 };
}

/** Mirrors `sampleAnimation`'s own direction-to-hflip rule (frame.ts): art is authored facing "rightward," and the two leftward hex directions reuse it mirrored rather than being drawn separately. Shared here so the idle sprite mirrors the exact same way a combat/movement frame already does. */
function isMirroredFacing(facing: Direction | undefined): boolean {
  return facing === Direction.NorthWest || facing === Direction.SouthWest;
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
  /** Base URL `engine/`-prefixed references are served from (see ImageCache.setEngineImageBaseUrl). */
  engineImageBaseUrl?: string;
  /** Called with a hex's engine-convention (0-based) (x,y) when a terrain tile is clicked -- see module doc comment. */
  onHexClick?: (x: number, y: number) => void;
  /** Called with a hex's engine-convention (0-based) (x,y) when the pointer moves over a terrain tile -- lets a caller show a live coordinate readout, useful for describing positions precisely (e.g. reporting a bug). */
  /** The pointer moved onto hex (x, y); `pointerType` is the DOM's (`'mouse'`, `'touch'`, `'pen'`). */
  onHexHover?: (x: number, y: number, pointerType?: string) => void;
  /**
   * Phase 14: real Wesnoth's right-click context menu. Called with a hex's
   * engine-convention (0-based) (x,y) AND the raw browser viewport
   * coordinates (`clientX`/`clientY`, for positioning an HTML popup menu at
   * the cursor) when a terrain tile is right-clicked. The caller is
   * responsible for suppressing the browser's own native context menu
   * (a separate DOM `contextmenu` event this module doesn't see) --
   * `GameBoardView.svelte` does this on `canvasHost`.
   */
  onHexRightClick?: (x: number, y: number, clientX: number, clientY: number) => void;
  /**
   * An already parsed `[terrain_graphics]` rule list (see
   * `terrain/terrainGraphicsRules.ts`, revived via `reviveBuildingRules`),
   * laid out on the calling thread -- for tests and tools. Takes precedence
   * over `terrainGraphicsRulesUrl`.
   */
  terrainGraphicsRules?: readonly BuildingRule[];
  /**
   * Where the rules JSON is served (built by
   * `apps/web/scripts/build-terrain-graphics-rules.mjs`). Phase 28a P3: the
   * browser fetches, parses and matches it in a worker
   * (`terrain/terrainLayoutClient.ts`). With neither option, or no loadable
   * rules, `renderTerrain` falls back to the flat-coloured placeholder
   * (`colorForTerrain`).
   */
  terrainGraphicsRulesUrl?: string;
}

/** What `setHighlights` should currently draw, replacing whatever it drew last call. */
export interface HighlightState {
  /** The selected unit's own hex, outlined. */
  selected?: HexPoint | null;
  /**
   * Hexes the selected unit could move to this turn -- an entry's optional
   * `defensePercent` (real, reported bug: "the map should show the terrain
   * defence of a unit on its reachable hexes") draws that hex's real
   * terrain-defense percentage as a small label on the tile itself, not
   * just on hover.
   */
  reachable?: readonly (HexPoint & { defensePercent?: number })[];
  /** Adjacent enemy hexes the selected unit could attack. */
  attackTargets?: readonly HexPoint[];
  /**
   * Phase 15: the keyboard cursor's hex -- a dashed-looking double ring,
   * deliberately unlike `selected`'s solid one, since both can be shown
   * at once (a unit selected while the cursor is over its destination).
   */
  cursor?: HexPoint | null;
}

/** Phase 28b: one hex of a route's footsteps, with the unit's movement cost there (which footprint image). */
export interface RouteStepPoint extends HexPoint {
  readonly moveCost: number;
}

/** Phase 28b: a hex where the route ends a turn, or its last hex (`marked_route::mark`), with the unit's defense there. */
export interface RouteMarkPoint extends HexPoint {
  readonly turns: number;
  readonly zoc: boolean;
  readonly capture: boolean;
  readonly invisible: boolean;
  readonly defensePercent: number;
}

/** Phase 28b: the route `setRoute` draws (`game_display::set_route`), from the unit's own hex to the destination. */
export interface RouteOverlay {
  readonly steps: readonly RouteStepPoint[];
  readonly marks: readonly RouteMarkPoint[];
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
  /**
   * Suppresses the synthetic lunge-and-return fallback motion `playAnimations`
   * plays when this cue has no real matching `anim` and `srcHex !== dstHex`.
   * Set by recruit cues (`GameShell.svelte`'s `buildRecruitAnimationCues`),
   * whose `dstHex` is the OTHER combatant's hex purely for `sampleAnimation`'s
   * own directional `offset=` math when a real `[recruit_anim]`/`[recruiting]`
   * animation exists -- the leader's "recruiting" is often not authored, so
   * `anim` can be `undefined`. Without this flag, both the
   * recruiting leader and the newly recruited unit visibly lunged toward
   * each other and back -- the attack/defend convention -- reading as an
   * unwanted "movement" animation playing at the same time as recruitment.
   * Real, reported bug.
   */
  readonly holdInPlace?: boolean;
  /**
   * Real, reported bug ("the move animation between adjacent hexes plays
   * twice on every step"): consecutive same-direction legs of a multi-hex
   * move that share one chosen `anim` using the engine-injected default
   * movement offset (`UnitAnimationDef.usesDefaultMovementOffset`) are
   * grouped by `GameShell.svelte`'s `buildMoveAnimationCues` into ONE cue
   * with `legs` set, instead of one full-duration cue per hex -- mirroring
   * `unit_animator::replace_anim_if_invalid` (animation.cpp ~L1365), which
   * keeps reusing the SAME running "movement" animation instance across
   * hexes rather than restarting it. `playAnimations` samples the whole
   * group with one continuously increasing elapsed clock (so the default
   * offset's repeating 200ms ramp lines up one repeat per hex, and the
   * walk-cycle frame images don't restart every hex either), picking
   * which `legs` entry's `srcHex`/`dstHex`/`direction` to interpolate
   * against via `HEX_STEP_MS`. `srcHex`/`dstHex`/`direction` above still
   * cover the group's first source and last destination (for the no-anim
   * synthetic fallback and the final resting position) when this is set.
   */
  readonly legs?: readonly { srcHex: HexPoint; dstHex: HexPoint; direction: Direction }[];
  /**
   * Phase 19: sounds to start when the hit lands (animation clock 0) on top of
   * the animation's own frame sounds -- the status sounds of a blow that
   * poisons, slows or petrifies (`unit_attack`'s `extra_hit_sounds`).
   */
  readonly extraSounds?: readonly string[];
}

/**
 * The sounds one cue makes, in clock order: its animation's frame sounds (once
 * per leg for a grouped multi-hex move, whose one running animation repeats
 * per hex) and its `extraSounds` at the hit (clock 0).
 */
function soundCuesFor(cue: UnitAnimationCue, legs: number): SoundCue[] {
  const own = cue.anim ? animationSoundCues(cue.anim) : [];
  let cues = own;
  if (cue.anim && legs > 1) {
    const start = cue.anim.startTimeMs;
    cues = [];
    for (let leg = 0; leg < legs; leg++) {
      for (const c of own) if (c.atMs - start < HEX_STEP_MS) cues.push({ atMs: c.atMs + leg * HEX_STEP_MS, files: c.files });
    }
  }
  const extra = (cue.extraSounds ?? []).map((files): SoundCue => ({ atMs: 0, files }));
  return [...cues, ...extra].sort((a, b) => a.atMs - b.atMs);
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
  /** Phase 18: map items' images (`display::draw_overlays_at`, `terrain_bg`): over terrain, under village flags and units, lit by the time of day. */
  private readonly itemLayer = new PIXI.Container();
  /** Map items' halos: upstream's halo manager draws them over everything map-side, untinted -- as the animation overlays here. */
  private readonly itemHaloLayer = new PIXI.Container();
  private itemsUpdate: Promise<void> = Promise.resolve();
  /** Map labels (`terrain_label`, drawn as floating labels over the map): above fog and the time-of-day tint. */
  private readonly labelLayer = new PIXI.Container();
  private readonly highlightLayer = new PIXI.Container();
  /** Reachable hexes' defense numbers: above units and terrain overlays (castle towers, forest canopies), like upstream's `drawing_layer::move_info`. */
  private readonly moveInfoLayer = new PIXI.Container();
  /** The hovered reachable hex's defense-coloured outline (`setHoveredHex`) -- kept apart from `highlightLayer` so pointer movement never rebuilds the whole overlay. */
  private readonly hoverLayer = new PIXI.Container();
  /** Defense per reachable hex (by `x,y`) from the last `setHighlights`, for `setHoveredHex`. */
  private reachableDefense = new Map<string, number>();
  /** The reachable hexes' defense labels (by `x,y`): hidden where the route draws its own (`setRoute`). */
  private reachLabels = new Map<string, PIXI.Text>();
  /** Phase 28b: the route's footprints (`drawing_layer::footsteps`: over the terrain, under units). */
  private readonly footstepLayer = new PIXI.Container();
  /** Phase 28b: the route's turn-end marks -- defense, turn number, ZoC/capture/hidden icons (`drawing_layer::move_info`). */
  private readonly routeInfoLayer = new PIXI.Container();
  /** Hexes (`x,y`) the current route marks. */
  private routeMarkKeys = new Set<string>();
  /** Bumped by every `setRoute`, so a route whose images arrive after a newer one was set is dropped. */
  private routeToken = 0;
  /** Phase 28b: the attack direction indicator (`drawing_layer::attack_indicator`). */
  private readonly attackIndicatorLayer = new PIXI.Container();
  private attackIndicatorToken = 0;
  private hoveredHex: HexPoint | null = null;
  private readonly unitLayer = new PIXI.Container();
  /** `applyStatusFilters`: which status set each sprite's filters were last built for. */
  private readonly statusFilterKeys = new WeakMap<PIXI.Sprite, string>();
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
   * Phase 22: the grid overlay (`prefs::grid`), upstream's two images per
   * hex on their own drawing layers: `grid_top` just over the terrain,
   * `grid_bottom` over the terrain's foreground pieces. Both lie under the
   * time-of-day tint, as upstream draws them `TOD_COLORED`. Built on first
   * use, then only shown or hidden.
   */
  private readonly gridTopLayer = new PIXI.Container();
  private readonly gridBottomLayer = new PIXI.Container();
  private gridBuilt: Promise<void> | null = null;
  /**
   * Holds ONLY the selected-unit ring, added to the stage AFTER
   * `unitLayer` -- see `setHighlights`' doc comment on why this is a
   * separate layer from `highlightLayer` (which stays under `unitLayer`,
   * correctly, for the reachable/attack-target hex fills).
   */
  private readonly selectionLayer = new PIXI.Container();
  /**
   * Fog/shroud hex overlays -- mirrors upstream's `drawing_layer::
   * fog_shroud`, which sits ABOVE every unit layer (so a fogged hex's
   * darkening genuinely covers anything drawn under it) but below
   * `selected_hex`/`attack_indicator` (kept as `selectionLayer` here).
   */
  private readonly fogShroudLayer = new PIXI.Container();
  /**
   * Mirrors upstream's `image::set_color_adjustment` (applied to every
   * `image::TOD_COLORED` blit -- terrain, units, AND the fog/shroud
   * overlay above, matching `drawing_layer::fog_shroud`'s own real ToD
   * tinting): a per-channel additive shift, clamped to [0,255], covering
   * the whole board.
   *
   * This project already has a faithful PER-TEXTURE port of that same
   * formula (`animation/timeOfDay.ts`'s `applyTodTint`, wired into
   * `ImageCache` as the `~TOD(r,g,b)` pseudo-op via `todRef` -- built
   * ahead of this phase but never called). That approach bakes a tinted
   * copy of every distinct terrain/unit texture the ToD touches, cached
   * per (image, ToD) pair; with thousands of terrain images in play (see
   * `renderTerrain`'s own preload cost), re-tinting on every ToD change
   * would mean re-resolving and caching a second full copy of the
   * terrain atlas per schedule entry. Implemented here instead as two
   * full-board rects -- one filled with the positive part of
   * (red,green,blue) drawn with `'add'` blend mode, one with the negative
   * part's absolute value drawn with `'subtract'` -- which reconstructs
   * the exact same per-channel additive/clamp result as a single
   * composite step over whatever's already drawn, with no extra texture
   * memory and no per-texture cache churn. `todRef`/`applyTodTint` remain
   * available (and tested) for a future need this can't cover -- e.g. a
   * `[time_area]`'s own distinct regional tint, which a single board-wide
   * layer can't express without render-target compositing.
   *
   * Sits above `fogShroudLayer` (so fog/shroud get the tint too) and
   * below `selectionLayer` (pure UI chrome, untinted).
   */
  private readonly todTintLayer = new PIXI.Container();
  private readonly todTintPositive = new PIXI.Graphics();
  private readonly todTintNegative = new PIXI.Graphics();
  /**
   * Per-hex terrain containers built once by `renderTerrain`, keyed by
   * `"x,y"` (logical coordinates) -- lets `updateFogShroud` hide a
   * shrouded hex's terrain entirely (mirrors upstream's `draw_hex`: "if
   * is_shrouded, terrain is not drawn at all") without rebuilding it.
   */
  private readonly terrainHexContainers = new Map<string, { bg?: PIXI.Container; fg?: PIXI.Container }>();
  /**
   * Floating damage/heal numerals (`unit_display`'s `float_text`) -- rising,
   * fading red (damage) / green (heal) numbers drawn above a unit's hex.
   * Topmost layer: real Wesnoth's floating labels are a screen-space UI
   * overlay, unaffected by ToD tinting or fog/shroud darkening, same as
   * `selectionLayer`'s own untinted UI chrome.
   */
  private readonly floatingLayer = new PIXI.Container();
  /**
   * Missiles and halos of animations being played (`playAnimations`):
   * above the units and the time-of-day tint (upstream's halos are not
   * lit by the time of day), below the selection ring and floating labels.
   */
  private readonly animationOverlayLayer = new PIXI.Container();
  private units: SnapshotUnit[];
  private readonly teamColor: Map<number, string>;
  /** `[side] flag=` per side (`''` = the default flag). */
  private readonly teamFlag: Map<number, string>;
  /** Village flag animation frames per side and colour -- see `villageFlagFrames`. */
  private readonly flagFrames = new Map<string, Promise<PIXI.FrameObject[]>>();
  /** Each side's flag animation phase, as a fraction of its frames. */
  private readonly flagStart = new Map<number, number>();
  private villageFlagsGeneration = 0;
  /** `x,y` of the hex `setHighlights` last marked selected, whose unit gets the `-selected` ellipse. */
  private selectedHexKey: string | null = null;
  private readonly onHexClick?: (x: number, y: number) => void;
  private readonly onHexHover?: (x: number, y: number, pointerType?: string) => void;
  private readonly onHexRightClick?: (x: number, y: number, clientX: number, clientY: number) => void;
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
  private readonly terrainGraphicsRulesUrl?: string;

  constructor(
    private readonly snapshot: ScenarioSnapshot,
    options: SnapshotBoardOptions = {},
  ) {
    if (options.imageBaseUrl) setImageBaseUrl(options.imageBaseUrl);
    if (options.engineImageBaseUrl) setEngineImageBaseUrl(options.engineImageBaseUrl);
    this.onHexClick = options.onHexClick;
    this.onHexHover = options.onHexHover;
    this.onHexRightClick = options.onHexRightClick;
    this.terrainGraphicsRules = options.terrainGraphicsRules;
    this.terrainGraphicsRulesUrl = options.terrainGraphicsRulesUrl;
    this.units = snapshot.units;
    this.teamColor = new Map(snapshot.teams.map((t) => [t.side, t.color]));
    this.teamFlag = new Map(snapshot.teams.map((t) => [t.side, t.flag ?? '']));
    this.stage.addChild(
      this.terrainLayer,
      this.gridTopLayer,
      this.itemLayer,
      this.villageLayer,
      this.highlightLayer,
      this.footstepLayer,
      this.unitLayer,
      this.terrainForegroundLayer,
      this.gridBottomLayer,
      this.moveInfoLayer,
      this.routeInfoLayer,
      this.hoverLayer,
      this.fogShroudLayer,
      this.todTintLayer,
      this.itemHaloLayer,
      this.labelLayer,
      this.animationOverlayLayer,
      this.selectionLayer,
      this.attackIndicatorLayer,
      this.floatingLayer,
    );
    this.footstepLayer.eventMode = 'none';
    this.routeInfoLayer.eventMode = 'none';
    this.attackIndicatorLayer.eventMode = 'none';
    this.animationOverlayLayer.eventMode = 'none';
    this.gridTopLayer.eventMode = 'none';
    this.gridBottomLayer.eventMode = 'none';
    this.gridTopLayer.visible = false;
    this.gridBottomLayer.visible = false;
    this.itemLayer.eventMode = 'none';
    this.itemHaloLayer.eventMode = 'none';
    this.labelLayer.eventMode = 'none';
    this.moveInfoLayer.eventMode = 'none';
    this.hoverLayer.eventMode = 'none';
    this.todTintPositive.blendMode = 'add';
    // A native blend equation -- see `installSubtractBlend`.
    this.todTintNegative.blendMode = 'subtract';
    this.todTintLayer.addChild(this.todTintPositive, this.todTintNegative);
    this.todTintLayer.eventMode = 'none';
  }

  /**
   * Phase 22: shows or hides the grid overlay (`togglegrid`). Upstream
   * draws it over every hex it draws, the half-hex border included.
   */
  async setGridVisible(visible: boolean): Promise<void> {
    this.gridTopLayer.visible = visible;
    this.gridBottomLayer.visible = visible;
    if (!visible) return;
    this.gridBuilt ??= (async () => {
      const [top, bottom] = await Promise.all([ImageCache.resolve('terrain/grid-top.png'), ImageCache.resolve('terrain/grid-bottom.png')]);
      for (let x = -1; x <= this.snapshot.map.width; x++) {
        for (let y = -1; y <= this.snapshot.map.height; y++) {
          const { x: cx, y: cy } = hexToPixel(toHexCoord(x, y));
          for (const [texture, layer] of [[top, this.gridTopLayer], [bottom, this.gridBottomLayer]] as const) {
            if (!texture) continue;
            const sprite = new PIXI.Sprite(texture);
            sprite.anchor.set(0.5);
            sprite.position.set(cx, cy);
            layer.addChild(sprite);
          }
        }
      }
    })();
    await this.gridBuilt;
  }

  /** Phase 22, for checks: whether the grid overlay is showing, and how many hexes it covers. */
  gridState(): { visible: boolean; hexes: number } {
    return { visible: this.gridTopLayer.visible, hexes: this.gridTopLayer.children.length };
  }

  /**
   * Draws (replacing any previous) the board-wide ToD colour tint from a
   * `[time]` entry's real `red=`/`green=`/`blue=` -- see `todTintLayer`'s
   * own doc comment. Pass `{ red: 0, green: 0, blue: 0 }` (neutral) to
   * clear it. Per-`[time_area]` tinting (a region showing a DIFFERENT
   * tint than the rest of the board) is a deliberate, documented gap --
   * see this method's own doc comment below.
   *
   * NOT implemented: a hex-by-hex `[time_area]` tint. A single full-board
   * filter/overlay can't show two different tints in two regions at once
   * without render-target compositing (drawing the area's own hexes to a
   * separate texture and tinting that in isolation) -- real, but bounded,
   * additional work; the combat/event-filter consequences of
   * `[time_area]` (the part that actually matters for gameplay) are
   * already fully correct via `GameSession.timeOfDayAt`, independent of
   * this visual simplification.
   */
  updateTimeOfDayTint(tod: { red: number; green: number; blue: number }): void {
    const { width, height } = this.snapshot.map;
    const x = -HEX_COL_WIDTH;
    const y = -HEX_ROW_HEIGHT;
    const w = (width + 2) * HEX_COL_WIDTH;
    const h = (height + 2) * HEX_ROW_HEIGHT;

    const { positive, negative } = splitTodTintColors(tod);

    this.todTintPositive.clear();
    if (positive !== 0) this.todTintPositive.rect(x, y, w, h).fill({ color: positive });

    this.todTintNegative.clear();
    if (negative !== 0) this.todTintNegative.rect(x, y, w, h).fill({ color: negative });
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

  /**
   * Click/hover routing for the whole board through ONE interactive
   * object: `terrainLayer` itself, with a rectangular `hitArea` covering the
   * map and `pixelToHex` resolving the hex from the local pointer position.
   * This replaced one interactive `PIXI.Graphics` polygon per hex (1,161 of
   * them on Dead_Water's map) -- with real terrain art those polygons drew
   * nothing yet still cost a display object each, every frame. Routing by
   * hex geometry stays correct regardless of what's drawn on top: a layer's
   * hex-alpha-mask keeps its visible footprint inside the hex it was
   * resolved for (see `terrainPositioning.ts`), and non-interactive sprites
   * (PixiJS default `eventMode`) let pointer events pass straight through.
   */
  private installHitArea(): void {
    if (!this.onHexClick && !this.onHexHover && !this.onHexRightClick) return;
    const onBoard = new Set(this.snapshot.terrain.map((h) => `${h.x},${h.y}`));
    const { width, height } = this.snapshot.map;
    const layer = this.terrainLayer;
    layer.eventMode = 'static';
    layer.hitArea = new PIXI.Rectangle(0, 0, (width + 1) * HEX_COL_WIDTH, (height + 1) * HEX_ROW_HEIGHT);
    // A parent `hitArea` does NOT stop PixiJS from hit-testing children
    // (`EventBoundary.hitTestRecursive` recurses whenever
    // `interactiveChildren` is set) -- without this, every pointermove
    // walked all ~10k terrain sprites/containers.
    layer.interactiveChildren = false;
    if (this.onHexClick) layer.cursor = 'pointer';

    const hexAt = (e: PIXI.FederatedPointerEvent): HexPoint | null => {
      const local = layer.toLocal(e.global);
      const coord = pixelToHex(local.x, local.y);
      const hex = { x: coord.x - 1, y: coord.y - 1 };
      return onBoard.has(`${hex.x},${hex.y}`) ? hex : null;
    };

    if (this.onHexClick) {
      // Real, reported bug: PixiJS's `pointertap` fires on EVERY mouse
      // button's release, not just the left one (confirmed directly in
      // `EventBoundary.mapPointerUp`: it dispatches `rightclick` THEN
      // unconditionally also dispatches `pointertap` for the same
      // release) -- so a right-click meant to only open the context menu
      // was ALSO firing a normal move/select/attack on whatever hex it
      // landed on. `e.button === 0` restricts this to the left button,
      // matching the native DOM `click` event's own convention.
      layer.on('pointertap', (e) => {
        if (e.button !== 0) return;
        const hex = hexAt(e);
        if (hex) this.onHexClick?.(hex.x, hex.y);
      });
    }
    if (this.onHexRightClick) {
      layer.on('rightclick', (e) => {
        const hex = hexAt(e);
        if (hex) this.onHexRightClick?.(hex.x, hex.y, e.clientX, e.clientY);
      });
    }
    if (this.onHexHover) {
      let last: HexPoint | null = null;
      layer.on('pointermove', (e) => {
        const hex = hexAt(e);
        if (!hex || (last && last.x === hex.x && last.y === hex.y)) return;
        last = hex;
        this.onHexHover?.(hex.x, hex.y, e.pointerType);
      });
    }
  }

  /** The terrain as drawn: the snapshot's, until `updateTerrain` replaces it. */
  private terrain: readonly SnapshotTerrainHex[] = [];
  /** The last `updateFogShroud` input, re-applied after a terrain rebuild. */
  private lastFogShroud: readonly FogShroudHex[] = [];
  /** `fogShroudKey` of `lastFogShroud`. */
  private lastFogShroudKey: string | null = null;
  private terrainUpdate: Promise<void> = Promise.resolve();

  /**
   * Redraws the map after WML changed it (`[terrain]`, `[terrain_mask]`):
   * `hexes` is the whole on-board terrain as it now is. The layout is
   * recomputed in full -- terrain_graphics rules look at neighbours, and
   * changes are rare -- and the fog/shroud overlay re-applied on top.
   */
  updateTerrain(hexes: readonly SnapshotTerrainHex[]): Promise<void> {
    this.terrainUpdate = this.terrainUpdate.then(async () => {
      this.terrain = hexes;
      for (const layer of [this.terrainLayer, this.terrainForegroundLayer]) {
        for (const child of layer.removeChildren()) child.destroy({ children: true });
      }
      this.terrainHexContainers.clear();
      await this.drawTerrain();
      this.lastFogShroudKey = null; // the terrain was rebuilt: the overlay must be too
      this.updateFogShroud(this.lastFogShroud);
    });
    return this.terrainUpdate;
  }

  private async renderTerrain(): Promise<void> {
    this.installHitArea();
    this.terrain = this.snapshot.terrain;
    await this.drawTerrain();
  }

  private async drawTerrain(): Promise<void> {
    const { width, height } = this.snapshot.map;
    // Phase 28a P3: measured by apps/web/scripts/measure-load.mjs.
    performance.mark('board:terrain-layout-start');
    const layout =
      this.terrainGraphicsRules && this.terrainGraphicsRules.length > 0
        ? layoutTerrain(this.terrainGraphicsRules, this.terrain, width, height)
        : this.terrainGraphicsRulesUrl
          ? await computeTerrainLayout(this.terrainGraphicsRulesUrl, this.terrain, width, height)
          : null;
    performance.measure('board:terrain-layout', 'board:terrain-layout-start');
    if (!layout) {
      this.renderTerrainFlat();
      return;
    }
    await this.renderTerrainReal(layout);
  }

  /** The pre-Phase-9 flat-coloured placeholder -- see `SnapshotBoardOptions.terrainGraphicsRules`'s own doc comment on when this still applies. */
  private renderTerrainFlat(): void {
    for (const hex of this.terrain) {
      const { x: cx, y: cy } = hexToPixel(toHexCoord(hex.x, hex.y));
      const g = new PIXI.Graphics();
      g.poly(hexCorners(cx, cy).flatMap((p) => [p.x, p.y]));
      g.fill({ color: colorForTerrain(hex.code) });
      g.stroke({ width: 1, color: 0x000000, alpha: 0.15 });
      this.terrainLayer.addChild(g);
    }
  }

  /**
   * Real per-hex `[terrain_graphics]` image compositing (Phase 9): given the
   * map's terrain layout (every hex's layers, including the off-map ring --
   * see `terrain/terrainLayout.ts`), preloads every image reference those
   * layers need, then builds one `makeLayerSprite` per layer -- background
   * layers into `terrainLayer` (under units), foreground layers (rare -- tall
   * structural pieces) into `terrainForegroundLayer` (over units).
   */
  private async renderTerrainReal(layout: TerrainLayout): Promise<void> {
    const perHex = layout.hexes.map((hex) => {
      const { x: cx, y: cy } = hexToPixel(toHexCoord(hex.x, hex.y));
      return { ...hex, cx, cy };
    });

    // Phase 28a P0: measured by apps/web/scripts/measure-load.mjs.
    performance.mark('board:terrain-images-start');
    await ImageCache.preload(layout.refs);
    performance.measure('board:terrain-images', 'board:terrain-images-start');

    // One container per hex per layer -- a grouping only (a future per-hex
    // ToD retint or terrain-change rebuild can target one hex's sprites).
    // NOT for culling: PixiJS's CullerPlugin was tried on exactly this
    // structure and made every frame ~10x slower, while rendering all
    // ~8,700 sprites unculled costs ~2ms of CPU (see GameBoardView).
    const hexContainer = (): PIXI.Container => new PIXI.Container();
    for (const hex of perHex) {
      const key = `${hex.x},${hex.y}`;
      const entry: { bg?: PIXI.Container; fg?: PIXI.Container } = {};
      if (hex.bg.length > 0) {
        const c = hexContainer();
        for (const layer of hex.bg) {
          const sprite = makeLayerSprite(layer, hex.cx, hex.cy);
          if (sprite) c.addChild(sprite);
        }
        this.terrainLayer.addChild(c);
        entry.bg = c;
      }
      if (hex.fg.length > 0) {
        const c = hexContainer();
        for (const layer of hex.fg) {
          const sprite = makeLayerSprite(layer, hex.cx, hex.cy);
          if (sprite) c.addChild(sprite);
        }
        this.terrainForegroundLayer.addChild(c);
        entry.fg = c;
      }
      if (entry.bg || entry.fg) this.terrainHexContainers.set(key, entry);
    }
  }

  /**
   * Draws (replacing any previous) the fog/shroud overlay from `hexes`
   * (typically `GameSession.hexVisibility`) -- hides a shrouded hex's
   * terrain entirely and covers shrouded/fogged hexes with the real
   * void/fog art, plus the directional transition sprites that fade a
   * clear/fogged hex into a more-hidden neighbour (`fogShroud.ts`'s port
   * of `display::get_fog_shroud_images`). Pass `[]` (the common case for
   * a scenario using neither `shroud=` nor `fog=`) to clear any prior
   * overlay and restore full terrain visibility.
   */
  updateFogShroud(hexes: readonly FogShroudHex[]): void {
    // The UI passes the whole list on every sync (a selection, a hover): rebuild only when it changed.
    const key = fogShroudKey(hexes);
    if (key === this.lastFogShroudKey) return;
    // Remembered only once there is terrain to apply it to (an early call, before the board is built, must not
    // make the first real one look unchanged).
    this.lastFogShroudKey = this.terrainHexContainers.size > 0 ? key : null;
    this.lastFogShroud = hexes;
    if (hexes.length === 0) {
      this.fogShroudLayer.removeChildren().forEach((child) => child.destroy());
      for (const c of this.terrainHexContainers.values()) {
        if (c.bg) c.bg.visible = true;
        if (c.fg) c.fg.visible = true;
      }
      return;
    }
    void this.drawFogShroud(hexes);
  }

  /** Async half of `updateFogShroud` -- loads whatever fog/void/transition images this call needs, then swaps the layer in one go. */
  private async drawFogShroud(hexes: readonly FogShroudHex[]): Promise<void> {
    const visAt = new Map<string, FogShroudHex['visibility']>();
    for (const h of hexes) visAt.set(`${h.x},${h.y}`, h.visibility);
    const neighborsOf = (loc: Location): FogShroudHex['visibility'][] =>
      getAdjacentTiles(loc).map((adj) => visAt.get(`${adj.x},${adj.y}`) ?? 'shrouded');

    const perHex: Array<{ cx: number; cy: number; images: string[] }> = [];
    const refs = new Set<string>();
    for (const h of hexes) {
      const key = `${h.x},${h.y}`;
      const containers = this.terrainHexContainers.get(key);
      const shrouded = h.visibility === 'shrouded';
      if (containers?.bg) containers.bg.visible = !shrouded;
      if (containers?.fg) containers.fg.visible = !shrouded;

      const images = hexOverlayImages(h.x, h.y, h.visibility, neighborsOf(new Location(h.x, h.y)), defaultAssetExists);
      if (images.length === 0) continue;
      const { x: cx, y: cy } = hexToPixel(toHexCoord(h.x, h.y));
      perHex.push({ cx, cy, images });
      // These live under `data/core/images/terrain/{fog,void}/`, NOT the
      // separate engine-chrome `images/` root -- no `engine/` prefix (that
      // would route to the wrong physical directory, see `ImageCache.
      // imageUrl`'s own doc comment). `hexedRef`/`~HEXED()` isn't needed
      // either: these are already hex-shaped assets, not larger terrain
      // tiles that need clipping to a hex mask.
      for (const img of images) refs.add(img);
    }

    await ImageCache.preload(refs);

    this.fogShroudLayer.removeChildren().forEach((child) => child.destroy());
    for (const hex of perHex) {
      for (const img of hex.images) {
        const texture = await ImageCache.resolve(img);
        if (!texture) continue;
        const sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5);
        sprite.x = hex.cx;
        sprite.y = hex.cy;
        this.fogShroudLayer.addChild(sprite);
      }
    }
  }

  /**
   * Appends the real `~RC(flagRgb>sideColorId)` team-recolor modifier
   * (`unit::TC_image_mods`) to `imagePath` for `side`, or returns it
   * unmodified if no color data is loaded yet (`ImageCache.setColorData`
   * hasn't run) or the side has no resolvable color id. Shared by
   * `buildUnitVisual` (the static idle sprite) and `playAnimations`
   * (movement/attack/death/recruit animation frames) so both resolve the
   * exact same way -- real, reported bug: animation frames were resolved
   * straight from `sample.imagePath` with no recolor at all, so a unit
   * rendered in its raw reference palette (almost always magenta) for the
   * ENTIRE duration of any animation (most visibly during a death
   * animation, but really any of them), even though its static idle
   * sprite was already correctly recolored.
   */
  private teamColoredRef(imagePath: string, side: number, flagRgb: string | undefined): string {
    const colorId = this.sideColorId(side);
    return colorId ? joinRef(imagePath, `RC(${flagRgb ?? 'magenta'}>${colorId})`) : imagePath;
  }

  /** `team::get_side_color_id`: the side's colour range id (`blue`, `red`, ...), or `''` before the colour data has loaded. */
  private sideColorId(side: number): string {
    const colorData = ImageCache.getColorData();
    const rawColor = this.teamColor.get(side);
    return colorData && rawColor !== undefined ? resolveSideColorId(rawColor, side, colorData.defaultColors) : '';
  }

  /** The side's colour (its range's `mid`) as a number, grey when unknown. */
  private sideColor(side: number): number {
    const rgb = sideColorRgb(ImageCache.getColorData(), this.teamColor.get(side) ?? '', side);
    if (!rgb) return 0xcccccc;
    const [r, g, b] = rgb.split(',').map(Number) as [number, number, number];
    return (r << 16) | (g << 8) | b;
  }

  /**
   * `unit_drawer::draw_ellipses`: the `-top`/`-bottom` ellipse images under
   * the unit, recoloured `~RC(ellipse_red>side colour)`, and drawn over the
   * whole hex. The image name says whether the unit is a leader, emits no
   * zone of control, or is selected -- see `ellipseImageBase`.
   */
  private async updateEllipse(visual: UnitVisual, unit: SnapshotUnit): Promise<void> {
    if (!visual.sprite) return;
    const base = ellipseImageBase(unit, this.selectedHexKey === `${unit.x},${unit.y}`);
    const colorId = this.sideColorId(unit.side);
    const key = base === null ? null : `${base}|${colorId}`;
    if (key === visual.lastEllipseKey) return;
    visual.lastEllipseKey = key;
    const refs = base === null ? [] : ['-top.png', '-bottom.png'].map((part) => (colorId ? joinRef(base + part, `RC(ellipse_red>${colorId})`) : base + part));
    const textures = await Promise.all(refs.map((ref) => ImageCache.resolve(ref)));
    // A newer call (a selection change, a side change) took over meanwhile.
    if (visual.container.destroyed || visual.lastEllipseKey !== key) return;
    for (const child of visual.marker.removeChildren()) child.destroy();
    for (const texture of textures) {
      if (!texture) continue;
      const part = new PIXI.Sprite(texture);
      part.anchor.set(0.5);
      part.width = TILE_SIZE;
      part.height = TILE_SIZE;
      visual.marker.addChild(part);
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
    const marker = new PIXI.Container();
    let sprite: PIXI.Sprite | null = null;

    if (unit.image) {
      // Team recolor: real Wesnoth appends `~RC(flag_rgb>side_color_id)` to
      // every unit sprite at render time (`unit::TC_image_mods`) -- real,
      // reported bug (bugs3.md #3): sprites always rendered in their raw
      // reference palette (almost always magenta), never the unit's side
      // color, because nothing supplied `ImageCache`'s color data/computed
      // this modifier. `getColorData()` returns null (skip the modifier,
      // same as upstream with no color data loaded) until `apps/web` calls
      // `setColorData` once at startup (see `build-team-colors.mjs`).
      const ref = this.teamColoredRef(unit.image, unit.side, unit.flagRgb);
      const texture = await ImageCache.resolve(ref);
      if (texture) {
        sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5, 0.5);
        if (isMirroredFacing(unit.facing)) sprite.scale.x = -Math.abs(sprite.scale.x);
      }
    }

    // Under the sprite: the side-coloured ellipse, filled in by
    // `updateEllipse`. No sprite at all (image missing/unresolvable) -- a
    // plain dot in the side's colour instead, so the unit is still visible
    // and clickable-by-proxy.
    if (sprite) {
      container.addChild(marker, sprite);
    } else {
      marker.addChild(new PIXI.Graphics().circle(0, 0, 16).fill({ color: this.sideColor(unit.side) }));
      container.addChild(marker);
    }

    const bars = new PIXI.Graphics();
    container.addChild(bars);

    return {
      container,
      sprite,
      marker,
      lastEllipseKey: null,
      overlay: null,
      lastImage: unit.image,
      lastSide: unit.side,
      bars,
      crownIcon: null,
      loyalIcon: null,
      orbIcon: null,
      lastOrbRef: null,
      flagRgb: unit.flagRgb,
      lastUnit: unit,
    };
  }

  /**
   * Draws one real energy bar (`units/drawer.cpp`'s `draw_bar`) into `g` at
   * `index` (0 = HP, 1 = XP -- `ENERGY_BAR.spacing` apart), in coordinates
   * local to a unit's container (hex CENTER, not top-left -- `ENERGY_BAR`'s
   * constants are top-left-relative real pixel offsets on a 72px hex, so
   * every coordinate here is shifted by half a tile). Height is clamped the
   * same way real Wesnoth clamps it: the bar's bottom edge never sits
   * closer than `ENERGY_BAR.originY` px from the hex's own bottom edge.
   */
  private drawEnergyBar(g: PIXI.Graphics, index: number, heightPx: number, filled: number, color: number): void {
    const TILE = 72;
    const maxHeight = TILE - 2 * ENERGY_BAR.originY;
    const h = Math.max(0, Math.min(heightPx, maxHeight));
    if (h <= 0) return;
    const left = ENERGY_BAR.originX + ENERGY_BAR.spacing * index - TILE / 2;
    const top = ENERGY_BAR.originY - TILE / 2;
    const w = ENERGY_BAR.width;
    g.rect(left, top, w, h).fill({ color: ENERGY_BAR.borderColor, alpha: ENERGY_BAR.borderAlpha });
    const innerW = w - 2;
    const innerH = h - 2;
    if (innerW <= 0 || innerH <= 0) return;
    g.rect(left + 1, top + 1, innerW, innerH).fill({ color: ENERGY_BAR.backgroundColor, alpha: ENERGY_BAR.backgroundAlpha });
    const filledH = innerH * Math.max(0, Math.min(1, filled));
    if (filledH > 0) {
      g.rect(left + 1, top + 1 + (innerH - filledH), innerW, filledH).fill({ color, alpha: 0.8 });
    }
  }

  /**
   * Redraws `visual.bars` (HP bar, XP bar, moves-left orb) and updates
   * `visual.sprite`'s status tint/grayscale from `unit`'s current real
   * state -- called every `renderUnits` pass, right after position/rebuild
   * bookkeeping, so it always reflects the latest hitpoints/experience/
   * moves/statuses. See `unitOverlays.ts` for the underlying color/
   * threshold math (ported from `units/drawer.cpp`/`unit.cpp`) and its own
   * doc comment for the two deliberate simplifications (orb position isn't
   * pixel-matched to the real `orb.png` asset -- drawn as a plain dot
   * instead, see the module doc comment on why a real image asset wasn't
   * used here; and the moves-orb states are collapsed 4-to-3).
   */
  private updateOverlays(visual: UnitVisual, unit: SnapshotUnit): void {
    visual.bars.clear();

    if (unit.maxHitpoints > 0) {
      const heightPx = energyBarHeight(unit.maxHitpoints, DEFAULT_HP_BAR_SCALING);
      const filled = energyBarFilled(unit.hitpoints, unit.maxHitpoints);
      this.drawEnergyBar(visual.bars, 0, heightPx, filled, hpColor(unit.hitpoints, unit.maxHitpoints));
    }

    // Real visibility gate: `u.experience() > 0 && u.can_advance()` (units/drawer.cpp).
    if (unit.canAdvance && (unit.experience ?? 0) > 0 && unit.maxExperience !== undefined) {
      const level = unit.level ?? 0;
      const heightPx = energyBarHeight(unit.maxExperience, DEFAULT_XP_BAR_SCALING / Math.max(level, 1));
      const experience = unit.experience ?? 0;
      const filled = energyBarFilled(experience, unit.maxExperience);
      const toAdvance = Math.max(0, unit.maxExperience - experience);
      this.drawEnergyBar(visual.bars, 1, heightPx, filled, xpColor(toAdvance));
    }

    // Moves-left orb: see `updateIcons` (needs an async texture resolve/
    // swap for its real, per-status recolor -- unlike the bars above, a
    // cheap synchronous vector redraw).

    if (visual.sprite) {
      this.applyStatusFilters(visual.sprite, unit.statuses ?? []);
    }
  }

  /**
   * Lazily loads and toggles the real leader-crown/loyal-icon overlays --
   * see `UnitVisual.crownIcon`/`loyalIcon`'s own doc comment. Split out
   * from the synchronous `updateOverlays` since these need a real texture
   * load (`ImageCache.resolve`) the bars/tint never do.
   */
  private async updateIcons(visual: UnitVisual, unit: SnapshotUnit): Promise<void> {
    // Moves-left orb: the real `misc/orb.png` asset, recolored to the
    // current MovesOrbStatus's real color id (see ORB_COLOR_ID's own doc
    // comment) and drawn at the same anchor as the crown/loyal icons below
    // -- real, reported bug (bugs3.md #1): a procedurally-drawn dot at a
    // hand-guessed offset used to be drawn here instead, misaligned with
    // those two real, correctly-positioned assets. Handled FIRST (added to
    // `container` before crown/loyal below) to match upstream's own
    // draw-order (`drawer.cpp`'s `textures` vector pushes the orb, then
    // the crown, then overlays/loyal-icon, each later blit landing on top
    // of the earlier ones at the identical destination rect) -- both
    // assets' own artwork sits in roughly the same top-left corner of
    // their 72px canvas, so which one is drawn on top matters.
    if (
      unit.movesLeft !== undefined &&
      unit.maxMoves !== undefined &&
      unit.attacksLeft !== undefined &&
      unit.maxAttacksPerTurn !== undefined
    ) {
      const status = movesOrbStatus(
        unit.movesLeft,
        unit.maxMoves,
        unit.attacksLeft,
        unit.maxAttacksPerTurn,
        unit.canMove ?? unit.movesLeft > 0,
        unit.canAttackHere ?? unit.attacksLeft > 0,
      );
      const ref = joinRef('engine/misc/orb.png', `RC(magenta>${ORB_COLOR_ID[status]})`);
      if (visual.lastOrbRef !== ref) {
        const texture = await ImageCache.resolve(ref);
        if (texture) {
          if (!visual.orbIcon) {
            const sprite = new PIXI.Sprite(texture);
            sprite.anchor.set(0.5, 0.5);
            visual.container.addChild(sprite);
            visual.orbIcon = sprite;
          } else {
            visual.orbIcon.texture = texture;
          }
          visual.orbIcon.visible = true;
        }
        visual.lastOrbRef = ref;
      }
    } else if (visual.orbIcon) {
      visual.orbIcon.visible = false;
      visual.lastOrbRef = null;
    }

    if (unit.canRecruit) {
      if (!visual.crownIcon) {
        const texture = await ImageCache.resolve('engine/misc/leader-crown.png');
        if (texture) {
          const sprite = new PIXI.Sprite(texture);
          sprite.anchor.set(0.5, 0.5);
          visual.container.addChild(sprite);
          visual.crownIcon = sprite;
        }
      }
      if (visual.crownIcon) visual.crownIcon.visible = true;
    } else if (visual.crownIcon) {
      visual.crownIcon.visible = false;
    }

    if (unit.loyal) {
      if (!visual.loyalIcon) {
        const texture = await ImageCache.resolve('misc/loyal-icon.png');
        if (texture) {
          const sprite = new PIXI.Sprite(texture);
          sprite.anchor.set(0.5, 0.5);
          visual.container.addChild(sprite);
          visual.loyalIcon = sprite;
        }
      }
      if (visual.loyalIcon) visual.loyalIcon.visible = true;
    } else if (visual.loyalIcon) {
      visual.loyalIcon.visible = false;
    }
  }

  /**
   * Status looks, as `units/drawer.cpp` draws them: petrified units in
   * greyscale, poisoned/slowed ones blended toward green/pale blue
   * (`statusBlend`). Filters are only rebuilt when the set of statuses
   * changes, keyed per sprite so a rebuilt sprite (new image) gets them
   * again.
   */
  private applyStatusFilters(sprite: PIXI.Sprite, statuses: readonly string[]): void {
    const petrified = statuses.includes('petrified');
    const blend = statusBlend(statuses.includes('poisoned'), statuses.includes('slowed'));
    const key = `${petrified}|${blend ? `${blend.color}/${blend.ratio}` : ''}`;
    if (this.statusFilterKeys.get(sprite) === key) return;
    this.statusFilterKeys.set(sprite, key);
    const filters: PIXI.Filter[] = [];
    if (petrified) {
      const filter = new PIXI.ColorMatrixFilter();
      filter.desaturate();
      filters.push(filter);
    }
    if (blend) {
      const filter = new PIXI.ColorMatrixFilter();
      filter.matrix = blendColorMatrix(blend) as PIXI.ColorMatrix;
      filters.push(filter);
    }
    sprite.filters = filters.length > 0 ? filters : null;
  }

  /**
   * Phase 28b: `game_display::set_route` -- a unit's route from its own hex
   * (`null` clears it). Each hex gets its footprints (`footsteps_images`):
   * two half-hex prints, in and out, in the direction walked, their pace
   * from the unit's movement cost there, or a teleport's marker. Each hex
   * where the route ends a turn, and its last, gets what
   * `draw_movement_info` draws: the unit's defense there, the number of
   * the turn it gets there (except a lone "1" on the destination), and the
   * ZoC, capture and hidden markers.
   */
  setRoute(route: RouteOverlay | null): void {
    const token = ++this.routeToken;
    this.footstepLayer.removeChildren().forEach((child) => child.destroy());
    this.routeInfoLayer.removeChildren().forEach((child) => child.destroy());
    this.routeMarkKeys = new Set(route && route.steps.length >= 2 ? route.marks.map((m) => `${m.x},${m.y}`) : []);
    for (const [key, label] of this.reachLabels) label.visible = !this.routeMarkKeys.has(key);
    if (!route || route.steps.length < 2) return;
    const steps = route.steps.map((s) => new Location(s.x, s.y));
    const last = route.steps[route.steps.length - 1]!;

    const place = (sprite: PIXI.Sprite, x: number, y: number, flip = false): void => {
      const { x: cx, y: cy } = hexToPixel(toHexCoord(x, y));
      sprite.anchor.set(0.5);
      sprite.position.set(cx, cy);
      // `~FL(horiz)~FL(vert)`: a half-turn.
      if (flip) sprite.rotation = Math.PI;
    };
    void (async () => {
      const prints: { ref: string; x: number; y: number; flip: boolean }[] = [];
      route.steps.forEach((step, i) => {
        const pace = Math.min(step.moveCost, FOOTPRINT_PACES.length);
        if (pace < 1) return;
        let teleport: string | null = null;
        // The first hex has only the way out, the last only the way in.
        for (let h = i === 0 ? 1 : 0; h <= (i === steps.length - 1 ? 0 : 1); h++) {
          const from = steps[i + h - 1]!;
          const to = steps[i + h]!;
          if (!tilesAdjacent(from, to)) {
            teleport = h === 0 ? 'engine/footsteps/teleport-in.png' : 'engine/footsteps/teleport-out.png';
            continue;
          }
          let dir = relativeDirection(from, to);
          // Only n/ne/se are drawn; the other three are those turned round.
          const flip = dir > Direction.SouthEast;
          if (flip) dir = (dir + 3) % 6;
          prints.push({ ref: `engine/footsteps/${FOOTPRINT_PACES[pace - 1]}${h === 0 ? '-in' : '-out'}-${writeDirection(dir)}.png`, x: step.x, y: step.y, flip });
        }
        if (teleport) prints.push({ ref: teleport, x: step.x, y: step.y, flip: false });
      });
      const icons = route.marks.flatMap((m) =>
        [m.invisible && 'engine/misc/hidden.png', m.zoc && 'engine/misc/zoc.png', m.capture && 'engine/misc/capture.png']
          .filter((ref): ref is string => !!ref)
          .map((ref) => ({ ref, x: m.x, y: m.y, flip: false })),
      );
      const textures = await Promise.all([...prints, ...icons].map((p) => ImageCache.resolve(p.ref)));
      if (token !== this.routeToken) return;
      [...prints, ...icons].forEach((p, i) => {
        const texture = textures[i];
        if (!texture) return;
        const sprite = new PIXI.Sprite(texture);
        place(sprite, p.x, p.y, p.flip);
        (i < prints.length ? this.footstepLayer : this.routeInfoLayer).addChild(sprite);
      });
    })();

    for (const mark of route.marks) {
      if (mark.x === route.steps[0]!.x && mark.y === route.steps[0]!.y) continue; // the unit stands there
      const { x: cx, y: cy } = hexToPixel(toHexCoord(mark.x, mark.y));
      const defense = new PIXI.Text({
        text: `${mark.defensePercent}%`,
        style: { fontSize: 18, fontWeight: 'bold', fill: redToGreen(mark.defensePercent), stroke: { color: 0x000000, width: 3 } },
      });
      defense.anchor.set(0.5);
      defense.position.set(cx, cy);
      this.routeInfoLayer.addChild(defense);
      const isLast = mark.x === last.x && mark.y === last.y;
      if (mark.turns > 1 || (mark.turns === 1 && !isLast)) {
        const turns = new PIXI.Text({
          text: String(mark.turns),
          style: { fontSize: 17, fontWeight: 'bold', fill: 0xdddddd, stroke: { color: 0x000000, width: 3 } },
        });
        turns.anchor.set(0.5);
        // draw_text_in_hex(..., 0.5, 0.8): below the hex's centre.
        turns.position.set(cx, cy + 0.3 * TILE_SIZE);
        this.routeInfoLayer.addChild(turns);
      }
    }
  }

  /** Phase 28b, for checks: the route drawn now -- its marked hexes and their turn labels. */
  routeState(): { footprints: number; marks: { x: number; y: number; texts: string[] }[] } {
    const marks = [...this.routeMarkKeys].map((key) => {
      const [x, y] = key.split(',').map(Number) as [number, number];
      const { x: cx, y: cy } = hexToPixel(toHexCoord(x, y));
      const texts = this.routeInfoLayer.children
        .filter((c): c is PIXI.Text => c instanceof PIXI.Text && Math.abs(c.x - cx) < 1 && Math.abs(c.y - cy) < TILE_SIZE / 2)
        .map((t) => t.text);
      return { x, y, texts };
    });
    return { footprints: this.footstepLayer.children.length, marks };
  }

  /**
   * Phase 28b: `game_display::set_attack_indicator` -- the arrow pair
   * showing an attack from `src` on `dst` (`misc/attack-indicator-src-*`
   * and `-dst-*`, in the direction from one to the other); `null` hides it.
   */
  setAttackIndicator(indicator: { src: HexPoint; dst: HexPoint } | null): void {
    const token = ++this.attackIndicatorToken;
    this.attackIndicatorLayer.removeChildren().forEach((child) => child.destroy());
    if (!indicator) return;
    const dir = writeDirection(relativeDirection(new Location(indicator.src.x, indicator.src.y), new Location(indicator.dst.x, indicator.dst.y)));
    const parts = [
      { ref: `engine/misc/attack-indicator-src-${dir}.png`, hex: indicator.src },
      { ref: `engine/misc/attack-indicator-dst-${dir}.png`, hex: indicator.dst },
    ];
    void Promise.all(parts.map((p) => ImageCache.resolve(p.ref))).then((textures) => {
      if (token !== this.attackIndicatorToken) return;
      parts.forEach((p, i) => {
        const texture = textures[i];
        if (!texture) return;
        const sprite = new PIXI.Sprite(texture);
        const { x: cx, y: cy } = hexToPixel(toHexCoord(p.hex.x, p.hex.y));
        sprite.anchor.set(0.5);
        sprite.position.set(cx, cy);
        this.attackIndicatorLayer.addChild(sprite);
      });
    });
  }

  /** Phase 28b, for checks: the hexes the attack indicator is drawn on (source first), or `null`. */
  attackIndicatorState(): number {
    return this.attackIndicatorLayer.children.length;
  }

  /**
   * The hex under the pointer (or `null`): if it is one of the reachable
   * hexes, it is outlined in the colour of the unit's defense there, as
   * upstream marks the hovered destination (bugs6.md).
   */
  setHoveredHex(hex: HexPoint | null): void {
    if (this.hoveredHex?.x === hex?.x && this.hoveredHex?.y === hex?.y) return;
    this.hoveredHex = hex;
    this.drawHoverOutline();
  }

  private drawHoverOutline(): void {
    this.hoverLayer.removeChildren().forEach((child) => child.destroy());
    const hex = this.hoveredHex;
    const defense = hex ? this.reachableDefense.get(`${hex.x},${hex.y}`) : undefined;
    if (!hex || defense === undefined) return;
    const { x: cx, y: cy } = hexToPixel(toHexCoord(hex.x, hex.y));
    const outline = new PIXI.Graphics();
    outline.poly(hexCorners(cx, cy).flatMap((p) => [p.x, p.y]));
    outline.stroke({ width: 3, color: redToGreen(defense), alpha: 1 });
    this.hoverLayer.addChild(outline);
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
  /**
   * Creates (if missing), updates, and positions the single `UnitVisual`
   * for `unit` -- the per-unit body `renderUnits()`'s own loop uses,
   * pulled out so `ensureUnitVisual` (below) can create just ONE unit's
   * visual on demand, without touching any other unit's state the way a
   * full `renderUnits()` pass would.
   */
  private async updateOneUnit(unit: SnapshotUnit, options: { hidden?: boolean } = {}): Promise<UnitVisual> {
    const key = spriteKey(unit);
    const coord = toHexCoord(unit.x, unit.y);
    const { x: cx, y: cy } = hexToPixel(coord);

    let visual = this.unitVisuals.get(key);
    if (!visual) {
      visual = await this.buildUnitVisual(unit);
      // Hidden from the start: its ellipse and icons still load below, with the container on stage.
      if (options.hidden) visual.container.visible = false;
      this.unitVisuals.set(key, visual);
      this.unitLayer.addChild(visual.container);
    } else if (visual.lastImage !== unit.image || visual.lastSide !== unit.side) {
      visual.container.removeChildren();
      const rebuilt = await this.buildUnitVisual(unit);
      visual.container.addChild(...rebuilt.container.removeChildren());
      visual.sprite = rebuilt.sprite;
      visual.marker = rebuilt.marker;
      visual.lastEllipseKey = null;
      visual.bars = rebuilt.bars;
      visual.overlay = null; // the old overlay sprite (if any) was just destroyed along with its old container children.
      visual.crownIcon = null; // ditto for the crown/loyal/orb icons, if any.
      visual.loyalIcon = null;
      visual.orbIcon = null;
      visual.lastOrbRef = null;
      visual.lastImage = unit.image;
      visual.lastSide = unit.side;
    }
    if (visual.overlay) visual.overlay.alpha = 0; // a hit-flash should never outlive the animation that caused it.
    visual.lastUnit = unit;
    await this.updateEllipse(visual, unit);
    if (visual.container.destroyed) return visual;
    this.updateOverlays(visual, unit);
    await this.updateIcons(visual, unit);
    // Defensive: `updateIcons` just awaited (a real texture load, in the
    // worst case), during which a CONCURRENT `renderUnits()`/`updateUnits()`
    // pass built from an older `this.units` snapshot (one that predates
    // `unit` even existing -- e.g. `GameShell`'s reactive `units` prop
    // update firing again before this call finished) could have already
    // destroyed this very container as "not in its own snapshot" (see
    // `ensureUnitVisual`'s own doc comment for the concrete real bug this
    // guards against). Bail out rather than crash setting properties on a
    // dead container -- the concurrent pass already removed this entry
    // from `unitVisuals` too, so there's nothing left to keep correct.
    if (visual.container.destroyed) return visual;
    visual.container.x = cx;
    visual.container.y = cy;
    if (visual.sprite) {
      // Real, reported bug: this used to unconditionally reset to the
      // unmirrored orientation ("undo any hflip a prior animation left
      // behind"), regardless of `unit.facing` -- so the idle sprite
      // never actually mirrored to face the unit's last move/attack
      // direction, even though it correctly reset any IN-PROGRESS
      // animation's hflip once that animation finished. Now settles on
      // whichever orientation `unit.facing` actually calls for.
      const mirrored = isMirroredFacing(unit.facing);
      visual.sprite.scale.x = mirrored ? -Math.abs(visual.sprite.scale.x) : Math.abs(visual.sprite.scale.x);
    }
    return visual;
  }

  /**
   * Creates (or updates/repositions, if it somehow already exists) the
   * visual for exactly one unit RIGHT NOW, ahead of the next full
   * `updateUnits()`/`renderUnits()` pass -- real, reported bug (bugs5.md
   * #3): a just-recruited unit has no visual at all until that deferred
   * pass runs (only after `GameShell` finishes playing back the WHOLE
   * rest of a turn's animations, batched -- see `playAiAnimations`'s own
   * doc comment), so its own "recruited" animation cue silently did
   * nothing at all (`playAnimationSequence` filters out any cue whose
   * `key` has no existing visual, see its own doc comment) -- only the
   * recruiting LEADER's half of the pair (its visual already existed)
   * ever played, and the new unit simply popped into existence later,
   * all at once with every other unit recruited that same turn. Callers
   * should call this for a newly-recruited/recalled unit BEFORE playing
   * its recruit animation cue, mirroring `previewHitpoints`/
   * `spawnFloatingNumber`/`removeUnitVisual`'s "poke the renderer
   * directly, don't wait for the deferred sync" convention.
   */
  async ensureUnitVisual(unit: SnapshotUnit, options: { hidden?: boolean } = {}): Promise<void> {
    const visual = await this.updateOneUnit(unit, options);
    // `unit_recruited`: the new unit stays hidden (`set_hidden(true)`) while the view scrolls to it and its
    // frames load, and appears with the first frame of its "recruited" animation -- not standing there first.
    if (options.hidden && !visual.container.destroyed) visual.container.visible = false;
  }

  private async renderUnits(): Promise<void> {
    const seen = new Set<string>();

    for (const unit of this.units) {
      seen.add(spriteKey(unit));
      const visual = await this.updateOneUnit(unit);
      // A recruit hidden for its animation (`ensureUnitVisual`) is shown by the next full pass at the latest.
      if (!visual.container.destroyed) visual.container.visible = true;
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
  /**
   * Phase 19: where the sounds of animations being played go -- each frame's
   * `sound=` when the frame starts (`unit_frame::redraw`'s `on_start_time`),
   * plus a cue's `extraSounds`. The audio itself lives in `packages/ui`.
   */
  soundSink: ((files: string) => void) | null = null;

  /**
   * Skip Animation: every animation playing now jumps to its end (and plays no more sounds); later
   * `playAnimations` calls play normally.
   */
  skipAnimations(): void {
    this.skipGeneration++;
  }

  private skipGeneration = 0;

  async playAnimations(cues: readonly UnitAnimationCue[], defaultDurationMs = 400, speedMultiplier = 1): Promise<void> {
    const skipAt = this.skipGeneration;
    const active = cues
      .map((cue) => {
        const visual = this.unitVisuals.get(cue.key);
        if (!visual) return null;
        const src = hexToPixel(toHexCoord(cue.srcHex.x, cue.srcHex.y));
        const dst = hexToPixel(toHexCoord(cue.dstHex.x, cue.dstHex.y));
        // One `HEX_STEP_MS` per grouped leg (see `UnitAnimationCue.legs`'
        // own doc comment) instead of the whole anim's frame-cycle
        // duration -- that's what makes each hex get exactly one repeat
        // of the default offset's ramp rather than however many fit in
        // one leg's full playback.
        const legPixels = cue.legs?.map((leg) => ({
          src: hexToPixel(toHexCoord(leg.srcHex.x, leg.srcHex.y)),
          dst: hexToPixel(toHexCoord(leg.dstHex.x, leg.dstHex.y)),
          direction: leg.direction,
        }));
        const grouped = legPixels !== undefined && legPixels.length > 0;
        const timeline = cue.anim && !grouped ? animationTimeline(cue.anim) : null;
        return { cue, visual, src, dst, legPixels, grouped, timeline };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    if (active.length === 0) return;

    // bugs6.md (particles): every animation of a beat runs on one clock on
    // which hits land at 0 -- `unit_animator::start_animations` starts them
    // all at the earliest `begin=` among them, so an attack's missile
    // arrives, and the defender flinches, on the blow. `clockStart` is that
    // earliest start; grouped movement cues keep their own 0-based clock.
    const timelines = active.flatMap((a) => (a.timeline ? [a.timeline] : []));
    const clockStart = timelines.length > 0 ? Math.min(...timelines.map((t) => t.startMs)) : 0;
    const timed = active.map((a) => {
      const internalMs = a.grouped
        ? a.legPixels!.length * HEX_STEP_MS
        : a.timeline
          ? a.timeline.endMs - clockStart
          : defaultDurationMs;
      return { ...a, duration: Math.max(1, internalMs / speedMultiplier), sounds: soundCuesFor(a.cue, a.grouped ? a.legPixels!.length : 0), nextSound: 0 };
    });

    // Pre-resolve every real texture this playback will need up front, so
    // no frame swap stalls on a still-loading image mid-animation.
    // Phase 28a P0: the time this takes is an animation's start latency (measure-load.mjs).
    performance.mark('anim:frames-start');
    const isDiagonal = (d: Direction): boolean =>
      d === Direction.NorthEast || d === Direction.SouthEast || d === Direction.NorthWest || d === Direction.SouthWest;
    const overlayTextures = await this.preloadOverlayImages(active.flatMap((a) => (a.cue.anim ? [a.cue.anim] : [])));
    for (const { cue, visual, legPixels } of active) {
      if (!cue.anim) continue;
      const paths = new Set<string>();
      // A grouped multi-leg cue (see `UnitAnimationCue.legs`) can switch
      // direction leg to leg (e.g. a WML-authored s/se/sw bucket covers
      // all three) -- preload for every direction actually used, not just
      // the cue's own first-leg `direction`.
      const diagonalUsed = new Set<boolean>([isDiagonal(cue.direction), ...(legPixels?.map((l) => isDiagonal(l.direction)) ?? [])]);
      for (const frame of cue.anim.frames) {
        for (const diagonal of diagonalUsed) {
          const seq = diagonal && frame.imageDiagonal.length > 0 ? frame.imageDiagonal : frame.image;
          for (const step of seq) paths.add(step.value);
        }
      }
      await Promise.all([...paths].map((p) => ImageCache.resolve(this.teamColoredRef(p, visual.lastSide, visual.flagRgb))));
    }
    performance.measure('anim:frames', 'anim:frames-start');

    const totalMs = Math.max(...timed.map((a) => a.duration));
    const start = performance.now();
    const overlayPool: PIXI.Sprite[] = [];

    await new Promise<void>((resolve) => {
      const tick = async (): Promise<void> => {
        const skipped = this.skipGeneration !== skipAt;
        const elapsed = skipped ? totalMs : performance.now() - start;
        const overlays: OverlaySample[] = [];

        for (const entry of timed) {
          const { cue, visual, src, dst, legPixels, duration, grouped } = entry;
          // A visual replaced mid-animation (the unit changed or left -- e.g.
          // the dialogue it plays under was advanced): nothing left to move.
          // Touching it would throw and leave this promise unresolved.
          if (visual.container.destroyed) continue;
          const t = Math.min(elapsed, duration);
          // Phase 19: frame sounds start when their frame first draws.
          const soundClock = grouped && cue.anim ? t * speedMultiplier + cue.anim.startTimeMs : clockStart + t * speedMultiplier;
          while (entry.nextSound < entry.sounds.length && entry.sounds[entry.nextSound]!.atMs <= soundClock) {
            if (!skipped) this.soundSink?.(entry.sounds[entry.nextSound]!.files);
            entry.nextSound++;
          }
          if (cue.anim) {
            // `t` is wall-clock time (already compressed by speedMultiplier);
            // scale it back up to the animation's own real internal
            // timeline so a real anim's frame/offset progression plays
            // faster, not truncated -- see this method's own doc comment.
            // `absT` is that time on the shared clock (see `clockStart`);
            // `animT` the same relative to this animation's own `[frame]`s.
            const absT = grouped ? t * speedMultiplier + cue.anim.startTimeMs : clockStart + t * speedMultiplier;
            const animT = Math.max(0, absT - cue.anim.startTimeMs);
            // A grouped multi-leg cue samples ONE continuously-running
            // animation across every hex (see `UnitAnimationCue.legs`'
            // own doc comment) -- `animT` keeps counting up across the
            // whole group (so the default offset's ramp and the frame
            // images both progress naturally, exactly as the single
            // reused instance they're modelling would), but which hex
            // pair to interpolate position against switches every
            // `HEX_STEP_MS`.
            let curSrc = src;
            let curDst = dst;
            let curDirection = cue.direction;
            if (legPixels && legPixels.length > 0) {
              const legIndex = Math.min(Math.floor(animT / HEX_STEP_MS), legPixels.length - 1);
              const leg = legPixels[legIndex]!;
              curSrc = leg.src;
              curDst = leg.dst;
              curDirection = leg.direction;
            }
            const sample = sampleAnimation(cue.anim, curDirection, animT, curSrc, curDst);
            if (sample.imagePath) {
              const texture = await ImageCache.resolve(this.teamColoredRef(sample.imagePath, visual.lastSide, visual.flagRgb));
              if (visual.container.destroyed) continue;
              if (texture && visual.sprite && visual.sprite.texture !== texture) visual.sprite.texture = texture;
            }
            if (visual.sprite) {
              visual.sprite.scale.x = sample.hflip ? -Math.abs(visual.sprite.scale.x) : Math.abs(visual.sprite.scale.x);
              visual.sprite.alpha = sample.alpha;
            }
            visual.container.x = sample.x;
            visual.container.y = sample.y;
            this.applyBlend(visual, sample.blendRatio, sample.blendColor);
            // Upstream takes a frame's facing from src->dst, so an in-place
            // animation has none (no mirroring of its halos).
            const inPlace = curSrc.x === curDst.x && curSrc.y === curDst.y;
            const overlayDirection = inPlace ? Direction.Indeterminate : curDirection;
            const halo = sampleUnitHalo(cue.anim, overlayDirection, absT, sample);
            if (halo) overlays.push(halo);
            overlays.push(...sampleParticles(cue.anim, overlayDirection, absT, curSrc, curDst));
          } else if (!cue.holdInPlace && (cue.srcHex.x !== cue.dstHex.x || cue.srcHex.y !== cue.dstHex.y)) {
            // No real anim: a synthetic beat appropriate to what this cue
            // means. `restAt: 'dst'` (movement) glides straight there,
            // offset 0 -> 1 over the full duration; the default (`'src'`,
            // an attack lunge/reaction) bounces out partway and back:
            // 0 -> 0.35 -> 0. `holdInPlace` (recruit cues) skips this
            // entirely -- see its own doc comment.
            const offset =
              cue.restAt === 'dst'
                ? t / duration
                : t <= duration / 2
                  ? (t / (duration / 2)) * 0.35
                  : 0.35 * (1 - (t - duration / 2) / (duration / 2));
            visual.container.x = offset * dst.x + (1 - offset) * src.x;
            visual.container.y = offset * dst.y + (1 - offset) * src.y;
          }
          // A recruit is kept hidden until its animation draws (see `ensureUnitVisual`) -- shown only
          // once this frame's image and alpha are on it.
          visual.container.visible = true;
        }

        this.drawOverlays(overlayPool, elapsed >= totalMs ? [] : overlays, overlayTextures);

        if (elapsed >= totalMs) {
          for (const sprite of overlayPool) sprite.destroy();
          // Settle each sprite at its own real resting hex -- `dst` for a
          // `restAt: 'dst'` cue (movement: the unit's real new hex), `src`
          // otherwise (attack: both the attacker's lunge-and-return and
          // the defender's in-place reaction end where they started).
          for (const { cue, visual, src, dst } of active) {
            if (visual.container.destroyed) continue;
            const rest = cue.restAt === 'dst' ? dst : src;
            visual.container.x = rest.x;
            visual.container.y = rest.y;
            visual.container.visible = true;
            if (visual.sprite) visual.sprite.alpha = 1;
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

  /** Every missile/halo image `anims` can show (see `sampleParticles`/`sampleUnitHalo`), fetched up front so no frame waits on the network. */
  private async preloadOverlayImages(anims: readonly UnitAnimationDef[]): Promise<Map<string, PIXI.Texture>> {
    const paths = new Set<string>();
    const addSteps = (steps: readonly { value: string }[], mod: string): void => {
      for (const step of steps) paths.add(mod ? `${step.value}${mod}` : step.value);
    };
    for (const anim of anims) {
      for (const frame of anim.frames) addSteps(frame.halo, frame.haloMod || anim.animationParams.haloMod);
      addSteps(anim.animationParams.halo, anim.animationParams.haloMod);
      for (const p of anim.particles) {
        addSteps(p.params.halo, p.params.haloMod);
        for (const frame of p.frames) {
          addSteps(frame.image, frame.imageMod || p.params.imageMod);
          addSteps(frame.imageDiagonal, frame.imageMod || p.params.imageMod);
          addSteps(frame.halo, frame.haloMod || p.params.haloMod);
        }
      }
    }
    const textures = new Map<string, PIXI.Texture>();
    await Promise.all(
      [...paths].map(async (path) => {
        const texture = await ImageCache.resolve(path);
        if (texture) textures.set(path, texture);
      }),
    );
    return textures;
  }

  /** Debug: the missiles/halos drawn on the latest animation frame (see `drawOverlays`). */
  lastAnimationOverlays: readonly OverlaySample[] = [];

  /** Shows `overlays` using (and growing) `pool`, one sprite each, hiding the rest. Images that failed to load are skipped. */
  private drawOverlays(pool: PIXI.Sprite[], overlays: readonly OverlaySample[], textures: ReadonlyMap<string, PIXI.Texture>): void {
    this.lastAnimationOverlays = overlays.filter((o) => textures.has(o.path));
    let used = 0;
    for (const overlay of overlays) {
      const texture = textures.get(overlay.path);
      if (!texture) continue;
      let sprite = pool[used];
      if (!sprite) {
        sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5, 0.5);
        this.animationOverlayLayer.addChild(sprite);
        pool.push(sprite);
      }
      sprite.texture = texture;
      sprite.position.set(overlay.x, overlay.y);
      sprite.scale.set(overlay.hflip ? -1 : 1, overlay.vflip ? -1 : 1);
      sprite.visible = true;
      used++;
    }
    for (let i = used; i < pool.length; i++) pool[i]!.visible = false;
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
   * Redraws `key`'s HP bar (and, incidentally, its XP bar/orb, since all
   * three share one `Graphics` object -- see `updateOverlays`) using
   * `hitpoints` instead of whatever `renderUnits` last drew it with,
   * without touching the live `SnapshotUnit` data `this.units` holds.
   * Real, reported bug: the HP bar only ever updated once, after a whole
   * attack's exchange fully resolved, instead of after each individual
   * blow the way real Wesnoth's `unit_display` does -- a caller stepping
   * through `AttackBlowResult[]` (`GameShell.svelte`'s combat animation
   * playback, between beats) calls this once per blow with the running
   * post-blow hitpoints total for whichever combatant it just hit.
   * No-ops if `key` isn't currently on screen (e.g. it died on an earlier
   * blow this same exchange).
   */
  previewHitpoints(key: string, hitpoints: number): void {
    const visual = this.unitVisuals.get(key);
    if (!visual) return;
    const clamped = Math.max(0, Math.min(visual.lastUnit.maxHitpoints, hitpoints));
    this.updateOverlays(visual, { ...visual.lastUnit, hitpoints: clamped });
  }

  /**
   * Spawns one floating numeral (`unit_display`'s `float_text`) above
   * `key`'s current hex -- red for damage, green for heal, rising and
   * fading out over `durationMs`. Fire-and-forget: does not block the
   * caller or the main animation playback loop (real Wesnoth's own
   * floating labels are likewise decorative, not something combat
   * resolution waits on). No-ops if `key` isn't currently on screen.
   */
  spawnFloatingNumber(key: string, amount: number, kind: 'damage' | 'heal', durationMs = 1000): void {
    if (amount === 0) return;
    const visual = this.unitVisuals.get(key);
    if (!visual) return;
    const text = new PIXI.Text({
      text: kind === 'damage' ? `-${Math.abs(amount)}` : `+${Math.abs(amount)}`,
      style: {
        fontSize: 20,
        fontWeight: 'bold',
        fill: kind === 'damage' ? 0xe23b3b : 0x3fdf6a,
        stroke: { color: 0x000000, width: 3 },
      },
    });
    text.anchor.set(0.5, 1);
    const startX = visual.container.x;
    const startY = visual.container.y - TILE_SIZE * 0.3;
    text.position.set(startX, startY);
    this.floatingLayer.addChild(text);

    const start = performance.now();
    const rise = TILE_SIZE * 0.6;
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - start) / durationMs);
      text.position.y = startY - rise * t;
      text.alpha = 1 - t;
      if (t >= 1) {
        this.floatingLayer.removeChild(text);
        text.destroy();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /**
   * C1: `game_display::float_label` (`[floating_text]`, `wesnoth.interface.float_label`): `text` rising from
   * the middle of the top edge of hex (`x`, `y`) at 100 px a second, for a second, then gone (no fade:
   * `set_lifetime(lifetime, 0)`). `SIZE_FLOAT_LABEL` (24), outlined, in `color`. Board coordinates, so size
   * and speed follow the zoom as upstream's do.
   */
  spawnHexLabel(x: number, y: number, text: string, color: number): void {
    if (text === '') return;
    const { x: cx, y: cy } = hexToPixel(toHexCoord(x, y));
    const label = new PIXI.Text({
      text,
      style: { fontSize: 24, fill: color, stroke: { color: 0x000000, width: 3 }, align: 'center' },
    });
    label.anchor.set(0.5, 0);
    const startY = cy - HEX_ROW_HEIGHT / 2;
    label.position.set(cx, startY);
    this.floatingLayer.addChild(label);
    const lifetimeMs = 1000;
    const start = performance.now();
    const tick = (): void => {
      if (label.destroyed) return;
      const elapsed = performance.now() - start;
      if (elapsed >= lifetimeMs) {
        this.floatingLayer.removeChild(label);
        label.destroy();
        return;
      }
      label.position.y = startY - 0.1 * elapsed;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /**
   * Immediately destroys and removes `key`'s unit visual, if it's
   * currently on screen -- the same "poke the renderer directly, don't
   * wait for the next full `updateUnits()`" convention as
   * `previewHitpoints`/`spawnFloatingNumber` above. Real, reported bug
   * (bugs4.md #3): during an AI turn's animation playback (`GameShell.
   * playAiAnimations`), every action's board-state mutation already
   * happened before ANY of that turn's animations start playing (see
   * `AiAction.animation`'s own doc comment) -- so a unit that died on an
   * EARLY event kept its stale sprite on screen through every LATER
   * event's animation too, only actually disappearing at the single
   * `sync()` call after the whole turn finishes. If a later event's own
   * unit happened to move onto or through that same hex, the two sprites
   * visually overlapped, reading as "units standing on the same hex".
   * Calling this the instant a death animation finishes playing removes
   * the stale sprite right away instead of leaving it for the deferred
   * sync. No-ops if `key` isn't currently on screen (already gone, or
   * never existed).
   */
  /**
   * Where every unit sprite actually is on the board right now, keyed by
   * `spriteKey` -- the live container position, mid-animation included.
   * For debugging movement glitches ("it jumps back and forth"): sampled
   * over time this turns an impression into a list of positions. Exposed
   * through `window.__wesnothDebug` in dev builds only.
   */
  unitSpritePositions(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    for (const [key, visual] of this.unitVisuals) {
      out[key] = [Math.round(visual.container.x), Math.round(visual.container.y)];
    }
    return out;
  }

  /** Debug: each unit sprite's visibility, alpha, image and position -- for checking when a unit shows. */
  unitSpriteStates(): Record<string, { visible: boolean; alpha: number; image: string; x: number; y: number }> {
    const out: Record<string, { visible: boolean; alpha: number; image: string; x: number; y: number }> = {};
    for (const [key, visual] of this.unitVisuals) {
      if (visual.container.destroyed) continue;
      const source = visual.sprite?.texture?.source as { label?: string; resource?: { src?: string } } | undefined;
      out[key] = {
        visible: visual.container.visible,
        alpha: Math.round((visual.sprite?.alpha ?? 1) * 100) / 100,
        image: source?.label ?? source?.resource?.src?.slice(-60) ?? '',
        x: Math.round(visual.container.x),
        y: Math.round(visual.container.y),
      };
    }
    return out;
  }

  /** Debug: how many filters each unit sprite carries (status looks -- see `applyStatusFilters`). */
  unitSpriteFilterCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, visual] of this.unitVisuals) {
      const filters = visual.sprite?.filters;
      out[key] = Array.isArray(filters) ? filters.length : filters ? 1 : 0;
    }
    return out;
  }

  removeUnitVisual(key: string): void {
    const visual = this.unitVisuals.get(key);
    if (!visual) return;
    this.unitLayer.removeChild(visual.container);
    visual.container.destroy({ children: true });
    this.unitVisuals.delete(key);
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
  /**
   * Phase 18: draws (replacing any previous) the map items, already
   * filtered for what the viewing side sees and ordered for drawing. An
   * image fills its hex's tile rect (upstream blits it to the hex's
   * destination rect); a halo is centred on the hex at its own size and
   * cycles its frames (`name:ms`, 100 ms when unspecified, as `halo.cpp`).
   * `submerge=` is not drawn (items show whole).
   */
  updateItems(items: readonly MapItemPoint[]): Promise<void> {
    this.itemsUpdate = this.itemsUpdate.then(async () => {
      const refs = new Set<string>();
      const halos = items.map((item) => (item.halo ? parseHaloFrames(item.halo) : []));
      for (const item of items) if (item.image) refs.add(item.image);
      for (const frames of halos) for (const f of frames) refs.add(f.image);
      await ImageCache.preload(refs);
      for (const layer of [this.itemLayer, this.itemHaloLayer]) {
        for (const child of layer.removeChildren()) child.destroy();
      }
      for (const [i, item] of items.entries()) {
        const { x: cx, y: cy } = hexToPixel(toHexCoord(item.x, item.y));
        if (item.image) {
          const texture = await ImageCache.resolve(item.image);
          if (texture) {
            const sprite = new PIXI.Sprite(texture);
            sprite.anchor.set(0.5);
            sprite.position.set(cx, cy);
            sprite.width = TILE_SIZE;
            sprite.height = TILE_SIZE;
            this.itemLayer.addChild(sprite);
          }
        }
        const frames: PIXI.FrameObject[] = [];
        for (const f of halos[i]!) {
          const texture = await ImageCache.resolve(f.image);
          if (texture) frames.push({ texture, time: f.durationMs });
        }
        if (frames.length === 1) {
          const sprite = new PIXI.Sprite(frames[0]!.texture);
          sprite.anchor.set(0.5);
          sprite.position.set(cx, cy);
          this.itemHaloLayer.addChild(sprite);
        } else if (frames.length > 1) {
          const sprite = new PIXI.AnimatedSprite(frames);
          sprite.anchor.set(0.5);
          sprite.position.set(cx, cy);
          sprite.play();
          this.itemHaloLayer.addChild(sprite);
        }
      }
    });
    return this.itemsUpdate;
  }

  /**
   * Phase 18: draws (replacing any previous) the map labels the viewing
   * side sees. As `terrain_label::recalculate`: centred on the hex, its
   * middle `SIZE_NORMAL` above the hex's bottom edge, in the normal font
   * size, in the label's colour. Pango markup is shown as plain text.
   */
  updateLabels(labels: readonly MapLabelPoint[]): void {
    for (const child of this.labelLayer.removeChildren()) child.destroy();
    for (const label of labels) {
      const { x: cx, y: cy } = hexToPixel(toHexCoord(label.x, label.y));
      const [r, g, b] = label.color.split(',').map(Number) as [number, number, number];
      const text = new PIXI.Text({
        text: label.text.replace(/<[^>]*>/g, ''),
        style: {
          fontFamily: 'sans-serif',
          fontSize: LABEL_FONT_SIZE,
          fill: (r << 16) | (g << 8) | b,
          stroke: { color: 0x000000, width: 3 },
          align: 'center',
          wordWrap: true,
          wordWrapWidth: LABEL_FONT_SIZE * 13,
        },
      });
      text.anchor.set(0.5);
      text.position.set(cx, cy + TILE_SIZE / 2 - LABEL_FONT_SIZE);
      this.labelLayer.addChild(text);
    }
  }

  updateVillageOwnership(owners: readonly VillageOwnerPoint[]): Promise<void> {
    const generation = ++this.villageFlagsGeneration;
    return (async () => {
      const framesBySide = new Map<number, PIXI.FrameObject[]>();
      for (const side of new Set(owners.map((v) => v.side))) framesBySide.set(side, await this.villageFlagFrames(side));
      if (generation !== this.villageFlagsGeneration) return; // a newer ownership update replaced this one
      for (const child of this.villageLayer.removeChildren()) child.destroy();
      for (const v of owners) {
        const frames = framesBySide.get(v.side) ?? [];
        if (frames.length === 0) continue;
        const { x: cx, y: cy } = hexToPixel(toHexCoord(v.x, v.y));
        const flag = new PIXI.AnimatedSprite(frames);
        flag.anchor.set(0.5);
        flag.position.set(cx, cy);
        flag.width = TILE_SIZE;
        flag.height = TILE_SIZE;
        // One phase per side, as upstream animates one flag per side.
        flag.gotoAndPlay(this.flagStartFrame(v.side, frames.length));
        if (frames.length === 1) flag.stop();
        this.villageLayer.addChild(flag);
      }
    })();
  }

  /**
   * `display::reinit_flags_for_team`: the side's `[side] flag=` animation (by
   * default `game_config::images::flag`, `flags/flag-[1~4].png:150`), each
   * frame recoloured `~RC(flag_rgb>side colour)`.
   */
  private villageFlagFrames(side: number): Promise<PIXI.FrameObject[]> {
    const colorId = this.sideColorId(side);
    const key = `${side}|${colorId}`;
    let frames = this.flagFrames.get(key);
    if (!frames) {
      const flag = this.teamFlag.get(side) || DEFAULT_FLAG;
      frames = Promise.all(
        squareParentheticalSplit(flag).map(async (item) => {
          const parts = item.split(':');
          const image = parts.length > 1 ? parts[0]! : item;
          const time = parts.length > 1 ? Math.max(1, Number.parseInt(parts[parts.length - 1]!, 10) || 100) : 100;
          const texture = await ImageCache.resolve(colorId ? joinRef(image, `RC(${FLAG_RGB}>${colorId})`) : image);
          return texture ? { texture, time } : null;
        }),
      ).then((list) => list.filter((f): f is PIXI.FrameObject => f !== null));
      this.flagFrames.set(key, frames);
    }
    return frames;
  }

  private flagStartFrame(side: number, frameCount: number): number {
    let start = this.flagStart.get(side);
    if (start === undefined) {
      start = Math.random();
      this.flagStart.set(side, start);
    }
    return Math.floor(start * frameCount);
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
    const selectedKey = state.selected ? `${state.selected.x},${state.selected.y}` : null;
    if (selectedKey !== this.selectedHexKey) {
      const previous = this.selectedHexKey;
      this.selectedHexKey = selectedKey;
      for (const visual of this.unitVisuals.values()) {
        const at = `${visual.lastUnit.x},${visual.lastUnit.y}`;
        if (at === previous || at === selectedKey) void this.updateEllipse(visual, visual.lastUnit);
      }
    }
    // Destroyed, not just detached: a `Graphics` holds GPU geometry, and every select and deselect builds a
    // new set (playtest: on a phone the leak grew until the GPU dropped the terrain for seconds at a time).
    this.highlightLayer.removeChildren().forEach((child) => child.destroy());
    this.moveInfoLayer.removeChildren().forEach((child) => child.destroy());
    this.selectionLayer.removeChildren().forEach((child) => child.destroy());

    // Attack targets: a colour-coded fill alone isn't reliably visible on
    // Dead Water's water/sand (confirmed by screenshot), so they also get
    // a solid white outline on top of the red fill. Reachable hexes are
    // drawn differently -- see below.
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

    // bugs6.md: reachable hexes are only brightened -- an additive white
    // wash, no colour of their own -- and each shows the unit's defense
    // there as a number in upstream's `red_to_green` colour
    // (`game_display::draw_movement_info`). Upstream only numbers the
    // hovered hex; every reachable one is numbered here, with touch input in
    // mind. The hovered hex's outline is `setHoveredHex`'s.
    this.reachableDefense = new Map();
    this.reachLabels = new Map();
    for (const hex of state.reachable ?? []) {
      const coord = toHexCoord(hex.x, hex.y);
      const { x: cx, y: cy } = hexToPixel(coord);
      const wash = new PIXI.Graphics();
      wash.poly(hexCorners(cx, cy).flatMap((p) => [p.x, p.y]));
      wash.fill({ color: 0xffffff, alpha: 0.22 });
      wash.blendMode = 'add';
      this.highlightLayer.addChild(wash);
      if (hex.defensePercent !== undefined) {
        this.reachableDefense.set(`${hex.x},${hex.y}`, hex.defensePercent);
        const label = new PIXI.Text({
          text: `${hex.defensePercent}%`,
          style: { fontSize: 16, fontWeight: 'bold', fill: redToGreen(hex.defensePercent), stroke: { color: 0x000000, width: 3 } },
        });
        label.anchor.set(0.5);
        label.position.set(cx, cy);
        label.visible = !this.routeMarkKeys.has(`${hex.x},${hex.y}`);
        this.reachLabels.set(`${hex.x},${hex.y}`, label);
        this.moveInfoLayer.addChild(label);
      }
    }
    this.drawHoverOutline();
    for (const hex of state.attackTargets ?? []) drawFill(hex, 0xe23b3b, 0.5);

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

    // Phase 15: the keyboard cursor. Drawn last so it stays visible on top of a
    // selection ring on the same hex; cyan, a hue no other highlight here uses.
    if (state.cursor) {
      const coord = toHexCoord(state.cursor.x, state.cursor.y);
      const { x: cx, y: cy } = hexToPixel(coord);
      const points = hexCorners(cx, cy).flatMap((p) => [p.x, p.y]);

      const outer = new PIXI.Graphics();
      outer.poly(points);
      outer.stroke({ width: 7, color: 0x000000, alpha: 0.7 });
      this.selectionLayer.addChild(outer);

      const inner = new PIXI.Graphics();
      inner.poly(points);
      inner.stroke({ width: 3, color: 0x36e0ff, alpha: 1 });
      this.selectionLayer.addChild(inner);
    }
  }
}

/** `game_config::foot_speed_prefix` (`footprint_prefix`): the footprints for a hex costing 1, 2, and 3 or more. */
/** Identity of a fog/shroud state, to tell an unchanged one apart. */
function fogShroudKey(hexes: readonly FogShroudHex[]): string {
  let key = '';
  for (const h of hexes) key += `${h.x},${h.y}${h.visibility[0]};`;
  return key;
}

const FOOTPRINT_PACES = ['foot-normal', 'foot-medium', 'foot-slow'] as const;

/** `game_config::flag_rgb`: the palette the flag images are drawn in. */
const FLAG_RGB = 'flag_green';
/** `game_config::images::flag` (`data/game_config.cfg`). */
const DEFAULT_FLAG = 'flags/flag-[1~4].png:150';

