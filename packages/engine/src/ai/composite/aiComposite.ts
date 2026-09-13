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
import { IdleStage, type Stage } from './stage.js';

export type CandidateActionFactory = (ctx: AiContext, cfg: WmlConfig) => CandidateAction;

/** Walks every `[stage]` child across `configs` (in order) and builds a real `Stage` for each -- `name=empty` becomes an `IdleStage`, anything else is treated as the (only real upstream variant this port implements) RCA main-loop stage. */
export function buildStagesFromConfigs(ctx: AiContext, configs: readonly WmlConfig[], registry: ReadonlyMap<string, CandidateActionFactory>): Stage[] {
  const stages: Stage[] = [];
  for (const cfg of configs) {
    for (const stageCfg of cfg.children('stage')) {
      const stageId = stageCfg.getString('id', '');
      const stageName = stageCfg.getString('name', '');
      if (stageName === 'empty') {
        stages.push(new IdleStage(stageId));
        continue;
      }
      const candidateActions: CandidateAction[] = [];
      for (const caCfg of stageCfg.children('candidate_action')) {
        const caName = caCfg.getString('name', '');
        const factory = registry.get(caName);
        if (!factory) {
          ctx.host.log('warn', `AI stage "${stageId}": candidate_action id="${caCfg.getString('id', '')}" name="${caName}" has no registered factory yet -- skipped`);
          continue;
        }
        candidateActions.push(factory(ctx, caCfg));
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

  /** Runs every stage in order, stopping immediately if a scenario-ending event fired mid-turn. */
  playTurn(): void {
    for (const stage of this.stages) {
      if (this.ctx.host.scenarioEnded()) break;
      stage.playStage();
    }
  }

  /** Mirrors `ai_composite::new_turn`: invalidates cached move maps (this port doesn't cache resolved aspects or keeps/defensive-position data yet -- see `composite/aspect.ts`'s own module doc comment on why that's a documented, not silent, simplification). */
  newTurn(): void {
    this.ctx.invalidateMoveMaps();
    this.ctx.clearRecentAttacks();
  }
}

export function createAiComposite(ctx: AiContext, configs: readonly WmlConfig[], registry: ReadonlyMap<string, CandidateActionFactory>): AiComposite {
  return new AiComposite(ctx, buildStagesFromConfigs(ctx, configs, registry));
}
