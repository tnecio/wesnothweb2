/**
 * Unit visibility under fog and `hides` abilities: ports of
 * `unit::invisible`, `unit::is_visible_to_team`,
 * `display_context::would_be_discovered` and `get_visible_unit`.
 *
 * `hides` evaluation covers what every mainline `hides` ability uses: the
 * unit's own ability (`affect_self`), its `[filter]` unit attributes and
 * `formula=`, and `[filter_location]` `terrain=`/`time_of_day=`/`x,y=`
 * evaluated at the hex being checked. Not covered: `hides` granted to
 * adjacent units via `[affect_adjacent]` (no mainline use).
 *
 * Kept from before this port: WML `hidden=yes` units stay invisible to
 * enemies (upstream treats `hidden_` as display-only).
 */

import type { GameBoard } from '../model/GameBoard.js';
import { getAdjacentTiles, type Location } from '../model/Location.js';
import type { Team } from '../model/Team.js';
import { parseTerrainList, terrainMatches } from '../model/Terrain.js';
import { UnitStatus, type Unit } from '../model/Unit.js';
import type { WmlConfig } from '../wml/config.js';
import { locationMatchesFilter, unitMatchesFilter } from '../events/filter.js';

/** Mirrors `terrain_filter`'s `time_of_day=` check against the hex's effective lawful bonus. */
function timeOfDayMatches(board: GameBoard, loc: Location, wanted: string): boolean {
  const bonus = board.lawfulBonusAt?.(loc) ?? 0;
  const alignment = bonus > 0 ? 'lawful' : bonus < 0 ? 'chaotic' : 'neutral';
  return wanted
    .split(',')
    .map((s) => s.trim())
    .some((w) => w === alignment || (w === 'liminal' && bonus === 0));
}

function filterLocationMatches(board: GameBoard, loc: Location, cfg: WmlConfig): boolean {
  if (!locationMatchesFilter(loc, cfg)) return false;
  if (cfg.hasAttribute('terrain') && !terrainMatches(board.map.getTerrain(loc), parseTerrainList(cfg.getString('terrain')))) {
    return false;
  }
  if (cfg.hasAttribute('time_of_day') && !timeOfDayMatches(board, loc, cfg.getString('time_of_day'))) return false;
  return true;
}

/** Whether `unit` standing at `loc` has an active `hides` ability (`get_ability_bool("hides", loc)`). */
export function hidesActive(board: GameBoard, unit: Unit, loc: Location = unit.location): boolean {
  return unit.abilities.some((entry) => {
    if (entry.tag !== 'hides') return false;
    if (!entry.config.getBoolean('affect_self', true)) return false;
    const filter = entry.config.child('filter');
    if (!filter) return true;
    if (!unitMatchesFilter(unit, filter, board)) return false;
    return filter.children('filter_location').every((fl) => filterLocationMatches(board, loc, fl));
  });
}

/** Mirrors `display_context::would_be_discovered`: an enemy of `side` adjacent to `loc` that `side` can see. */
export function wouldBeDiscovered(board: GameBoard, loc: Location, side: number, seeAll: boolean): boolean {
  const team = board.getTeam(side);
  if (!team) return false;
  for (const adj of getAdjacentTiles(loc)) {
    const u = board.unitAt(adj);
    if (!u) continue;
    const uTeam = board.getTeam(u.side);
    if (!uTeam || !team.isEnemy(uTeam) || u.incapacitated) continue;
    if (seeAll) return true;
    if (!board.isFogged(side, adj) && !unitInvisible(board, u, adj, true)) return true;
  }
  return false;
}

/** Mirrors `unit::invisible`. */
export function unitInvisible(board: GameBoard, unit: Unit, loc: Location = unit.location, seeAll = true): boolean {
  if (unit.hasStatus(UnitStatus.Uncovered)) return false;
  if (!hidesActive(board, unit, loc)) return false;
  return !wouldBeDiscovered(board, loc, unit.side, seeAll);
}

/** Mirrors `unit::is_visible_to_team(loc, team, see_all)`. */
export function isUnitVisibleToTeam(board: GameBoard, unit: Unit, team: Team, seeAll = false, loc: Location = unit.location): boolean {
  if (!board.map.onBoard(loc)) return false;
  if (seeAll) return true;
  const unitTeam = board.getTeam(unit.side);
  const enemy = !unitTeam || team.isEnemy(unitTeam);
  if (enemy && (unit.hidden || unitInvisible(board, unit, loc))) return false;
  if (team.side === unit.side) return true;
  return !team.fogged(loc, board.teams());
}

/** Mirrors `display_context::get_visible_unit`; `viewingTeam` undefined (or `seeAll`) sees everything. */
export function getVisibleUnit(board: GameBoard, loc: Location, viewingTeam: Team | undefined, seeAll: boolean): Unit | undefined {
  const u = board.unitAt(loc);
  if (!u) return undefined;
  if (seeAll || !viewingTeam) return u;
  return isUnitVisibleToTeam(board, u, viewingTeam, false, loc) ? u : undefined;
}
