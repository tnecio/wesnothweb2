/**
 * TS port of `ai_default_rca::move_leader_to_goals_phase` (`src/ai/default/
 * ca.cpp:267-388`): moves the leader towards the `leader_goal` aspect's
 * `x=`/`y=` hex, refusing to step onto any hex where the leader's own
 * hitpoints times `max_risk` (default `1 - caution`) would be exceeded by
 * enemy power projection. `auto_remove=yes` (with an `id=`) deletes the
 * facet via `[modify_ai]` once the goal is reached -- not ported (S5+
 * concern, `[modify_ai]` execution itself); this port logs instead of
 * silently no-op'ing, matching the project's convention.
 */

import { Location } from '../../model/Location.js';
import type { Unit } from '../../model/Unit.js';
import { findPath } from '../../pathfind/pathfind.js';
import { reachableHexes } from '../../pathfind/pathfind.js';
import { CandidateAction } from '../composite/rca.js';

export class MoveLeaderToGoalsCandidateAction extends CandidateAction {
  private pending: { leader: Unit; dest: Location; removeMovement: boolean; alreadyThere: boolean; autoRemoveId: string | undefined } | undefined;

  evaluate(): number {
    this.pending = undefined;
    const goalCfg = this.ctx.getLeaderGoalConfig();
    if (goalCfg.attributeNames().length === 0 && goalCfg.allChildren().length === 0) return 0;

    const maxRisk = goalCfg.hasAttribute('max_risk') ? goalCfg.getNumber('max_risk') : 1 - this.ctx.getCaution();
    const autoRemove = goalCfg.getBoolean('auto_remove', false);
    const dst = Location.fromConfig(goalCfg);
    if (!dst.valid()) return 0;

    const board = this.ctx.board;
    const leader = board
      .unitsForSide(this.ctx.side)
      .find((u) => u.canRecruit && !u.incapacitated && u.movesLeft > 0 && this.isAllowedUnit(u));
    if (!leader) return 0;

    const id = goalCfg.getString('id', '');

    if (leader.location.equals(dst)) {
      if (autoRemove && id) {
        // Falls through to the pathfind-to-self below (mirrors upstream exactly): from-self routing finds nothing,
        // so this always ends in BAD_SCORE once the removal is requested -- the facet deletion is a [modify_ai]
        // effect this port defers to S5 (GameSession's own modify_ai executor), logged rather than silently skipped.
        this.ctx.host.log('warn', `move_leader_to_goals: reached goal "${id}" with auto_remove=yes, but [modify_ai] facet removal is not wired until Phase 29 S5`);
      } else {
        this.pending = { leader, dest: dst, removeMovement: !autoRemove, alreadyThere: true, autoRemoveId: undefined };
        return this.score;
      }
    }

    const route = findPath(this.ctx.board, leader, dst, { viewingTeam: this.ctx.team() });
    if (route.steps.length === 0) return 0;

    const { destinations } = reachableHexes(this.ctx.board, leader, { viewingTeam: this.ctx.team() });
    const enemyDstSrc = this.ctx.getEnemyDstSrc();
    let loc: Location | undefined;
    for (const step of route.steps) {
      if (destinations.contains(step) && this.ctx.powerProjection(step, enemyDstSrc) < leader.hitpoints * maxRisk) {
        loc = step;
      }
    }
    if (!loc) return 0;

    this.pending = { leader, dest: loc, removeMovement: false, alreadyThere: false, autoRemoveId: autoRemove ? id : undefined };
    return this.score;
  }

  execute(): void {
    if (!this.pending) return;
    const { leader, dest } = this.pending;
    if (this.pending.alreadyThere) {
      // A "stay put" move that still burns the leader's turn unless auto_remove -- mirrors check_move_action(loc, loc, !auto_remove).
      if (this.pending.removeMovement) this.ctx.stopUnit(leader, true, false);
      return;
    }
    const route = findPath(this.ctx.board, leader, dest, { viewingTeam: this.ctx.team() });
    if (route.steps.length > 0) this.ctx.executeMove(leader, route.steps, false);
  }
}
