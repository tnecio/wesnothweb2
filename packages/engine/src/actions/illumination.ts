/**
 * TS port of `tod_manager::get_illuminated_time_of_day` (`src/tod_manager.
 * cpp`): the `[illuminates]` ability's effect on the lawful-bonus at a
 * hex, on top of whatever `Schedule.timeOfDayAt` already says.
 *
 * Scope: every real mainline `[illuminates]` definition (`data/core/
 * macros/abilities.cfg`'s `ABILITY_ILLUMINATES`: `value=25, max_value=25,
 * cumulative=no, affect_self=yes`, no `radius=` -- so radius defaults to
 * 1, adjacent-only) is covered, including the multi-illuminator
 * "net darker vs. net brighter" composition upstream itself implements
 * for the rare case of several different illuminates definitions
 * overlapping a hex with opposite signs.
 *
 * NOT ported: terrain-type `light=`/`max_light=`/`min_light=` (a
 * terrain's own innate illumination) feeding into the "before any unit's
 * illuminates" base value -- `TerrainType` doesn't model these fields
 * yet, so the base is simply the schedule's own `lawful_bonus` at that
 * hex. `[illuminates]`'s `[filter]`/`[affect_adjacent]` machinery
 * (`abilityEffects.ts`'s generic pipeline) isn't reused here either: real
 * Wesnoth computes this via a dedicated hex-centric distance scan, not a
 * receiver-centric ability search, since illumination affects a HEX (felt
 * by anyone standing there, friend or enemy alike), not a specific unit.
 */

import { distanceBetween, type Location } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Schedule, TimeOfDayEntry } from '../model/Schedule.js';
import type { RegistryEntry } from '../model/UnitType.js';
import { currentAbilitiesEpoch, type Unit } from '../model/Unit.js';

/** Mirrors `utils::bounded_add`: `base + increment`, clamped so it never crosses `maxSum` (if increment >= 0) or `minSum` (if increment < 0) -- but never pulled back past `base` itself either. */
function boundedAdd(base: number, increment: number, maxSum: number, minSum: number): number {
  if (increment >= 0) return Math.min(base + increment, Math.max(base, maxSum));
  return Math.max(base + increment, Math.min(base, minSum));
}

interface IlluminatesContribution {
  readonly mod: number;
  readonly max: number;
  readonly min: number;
}

interface IlluminatesSource {
  readonly radius: number;
  readonly contribution: IlluminatesContribution;
}

/**
 * The `[illuminates]` abilities in a unit's ability list, parsed once per list. Effects replace a unit's
 * `abilities` array rather than editing it, so the array itself is the cache key. This runs for every hex
 * the AI rates (`power_projection`), where re-reading every unit's ability configs dominated its time.
 */
const illuminatesCache = new WeakMap<readonly RegistryEntry[], readonly IlluminatesSource[]>();

interface Illuminator {
  readonly unit: Unit;
  readonly sources: readonly IlluminatesSource[];
}

/**
 * The units on `board` with an `[illuminates]` ability (usually none), rebuilt only when a unit was placed,
 * moved or removed, or any unit's abilities changed. The AI asks for the lawful bonus of every hex it rates,
 * and walking every unit's abilities each time was most of an AI turn on a big map.
 */
const illuminatorsCache = new WeakMap<GameBoard, { version: number; epoch: number; list: readonly Illuminator[] }>();

function illuminatorsOn(board: GameBoard): readonly Illuminator[] {
  const cached = illuminatorsCache.get(board);
  const epoch = currentAbilitiesEpoch();
  if (cached && cached.version === board.unitsVersion && cached.epoch === epoch) return cached.list;
  const list: Illuminator[] = [];
  for (const unit of board.unitsIterable()) {
    const sources = illuminatesOf(unit.abilities);
    if (sources.length > 0) list.push({ unit, sources });
  }
  illuminatorsCache.set(board, { version: board.unitsVersion, epoch, list });
  return list;
}

function illuminatesOf(abilities: readonly RegistryEntry[]): readonly IlluminatesSource[] {
  let sources = illuminatesCache.get(abilities);
  if (!sources) {
    const list: IlluminatesSource[] = [];
    for (const entry of abilities) {
      if (entry.tag !== 'illuminates') continue;
      if (!entry.config.getBoolean('affect_self', true)) continue; // every real definition is self-centered; nothing else to check here.
      const radiusRaw = entry.config.getString('radius', '1');
      const radius = radiusRaw === 'all_map' ? Infinity : (entry.config.getNumber('radius', 1) ?? 1);
      const mod = entry.config.getNumber('value', 0);
      const max = entry.config.hasAttribute('max_value') ? entry.config.getNumber('max_value') : Number.POSITIVE_INFINITY;
      const min = entry.config.hasAttribute('min_value') ? entry.config.getNumber('min_value') : Number.NEGATIVE_INFINITY;
      list.push({ radius, contribution: { mod, max, min } });
    }
    sources = list;
    illuminatesCache.set(abilities, sources);
  }
  return sources;
}

/**
 * Mirrors `tod_manager::get_illuminated_time_of_day`'s effect (minus the
 * terrain-light base, see module doc comment): `baseLawfulBonus` (the
 * schedule's own value at `loc`, before illumination) shifted by every
 * non-incapacitated unit's active `[illuminates]` ability within range of
 * `loc`.
 */
export function illuminatedLawfulBonus(board: GameBoard, loc: Location, baseLawfulBonus: number): number {
  const contributions: IlluminatesContribution[] = [];
  let mostAdd = 0;
  let mostSub = 0;

  for (const { unit, sources } of illuminatorsOn(board)) {
    if (unit.incapacitated) continue;
    for (const { radius, contribution } of sources) {
      if (distanceBetween(unit.location, loc) > radius) continue;
      contributions.push(contribution);
      const mod = contribution.mod;
      if (mod > mostAdd) mostAdd = mod;
      else if (mod < mostSub) mostSub = mod;
    }
  }

  if (contributions.length === 0) return baseLawfulBonus;

  const netDarker = mostAdd < -mostSub;
  const base = baseLawfulBonus + (netDarker ? mostAdd : mostSub);
  let best = baseLawfulBonus;
  for (const c of contributions) {
    const result = boundedAdd(base, c.mod, c.max, c.min);
    if (netDarker ? result < best : result > best) best = result;
  }
  return best;
}

/**
 * The single entry point combat/rendering/event-filter code should use:
 * `Schedule.timeOfDayAt` (global or `[time_area]`) with `[illuminates]`
 * applied on top -- mirrors upstream's own `get_illuminated_time_of_day`,
 * which always layers illumination on top of the location-aware ToD, not
 * a separate step callers might forget.
 */
export function effectiveTimeOfDayAt(board: GameBoard, schedule: Schedule, turnNumber: number, loc: Location): TimeOfDayEntry {
  const base = schedule.timeOfDayAt(loc, turnNumber);
  const lawfulBonus = illuminatedLawfulBonus(board, loc, base.lawfulBonus);
  return lawfulBonus === base.lawfulBonus ? base : { ...base, lawfulBonus };
}
