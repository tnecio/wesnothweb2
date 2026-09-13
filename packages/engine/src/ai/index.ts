// Phase 7 heuristic AI -- superseded by the framework below as of Phase 29 S5 (kept until then, see docs/IMPLEMENTATION_PLAN.md's Phase 29 section).
export * from './simpleAi.js';

// Phase 29: the real RCA candidate-action framework.
export type { AiAction, AiActionKind, AiAnimationEvent, AiHost } from './types.js';
export { AiContext } from './context.js';
export { calculateMoves, type CalculateMovesOptions, type CalculatedMoves, type MoveMap } from './moveMaps.js';
export { powerProjection, type PowerProjectionContext } from './powerProjection.js';
export { nearestKeep, suitableKeep, allKeeps } from './keeps.js';
export { isAspectActive, facetFromConfig, CompositeAspect, type AspectFacet } from './composite/aspect.js';
export { expandSimplifiedAspects, buildAspects, parseSideAiConfig, type ParsedSideAiConfig } from './config/upgrade.js';
export { CandidateAction, RcaStage, BAD_SCORE, DEFAULT_MAX_SCORE, EXECUTION_CAP } from './composite/rca.js';
export { IdleStage, type Stage } from './composite/stage.js';
export { AiComposite, buildStagesFromConfigs, createAiComposite, type CandidateActionFactory } from './composite/aiComposite.js';
export { GotoCandidateAction } from './default/caGoto.js';
export { MoveLeaderToKeepCandidateAction } from './default/caMoveLeaderToKeep.js';
export { LeaderSharesKeepCandidateAction } from './default/caLeaderSharesKeep.js';
export { HealingCandidateAction } from './default/caHealing.js';
export { VillagesCandidateAction } from './default/caVillages.js';
export { createDefaultCandidateActionRegistry } from './default/registry.js';
export { DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON } from './config/builtinAiConfigs.generated.js';
