/**
 * Shroud and fog WML actions: `[remove_shroud]`/`[place_shroud]`
 * (`data/lua/wml-tags.lua` over `game_lua_kernel::intf_toggle_shroud`).
 */

import type { WmlConfig } from '../wml/config.js';
import type { Team } from '../model/Team.js';
import type { EventContext } from './context.js';
import { findLocations } from './filter.js';

/** Mirrors `utils.get_sides`: `side=` list, else `[filter_side] side=`, else every side. */
export function sidesForAction(cfg: WmlConfig, ctx: EventContext): Team[] {
  const source = cfg.hasAttribute('side') ? cfg : cfg.child('filter_side');
  const teams = ctx.board.teams();
  if (!source || !source.hasAttribute('side')) return teams;
  const wanted = new Set(
    source
      .getString('side')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n)),
  );
  return teams.filter((t) => wanted.has(t.side));
}

export function actionRemoveShroud(cfg: WmlConfig, ctx: EventContext): void {
  const locs = findLocations(ctx.board, cfg);
  for (const team of sidesForAction(cfg, ctx)) {
    for (const loc of locs) team.clearShroud(loc);
  }
}

export function actionPlaceShroud(cfg: WmlConfig, ctx: EventContext): void {
  const locs = findLocations(ctx.board, cfg);
  for (const team of sidesForAction(cfg, ctx)) {
    for (const loc of locs) team.placeShroud(loc);
  }
}

/** `parse_fog_cfg`: fog tags pick sides only through `[filter_side]` (all sides without one). */
function sidesForFogAction(cfg: WmlConfig, ctx: EventContext): Team[] {
  const filterSide = cfg.child('filter_side');
  return filterSide ? sidesForAction(filterSide, ctx) : ctx.board.teams();
}

/** Mirrors `wml_actions.lift_fog`: clears fog now, or with `multiturn=yes` keeps the hexes clear until `[reset_fog]`. */
export function actionLiftFog(cfg: WmlConfig, ctx: EventContext): void {
  const locs = findLocations(ctx.board, cfg);
  const multiturn = cfg.getBoolean('multiturn', false);
  for (const team of sidesForFogAction(cfg, ctx)) {
    for (const loc of locs) {
      if (multiturn) team.fogClearer.add(loc.key());
      else team.clearFog(loc);
    }
  }
}

/** Mirrors `wml_actions.reset_fog`: drops `multiturn` fog overrides; `reset_view=yes` also re-fogs the side (cleared again on its next vision update). */
export function actionResetFog(cfg: WmlConfig, ctx: EventContext): void {
  const locs = findLocations(ctx.board, cfg);
  const resetView = cfg.getBoolean('reset_view', false);
  for (const team of sidesForFogAction(cfg, ctx)) {
    for (const loc of locs) team.fogClearer.delete(loc.key());
    if (resetView) team.refog();
  }
}
