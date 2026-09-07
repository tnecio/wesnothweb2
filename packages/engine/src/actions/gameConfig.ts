/**
 * Small shared constants/formulas ported from upstream's `game_config.hpp`/
 * `.cpp` and `utils/math.hpp` that the actions in this directory need.
 * Upstream keeps these as mutable globals overridable by a scenario's
 * `[game_config]`; this port keeps them as plain constants (the values
 * shipped as defaults) since nothing in this project's scope yet loads a
 * `[game_config]` override. If/when that's wired up, these can become
 * fields on a small config object threaded through instead.
 */

/** `game_config::poison_amount` (default). */
export const POISON_AMOUNT = 8;
/** `game_config::rest_heal_amount` (default). */
export const REST_HEAL_AMOUNT = 2;
/** `game_config::recall_cost` (default; a `Team`'s own `recallCost` field normally wins). */
export const DEFAULT_RECALL_COST = 20;
/** `game_config::kill_experience` (default). */
export const KILL_EXPERIENCE = 8;
/** `game_config::combat_experience` (default). */
export const COMBAT_EXPERIENCE = 1;

/** Mirrors `game_config::kill_xp(level)`. */
export function killXp(level: number): number {
  return level ? KILL_EXPERIENCE * level : Math.floor(KILL_EXPERIENCE / 2);
}

/** Mirrors `game_config::combat_xp(level)`. */
export function combatXp(level: number): number {
  return COMBAT_EXPERIENCE * level;
}

/**
 * Mirrors `round_damage(base_damage, bonus, divisor)` from `utils/math.hpp`:
 * rounds `base_damage * bonus / divisor` to the nearest integer, breaking
 * ties towards `base_damage` (i.e. away from zero-ing out small amounts),
 * and never returns less than 1 for a nonzero `base_damage`.
 */
export function roundDamage(baseDamage: number, bonus: number, divisor: number): number {
  if (baseDamage === 0) return 0;
  const rounding = Math.floor(divisor / 2) - (bonus <= divisor || divisor === 1 ? 0 : 1);
  return Math.max(1, Math.trunc((baseDamage * bonus + rounding) / divisor));
}
