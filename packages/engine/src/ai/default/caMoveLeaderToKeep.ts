/**
 * TS port of `ai_default_rca::move_leader_to_keep_phase` (`src/ai/
 * default/ca.cpp:389-534`). Score 120000. Sends an eligible leader
 * toward its `suitableKeep` (`../keeps.ts`) -- see that module's own doc
 * comment for the documented simplification vs. upstream's fuller
 * enemy-unreachable-hex ranking.
 */

import type { Location } from '../../model/Location.js';
import type { Unit } from '../../model/Unit.js';
import { findPath, reachableHexes } from '../../pathfind/pathfind.js';
import { CandidateAction } from '../composite/rca.js';

export class MoveLeaderToKeepCandidateAction extends CandidateAction {
  private pending: { unit: Unit; path: Location[] } | undefined;

  evaluate(): number {
    this.pending = undefined;
    if (this.ctx.isKeepIgnoringLeader('')) return 0;

    let bestLeader: Unit | undefined;
    let bestPath: Location[] | undefined;
    for (const leader of this.ctx.leaders()) {
      if (leader.movesLeft <= 0) continue;
      if (!this.isAllowedUnit(leader)) continue;
      if (this.ctx.isKeepIgnoringLeader(leader.id)) continue;
      const passive = this.ctx.isPassiveLeader(leader.id);
      const sharesKeep = this.ctx.isPassiveKeepSharingLeader(leader.id);
      if (passive && !sharesKeep) continue;

      const { destinations } = reachableHexes(this.ctx.board, leader, { viewingTeam: this.ctx.team() });
      const keep = this.ctx.suitableKeep(leader.location, destinations);
      if (!keep || keep.equals(leader.location)) continue;

      const route = findPath(this.ctx.board, leader, keep, { viewingTeam: this.ctx.team() });
      if (route.steps.length <= 1) continue;

      // Prefer whichever leader can get there directly this turn; if several qualify, the shortest route wins.
      if (!bestPath || route.steps.length < bestPath.length) {
        // Walk the leader as far along the route toward the keep as it can go this turn (the last reachable, empty hex on the route).
        const destSet = new Map(destinations.values().map((step) => [step.curr.key(), step]));
        let stopIndex = -1;
        for (let i = route.steps.length - 1; i >= 1; i--) {
          const step = route.steps[i]!;
          if (destSet.has(step.key()) && !this.ctx.board.hasUnitAt(step)) {
            stopIndex = i;
            break;
          }
        }
        if (stopIndex > 0) {
          bestLeader = leader;
          bestPath = route.steps.slice(0, stopIndex + 1);
        }
      }
    }

    if (bestLeader && bestPath) {
      this.pending = { unit: bestLeader, path: bestPath };
      return this.score;
    }
    return 0;
  }

  execute(): void {
    if (!this.pending) return;
    this.ctx.executeMove(this.pending.unit, this.pending.path, true);
  }
}
