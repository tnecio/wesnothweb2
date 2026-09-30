/**
 * `lua_kernel_base`'s own API (`lua_kernel_base.cpp`): the sandboxed standard library, `print`/`load`, the
 * basic `wesnoth.*` functions, `filesystem` over the virtual data directory (`lua_fileops.cpp`), the `wml`
 * module's C++ half (`lua_wml.cpp`), `wesnoth.map`'s location operations (`lua_map_location_ops.cpp`),
 * `wesnoth.game_config`, and finally `data/lua/package.lua` for `wesnoth.require`.
 */
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { parseConfig } from '@wesnothweb2/engine/src/wml/parser.js';
import { writeWml } from '@wesnothweb2/engine/src/wml/writer.js';
import { TString } from '@wesnothweb2/engine/src/i18n/tstring.js';
import { dsngettext } from '@wesnothweb2/engine/src/i18n/gettext.js';
import { VariableStore, varNodeFromConfig } from '@wesnothweb2/engine/src/events/variables.js';
import {
  Direction,
  Location,
  distanceBetween,
  getAdjacentTiles,
  parseDirection,
  relativeDirection,
  tilesAdjacent,
  writeDirection,
} from '@wesnothweb2/engine/src/model/Location.js';
import {
  GETTEXT_KEY,
  TSTRING_KEY,
  argError,
  checkInteger,
  checkString,
  checkStringArray,
  lauxlib,
  lua,
  luaError,
  optString,
  pushString,
  pushStringArray,
  tableGet,
  to_luastring,
  toBoolean,
  typeError,
  type LuaCFunction,
  type LuaKernel,
  type LuaState,
} from './kernel.js';

/** The game's own settings that Lua reads through `wesnoth.game_config` (`game_config.hpp`). */
export interface GameConfigValues {
  readonly [key: string]: number | string | boolean | undefined;
}

/** `game_config` defaults (`game_config.cpp`, `data/game_config.cfg`) the base kernel exposes. */
export const BASE_GAME_CONFIG: GameConfigValues = {
  base_income: 2,
  village_income: 1,
  village_support: 1,
  poison_amount: 8,
  rest_heal_amount: 2,
  recall_cost: 20,
  kill_experience: 8,
  combat_experience: 1,
  debug: false,
  debug_lua: false,
  strict_lua: false,
  mp_debug: false,
};

const startTime = Date.now();

