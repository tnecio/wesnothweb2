/**
 * TS port of the display-and-combat-relevant slice of `tod_manager`
 * (`src/tod_manager.hpp/.cpp`): a scenario's real `[time]` schedule, its
 * `[time_area]` local overrides, and which entry is active on a given
 * turn (globally, or at a specific hex).
 *
 * Real Wesnoth macros like `{DEFAULT_SCHEDULE}`/`{UNDERGROUND}` expand to
 * real `[time]` child tags at WML-preprocessing time -- this project's
 * snapshot pipeline already preprocesses scenarios fully, so
 * `scenarioConfigJson` already carries the real, scenario-specific
 * schedule with no extra snapshot field needed. `Schedule.fromScenarioConfig`
 * just reads it back out.
 *
 * Turn advancement is modelled the same way upstream's own
 * `calculate_time_index_at_turn` does: rather than mutating a "current
 * index" once per turn, each schedule (global or an area's own) is an
 * "anchor" (a turn number + the schedule index active on it), and the
 * active index for any turn is computed on demand as `anchorIndex +
 * (turnNumber - anchorTurn), mod length`. Creating a time area, or
 * replacing the schedule, simply re-anchors at the turn it happened on --
 * no per-turn mutation needed at all.
 *
 * Deliberately NOT ported:
 *  - `calculate_best_liminal_bonus`'s exact search heuristic for the
 *    default `maxLiminalBonus` (used only by the rare liminal alignment,
 *    e.g. bats/gryphons) -- real Wesnoth computes `max(25,
 *    calculate_best_liminal_bonus(schedule))`; this uses a flat `25`
 *    default instead (real Wesnoth's own floor value), honored the same
 *    way a scenario's own explicit `liminal_bonus=` overrides either.
 *  - Per-area `max_liminal_bonus`: upstream's is schedule-wide (a single
 *    `tod_manager`-level value), not per time-area, and this matches.
 *  - Terrain-type `light=`/`max_light=`/`min_light=` (a terrain's own
 *    innate illumination, e.g. some caves) feeding into
 *    `get_illuminated_time_of_day`'s base -- `TerrainType` doesn't model
 *    these fields yet; see `actions/illumination.ts`'s own doc comment.
 */

import { Location } from './Location.js';
import { WmlConfig, type WmlConfigJson } from '../wml/config.js';

/** One `[time]` entry -- mirrors the display/combat-relevant fields of `time_of_day`. */
export interface TimeOfDayEntry {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  /** `[time] lawful_bonus=` -- positive favors lawful units, negative favors chaotic. Passed straight to `combatStats.ts`'s `combatModifier`. */
  readonly lawfulBonus: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/** Parses a config's `[time]` children into `TimeOfDayEntry`s -- shared by the global schedule, `[time_area]`, and `[replace_schedule]`. */
export function parseTimes(cfg: WmlConfig): TimeOfDayEntry[] {
  return cfg.children('time').map(
    (t): TimeOfDayEntry => ({
      id: t.getString('id', ''),
      name: t.getString('name', ''),
      image: t.getString('image', ''),
      lawfulBonus: t.getNumber('lawful_bonus', 0),
      red: t.getNumber('red', 0),
      green: t.getNumber('green', 0),
      blue: t.getNumber('blue', 0),
    }),
  );
}

/** A `[time]` sequence anchored to the turn its `currentTime` index was established on -- mirrors `calculate_time_index_at_turn`'s inputs. */
interface AnchoredSequence {
  readonly times: readonly TimeOfDayEntry[];
  readonly anchorTurn: number;
  readonly anchorIndex: number;
}

function timeOfDayInSequence(seq: AnchoredSequence, turnNumber: number): TimeOfDayEntry {
  if (seq.times.length === 0) return NEUTRAL_TIME_OF_DAY;
  const raw = (seq.anchorIndex + (turnNumber - seq.anchorTurn)) % seq.times.length;
  const idx = raw < 0 ? raw + seq.times.length : raw;
  return seq.times[idx]!;
}

/** One `[time_area]`: a named region following its own schedule instead of the global one. Mirrors `tod_manager::area_time_of_day`. */
export interface TimeArea {
  readonly id: string;
  readonly hexes: ReadonlySet<string>;
  readonly schedule: AnchoredSequence;
}

/**
 * A scenario's real `[time]` schedule (global and per-`[time_area]`), plus
 * the liminal-bonus ceiling. Mutable: `[time_area]`/`[remove_time_area]`/
 * `[replace_schedule]` change live state mid-scenario, matching upstream's
 * own stateful `tod_manager`.
 */
export class Schedule {
  private globalSchedule: AnchoredSequence;
  /**
   * Ordered like upstream's `areas_` vector: `[time_area]` always appends
   * (even for a re-used `id=`, which just shadows the earlier one -- see
   * `timeOfDayAt`'s reverse-iteration priority), and `[remove_time_area]`
   * with no `id=` clears all of them.
   */
  private areas: TimeArea[] = [];
  /** `tod_manager::get_max_liminal_bonus()` -- see module doc comment on the simplified default. */
  maxLiminalBonus: number;

