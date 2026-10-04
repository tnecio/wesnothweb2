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

import { isUnitVisibleToTeam } from '../pathfind/visibility.js';
import { ShroudClearer, actorSighted, type RaiseEvent } from './vision.js';
import { Location, getAdjacentTiles, oppositeDirection, relativeDirection, type Direction, distanceBetween } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Team } from '../model/Team.js';
import { Unit, type UnitModification } from '../model/Unit.js';
import type { UnitType } from '../model/UnitType.js';
import type { Rng } from '../rng/Rng.js';
import type { Flow } from '../events/interaction.js';

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Mirrors `unit::generate_traits(must_have_only=false)`: adds `type`'s
 * `musthave` traits the unit lacks (unconditionally, even beyond
 * `numTraits` -- upstream never caps that pass), then fills the remaining
 * `numTraits` slots at random from the candidates, honouring each one's
 * `require_traits=`/`exclude_traits=` against what the unit already has.
 * `existing` is the unit's traits so far (a WML `[unit]` may list some);
 * a leader only draws from `availability=any` traits. Stops early when no
 * candidate remains. Returns only the traits it added.
 *
 * The candidate list is `type.possibleTraits` in upstream's own order
 * (see `resolveTraitPools`), because the random pick is an index into it.
 */
export function generateTraits(type: UnitType, rng: Rng, existing: readonly UnitModification[] = [], canRecruit = false): UnitModification[] {
  const added: UnitModification[] = [];
  const current = () => [...existing.filter((m) => m.kind === 'trait'), ...added];
  const hasId = (id: string) => current().some((m) => m.cfg.getString('id') === id);

  for (const t of type.possibleTraits) {
    if (t.getString('availability', '') === 'musthave' && !hasId(t.getString('id'))) {
      added.push({ kind: 'trait', cfg: t });
    }
  }

  for (let count = current().length; count < type.numTraits; count++) {
    const traits = current();
    const pickedIds = traits.map((m) => m.cfg.getString('id'));
    const pickedExcludes = traits.flatMap((m) => splitList(m.cfg.getString('exclude_traits', '')));
    const candidates = type.possibleTraits.filter((t) => {
      const id = t.getString('id');
      if (hasId(id)) return false;
      if (splitList(t.getString('require_traits', '')).some((r) => !pickedIds.includes(r))) return false;
      if ([...splitList(t.getString('exclude_traits', '')), ...pickedExcludes].includes(id)) return false;
      if (splitList(t.getString('exclude_traits', '')).some((e) => pickedIds.includes(e))) return false;
      return !canRecruit || t.getString('availability', '') === 'any';
    });
    if (candidates.length === 0) break;
    const chosen = candidates[rng.getRandomInt(0, candidates.length - 1)]!;
    added.push({ kind: 'trait', cfg: chosen });
  }

  return added;
}

/**
 * The synced random draws upstream's `unit::init` makes for a *new* unit,
 * in its order: the gender (when there is a choice to make), the traits,
 * then the name. This port does not generate names, but it makes the
 * same number of draws (`UnitType.nameDraws`), so every draw after them in
 * the same action -- the next unit's traits, the combat that follows --
 * lines up with the real game's.
 *
 * `gender` given: no draw. `randomGender`: draw among the type's genders
 * (a recruit always does; a WML `[unit]` only with `random_gender=yes`).
 * `randomTraits` false (`random_traits=no`): only must-have traits.
 * `named`: the unit already has a name, so none is generated.
 */
export function rollNewUnit(
  type: UnitType,
  rng: Rng,
  options: { gender?: string; randomGender: boolean; existing?: readonly UnitModification[]; randomTraits: boolean; canRecruit: boolean; named: boolean },
): { gender: string; traits: UnitModification[] } {
  const genders = type.genders;
  const gender =
    options.gender ??
    (options.randomGender && genders.length > 1 ? genders[rng.getRandomInt(0, genders.length - 1)]! : (genders[0] ?? 'male'));
  const traits = options.randomTraits
    ? generateTraits(type, rng, options.existing ?? [], options.canRecruit)
    : generateMustHaveTraits(type, options.existing ?? []);
  if (!options.named) {
    const draws = gender === 'female' ? type.nameDraws.female : type.nameDraws.male;
    for (let i = 0; i < draws; i++) rng.nextRandom();
  }
  return { gender, traits };
}

