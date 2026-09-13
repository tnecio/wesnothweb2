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
// `'subtract'` (used by `updateTimeOfDayTint`'s negative-channel layer) is one of
// PixiJS v8's "advanced" blend modes: a shader-based filter, not a native GL
// blend equation like `'add'`/`'normal'`, so it renders nothing (silently, no
// error) until its extension is registered. `'add'` needs no such registration.
PIXI.extensions.add(PIXI.SubtractBlend);
import { Direction, Location, getAdjacentTiles } from '@wesnothweb2/engine/src/model/Location.js';
import { hexOverlayImages, defaultAssetExists, type FogShroudHex } from './fogShroud.js';
import { splitTodTintColors } from './todTint.js';
import { parseTerrainCode, NONE_TERRAIN, type TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import {
  hexCorners,
  hexToPixel,
  pixelToHex,
  HEX_SIZE,
  HEX_COL_WIDTH,
  HEX_ROW_HEIGHT,
  type HexCoord,
} from './hexGeometry.js';
import { ImageCache, hexedRef, setImageBaseUrl, setEngineImageBaseUrl } from './images/ImageCache.js';
import { joinRef } from './images/ipf.js';
import { resolveSideColorId } from './images/teamColor.js';
import { sampleAnimation, animationDurationMs } from './animation/playback.js';
import type { UnitAnimationDef } from './animation/unitAnimation.js';
import { makeLayerSprite, type TerrainLayer } from './terrainPositioning.js';
import { buildTerrainTiles, getTerrainFramesAt, type TerrainMapQuery } from './terrain/terrainBuilder.js';
import type { BuildingRule } from './terrain/terrainGraphicsRules.js';
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
  statusTint,
} from './unitOverlays.js';

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
  /** Base URL `engine/`-prefixed references are served from (see ImageCache.setEngineImageBaseUrl). */
  engineImageBaseUrl?: string;
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
  /**
   * Suppresses the synthetic lunge-and-return fallback motion `playAnimations`
   * plays when this cue has no real matching `anim` and `srcHex !== dstHex`.
   * Set by recruit cues (`GameShell.svelte`'s `buildRecruitAnimationCues`),
   * whose `dstHex` is the OTHER combatant's hex purely for `sampleAnimation`'s
   * own directional `offset=` math when a real `[recruit_anim]`/`[recruiting]`
   * animation exists -- most real unit types don't author one (upstream's
   * `fill_initial_animations`-synthesized implicit "recruited" fallback isn't
   * ported, see `unitAnimation.ts`'s module doc comment), so `anim` is
   * `undefined` far more often than not. Without this flag, both the
   * recruiting leader and the newly recruited unit visibly lunged toward
   * each other and back -- the attack/defend convention -- reading as an
   * unwanted "movement" animation playing at the same time as recruitment.
   * Real, reported bug.
   */
  readonly holdInPlace?: boolean;
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
    if (options.engineImageBaseUrl) setEngineImageBaseUrl(options.engineImageBaseUrl);
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
      this.fogShroudLayer,
      this.todTintLayer,
      this.selectionLayer,
    );
    this.todTintPositive.blendMode = 'add';
    // 'subtract' is one of PixiJS v8's "advanced" (shader-based) blend
    // modes, not a native GL blend equation like 'add' -- it needs its
    // extension registered (see the `PIXI.extensions.add` call at this
    // module's top) AND the application's renderer created with
    // `useBackBuffer: true` (see `GameBoardView.svelte`'s `app.init`).
    // Real, found-by-testing bug: without `useBackBuffer`, the blend
    // filter has no valid backbuffer to read the composited scene from
    // and silently renders solid black wherever it's applied -- not an
    // error, not a warning in the common case, just a black board.
    this.todTintNegative.blendMode = 'subtract';
    this.todTintLayer.addChild(this.todTintPositive, this.todTintNegative);
    this.todTintLayer.eventMode = 'none';
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
    if (!this.onHexClick && !this.onHexHover) return;
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
      layer.on('pointertap', (e) => {
        const hex = hexAt(e);
        if (hex) this.onHexClick?.(hex.x, hex.y);
      });
    }
    if (this.onHexHover) {
      let last: HexPoint | null = null;
      layer.on('pointermove', (e) => {
        const hex = hexAt(e);
        if (!hex || (last && last.x === hex.x && last.y === hex.y)) return;
        last = hex;
        this.onHexHover?.(hex.x, hex.y);
      });
    }
  }

  private async renderTerrain(): Promise<void> {
    this.installHitArea();
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
      const g = new PIXI.Graphics();
      g.poly(hexCorners(cx, cy).flatMap((p) => [p.x, p.y]));
      g.fill({ color: colorForTerrain(hex.code) });
      g.stroke({ width: 1, color: 0x000000, alpha: 0.15 });
      this.terrainLayer.addChild(g);
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
    const tiles = buildTerrainTiles(rules as BuildingRule[], query, {
      offMapCode,
    });

    // Every board hex PLUS the one-hex off-map ring around it: upstream draws
    // that ring too (`display::draw_hex` runs over the border when
    // `draw_border` is set), which is where the `_off^_usr` background and
    // the `off-map/border.png` edge fades come from -- without it the map
    // ends in a hard black sawtooth instead of the real game's soft edge.
    const { width, height } = this.snapshot.map;
    const perHex: Array<{
      x: number;
      y: number;
      cx: number;
      cy: number;
      bg: TerrainLayer[];
      fg: TerrainLayer[];
    }> = [];
    const refs = new Set<string>();
    for (let x = -1; x <= width; x++) {
      for (let y = -1; y <= height; y++) {
        const { background, foreground } = getTerrainFramesAt(tiles, x, y, '');
        const { x: cx, y: cy } = hexToPixel(toHexCoord(x, y));
        perHex.push({ x, y, cx, cy, bg: [...background], fg: [...foreground] });
        for (const layer of [...background, ...foreground]) {
          for (const frame of layer.frames) refs.add(hexedRef(joinRef(frame.path, frame.mods)));
        }
      }
    }

    await ImageCache.preload(refs);

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
    if (hexes.length === 0) {
      this.fogShroudLayer.removeChildren();
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

    this.fogShroudLayer.removeChildren();
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
    const colorData = ImageCache.getColorData();
    const rawColor = this.teamColor.get(side);
    const colorId = colorData && rawColor !== undefined ? resolveSideColorId(rawColor, side, colorData.defaultColors) : '';
    return colorId ? joinRef(imagePath, `RC(${flagRgb ?? 'magenta'}>${colorId})`) : imagePath;
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
      }
    }

    // A small side-colour marker dot underneath every sprite -- kept even
    // now that recoloring is real (some unit art has little/no magenta
    // area, e.g. mostly-metal or all-white sprites, where the recolor
    // alone can be easy to miss at a glance). No sprite at all (image
    // missing/unresolvable) -- fall back to a bigger, undecorated dot so
    // the unit is still visible and clickable-by-proxy.
    if (sprite) {
      marker.circle(0, 28, 6).fill({ color: sideMarkerColor(this.teamColor.get(unit.side)) });
      container.addChild(marker, sprite);
    } else {
      marker.circle(0, 0, 16).fill({ color: sideMarkerColor(this.teamColor.get(unit.side)) });
      container.addChild(marker);
    }

    const bars = new PIXI.Graphics();
    container.addChild(bars);

    return {
      container,
      sprite,
      marker,
      overlay: null,
      lastImage: unit.image,
      lastSide: unit.side,
      bars,
      crownIcon: null,
      loyalIcon: null,
      orbIcon: null,
      lastOrbRef: null,
      flagRgb: unit.flagRgb,
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
      const statuses = unit.statuses ?? [];
      visual.sprite.tint = statusTint(statuses.includes('poisoned'), statuses.includes('slowed'));
      if (statuses.includes('petrified')) {
        if (!visual.sprite.filters || (visual.sprite.filters as PIXI.Filter[]).length === 0) {
          const filter = new PIXI.ColorMatrixFilter();
          filter.desaturate();
          visual.sprite.filters = [filter];
        }
      } else if (visual.sprite.filters) {
        visual.sprite.filters = null;
      }
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
      this.updateOverlays(visual, unit);
      await this.updateIcons(visual, unit);
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
    for (const { cue, visual } of active) {
      if (!cue.anim) continue;
      const paths = new Set<string>();
      for (const frame of cue.anim.frames) {
        const seq =
          cue.direction === Direction.NorthEast ||
          cue.direction === Direction.SouthEast ||
          cue.direction === Direction.NorthWest ||
          cue.direction === Direction.SouthWest
            ? frame.imageDiagonal.length > 0
              ? frame.imageDiagonal
              : frame.image
            : frame.image;
        for (const step of seq) paths.add(step.value);
      }
      await Promise.all([...paths].map((p) => ImageCache.resolve(this.teamColoredRef(p, visual.lastSide, visual.flagRgb))));
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
              const texture = await ImageCache.resolve(this.teamColoredRef(sample.imagePath, visual.lastSide, visual.flagRgb));
              if (texture && visual.sprite && visual.sprite.texture !== texture) visual.sprite.texture = texture;
            }
            if (visual.sprite)
              visual.sprite.scale.x = sample.hflip ? -Math.abs(visual.sprite.scale.x) : Math.abs(visual.sprite.scale.x);
            visual.container.x = sample.x;
            visual.container.y = sample.y;
            this.applyBlend(visual, sample.blendRatio, sample.blendColor);
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

    for (const hex of state.reachable ?? []) {
      drawFill(hex, 0x3fa9f5, 0.45);
      if (hex.defensePercent !== undefined) {
        const coord = toHexCoord(hex.x, hex.y);
        const { x: cx, y: cy } = hexToPixel(coord);
        const label = new PIXI.Text({
          text: `${hex.defensePercent}%`,
          style: { fontSize: 14, fontWeight: 'bold', fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
        });
        label.anchor.set(0.5);
        label.position.set(cx, cy);
        this.highlightLayer.addChild(label);
      }
    }
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
