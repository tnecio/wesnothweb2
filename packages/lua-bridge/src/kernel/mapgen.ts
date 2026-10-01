/**
 * C1: the map generator's Lua kernel (`src/scripting/mapgen_lua_kernel.cpp`, `generators/lua_map_generator.cpp`),
 * for scenarios with `map_generation=lua` (Heir to the Throne's and Sceptre of Fire's caves). Upstream builds a
 * base kernel named `Mapgen Lua Kernel`, replaces `mathx.random` with one drawing from its own `mt19937`, adds
 * the generator's `wesnoth.paths.find_path` (positional, with a cost function), loads `data/lua/core`, then runs
 * the `[generator]`'s `create_map` code with the generator config as `...` and takes the map string it returns.
 *
 * Only what the mainline generators call is here (`cave_map_generator.lua`, `mapgen_helper.lua`); the rest of
 * upstream's mapgen API (`wesnoth.map.create`, terrain filters, height maps) is not.
 */
import type { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import { MtRng } from '@wesnothweb2/engine/src/rng/MtRng.js';
import { RngDeterministic } from '@wesnothweb2/engine/src/rng/RngDeterministic.js';
import { aStarSearch, type CostCalculator } from '@wesnothweb2/engine/src/pathfind/astar.js';
import { LuaKernel, lua, lauxlib, to_luastring, type KernelLog, type LuaState, type VirtualDataDir } from './kernel.js';
import { BASE_GAME_CONFIG, installBase, installPackage, installStrictMode, loadCore } from './base.js';
import { installMathx, installStringx } from './stringx.js';

/**
 * `lua_map_generator::create_map(seed)`: runs `code` (the `[generator]`'s `create_map=`) with `generator` as its
 * argument in a fresh map generator kernel whose random numbers start from `seed`; returns the map data.
 */
export function generateLuaMap(files: VirtualDataDir, code: string, generator: WmlConfig, seed: number, log: KernelLog): string {
  const k = new LuaKernel(files, log, 'Mapgen Lua Kernel');
  // `create_map(prog, generator, seed)`: `default_rng_ = std::mt19937(get_random_seed())`, the seed as given.
  const mt = new MtRng(seed >>> 0);
  installStringx(k);
  installMathx(k, () => new RngDeterministic(mt));
  installBase(k, () => BASE_GAME_CONFIG);
  installPackage(k);
  installStrictMode(k);

  // `intf_random`: [0, 1) without arguments, else an integer in [min, max] (`min + rng() % (max - min + 1)`).
  k.define(['mathx', 'random'], (T: LuaState) => {
    if (lua.lua_isnoneornil(T, 1)) {
      lua.lua_pushnumber(T, mt.getNextRandom() / 4294967296);
      return 1;
    }
    let min: number;
    let max: number;
    if (lua.lua_isnumber(T, 2)) {
      min = Number(lauxlib.luaL_checkinteger(T, 1));
      max = Number(lauxlib.luaL_checkinteger(T, 2));
    } else {
      min = 1;
      max = Number(lauxlib.luaL_checkinteger(T, 1));
    }
    if (min > max) return lauxlib.luaL_argerror(T, 1, to_luastring('min > max'));
    lua.lua_pushinteger(T, min + ((mt.getNextRandom() >>> 0) % (max - min + 1)));
    return 1;
  });

  // The generator's `intf_find_path(x1, y1, x2, y2, calculate, width, height[, include_borders])`, or with a
  // table `{calculate=, width=, height=, include_borders=}`. Two numbers make a location, as
  // `luaW_checklocation` reads them, so the cost function follows the four coordinates.
  k.define(['wesnoth', 'paths', 'find_path'], (T: LuaState) => {
    const loc = (i: number): Location =>
      lua.lua_type(T, i) === lua.LUA_TNUMBER ? Location.fromWml(Number(lua.lua_tointeger(T, i)), Number(lua.lua_tointeger(T, i + 1))) : k.checkLocation(T, i);
    const twoNumbers = lua.lua_type(T, 1) === lua.LUA_TNUMBER;
    const src = loc(1);
    const dstIdx = twoNumbers ? 3 : 2;
    const dst = loc(dstIdx);
    let arg = dstIdx + (lua.lua_type(T, dstIdx) === lua.LUA_TNUMBER ? 2 : 1);
    let fnIndex: number;
    let width: number;
    let height: number;
    let border = false;
    if (lua.lua_istable(T, arg)) {
      lua.lua_getfield(T, arg, to_luastring('calculate'));
      if (!lua.lua_isfunction(T, -1)) return lauxlib.luaL_argerror(T, arg, to_luastring('missing key: calculate'));
      fnIndex = lua.lua_gettop(T);
      lua.lua_getfield(T, arg, to_luastring('width'));
      width = Number(lauxlib.luaL_checkinteger(T, -1));
      lua.lua_getfield(T, arg, to_luastring('height'));
      height = Number(lauxlib.luaL_checkinteger(T, -1));
      lua.lua_getfield(T, arg, to_luastring('include_borders'));
      border = lua.lua_toboolean(T, -1);
    } else {
      fnIndex = arg;
      width = Number(lauxlib.luaL_checkinteger(T, arg + 1));
      height = Number(lauxlib.luaL_checkinteger(T, arg + 2));
      if (lua.lua_isboolean(T, arg + 3)) border = lua.lua_toboolean(T, arg + 3);
      arg += 3;
    }
    // `lua_pathfind_cost_calculator`: the Lua function's cost, at least 1 (an error counts as 1).
    const calc: CostCalculator = {
      cost: (at: Location, soFar: number): number => {
        lua.lua_pushvalue(T, fnIndex);
        lua.lua_pushinteger(T, at.wmlX);
        lua.lua_pushinteger(T, at.wmlY);
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
    const res = aStarSearch(src, dst, 10000, calc, width, height, border ? 1 : 0);
    lua.lua_createtable(T, res.steps.length, 0);
    res.steps.forEach((step, i) => {
      k.pushLocation(T, step);
      lua.lua_rawseti(T, -2, i + 1);
    });
    lua.lua_pushinteger(T, Math.trunc(res.moveCost));
    return 2;
  });

  // Upstream API this kernel has that the mainline generators never call: stubs that raise if called, so
  // `core/` can wrap them as it loads (`gui` is every kernel's, `lua_kernel_base`; the map functions are
  // the generator kernel's own).
  for (const name of ['show_menu', 'show_narration', 'show_popup', 'show_story', 'show_prompt', 'show_lua_console', 'add_widget_definition']) {
    k.unported(['gui', name]);
  }
  for (const name of ['filter', 'create', 'generate_height_map', 'generate', 'find', 'find_in_radius']) k.unported(['wesnoth', 'map', name]);
  for (const name of ['tovconfig', 'get_variable', 'get_all_vars']) k.unported(['wml', name]);
  loadCore(k);

  // `run_generator`: the code, called with the generator's config.
  const L = k.L;
  if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring('=create_map')) !== lua.LUA_OK) {
    throw new Error(`create_map: ${lua.lua_tojsstring(L, -1)}`);
  }
  k.pushConfig(L, generator);
  if (lua.lua_pcall(L, 1, 1, 0) !== lua.LUA_OK) throw new Error(`create_map: ${lua.lua_tojsstring(L, -1)}`);
  if (!lua.lua_isstring(L, -1)) throw new Error(`create_map: expected a string, found a ${lua.lua_typename(L, lua.lua_type(L, -1))}`);
  const map = lua.lua_tojsstring(L, -1);
  lua.lua_pop(L, 1);
  return map;
}
