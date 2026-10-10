/**
 * The `[modify_ai]`/`[modify_side]`/`[micro_ai]` WML action tags, wired to
 * whatever `EventContext.ai` a host supplies (`packages/ui`'s `GameSession`,
 * via `AiManager`, Phase 29 S5). Registering these three tags here (rather
 * than inline in `actionWml.ts`, which knows nothing about the AI package)
 * keeps `packages/engine/src/events/` free of an `ai/` import for anything
 * but this one file's own type reference.
 *
 * `[micro_ai]` is a stub until Phase 29 S9 (needs the Lua bridge) --
 * logs "not loaded" rather than silently doing nothing, matching this
 * project's "inert until the stage that needs it, never silently wrong"
 * convention.
 */

import type { WmlConfig } from '../wml/config.js';
import type { ActionRegistry, EventContext } from '../events/context.js';
import { parseComponentPath, type ModifyAiActionKind } from './manager.js';
import { getSides } from '../events/sideFilter.js';
import { parseController, parseDefeatCondition } from '../model/Team.js';
import { applySetVariable, actionClearVariable, actionSetVariables } from '../events/actionWml.js';
import { VariableStore, newVarNode, varNodeFromConfig } from '../events/variables.js';

export interface AiWmlHooks {
  modifyAi(side: number, action: ModifyAiActionKind, path: string, cfg: WmlConfig | undefined): void;
  /** `[modify_side]`'s `[ai]` child(ren) -- every other `[modify_side]` field (`team_name=`, `controller=`, ...) is handled by the caller's own existing side-field logic, not here. */
  appendSideAi(side: number, cfg: WmlConfig): void;
  /** `[modify_side][ai]` naming an `ai_algorithm=`: the side's AI replaced by these blocks. */
  switchSideAi(side: number, cfgs: readonly WmlConfig[]): void;
  microAi(side: number, cfg: WmlConfig): void;
}

function parseModifyAiAction(raw: string): ModifyAiActionKind {
  if (raw === 'add' || raw === 'change' || raw === 'delete' || raw === 'try_delete') return raw;
  return 'add';
}

export function registerAiWmlActions(registry: ActionRegistry): void {
  registry.register('modify_ai', (cfg: WmlConfig, ctx: EventContext) => {
    if (!ctx.ai) {
      ctx.log('warn', '[modify_ai]: no AI engine loaded for this session -- ignored');
      return;
    }
    const action = parseModifyAiAction(cfg.getString('action', 'add'));
    const path = cfg.getString('path', '');
    // `component_manager::add_component`: the component is the child named after the path's last element.
    const last = parseComponentPath(path).pop();
    // modify_ai.lua: `utils.get_sides(cfg)`, each in turn.
    for (const side of getSides(ctx.board, cfg, ctx.log)) ctx.ai.modifyAi(side, action, path, last ? cfg.child(last.property) : undefined);
  });

  registry.register('modify_side', actionModifySide);

  registry.register('micro_ai', (cfg: WmlConfig, ctx: EventContext) => {
    if (!ctx.ai) {
      ctx.log('warn', '[micro_ai]: no AI engine loaded for this session -- ignored');
      return;
    }
    const side = cfg.getNumber('side', 1);
    ctx.ai.microAi(side, cfg);
  });
}

/**
 * `wml_actions.modify_side` (`data/lua/wml/modify_side.lua`): every side `utils.get_sides` names -- `side=` (a
 * list) or `[filter_side]` -- takes each key the tag gives. As there, changing fog or shroud sets the flag only:
 * the hexes stay as they are until the next vision update (`[redraw]` is the board's own redraw, a no-op here).
 */
