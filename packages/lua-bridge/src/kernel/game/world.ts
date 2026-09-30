/**
 * The game world in Lua, ported from `game_lua_kernel.cpp`, `lua_terrainmap.cpp`, `lua_team.cpp` and
 * `lua_unit_type.cpp`: the `"terrain map"` userdata (`wesnoth.current.map`), `wesnoth.map`'s game functions,
 * `wesnoth.current`, `wesnoth.scenario`, `wesnoth.sides` and the `"side"` userdata, `wesnoth.unit_types`,
 * `wesnoth.terrain_types` and `wesnoth.schedule`. Only the game's own map is a terrain map here
 * (`wesnoth.map.create` is not ported).
 */
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { TString } from '@wesnothweb2/engine/src/i18n/tstring.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import type { Team } from '@wesnothweb2/engine/src/model/Team.js';
import type { UnitType } from '@wesnothweb2/engine/src/model/UnitType.js';
import { parseTerrainCode, writeTerrainCode, NONE_TERRAIN } from '@wesnothweb2/engine/src/model/Terrain.js';
import { findLocations, locationMatchesFilterOnBoard } from '@wesnothweb2/engine/src/events/filter.js';
import { findSides, sideMatchesFilter } from '@wesnothweb2/engine/src/events/sideFilter.js';
import { effectiveTimeOfDayAt } from '@wesnothweb2/engine/src/actions/illumination.js';
import type { TimeOfDayEntry } from '@wesnothweb2/engine/src/model/Schedule.js';
import { labelFromConfig, labelToConfig } from '@wesnothweb2/engine/src/events/labelsWml.js';
import {
  argError,
  checkInteger,
  checkString,
  lauxlib,
  lua,
  luaError,
  pushString,
  pushStringArray,
  tableGet,
  to_luastring,
  toBoolean,
  typeError,
  type LuaCFunction,
  type LuaKernel,
  type LuaState,
} from '../kernel.js';
import type { GameKernelHost } from './host.js';
import type { LuaUnits } from './units.js';

const TERRAIN_MAP_KEY = 'terrain map';
const SIDE_KEY = 'side';
const SIDE_VARIABLES_KEY = 'side variables';
const UNIT_TYPE_KEY = 'unit type';

export interface WorldOptions {
  /** A side's `[ai]` as its `__cfg` shows it (`team::write`); the AI module supplies it. */
  sideAiConfigs?: (side: number) => readonly WmlConfig[];
  /** The scenario's id, name and difficulty (`wesnoth.scenario`). */
  scenario?: () => { id: string; name: string | TString; difficulty: string; campaignType: string };
}

