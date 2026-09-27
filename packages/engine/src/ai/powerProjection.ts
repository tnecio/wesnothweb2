/**
 * TS port of `readonly_context_impl::power_projection` (`src/ai/
 * contexts.cpp`): a rough "how much combat power could reach/threaten
 * this hex" score, used throughout the default AI (villages' threat
 * filter, healing's vulnerability check, combat's `vulnerability`/
 * `support` terms). For each of the 6 neighbours of `loc`, the single
 * best unit (from `dstSrc`) that could occupy it contributes a rating;
 * ratings are summed and divided by 100000.
 *
 * Simplified vs. upstream (documented, not silent): upstream iterates to
 * a fixed point, letting a unit be reassigned to a DIFFERENT neighbour if
 * that raises the total; this port greedily assigns each unit to at most
 * one neighbour on a first-come basis (neighbours processed in a fixed
 * order), which slightly undercounts in rare highly-contested
 * configurations but matches for the single-neighbour and
 * no-shared-unit cases this phase's own tests exercise.
 */

import { getAdjacentTiles, type Location } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';
import { combatModifier } from '../actions/combatStats.js';
import type { MoveMap } from './moveMaps.js';

export interface PowerProjectionContext {
  readonly turnNumber: number;
  readonly lawfulBonusAt: (loc: Location) => number;
  readonly maxLiminalBonus: number;
}

/** Mirrors the per-unit rating term inside `power_projection`'s loop. */
function unitRating(board: GameBoard, unit: Unit, hex: Location, ctx: PowerProjectionContext): number {
  const defenseChanceToBeHit = 100 - unit.defenseModifier(board.map.getTerrain(hex));
  const lawfulBonus = ctx.lawfulBonusAt(hex);
  const todModifier = combatModifier(lawfulBonus, unit.alignment, unit.fearless, ctx.maxLiminalBonus);
  let maxDamage = 0;
  for (const attack of unit.attacks) {
    maxDamage = Math.max(maxDamage, attack.damage * attack.numAttacks * (100 + todModifier));
  }
  const villageMultiplier = board.map.isVillage(hex) ? 3 : 2;
  const hpFactor = Math.sqrt(unit.hitpoints / Math.max(1, unit.maxHitpoints));
  return (hpFactor * 1000 * defenseChanceToBeHit * maxDamage * villageMultiplier) / 200;
}

export function powerProjection(board: GameBoard, loc: Location, dstSrc: MoveMap, ctx: PowerProjectionContext): number {
  const used = new Set<string>();
  let total = 0;
  for (const hex of getAdjacentTiles(loc)) {
    const candidates = dstSrc.get(hex.key()) ?? [];
    let best = 0;
    let bestUnitKey: string | undefined;
    for (const srcLoc of candidates) {
      if (used.has(srcLoc.key())) continue;
      const unit = board.unitAt(srcLoc);
      if (!unit) continue;
      const rating = unitRating(board, unit, hex, ctx);
      if (rating > best) {
        best = rating;
        bestUnitKey = srcLoc.key();
      }
    }
    if (bestUnitKey) {
      used.add(bestUnitKey);
      total += best;
    }
  }
  return total / 100000;
}

export interface DefensivePosition {
  /** The best reachable hex found, if any (undefined only when `loc` has no unit or no reachable destination beat the "chance to hit 100" starting bound). */
  readonly loc?: Location;
  /** 0-100 "chance to be hit" (upstream's `defense_modifier` convention) at the chosen hex, or 100 if none was found. */
  readonly chanceToHit: number;
  readonly vulnerability: number;
  readonly support: number;
}

/**
 * TS port of `readonly_context_impl::best_defensive_position` (`src/ai/
 * contexts.cpp:445-489`): among the hexes the unit currently at `loc` can
 * reach this turn (`srcDst`), the one with the lowest chance to be hit,
 * breaking ties by the highest (support - vulnerability). Used by
 * `attack_analysis::analyze`'s `alternative_terrain_quality` (Phase 29 S2)
 * to compare an attack's actual terrain against "what if this unit just
 * repositioned instead". Uncached here; the AI asks through
 * `AiContext.bestDefensivePosition`, which keeps upstream's per-turn cache.
 */
export function bestDefensivePosition(
  board: GameBoard,
  loc: Location,
  srcDst: MoveMap,
  dstSrc: MoveMap,
  enemyDstSrc: MoveMap,
  ctx: PowerProjectionContext,
): DefensivePosition {
  const unit = board.unitAt(loc);
  if (!unit) return { chanceToHit: 0, vulnerability: 0, support: 0 };

  let best: DefensivePosition = { chanceToHit: 100, vulnerability: 10000, support: 0 };

  for (const dest of srcDst.get(loc.key()) ?? []) {
    const defense = unit.defenseModifier(board.map.getTerrain(dest));
    if (defense > best.chanceToHit) continue;

    const vulnerability = powerProjection(board, dest, enemyDstSrc, ctx);
    const support = powerProjection(board, dest, dstSrc, ctx);

    if (defense < best.chanceToHit || support - vulnerability > best.support - best.vulnerability) {
      best = { loc: dest, chanceToHit: defense, vulnerability, support };
    }
  }
  return best;
}
