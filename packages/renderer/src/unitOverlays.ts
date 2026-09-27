/**
 * Pure geometry/color logic for a unit's real HP/XP bars, moves-left orb,
 * and poison/slow status tint -- ported from `units/drawer.cpp` (the
 * `energy_bar` struct/`draw_bar`), `units/unit.cpp` (`hp_color_impl`/
 * `xp_color`), and `display_context.cpp` (`unit_orb_status`). Split out from
 * `SnapshotBoard.ts` (which turns this into actual `PIXI.Graphics`/tint
 * calls) so the color/threshold math itself is unit-testable without a PIXI
 * canvas.
 *
 * Two real behaviours are deliberately simplified here, both noted where
 * they apply below: `unit_orb_status`'s `disengaged` state (a unit that can
 * still move but has no attack left, or couldn't reach an enemy anyway) is
 * folded into `partial` rather than reproduced exactly (upstream's version
 * needs a full reachable-hexes/attack-range analysis this orb doesn't
 * otherwise use).
 */

/** `units/drawer.cpp`'s `energy_bar` struct constants (all in real, unscaled 72px-hex pixels). */
export const ENERGY_BAR = {
  originX: 14,
  originY: 13,
  width: 4,
  /** Distance between the top-left corner of the HP bar and the XP bar (`def_w + 1`). */
  spacing: 5,
  backgroundColor: 0x000000,
  backgroundAlpha: 80 / 255,
  borderColor: 0xd5d5d5,
  borderAlpha: 200 / 255,
} as const;

/** `energy_bar::get_height`: `int(size * scaling)`. */
export function energyBarHeight(size: number, scaling: number): number {
  return Math.floor(size * scaling);
}

/** `energy_bar::get_filled`: `clamp(size/max, 0, 1)`. */
export function energyBarFilled(size: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, size / max));
}

/** `unit::hp_color`/`hp_color_impl` (units/unit.cpp). */
export function hpColor(hitpoints: number, maxHitpoints: number): number {
  const ratio = maxHitpoints > 0 ? hitpoints / maxHitpoints : 0;
  if (ratio === 1) return 0x21e100;
  if (ratio > 1) return 0x64ff64;
  if (ratio >= 0.75) return 0xaaff00;
  if (ratio >= 0.5) return 0xffaf00;
  if (ratio >= 0.25) return 0xff9b00;
  return 0xff0000;
}

/** Real `game_config::kill_experience` default (`data/game_config.cfg`/`game_config.cpp`). */
export const KILL_EXPERIENCE = 8;

/**
 * `unit::xp_color` (units/unit.cpp) -- simplified to the `can_advance() ==
 * true` branch only (the only case this project ever draws an XP bar for
 * at all -- see `SnapshotBoard.ts`'s `showXpBar`, mirroring upstream's own
 * `u.experience() > 0 && u.can_advance()` bar-visibility gate), and with no
 * AMLA modeling (this project doesn't track AMLA -- see `UnitType.ts`).
 */
export function xpColor(experienceToAdvance: number): number {
  if (experienceToAdvance <= KILL_EXPERIENCE) return 0xffffff;
  if (experienceToAdvance <= KILL_EXPERIENCE * 2) return 0x96ffff;
  if (experienceToAdvance <= KILL_EXPERIENCE * 3) return 0x00cdcd;
  return 0x00a0e1;
}

/** Real default game-wide `hp_bar_scaling`/`xp_bar_scaling` (`game_config.cpp`) -- see `UnitType`'s own doc comment on why this project doesn't track a per-type override (no real content in this project's used campaigns sets one). */
export const DEFAULT_HP_BAR_SCALING = 0.666;
export const DEFAULT_XP_BAR_SCALING = 0.5;

/**
 * `display_context::unit_orb_status`, collapsed from 4 own-side states to 3
 * (see module doc comment): `disengaged` (can move, can't attack) reads as
 * `partial` here, same as upstream's real `partial` state.
 *
 * `canMove`/`canAttackHere` mirror `unit_can_move`'s `can_move_result` --
 * real, reported bug: a unit boxed in with movement points left but no
 * reachable adjacent hex, and no attack possible, used to read as `partial`
 * (yellow) because this function only ever looked at the raw
 * `movesLeft <= 0` counter; the real orb only turns green/yellow when the
 * unit could actually still act. See `engine`'s `actions/unitCanAct.ts` for
 * how callers compute these two booleans (needs board/terrain access this
 * pure color-math module deliberately doesn't have).
 */