export function installWorld(k: LuaKernel, host: GameKernelHost, units: LuaUnits, options: WorldOptions = {}): void {
  const ctx = () => host.ctx();
  const turn = (): number => ctx().turnNumber?.() ?? ctx().variables.getNumber('turn_number', 1);

  // --- the terrain map ---
  const L = k.L;
  let mapTableRef: number | undefined;
  lauxlib.luaL_newmetatable(L, to_luastring(TERRAIN_MAP_KEY));
  setFuncs(L, {
    __index: (T) => {
      checkMap(k, T, 1);
      const map = ctx().board.map;
      const loc = k.toLocation(T, 2);
      if (loc) {
        pushString(T, writeTerrainCode(map.getTerrain(loc)));
        return 1;
      }
      // Methods (`map:iter_adjacent(...)`, ...) are `wesnoth.map`'s functions: a raw lookup of the key already on
      // the stack, in the table as it was first used -- this runs for every hex a Lua AI walks.
      if (lua.lua_type(T, 2) === lua.LUA_TSTRING) {
        if (mapTableRef === undefined) {
          lua.lua_getglobal(T, to_luastring('wesnoth'));
          lua.lua_getfield(T, -1, to_luastring('map'));
          mapTableRef = lauxlib.luaL_ref(T, lua.LUA_REGISTRYINDEX);
          lua.lua_pop(T, 1);
        }
        lua.lua_rawgeti(T, lua.LUA_REGISTRYINDEX, mapTableRef);
        lua.lua_pushvalue(T, 2);
        if (lua.lua_rawget(T, -2) !== lua.LUA_TNIL) return 1;
        lua.lua_pop(T, 2);
      }
      const key = checkString(T, 2);
      switch (key) {
        case 'width':
          lua.lua_pushinteger(T, map.w() + 2);
          return 1;
        case 'height':
          lua.lua_pushinteger(T, map.h() + 2);
          return 1;
        case 'playable_width':
          lua.lua_pushinteger(T, map.w());
          return 1;
        case 'playable_height':
          lua.lua_pushinteger(T, map.h());
          return 1;
        case 'border_size':
          lua.lua_pushinteger(T, 1);
          return 1;
        case 'data':
          pushString(T, map.write());
          return 1;
        default:
          return 0;
      }
    },
    __newindex: (T) => {
      checkMap(k, T, 1);
      const loc = lua.lua_type(T, 3) !== lua.LUA_TNUMBER ? k.toLocation(T, 2) : undefined;
      if (loc) {
        const str = checkString(T, 3);
        const mode = str.startsWith('^') ? 'OVERLAY' : str.endsWith('^') ? 'BASE' : 'BOTH';
        ctx().board.changeTerrain(loc, parseTerrainCode(str), mode);
        return 0;
      }
      return argError(T, 2, `unknown modifiable property of map: ${checkString(T, 2)}`);
    },
  });
  pushString(L, TERRAIN_MAP_KEY);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_pop(L, 1);
  const pushMap = (T: LuaState): void => k.pushUserdata(T, TERRAIN_MAP_KEY, true);

  k.defineAll(['wesnoth', 'map'], {
    on_board: (T) => {
      checkMap(k, T, 1);
      const loc = k.checkLocation(T, 2);
      const withBorder = lua.lua_isnoneornil(T, 3) ? false : toBoolean(T, 3);
      const map = ctx().board.map;
      lua.lua_pushboolean(T, withBorder ? map.onBoardWithBorder(loc) : map.onBoard(loc));
      return 1;
    },
    on_border: (T) => {
      checkMap(k, T, 1);
      const loc = k.checkLocation(T, 2);
      const map = ctx().board.map;
      lua.lua_pushboolean(T, map.onBoardWithBorder(loc) && !map.onBoard(loc));
      return 1;
    },
    iter: (T) => {
      checkMap(k, T, 1);
      const withBorder = lua.lua_isboolean(T, 2) ? toBoolean(T, 2) : false;
      const map = ctx().board.map;
      const w = withBorder ? map.w() + 1 : map.w();
      const h = withBorder ? map.h() + 1 : map.h();
      let x = withBorder ? -1 : 0;
      let y = 1;
      if (withBorder) y = 0;
      lua.lua_pushcfunction(T, (U: LuaState) => {
        if (x === w) {
          if (y === h) {
            lua.lua_pushnil(U);
            return 1;
          }
          x = withBorder ? 0 : 1;
          y++;
        } else x++;
        lua.lua_pushinteger(U, x);
        lua.lua_pushinteger(U, y);
        pushString(U, writeTerrainCode(map.getTerrain(Location.fromWml(x, y))));
        return 3;
      });
      return 1;
    },
    get_owner: (T) => {
      const loc = k.checkLocation(T, 1);
      const board = ctx().board;
      if (!board.map.isVillage(loc)) return 0;
      const side = board.villageOwner(loc);
      if (!side) return 0;
      lua.lua_pushinteger(T, side);
      return 1;
    },
    set_owner: (T) => {
      const loc = k.checkLocation(T, 1);
      const side = lua.lua_isnoneornil(T, 2) ? 0 : checkInteger(T, 2);
      const board = ctx().board;
      if (!board.map.isVillage(loc)) return 0;
      board.captureVillage(loc, side);
      return 0;
    },
    find: (T) => {
      const filter = k.checkConfig(T, 1);
      const ref = units.toUnit(T, 2);
      k.pushLocationSet(T, sortLocations(findLocations(ctx().board, filter, ref)));
      return 1;
    },
    matches: (T) => {
      const loc = k.checkLocation(T, 1);
      const filter = k.checkConfig(T, 2);
      const ref = units.toUnit(T, 3);
      lua.lua_pushboolean(T, locationMatchesFilterOnBoard(ctx().board, loc, filter, ref));
      return 1;
    },
  });
  // Labels (`intf_add_label`/`intf_remove_label`/`intf_get_label`), on the game's label store.
  k.defineAll(['wesnoth', 'map'], {
    add_label: (T) => {
      const c = ctx();
      c.labels.set(labelFromConfig(c.variables.expandConfig(k.checkConfig(T, 1)), c));
      return 0;
    },
    remove_label: (T) => {
      const loc = k.checkLocation(T, 1);
      let teamName = '';
      if (lua.lua_gettop(T) === 1 && lua.lua_istable(T, 1)) {
        if (tableGet(T, 1, 'team_name')) {
          teamName = lua.lua_isstring(T, -1) ? checkString(T, -1) : '';
          lua.lua_pop(T, 1);
        }
      } else if (lua.lua_isstring(T, 2)) teamName = checkString(T, 2);
      const c = ctx();
      c.labels.set({ ...labelFromConfig(new WmlConfig(), c, loc), teamName, text: '' });
      return 0;
    },
    get_label: (T) => {
      const loc = k.checkLocation(T, 1);
      const board = ctx().board;
      let teamName: string | undefined;
      if (lua.lua_isnoneornil(T, 2)) teamName = '';
      else if (lua.lua_type(T, 2) === lua.LUA_TNUMBER) teamName = board.getTeam(checkInteger(T, 2))?.teamName;
      else if (lua.lua_type(T, 2) === lua.LUA_TSTRING) teamName = checkString(T, 2);
      else if (lua.lua_isuserdata(T, 2)) {
        const side = k.userdata<number>(T, 2, SIDE_KEY);
        if (side === undefined) return typeError(T, 2, 'side');
        teamName = board.getTeam(side)?.teamName;
      }
      const label = teamName === undefined ? undefined : ctx().labels.get(loc, teamName);
      if (!label) return 0;
      k.pushConfig(T, labelToConfig(label));
      return 1;
    },
  });
  for (const name of ['terrain_mask', 'place_area', 'remove_area', 'get_area', 'replace_if_failed', 'create', 'generate_height_map']) {
    k.unported(['wesnoth', 'map', name]);
  }

  // --- wesnoth.current ---
  const currentGetters: Record<string, (T: LuaState) => void> = {
    side: (T) => lua.lua_pushinteger(T, host.currentSide()),
    turn: (T) => lua.lua_pushinteger(T, turn()),
    synced_state: (T) => pushString(T, 'unsynced'),
    user_can_invoke_commands: (T) => lua.lua_pushboolean(T, false),
    map: (T) => pushMap(T),
    user_is_replaying: (T) => lua.lua_pushboolean(T, false),
    event_context: (T) => {
      const c = ctx();
      const cfg = new WmlConfig();
      cfg.setAttribute('name', c.eventData.getString('name', ''));
      k.pushConfig(T, cfg);
    },
  };
  pushProxy(k, ['wesnoth'], 'current', 'current', currentGetters);

  // --- wesnoth.scenario ---
  const scenarioGetters: Record<string, (T: LuaState) => void> = {
    turns: (T) => lua.lua_pushinteger(T, ctx().turnLimit),
    id: (T) => pushString(T, options.scenario?.().id ?? ''),
    name: (T) => {
      const name = options.scenario?.().name ?? '';
      k.pushTString(T, typeof name === 'string' ? TString.literal(name) : name);
    },
    difficulty: (T) => pushString(T, options.scenario?.().difficulty ?? ''),
    type: (T) => pushString(T, options.scenario?.().campaignType ?? 'scenario'),
  };
  pushProxy(k, ['wesnoth'], 'scenario', 'scenario', scenarioGetters);

  // --- sides ---
  installSides(k, host, options);

  // --- unit types and terrain types ---
  installUnitTypes(k, host, units);
  installRaces(k, host);
  pushTableProxy(k, ['wesnoth'], 'terrain_types', 'terrain types', (T) => {
    const code = parseTerrainCode(checkString(T, 2));
    if (code.equals(NONE_TERRAIN)) return 0;
    const map = ctx().board.map;
    const info = map.terrainInfoFor(code);
    if (!info || info.id === '') return 0;
    lua.lua_createtable(T, 0, 12);
    const set = (key: string, push: () => void): void => {
      push();
      lua.lua_setfield(T, -2, to_luastring(key));
    };
    set('id', () => pushString(T, info.id));
    set('name', () => k.pushTString(T, info.nameT ?? TString.literal(info.name)));
    set('editor_name', () => k.pushTString(T, info.nameT ?? TString.literal(info.name)));
    set('description', () => k.pushTString(T, info.nameT ?? TString.literal(info.name)));
    set('icon', () => pushString(T, ''));
    set('editor_image', () => pushString(T, ''));
    set('light', () => lua.lua_pushinteger(T, info.lightModification));
    set('village', () => lua.lua_pushboolean(T, info.isVillage()));
    set('castle', () => lua.lua_pushboolean(T, info.isCastle()));
    set('keep', () => lua.lua_pushboolean(T, info.isKeep()));
    set('healing', () => lua.lua_pushinteger(T, info.givesHealing()));
    const aliases = (list: readonly import('@wesnothweb2/engine/src/model/Terrain.js').TerrainCode[]) => {
      const codes = list.map((c) => map.terrainInfoFor(c)).filter((t) => t && t.id !== '').map((t) => writeTerrainCode(t!.code));
      pushStringArray(T, codes);
    };
    set('mvt_alias', () => aliases(info.mvtType));
    set('def_alias', () => aliases(info.defType));
    return 1;
  });

  // --- the schedule ---
  const pushTod = (T: LuaState, tod: TimeOfDayEntry): void => {
    lua.lua_createtable(T, 0, 10);
    const set = (key: string, push: () => void): void => {
      push();
      lua.lua_setfield(T, -2, to_luastring(key));
    };
    set('id', () => pushString(T, tod.id));
    set('lawful_bonus', () => lua.lua_pushinteger(T, tod.lawfulBonus));
    set('bonus_modified', () => lua.lua_pushinteger(T, 0));
    set('image', () => pushString(T, tod.image));
    set('name', () => k.pushTString(T, TString.literal(tod.name)));
    set('sound', () => pushString(T, tod.sounds ?? ''));
    set('mask', () => pushString(T, ''));
    set('red', () => lua.lua_pushinteger(T, tod.red));
    set('green', () => lua.lua_pushinteger(T, tod.green));
    set('blue', () => lua.lua_pushinteger(T, tod.blue));
  };
  const getTod = (illuminated: boolean): LuaCFunction => (T) => {
    const c = ctx();
    let forTurn = turn();
    let loc: Location | undefined;
    const given = k.toLocation(T, 1);
    if (given) {
      if (!c.board.map.onBoardWithBorder(given)) return argError(T, 1, 'coordinates are not on board');
      loc = given;
    } else if (lua.lua_isstring(T, 1)) return luaError(T, 'wesnoth.schedule: time areas by id are not available in this port yet');
    if (lua.lua_isnumber(T, 2)) {
      forTurn = checkInteger(T, 2);
      const limit = c.turnLimit;
      if (forTurn < 1 || (limit !== -1 && forTurn > limit)) return argError(T, 2, 'turn number out of range');
    }
    const tod = loc
      ? illuminated
        ? effectiveTimeOfDayAt(c.board, c.schedule, forTurn, loc)
        : c.schedule.timeOfDayAt(loc, forTurn)
      : c.schedule.timeOfDayForTurn(forTurn);
    pushTod(T, tod);
    return 1;
  };
  k.defineAll(['wesnoth', 'schedule'], { get_time_of_day: getTod(false), get_illumination: getTod(true) });
  k.unported(['wesnoth', 'schedule', 'replace']);
}

