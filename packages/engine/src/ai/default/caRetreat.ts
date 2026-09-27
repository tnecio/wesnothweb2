/**
 * TS port of `ai_default_rca::retreat_phase` (`src/ai/default/ca.cpp:
 * 1388-1540`), used only by the `ai_default_rca_1_14` fallback algorithm
 * (the current default `ai_default_rca` uses the Lua `retreat_injured`
 * micro-loop CA instead -- Phase 29 S7+). A full-health-but-outmatched
 * unit (not a leader) retreats to whichever reachable hex best balances
 * its own vs. the enemy's power projection, falling back to the single
 * best DEFENSIVE hex if none clearly favor it -- unless it's within reach
 * of its own leader, in which case it stays to defend instead.
 */

import { getAdjacentTiles, type Location } from '../../model/Location.js';
import type { Unit } from '../../model/Unit.js';
import { findPath } from '../../pathfind/pathfind.js';
import { locationMatchesFilterOnBoard } from '../../events/filter.js';
import { CandidateAction } from '../composite/rca.js';
import { calculateMoves, type MoveMap } from '../moveMaps.js';

export class RetreatCandidateAction extends CandidateAction {
  private pending: { unit: Unit; dest: Location } | undefined;

  /** Mirrors `retreat_phase::should_retreat` (always called with the unit's own current location in this port -- the only call site never passes a hypothetical one). */
  private shouldRetreat(unit: Unit, fullSrcDst: MoveMap, fullDstSrc: MoveMap, caution: number): boolean {
    if (caution <= 0) return false;
    const board = this.ctx.board;
    const enemyDstSrc = this.ctx.getEnemyDstSrc();
    const pos = this.ctx.bestDefensivePosition(unit.location, fullSrcDst, fullDstSrc, enemyDstSrc);

    const optimalTerrain = pos.chanceToHit / 100;
    const proposedTerrain = unit.defenseModifier(board.map.getTerrain(unit.location)) / 100;
    const exposure = proposedTerrain - optimalTerrain;

    const ourPower = this.ctx.powerProjection(unit.location, fullDstSrc);
    const theirPower = this.ctx.powerProjection(unit.location, enemyDstSrc);
    return caution * theirPower * (1.0 + exposure) > ourPower;
  }

  evaluate(): number {
    this.pending = undefined;
    const board = this.ctx.board;
    const avoidCfg = this.ctx.getAvoidConfig();
    const { srcDst: fullSrcDst, dstSrc: fullDstSrc } = calculateMoves(board, this.ctx.side, {
      enemy: false,
      assumeFullMovement: true,
      avoid: (loc) => locationMatchesFilterOnBoard(board, loc, avoidCfg),
      viewingTeam: this.ctx.team(),
    });

    const leaders = this.ctx.leaders();
    const leaderAdjacent = new Set<string>();
    for (const leader of leaders) {
      for (const adj of getAdjacentTiles(leader.location)) leaderAdjacent.add(adj.key());
    }

    const caution = this.ctx.getCaution();
    const srcDst = this.ctx.getSrcDst();
    const dstSrc = this.ctx.getDstSrc();
    const enemyDstSrc = this.ctx.getEnemyDstSrc();

    for (const unit of board.unitsForSide(this.ctx.side)) {
      if (unit.movesLeft !== unit.maxMoves) continue;
      if (leaders.includes(unit)) continue;
      if (unit.incapacitated || !this.isAllowedUnit(unit)) continue;
      if (!this.shouldRetreat(unit, fullSrcDst, fullDstSrc, caution)) continue;

      let canReachLeader = false;
      let bestPos: Location | undefined;
      let bestRating = -1000;
      let bestDefensive = unit.location;
      let bestDefensiveRating = unit.defenseModifier(board.map.getTerrain(unit.location)) - (board.map.isVillage(unit.location) ? 10 : 0);

      for (const hex of srcDst.get(unit.location.key()) ?? []) {
        if (leaderAdjacent.has(hex.key())) {
          canReachLeader = true;
          break;
        }

        const defense = unit.defenseModifier(board.map.getTerrain(hex));
        const ourPower = this.ctx.powerProjection(hex, dstSrc);
        const theirPower = this.ctx.powerProjection(hex, enemyDstSrc) * (defense / 100);
        const rating = ourPower - theirPower;
        if (rating > bestRating) {
          bestPos = hex;
          bestRating = rating;
        }

        const modifiedDefense = defense - (board.map.isVillage(hex) ? 10 : 0);
        if (modifiedDefense < bestDefensiveRating) {
          bestDefensiveRating = modifiedDefense;
          bestDefensive = hex;
        }
      }

      if (canReachLeader) continue;
      const dest = bestPos ?? bestDefensive;
      this.pending = { unit, dest };
      return this.score;
    }

    return 0;
  }

  execute(): void {
    if (!this.pending) return;
    const { unit, dest } = this.pending;
    if (dest.equals(unit.location)) {
      this.ctx.stopUnit(unit, true, false);
      return;
    }
    const route = findPath(this.ctx.board, unit, dest, { viewingTeam: this.ctx.team() });
    if (route.steps.length > 0) this.ctx.executeMove(unit, route.steps, true);
  }
}
