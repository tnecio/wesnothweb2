/**
 * TS port of `ai_default_rca::aspect_attacks` (`src/ai/default/
 * aspect_attacks.cpp`): explores every combination of the AI's own units
 * attacking each visible enemy, up to depth 5, producing one
 * `AttackAnalysis` per combination -- the candidate pool `caCombat.ts`
 * picks the best-rated one from. This is the single most expensive part of
 * the default AI (documented, not silently accepted: no `unit_stats_cache`
 * here, see `attackAnalysis.ts`'s own module doc comment; a real
 * performance pass is Phase 29 S12).
 */

import { getAdjacentTiles, type Location } from '../../model/Location.js';
import type { GameBoard } from '../../model/GameBoard.js';
import type { Unit } from '../../model/Unit.js';
import type { WmlConfig } from '../../wml/config.js';
import { unitMatchesFilter } from '../../events/filter.js';
import { isUnitVisibleToTeam } from '../../pathfind/visibility.js';
import { isBackstabActive } from '../../actions/combat.js';
import { getActiveAbilities, computeAbilityEffect } from '../../actions/abilityEffects.js';
import { calculateMoves, type MoveMap } from '../moveMaps.js';
import { powerProjection } from '../powerProjection.js';
import type { AiContext } from '../context.js';
import { AttackAnalysis } from './attackAnalysis.js';

export interface AnalyzeTargetsOptions {
  /** `[filter_own]` on the `attacks` aspect's active facet -- gates which of the AI's own units may be used as attackers. */
  readonly filterOwn?: WmlConfig;
  /** `[filter_enemy]` -- gates which enemy units may be targeted at all. */
  readonly filterEnemy?: WmlConfig;
}

/** Mirrors `contexts.cpp`'s `under_leadership(unit, loc)`: the leadership bonus `unit` would get if it stood at the (possibly hypothetical) `loc`, not necessarily its current location. */
function leadershipBonusAt(board: GameBoard, unit: Unit, loc: Location): number {
  const abilities = getActiveAbilities(board, unit, 'leadership', loc);
  if (abilities.length === 0) return 0;
  return computeAbilityEffect(abilities, 0, unit);
}

/** Mirrors `aspect_attacks_base::rate_terrain` (`aspect_attacks.cpp:335-363`). */
export function rateTerrain(board: GameBoard, unit: Unit, loc: Location): number {
  const defense = unit.defenseModifier(board.map.getTerrain(loc));
  let rating = 100 - defense;

  const healingValue = 10;
  const friendlyVillageValue = 5;
  const neutralVillageValue = 10;
  const enemyVillageValue = 15;

  // Upstream checks `u.get_ability_bool("regenerate", loc)` (location-aware); this port's ability model has no
  // per-location filter evaluation yet, so it falls back to "has the regenerate ability at all" -- matches
  // `caHealing.ts`'s own established convention for the same ability.
  if (board.map.givesHealing(loc) > 0 && !unit.type.abilities.some((a) => a.tag === 'regenerate')) {
    rating += healingValue;
  }

  if (board.map.isVillage(loc)) {
    const owner = board.villageOwner(loc);
    if (owner === unit.side) rating += friendlyVillageValue;
    else if (owner === undefined) rating += neutralVillageValue;
    else rating += enemyVillageValue;
  }

  return rating;
}