  constructor(times: readonly TimeOfDayEntry[], currentTimeStart: number, maxLiminalBonus: number) {
    this.globalSchedule = { times, anchorTurn: 1, anchorIndex: currentTimeStart };
    this.maxLiminalBonus = maxLiminalBonus;
  }

  /** True schedules have at least one `[time]` entry; an empty one (no `[time]` tags at all -- shouldn't happen for real content, but keeps callers crash-free) always reads as neutral. */
  get hasSchedule(): boolean {
    return this.globalSchedule.times.length > 0;
  }

  /** The global schedule's `[time]` entries (ignoring any `[time_area]` override) -- e.g. for a status-bar schedule preview. */
  get globalTimes(): readonly TimeOfDayEntry[] {
    return this.globalSchedule.times;
  }

  /**
   * Mirrors `tod_manager::get_time_of_day_turn` (the global-schedule
   * overload of `get_time_of_day`): the schedule entry active during
   * 1-based game turn `turnNumber`, ignoring any `[time_area]`.
   */
  timeOfDayForTurn(turnNumber: number): TimeOfDayEntry {
    return timeOfDayInSequence(this.globalSchedule, turnNumber);
  }

  /**
   * Mirrors `tod_manager::get_time_of_day(loc, turn)`: `loc`'s own
   * `[time_area]` schedule if one covers it (most-recently-added area
   * wins when they overlap, matching upstream's `areas_.rbegin()`
   * search), else the global schedule. Does NOT apply illumination --
   * see `actions/illumination.ts`'s `effectiveTimeOfDayAt` for that.
   */
  timeOfDayAt(loc: Location | undefined, turnNumber: number): TimeOfDayEntry {
    if (loc) {
      const key = loc.key();
      for (let i = this.areas.length - 1; i >= 0; i--) {
        const area = this.areas[i]!;
        if (area.schedule.times.length > 0 && area.hexes.has(key)) return timeOfDayInSequence(area.schedule, turnNumber);
      }
    }
    return this.timeOfDayForTurn(turnNumber);
  }

  /** The `[time_area]` id (if any, else `undefined`) covering `loc` right now -- mirrors `get_area_on_hex`. */
  areaIdAt(loc: Location): string | undefined {
    const key = loc.key();
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const area = this.areas[i]!;
      if (area.schedule.times.length > 0 && area.hexes.has(key)) return area.id;
    }
    return undefined;
  }

  /** Mirrors `tod_manager::add_time_area`. `turnNumber` anchors the area's own `current_time=` (default 0) to the turn it's created on. */
  addTimeArea(id: string, hexes: ReadonlySet<string>, times: readonly TimeOfDayEntry[], currentTime: number, turnNumber: number): void {
    this.areas.push({ id, hexes, schedule: { times, anchorTurn: turnNumber, anchorIndex: currentTime } });
  }

  /** Mirrors `tod_manager::remove_time_area`: an empty `id` removes every area; otherwise removes every area with a matching id (there can be more than one, see `addTimeArea`'s own doc comment). */
  removeTimeArea(id: string): void {
    this.areas = id === '' ? [] : this.areas.filter((a) => a.id !== id);
  }

  /** Every distinct time-area id currently active, in area order -- mirrors `get_area_ids`. */
  get areaIds(): readonly string[] {
    return this.areas.map((a) => a.id);
  }