function checkMap(k: LuaKernel, T: LuaState, idx: number): void {
  if (k.userdata(T, idx, TERRAIN_MAP_KEY) === undefined) typeError(T, idx, 'terrain map');
}

/** `std::set<map_location>` order: by x, then y. */
function sortLocations(locs: readonly Location[]): Location[] {
  return [...locs].sort((a, b) => a.x - b.x || a.y - b.y);
}

function setFuncs(L: LuaState, fns: Readonly<Record<string, LuaCFunction>>): void {
  for (const [name, fn] of Object.entries(fns)) {
    lua.lua_pushcfunction(L, fn);
    lua.lua_setfield(L, -2, to_luastring(name));
  }
}

/** A read-only attribute table like upstream's registry-backed userdata (`wesnoth.current`, `wesnoth.scenario`). */
function pushProxy(k: LuaKernel, parent: readonly string[], field: string, name: string, getters: Record<string, (T: LuaState) => void>): void {
  const L = k.L;
  k.pushTablePath(parent);
  lua.lua_newuserdata(L, 0);
  lua.lua_createtable(L, 0, 3);
  setFuncs(L, {
    __index: (T) => {
      const key = checkString(T, 2);
      const get = getters[key];
      if (!get) return argError(T, 2, `invalid property of ${name}: ${key}`);
      get(T);
      return 1;
    },
    __newindex: (T) => argError(T, 2, `invalid modifiable property of ${name}: ${checkString(T, 2)}`),
    __dir: (T) => {
      pushStringArray(T, Object.keys(getters));
      return 1;
    },
  });
  pushString(L, name);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_setmetatable(L, -2);
  lua.lua_setfield(L, -2, to_luastring(field));
  lua.lua_pop(L, 1);
}

