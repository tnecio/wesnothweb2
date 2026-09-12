/**
 * TS port of the state-mutation half of upstream's `actions/create.cpp`:
 * recruiting a new unit or recalling one from a side's recall list onto a
 * keep-connected castle tile, plus dismissing a recall-list unit
 * permanently (`undo_dismiss_action`'s forward operation -- there's no
 * separate `dismiss.cpp` upstream, dismissal is just a recall-list splice
 * done directly by the `dialogs::unit_recall` GUI code, ported here as a
 * small function of its own since the undo stack needs a symmetric
 * "un-dismiss" operation regardless).
 *
 * Deliberately simplified vs. upstream (see also `combatStats.ts`'s module
 * doc comment on the general "abilities/filters are inert data" stance
 * this project has taken so far):
 *  - **`recall_filter=`/unit-specific recruit lists are not evaluated.**
 *    `check_unit_recall_location` filters candidate recallers by
 *    `unit_filter(vconfig(recaller.recall_filter()))` (a WFL/SingleWML
 *    filter most leaders never set) and `check_unit_recruit_location`
 *    checks a specific `unit_type` against `recruiter.recruits()` (a
 *    *per-leader* recruit list some scenarios set via `[unit] recruit=`,
 *    distinct from the team-wide list `Team.ts.canRecruit` already
 *    tracks). Neither per-leader list is modeled in `Team.ts`/`Unit.ts`
 *    (out of bounds for this task), so this module only checks the
 *    team-wide `Team.canRecruit` set -- correct for the common case (no
 *    leader-specific recruit list), permissive for the rare case where a
 *    scenario actually restricts recruiting to specific leaders.
 *  - **Facing-towards-nearest-visible-enemy** (`set_recruit_facing`) is
 *    ported directly (it only needs board/team data already available
 *    here), but ties are broken by iteration order rather than upstream's
 *    exact `unit_map` iteration, which is an implementation detail with no
 *    documented tie-breaking rule upstream either.
 *  - **Village capture on recruit/recall placement** is out of scope for
 *    the same reason as `move.ts`'s (no village-ownership model yet).
 */

import { Location, getAdjacentTiles, oppositeDirection, Direction, ALL_DIRECTIONS, distanceBetween } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Team } from '../model/Team.js';
import { Unit, type UnitModification } from '../model/Unit.js';
import type { UnitType } from '../model/UnitType.js';
import type { Rng } from '../rng/Rng.js';

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Mirrors `unit::generate_traits(must_have_only=false)`: fills `type`'s
 * `numTraits` slots from `type.possibleTraits`, `musthave`-availability ones
 * first (unconditionally, even beyond `numTraits` -- matches upstream, which
 * never caps the musthave pass), then randomly for the rest, honoring each
 * candidate's `require_traits=`/`exclude_traits=` against what's already
 * been picked. Stops early if no candidate remains (matches upstream's
 * "could only generate N traits" case, e.g. a small `possibleTraits` pool).
 *
 * Deliberately NOT ported: the leader-only exclusion (`!can_recruit() ||
 * avl == "any"`) -- moot here since this is only ever called for a freshly
 * recruited unit (`Unit.create`'s `canRecruit: false` at this module's
 * `recruitUnit`), never a leader. See `UnitType`'s own module doc comment
 * for what `numTraits`/`possibleTraits` themselves don't model (race-level
 * defaults).
 */
export function generateTraits(type: UnitType, rng: Rng): UnitModification[] {
  const picked: UnitModification[] = [];
  const hasId = (id: string) => picked.some((m) => m.cfg.getString('id') === id);

  for (const t of type.possibleTraits) {
    if (t.getString('availability', 'any') === 'musthave' && !hasId(t.getString('id'))) {
      picked.push({ kind: 'trait', cfg: t });
    }
  }

  while (picked.length < type.numTraits) {
    const pickedIds = picked.map((m) => m.cfg.getString('id'));
    const pickedExcludes = picked.flatMap((m) => splitList(m.cfg.getString('exclude_traits', '')));
    const candidates = type.possibleTraits.filter((t) => {
      const id = t.getString('id');
      if (hasId(id) || pickedExcludes.includes(id)) return false;
      if (splitList(t.getString('require_traits', '')).some((r) => !pickedIds.includes(r))) return false;
      if (splitList(t.getString('exclude_traits', '')).some((e) => pickedIds.includes(e))) return false;
      return true;
    });
    if (candidates.length === 0) break;
    const chosen = candidates[rng.getRandomInt(0, candidates.length - 1)]!;
    picked.push({ kind: 'trait', cfg: chosen });
  }

  return picked;
}

