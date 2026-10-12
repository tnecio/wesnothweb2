/**
 * A port of `tod_manager::get_illuminated_time_of_day` (`src/tod_manager.cpp`): the lawful bonus at a hex after
 * the terrain's own light (`light=`, `max_light=`, `min_light=`) and every unit's active `[illuminates]` ability
 * within its `radius=`, on top of whatever `Schedule.timeOfDayAt` says. The abilities go through the ability
 * pipeline (`getAbilities`), so their filters count.
 */

import { distanceBetween, type Location } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Schedule, TimeOfDayEntry } from '../model/Schedule.js';
import { currentAbilitiesEpoch, type Unit } from '../model/Unit.js';
import { abilityEffect, getAbilities } from './abilities.js';

/** Mirrors `utils::bounded_add`: `base + increment`, clamped so it never crosses `maxSum` (if increment >= 0) or `minSum` (if increment < 0) -- but never pulled back past `base` itself either. */
function boundedAdd(base: number, increment: number, maxSum: number, minSum: number): number {
  if (increment >= 0) return Math.min(base + increment, Math.max(base, maxSum));
  return Math.max(base + increment, Math.min(base, minSum));
}

/**
 * The units whose abilities could illuminate a hex: when no unit has an `[illuminates]` ability, none (the
 * usual case); else every unit, since one can be taught it. Rebuilt only when a unit was placed, moved or
 * removed, or any unit's abilities changed: the AI asks for the lawful bonus of every hex it rates.
 */
const candidatesCache = new WeakMap<GameBoard, { version: number; epoch: number; list: readonly Unit[] }>();

function illuminationCandidates(board: GameBoard): readonly Unit[] {
  const cached = candidatesCache.get(board);
  const epoch = currentAbilitiesEpoch();
  if (cached && cached.version === board.unitsVersion && cached.epoch === epoch) return cached.list;
  let any = false;
  for (const unit of board.unitsIterable()) {
    if (unit.abilities.some((a) => a.tag === 'illuminates')) {
      any = true;
      break;
    }
  }
  const list = any ? [...board.unitsIterable()] : [];
  candidatesCache.set(board, { version: board.unitsVersion, epoch, list });
  return list;
}

/** `get_illuminated_time_of_day`'s lawful bonus: `baseLawfulBonus` (the schedule's, at `loc`) with terrain light and illumination. */
export function illuminatedLawfulBonus(board: GameBoard, loc: Location, baseLawfulBonus: number): number {
  const map = board.map;
  if (!map.onBoardWithBorder(loc)) return baseLawfulBonus;
  const info = map.terrainInfoFor(map.getTerrain(loc));
  const terrainLight = boundedAdd(baseLawfulBonus, info.lightModification, info.maxLight, info.minLight);

  const mods: number[] = [];
  const maxes: number[] = [];
  const mins: number[] = [];
  let mostAdd = 0;
  let mostSub = 0;
  for (const u of illuminationCandidates(board)) {
    if (u.incapacitated) continue;
    const distance = distanceBetween(u.location, loc);
    const illum = getAbilities(board, u, 'illuminates').filter((i) => {
      const raw = i.ability.cfg.getString('radius', '1');
      const radius = raw !== 'all_map' ? (raw.trim() !== '' && Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : 1) : Infinity;
      return distance <= radius;
    });
    if (illum.length === 0) continue;
    const unitMod = abilityEffect(illum, terrainLight, undefined, 'without_clamp_min_max').compositeValue;
    mods.push(unitMod);
    maxes.push(illum.highest('max_value').value);
    mins.push(illum.lowest('min_value').value);
    if (unitMod > mostAdd) mostAdd = unitMod;
    else if (unitMod < mostSub) mostSub = unitMod;
  }
  const netDarker = mostAdd < -mostSub;
  let best = terrainLight;
  const baseLight = terrainLight + (netDarker ? mostAdd : mostSub);
  for (let i = 0; i < mods.length; i++) {
    const result = boundedAdd(baseLight, mods[i]!, maxes[i]!, mins[i]!);
    if (netDarker && result < best) best = result;
    else if (!netDarker && result > best) best = result;
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