/** A table whose `__index` computes entries (`wesnoth.terrain_types`, `wesnoth.unit_types`). */
function pushTableProxy(k: LuaKernel, parent: readonly string[], field: string, name: string, index: LuaCFunction): void {
  const L = k.L;
  k.pushTablePath(parent);
  lua.lua_createtable(L, 0, 0);
  lua.lua_createtable(L, 0, 2);
  lua.lua_pushcfunction(L, index);
  lua.lua_setfield(L, -2, to_luastring('__index'));
  pushString(L, name);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_setmetatable(L, -2);
  lua.lua_setfield(L, -2, to_luastring(field));
  lua.lua_pop(L, 1);
}

// --- sides (lua_team.cpp) ---

function installSides(k: LuaKernel, host: GameKernelHost, options: WorldOptions): void {
  const L = k.L;
  const ctx = () => host.ctx();
  const teamAt = (T: LuaState, idx: number): Team => {
    const side = k.userdata<number>(T, idx, SIDE_KEY);
    const team = side === undefined ? undefined : ctx().board.getTeam(side);
    if (!team) return typeError(T, idx, 'side');
    return team;
  };
  const pushTeam = (T: LuaState, team: Team): void => k.pushUserdata(T, SIDE_KEY, team.side);
  const board = () => ctx().board;

  const getters: Record<string, (T: LuaState, t: Team) => void> = {
    side: (T, t) => lua.lua_pushinteger(T, t.side),
    save_id: (T, t) => pushString(T, t.saveId),
    gold: (T, t) => lua.lua_pushinteger(T, t.gold),
    objectives: (T, t) => k.pushTString(T, TString.literal(t.objectives)),
    village_gold: (T, t) => lua.lua_pushinteger(T, t.incomePerVillage),
    village_support: (T, t) => lua.lua_pushinteger(T, t.supportPerVillage),
    num_villages: (T, t) => lua.lua_pushinteger(T, board().villageCount(t.side)),
    recall_cost: (T, t) => lua.lua_pushinteger(T, t.recallCost),
    base_income: (T, t) => lua.lua_pushinteger(T, t.income),
    fog: (T, t) => lua.lua_pushboolean(T, t.usesFog()),
    shroud: (T, t) => lua.lua_pushboolean(T, t.usesShroud()),
    hidden: (T, t) => lua.lua_pushboolean(T, t.hidden),
    scroll_to_leader: (T, t) => lua.lua_pushboolean(T, t.scrollToLeader),
    color: (T, t) => pushString(T, t.color),
    flag: (T, t) => pushString(T, t.flag),
    user_team_name: (T, t) => k.pushTString(T, TString.literal(t.userTeamName)),
    team_name: (T, t) => pushString(T, t.teamName),
    faction: (T, t) => pushString(T, t.faction),
    controller: (T, t) => pushString(T, t.controller),
    is_local: (T) => lua.lua_pushboolean(T, true),
    carryover_bonus: (T, t) => lua.lua_pushnumber(T, t.carryoverBonus),
    carryover_percentage: (T, t) => lua.lua_pushinteger(T, t.carryoverPercentage),
    carryover_gold: (T, t) => lua.lua_pushinteger(T, t.carryoverGold),
    carryover_add: (T, t) => lua.lua_pushboolean(T, t.carryoverAdd),
    lost: (T, t) => lua.lua_pushboolean(T, t.lost),
    persistent: (T, t) => lua.lua_pushboolean(T, t.persistent),
    share_maps: (T, t) => lua.lua_pushboolean(T, t.shareMaps()),
    share_view: (T, t) => lua.lua_pushboolean(T, t.shareView()),
    side_name: (T, t) => k.pushTString(T, TString.literal(t.sideName)),
    recruit: (T, t) => pushStringArray(T, [...t.canRecruit].sort()),
    variables: (T) => {
      lua.lua_createtable(T, 1, 0);
      lua.lua_pushvalue(T, 1);
      lua.lua_rawseti(T, -2, 1);
      lauxlib.luaL_setmetatable(T, to_luastring(SIDE_VARIABLES_KEY));
    },
    starting_location: (T, t) => {
      const loc = board().map.startingPosition(t.side);
      if (loc.valid()) k.pushLocation(T, loc);
      else lua.lua_pushnil(T);
    },
    num_units: (T, t) => lua.lua_pushinteger(T, board().unitsForSide(t.side).length),
    __cfg: (T, t) => {
      // `team::write`, as far as this port's Team carries it.
      const cfg = new WmlConfig();
      cfg.setAttribute('side', t.side);
      cfg.setAttribute('gold', t.gold);
      cfg.setAttribute('income', t.income);
      cfg.setAttribute('team_name', t.teamName);
      cfg.setAttribute('user_team_name', t.userTeamName);
      cfg.setAttribute('save_id', t.saveId);
      cfg.setAttribute('controller', t.controller);
      cfg.setAttribute('recruit', [...t.canRecruit].sort().join(','));
      cfg.setAttribute('village_gold', t.incomePerVillage);
      cfg.setAttribute('recall_cost', t.recallCost);
      for (const ai of options.sideAiConfigs?.(t.side) ?? []) cfg.addChild('ai', ai);
      k.pushConfig(T, cfg);
    },
  };
  const setters: Record<string, (T: LuaState, t: Team) => void> = {
    gold: (T, t) => (t.gold = checkInteger(T, 3)),
    village_gold: (T, t) => (t.incomePerVillage = checkInteger(T, 3)),
    village_support: (T, t) => (t.supportPerVillage = checkInteger(T, 3)),
    recall_cost: (T, t) => (t.recallCost = checkInteger(T, 3)),
    base_income: (T, t) => (t.income = checkInteger(T, 3)),
    hidden: (T, t) => (t.hidden = toBoolean(T, 3)),
    team_name: (T, t) => (t.teamName = checkString(T, 3)),
    lost: (T, t) => (t.lost = toBoolean(T, 3)),
    recruit: (T, t) => {
      const list = lua.lua_isstring(T, 3) ? checkString(T, 3).split(',').map((s) => s.trim()).filter(Boolean) : tableStrings(T, 3);
      t.canRecruit = new Set(list);
    },
  };

  lauxlib.luaL_newmetatable(L, to_luastring(SIDE_KEY));
  setFuncs(L, {
    __index: (T) => {
      const team = teamAt(T, 1);
      const key = checkString(T, 2);
      const get = getters[key];
      if (get) {
        get(T, team);
        return 1;
      }
      lua.lua_getglobal(T, to_luastring('wesnoth'));
      lua.lua_getfield(T, -1, to_luastring('sides'));
      lua.lua_getfield(T, -1, to_luastring(key));
      if (!lua.lua_isnil(T, -1)) return 1;
      return argError(T, 2, `invalid property of side: ${key}`);
    },
    __newindex: (T) => {
      const team = teamAt(T, 1);
      const key = checkString(T, 2);
      const set = setters[key];
      if (!set) return argError(T, 2, `invalid modifiable property of side: ${key}`);
      set(T, team);
      return 0;
    },
    __eq: (T) => {
      lua.lua_pushboolean(T, k.userdata<number>(T, 1, SIDE_KEY) === k.userdata<number>(T, 2, SIDE_KEY));
      return 1;
    },
    __tostring: (T) => {
      const team = teamAt(T, 1);
      pushString(T, `side: <${team.side}>`);
      return 1;
    },
    __dir: (T) => {
      pushStringArray(T, Object.keys(getters));
      return 1;
    },
  });
  pushString(L, SIDE_KEY);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_pop(L, 1);

  lauxlib.luaL_newmetatable(L, to_luastring(SIDE_VARIABLES_KEY));
  const owner = (T: LuaState): Team => {
    lua.lua_rawgeti(T, 1, 1);
    const t = teamAt(T, -1);
    lua.lua_pop(T, 1);
    return t;
  };
  setFuncs(L, {
    __index: (T) => {
      const team = owner(T);
      const name = checkString(T, 2);
      const vars = team.variables ?? new WmlConfig();
      if (vars.hasAttribute(name)) k.pushScalar(T, vars.getRaw(name));
      else {
        const child = vars.child(name);
        if (!child) return 0;
        k.pushConfig(T, child);
      }
      return 1;
    },
    __newindex: (T) => {
      const team = owner(T);
      const name = checkString(T, 2);
      if (!team.variables) team.variables = new WmlConfig();
      const scalar = k.toScalar(T, 3);
      if (scalar !== undefined) team.variables.setAttribute(name, scalar);
      else {
        team.variables.removeChildren(name);
        if (!lua.lua_isnoneornil(T, 3)) team.variables.addChild(name, k.checkConfig(T, 3));
      }
      return 0;
    },
  });
  pushString(L, SIDE_VARIABLES_KEY);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_pop(L, 1);

  const sideNumber = (T: LuaState, idx: number): number => {
    const side = k.userdata<number>(T, idx, SIDE_KEY);
    return side ?? checkInteger(T, idx);
  };
  k.defineAll(['wesnoth', 'sides'], {
    get: (T) => {
      const team = board().getTeam(checkInteger(T, 1));
      if (!team) return 0;
      pushTeam(T, team);
      return 1;
    },
    find: (T) => {
      const filter = k.checkConfig(T, 1);
      const empty = filter.attributeNames().length === 0 && filter.allChildren().length === 0;
      const sides = empty ? board().teams().map((t) => t.side) : findSides(board(), filter);
      lua.lua_createtable(T, sides.length, 0);
      sides.forEach((s, i) => {
        pushTeam(T, board().getTeam(s)!);
        lua.lua_rawseti(T, -2, i + 1);
      });
      return 1;
    },
    matches: (T) => {
      const team = board().getTeam(sideNumber(T, 1));
      if (!team) return argError(T, 1, 'invalid side');
      lua.lua_pushboolean(T, sideMatchesFilter(board(), k.checkConfig(T, 2), team));
      return 1;
    },
    is_enemy: (T) => {
      const a = board().getTeam(sideNumber(T, 1));
      const b = board().getTeam(sideNumber(T, 2));
      if (!a || !b) return 0;
      lua.lua_pushboolean(T, a.isEnemy(b));
      return 1;
    },
    is_fogged: (T) => {
      const side = sideNumber(T, 1);
      lua.lua_pushboolean(T, board().isFogged(side, k.checkLocation(T, 2)));
      return 1;
    },
    is_shrouded: (T) => {
      const side = sideNumber(T, 1);
      lua.lua_pushboolean(T, board().isShrouded(side, k.checkLocation(T, 2)));
      return 1;
    },
  });
  for (const name of ['set_id', 'append_ai', 'debug_ai', 'switch_ai', 'create', 'place_shroud', 'remove_shroud', 'override_shroud', 'place_fog', 'remove_fog']) {
    k.unported(['wesnoth', 'sides', name]);
  }
}

