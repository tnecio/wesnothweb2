/**
 * TS port of the small, display-and-combat-relevant slice of `tod_manager`
 * (`src/tod_manager.hpp/.cpp`): given a scenario's real `[time]` entries
 * (its schedule) and the current game turn, which entry is active, and
 * what alignment damage bonus it implies.
 *
 * Real Wesnoth macros like `{DEFAULT_SCHEDULE}` expand to real `[time]`
 * child tags directly on `[scenario]` at WML-preprocessing time -- this
 * project's snapshot pipeline already preprocesses scenarios fully, so
 * `scenarioConfigJson` already carries the real, scenario-specific
 * schedule with no extra snapshot field needed. `Schedule.fromScenarioConfig`
 * just reads it back out.
 *
 * Deliberately NOT ported (a scoped-down MVP -- see `IMPLEMENTATION_PLAN.md`
 * Phase 12, "worth a fresh, dedicated scoping pass before starting"):
 *  - `[time_area]`/`[replace_schedule]`: regional/mid-scenario schedule
 *    overrides. Only the single global schedule is modeled.
 *  - `random_start_time=`: real Wesnoth resolves this via the synced RNG
 *    at scenario load (`tod_manager::resolve_random`); not wired to this
 *    project's RNG yet, so it's read as if absent (starts at
 *    `current_time=`, default 0) rather than randomized.
 *  - `calculate_best_liminal_bonus`'s exact search heuristic for the
 *    default `maxLiminalBonus` (used only by the rare liminal alignment,
 *    e.g. bats/gryphons) -- real Wesnoth computes `max(25,
 *    calculate_best_liminal_bonus(schedule))`; this uses a flat `25`
 *    default instead (real Wesnoth's own floor value), honored the same
 *    way a scenario's own explicit `liminal_bonus=` overrides either.
 */

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

/** A scenario's real `[time]` schedule plus its starting offset and liminal-bonus ceiling -- see module doc comment for what's simplified. */
export class Schedule {
  constructor(
    readonly times: readonly TimeOfDayEntry[],
    /** `[scenario] current_time=`: the schedule index active on turn 1 (default 0). */
    readonly currentTimeStart: number,
    /** `tod_manager::get_max_liminal_bonus()` -- see module doc comment on the simplified default. */
    readonly maxLiminalBonus: number,
  ) {}

  /** True schedules have at least one `[time]` entry; an empty one (no `[time]` tags at all -- shouldn't happen for real content, but keeps callers crash-free) always reads as neutral. */
  get hasSchedule(): boolean {
    return this.times.length > 0;
  }

  /**
   * Mirrors `tod_manager::get_time_of_day_turn`: the schedule entry active
   * during 1-based game turn `turnNumber`, wrapping around the schedule's
   * length. Real Wesnoth advances one schedule step per game turn (not per
   * side turn), matching `GameSession.turnNumber`'s own definition.
   */
  timeOfDayForTurn(turnNumber: number): TimeOfDayEntry {
    if (this.times.length === 0) return NEUTRAL_TIME_OF_DAY;
    const raw = (this.currentTimeStart + (turnNumber - 1)) % this.times.length;
    const idx = raw < 0 ? raw + this.times.length : raw;
    return this.times[idx]!;
  }

  /** Builds a `Schedule` from a `[scenario]` config's own (already macro-expanded) `[time]` children. */
  static fromScenarioConfig(scenarioCfg: WmlConfig): Schedule {
    const times = scenarioCfg.children('time').map(
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
    const currentTimeStart = scenarioCfg.getNumber('current_time', 0);
    const maxLiminalBonus = scenarioCfg.hasAttribute('liminal_bonus') ? scenarioCfg.getNumber('liminal_bonus') : DEFAULT_MAX_LIMINAL_BONUS;
    return new Schedule(times, currentTimeStart, maxLiminalBonus);
  }
}

/** Convenience wrapper for callers (e.g. `GameSession`) holding a snapshot's `scenarioConfigJson` rather than a live `WmlConfig` -- mirrors `carryover.ts`'s `findVictoryEndlevelGoldConfig`'s own JSON-in, parse-internally pattern. */
export function scheduleFromScenarioConfigJson(scenarioConfigJson: WmlConfigJson): Schedule {
  return Schedule.fromScenarioConfig(WmlConfig.fromJSON(scenarioConfigJson));
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