  /** Mirrors `tod_manager::replace_schedule`: replaces the GLOBAL schedule outright, re-anchored at `turnNumber` (`[time_area]`s are untouched). */
  replaceSchedule(times: readonly TimeOfDayEntry[], currentTime: number, turnNumber: number): void {
    this.globalSchedule = { times, anchorTurn: turnNumber, anchorIndex: currentTime };
  }

  /** Builds a `Schedule` from a `[scenario]` config's own (already macro-expanded) `[time]` children. `rng` resolves `random_start_time=` the same way `tod_manager::resolve_random` does -- see module doc comment; omit it to leave `current_time=`'s literal value untouched (matches an absent/`no` `random_start_time=`). */
  static fromScenarioConfig(scenarioCfg: WmlConfig, rng?: RandomDraw): Schedule {
    const times = parseTimes(scenarioCfg);
    const maxLiminalBonus = scenarioCfg.hasAttribute('liminal_bonus') ? scenarioCfg.getNumber('liminal_bonus') : DEFAULT_MAX_LIMINAL_BONUS;

    // `current_time=-17403` is upstream's own "unset" sentinel (see
    // tod_manager's constructor comment: "?: operator doesn't work in
    // this case") -- random_start_time= only applies when current_time=
    // is genuinely absent.
    let currentTimeStart = scenarioCfg.getNumber('current_time', 0);
    if (!scenarioCfg.hasAttribute('current_time') && rng && times.length > 0) {
      currentTimeStart = resolveRandomStartTime(scenarioCfg.getString('random_start_time', ''), times.length, rng);
    }
    return new Schedule(times, currentTimeStart, maxLiminalBonus);
  }
}

/** The one `Rng` primitive `resolveRandomStartTime` needs -- a raw 32-bit draw, matching upstream's own `r.next_random()` calls. */
export interface RandomDraw {
  nextRandom(): number;
}

/**
 * Mirrors `tod_manager::resolve_random`: `random_start_time=` is either a
 * boolean (`yes`/`true` -- a fully random index) or a comma-separated list
 * of 1-based schedule indices to pick randomly among (matching upstream's
 * `modulo`-wrapped, not-strictly-validated interpretation of those
 * integers, and its extra, otherwise-unused `next_random()` draw after
 * picking from the list). Anything else (empty, `no`/`false`) leaves the
 * schedule at index 0.
 */
function resolveRandomStartTime(raw: string, numberOfTimes: number, rng: RandomDraw): number {
  const candidates = raw
    .split(/[\s,]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (candidates.length > 0) {
    const chosen = candidates[rng.nextRandom() % candidates.length]!;
    rng.nextRandom();
    return modulo(chosen, numberOfTimes);
  }
  if (raw.trim() !== '' && !/^(no|false|0)$/i.test(raw.trim())) {
    return modulo(rng.nextRandom(), numberOfTimes);
  }
  return 0;
}

function modulo(n: number, m: number): number {
  return m === 0 ? 0 : ((n % m) + m) % m;
}

/** Convenience wrapper for callers (e.g. `GameSession`) holding a snapshot's `scenarioConfigJson` rather than a live `WmlConfig` -- mirrors `carryover.ts`'s `findVictoryEndlevelGoldConfig`'s own JSON-in, parse-internally pattern. */
export function scheduleFromScenarioConfigJson(scenarioConfigJson: WmlConfigJson, rng?: RandomDraw): Schedule {
  return Schedule.fromScenarioConfig(WmlConfig.fromJSON(scenarioConfigJson), rng);
}

/** Real Wesnoth's floor value for `tod_manager::get_max_liminal_bonus()` -- see module doc comment. */
export const DEFAULT_MAX_LIMINAL_BONUS = 25;

/** Stand-in for a scenario with no `[time]` schedule at all -- permanently neutral ToD (matches `combatStats.ts`'s own pre-Schedule default). */
export const NEUTRAL_TIME_OF_DAY: TimeOfDayEntry = {
  id: '',
  name: '',
  image: '',
  lawfulBonus: 0,
  red: 0,
  green: 0,
  blue: 0,
};