/** Mirrors `actions::RECRUIT_CHECK`. */
export type RecruitCheck =
  | 'no_leader'
  | 'no_able_leader'
  | 'no_keep_leader'
  | 'no_vacancy'
  | 'alternate_location'
  | 'ok';

const CHECK_ORDER: readonly RecruitCheck[] = ['no_leader', 'no_able_leader', 'no_keep_leader', 'no_vacancy', 'alternate_location', 'ok'];
function rank(c: RecruitCheck): number {
  return CHECK_ORDER.indexOf(c);
}

/**
 * Flood-fills castle tiles connected (via castle-to-castle adjacency) to
 * `keepLoc`, mirroring the "connected castle" concept `pathfind::
 * find_vacant_castle`/`game_state::can_recruit_on` rely on (a leader may
 * recruit onto any castle tile reachable from their keep without crossing
 * non-castle terrain, not just tiles directly adjacent to the leader).
 */
export function connectedCastleTiles(board: GameBoard, keepLoc: Location): Location[] {
  if (!board.map.isKeep(keepLoc)) return [];
  const seen = new Set<string>([keepLoc.key()]);
  const queue: Location[] = [keepLoc];
  const result: Location[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (!cur.equals(keepLoc)) result.push(cur);
    for (const adj of getAdjacentTiles(cur)) {
      if (seen.has(adj.key())) continue;
      if (!board.map.isCastle(adj) && !board.map.isKeep(adj)) continue;
      seen.add(adj.key());
      queue.push(adj);
    }
  }
  return result;
}

/** Mirrors `pathfind::find_vacant_castle`: the first unoccupied castle tile connected to `leader`'s keep. */
export function findVacantCastleTile(board: GameBoard, leader: Unit): Location | undefined {
  if (!board.map.isKeep(leader.location)) return undefined;
  for (const tile of connectedCastleTiles(board, leader.location)) {
    if (!board.hasUnitAt(tile)) return tile;
  }
  return undefined;
}

/** Mirrors `game_state::can_recruit_on`: is `loc` a castle tile connected to a leader standing on a keep? */
export function canRecruitOn(board: GameBoard, leader: Unit, loc: Location): boolean {
  if (!board.map.isKeep(leader.location)) return false;
  if (!board.map.isCastle(loc) && !board.map.isKeep(loc)) return false;
  if (loc.equals(leader.location)) return true;
  return connectedCastleTiles(board, leader.location).some((t) => t.equals(loc));
}

function candidateLeaders(board: GameBoard, side: number): Unit[] {
  return board.unitsForSide(side).filter((u) => u.canRecruit);
}

/**
 * Mirrors `check_recruit_location`/`check_recall_location` (unified since
 * both only differ in what "can this leader recruit/recall the specific
 * unit" means -- callers pass that in as `canUse`). Returns the check
 * result plus, on `ok`/`alternate_location`, the leader and location to
 * use.
 */
export function checkRecruitLocation(
  board: GameBoard,
  side: number,
  preferredLoc: Location,
  preferredFrom: Location,
  canUse: (leader: Unit) => boolean,
): { result: RecruitCheck; location: Location; leader: Unit | undefined } {
  const checkLocation = board.hasUnitAt(preferredLoc) ? Location.NULL : preferredLoc;
  const goal: RecruitCheck = checkLocation.valid() ? 'ok' : 'alternate_location';

  let best: RecruitCheck = 'no_leader';
  let bestLeader: Unit | undefined;
  let bestLoc: Location = preferredLoc;

  const checkOne = (leader: Unit): RecruitCheck => {
    if (!leader.canRecruit) return 'no_leader';
    if (!canUse(leader)) return 'no_able_leader';
    if (!board.map.isKeep(leader.location)) return 'no_keep_leader';
    const vacant = findVacantCastleTile(board, leader);
    if (!vacant) return 'no_vacancy';
    if (checkLocation.valid() && canRecruitOn(board, leader, checkLocation)) return 'ok';
    bestLoc = vacant;
    return 'alternate_location';
  };

  const preferred = board.unitAt(preferredFrom);
  if (preferred && preferred.side === side) {
    best = checkOne(preferred);
    bestLeader = preferred;
  }

  if (rank(best) < rank(goal)) {
    for (const leader of candidateLeaders(board, side)) {
      const current = checkOne(leader);
      if (rank(current) <= rank(best)) continue;
      best = current;
      bestLeader = leader;
      if (rank(best) >= rank(goal)) break;
    }
  }

  const location = best === 'alternate_location' ? bestLoc : preferredLoc;
  return { result: best, location, leader: bestLeader };
}

// --- facing ---

function directionBetween(from: Location, to: Location): Direction | undefined {
  const idx = getAdjacentTiles(from).findIndex((loc) => loc.equals(to));
  return idx === -1 ? undefined : ALL_DIRECTIONS[idx];
}

