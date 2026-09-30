/**
 * The AI's action results (`src/ai/actions.cpp`) as Lua's `ai.move`/`ai.attack`/`ai.recruit`/`ai.recall`/
 * `ai.stopunit_*` and `ai.check_*` use them: a check before (`do_check_before`), then -- when executing --
 * the action through the engine's `AiContext` (which records it as a synced command, as the built-in
 * candidate actions' are), then a check after. The result carries upstream's status codes.
 */
import { distanceBetween, tilesAdjacent, Location } from '@wesnothweb2/engine/src/model/Location.js';
import type { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import type { UnitType } from '@wesnothweb2/engine/src/model/UnitType.js';
import type { AiContext } from '@wesnothweb2/engine/src/ai/context.js';
import { ShortestPathCalculator } from '@wesnothweb2/engine/src/pathfind/pathfind.js';
import { aStarSearch } from '@wesnothweb2/engine/src/pathfind/astar.js';
import { getTeleportLocations } from '@wesnothweb2/engine/src/pathfind/teleport.js';
import { checkRecruitLocation, type RecruitCheck } from '@wesnothweb2/engine/src/actions/recruit.js';
import { chooseDefenderWeaponIndex, type UnitStatsOptions } from '@wesnothweb2/engine/src/actions/combatStats.js';
import { chooseAttackerWeapon } from '@wesnothweb2/engine/src/ai/default/attackAnalysis.js';
import { isBackstabActive } from '@wesnothweb2/engine/src/actions/combat.js';
import { computeLeadershipBonus } from '@wesnothweb2/engine/src/actions/abilityEffects.js';

export const AI_ACTION_SUCCESS = 0;
export const AI_ACTION_FAILURE = -1;

export const E = {
  EMPTY_ATTACKER: 1001,
  EMPTY_DEFENDER: 1002,
  INCAPACITATED_ATTACKER: 1003,
  INCAPACITATED_DEFENDER: 1004,
  NOT_OWN_ATTACKER: 1005,
  NOT_ENEMY_DEFENDER: 1006,
  NO_ATTACKS_LEFT: 1007,
  WRONG_ATTACKER_WEAPON: 1008,
  UNABLE_TO_CHOOSE_ATTACKER_WEAPON: 1009,
  ATTACKER_AND_DEFENDER_NOT_ADJACENT: 1010,
  EMPTY_MOVE: 2001,
  MOVE_NO_UNIT: 2002,
  MOVE_NOT_OWN_UNIT: 2003,
  MOVE_INCAPACITATED_UNIT: 2004,
  AMBUSHED: 2005,
  FAILED_TELEPORT: 2006,
  OFF_MAP: 2007,
  NO_ROUTE: 2008,
  RECRUIT_NOT_AVAILABLE: 3001,
  UNKNOWN_OR_DUMMY_UNIT_TYPE: 3002,
  RECRUIT_NO_GOLD: 3003,
  RECRUIT_NO_LEADER: 3004,
  RECRUIT_LEADER_NOT_ON_KEEP: 3005,
  BAD_RECRUIT_LOCATION: 3006,
  STOPUNIT_NO_UNIT: 4002,
  STOPUNIT_NOT_OWN_UNIT: 4003,
  STOPUNIT_INCAPACITATED_UNIT: 4004,
  NOT_AVAILABLE_FOR_RECALLING: 6001,
  RECALL_NO_GOLD: 6003,
  RECALL_NO_LEADER: 6004,
  RECALL_LEADER_NOT_ON_KEEP: 6005,
  BAD_RECALL_LOCATION: 6006,
} as const;

/** `actions::error_names_`. */
const ERROR_NAMES: Record<number, string> = {
  [AI_ACTION_SUCCESS]: 'action_result::AI_ACTION_SUCCESS',
  1: 'action_result::AI_ACTION_STARTED',
  [AI_ACTION_FAILURE]: 'action_result::AI_ACTION_FAILURE',
  1001: 'attack_result::E_EMPTY_ATTACKER',
  1002: 'attack_result::E_EMPTY_DEFENDER',
  1003: 'attack_result::E_INCAPACITATED_ATTACKER',
  1004: 'attack_result::E_INCAPACITATED_DEFENDER',
  1005: 'attack_result::E_NOT_OWN_ATTACKER',
  1006: 'attack_result::E_NOT_ENEMY_DEFENDER',
  1007: 'attack_result::E_NO_ATTACKS_LEFT',
  1008: 'attack_result::E_WRONG_ATTACKER_WEAPON',
  1009: 'attack_result::E_UNABLE_TO_CHOOSE_ATTACKER_WEAPON',
  1010: ' attack_result::E_ATTACKER_AND_DEFENDER_NOT_ADJACENT',
  2001: 'move_result::E_EMPTY_MOVE',
  2002: 'move_result::E_NO_UNIT',
  2003: 'move_result::E_NOT_OWN_UNIT',
  2004: 'move_result::E_INCAPACITATED_UNIT',
  2005: 'move_result::E_AMBUSHED',
  2006: 'move_result::E_FAILED_TELEPORT',
  2007: 'move_result::E_OFF_MAP',
  2008: 'move_result::E_NO_ROUTE',
  6001: 'recall_result::E_NOT_AVAILABLE_FOR_RECALLING',
  6003: 'recall_result::E_NO_GOLD',
  6004: ' recall_result::E_NO_LEADER',
  6005: 'recall_result::E_LEADER_NOT_ON_KEEP',
  6006: 'recall_result::E_BAD_RECALL_LOCATION',
  3001: 'recruit_result::E_NOT_AVAILABLE_FOR_RECRUITING',
  3002: 'recruit_result::E_UNKNOWN_OR_DUMMY_UNIT_TYPE',
  3003: 'recruit_result::E_NO_GOLD',
  3004: 'recruit_result::E_NO_LEADER',
  3005: 'recruit_result::E_LEADER_NOT_ON_KEEP',
  3006: 'recruit_result::E_BAD_RECRUIT_LOCATION',
  4002: 'stopunit_result::E_NO_UNIT',
  4003: 'stopunit_result::E_NOT_OWN_UNIT',
  4004: 'stopunit_result::E_INCAPACITATED_UNIT',
};

export function errorName(status: number): string {
  return ERROR_NAMES[status] ?? 'Unknown error';
}

export interface ActionResult {
  status: number;
  gamestateChanged: boolean;
}

class Result implements ActionResult {
  status = AI_ACTION_SUCCESS;
  gamestateChanged = false;
  get ok(): boolean {
    return this.status === AI_ACTION_SUCCESS;
  }
  fail(code: number): void {
    this.status = code;
  }
}

/** `action_result::execute` / a bare check: check before, then (executing) the action and the check after. */
function run(exec: boolean, before: (r: Result) => void, execute: (r: Result) => void, after: (r: Result) => void = () => {}): ActionResult {
  const r = new Result();
  before(r);
  if (!exec) return r;
  if (r.ok) execute(r);
  if (r.ok) after(r);
  return r;
}

function ownUnitAt(ctx: AiContext, loc: Location, r: Result, codes: { none: number; notOwn: number; incapacitated: number }): Unit | undefined {
  const u = ctx.board.unitAt(loc);
  if (!u) return void r.fail(codes.none);
  if (u.side !== ctx.side) return void r.fail(codes.notOwn);
  if (u.incapacitated) return void r.fail(codes.incapacitated);
  return u;
}

/** `move_result`. */
export function moveAction(ctx: AiContext, exec: boolean, from: Location, to: Location, removeMovement: boolean, unreachIsOk: boolean): ActionResult {
  let route: Location[] = [];
  let unit: Unit | undefined;
  return run(
    exec,
    (r) => {
      unit = ownUnitAt(ctx, from, r, { none: E.MOVE_NO_UNIT, notOwn: E.MOVE_NOT_OWN_UNIT, incapacitated: E.MOVE_INCAPACITATED_UNIT });
      if (!unit) return;
      if (from.equals(to)) {
        if (!removeMovement || unit.movesLeft === 0) r.fail(E.EMPTY_MOVE);
        return;
      }
      if (unit.movesLeft === 0) return r.fail(E.EMPTY_MOVE);
      if (!to.valid() || !ctx.board.map.onBoard(to)) return r.fail(E.OFF_MAP);
      const board = ctx.board;
      const team = ctx.team();
      const calc = new ShortestPathCalculator(board, unit, team);
      const teleports = getTeleportLocations(board, unit, { viewingTeam: team, seeAll: true });
      route = aStarSearch(unit.location, to, 10000, calc, board.map.w(), board.map.h(), 0, teleports).steps;
      if (route.length === 0) r.fail(E.NO_ROUTE);
    },
    (r) => {
      let ambushed = false;
      let failedTeleport = false;
      if (!from.equals(to)) {
        const before = ctx.gamestateSnapshot();
        const outcome = ctx.executeMove(unit!, route, false);
        if (ctx.gamestateSnapshot() !== before) r.gamestateChanged = true;
        ambushed = outcome.result.ambushed;
        failedTeleport = outcome.result.teleportFailed;
      }
      const moved = ctx.board.allUnits().find((u) => u.underlyingId === unit!.underlyingId);
      if (moved && removeMovement && moved.movesLeft > 0 && moved.location.equals(to)) {
        if (ctx.stopUnit(moved, true, false)) r.gamestateChanged = true;
      }
      if (ambushed) r.fail(E.AMBUSHED);
      else if (failedTeleport) r.fail(E.FAILED_TELEPORT);
      void unreachIsOk;
    },
  );
}

/** `attack_result`: a weapon of -1 is chosen with `aggression`, the defender's counter by the game's rule. */
export function attackAction(ctx: AiContext, exec: boolean, attackerLoc: Location, defenderLoc: Location, attackerWeapon: number, aggression: number): ActionResult {
  const board = ctx.board;
  return run(
    exec,
    (r) => {
      const attacker = board.unitAt(attackerLoc);
      const defender = board.unitAt(defenderLoc);
      if (!attacker) return r.fail(E.EMPTY_ATTACKER);
      if (!defender) return r.fail(E.EMPTY_DEFENDER);
      if (attacker.incapacitated) return r.fail(E.INCAPACITATED_ATTACKER);
      if (defender.incapacitated) return r.fail(E.INCAPACITATED_DEFENDER);
      if (attacker.attacksLeft <= 0) return r.fail(E.NO_ATTACKS_LEFT);
      if (attacker.side !== ctx.side) return r.fail(E.NOT_OWN_ATTACKER);
      const defTeam = board.getTeam(defender.side);
      if (!defTeam || !ctx.team().isEnemy(defTeam)) return r.fail(E.NOT_ENEMY_DEFENDER);
      if (attackerWeapon !== -1 && (attackerWeapon < 0 || attackerWeapon >= attacker.attacks.length)) return r.fail(E.WRONG_ATTACKER_WEAPON);
      if (!tilesAdjacent(attackerLoc, defenderLoc)) r.fail(E.ATTACKER_AND_DEFENDER_NOT_ADJACENT);
    },
    (r) => {
      const attacker = board.unitAt(attackerLoc)!;
      const defender = board.unitAt(defenderLoc)!;
      const distance = distanceBetween(attackerLoc, defenderLoc);
      const aDef = attacker.defenseModifier(board.map.getTerrain(attackerLoc));
      const dDef = defender.defenseModifier(board.map.getTerrain(defenderLoc));
      const options: UnitStatsOptions = {
        attackerLawfulBonus: ctx.host.lawfulBonusAt(attackerLoc),
        defenderLawfulBonus: ctx.host.lawfulBonusAt(defenderLoc),
        maxLiminalBonus: ctx.host.maxLiminalBonus,
        backstabActive: isBackstabActive(board, attackerLoc, defenderLoc),
        attackerLeadershipBonus: computeLeadershipBonus(board, attacker),
        defenderLeadershipBonus: computeLeadershipBonus(board, defender),
      };
      let weapon = attackerWeapon;
      if (weapon < 0) weapon = chooseAttackerWeapon(attacker, defender, distance, aDef, dDef, aggression, options)?.attackerWeaponIndex ?? -1;
      if (weapon < 0) return r.fail(E.UNABLE_TO_CHOOSE_ATTACKER_WEAPON);
      const defenderWeapon = chooseDefenderWeaponIndex(attacker, weapon, defender, distance, aDef, dDef, options);
      ctx.executeAttack(attackerLoc, weapon, defenderLoc, defenderWeapon);
      r.gamestateChanged = true;
    },
  );
}

function recruitCheckError(check: RecruitCheck, locationSpecified: boolean, codes: { noLeader: number; notOnKeep: number; badLocation: number }): number | undefined {
  switch (check) {
    case 'no_leader':
    case 'no_able_leader':
      return codes.noLeader;
    case 'no_keep_leader':
      return codes.notOnKeep;
    case 'no_vacancy':
      return codes.badLocation;
    case 'alternate_location':
      return locationSpecified ? codes.badLocation : undefined;
    default:
      return undefined;
  }
}

/** `recruit_result`: `where` may be null (any suitable castle hex). */
export function recruitAction(ctx: AiContext, exec: boolean, typeId: string, where: Location): ActionResult {
  let type: UnitType | undefined;
  let location = where;
  let leader: Unit | undefined;
  return run(
    exec,
    (r) => {
      try {
        type = ctx.host.resolveType(typeId);
      } catch {
        type = undefined;
      }
      if (!type) return r.fail(E.UNKNOWN_OR_DUMMY_UNIT_TYPE);
      const team = ctx.team();
      if (team.gold < type.cost) return r.fail(E.RECRUIT_NO_GOLD);
      const check = checkRecruitLocation(ctx.board, ctx.side, where, Location.NULL, (l) => team.canRecruitType(typeId) || l.extraRecruit.includes(typeId));
      const err = recruitCheckError(check.result, where.valid(), { noLeader: E.RECRUIT_NO_LEADER, notOnKeep: E.RECRUIT_LEADER_NOT_ON_KEEP, badLocation: E.BAD_RECRUIT_LOCATION });
      if (err !== undefined) return r.fail(err);
      location = check.location;
      leader = check.leader;
    },
    (r) => {
      const result = ctx.executeRecruit(ctx.team(), type!, location, leader?.location ?? Location.NULL);
      if (result) r.gamestateChanged = true;
    },
    (r) => {
      const u = ctx.board.unitAt(location);
      if (!ctx.board.map.onBoard(location) || !u || u.side !== ctx.side) r.fail(AI_ACTION_FAILURE);
    },
  );
}

/** `recall_result`: by unit id from the side's recall list. */
export function recallAction(ctx: AiContext, exec: boolean, unitId: string, where: Location): ActionResult {
  let unit: Unit | undefined;
  let location = where;
  let leader: Unit | undefined;
  return run(
    exec,
    (r) => {
      const team = ctx.team();
      if (team.gold < team.recallCost) return r.fail(E.RECALL_NO_GOLD);
      unit = ctx.board.recallList(ctx.side).find((u) => u.id === unitId);
      if (!unit) return r.fail(E.NOT_AVAILABLE_FOR_RECALLING);
      const check = checkRecruitLocation(ctx.board, ctx.side, where, Location.NULL, () => true);
      const err = recruitCheckError(check.result, where.valid(), { noLeader: E.RECALL_NO_LEADER, notOnKeep: E.RECALL_LEADER_NOT_ON_KEEP, badLocation: E.BAD_RECALL_LOCATION });
      if (err !== undefined) return r.fail(err);
      location = check.location;
      leader = check.leader;
    },
    (r) => {
      const result = ctx.executeRecall(ctx.team(), unit!, location, leader?.location ?? Location.NULL);
      if (result) r.gamestateChanged = true;
    },
    (r) => {
      const u = ctx.board.unitAt(location);
      if (!ctx.board.map.onBoard(location) || !u || u.side !== ctx.side) r.fail(AI_ACTION_FAILURE);
    },
  );
}

/** `stopunit_result`. */
export function stopunitAction(ctx: AiContext, exec: boolean, loc: Location, removeMovement: boolean, removeAttacks: boolean): ActionResult {
  return run(
    exec,
    (r) => {
      ownUnitAt(ctx, loc, r, { none: E.STOPUNIT_NO_UNIT, notOwn: E.STOPUNIT_NOT_OWN_UNIT, incapacitated: E.STOPUNIT_INCAPACITATED_UNIT });
    },
    (r) => {
      const u = ctx.board.unitAt(loc)!;
      if (ctx.stopUnit(u, removeMovement, removeAttacks)) r.gamestateChanged = true;
    },
    (r) => {
      const u = ctx.board.unitAt(loc);
      if (!u || (removeMovement && u.movesLeft !== 0) || (removeAttacks && u.attacksLeft !== 0)) r.fail(AI_ACTION_FAILURE);
    },
  );
}