/** `generate_traits(must_have_only=true)`: just the missing `musthave` traits, no randomness. */
function generateMustHaveTraits(type: UnitType, existing: readonly UnitModification[]): UnitModification[] {
  const have = new Set(existing.filter((m) => m.kind === 'trait').map((m) => m.cfg.getString('id')));
  return type.possibleTraits
    .filter((t) => t.getString('availability', '') === 'musthave' && !have.has(t.getString('id')))
    .map((cfg) => ({ kind: 'trait', cfg }));
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

/** Mirrors `set_recruit_facing`: face the closest visible enemy (weighted by level), else away from the recruiting leader, else towards the map center. */
function computeRecruitFacing(board: GameBoard, unit: Unit, recruitLoc: Location, leaderLoc: Location | undefined): Direction {
  let minDist = Infinity;
  let minLoc: Location | undefined;
  for (const other of board.allUnits()) {
    const otherTeam = board.getTeam(other.side);
    const unitTeam = board.getTeam(unit.side);
    if (!otherTeam || !unitTeam || !unitTeam.isEnemy(otherTeam)) continue;
    if (!isUnitVisibleToTeam(board, other, unitTeam, false)) continue;
    const dist = distanceBetween(other.location, recruitLoc) - other.level;
    if (dist < minDist) {
      minDist = dist;
      minLoc = other.location;
    }
  }
  if (minLoc) return relativeDirection(recruitLoc, minLoc);
  if (leaderLoc) return oppositeDirection(relativeDirection(recruitLoc, leaderLoc));
  return relativeDirection(recruitLoc, new Location(Math.floor(board.map.w() / 2), Math.floor(board.map.h() / 2)));
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
  raise?: RaiseEvent,
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

  // place_recruit: clear fog around the new unit, then sighted events both ways.
  const clearer = new ShroudClearer(board);
  if (team.autoShroudUpdates) clearer.clearUnitIfNeeded(location, unit);
  if (raise) {
    clearer.fireEvents(raise);
    actorSighted(board, unit, raise);
  } else {
    clearer.dropEvents();
  }

  team.spendGold(cost);
  return { unit, location, cost };
}

/**
 * What `placeRecruitFlow` needs from whoever owns the event pump: `fire`
 * runs an event to completion *now* (upstream's `pump().fire`), suspending
 * for any dialogue it shows; `raise` queues the `sighted` events for the
 * caller to pump afterwards; `appear` plays the unit's arrival, if anything
 * is watching.
 */
export interface PlaceRecruitHooks {
  fire(name: string, loc1: Location, loc2: Location): Flow;
  raise: RaiseEvent;
  appear?(unit: Unit, leader: Unit | undefined): Flow;
}

/**
 * `actions::place_recruit` in full, event by event and in upstream's order:
 * the unit goes on the board, `unit_placed` fires, then `prerecruit`/
 * `prerecall` (either may remove it, which aborts the placement), then the
 * gold is spent and the unit appears, a village under it is taken, fog is
 * cleared, `recruit`/`recall` fires, and the `sighted` events are raised.
 * Returns `null` when an event took the unit away.
 *
 * The order is not cosmetic: those events run WML that may draw random
 * numbers (Dead Water 1's `prerecruit` rolls an undead recruit's variation),
 * so a replay only lines up with the real game when they fire where
 * upstream fires them.
 */
export function* placeRecruitFlow(
  board: GameBoard,
  team: Team,
  unit: Unit,
  location: Location,
  from: Location,
  cost: number,
  isRecall: boolean,
  hooks: PlaceRecruitHooks,
  facing?: Direction,
): Flow<PlaceRecruitResult | null> {
  unit.movesLeft = 0;
  unit.attacksLeft = 0;
  if (!isRecall) unit.healToFull();
  unit.hidden = false;

  const leader = board.unitAt(from);
  unit.location = location;
  board.addUnit(unit);
  unit.facing = facing ?? computeRecruitFacing(board, unit, location, leader?.location);

  yield* hooks.fire('unit_placed', location, Location.NULL);
  if (board.unitAt(location) !== unit) return null;
  yield* hooks.fire(isRecall ? 'prerecall' : 'prerecruit', location, from);
  if (board.unitAt(location) !== unit) return null;

  team.spendGold(cost);
  if (hooks.appear) yield* hooks.appear(unit, leader);

  if (board.map.isVillage(location) && board.villageOwner(location) !== unit.side) {
    board.captureVillage(location, unit.side);
    yield* hooks.fire('capture', location, Location.NULL);
    if (board.unitAt(location) !== unit) return null;
  }

  const clearer = new ShroudClearer(board);
  if (team.autoShroudUpdates) clearer.clearUnitIfNeeded(location, unit);

  yield* hooks.fire(isRecall ? 'recall' : 'recruit', location, from);

  clearer.fireEvents(hooks.raise);
  if (board.unitAt(location) === unit) actorSighted(board, unit, hooks.raise);
  return { unit, location, cost };
}

/** `recruit_unit` as a flow: a new unit of `type` (with upstream's creation-time draws, see `rollNewUnit`) placed by `placeRecruitFlow`. */
export function* recruitUnitFlow(
  board: GameBoard,
  team: Team,
  type: UnitType,
  loc: Location,
  from: Location,
  rng: Rng,
  hooks: PlaceRecruitHooks,
): Flow<PlaceRecruitResult | null> {
  const { gender, traits } = rollNewUnit(type, rng, { randomGender: true, randomTraits: true, canRecruit: false, named: false });
  const unit = Unit.create(type, team.side, loc, { canRecruit: false, gender, modifications: traits });
  board.assignUnitId(unit);
  return yield* placeRecruitFlow(board, team, unit, loc, from, type.cost, false, hooks);
}

/** `recall_unit` as a flow: `unit` (already off the recall list) placed by `placeRecruitFlow`. */
export function* recallUnitFlow(
  board: GameBoard,
  team: Team,
  unit: Unit,
  loc: Location,
  from: Location,
  hooks: PlaceRecruitHooks,
): Flow<PlaceRecruitResult | null> {
  const cost = unit.recallCost >= 0 ? unit.recallCost : team.recallCost;
  return yield* placeRecruitFlow(board, team, unit, loc, from, cost, true, hooks);
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
export function recruitUnit(board: GameBoard, team: Team, type: UnitType, loc: Location, from: Location, rng: Rng, raise?: RaiseEvent): PlaceRecruitResult {
  // unit::init's synced draws, in upstream's order (see `rollNewUnit`). Its
  // facing draw uses the unsynced generator, so it is not mirrored.
  const { gender, traits } = rollNewUnit(type, rng, { randomGender: true, randomTraits: true, canRecruit: false, named: false });
  const unit = Unit.create(type, team.side, loc, { canRecruit: false, gender, modifications: traits });
  board.assignUnitId(unit);
  return placeRecruit(board, team, unit, loc, from, type.cost, false, false, undefined, raise);
}

/**
 * Recalls `unit` (removed from `team`'s recall list by the caller -- see
 * `GameBoard.removeFromRecallList`) onto the board, mirroring `actions::
 * recall_unit`. Cost is the unit's own `recallCost` if set (>= 0),
 * otherwise the team's default.
 */
export function recallUnit(board: GameBoard, team: Team, unit: Unit, loc: Location, from: Location, facing?: Direction, raise?: RaiseEvent): PlaceRecruitResult {
  const cost = unit.recallCost >= 0 ? unit.recallCost : team.recallCost;
  return placeRecruit(board, team, unit, loc, from, cost, true, false, facing, raise);
}

/**
 * A WML `[recall]`'s placement (`action_wml.cpp`'s `place_recruit(..., 0, true, facing, show, fire_event, true,
 * true)`): free, and with full movement, unlike a player's recall. `from` is the recalling leader's hex, or an
 * invalid location when none recalls it.
 */
export function placeWmlRecall(board: GameBoard, team: Team, unit: Unit, loc: Location, from: Location, facing?: Direction): PlaceRecruitResult {
  return placeRecruit(board, team, unit, loc, from, 0, true, true, facing);
}

/** Permanently removes `unit` (by `underlyingId`) from `side`'s recall list, mirroring the GUI's dismiss action. Returns the removed unit, if found. */
export function dismissUnit(board: GameBoard, side: number, underlyingId: number): Unit | undefined {
  return board.removeFromRecallList(side, underlyingId);
}

/** Same as `dismissUnit`, but keyed by recall-list position -- see `GameBoard.removeFromRecallListAt`'s own doc comment for why that's the safe key for a UI (like the recall dialog) driven by list index, not `underlyingId`. */
export function dismissUnitAt(board: GameBoard, side: number, index: number): Unit | undefined {
  return board.removeFromRecallListAt(side, index);
}
