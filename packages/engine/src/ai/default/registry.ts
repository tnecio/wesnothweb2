/**
 * TS port of the relevant slice of `src/ai/registry.cpp`: the real
 * upstream `name=` -> candidate-action-class table. `buildStagesFromConfigs`
 * (`composite/aiComposite.ts`) looks candidate actions up here by their
 * WML `name=` (e.g. `ai_default_rca::goto_phase`); a name with no entry
 * yet (most of the real default AI, until Phase 29's later stages land)
 * is warned and skipped rather than erroring.
 */

import type { CandidateActionFactory } from '../composite/aiComposite.js';
import { GotoCandidateAction } from './caGoto.js';
import { MoveLeaderToKeepCandidateAction } from './caMoveLeaderToKeep.js';
import { LeaderSharesKeepCandidateAction } from './caLeaderSharesKeep.js';
import { HealingCandidateAction } from './caHealing.js';
import { VillagesCandidateAction } from './caVillages.js';
import { CombatCandidateAction } from './caCombat.js';
import { RecruitmentCandidateAction } from './recruitment.js';
import { MoveLeaderToGoalsCandidateAction } from './caMoveLeaderToGoals.js';
import { MoveToTargetsCandidateAction } from './caMoveToTargets.js';
import { RetreatCandidateAction } from './caRetreat.js';

export function createDefaultCandidateActionRegistry(): Map<string, CandidateActionFactory> {
  const registry = new Map<string, CandidateActionFactory>();
  registry.set('ai_default_rca::goto_phase', (ctx, cfg) => new GotoCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::combat_phase', (ctx, cfg) => new CombatCandidateAction(ctx, cfg));
  registry.set('default_recruitment::recruitment', (ctx, cfg) => new RecruitmentCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::move_leader_to_goals_phase', (ctx, cfg) => new MoveLeaderToGoalsCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::move_to_targets_phase', (ctx, cfg) => new MoveToTargetsCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::retreat_phase', (ctx, cfg) => new RetreatCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::move_leader_to_goals_phase', (ctx, cfg) => new MoveLeaderToGoalsCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::retreat_phase', (ctx, cfg) => new RetreatCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::default_move_to_targets_phase', (ctx, cfg) => new MoveToTargetsCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::testing_move_to_targets_phase', (ctx, cfg) => new MoveToTargetsCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::move_leader_to_keep_phase', (ctx, cfg) => new MoveLeaderToKeepCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::leader_shares_keep_phase', (ctx, cfg) => new LeaderSharesKeepCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::passive_leader_shares_keep_phase', (ctx, cfg) => new LeaderSharesKeepCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::get_healing_phase', (ctx, cfg) => new HealingCandidateAction(ctx, cfg));
  registry.set('ai_default_rca::get_villages_phase', (ctx, cfg) => new VillagesCandidateAction(ctx, cfg));
  // Legacy testing_ai_default:: aliases (real upstream registers every C++ CA under both names -- src/ai/registry.cpp).
  registry.set('testing_ai_default::goto_phase', (ctx, cfg) => new GotoCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::combat_phase', (ctx, cfg) => new CombatCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::move_leader_to_keep_phase', (ctx, cfg) => new MoveLeaderToKeepCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::leader_shares_keep_phase', (ctx, cfg) => new LeaderSharesKeepCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::get_healing_phase', (ctx, cfg) => new HealingCandidateAction(ctx, cfg));
  registry.set('testing_ai_default::get_villages_phase', (ctx, cfg) => new VillagesCandidateAction(ctx, cfg));
  return registry;
}
