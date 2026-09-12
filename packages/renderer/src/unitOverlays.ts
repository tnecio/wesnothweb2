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
 * otherwise use); and the poison/slow tint uses a plain color lerp as a
 * stand-in for upstream's true `blend_with`/`blend_ratio` alpha blend
 * (matching this project's already-established hit-flash approximation --
 * see `SnapshotBoard.ts`'s `applyBlend` doc comment).
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
 * `units/drawer.cpp`'s poison/slow tint block (`redraw_unit`, "Add future
 * colored states here"), returning a plain multiplicative tint approximating
 * the real alpha blend toward the averaged color -- see module doc comment.
 * `0xffffff` (no-op tint) when neither status applies.
 */
export function statusTint(poisoned: boolean, slowed: boolean): number {
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
  if (tints === 0) return 0xffffff;
  const avgRatio = ratio / tints;
  const lerp = (from: number, to: number): number => Math.round(from + (to - from) * avgRatio);
  const tr = lerp(255, r / tints);
  const tg = lerp(255, g / tints);
  const tb = lerp(255, b / tints);
  return (tr << 16) | (tg << 8) | tb;
}