export type MovesOrbStatus = 'unmoved' | 'partial' | 'moved';

export function movesOrbStatus(
  movesLeft: number,
  maxMoves: number,
  attacksLeft: number,
  maxAttacksPerTurn: number,
  canMove: boolean,
  canAttackHere: boolean,
): MovesOrbStatus {
  if (movesLeft === maxMoves && attacksLeft === maxAttacksPerTurn) return 'unmoved';
  if (!canMove && !canAttackHere) return 'moved';
  return 'partial';
}

/** Real default `*_orb_color` preferences (`data/game_config.cfg`), as each range's "average shade" (`data/core/team-colors.cfg`). */
export const ORB_COLOR: Record<MovesOrbStatus, number> = {
  unmoved: 0x8cff00, // brightgreen
  partial: 0xffc600, // brightorange
  moved: 0xff0000, // red
};

/**
 * Real default `*_orb_color` preferences (`data/game_config.cfg`'s
 * `unmoved_orb_color`/`partial_orb_color`/`moved_orb_color`), as the real
 * `color_range` ids `~RC(magenta>id)` needs (not `ORB_COLOR`'s hex numbers,
 * which approximate the same ranges' "average shade" for the old
 * procedurally-drawn dot -- see `SnapshotBoard.updateIcons`, which draws
 * the real `misc/orb.png` asset recolored with these ids instead. Real,
 * reported bug (bugs3.md #1): the procedural dot's hand-guessed position
 * didn't match the real crown/loyal-icon overlays' position (both of which
 * were already the real, pre-positioned-via-transparent-padding 72x72
 * assets, drawn at the unit's own anchor) -- using the real `orb.png`
 * asset the same way fixes both the color AND the alignment at once.
 */
export const ORB_COLOR_ID: Record<MovesOrbStatus, string> = {
  unmoved: 'brightgreen',
  partial: 'brightorange',
  moved: 'red',
};

/**
 * Sets the orb colours (upstream's `unmoved_orb_color`/`partial_orb_color`/`moved_orb_color` preferences) to
 * team-colour ids. The next `updateIcons` redraws the orbs with them; the defaults above are what upstream ships.
 */
export function setOrbColorIds(colors: Partial<Record<MovesOrbStatus, string>>): void {
  for (const status of ['unmoved', 'partial', 'moved'] as const) {
    const id = colors[status];
    if (id) ORB_COLOR_ID[status] = id;
  }
}

/** Upstream's `blend_with`/`blend_ratio` pair: every pixel moves `ratio` of the way toward `color` (0xRRGGBB). */
export interface StatusBlend {
  color: number;
  ratio: number;
}

/**
 * `units/drawer.cpp`'s poison/slow block (`redraw_unit`, "Add future
 * colored states here"): the colors of every active status are averaged,
 * and so are their 0.25 ratios. `null` when neither status applies.
 *
 * This is a true blend, not a multiplicative tint. Reported (bugs6.md):
 * the tint this used to be scaled pixels by (239,239,255) for slowed, which
 * leaves the dark pixels of a sprite essentially unchanged -- a slowed unit
 * looked no different. Blending lifts every pixel toward the pale blue, as
 * the real game does.
 */
export function statusBlend(poisoned: boolean, slowed: boolean): StatusBlend | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let ratio = 0;
  let tints = 0;
  if (poisoned) {
    g += 255;
    ratio += 0.25;
    tints++;
  }
  if (slowed) {
    r += 191;
    g += 191;
    b += 255;
    ratio += 0.25;
    tints++;
  }
  if (tints === 0) return null;
  const color = (Math.round(r / tints) << 16) | (Math.round(g / tints) << 8) | Math.round(b / tints);
  return { color, ratio: ratio / tints };
}

/**
 * `statusBlend` as a 5x4 color matrix (PixiJS `ColorMatrixFilter` layout,
 * channels and offsets in 0-1): `out = in * (1 - ratio) + color * ratio`
 * for r/g/b, alpha untouched.
 */
export function blendColorMatrix(blend: StatusBlend): number[] {
  const k = 1 - blend.ratio;
  const channel = (shift: number): number => (((blend.color >> shift) & 0xff) / 255) * blend.ratio;
  return [
    k, 0, 0, 0, channel(16),
    0, k, 0, 0, channel(8),
    0, 0, k, 0, channel(0),
    0, 0, 0, 1, 0,
  ];
}
