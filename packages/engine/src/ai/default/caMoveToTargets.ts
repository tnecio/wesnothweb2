/**
 * TS port of `ai_default_rca::move_to_targets_phase` (`src/ai/default/
 * ca_move_to_targets.cpp`): repeatedly finds the best (unit, target) pairing
 * from `findTargets` and advances that unit towards it, until no eligible
 * unit or reachable target remains this turn.
 *
 * Deliberately NOT ported (documented simplification, matches this
 * project's "land the core loop, flag the rest" convention for genuinely
 * large sub-systems -- see `recruitment.ts`'s own module doc comment for
 * the same pattern): the "dangerous path" branch and everything under it
 * (`form_group`/`compare_groups`/`move_group`'s troop-massing, the
 * `support`-target `access_points` special case, and the
 * `battle_aid`/`mass` reinforcement target injection). Upstream only takes
 * that branch when `grouping != "no"` AND a threat is found along the
 * route; this port always falls through to upstream's OWN final fallback
 * (advance as far along the chosen route as this turn's movement allows,
 * `rate_target`'s scoring is otherwise identical) -- real, sensible
 * movement in every case, just without the "mass troops before attacking a
 * defended target" refinement.
 */

import { getAdjacentTiles, type Location } from '../../model/Location.js';
import type { Unit } from '../../model/Unit.js';
import type { PlainRoute } from '../../pathfind/astar.js';
import { aStarSearch, NO_PATH_VALUE, type CostCalculator } from '../../pathfind/astar.js';
import { locationMatchesFilterOnBoard } from '../../events/filter.js';
import type { GameBoard } from '../../model/GameBoard.js';
import { CandidateAction } from '../composite/rca.js';
import type { AiContext } from '../context.js';
import type { MoveMap } from '../moveMaps.js';
import type { Target } from '../composite/target.js';
import { findTargets } from './findTargets.js';

const DUMMY_ROUTE: PlainRoute = { steps: [], moveCost: 0 };

/** Mirrors `move_cost_calculator`: real terrain cost, quadrupled through any occupied hex (own or enemy) to discourage single-filing, further inflated per nearby enemy for a scout (`usage=="scout"`) trying to avoid them. */
class TargetMoveCostCalculator implements CostCalculator {
  private readonly avoidEnemies: boolean;
  constructor(
    private readonly board: GameBoard,
    private readonly unit: Unit,
    private readonly enemyDstSrc: MoveMap,
  ) {
    this.avoidEnemies = unit.type.usage === 'scout';
  }
  cost(loc: Location): number {
    const terrain = this.board.map.getTerrain(loc);
    const moveCost = this.unit.movementCost(terrain);
    if (moveCost > this.unit.maxMoves) return NO_PATH_VALUE;
    let res = moveCost;
    if (this.avoidEnemies) res *= 1.0 + (this.enemyDstSrc.get(loc.key())?.length ?? 0);
    if (this.board.hasUnitAt(loc)) res *= 4.0;
    return res;
  }
}

function enemiesAlongPath(steps: readonly Location[], enemyDstSrc: MoveMap): Set<string> {
  const res = new Set<string>();
  for (const loc of steps) {
    for (const adj of getAdjacentTiles(loc)) {
      for (const enemyLoc of enemyDstSrc.get(adj.key()) ?? []) res.add(enemyLoc.key());
    }
  }
  return res;
}

interface ChosenMove {
  readonly unit: Unit;
  readonly dest: Location;
}

export class MoveToTargetsCandidateAction extends CandidateAction {
  /** Mirrors `move_to_targets_phase::rate_target`. */
  private rateTarget(target: Target, unit: Unit, dstSrc: MoveMap, enemyDstSrc: MoveMap, route: PlainRoute): number {
    let moveCost = route.moveCost;
    if (moveCost > 0) {
      const reachers = dstSrc.get(target.loc.key()) ?? [];
      if (reachers.some((l) => l.equals(unit.location))) moveCost = 0;
    }

    let rating = target.value;
    if (rating === 0) return rating;
    if (moveCost > 0) rating /= moveCost;

    if (target.type === 'support') {
      if (moveCost <= unit.movesLeft * 2) rating *= 10.0;
      else return 0;
    }

    if (unit.type.usage === 'scout') {
      if (target.type === 'village') rating *= this.ctx.getScoutVillageTargeting();
      const guarding = enemiesAlongPath(route.steps, enemyDstSrc);
      if (guarding.size > 1) rating /= guarding.size;
      else rating *= 100;
    }

    return rating;
  }

