/**
 * `wesnoth.paths` and `wesnoth.simulate_combat` (`game_lua_kernel.cpp`: `intf_find_reach`, `intf_find_path`,
 * `intf_find_vacant_tile`, `intf_simulate_combat`), on the engine's own pathfinder and battle simulation.
 */
import { Location as LocationClass, getAdjacentTiles, type Location } from '@wesnothweb2/engine/src/model/Location.js';
import { createJammingMap, unitVisionPath } from '@wesnothweb2/engine/src/actions/vision.js';
import type { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import { reachableHexes, findVacantTile, ShortestPathCalculator } from '@wesnothweb2/engine/src/pathfind/pathfind.js';
import { aStarSearch, type CostCalculator } from '@wesnothweb2/engine/src/pathfind/astar.js';
import { getTeleportLocations } from '@wesnothweb2/engine/src/pathfind/teleport.js';
import { buildBattleContext, chooseAttackerWeapon, chooseDefenderWeaponIndex } from '@wesnothweb2/engine/src/actions/combatStats.js';
import { simulateCombat, type BattleContextUnitStats, type Combatant } from '@wesnothweb2/engine/src/actions/attackPrediction.js';
import type { AttackType } from '@wesnothweb2/engine/src/model/UnitType.js';
import { Unit as UnitClass } from '@wesnothweb2/engine/src/model/Unit.js';
import { argError, checkInteger, lua, to_luastring, pushString, tableGet, toBoolean, type LuaKernel, type LuaState } from '../kernel.js';
import type { GameKernelHost } from './host.js';
import type { LuaUnits } from './units.js';
import { findUnits } from '@wesnothweb2/engine/src/events/filter.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';

export function installPaths(k: LuaKernel, host: GameKernelHost, units: LuaUnits): void {
  const ctx = () => host.ctx();

  const tableBool = (T: LuaState, idx: number, key: string): boolean => {
    if (!tableGet(T, idx, key)) return false;
    const v = toBoolean(T, -1);
    lua.lua_pop(T, 1);
    return v;
  };
  const tableNumber = (T: LuaState, idx: number, key: string, fallback: number): number => {
    if (!tableGet(T, idx, key)) return fallback;
    const v = lua.lua_tonumber(T, -1);
    lua.lua_pop(T, 1);
    return v;
  };
  const viewingSideOpt = (T: LuaState, idx: number, fallback: number): number => {
    lua.lua_pushstring(T, to_luastring('viewing_side'));
    lua.lua_rawget(T, idx);
    if (lua.lua_isnil(T, -1)) {
      lua.lua_pop(T, 1);
      return fallback;
    }
    const side = checkInteger(T, -1);
    lua.lua_pop(T, 1);
    if (!ctx().board.getTeam(side)) return argError(T, -1, 'invalid viewing side');
    return side;
  };

  /**
   * `intf_find_reach`'s search: where `unit` can go, with the options of the table at `arg` (0 or a nil/none
   * argument: none) -- `ignore_units`, `ignore_visibility`, `ignore_teleport`, `max_cost` (upstream reads the
   * additional turns from it) and `viewing_side`.
   */
  const reachOf = (T: LuaState, unit: Unit, arg: number) => {
    let viewingSide = unit.side;
    let ignoreUnits = false;
    let seeAll = false;
    let ignoreTeleport = false;
    let additionalTurns = 0;
    if (arg > 0 && lua.lua_istable(T, arg)) {
      ignoreUnits = tableBool(T, arg, 'ignore_units');
      seeAll = tableBool(T, arg, 'ignore_visibility');
      ignoreTeleport = tableBool(T, arg, 'ignore_teleport');
      // Upstream reads additional turns from `max_cost` here.
      additionalTurns = Math.trunc(tableNumber(T, arg, 'max_cost', 0));
      viewingSide = viewingSideOpt(T, arg, viewingSide);
    } else if (arg > 0 && !lua.lua_isnoneornil(T, arg)) argError(T, arg, 'table expected');
    const board = ctx().board;
    return reachableHexes(board, unit, {
      forceIgnoreZoc: ignoreUnits,
      ignoreUnits,
      allowTeleport: !ignoreTeleport,
      viewingTeam: board.getTeam(viewingSide),
      additionalTurns,
      seeAll,
    }).destinations.values();
  };
  const sideFilter = (side: number): WmlConfig => {
    const cfg = new WmlConfig();
    cfg.setAttribute('side', side);
    return cfg;
  };
  const lauxlibLen = (T: LuaState, idx: number): number => lua.lua_rawlen(T, idx);

  k.defineAll(['wesnoth', 'paths'], {
    find_reach: (T) => {
      let arg = 1;
      let unit: Unit;
      if (lua.lua_isuserdata(T, arg)) unit = units.check(T, arg);
      else {
        const src = k.checkLocation(T, arg);
        const found = ctx().board.unitAt(src);
        if (!found) return argError(T, 1, 'unit not found');
        unit = found;
      }
      arg++;
      const steps = reachOf(T, unit, arg);
      lua.lua_createtable(T, steps.length, 0);
      steps.forEach((s, i) => {
        k.pushNamedTuple(T, ['x', 'y', 'moves_left']);
        lua.lua_pushinteger(T, s.curr.wmlX);
        lua.lua_rawseti(T, -2, 1);
        lua.lua_pushinteger(T, s.curr.wmlY);
        lua.lua_rawseti(T, -2, 2);
        lua.lua_pushinteger(T, s.moveLeft);
        lua.lua_rawseti(T, -2, 3);
        lua.lua_rawseti(T, -2, i + 1);
      });
      return 1;
    },

    /**
     * Not upstream API: `ai/lua/battle_calcs.lua`'s `get_attack_map(units, cfg)` worked out natively (see
     * `installNativeAttackMap`). Returns the merged map as a flat array `{x, y, units, hitpoints, ...}`, in the
     * order the Lua version first inserts each hex, and leaves the board as the Lua version leaves it.
     */
    __port_attack_map: (T) => {
      if (!lua.lua_istable(T, 1)) return argError(T, 1, 'table expected');
      const cfgIdx = lua.lua_istable(T, 2) ? 2 : 0;
      const board = ctx().board;
      const current = host.currentSide();
      const cfgMaxMoves = cfgIdx ? tableBool(T, cfgIdx, 'max_moves') : false;
      const count = lauxlibLen(T, 1);
      const order: Location[] = [];
      const merged = new Map<string, { units: number; hitpoints: number }>();
      for (let i = 1; i <= count; i++) {
        lua.lua_geti(T, 1, i);
        const unit = units.check(T, -1);
        lua.lua_pop(T, 1);
        // `get_attack_map_unit`: the unit's own moves, or (for a unit of another side, or `max_moves`) its full moves.
        const maxMoves = cfgMaxMoves || unit.side !== current;
        const oldMoves = unit.movesLeft;
        if (maxMoves) unit.movesLeft = unit.maxMoves;
        // For a unit of another side, the current side's units with moves left are taken off the map (they
        // will have moved by then), as `extract` and `to_map` do: each put back at the end of the board's list.
        const lifted: Unit[] = [];
        if (unit.side !== current) {
          for (const u of findUnits(board, sideFilter(current))) {
            if (u.movesLeft > 0) {
              lifted.push(u);
              board.removeUnitAt(u.location);
            }
          }
        }
        const reach = reachOf(T, unit, cfgIdx);
        for (const u of lifted) {
          board.removeUnitAt(u.location);
          board.addUnit(u);
        }
        // This unit's map, in its own first-insertion order: each reachable hex, then its neighbours on the map.
        const own = new Set<string>();
        const ownOrder: Location[] = [];
        const add = (loc: Location) => {
          const key = `${loc.x},${loc.y}`;
          if (own.has(key)) return;
          own.add(key);
          ownOrder.push(loc);
        };
        for (const step of reach) {
          add(step.curr);
          for (const adj of getAdjacentTiles(step.curr)) if (board.map.onBoard(adj)) add(adj);
        }
        // `union_merge`: added in the order this unit's map lists them; a hex already there keeps its place.
        for (const loc of ownOrder) {
          const key = `${loc.x},${loc.y}`;
          const entry = merged.get(key);
          if (entry) {
            entry.units += 1;
            entry.hitpoints += unit.hitpoints;
          } else {
            merged.set(key, { units: 1, hitpoints: unit.hitpoints });
            order.push(loc);
          }
        }
        if (maxMoves) unit.movesLeft = oldMoves;
      }
      lua.lua_createtable(T, order.length * 4, 0);
      order.forEach((loc, i) => {
        const entry = merged.get(`${loc.x},${loc.y}`)!;
        lua.lua_pushinteger(T, loc.wmlX);
        lua.lua_rawseti(T, -2, i * 4 + 1);
        lua.lua_pushinteger(T, loc.wmlY);
        lua.lua_rawseti(T, -2, i * 4 + 2);
        lua.lua_pushinteger(T, entry.units);
        lua.lua_rawseti(T, -2, i * 4 + 3);
        lua.lua_pushinteger(T, entry.hitpoints);
        lua.lua_rawseti(T, -2, i * 4 + 4);
      });
      return 1;
    },

    find_path: (T) => {
      let arg = 1;
      let src: Location;
      let unit: Unit | undefined;
      let viewingSide = 0;
      const board = ctx().board;
      if (lua.lua_isuserdata(T, arg)) {
        unit = units.check(T, arg);
        src = unit.location;
        viewingSide = unit.side;
      } else {
        src = k.checkLocation(T, arg);
        unit = board.unitAt(src);
        if (unit) viewingSide = unit.side;
      }
      arg++;
      const dst = k.checkLocation(T, arg);
      if (!board.map.onBoard(src)) return argError(T, 1, 'invalid location');
      if (!board.map.onBoard(dst)) return argError(T, arg, 'invalid location');
      arg++;
      let ignoreUnits = false;
      let seeAll = false;
      let ignoreTeleport = false;
      let stopAt = 10000;
      let calc: CostCalculator | undefined;
      if (lua.lua_istable(T, arg)) {
        ignoreUnits = tableBool(T, arg, 'ignore_units');
        seeAll = tableBool(T, arg, 'ignore_visibility');
        ignoreTeleport = tableBool(T, arg, 'ignore_teleport');
        stopAt = tableNumber(T, arg, 'max_cost', stopAt);
        viewingSide = viewingSideOpt(T, arg, viewingSide);
        lua.lua_pushstring(T, to_luastring('calculate'));
        lua.lua_rawget(T, arg);
        if (lua.lua_isfunction(T, -1)) {
          const fnIndex = lua.lua_gettop(T);
          // lua_pathfind_cost_calculator: the Lua function's cost, at least 1 (NaN counts as 1).
          calc = {
            cost: (loc: Location, soFar: number): number => {
              lua.lua_pushvalue(T, fnIndex);
              lua.lua_pushinteger(T, loc.wmlX);
              lua.lua_pushinteger(T, loc.wmlY);
              lua.lua_pushnumber(T, soFar);
              if (lua.lua_pcall(T, 3, 1, 0) !== lua.LUA_OK) {
                k.log('error', `wesnoth.paths.find_path calculate: ${lua.lua_tojsstring(T, -1)}`);
                lua.lua_pop(T, 1);
                return 1;
              }
              const cost = lua.lua_tonumber(T, -1);
              lua.lua_pop(T, 1);
              return !(cost >= 1) ? 1 : cost;
            },
          };
        }
      } else if (!lua.lua_isnoneornil(T, arg)) return argError(T, arg, 'table expected');
      let teleports;
      if (!ignoreTeleport) {
        if (viewingSide === 0) {
          k.log('warn', 'wesnoth.paths.find_path: ignore_teleport=false requires a valid viewing_side; continuing with ignore_teleport=true');
        } else if (unit) {
          const viewingTeam = board.getTeam(viewingSide);
          teleports = getTeleportLocations(board, unit, { viewingTeam: seeAll ? undefined : viewingTeam, seeAll, ignoreUnits });
        }
      }
      if (!calc) {
        if (!unit) return argError(T, 1, 'unit not found OR custom cost function not provided');
        const viewingTeam = board.getTeam(viewingSide);
        calc = new ShortestPathCalculator(board, unit, seeAll ? undefined : viewingTeam, { ignoreUnit: ignoreUnits, seeAll });
      }
      const res = aStarSearch(src, dst, stopAt, calc, board.map.w(), board.map.h(), 0, teleports);
      lua.lua_createtable(T, res.steps.length, 0);
      res.steps.forEach((loc, i) => {
        k.pushLocation(T, loc);
        lua.lua_rawseti(T, -2, i + 1);
      });
      lua.lua_pushinteger(T, Math.trunc(res.moveCost));
      return 2;
    },

    find_vacant_hex: (T) => {
      const loc = k.checkLocation(T, 1);
      let unit: Unit | undefined;
      if (!lua.lua_isnoneornil(T, 2)) {
        unit = units.toUnit(T, 2);
        if (!unit) unit = UnitClass.fromConfig(k.checkConfig(T, 2), ctx().resolveType);
      }
      const res = findVacantTile(ctx().board, loc, { passCheck: unit });
      if (!res) return 0;
      lua.lua_pushinteger(T, res.wmlX);
      lua.lua_pushinteger(T, res.wmlY);
      return 2;
    },
  });
  // `intf_find_vision_range`: `vision_path` with the side's jamming map; destinations, then edges with -1.
  k.define(['wesnoth', 'paths', 'find_vision_range'], (T) => {
    let unit: Unit;
    if (lua.lua_isuserdata(T, 1)) unit = units.check(T, 1);
    else {
      const found = ctx().board.unitAt(k.checkLocation(T, 1));
      if (!found) return argError(T, 1, 'unit not found');
      unit = found;
    }
    const board = ctx().board;
    const team = board.getTeam(unit.side);
    const res = unitVisionPath(board, unit, unit.location, team ? createJammingMap(board, team) : new Map());
    const rows: Array<[number, number, number]> = res.destinations.values().map((d) => [d.curr.wmlX, d.curr.wmlY, d.moveLeft]);
    for (const key of res.edges) {
      const loc = LocationClass.fromKey(key);
      rows.push([loc.wmlX, loc.wmlY, -1]);
    }
    lua.lua_createtable(T, rows.length, 0);
    rows.forEach((row, i) => {
      k.pushNamedTuple(T, ['x', 'y', 'vision_left']);
      row.forEach((v, j) => {
        lua.lua_pushinteger(T, v);
        lua.lua_rawseti(T, -2, j + 1);
      });
      lua.lua_rawseti(T, -2, i + 1);
    });
    return 1;
  });
  k.unported(['wesnoth', 'paths', 'find_cost_map']);

  k.define(['wesnoth', 'simulate_combat'], (T) => {
    let arg = 1;
    let attW = -1;
    let defW = -1;
    const att = units.check(T, arg++);
    if (lua.lua_isnumber(T, arg)) {
      attW = checkInteger(T, arg) - 1;
      if (attW < 0 || attW >= att.attacks.length) return argError(T, arg, 'weapon index out of bounds');
      arg++;
    }
    const def = units.check(T, arg++);
    if (lua.lua_isnumber(T, arg)) {
      defW = checkInteger(T, arg) - 1;
      if (defW < 0 || defW >= def.attacks.length) return argError(T, arg, 'weapon index out of bounds');
      arg++;
    }
    const sim = battleContext(host, att, attW, def, defW);
    pushSimData(T, sim.attacker);
    pushSimData(T, sim.defender);
    pushSimWeapon(k, units, T, sim.attackerStats, att.attacks[sim.attackerWeaponIndex], sim.attackerWeaponIndex);
    pushSimWeapon(k, units, T, sim.defenderStats, def.attacks[sim.defenderWeaponIndex], sim.defenderWeaponIndex);
    return 4;
  });

  installNativeAttackMap(k);
}

/**
 * Not upstream: `ai/lua/battle_calcs.lua`'s `get_attack_map`, which the default AI's `retreat_injured` (and
 * `grab_villages`, several micro AIs) call, worked out by `wesnoth.paths.__port_attack_map` instead of in Lua.
 * The result is the same location sets, filled in the same order (this VM's tables iterate in insertion order),
 * and the board ends as the Lua version leaves it -- only faster. In this interpreted Lua it took the AI a second
 * or two for each evaluation on a 40-unit map, all of it with the page frozen (real, reported bug: Northern
 * Rebirth 1, "everything freezes while the AI thinks"). The module is patched the first time `wesnoth.require`
 * returns it, wherever it is loaded from.
 */
function installNativeAttackMap(k: LuaKernel): void {
  k.run(
    `local require = wesnoth.require
local patched = setmetatable({}, { __mode = 'k' })
wesnoth.require = function(...)
  local m = require(...)
  if type(m) == 'table' and not patched[m] and rawget(m, 'get_attack_map') and rawget(m, 'get_attack_map_unit') then
    patched[m] = true
    local LS = require 'location_set'
    m.get_attack_map = function(units, cfg)
      local flat = wesnoth.paths.__port_attack_map(units, cfg)
      local map = { units = LS.create(), hitpoints = LS.create() }
      for i = 1, #flat, 4 do
        map.units:insert(flat[i], flat[i + 1], flat[i + 2])
        map.hitpoints:insert(flat[i], flat[i + 1], flat[i + 3])
      end
      return map
    end
  end
  return m
end`,
    '=native_attack_map',
  );
}

/**
 * `battle_context(units, att_loc, def_loc, att_w, def_w, aggression=0.0, nullptr, att, def)`: a weapon of -1 is
 * chosen as the game does (the attacker's best by `choose_attacker_weapon` with harm weight 1, the defender's
 * best counter), and the combat simulated with each unit where it stands.
 */
function battleContext(host: GameKernelHost, att: Unit, attW: number, def: Unit, defW: number) {
  const ctx = host.ctx();
  const input = { board: ctx.board, attacker: att, defender: def, options: { maxLiminalBonus: ctx.schedule.maxLiminalBonus } };
  let attackerWeaponIndex = attW;
  let defenderWeaponIndex = defW;
  if (attackerWeaponIndex < 0) {
    // Both weapons are chosen, whatever defender weapon was asked for.
    ({ attackerWeaponIndex, defenderWeaponIndex } = chooseAttackerWeapon(input, 1.0));
  } else if (defenderWeaponIndex < 0) {
    defenderWeaponIndex = chooseDefenderWeaponIndex(input, attackerWeaponIndex);
  }
  const aw = attackerWeaponIndex >= 0 ? att.attacks[attackerWeaponIndex] : undefined;
  const dw = defenderWeaponIndex >= 0 ? def.attacks[defenderWeaponIndex] : undefined;
  const { attacker: attackerStats, defender: defenderStats } = buildBattleContext({ ...input, attackerWeapon: aw, defenderWeapon: dw });
  const { attacker, defender } = simulateCombat(attackerStats, defenderStats);
  return { attacker, defender, attackerStats, defenderStats, attackerWeaponIndex, defenderWeaponIndex };
}

/** `luaW_pushsimdata`. */
function pushSimData(T: LuaState, c: Combatant): void {
  lua.lua_createtable(T, 0, 5);
  lua.lua_pushnumber(T, c.poisoned);
  lua.lua_setfield(T, -2, to_luastring('poisoned'));
  lua.lua_pushnumber(T, c.slowed);
  lua.lua_setfield(T, -2, to_luastring('slowed'));
  lua.lua_pushnumber(T, c.untouched);
  lua.lua_setfield(T, -2, to_luastring('untouched'));
  lua.lua_pushnumber(T, c.averageHp());
  lua.lua_setfield(T, -2, to_luastring('average_hp'));
  lua.lua_createtable(T, c.hpDist.length, 0);
  c.hpDist.forEach((p, i) => {
    lua.lua_pushnumber(T, p);
    lua.lua_rawseti(T, -2, i);
  });
  lua.lua_setfield(T, -2, to_luastring('hp_chance'));
}

/** `luaW_pushsimweapon`. */
function pushSimWeapon(k: LuaKernel, units: LuaUnits, T: LuaState, s: BattleContextUnitStats, weapon: AttackType | undefined, index: number): void {
  lua.lua_createtable(T, 0, 16);
  const num = (key: string, v: number) => {
    lua.lua_pushnumber(T, v);
    lua.lua_setfield(T, -2, to_luastring(key));
  };
  const bool = (key: string, v: boolean) => {
    lua.lua_pushboolean(T, v);
    lua.lua_setfield(T, -2, to_luastring(key));
  };
  num('num_blows', s.numBlows);
  num('damage', s.damage);
  num('chance_to_hit', s.chanceToHit);
  bool('poisons', s.poisons);
  bool('slows', s.slows);
  bool('petrifies', s.petrifies);
  bool('plagues', s.plagues ?? false);
  pushString(T, s.plagueType ?? '');
  lua.lua_setfield(T, -2, to_luastring('plague_type'));
  num('rounds', s.rounds);
  bool('firststrike', s.firststrike);
  bool('drains', s.drains);
  num('drain_constant', s.drainConstant);
  num('drain_percent', s.drainPercent);
  num('attack_num', index);
  num('number', index + 1);
  if (weapon) {
    pushString(T, weapon.id);
    lua.lua_setfield(T, -2, to_luastring('name'));
    units.pushWeapon(T, weapon);
    lua.lua_setfield(T, -2, to_luastring('weapon'));
  }
  void k;
}
