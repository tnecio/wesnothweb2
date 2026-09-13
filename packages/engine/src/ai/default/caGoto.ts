/**
 * TS port of `ai_default_rca::goto_phase` (`src/ai/default/ca.cpp:53-153`).
 * Score 200000 (real WML, `data/core/macros/ai_candidate_actions.cfg`) --
 * the highest-priority default CA, so a unit with a pending `Unit.goto`
 * (Phase 29 S0) always finishes that errand before anything else acts.
 */

import { distanceBetween, type Location } from '../../model/Location.js';
import type { Unit } from '../../model/Unit.js';
import { findPath, reachableHexes } from '../../pathfind/pathfind.js';
import { CandidateAction } from '../composite/rca.js';

export class GotoCandidateAction extends CandidateAction {
  private pending: { unit: Unit; path: Location[] } | undefined;

  evaluate(): number {
    this.pending = undefined;
    const board = this.ctx.board;
    for (const unit of board.unitsForSide(this.ctx.side)) {
      if (!unit.goto || !board.map.onBoard(unit.goto)) continue;
      if (unit.goto.equals(unit.location)) {
        unit.goto = undefined;
        continue;
      }
      if (unit.movesLeft <= 0) continue;
      if (this.ctx.isPassiveLeader(unit.id)) continue;
      if (!this.isAllowedUnit(unit)) continue;

      const route = findPath(board, unit, unit.goto, { viewingTeam: this.ctx.team() });
      if (route.steps.length > 1) {
        this.pending = { unit, path: route.steps };
        return this.score;
      }

      // No direct route this turn: fall back to the reachable hex closest to the goto target (mirrors ca.cpp's own fallback).
      const { destinations } = reachableHexes(board, unit, { viewingTeam: this.ctx.team() });
      let bestLoc: Location | undefined;
      let bestDist = Infinity;
      for (const step of destinations.values()) {
        const d = distanceBetween(step.curr, unit.goto);
        if (d < bestDist) {
          bestDist = d;
          bestLoc = step.curr;
        }
      }
      if (bestLoc && !bestLoc.equals(unit.location)) {
        const fallbackRoute = findPath(board, unit, bestLoc, { viewingTeam: this.ctx.team() });
        if (fallbackRoute.steps.length > 1) {
          this.pending = { unit, path: fallbackRoute.steps };
          return this.score;
        }
      }
    }
    return 0;
  }

  execute(): void {
    if (!this.pending) return;
    const { unit, path } = this.pending;
    const outcome = this.ctx.executeMove(unit, path, true);
    if (!outcome.moved) {
      // Mirrors ca.cpp's execute(): if the path was blocked by an ally and nothing actually moved, burn the unit's
      // movement anyway so this CA isn't blacklisted for "lying" in evaluate() and other CAs get a turn.
      this.ctx.stopUnit(unit, true, false);
    }
  }
}
