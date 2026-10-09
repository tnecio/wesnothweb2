/**
 * TS port of upstream's `ai_composite` (`src/ai/composite/ai.cpp/.hpp`):
 * the whole `[ai]` for one side -- its ordered stages, run in sequence
 * every turn. Building one from parsed WML (`config/upgrade.ts`'s
 * `ParsedSideAiConfig`) is `buildStagesFromConfigs`/`createAiComposite`
 * below, which walks every `[stage]` across the merged config list and
 * resolves each `[candidate_action]`'s `name=` against a registry --
 * unresolved names (real upstream CAs this port hasn't implemented yet,
 * e.g. `combat`/`recruitment` before Phase 29 S2/S3 land) are warned and
 * skipped rather than erroring, so a real `ai_default_rca` config can be
 * loaded incrementally as each stage of the port adds more CAs.
 */

import type { WmlConfig } from '../../wml/config.js';
import type { AiContext } from '../context.js';
import { CandidateAction, RcaStage } from './rca.js';
import { IdleStage, runAiSteps, type AiSteps, type Stage } from './stage.js';

export type CandidateActionFactory = (ctx: AiContext, cfg: WmlConfig) => CandidateAction;

/**
 * An AI engine other than the built-in C++ one (`ai::engine`, `engine_lua.cpp`): builds the candidate actions
 * whose `engine=` names it. `sideConfigs` are the side's merged `[ai]` configs, for the engine's own
 * `[engine]` block (its code and persistent data).
 */
export interface AiEngine {
  candidateAction(ctx: AiContext, cfg: WmlConfig, sideConfigs: readonly WmlConfig[]): CandidateAction | undefined;
  /** `engine::do_parse_stage_from_config`: a `[stage]` whose `engine=` names this engine. */
  stage?(ctx: AiContext, cfg: WmlConfig, sideConfigs: readonly WmlConfig[]): Stage | undefined;
  /** `engine_lua::apply_micro_ai`: a `[micro_ai]` from the side's `[ai]` (`side=` and `action=add` set). */
  applyMicroAi?(ctx: AiContext, sideConfigs: readonly WmlConfig[], cfg: WmlConfig): void;
  /** The engine's own `[engine]` block for `to_config` (its code and persistent data). */
  engineConfig?(ctx: AiContext): WmlConfig | undefined;
}

/** Builds one `[candidate_action]` through its engine (`engine::parse_candidate_action_from_config`). */
export function buildCandidateAction(
  ctx: AiContext,
  caCfg: WmlConfig,
  configs: readonly WmlConfig[],
  registry: ReadonlyMap<string, CandidateActionFactory>,
  engines: ReadonlyMap<string, AiEngine>,
  where: string,
): CandidateAction | undefined {
  const engine = caCfg.getString('engine', 'cpp');
  const caName = caCfg.getString('name', '');
  if (engine !== 'cpp') {
    const e = engines.get(engine);
    if (!e) {
      ctx.host.log('warn', `${where}: candidate_action id="${caCfg.getString('id', '')}" needs the ${engine} AI engine, which is not loaded -- skipped`);
      return undefined;
    }
    return e.candidateAction(ctx, caCfg, configs);
  }
  const factory = registry.get(caName);
  if (!factory) {
    ctx.host.log('warn', `${where}: candidate_action id="${caCfg.getString('id', '')}" name="${caName}" has no registered factory yet -- skipped`);
    return undefined;
  }
  return factory(ctx, caCfg);
}

/** Walks every `[stage]` child across `configs` (in order) and builds a real `Stage` for each -- `name=empty` becomes an `IdleStage`, anything else is treated as the (only real upstream variant this port implements) RCA main-loop stage. */
export function buildStagesFromConfigs(
  ctx: AiContext,
  configs: readonly WmlConfig[],
  registry: ReadonlyMap<string, CandidateActionFactory>,
  engines: ReadonlyMap<string, AiEngine> = new Map(),
): Stage[] {
  const stages: Stage[] = [];
  for (const cfg of configs) {
    for (const stageCfg of cfg.children('stage')) {
      const stageId = stageCfg.getString('id', '');
      const stageName = stageCfg.getString('name', '');
      if (stageName === 'empty') {
        stages.push(new IdleStage(stageId));
        continue;
      }
      // `engine::parse_stage_from_config`: a stage of another engine (`engine=lua`'s `lua_stage_wrapper`).
      const engine = stageCfg.getString('engine', 'cpp');
      if (engine !== 'cpp') {
        const built = engines.get(engine)?.stage?.(ctx, stageCfg, configs);
        if (built) stages.push(built);
        else ctx.host.log('warn', `AI stage "${stageId}" needs the ${engine} AI engine, which is not loaded -- skipped`);
        continue;
      }
      const candidateActions: CandidateAction[] = [];
      for (const caCfg of stageCfg.children('candidate_action')) {
        const ca = buildCandidateAction(ctx, caCfg, configs, registry, engines, `AI stage "${stageId}"`);
        if (ca) candidateActions.push(ca);
      }
      stages.push(new RcaStage(ctx, stageId, candidateActions));
    }
  }
  return stages;
}

/** Mirrors `ai_composite::play_turn`/`new_turn` (`src/ai/composite/ai.cpp:126-190`). */
export class AiComposite {
  readonly side: number;
  private readonly ctx: AiContext;
  private stages: Stage[];

  constructor(ctx: AiContext, stages: readonly Stage[]) {
    this.ctx = ctx;
    this.side = ctx.side;
    this.stages = [...stages];
  }

  listStages(): readonly Stage[] {
    return this.stages;
  }

  /** `ai_composite::add_stage`: appended after the others. */
  addStage(stage: Stage): void {
    this.stages.push(stage);
  }

  /** Runs every stage in order, stopping immediately if a scenario-ending event fired mid-turn. */
  playTurn(): void {
    runAiSteps(this.playTurnSteps());
  }

  /** The same, pausing after each action a stage takes (Phase 29a). */
  *playTurnSteps(): AiSteps<void> {
    for (const stage of this.stages) {
      if (this.ctx.host.scenarioEnded()) break;
      yield* stage.playStageSteps();
    }
  }

  /** Mirrors `ai_composite::new_turn`: invalidates cached move maps and defensive positions (this port doesn't cache resolved aspects or keeps yet -- see `composite/aspect.ts`'s own module doc comment on why that's a documented, not silent, simplification). */
  newTurn(): void {
    this.ctx.invalidateMoveMaps();
    this.ctx.invalidateDefensivePositionCache();
    this.ctx.clearRecentAttacks();
  }
}

export function createAiComposite(
  ctx: AiContext,
  configs: readonly WmlConfig[],
  registry: ReadonlyMap<string, CandidateActionFactory>,
  engines: ReadonlyMap<string, AiEngine> = new Map(),
): AiComposite {
  return new AiComposite(ctx, buildStagesFromConfigs(ctx, configs, registry, engines));
}