/** Mirrors `aspect_attacks_base::do_attack_analysis` (`aspect_attacks.cpp:125-333`). */
function doAttackAnalysis(
  ctx: AiContext,
  loc: Location,
  srcDst: MoveMap,
  dstSrc: MoveMap,
  fullDstSrc: MoveMap,
  enemyDstSrc: MoveMap,
  tiles: readonly Location[],
  usedLocations: boolean[],
  units: Location[],
  result: AttackAnalysis[],
  curAnalysis: AttackAnalysis,
): void {
  const board = ctx.board;
  const MAX_ATTACK_DEPTH = 5;
  if (curAnalysis.movements.length >= MAX_ATTACK_DEPTH) return;

  const MAX_POSITIONS = 1000;
  if (result.length > MAX_POSITIONS && curAnalysis.movements.length > 0) return;

  for (let i = 0; i < units.length; i++) {
    const currentUnit = units[i]!;
    const unit = board.unitAt(currentUnit);
    if (!unit) continue;

    let backstab = false;
    let slow = false;
    for (const attack of unit.attacks) {
      // `id=` substitutes for upstream's special/ability tag lookup -- see `combatStats.ts`'s own module doc
      // comment on why that's precise for real mainline content (canonical specials set `id=` to their tag name).
      if (attack.specials.some((s) => s.getString('id', '') === 'backstab')) backstab = true;
      if (attack.specials.some((s) => s.getString('id', '') === 'slow')) slow = true;
    }

    if (slow && curAnalysis.movements.length !== 0) continue;

    // Surrounded check: flanked-by-opposite-enemy-pairs, or nearly boxed in.
    let isSurrounded = false;
    let isFlanked = false;
    let enemyUnitsAround = 0;
    let accessibleTiles = 0;
    const adj = getAdjacentTiles(currentUnit);
    const ownTeam = ctx.team();

    for (let tile = 0; tile !== 3; ++tile) {
      const tmpUnit = board.unitAt(adj[tile]!);
      let possibleFlanked = false;

      if (board.map.onBoard(adj[tile]!)) {
        accessibleTiles++;
        const tmpTeam = tmpUnit ? board.getTeam(tmpUnit.side) : undefined;
        if (tmpUnit && tmpTeam && ownTeam.isEnemy(tmpTeam)) {
          enemyUnitsAround++;
          possibleFlanked = true;
        }
      }

      const tmpOppositeUnit = board.unitAt(adj[tile + 3]!);
      if (board.map.onBoard(adj[tile + 3]!)) {
        accessibleTiles++;
        const oppositeTeam = tmpOppositeUnit ? board.getTeam(tmpOppositeUnit.side) : undefined;
        if (tmpOppositeUnit && oppositeTeam && ownTeam.isEnemy(oppositeTeam)) {
          enemyUnitsAround++;
          if (possibleFlanked) isFlanked = true;
        }
      }
    }
    if ((isFlanked && enemyUnitsAround > 2) || enemyUnitsAround >= accessibleTiles - 1) isSurrounded = true;

    let bestVulnerability = 0;
    let bestSupport = 0;
    let bestRating = 0;
    let curPosition = -1;

    const ppCtx = { turnNumber: ctx.turnNumber(), lawfulBonusAt: ctx.host.lawfulBonusAt, maxLiminalBonus: ctx.host.maxLiminalBonus };

    for (let j = 0; j < tiles.length; j++) {
      if (usedLocations[j]) continue;
      const tile = tiles[j]!;

      if (!tile.equals(currentUnit)) {
        const srcList = dstSrc.get(tile.key()) ?? [];
        const canReach = srcList.some((l) => l.equals(currentUnit));
        if (!canReach || board.unitAt(tile)) continue;
      }

      const bestLeadershipBonus = leadershipBonusAt(board, unit, tile);
      const leadershipBonus = (bestLeadershipBonus + 100) / 100;

      let backstabBonus = 1;
      let surroundBonus = 1.0;
      const oppositeTile = tiles[(j + 3) % 6]!;
      if (!oppositeTile.equals(currentUnit) && isBackstabActive(board, tile, loc)) {
        if (backstab) backstabBonus = 2;
        const oppositeUnit = board.unitAt(oppositeTile);
        if (oppositeUnit && !oppositeUnit.type.abilities.some((a) => a.tag === 'skirmisher')) {
          surroundBonus = 1.2;
        }
      }

      const rating = Math.trunc(rateTerrain(board, unit, tile) * backstabBonus * leadershipBonus);
      if (curPosition >= 0 && rating < bestRating) continue;

      const vulnerability = powerProjection(board, tile, enemyDstSrc, ppCtx);
      const support = powerProjection(board, tile, fullDstSrc, ppCtx);

      if (curPosition >= 0 && rating === bestRating && vulnerability / surroundBonus - support * surroundBonus >= bestVulnerability - bestSupport) {
        continue;
      }

      curPosition = j;
      bestRating = rating;
      bestVulnerability = vulnerability / surroundBonus;
      bestSupport = support * surroundBonus;
    }

    if (curPosition !== -1) {
      units.splice(i, 1);

      curAnalysis.movements.push({ from: currentUnit, to: tiles[curPosition]! });
      curAnalysis.vulnerability += bestVulnerability;
      curAnalysis.support += bestSupport;
      curAnalysis.isSurrounded = isSurrounded;
      curAnalysis.analyze(board, ctx, dstSrc, srcDst, enemyDstSrc, ctx.getAggression());
      result.push(curAnalysis.clone());

      usedLocations[curPosition] = true;

      doAttackAnalysis(ctx, loc, srcDst, dstSrc, fullDstSrc, enemyDstSrc, tiles, usedLocations, units, result, curAnalysis);

      usedLocations[curPosition] = false;

      curAnalysis.vulnerability -= bestVulnerability;
      curAnalysis.support -= bestSupport;
      curAnalysis.movements.pop();

      units.splice(i, 0, currentUnit);
    }
  }
}

/** Mirrors `aspect_attacks_base::analyze_targets` (`aspect_attacks.cpp:74-123`): every attack combination against every visible enemy. */
export function analyzeTargets(ctx: AiContext, options: AnalyzeTargetsOptions = {}): AttackAnalysis[] {
  const board = ctx.board;
  const team = ctx.team();
  const srcDst = ctx.getSrcDst();
  const dstSrc = ctx.getDstSrc();
  const enemyDstSrc = ctx.getEnemyDstSrc();

  const result: AttackAnalysis[] = [];

  const unitLocs: Location[] = [];
  for (const u of board.unitsForSide(ctx.side)) {
    if (u.attacksLeft > 0 && !(u.canRecruit && ctx.isPassiveLeader(u.id))) {
      if (options.filterOwn && !unitMatchesFilter(u, options.filterOwn, board)) continue;
      unitLocs.push(u.location);
    }
  }

  const usedLocations: boolean[] = [false, false, false, false, false, false];

  // "What could this side muster if every unit had full movement" -- feeds the `support` power-projection term only.
  const { dstSrc: fullDstSrc } = calculateMoves(board, ctx.side, { enemy: false, assumeFullMovement: true, viewingTeam: team, seeAll: true });

  for (const u of board.allUnits()) {
    const uTeam = board.getTeam(u.side);
    if (uTeam && team.isEnemy(uTeam) && !u.incapacitated && isUnitVisibleToTeam(board, u, team, false)) {
      if (options.filterEnemy && !unitMatchesFilter(u, options.filterEnemy, board)) continue;

      const adj = getAdjacentTiles(u.location);
      const analysis = new AttackAnalysis();
      analysis.target = u.location;
      analysis.vulnerability = 0;
      analysis.support = 0;

      doAttackAnalysis(ctx, u.location, srcDst, dstSrc, fullDstSrc, enemyDstSrc, adj, usedLocations, unitLocs, result, analysis);
    }
  }
  return result;
}
