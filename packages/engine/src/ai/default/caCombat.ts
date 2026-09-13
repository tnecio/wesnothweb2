/**
 * TS port of `ai_default_rca::combat_phase` (`src/ai/default/ca.cpp:
 * 154-266`). Picks the best-`rating()`-scoring `AttackAnalysis` out of the
 * `attacks` aspect (`AiContext.getAttacks()`), filtered to combos this CA's
 * own `[filter_own]` allows every attacker in, then executes just the
 * FIRST attacker's (move +) attack -- matching upstream exactly: only
 * `movements[0]` is ever executed; if the chosen combo has more attackers,
 * the CA simply gets picked again next RCA pass once the gamestate change
 * invalidates the `attacks` cache and a fresh (now smaller) combo is found.
 *
 * Not ported here (matches upstream: `combat_phase::execute` itself does
 * not call advancement -- that's baked into the C++ engine's synced attack
 * command executor, `attack_unit_and_advance`, invisible to the candidate
 * action): explicit `advanceUnitFully` calls are still made, matching this
 * port's own established convention (`simpleAi.ts`'s `playAiTurn`) of
 * making that real, observable behaviour explicit at the TS call site
 * since there's no engine-wide synced-command layer to hide it in here.
 */

import { findPath } from '../../pathfind/pathfind.js';
import { isBackstabActive } from '../../actions/combat.js';
import { computeLeadershipBonus } from '../../actions/abilityEffects.js';
import { advanceUnitFully } from '../../actions/advancement.js';
import { CandidateAction } from '../composite/rca.js';
import { AttackAnalysis, chooseAttackerWeapon } from './attackAnalysis.js';

export class CombatCandidateAction extends CandidateAction {
  private bestAnalysis: AttackAnalysis | undefined;
  private bestRating = -1000;

  evaluate(): number {
    this.bestAnalysis = undefined;
    this.bestRating = -1000;

    const board = this.ctx.board;
    const aggression = this.ctx.getAggression();

    for (const analysis of this.ctx.getAttacks()) {
      let skip = false;
      for (const m of analysis.movements) {
        const u = board.unitAt(m.from);
        if (!u || !this.isAllowedUnit(u)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;

      const rating = analysis.rating(aggression, this.ctx);
      if (rating > this.bestRating) {
        this.bestAnalysis = analysis;
        this.bestRating = rating;
      }
    }

    return this.bestRating > 0.0 ? this.score : 0;
  }

  execute(): void {
    if (!this.bestAnalysis || this.bestRating <= 0.0) return;
    const board = this.ctx.board;
    const { from, to } = this.bestAnalysis.movements[0]!;
    const targetLoc = this.bestAnalysis.target;

    if (!from.equals(to)) {
      const attackerUnit = board.unitAt(from);
      if (!attackerUnit) return;
      const route = findPath(board, attackerUnit, to, { viewingTeam: this.ctx.team() });
      if (route.steps.length === 0) return;
      const moveResult = this.ctx.executeMove(attackerUnit, route.steps, false);
      if (!moveResult.moved) return;
    }

    const attacker = board.unitAt(to);
    const defender = board.unitAt(targetLoc);
    if (!attacker || !defender || attacker.attacksLeft <= 0) return;

    const distance = 1;
    const attackerTerrainDefense = attacker.defenseModifier(board.map.getTerrain(to));
    const defenderTerrainDefense = defender.defenseModifier(board.map.getTerrain(targetLoc));
    const choice = chooseAttackerWeapon(attacker, defender, distance, attackerTerrainDefense, defenderTerrainDefense, this.ctx.getAggression(), {
      backstabActive: isBackstabActive(board, to, targetLoc),
      attackerLeadershipBonus: computeLeadershipBonus(board, attacker),
      defenderLeadershipBonus: computeLeadershipBonus(board, defender),
    });
    if (!choice) return;

    this.ctx.executeAttack(to, choice.attackerWeaponIndex, targetLoc, choice.defenderWeaponIndex);

    const survivingAttacker = board.unitAt(to);
    if (survivingAttacker) {
      for (const _step of advanceUnitFully(board, survivingAttacker, this.ctx.host.rng, this.ctx.host.resolveType)) {
        /* real, observable behaviour (see module doc comment); no action log at this layer yet -- Phase 29 S5. */
      }
    }
    const survivingDefender = board.unitAt(targetLoc);
    if (survivingDefender) {
      for (const _step of advanceUnitFully(board, survivingDefender, this.ctx.host.rng, this.ctx.host.resolveType)) {
        /* see above */
      }
    }
  }
}
