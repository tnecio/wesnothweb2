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
    const side = cfg.getNumber('side', 1);
    const action = parseModifyAiAction(cfg.getString('action', 'add'));
    const path = cfg.getString('path', '');
    // `component_manager::add_component`: the component is the child named after the path's last element.
    const last = parseComponentPath(path).pop();
    ctx.ai.modifyAi(side, action, path, last ? cfg.child(last.property) : undefined);
  });

  registry.register('modify_side', (cfg: WmlConfig, ctx: EventContext) => {
    const sides = cfg.hasAttribute('side') ? [cfg.getNumber('side', 1)] : [];
    for (const side of sides) {
      const team = ctx.board.getTeam(side);
      if (!team) continue;
      if (cfg.hasAttribute('team_name')) team.teamName = cfg.getString('team_name');
      if (cfg.hasAttribute('user_team_name')) team.userTeamName = cfg.getString('user_team_name');
      if (cfg.hasAttribute('controller')) {
        const controller = cfg.getString('controller');
        if (controller === 'ai' || controller === 'human' || controller === 'network' || controller === 'network_ai') {
          team.controller = controller;
        }
      }
      if (cfg.hasAttribute('recruit')) {
        team.canRecruit = new Set(
          cfg
            .getString('recruit')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        );
      }
      if (cfg.hasAttribute('gold')) team.gold = cfg.getNumber('gold');
      if (cfg.hasAttribute('income')) team.income = cfg.getNumber('income');

      // modify_side.lua: an `[ai]` naming `ai_algorithm=` replaces the side's AI with the blocks (`switch_ai`);
      // otherwise each is appended to it (`append_ai`).
      const ais = cfg.children('ai');
      if (ais.length > 0 && !ctx.ai) ctx.log('warn', '[modify_side][ai]: no AI engine loaded for this session -- ignored');
      else if (ais.some((a) => a.hasAttribute('ai_algorithm'))) ctx.ai!.switchSideAi(side, ais);
      else for (const aiCfg of ais) ctx.ai!.appendSideAi(side, aiCfg);
    }
  });

  registry.register('micro_ai', (cfg: WmlConfig, ctx: EventContext) => {
    if (!ctx.ai) {
      ctx.log('warn', '[micro_ai]: no AI engine loaded for this session -- ignored');
      return;
    }
    const side = cfg.getNumber('side', 1);
    ctx.ai.microAi(side, cfg);
  });
}
