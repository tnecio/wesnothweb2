/**
 * TS port of `ai_default_rca::get_healing_phase` (`src/ai/default/ca.cpp:
 * 1313-1387`). Score 80000. Sends a damaged or poisoned unit (that lacks
 * `regenerate` and isn't a passive leader) to the reachable healing-
 * terrain hex with the lowest `powerProjection` against enemy threat,
 * moving only if the leftover vulnerability (doubled for leaders) is
 * still less than the unit's own hitpoints.
 */

import type { Location } from '../../model/Location.js';
import type { Unit } from '../../model/Unit.js';
import { findPath } from '../../pathfind/pathfind.js';
import { POISON_AMOUNT } from '../../actions/gameConfig.js';
import { CandidateAction } from '../composite/rca.js';

export class HealingCandidateAction extends CandidateAction {
  private pending: { unit: Unit; dest: Location } | undefined;

  evaluate(): number {
    this.pending = undefined;
    const board = this.ctx.board;
    const enemyDstSrc = this.ctx.getEnemyDstSrc();

    for (const unit of board.unitsForSide(this.ctx.side)) {
      if (this.ctx.isPassiveLeader(unit.id)) continue;
      if (!this.isAllowedUnit(unit)) continue;
      if (unit.type.abilities.some((a) => a.tag === 'regenerate')) continue;
      const damaged = unit.hitpoints < unit.maxHitpoints - POISON_AMOUNT / 2;
      if (!damaged && !unit.poisoned) continue;

      const destinations = this.ctx.getSrcDst().get(unit.location.key());
      if (!destinations) continue;

      let bestDest: Location | undefined;
      let bestVulnerability = Infinity;
      for (const dst of destinations) {
        if (board.map.givesHealing(dst) <= 0) continue;
        if (!dst.equals(unit.location) && board.hasUnitAt(dst)) continue;
        const vulnerability = this.ctx.powerProjection(dst, enemyDstSrc);
        if (vulnerability < bestVulnerability) {
          bestVulnerability = vulnerability;
          bestDest = dst;
        }
      }
      if (!bestDest || bestDest.equals(unit.location)) continue;

      const leaderPenalty = unit.canRecruit ? 2.0 : 1.0;
      if (bestVulnerability * leaderPenalty < unit.hitpoints) {
        this.pending = { unit, dest: bestDest };
        return this.score;
      }
    }
    return 0;
  }

  execute(): void {
    if (!this.pending) return;
    const { unit, dest } = this.pending;
    const route = findPath(this.ctx.board, unit, dest, { viewingTeam: this.ctx.team() });
    if (route.steps.length > 1) this.ctx.executeMove(unit, route.steps, true);
  }
}
