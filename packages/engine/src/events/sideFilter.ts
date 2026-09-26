/**
 * Standard Side Filter (`side_filter.cpp`): which teams a `side=`/
 * `team_name=`/`[has_unit]`/`[enemy_of]`/... filter picks, with `[and]`/
 * `[or]`/`[not]` folded in document order. `wesnoth.sides.find(cfg)` in the
 * Lua WML tags is this over the tag's whole config.
 *
 * Not ported: `formula=` (logged, matches nothing, as a formula error
 * does upstream) and `lua_function=` (ignored, as without a Lua kernel).
 * The caller substitutes variables first.
 */
import type { WmlConfig } from '../wml/config.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Team } from '../model/Team.js';
import { parseRanges, unitMatchesFilter } from './filter.js';

const inRanges = (n: number, text: string) => parseRanges(text).some(([lo, hi]) => n >= lo && n <= hi);

function matchInternal(board: GameBoard, cfg: WmlConfig, t: Team, log?: (msg: string) => void): boolean {
  if (cfg.hasAttribute('side_in') && !inRanges(t.side, cfg.getString('side_in'))) return false;
  if (cfg.hasAttribute('side') && !inRanges(t.side, cfg.getString('side'))) return false;

  const teamName = cfg.getString('team_name', '');
  if (teamName !== '' && !t.teamName.split(',').map((n) => n.trim()).includes(teamName)) return false;

  const hasUnit = cfg.child('has_unit');
  if (hasUnit) {
    let found = board.allUnits().some((u) => u.side === t.side && unitMatchesFilter(u, hasUnit, board));
    if (!found && hasUnit.getBoolean('search_recall_list', false)) {
      found = board.recallList(t.side).some((u) => unitMatchesFilter(u, hasUnit, board));
    }
    if (!found) return false;
  }

  const others = (tag: string) => {
    const child = cfg.child(tag);
    return child ? findSides(board, child, log).map((s) => board.getTeam(s)!) : null;
  };
  const enemyOf = others('enemy_of');
  if (enemyOf && (enemyOf.length === 0 || enemyOf.some((o) => !o.isEnemy(t)))) return false;
  const alliedWith = others('allied_with');
  if (alliedWith && (alliedWith.length === 0 || alliedWith.some((o) => o.isEnemy(t)))) return false;
  const hasEnemy = others('has_enemy');
  if (hasEnemy && !hasEnemy.some((o) => o.isEnemy(t))) return false;
  const hasAlly = others('has_ally');
  if (hasAlly && !hasAlly.some((o) => !o.isEnemy(t))) return false;

  const controller = cfg.getString('controller', '');
  if (controller !== '' && !controller.split(',').map((c) => c.trim()).includes(t.controller)) return false;

  if (cfg.hasAttribute('formula')) {
    log?.('side filter formula= is not supported; the filter matches nothing');
    return false;
  }
  return true;
}

/** `side_filter::match`: the attribute/child tests, then `[and]`/`[or]`/`[not]` in order. */
export function sideMatchesFilter(board: GameBoard, cfg: WmlConfig, t: Team, log?: (msg: string) => void): boolean {
  let matches = matchInternal(board, cfg, t, log);
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'and') matches = matches && sideMatchesFilter(board, config, t, log);
    else if (tag === 'or') matches = matches || sideMatchesFilter(board, config, t, log);
    else if (tag === 'not') matches = matches && !sideMatchesFilter(board, config, t, log);
  }
  return matches;
}

/** `side_filter::get_teams`: the matching sides, in side order. */
export function findSides(board: GameBoard, cfg: WmlConfig, log?: (msg: string) => void): number[] {
  return board
    .teams()
    .filter((t) => sideMatchesFilter(board, cfg, t, log))
    .map((t) => t.side);
}
