/**
 * TS port of upstream's `goal` hierarchy (`src/ai/composite/goal.hpp/.cpp`):
 * explicit `[goal]` tags an `[ai]` block can carry -- `target`/`target_unit`
 * (a unit filter), `target_location` (a location filter), `protect_unit`/
 * `protect_location` (raise a `threat` target against any enemy near a
 * protected unit/location). `findTargets.ts`'s `findTargets` calls
 * `addTargets` on every active one, alongside its own built-in threat/
 * village/leader targets.
 *
 * Not ported: `lua_goal` (Phase 29 S7+, once Lua CAs exist).
 */

import { distanceBetween, type Location } from '../../model/Location.js';
import type { WmlConfig } from '../../wml/config.js';
import { unitMatchesFilter, findLocations } from '../../events/filter.js';
import { isUnitVisibleToTeam } from '../../pathfind/visibility.js';
import type { AiContext } from '../context.js';
import type { Target } from './target.js';

export interface Goal {
  /** `[goal] id=` -- how `[modify_ai] path=goal[<id>] action=delete` (the single most common real-content `[modify_ai]` shape, e.g. Son of the Black Eye's "defend_Braga") addresses one goal. Empty when the WML author gave none. */
  readonly id: string;
  isActive(ctx: AiContext): boolean;
  addTargets(ctx: AiContext, targets: Target[]): void;
}

function isGoalActive(ctx: AiContext, cfg: WmlConfig): boolean {
  return ctx.isActive(cfg.getString('turns', ''), cfg.getString('time_of_day', ''));
}

/** Mirrors `target_unit_goal` (`name=target`/`target_unit`, the default for an unrecognized/empty `name=`): every unit matching `[criteria]` (a SUF) becomes an explicit target. */
export class TargetUnitGoal implements Goal {
  readonly id: string;
  private readonly value: number;
  constructor(private readonly cfg: WmlConfig) {
    this.id = cfg.getString('id', '');
    this.value = cfg.getNumber('value', 0);
  }
  isActive(ctx: AiContext): boolean {
    return isGoalActive(ctx, this.cfg);
  }
  addTargets(ctx: AiContext, targets: Target[]): void {
    const criteria = this.cfg.child('criteria');
    if (!criteria) return;
    for (const u of ctx.board.allUnits()) {
      if (unitMatchesFilter(u, criteria, ctx.board)) {
        targets.push({ loc: u.location, value: this.value, type: 'xplicit' });
      }
    }
  }
}

/** Mirrors `target_location_goal` (`name=target_location`): every hex matching `[criteria]` (a SLF) becomes an explicit target. */
export class TargetLocationGoal implements Goal {
  readonly id: string;
  private readonly value: number;
  constructor(private readonly cfg: WmlConfig) {
    this.id = cfg.getString('id', '');
    this.value = cfg.getNumber('value', 0);
  }
  isActive(ctx: AiContext): boolean {
    return isGoalActive(ctx, this.cfg);
  }
  addTargets(ctx: AiContext, targets: Target[]): void {
    const criteria = this.cfg.child('criteria');
    if (!criteria) return;
    for (const loc of findLocations(ctx.board, criteria)) {
      targets.push({ loc, value: this.value, type: 'xplicit' });
    }
  }
}

/**
 * Mirrors `protect_goal` (`name=protect_unit`/`protect_location`): finds
 * every enemy within `protect_radius` of a matching unit/location and adds
 * it as a `threat` target, valued higher the closer it is.
 */
export class ProtectGoal implements Goal {
  readonly id: string;
  private readonly value: number;
  private readonly radius: number;
  constructor(
    private readonly cfg: WmlConfig,
    private readonly protectUnit: boolean,
  ) {
    this.id = cfg.getString('id', '');
    this.value = cfg.getNumber('value', 1.0);
    const r = cfg.getNumber('protect_radius', 1);
    this.radius = r < 1 ? 20 : r;
  }
  isActive(ctx: AiContext): boolean {
    return isGoalActive(ctx, this.cfg);
  }
  addTargets(ctx: AiContext, targets: Target[]): void {
    const criteria = this.cfg.child('criteria');
    if (!criteria) return;
    const board = ctx.board;
    const team = ctx.team();

    const items: Location[] = [];
    if (this.protectUnit) {
      for (const u of board.allUnits()) {
        if (unitMatchesFilter(u, criteria, board) && isUnitVisibleToTeam(board, u, team, false)) items.push(u.location);
      }
    } else {
      items.push(...findLocations(board, criteria));
    }

    for (const loc of items) {
      for (const u of board.allUnits()) {
        const uTeam = board.getTeam(u.side);
        if (!uTeam || !team.isEnemy(uTeam)) continue;
        const distance = distanceBetween(u.location, loc);
        if (distance < this.radius && isUnitVisibleToTeam(board, u, team, false)) {
          targets.push({ loc: u.location, value: (this.value * (this.radius - distance)) / this.radius, type: 'threat' });
        }
      }
    }
  }
}

/**
 * Mirrors `configuration`'s upgrade of the short `name=` a goal is
 * conventionally authored with into its real class -- an empty or
 * unrecognized-but-conventional `name=` (`""`, `target`, `target_unit`)
 * all resolve to `TargetUnitGoal` (matches `src/ai/registry.cpp`
 * registering the SAME class under all three names).
 */
export function buildGoalsFromConfigs(configs: readonly WmlConfig[], onUnrecognized?: (name: string) => void): Goal[] {
  const goals: Goal[] = [];
  for (const cfg of configs) {
    for (const goalCfg of cfg.children('goal')) {
      const name = goalCfg.getString('name', '');
      switch (name) {
        case '':
        case 'target':
        case 'target_unit':
          goals.push(new TargetUnitGoal(goalCfg));
          break;
        case 'target_location':
          goals.push(new TargetLocationGoal(goalCfg));
          break;
        case 'protect_location':
          goals.push(new ProtectGoal(goalCfg, false));
          break;
        case 'protect_unit':
          goals.push(new ProtectGoal(goalCfg, true));
          break;
        default:
          onUnrecognized?.(name);
      }
    }
  }
  return goals;
}
