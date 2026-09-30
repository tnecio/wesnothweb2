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

import { WmlConfig } from '../wml/config.js';
import type { AiHost, AiAction } from './types.js';
import { parseSideAiConfig } from './config/upgrade.js';
import { DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON } from './config/builtinAiConfigs.generated.js';
import { AiContext } from './context.js';
import { AiComposite, buildCandidateAction, createAiComposite, type AiEngine, type CandidateActionFactory } from './composite/aiComposite.js';
import { RcaStage } from './composite/rca.js';
import { buildGoalsFromConfigs } from './composite/goal.js';
import { createDefaultCandidateActionRegistry } from './default/registry.js';

export type ModifyAiActionKind = 'add' | 'change' | 'delete' | 'try_delete';

interface SideAiState {
  readonly ctx: AiContext;
  readonly composite: AiComposite;
  readonly configs: readonly WmlConfig[];
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
    /** Engines besides the built-in one, by `engine=` name (`lua`: lua-bridge's Lua AI engine). */
    private readonly engines: ReadonlyMap<string, AiEngine> = new Map(),
  ) {
    this.registry = registry;
  }

  private build(side: number): SideAiState {
    const blocks = [...this.sideAiConfigs(side), ...(this.extraBlocks.get(side) ?? [])];
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, blocks);
    const ctx = new AiContext(this.host, side, parsed.aspects, parsed.goals);
    const composite = createAiComposite(ctx, parsed.configs, this.registry, this.engines);
    return { ctx, composite, configs: parsed.configs };
  }

  private getOrCreate(side: number): SideAiState {
    let state = this.sides.get(side);
    if (!state) {
      state = this.build(side);
      this.sides.set(side, state);
      this.applyInitialModifications(side, state);
    }
    this.adoptUnitAi(side);
    return state;
  }

  /**
   * `unit::init`'s `[ai]` handling: a unit's own `[micro_ai]`s (filtered to it, `action=add`) and
   * `[candidate_action]`s (`[filter_own]` it, added to their stage) are appended to its side's AI
   * (`holder::append_ai`). Upstream does this when the unit is created; here, before the side's AI is next used.
   */
  private adoptUnitAi(side: number): void {
    if (this.adopting) return;
    const units = [...this.host.board.unitsForSide(side), ...this.host.board.recallList(side)].filter((u) => u.pendingAi);
    if (units.length === 0) return;
    this.adopting = true;
    try {
      for (const unit of units) {
        const ai = unit.pendingAi!;
        unit.pendingAi = undefined;
        const events = new WmlConfig();
        for (const micro of ai.children('micro_ai')) {
          const m = micro.clone();
          m.removeChildren('filter');
          m.addChild('filter').setAttribute('id', unit.id);
          m.setAttribute('side', unit.side);
          m.setAttribute('action', 'add');
          events.addChild('micro_ai', m);
        }
        for (const caCfg of ai.children('candidate_action')) {
          const ca = caCfg.clone();
          ca.removeChildren('filter_own');
          ca.addChild('filter_own').setAttribute('id', unit.id);
          const stage = ca.getString('stage', '') || 'main_loop';
          const mod = events.addChild('modify_ai');
          mod.setAttribute('action', 'add');
          mod.setAttribute('side', unit.side);
          mod.setAttribute('path', `stage[${stage}].candidate_action[]`);
          const body = new WmlConfig();
          for (const key of ca.attributeNames()) if (key !== 'stage' && key !== 'sticky') body.setAttribute(key, ca.getRaw(key)!);
          for (const c of ca.allChildren()) body.addChild(c.tag, c.config);
          mod.addChild('candidate_action', body);
        }
        this.appendAi(side, events);
      }
    } finally {
      this.adopting = false;
    }
  }

  private adopting = false;

  /** `holder::append_ai`: facets, goals, `[modify_ai]`s and `[micro_ai]`s added to the side's live AI. */
  appendAi(side: number, cfg: WmlConfig): void {
    const { ctx } = this.getOrCreate(side);
    for (const aspect of cfg.children('aspect')) {
      for (const facet of aspect.children('facet')) ctx.addFacet(aspect.getString('id'), facet);
    }
    for (const goal of cfg.children('goal')) this.modifyAi(side, 'add', 'goal[]', goal);
    for (const mod of cfg.children('modify_ai')) {
      this.modifyAi(side, (mod.getString('action', '') || 'add') as ModifyAiActionKind, mod.getString('path', ''), componentOf(mod));
    }
    for (const micro of cfg.children('micro_ai')) {
      const m = micro.clone();
      m.setAttribute('side', side);
      m.setAttribute('action', 'add');
      this.applyMicroAi(side, m);
    }
  }

  /** `holder::init`: the `[ai]` blocks' `[modify_ai]`s, then their `[micro_ai]`s (as `action=add` for this side). */
  private applyInitialModifications(side: number, state: SideAiState): void {
    for (const cfg of state.configs) {
      for (const mod of cfg.children('modify_ai')) {
        this.modifyAi(side, (mod.getString('action', '') || 'add') as ModifyAiActionKind, mod.getString('path', ''), componentOf(mod));
      }
    }
    for (const cfg of state.configs) {
      for (const micro of cfg.children('micro_ai')) {
        const body = micro.clone();
        body.setAttribute('side', side);
        body.setAttribute('action', 'add');
        this.applyMicroAi(side, body);
      }
    }
  }

  /** `holder::micro_ai`: handed to the Lua engine, which runs the `[micro_ai]` tag's Lua. */
  applyMicroAi(side: number, cfg: WmlConfig): void {
    const state = this.getOrCreate(side);
    const lua = this.engines.get('lua');
    if (!lua?.applyMicroAi) {
      this.host.log('warn', '[micro_ai]: the Lua AI engine is not loaded -- ignored');
      return;
    }
    lua.applyMicroAi(state.ctx, state.configs, cfg);
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
   * `holder::modify_ai` through `component_manager` (`src/ai/composite/component.cpp`): `path` names a
   * component by `property[id]`/`property[position]` steps, as upstream's `find_component` reads it. `cfg` is
   * the component itself (`add`/`change`). The shapes real content uses are handled:
   *  - `goal[...]`: add/change/delete a `[goal]`;
   *  - `stage[<id>].candidate_action[...]`: add/change/delete a candidate action in an RCA stage (`[<id>]`
   *    names one, `[n]` a position, none appends);
   *  - `aspect[<id>].facet[...]`: add/change/delete a facet (`*` deletes all).
   * Anything else is logged and ignored.
   */
  modifyAi(side: number, action: ModifyAiActionKind, path: string, cfg?: WmlConfig): boolean {
    const elements = parseComponentPath(path);
    const last = elements[elements.length - 1];
    if (!last) return this.unsupported(path);
    const state = this.getOrCreate(side);
    const { ctx, composite, configs } = state;
    const removing = action === 'delete' || action === 'try_delete' || action === 'change';
    const adding = action === 'add' || action === 'change';
    if (adding && !cfg) {
      this.host.log('warn', `[modify_ai] action="${action}" path="${path}" needs a component`);
      return false;
    }

    if (elements.length === 1 && last.property === 'goal') {
      if (removing) ctx.deleteGoal(last.id);
      if (adding) {
        const wrapper = new WmlConfig();
        wrapper.addChild('goal', cfg!);
        const goals = buildGoalsFromConfigs([wrapper], (name) => this.host.log('warn', `[modify_ai]: goal name="${name}" not recognized`));
        for (const goal of goals) ctx.addGoal(goal);
      }
      return true;
    }

    const [first] = elements;
    if (elements.length === 2 && first!.property === 'stage' && last.property === 'candidate_action') {
      const stage = composite.listStages().find((s) => s.id === first!.id);
      if (!(stage instanceof RcaStage)) {
        this.host.log('warn', `[modify_ai] path="${path}": no RCA stage id="${first!.id}" on side ${side}`);
        return false;
      }
      let position = last.position;
      if (removing) {
        const existing = stage.listCandidateActions();
        const index = last.position >= 0 ? last.position : existing.findIndex((ca) => ca.id === last.id);
        if (index >= 0 && index < existing.length) {
          position = index;
          stage.deleteCandidateAction(last.id === '*' ? '*' : existing[index]!.id);
        } else if (last.id === '*') stage.deleteCandidateAction('*');
        else if (action === 'change') return false;
      }
      if (adding) {
        const body = cfg!.clone();
        if (action === 'change' && !body.hasAttribute('id') && last.id !== '') body.setAttribute('id', last.id);
        const ca = buildCandidateAction(ctx, body, configs, this.registry, this.engines, `[modify_ai] path="${path}"`);
        if (!ca) return false;
        stage.insertCandidateAction(ca, position);
      }
      return true;
    }

    if (elements.length === 2 && first!.property === 'aspect' && last.property === 'facet') {
      if (removing) ctx.deleteFacet(first!.id, last.id);
      if (adding) {
        const body = cfg!.clone();
        if (action === 'change' && !body.hasAttribute('id') && last.id !== '') body.setAttribute('id', last.id);
        ctx.addFacet(first!.id, body);
      }
      return true;
    }

    return this.unsupported(path);
  }

  private unsupported(path: string): boolean {
    this.host.log('warn', `[modify_ai] path="${path}" is not supported here -- ignored`);
    return false;
  }

  /**
   * `holder::to_config`: the side's AI as it stands (its aspects, goals left out, stages with their candidate
   * actions, and each engine's own block) -- what `wesnoth.sides[n].__cfg` shows as `[ai]`.
   */
  toConfig(side: number): WmlConfig {
    const { ctx, composite } = this.getOrCreate(side);
    const cfg = new WmlConfig();
    for (const aspect of ctx.aspectConfigs()) cfg.addChild('aspect', aspect);
    for (const stage of composite.listStages()) {
      if (stage instanceof RcaStage) cfg.addChild('stage', stage.toConfig());
      else {
        const s = cfg.addChild('stage');
        s.setAttribute('id', stage.id);
        s.setAttribute('name', stage.name);
      }
    }
    for (const engine of this.engines.values()) {
      const e = engine.engineConfig?.(ctx);
      if (e) cfg.addChild('engine', e);
    }
    return cfg;
  }
}

/** A `[modify_ai]`'s component: its child named after the path's last element (`[candidate_action]`, `[facet]`, ...). */
function componentOf(mod: WmlConfig): WmlConfig | undefined {
  const last = parseComponentPath(mod.getString('path', '')).pop();
  return last ? mod.child(last.property) : undefined;
}

interface PathElement {
  readonly property: string;
  /** `[n]`, or -2 when not given (upstream's convention). */
  readonly position: number;
  readonly id: string;
}

/** `find_component`'s path grammar: `property`, `property[n]` or `property[id]`, joined by dots. */
export function parseComponentPath(path: string): PathElement[] {
  const out: PathElement[] = [];
  const re = /([^.[]+)(\[(\d*)\]|\[([^\]]+)\]|())/g;
  for (const m of path.trim().matchAll(re)) {
    const position = m[3] !== undefined && m[3] !== '' ? Number(m[3]) : -2;
    out.push({ property: m[1]!.replace(/^\./, ''), position, id: m[4] ?? '' });
  }
  return out;
}
