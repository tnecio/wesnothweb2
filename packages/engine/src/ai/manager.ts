/**
 * TS port of the relevant slice of `ai::manager` (`src/ai/manager.cpp`):
 * one `AiComposite` per side, built lazily from that side's `[side][ai]`
 * blocks, replayed on `[modify_side][ai]` appends, and mutable via
 * `[modify_ai]`. `GameSession` (Phase 29 S5) owns exactly one `AiManager`
 * for the whole scenario.
 *
 * **Documented simplification** (matches this port's established pattern
 * for real-but-large upstream sub-systems): `[modify_ai]` path support is
 * limited to `stage[<id>].candidate_action[<ca_id>]` (add/delete/change) --
 * the single most common real-content shape (deleting/adding a candidate
 * action, e.g. Dead Water-style "recruitment_pattern"-adjacent tweaks and
 * the plan's own test scenario). `aspect[<id>].facet[<id>]` paths and
 * `AiComposite.toConfig()` (full save/restore of any `[modify_ai]`-made
 * change) are not ported -- a `[modify_ai]` change made mid-game does not
 * currently survive a save/load round-trip, only the original scenario
 * config does. `[micro_ai]` is a Phase 29 S9+ concern (needs the Lua
 * bridge) and just logs here.
 */

import type { GameBoard } from '../model/GameBoard.js';
import { WmlConfig } from '../wml/config.js';
import type { AiHost, AiAction } from './types.js';
import { parseSideAiConfig } from './config/upgrade.js';
import { DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON } from './config/builtinAiConfigs.generated.js';
import { AiContext } from './context.js';
import { AiComposite, createAiComposite, type CandidateActionFactory } from './composite/aiComposite.js';
import { RcaStage } from './composite/rca.js';
import { buildGoalsFromConfigs } from './composite/goal.js';
import { createDefaultCandidateActionRegistry } from './default/registry.js';

export type ModifyAiActionKind = 'add' | 'change' | 'delete' | 'try_delete';

interface SideAiState {
  readonly ctx: AiContext;
  readonly composite: AiComposite;
}

export class AiManager {
  private readonly sides = new Map<number, SideAiState>();
  private readonly extraBlocks = new Map<number, WmlConfig[]>();
  private readonly registry: ReadonlyMap<string, CandidateActionFactory>;

  constructor(
    private readonly host: AiHost,
    /** The real `[side][ai]` blocks for `side`, from the scenario's own config (typically `findSideConfig(scenarioConfigJson, side)?.children('ai') ?? []`). */
    private readonly sideAiConfigs: (side: number) => readonly WmlConfig[],
    registry: ReadonlyMap<string, CandidateActionFactory> = createDefaultCandidateActionRegistry(),
  ) {
    this.registry = registry;
  }

  private build(side: number): SideAiState {
    const blocks = [...this.sideAiConfigs(side), ...(this.extraBlocks.get(side) ?? [])];
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, blocks);
    const ctx = new AiContext(this.host, side, parsed.aspects, parsed.goals);
    const composite = createAiComposite(ctx, parsed.configs, this.registry);
    return { ctx, composite };
  }

  private getOrCreate(side: number): SideAiState {
    let state = this.sides.get(side);
    if (!state) {
      state = this.build(side);
      this.sides.set(side, state);
    }
    return state;
  }

  /** Plays `side`'s entire AI turn (`ai_composite::new_turn`+`play_turn`) and returns everything it did, ready for a host with a renderer to replay -- mirrors `simpleAi.ts`'s own `playAiTurn` return contract exactly, so `GameShell.playAiAnimations` needs no changes. */
  playTurn(side: number): AiAction[] {
    const { ctx, composite } = this.getOrCreate(side);
    composite.newTurn();
    composite.playTurn();
    return ctx.drainActionLog();
  }

  /** Mirrors `[modify_side][ai]`: appends another `[ai]` block for `side` (merged the same way multiple real `[side][ai]` blocks already are) and rebuilds its composite from scratch next time it's needed. */
  appendSideAi(side: number, cfg: WmlConfig): void {
    const list = this.extraBlocks.get(side);
    if (list) list.push(cfg);
    else this.extraBlocks.set(side, [cfg]);
    this.sides.delete(side);
  }

  /**
   * Mirrors `[modify_ai]`. Two path shapes are supported:
   *  - `goal[<id>]` (by far the most common real-content shape, e.g. Son
   *    of the Black Eye's "defend_Braga"/"defend_Meato"): add/delete a
   *    `[goal]`.
   *  - `stage[<id>].candidate_action[<ca_id>]`: add/delete a candidate
   *    action inside one RCA stage.
   * `add`/`change` need `cfg` (the `[goal]`/`[candidate_action]` body);
   * `change` is delete-then-add; `delete`/`try_delete` differ only in
   * whether a missing target is worth a warning (both are silent misses
   * here, matching upstream's `try_delete`'s own forgiving intent for
   * either). Any other path shape (`aspect[...]`, `stage[]` alone, ...) is
   * logged and ignored -- a documented gap, see this module's doc comment.
   */
  modifyAi(side: number, action: ModifyAiActionKind, path: string, cfg?: WmlConfig): boolean {
    const trimmed = path.trim();

    const goalMatch = /^goal\[([^\]]*)\]$/.exec(trimmed);
    if (goalMatch) {
      const { ctx } = this.getOrCreate(side);
      const [, goalId] = goalMatch;
      if (action === 'delete' || action === 'try_delete' || action === 'change') {
        ctx.deleteGoal(goalId ?? '');
      }
      if (action === 'add' || action === 'change') {
        if (!cfg) {
          this.host.log('warn', `[modify_ai] action="${action}" path="${path}" needs a [goal] body`);
          return false;
        }
        const goals = buildGoalsFromConfigs([(() => {
          const wrapper = new WmlConfig();
          wrapper.addChild('goal', cfg);
          return wrapper;
        })()], (name) => this.host.log('warn', `[modify_ai]: goal name="${name}" not recognized`));
        for (const goal of goals) ctx.addGoal(goal);
      }
      return true;
    }

    const caMatch = /^stage\[([^\]]*)\]\.candidate_action\[([^\]]*)\]$/.exec(trimmed);
    if (caMatch) {
      const [, stageId, caId] = caMatch;
      const { ctx, composite } = this.getOrCreate(side);
      const stage = composite.listStages().find((s) => s.id === stageId);
      if (!(stage instanceof RcaStage)) {
        this.host.log('warn', `[modify_ai] path="${path}": no RCA stage id="${stageId}" on side ${side}`);
        return false;
      }
      if (action === 'delete' || action === 'try_delete' || action === 'change') {
        stage.deleteCandidateAction(caId ?? '');
      }
      if (action === 'add' || action === 'change') {
        if (!cfg) {
          this.host.log('warn', `[modify_ai] action="${action}" path="${path}" needs a [candidate_action] body`);
          return false;
        }
        const name = cfg.getString('name', '');
        const factory = this.registry.get(name);
        if (!factory) {
          this.host.log('warn', `[modify_ai] candidate_action name="${name}" has no registered factory -- skipped`);
          return false;
        }
        stage.addCandidateAction(factory(ctx, cfg));
      }
      return true;
    }

    this.host.log('warn', `[modify_ai] path="${path}" is not a supported shape (only goal[id] and stage[id].candidate_action[id] are) -- ignored`);
    return false;
  }
}
