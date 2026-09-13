/**
 * TS port of `ai_default_rca::leader_shares_keep_phase` (`src/ai/
 * default/ca.cpp:1563-1650`). Score 10000 -- lowest of the C++ CAs, runs
 * only once nothing more important is left to do. Moves an own leader
 * off its keep so an allied leader can use it, when both are true: some
 * own leader isn't passive (or is a passive-but-keep-sharing one) and
 * stands on a keep, and some allied side has a leader.
 *
 * Simplified vs. upstream (documented): upstream checks that an allied
 * leader could ACTUALLY reach and use the specific keep this turn; this
 * port triggers off "any allied side has a leader at all" instead, which
 * is faithful for the common single-keep-per-castle case Phase 29's own
 * tests exercise but can move a leader off a keep no ally can currently
 * reach.
 */

import type { Location } from '../../model/Location.js';
import type { Unit } from '../../model/Unit.js';
import { findPath, reachableHexes } from '../../pathfind/pathfind.js';
import { CandidateAction } from '../composite/rca.js';

export class LeaderSharesKeepCandidateAction extends CandidateAction {
  private pending: { unit: Unit; dest: Location } | undefined;

  evaluate(): number {
    this.pending = undefined;
    const board = this.ctx.board;
    const ownTeam = this.ctx.team();

    const eligibleLeaders = this.ctx.leaders().filter((leader) => {
      if (!this.isAllowedUnit(leader)) return false;
      const passive = this.ctx.isPassiveLeader(leader.id);
      const sharesKeep = this.ctx.isPassiveKeepSharingLeader(leader.id);
      return !passive || sharesKeep;
    });
    if (eligibleLeaders.length === 0) return 0;

    const hasAlliedLeader = board
      .teams()
      .some((t) => t.side !== this.ctx.side && !ownTeam.isEnemy(t) && board.unitsForSide(t.side).some((u) => u.canRecruit));
    if (!hasAlliedLeader) return 0;

    for (const leader of eligibleLeaders) {
      if (!board.map.isKeep(leader.location)) continue;
      const { destinations } = reachableHexes(board, leader, { viewingTeam: ownTeam });
      for (const step of destinations.values()) {
        if (step.curr.equals(leader.location)) continue;
        if (board.map.isKeep(step.curr)) continue;
        if (board.hasUnitAt(step.curr)) continue;
        this.pending = { unit: leader, dest: step.curr };
        return this.score;
      }
    }
    return 0;
  }

  execute(): void {
    if (!this.pending) return;
    const route = findPath(this.ctx.board, this.pending.unit, this.pending.dest, { viewingTeam: this.ctx.team() });
    if (route.steps.length > 1) this.ctx.executeMove(this.pending.unit, route.steps, true);
  }
}