/** Mirrors `set_recruit_facing`: face the closest visible enemy (weighted by level), else away from the recruiting leader, else towards the map center. */
function computeRecruitFacing(board: GameBoard, unit: Unit, recruitLoc: Location, leaderLoc: Location | undefined): Direction {
  let minDist = Infinity;
  let minLoc: Location | undefined;
  const isAlly = (a: number, b: number): boolean => {
    const ta = board.getTeam(a);
    const tb = board.getTeam(b);
    return !!ta && !!tb && !ta.isEnemy(tb);
  };
  for (const other of board.allUnits()) {
    const otherTeam = board.getTeam(other.side);
    const unitTeam = board.getTeam(unit.side);
    if (!otherTeam || !unitTeam || !unitTeam.isEnemy(otherTeam)) continue;
    if (!other.isVisibleToTeam(unit.side, isAlly, false)) continue;
    const dist = distanceBetween(other.location, recruitLoc) - other.level;
    if (dist < minDist) {
      minDist = dist;
      minLoc = other.location;
    }
  }
  if (minLoc) {
    const dir = directionBetween(recruitLoc, minLoc);
    if (dir !== undefined) return dir;
  }
  if (leaderLoc) {
    const dir = directionBetween(recruitLoc, leaderLoc);
    if (dir !== undefined) return oppositeDirection(dir);
  }
  const center = new Location(Math.floor(board.map.w() / 2), Math.floor(board.map.h() / 2));
  return directionBetween(recruitLoc, center) ?? Direction.South;
}

// --- recruit / recall / dismiss ---

export interface PlaceRecruitResult {
  readonly unit: Unit;
  readonly location: Location;
  readonly cost: number;
}

/**
 * Mirrors `actions::place_recruit`'s state-mutating core: positions `unit`
 * (already constructed, e.g. via `Unit.create`/pulled off a recall list)
 * on the board, sets its moves/attacks (0 unless `fullMovement`, matching
 * upstream's default for both recruit and recall -- freshly placed units
 * cannot act the turn they arrive), heals it fully unless `isRecall`
 * (recalled units keep their saved hp/xp), and spends `cost` from `team`.
 */
function placeRecruit(
  board: GameBoard,
  team: Team,
  unit: Unit,
  location: Location,
  from: Location,
  cost: number,
  isRecall: boolean,
  fullMovement = false,
  facing?: Direction,
): PlaceRecruitResult {
  if (fullMovement) {
    unit.movesLeft = unit.maxMoves;
  } else {
    unit.movesLeft = 0;
    unit.attacksLeft = 0;
  }
  if (!isRecall) unit.healToFull();
  unit.hidden = false;

  const leader = board.unitAt(from);
  unit.location = location;
  board.addUnit(unit);
  unit.facing = facing ?? computeRecruitFacing(board, unit, location, leader?.location);

  team.spendGold(cost);
  return { unit, location, cost };
}

/**
 * Recruits a fresh unit of `type` for `side`, mirroring `actions::
 * recruit_unit`. `loc`/`from` should already have passed `checkRecruitLocation`
 * (this function does not itself re-validate placement legality -- callers
 * building a full recruit command should call `checkRecruitLocation` first
 * and surface its result to the player/AI). `rng` generates this unit's
 * random traits (`generateTraits`) -- real, reported bug: recruited units
 * never got any.
 */
export function recruitUnit(board: GameBoard, team: Team, type: UnitType, loc: Location, from: Location, rng: Rng): PlaceRecruitResult {
  const unit = Unit.create(type, team.side, loc, { canRecruit: false, modifications: generateTraits(type, rng) });
  return placeRecruit(board, team, unit, loc, from, type.cost, false, false);
}

/**
 * Recalls `unit` (removed from `team`'s recall list by the caller -- see
 * `GameBoard.removeFromRecallList`) onto the board, mirroring `actions::
 * recall_unit`. Cost is the unit's own `recallCost` if set (>= 0),
 * otherwise the team's default.
 */
export function recallUnit(board: GameBoard, team: Team, unit: Unit, loc: Location, from: Location, facing?: Direction): PlaceRecruitResult {
  const cost = unit.type.recallCost >= 0 ? unit.type.recallCost : team.recallCost;
  return placeRecruit(board, team, unit, loc, from, cost, true, false, facing);
}

/** Permanently removes `unit` (by `underlyingId`) from `side`'s recall list, mirroring the GUI's dismiss action. Returns the removed unit, if found. */
export function dismissUnit(board: GameBoard, side: number, underlyingId: number): Unit | undefined {
  return board.removeFromRecallList(side, underlyingId);
}