function tableStrings(T: LuaState, idx: number): string[] {
  const out: string[] = [];
  for (let i = 1, n = lauxlib.luaL_len(T, idx); i <= n; i++) {
    lua.lua_geti(T, idx, i);
    out.push(checkString(T, -1));
    lua.lua_pop(T, 1);
  }
  return out;
}

// --- unit types (lua_unit_type.cpp) ---

function installUnitTypes(k: LuaKernel, host: GameKernelHost, units: LuaUnits): void {
  const L = k.L;
  const resolve = (id: string): UnitType | undefined => {
    try {
      return host.ctx().resolveType(id);
    } catch {
      return undefined;
    }
  };
  const typeAt = (T: LuaState, idx: number): UnitType | undefined => k.userdata<UnitType>(T, idx, UNIT_TYPE_KEY);
  units.unitTypeOf = (T, idx) => typeAt(T, idx)?.attacks;
  const getters: Record<string, (T: LuaState, t: UnitType) => void> = {
    name: (T, t) => k.pushTString(T, TString.literal(t.name)),
    id: (T, t) => pushString(T, t.id),
    alignment: (T, t) => pushString(T, t.alignment),
    race: (T, t) => pushString(T, t.raceId),
    max_hitpoints: (T, t) => lua.lua_pushinteger(T, t.hitpoints),
    max_moves: (T, t) => lua.lua_pushinteger(T, t.movement),
    max_experience: (T, t) => lua.lua_pushinteger(T, t.experienceNeededBase),
    cost: (T, t) => lua.lua_pushinteger(T, t.cost),
    level: (T, t) => lua.lua_pushinteger(T, t.level),
    recall_cost: (T, t) => lua.lua_pushinteger(T, t.recallCost),
    advances_to: (T, t) => pushStringArray(T, t.advancesTo),
    usage: (T, t) => pushString(T, t.usage),
    abilities: (T, t) => pushStringArray(T, t.abilities.map((a) => a.config.getString('id')).filter((id) => id !== '')),
    attacks: (T) => {
      lua.lua_createtable(T, 1, 0);
      lua.lua_pushvalue(T, 1);
      lua.lua_rawseti(T, -2, 0);
      lauxlib.luaL_setmetatable(T, to_luastring('unit attacks table'));
    },
    __cfg: (T, t) => {
      const cfg = host.ctx().unitTypeConfig?.(t.id);
      if (cfg) k.pushConfig(T, cfg);
      else lua.lua_pushnil(T);
    },
  };
  lauxlib.luaL_newmetatable(L, to_luastring(UNIT_TYPE_KEY));
  setFuncs(L, {
    __index: (T) => {
      const t = typeAt(T, 1);
      if (!t) return typeError(T, 1, 'unit type');
      const key = checkString(T, 2);
      const get = getters[key];
      if (!get) return argError(T, 2, `invalid property of unit type: ${key}`);
      get(T, t);
      return 1;
    },
    __eq: (T) => {
      lua.lua_pushboolean(T, typeAt(T, 1) === typeAt(T, 2));
      return 1;
    },
    __tostring: (T) => {
      pushString(T, `unit type: <${typeAt(T, 1)?.id ?? ''}>`);
      return 1;
    },
  });
  pushString(L, UNIT_TYPE_KEY);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_pop(L, 1);
  pushTableProxy(k, ['wesnoth'], 'unit_types', 'unit types', (T) => {
    const t = resolve(checkString(T, 2));
    if (!t) return 0;
    k.pushUserdata(T, UNIT_TYPE_KEY, t);
    return 1;
  });
}