  private isEligible(u: Unit): boolean {
    if (u.side !== this.ctx.side) return false;
    if (u.canRecruit && !this.ctx.isKeepIgnoringLeader(u.id)) return false;
    if (u.movesLeft <= 0 || u.incapacitated) return false;
    return true;
  }

  /** Mirrors `move_to_targets_phase::choose_move`. */
  private chooseMove(targets: readonly Target[]): ChosenMove | undefined {
    const board = this.ctx.board;

    for (const u of board.allUnits()) {
      if (this.isEligible(u) && u.guardian) return { unit: u, dest: u.location };
    }

    const unit = board.allUnits().find((u) => this.isEligible(u) && this.isAllowedUnit(u));
    if (!unit) return undefined;

    const dstSrc = this.ctx.getDstSrc();
    const enemyDstSrc = this.ctx.getEnemyDstSrc();

    const rated = targets.map((tg) => ({ tg, maxRating: this.rateTarget(tg, unit, dstSrc, enemyDstSrc, DUMMY_ROUTE) }));
    rated.sort((a, b) => b.maxRating - a.maxRating);

    let best: Unit | undefined;
    let bestRoute: PlainRoute = DUMMY_ROUTE;
    let bestRating = -1;
    let bestTarget: Target | undefined;

    const STOP_VALUE = 500;
    for (let i = 0; i < rated.length; i++) {
      const { tg, maxRating } = rated[i]!;
      const calc = new TargetMoveCostCalculator(board, unit, enemyDstSrc);
      const route = aStarSearch(unit.location, tg.loc, STOP_VALUE, calc, board.map.w(), board.map.h());
      if (route.steps.length === 0) continue;

      const rating = this.rateTarget(tg, unit, dstSrc, enemyDstSrc, route);
      if (rating > bestRating) {
        bestRating = rating === 0 ? 0.000000001 : rating;
        best = unit;
        bestRoute = route;
        bestTarget = tg;
        const next = rated[i + 1];
        if (next && bestRating >= next.maxRating) break;
      }
      void maxRating;
    }

    if (!bestTarget || !best) return undefined;

    if (!this.ctx.getSimpleTargeting()) {
      for (const u of board.allUnits()) {
        if (u === unit || !this.isEligible(u) || u.guardian || !this.isAllowedUnit(u)) continue;
        const calc = new TargetMoveCostCalculator(board, u, enemyDstSrc);
        const route = aStarSearch(u.location, bestTarget.loc, STOP_VALUE, calc, board.map.w(), board.map.h());
        if (route.steps.length === 0) continue;
        const rating = this.rateTarget(bestTarget, u, dstSrc, enemyDstSrc, route);
        if (rating > bestRating) {
          bestRating = rating;
          best = u;
          bestRoute = route;
        }
      }
    }

    // See module doc comment: the grouping/dangerous-path/support-access-points/mass-attack branches are not
    // ported. This always takes upstream's own final fallback: advance as far along the chosen route as this
    // unit's remaining movement allows this turn.
    let dest: Location | undefined;
    for (const step of bestRoute.steps) {
      const reachers = dstSrc.get(step.key()) ?? [];
      if (reachers.some((l) => l.equals(best!.location))) dest = step;
    }
    return { unit: best, dest: dest ?? best.location };
  }

  evaluate(): number {
    // Mirrors upstream exactly: this CA always claims its configured score; if execute() turns out to be a no-op,
    // RcaStage's own gamestate-unchanged blacklisting (see composite/rca.ts) disables it for the rest of the turn.
    return this.score;
  }

  execute(): void {
    const board = this.ctx.board;
    let targets: Target[] = [];

    for (;;) {
      if (targets.length === 0) {
        targets = findTargets(this.ctx, this.ctx.getEnemyDstSrc());
        if (targets.length === 0) break;
      }

      const avoidCfg = this.ctx.getAvoidConfig();
      targets = targets.filter((t) => board.map.onBoard(t.loc) && t.value > 0 && !locationMatchesFilterOnBoard(board, t.loc, avoidCfg));
      if (targets.length === 0) break;

      const move = this.chooseMove(targets);
      if (!move) break;

      if (move.dest.equals(move.unit.location)) {
        this.ctx.stopUnit(move.unit, true, false);
        continue;
      }

      const calc = new TargetMoveCostCalculator(board, move.unit, this.ctx.getEnemyDstSrc());
      const route = aStarSearch(move.unit.location, move.dest, board.map.w() + board.map.h(), calc, board.map.w(), board.map.h());
      if (route.steps.length === 0) break;

      const before = this.ctx.gamestateSnapshot();
      this.ctx.executeMove(move.unit, route.steps, true);
      if (this.ctx.gamestateSnapshot() === before) break;
    }
  }
}