export function installBase(k: LuaKernel, gameConfig: () => GameConfigValues): void {
  const L = k.L;

  // The sandbox: os keeps only clock/date/time/difftime; no dofile, loadfile or loadstring.
  lua.lua_getglobal(L, to_luastring('os'));
  for (const name of ['execute', 'exit', 'getenv', 'remove', 'rename', 'setlocale', 'tmpname']) {
    lua.lua_pushnil(L);
    lua.lua_setfield(L, -2, to_luastring(name));
  }
  lua.lua_pop(L, 1);
  for (const name of ['dofile', 'loadfile', 'loadstring', 'io', 'package', 'require', 'js']) {
    lua.lua_pushnil(L);
    lua.lua_setglobal(L, to_luastring(name));
  }

  // print goes to the kernel's log, as upstream's goes to the Lua console.
  lua.lua_getglobal(L, to_luastring('print'));
  lua.lua_setglobal(L, to_luastring('std_print'));
  lua.lua_pushcfunction(L, (T: LuaState) => {
    const n = lua.lua_gettop(T);
    const parts: string[] = [];
    for (let i = 1; i <= n; i++) {
      lua.lua_getglobal(T, to_luastring('tostring'));
      lua.lua_pushvalue(T, i);
      lua.lua_call(T, 1, 1);
      parts.push(lua.lua_isstring(T, -1) ? lua.lua_tojsstring(T, -1) : '');
      lua.lua_pop(T, 1);
    }
    k.log('debug', parts.join('\t'));
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('print'));

  // load: text chunks only (binary chunks are refused upstream, CVE-2018-1999023).
  lua.lua_pushcfunction(L, (T: LuaState) => {
    const chunk = checkString(T, 1);
    const name = optString(T, 2, chunk);
    const mode = optString(T, 3, 't');
    const overrideEnv = !lua.lua_isnone(T, 4);
    if (mode !== 't') return argError(T, 3, 'binary chunks are not allowed for security reasons');
    if (lauxlib.luaL_loadbufferx(T, to_luastring(chunk), null, to_luastring(name), to_luastring('t')) !== lua.LUA_OK) {
      lua.lua_pushnil(T);
      lua.lua_insert(T, -2);
      return 2;
    }
    if (overrideEnv) {
      lua.lua_pushvalue(T, 4);
      if (lua.lua_setupvalue(T, -2, 1) === null) lua.lua_pop(T, 1);
    }
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('load'));

  // The gettext and translatable string metatables.
  lauxlib.luaL_newmetatable(L, to_luastring(GETTEXT_KEY));
  setFuncs(L, {
    __call: (T) => {
      const msgid = checkString(T, 2);
      const domain = k.userdata<string>(T, 1, GETTEXT_KEY) ?? '';
      if (lua.lua_isstring(T, 3)) {
        const plural = checkString(T, 3);
        const count = checkInteger(T, 4);
        // A plural translatable string: this port's TString has no plural form, so it is translated now.
        k.pushTString(T, TString.literal(dsngettext(domain, msgid, plural, count)));
      } else k.pushTString(T, TString.translatable(domain, msgid));
      return 1;
    },
    __tostring: (T) => {
      pushString(T, `textdomain: ${k.userdata<string>(T, 1, GETTEXT_KEY) ?? ''}`);
      return 1;
    },
  });
  pushString(L, 'message domain');
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_pop(L, 1);

  lauxlib.luaL_newmetatable(L, to_luastring(TSTRING_KEY));
  const tstringPart = (T: LuaState, idx: number): TString => {
    switch (lua.lua_type(T, idx)) {
      case lua.LUA_TNUMBER:
      case lua.LUA_TSTRING:
        return TString.literal(k.stringAt(T, idx));
      default: {
        const t = k.tstringAt(T, idx);
        if (!t) typeError(T, idx, 'string');
        return t!;
      }
    }
  };
  setFuncs(L, {
    __concat: (T) => {
      k.pushTString(T, tstringPart(T, 1).concat(tstringPart(T, 2)));
      return 1;
    },
    __tostring: (T) => {
      pushString(T, k.tstringAt(T, 1)?.str() ?? '');
      return 1;
    },
    __len: (T) => {
      lua.lua_pushnumber(T, k.tstringAt(T, 1)?.str().length ?? 0);
      return 1;
    },
    __lt: (T) => {
      lua.lua_pushboolean(T, compareTranslated(checkTStringUdata(k, T, 1), checkTStringUdata(k, T, 2)) < 0);
      return 1;
    },
    __le: (T) => {
      lua.lua_pushboolean(T, compareTranslated(checkTStringUdata(k, T, 1), checkTStringUdata(k, T, 2)) < 1);
      return 1;
    },
    __eq: (T) => {
      lua.lua_pushboolean(T, (k.tstringAt(T, 1)?.str() ?? '') === (k.tstringAt(T, 2)?.str() ?? ''));
      return 1;
    },
  });
  // `s:format(...)` and `s:vformat{...}` on a translatable string (stringx is installed first).
  lua.lua_createtable(L, 0, 2);
  lua.lua_getglobal(L, to_luastring('string'));
  lua.lua_getfield(L, -1, to_luastring('format'));
  lua.lua_setfield(L, -3, to_luastring('format'));
  lua.lua_pop(L, 1);
  lua.lua_getglobal(L, to_luastring('stringx'));
  lua.lua_getfield(L, -1, to_luastring('vformat'));
  lua.lua_setfield(L, -3, to_luastring('vformat'));
  lua.lua_pop(L, 1);
  lua.lua_setfield(L, -2, to_luastring('__index'));
  pushString(L, TSTRING_KEY);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_pop(L, 1);

  // The basic wesnoth API.
  k.defineAll(['wesnoth'], {
    deprecated_message: (T) => {
      const elem = checkString(T, 1);
      const level = checkInteger(T, 2);
      const version = lua.lua_isnoneornil(T, 3) ? '' : checkString(T, 3);
      const detail = k.checkTString(T, 4).str();
      const message = deprecatedMessage(elem, level, version, detail);
      if (level < 1 || level >= 4) {
        pushString(T, message);
        return lua.lua_error(T);
      }
      warnOnce(k, message);
      return 0;
    },
    textdomain: (T) => {
      k.pushUserdata(T, GETTEXT_KEY, checkString(T, 1));
      return 1;
    },
    dofile: (T) => {
      checkString(T, 1);
      lua.lua_rotate(T, 1, -1);
      loadFile(k, T);
      lua.lua_rotate(T, 1, 1);
      lua.lua_call(T, lua.lua_gettop(T) - 1, lua.LUA_MULTRET);
      return lua.lua_gettop(T);
    },
    // Only used to load package.lua, which replaces it with the real wesnoth.require.
    require: (T) => {
      checkString(T, 1);
      lua.lua_settop(T, 1);
      lua.lua_getglobal(T, to_luastring('wesnoth'));
      lua.lua_getfield(T, -1, to_luastring('package'));
      lua.lua_pushvalue(T, 1);
      lua.lua_rawget(T, -2);
      if (!lua.lua_isnil(T, -1)) return 1;
      lua.lua_pop(T, 1);
      lua.lua_pushvalue(T, 1);
      loadFile(k, T);
      lua.lua_call(T, 0, 1);
      lua.lua_pushvalue(T, 1);
      lua.lua_pushvalue(T, -2);
      lua.lua_settable(T, 3);
      return 1;
    },
    kernel_type: (T) => {
      pushString(T, k.kernelType);
      return 1;
    },
    named_tuple: (T) => {
      if (!lua.lua_istable(T, 1)) return typeError(T, 1, 'table');
      const names = k.tupleNames(T, 2);
      const len = lauxlib.luaL_len(T, 1);
      k.pushNamedTuple(T, names);
      for (let i = 1; i <= Math.max(len, names.length); i++) {
        lua.lua_geti(T, 1, i);
        // The tuple's own __newindex rawsets an integer key, so rawseti is the same, without the metamethod call.
        lua.lua_rawseti(T, -2, i);
      }
      return 1;
    },
    log: (T) => {
      const hasLogger = lua.lua_isstring(T, 2);
      const logger = hasLogger ? checkString(T, 1) : '';
      const message = hasLogger ? checkString(T, 2) : checkString(T, 1);
      const level = logger === 'err' || logger === 'error' ? 'error' : logger === 'warn' || logger === 'wrn' || logger === 'warning' ? 'warn' : logger === 'debug' || logger === 'dbg' ? 'debug' : 'info';
      k.log(level, message);
      return 0;
    },
    ms_since_init: (T) => {
      lua.lua_pushinteger(T, Date.now() - startTime);
      return 1;
    },
    get_language: (T) => {
      pushString(T, 'en_US');
      return 1;
    },
  });
  for (const name of ['compile_formula', 'eval_formula', 'name_generator', 'version', 'current_version', 'print_attributes']) k.unported(['wesnoth', name]);

  k.pushTablePath(['wesnoth', 'package']);
  lua.lua_pop(L, 1);

  installFilesystem(k);
  installWml(k);
  installMapLocationOps(k);
  installGameConfig(k, gameConfig);
}

/** `lua_kernel_base::initialize`'s tail: `lua/package.lua` (the real `wesnoth.require`), then `ilua` strict mode. */
export function installPackage(k: LuaKernel): void {
  k.run(`wesnoth.require("lua/package.lua")`, '=package');
}

/** `ilua.set_strict()`: reading an undefined global is an error, as upstream runs all Lua. */
export function installStrictMode(k: LuaKernel): void {
  k.run(`local ilua = wesnoth.require("lua/ilua.lua"); ilua.set_strict(); ilua = nil`, '=ilua');
}

/** `lua_kernel_base::load_core`. */
export function loadCore(k: LuaKernel): void {
  k.run(`wesnoth.require("lua/core")`, '=core');
}

function setFuncs(L: LuaState, fns: Readonly<Record<string, LuaCFunction>>): void {
  for (const [name, fn] of Object.entries(fns)) {
    lua.lua_pushcfunction(L, fn);
    lua.lua_setfield(L, -2, to_luastring(name));
  }
}

function checkTStringUdata(k: LuaKernel, T: LuaState, idx: number): TString {
  lauxlib.luaL_checkudata(T, idx, to_luastring(TSTRING_KEY));
  return k.tstringAt(T, idx)!;
}

/** `translation::compare`: the locale's collation. */
function compareTranslated(a: TString, b: TString): number {
  return a.str().localeCompare(b.str());
}

const warned = new WeakMap<LuaKernel, Set<string>>();
function warnOnce(k: LuaKernel, message: string): void {
  let seen = warned.get(k);
  if (!seen) warned.set(k, (seen = new Set()));
  if (seen.has(message)) return;
  seen.add(message);
  k.log('warn', message);
}

/** `deprecated_message` (`deprecation.cpp`). */
function deprecatedMessage(elem: string, level: number, version: string, detail: string): string {
  let message: string;
  switch (level) {
    case 1:
      message = `${elem} has been deprecated indefinitely.`;
      break;
    case 2:
      message = version ? `${elem} has been deprecated and may be removed in version ${version}.` : `${elem} has been deprecated and may be removed at any time.`;
      break;
    case 3:
      message = `${elem} has been deprecated and will be removed in version ${version}.`;
      break;
    case 4:
      message = `${elem} has been deprecated and removed.`;
      break;
    default:
      return `Invalid deprecation level ${level} (should be 1-4)`;
  }
  return detail ? `${message}; ${detail}` : message;
}

// --- filesystem (lua_fileops.cpp) ---

/** `get_calling_file`: the directory of the Lua file that called, skipping package.lua itself. */
function callingDir(T: LuaState): string {
  const ar = new lua.lua_Debug();
  if (!lua.lua_getstack(T, 1, ar)) return '';
  lua.lua_getinfo(T, to_luastring('S'), ar);
  let source = ar.source ? String.fromCharCode(...ar.source) : '';
  if (!source.startsWith('@')) return '';
  let file = source.slice(1);
  for (let pos = 2; file === 'lua/package.lua'; pos++) {
    if (!lua.lua_getstack(T, pos, ar)) return '';
    lua.lua_getinfo(T, to_luastring('S'), ar);
    source = ar.source ? String.fromCharCode(...ar.source) : '';
    if (source.startsWith('@')) file = source.slice(1);
  }
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '' : file.slice(0, slash);
}

/** `canonical_path`: resolves `./`, `/./`, `//` and `/../`; undefined for an invalid path. */
export function canonicalPath(filename: string, currentDir: string): string | undefined {
  if (filename.length < 2) return undefined;
  if (filename.startsWith('./')) filename = currentDir + filename.slice(1);
  if (filename.includes('\\')) return undefined;
  while (filename.includes('/./')) filename = filename.replace('/./', '/');
  while (filename.includes('//')) filename = filename.replace('//', '/');
  for (;;) {
    const pos = filename.indexOf('/..');
    if (pos < 0) break;
    const pos2 = filename.lastIndexOf('/', pos - 1);
    if (pos2 < 0 || pos2 >= pos) return undefined;
    filename = filename.slice(0, pos2) + filename.slice(pos + 3);
  }
  if (filename.includes('..')) return undefined;
  return filename;
}

/** `filesystem::get_wml_location`: data-relative paths (a leading `/` or `~` is not supported here). */
function wmlLocation(k: LuaKernel, path: string): string | undefined {
  const rel = path.replace(/^\/+/, '');
  return k.isFile(rel) || k.isDirectory(rel) ? rel : undefined;
}

function resolveFilename(k: LuaKernel, filename: string, currentDir: string): string | undefined {
  const canonical = canonicalPath(filename, currentDir);
  return canonical === undefined ? undefined : wmlLocation(k, canonical);
}

/** `lua_fileops::load_file`: replaces the file name on top of the stack with its compiled chunk. */
function loadFile(k: LuaKernel, T: LuaState): void {
  const name = checkString(T, -1);
  const path = resolveFilename(k, name, callingDir(T));
  if (path === undefined || !k.isFile(path)) {
    argError(T, -1, 'file not found');
    return;
  }
  if (lauxlib.luaL_loadbufferx(T, to_luastring(k.files[path]!), null, to_luastring(`@${path}`), to_luastring('t')) !== lua.LUA_OK) {
    lua.lua_error(T);
    return;
  }
  lua.lua_remove(T, -2);
}

function installFilesystem(k: LuaKernel): void {
  k.defineAll(['filesystem'], {
    have_file: (T) => {
      const path = resolveFilename(k, checkString(T, 1), callingDir(T));
      if (path === undefined) lua.lua_pushboolean(T, false);
      else if (toBoolean(T, 2)) lua.lua_pushboolean(T, !k.isDirectory(path) || k.isFile(path));
      else lua.lua_pushboolean(T, true);
      return 1;
    },
    read_file: (T) => {
      const path = resolveFilename(k, checkString(T, 1), callingDir(T));
      if (path === undefined) return argError(T, -1, 'file not found');
      if (k.isFile(path)) {
        pushString(T, k.files[path]!);
        return 1;
      }
      const { files, dirs } = k.listDirectory(path);
      pushStringArray(T, [...dirs, ...files]);
      lua.lua_pushnumber(T, dirs.length);
      lua.lua_setfield(T, -2, to_luastring('ndirs'));
      return 1;
    },
    canonical_path: (T) => {
      const path = canonicalPath(checkString(T, 1), callingDir(T));
      if (path === undefined) return argError(T, 1, 'invalid path');
      pushString(T, path);
      return 1;
    },
  });
  for (const name of ['image_size', 'have_asset', 'resolve_asset']) k.unported(['filesystem', name]);
}

// --- wml (lua_wml.cpp) ---

function configsEqual(a: WmlConfig, b: WmlConfig): boolean {
  const an = a.attributeNames().sort();
  const bn = b.attributeNames().sort();
  if (an.join('\0') !== bn.join('\0')) return false;
  for (const key of an) {
    if (a.getString(key) !== b.getString(key)) return false;
  }
  const ac = a.allChildren();
  const bc = b.allChildren();
  if (ac.length !== bc.length) return false;
  return ac.every((c, i) => c.tag === bc[i]!.tag && configsEqual(c.config, bc[i]!.config));
}

function installWml(k: LuaKernel): void {
  k.defineAll(['wml'], {
    tostring: (T) => {
      pushString(T, writeWml(k.checkConfig(T, 1)));
      return 1;
    },
    parse: (T) => {
      k.pushConfig(T, parseConfig(checkString(T, 1)));
      return 1;
    },
    clone: (T) => {
      k.pushConfig(T, k.checkConfig(T, 1).clone());
      return 1;
    },
    interpolate: (T) => {
      const cfg = k.checkConfig(T, 1);
      const vars = new VariableStore(varNodeFromConfig(k.checkConfig(T, 2)));
      k.pushConfig(T, substituteConfig(cfg, vars));
      return 1;
    },
    equal: (T) => {
      lua.lua_pushboolean(T, configsEqual(k.checkConfig(T, 1), k.checkConfig(T, 2)));
      return 1;
    },
    valid: (T) => {
      lua.lua_pushboolean(T, k.toConfig(T, 1) !== undefined);
      return 1;
    },
  });
  for (const name of ['load', 'merge', 'diff', 'patch', 'matches_filter']) k.unported(['wml', name]);
}

/** `vconfig::get_parsed_config` over a variable set: every attribute `$`-substituted (no `[insert_tag]` yet). */
function substituteConfig(cfg: WmlConfig, vars: VariableStore): WmlConfig {
  const out = new WmlConfig();
  for (const key of cfg.attributeNames()) {
    const raw = cfg.getRaw(key)!;
    out.setAttribute(key, typeof raw === 'string' ? vars.substitute(raw) : raw);
  }
  for (const { tag, config } of cfg.allChildren()) out.addChild(tag, substituteConfig(config, vars));
  return out;
}

// --- wesnoth.map location operations (lua_map_location_ops.cpp) ---

/** `get_tile_ring`: from the south-west corner, walking each direction in turn. */
export function tileRing(center: Location, radius: number): Location[] {
  const out: Location[] = [];
  if (radius <= 0) return out;
  let loc = center.getDirection(Direction.SouthWest, radius);
  for (let n = 0; n < 6; n++) {
    for (let i = 0; i < radius; i++) {
      out.push(loc);
      loc = loc.getDirection(n as Direction, 1);
    }
  }
  return out;
}

/** `get_tiles_in_radius`: the rings 1..radius (not the centre). */
export function tilesInRadius(center: Location, radius: number): Location[] {
  const out: Location[] = [];
  for (let n = 1; n <= radius; n++) out.push(...tileRing(center, n));
  return out;
}

function installMapLocationOps(k: LuaKernel): void {
  const two = (T: LuaState, name: string): [Location, Location] => {
    const a = k.toLocation(T, 1);
    const b = a ? k.toLocation(T, 2) : undefined;
    if (!a || !b) luaError(T, `${name}: requires two locations`);
    return [a!, b!];
  };
  const one = (T: LuaState): Location => {
    const a = k.toLocation(T, 1);
    if (!a) argError(T, 1, 'expected a location');
    return a!;
  };
  k.defineAll(['wesnoth', 'map'], {
    get_direction: (T) => {
      const l = k.toLocation(T, 1);
      if (!l) return argError(T, 1, 'get_direction: first argument(S) must be a location');
      const nargs = lua.lua_gettop(T);
      if (nargs < 2) return luaError(T, 'get_direction: not missing direction argument');
      let n = 1;
      if (nargs === 3) {
        n = checkInteger(T, -1);
        lua.lua_pop(T, 1);
      }
      if (!lua.lua_isstring(T, -1)) return argError(T, -1, `get_direction: second argument should be a direction string, instead found a ${lua.lua_typename(T, lua.lua_type(T, -1))}`);
      const d = parseDirection(checkString(T, -1));
      lua.lua_pop(T, 1);
      k.pushLocation(T, l.getDirection(d, n));
      return 1;
    },
    hex_vector_sum: (T) => {
      const [a, b] = two(T, 'vector_sum');
      k.pushLocation(T, a.vectorSum(b));
      return 1;
    },
    hex_vector_diff: (T) => {
      const [a, b] = two(T, 'vector_diff');
      k.pushLocation(T, a.vectorDifference(b));
      return 1;
    },
    hex_vector_negation: (T) => {
      k.pushLocation(T, one(T).vectorNegation());
      return 1;
    },
    rotate_right_around_center: (T) => {
      const n = checkInteger(T, -1);
      lua.lua_pop(T, 1);
      const [loc, center] = two(T, 'rotate_right_around_center');
      k.pushLocation(T, loc.rotateRightAroundCenter(center, n));
      return 1;
    },
    are_hexes_adjacent: (T) => {
      const [a, b] = two(T, 'tiles_adjacent');
      lua.lua_pushboolean(T, tilesAdjacent(a, b));
      return 1;
    },
    get_adjacent_hexes: (T) => {
      for (const adj of getAdjacentTiles(one(T))) k.pushLocation(T, adj);
      return 6;
    },
    get_hexes_at_radius: (T) => {
      const center = one(T);
      k.pushLocationSet(T, tileRing(center, checkInteger(T, 2)));
      return 1;
    },
    get_hexes_in_radius: (T) => {
      const center = one(T);
      k.pushLocationSet(T, tilesInRadius(center, checkInteger(T, 2)));
      return 1;
    },
    distance_between: (T) => {
      const [a, b] = two(T, 'distance_between');
      lua.lua_pushinteger(T, distanceBetween(a, b));
      return 1;
    },
    get_cubic: (T) => {
      const h = one(T).toCubic();
      k.pushNamedTuple(T, ['q', 'r', 's']);
      [h.q + 1, h.r, h.s - 1].forEach((v, i) => {
        lua.lua_pushinteger(T, v);
        lua.lua_rawseti(T, -2, i + 1);
      });
      return 1;
    },
    from_cubic: (T) => {
      if (!lua.lua_istable(T, 1)) return argError(T, 1, 'expected cubic location');
      const get = (key: string): number | undefined => {
        if (!tableGet(T, 1, key)) return undefined;
        const v = checkInteger(T, -1);
        lua.lua_pop(T, 1);
        return v;
      };
      const q = get('q');
      const r = get('r');
      if (q === undefined || r === undefined) return argError(T, 1, 'expected cubic location');
      const s = get('s') ?? -q - r;
      if (q + r + s !== 0) return argError(T, 1, 'expected cubic location');
      k.pushLocation(T, Location.fromCubic({ q: q - 1, r, s: s + 1 }));
      return 1;
    },
    get_relative_dir: (T) => {
      const [a, b] = two(T, 'get_relative_dir');
      pushString(T, writeDirection(relativeDirection(a, b)));
      return 1;
    },
  });
  for (const name of ['parse_bitmap', 'make_bitmap']) k.unported(['wesnoth', 'map', name]);
}

// --- wesnoth.game_config ---

function installGameConfig(k: LuaKernel, values: () => GameConfigValues): void {
  const L = k.L;
  lua.lua_getglobal(L, to_luastring('wesnoth'));
  lua.lua_newuserdata(L, 0);
  lua.lua_createtable(L, 0, 4);
  setFuncs(L, {
    __index: (T) => {
      const key = checkString(T, 2);
      const v = values()[key];
      if (v === undefined) return argError(T, 2, `invalid property of game config: ${key}`);
      k.pushScalar(T, v);
      return 1;
    },
    __newindex: (T) => argError(T, 2, `invalid modifiable property of game config: ${checkString(T, 2)}`),
    __dir: (T) => {
      pushStringArray(T, Object.keys(values()));
      return 1;
    },
  });
  lua.lua_pushboolean(L, true);
  lua.lua_setfield(L, -2, to_luastring('__dir_tablelike'));
  pushString(L, 'game config');
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_setmetatable(L, -2);
  lua.lua_setfield(L, -2, to_luastring('game_config'));
  lua.lua_pop(L, 1);
}

export { parseDirection };