// --- races (lua_race.cpp) ---

const RACE_KEY = 'race';

/**
 * `wesnoth.races`: a `race` userdata per `[race]` id (`luaW_pushracetable`), read-only. Upstream fills a plain
 * table; here it is computed on lookup, so `pairs` over it sees nothing. `traits` lists the race's own
 * `[trait]`s (the global ones are not in the snapshot); the name generators are not ported.
 */
function installRaces(k: LuaKernel, host: GameKernelHost): void {
  const L = k.L;
  const raceAt = (T: LuaState, idx: number): WmlConfig => {
    const id = k.userdata<string>(T, idx, RACE_KEY);
    const cfg = id === undefined ? undefined : host.ctx().raceConfigs?.().get(id);
    if (!cfg) return typeError(T, idx, 'race');
    return cfg;
  };
  const getters: Record<string, (T: LuaState, cfg: WmlConfig) => void> = {
    id: (T, c) => pushString(T, c.getString('id')),
    name: (T, c) => k.pushScalar(T, c.getRaw('name') ?? c.getRaw('male_name') ?? ''),
    male_name: (T, c) => k.pushScalar(T, c.getRaw('male_name') ?? c.getRaw('name') ?? ''),
    female_name: (T, c) => k.pushScalar(T, c.getRaw('female_name') ?? c.getRaw('name') ?? ''),
    plural_name: (T, c) => k.pushScalar(T, c.getRaw('plural_name') ?? ''),
    description: (T, c) => k.pushScalar(T, c.getRaw('description') ?? ''),
    num_traits: (T, c) => lua.lua_pushinteger(T, c.getNumber('num_traits', 0)),
    ignore_global_traits: (T, c) => lua.lua_pushboolean(T, c.getBoolean('ignore_global_traits', false)),
    undead_variation: (T, c) => pushString(T, c.getString('undead_variation', '')),
    __cfg: (T, c) => k.pushConfig(T, c),
    traits: (T, c) => {
      lua.lua_newtable(T);
      for (const trait of c.children('trait')) {
        pushString(T, trait.getString('id'));
        k.pushConfig(T, trait);
        lua.lua_rawset(T, -3);
      }
    },
  };
  lauxlib.luaL_newmetatable(L, to_luastring(RACE_KEY));
  setFuncs(L, {
    __index: (T) => {
      const cfg = raceAt(T, 1);
      const key = checkString(T, 2);
      const get = getters[key];
      if (!get) return 0;
      get(T, cfg);
      return 1;
    },
    __tostring: (T) => {
      pushString(T, `race: <${raceAt(T, 1).getString('id')}>`);
      return 1;
    },
  });
  pushString(L, RACE_KEY);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_pop(L, 1);
  pushTableProxy(k, ['wesnoth'], 'races', 'races', (T) => {
    const id = checkString(T, 2);
    if (!host.ctx().raceConfigs?.().has(id)) return 0;
    k.pushUserdata(T, RACE_KEY, id);
    return 1;
  });
}