function actionModifySide(cfg: WmlConfig, ctx: EventContext): void {
  for (const sideNumber of getSides(ctx.board, cfg, ctx.log)) {
    const side = ctx.board.getTeam(sideNumber);
    if (!side) continue;
    const has = (key: string): boolean => cfg.hasAttribute(key);
    if (has('team_name')) side.teamName = cfg.getString('team_name');
    if (has('user_team_name')) side.userTeamName = cfg.getString('user_team_name');
    if (has('side_name')) side.sideName = cfg.getString('side_name');
    if (has('controller')) side.controller = parseController(cfg.getString('controller'));
    if (has('defeat_condition')) side.defeatCondition = parseDefeatCondition(cfg.getString('defeat_condition'));
    if (has('recruit')) side.canRecruit = new Set(cfg.getString('recruit').split(',').map((r) => r.trim()).filter((r) => r !== ''));
    if (has('village_support')) side.supportPerVillage = cfg.getNumber('village_support');
    if (has('village_gold')) side.incomePerVillage = cfg.getNumber('village_gold');
    // `side.base_income = income + base_income`: this port keeps income= and adds the base when paying.
    if (has('income')) side.income = cfg.getNumber('income');
    if (has('gold')) side.gold = cfg.getNumber('gold');
    if (has('hidden')) side.hidden = cfg.getBoolean('hidden');
    // `side:set_id(flag, color)`
    if (has('color')) side.color = cfg.getString('color');
    if (has('flag')) side.flag = cfg.getString('flag');
    if (has('flag_icon')) side.flagIcon = cfg.getString('flag_icon');
    if (has('suppress_end_turn_confirmation')) side.suppressEndTurnConfirmation = cfg.getBoolean('suppress_end_turn_confirmation');
    if (has('scroll_to_leader')) side.scrollToLeader = cfg.getBoolean('scroll_to_leader');
    if (has('shroud')) side.shroud.enabled = cfg.getBoolean('shroud');
    // `side:override_shroud({})`: shrouded everywhere again.
    if (cfg.getBoolean('reset_maps', false)) side.reshroud();
    if (has('fog')) side.fog.enabled = cfg.getBoolean('fog');
    // `side:place_fog({}, true)`: fogged everywhere again, and the multi-turn [lift_fog] clearings gone.
    if (cfg.getBoolean('reset_view', false)) {
      side.fogClearer.clear();
      side.refog();
    }
    if (has('shroud_data')) side.shroud.read(cfg.getString('shroud_data'));
    if (has('share_vision')) {
      const v = cfg.getString('share_vision');
      side.shareVision = v === 'shroud' || v === 'none' ? v : 'all';
    }
    // Legacy support
    if (has('share_view') || has('share_maps')) {
      side.shareVision = cfg.getBoolean('share_view', false) ? 'all' : cfg.getBoolean('share_maps', false) ? 'shroud' : 'none';
    }

    // The side's own variables, and its [ai].
    const ais: WmlConfig[] = [];
    let replaceAi = false;
    let vars: VariableStore | undefined;
    const sideVars = (): VariableStore => (vars ??= new VariableStore(side.variables ? varNodeFromConfig(side.variables) : newVarNode()));
    for (const { tag, config } of cfg.allChildren()) {
      if (tag === 'ai') {
        ais.push(config);
        if (config.hasAttribute('ai_algorithm')) replaceAi = true;
      } else if (tag === 'set_variable') applySetVariable(config, sideVars(), ctx.log);
      else if (tag === 'set_variables') actionSetVariables(config, { ...ctx, variables: sideVars() });
      else if (tag === 'clear_variable') actionClearVariable(config, { ...ctx, variables: sideVars() });
      else if (tag === 'variables') {
        // `wml.merge(side.variables.__cfg, content, var_merge_mode or "replace")`
        const mode = cfg.getString('var_merge_mode', 'replace');
        if (mode === 'replace' || !side.variables) side.variables = config.clone();
        else {
          const merged = side.variables.clone();
          for (const key of config.attributeNames()) merged.setAttribute(key, config.getRaw(key)!);
          for (const child of config.allChildren()) merged.addChild(child.tag, child.config.clone());
          side.variables = merged;
          vars = undefined;
        }
      }
    }
    if (vars) side.variables = vars.toConfig();
    if (has('switch_ai')) ctx.log('warn', `[modify_side] switch_ai=${cfg.getString('switch_ai')}: loading an AI file is not supported -- ignored`);
    if (ais.length > 0) {
      if (!ctx.ai) ctx.log('warn', '[modify_side][ai]: no AI engine loaded for this session -- ignored');
      else if (replaceAi) ctx.ai.switchSideAi(sideNumber, ais);
      else for (const aiCfg of ais) ctx.ai.appendSideAi(sideNumber, aiCfg);
    }
  }
}
