/**
 * Time-of-day WML actions: `[time_area]`/`[remove_time_area]`
 * (`wml_actions.time_area`/`remove_time_area`, `data/lua/wml-tags.lua`,
 * backed by `tod_manager::add_time_area`/`remove_time_area`),
 * `[replace_schedule]` (`wesnoth.schedule.replace`, `intf_replace_schedule`),
 * and `[store_time_of_day]` (`data/lua/wml/store_time_of_day.lua`).
 */

import { Location } from '../model/Location.js';
import { parseTimes } from '../model/Schedule.js';
import { WmlConfig } from '../wml/config.js';
import type { EventContext } from './context.js';
import { findLocations } from './filter.js';
import { varNodeFromConfig } from './variables.js';

/** The current game turn, as tracked in `ctx.variables` by whoever owns the event pump (`GameSession.fireSideTurnEvents`) -- falls back to 1 if never set (e.g. a bare unit test). */
function currentTurn(ctx: EventContext): number {
  return ctx.variables.getNumber('turn_number', 1);
}

/**
 * Mirrors `wml_actions.time_area`: `remove=yes` delegates to
 * `[remove_time_area]`; otherwise adds a new area covering every hex
 * `cfg` matches as a standard location filter (`findLocations`, reused
 * from Phase 11's shroud/fog tags), following its own `[time]` schedule
 * starting at `current_time=` (default 0), anchored to the current turn.
 */
export function actionTimeArea(cfg: WmlConfig, ctx: EventContext): void {
  if (cfg.getBoolean('remove', false)) {
    actionRemoveTimeArea(cfg, ctx);
    return;
  }
  const id = cfg.getString('id', '');
  const hexes = new Set(findLocations(ctx.board, cfg).map((l) => l.key()));
  const times = parseTimes(cfg);
  const currentTime = cfg.getNumber('current_time', 0);
  ctx.schedule.addTimeArea(id, hexes, times, currentTime, currentTurn(ctx));
}

/** Mirrors `wml_actions.remove_time_area`: `id=` is a comma-separated list of ids to remove (an empty id clears every area, per `Schedule.removeTimeArea`'s own doc comment). */
export function actionRemoveTimeArea(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('id')) {
    ctx.log('error', '[remove_time_area] missing required id= key');
    return;
  }
  for (const id of cfg.getString('id').split(',').map((s) => s.trim())) {
    ctx.schedule.removeTimeArea(id);
  }
}

/**
 * Mirrors `wesnoth.schedule.replace`/`intf_replace_schedule`'s WML-config
 * branch: replaces the GLOBAL schedule outright with `cfg`'s `[time]`
 * children, starting at `current_time=` (default 0). A schedule with no
 * `[time]` children is rejected (matches upstream logging an error and
 * leaving the old schedule in place) -- existing `[time_area]`s are
 * untouched either way.
 */
export function actionReplaceSchedule(cfg: WmlConfig, ctx: EventContext): void {
  const times = parseTimes(cfg);
  if (times.length === 0) {
    ctx.log('error', 'attempted to replace ToD schedule with empty schedule');
    return;
  }
  ctx.schedule.replaceSchedule(times, cfg.getNumber('current_time', 0), currentTurn(ctx));
}

/**
 * Mirrors `store_time_of_day.lua`: stores the ToD at `x=`/`y=` (global
 * schedule if omitted) and `turn=` (current turn if omitted, or 0) into
 * `variable=` (default `time_of_day`) as a one-element WML array --
 * matching upstream's own "always writes index [0]" behaviour (it sets
 * each field individually at `variable[0].<key>`, which in practice never
 * needs to coexist with other array elements for this variable). Does NOT
 * apply `[illuminates]` -- upstream calls `get_time_of_day`, not
 * `get_illumination`, here.
 */
export function actionStoreTimeOfDay(cfg: WmlConfig, ctx: EventContext): void {
  const variable = cfg.getString('variable', 'time_of_day');
  const turnRaw = cfg.getNumber('turn', 0);
  const turn = turnRaw === 0 ? currentTurn(ctx) : turnRaw;

  const hasLoc = cfg.hasAttribute('x') && cfg.hasAttribute('y');
  const tod = hasLoc
    ? ctx.schedule.timeOfDayAt(Location.fromWml(cfg.getNumber('x'), cfg.getNumber('y')), turn)
    : ctx.schedule.timeOfDayForTurn(turn);

  const out = new WmlConfig();
  out.setAttribute('id', tod.id);
  out.setAttribute('name', tod.name);
  out.setAttribute('image', tod.image);
  out.setAttribute('lawful_bonus', tod.lawfulBonus);
  out.setAttribute('red', tod.red);
  out.setAttribute('green', tod.green);
  out.setAttribute('blue', tod.blue);
  ctx.variables.setArray(variable, [varNodeFromConfig(out)]);
}
