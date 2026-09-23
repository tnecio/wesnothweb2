/**
 * TS port of `pathfind/teleport.cpp`: which hexes a unit can teleport
 * between. A *tunnel* (`teleport_group`) is a `[source]` location filter, a
 * `[target]` location filter and a `[filter]` for which units may use it;
 * tunnels come from a unit's own `[teleport]` abilities (`ABILITY_TELEPORT`:
 * any own village that is empty or holds the unit, to any empty own
 * village) and from the scenario's `[tunnel]` ActionWML (`TunnelManager`,
 * one per board). `getTeleportLocations` evaluates them for one unit into a
 * `TeleportMap`: for each source hex, the target hexes one step away.
 *
 * Differences from upstream, deliberately:
 *  - `ignore_units` does not swap in a unit-less filter context for the
 *    location filters (it only affects which targets count as blocked);
 *    no caller here evaluates tunnels while ignoring units yet.
 *  - A `[tunnel]` stores its config as given (upstream's default
 *    `delayed_variable_substitution=yes` re-substitutes variables at every
 *    use; ours are substituted once, when the tag runs).
 */
import type { GameBoard } from '../model/GameBoard.js';
import type { Location } from '../model/Location.js';
import type { Team } from '../model/Team.js';
import type { Unit } from '../model/Unit.js';
import { WmlConfig } from '../wml/config.js';
import { findLocations, unitMatchesFilter } from '../events/filter.js';
import { getActiveAbilities } from '../actions/abilityEffects.js';
import { getVisibleUnit } from './visibility.js';
import type { TeleportGroup } from './tunnels.js';

export { TunnelManager, type TeleportGroup } from './tunnels.js';

function groupPair(board: GameBoard, group: TeleportGroup, unit: Unit): { sources: Location[]; targets: Location[] } {
  const filter = group.cfg.child('filter') ?? new WmlConfig();
  if (!unitMatchesFilter(unit, filter, board)) return { sources: [], targets: [] };
  const from = findLocations(board, group.cfg.child('source') ?? new WmlConfig(), unit);
  const to = findLocations(board, group.cfg.child('target') ?? new WmlConfig(), unit);
  return group.reversed ? { sources: to, targets: from } : { sources: from, targets: to };
}

/** `teleport_map`: from each source hex, the hexes a teleport reaches in one step. */
export class TeleportMap {
  private readonly adjacent = new Map<string, Location[]>();
  readonly sources: Location[] = [];
  readonly targets: Location[] = [];

  static readonly EMPTY = new TeleportMap();

  add(sources: readonly Location[], targets: readonly Location[]): void {
    for (const src of sources) {
      const list = this.adjacent.get(src.key()) ?? [];
      for (const t of targets) if (!list.some((l) => l.equals(t))) list.push(t);
      this.adjacent.set(src.key(), list);
      if (!this.sources.some((l) => l.equals(src))) this.sources.push(src);
    }
    for (const t of targets) if (!this.targets.some((l) => l.equals(t))) this.targets.push(t);
  }

  /** `get_adjacents`: where a teleport from `loc` can go (empty if `loc` is no source). */
  adjacents(loc: Location): readonly Location[] {
    return this.adjacent.get(loc.key()) ?? [];
  }

  get isEmpty(): boolean {
    return this.adjacent.size === 0;
  }
}

export interface TeleportOptions {
  /** Whose knowledge counts (fog). Omit, or `seeAll`, for the full truth. */
  viewingTeam?: Team;
  seeAll?: boolean;
  /** Pathing that ignores units: occupied targets are not filtered out. */
  ignoreUnits?: boolean;
  /** For vision paths: skip tunnels with `allow_vision=no`. */
  checkVision?: boolean;
}

/**
 * `get_teleport_locations`: the tunnels `unit` may use -- from its active
 * `[teleport]` abilities and from the board's `[tunnel]`s -- evaluated
 * into a `TeleportMap`. For an enemy's unit, hexes the viewing team has
 * fogged are dropped unless the tunnel is `always_visible=yes`; targets
 * with a unit on them are dropped when `pass_allied_units=no`.
 */
export function getTeleportLocations(board: GameBoard, unit: Unit, options: TeleportOptions = {}): TeleportMap {
  const groups: TeleportGroup[] = [];
  for (const ability of getActiveAbilities(board, unit, 'teleport')) {
    for (const tunnel of ability.config.children('tunnel')) groups.push({ cfg: tunnel, reversed: false, id: tunnel.getString('id', '') });
  }
  groups.push(...board.tunnels.all());

  const seeAll = options.seeAll ?? !options.viewingTeam;
  const viewer = options.viewingTeam;
  const unitTeam = board.getTeam(unit.side);
  const map = new TeleportMap();
  for (const group of groups) {
    if (options.checkVision && !group.cfg.getBoolean('allow_vision', true)) continue;
    let { sources, targets } = groupPair(board, group, unit);
    if (!seeAll && viewer && unitTeam && !group.cfg.getBoolean('always_visible', false) && viewer.isEnemy(unitTeam)) {
      sources = sources.filter((l) => !viewer.fogged(l));
      targets = targets.filter((l) => !viewer.fogged(l));
    }
    if (!group.cfg.getBoolean('pass_allied_units', true) && !options.ignoreUnits && !options.checkVision) {
      targets = targets.filter((l) => (seeAll ? board.unitAt(l) : getVisibleUnit(board, l, viewer, false)) === undefined);
    }
    map.add(sources, targets);
  }
  return map;
}
