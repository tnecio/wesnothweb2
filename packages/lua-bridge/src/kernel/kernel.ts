/**
 * Phase 29 S7: the Lua kernel, shaped like upstream's (`src/scripting/lua_kernel_base.cpp`,
 * `game_lua_kernel.cpp`). Upstream builds its Lua API in layers -- C++ primitives, then
 * `data/lua/package.lua` for `wesnoth.require`, then `data/lua/core/*.lua` (`load_core`) for the Lua halves of
 * `mathx`/`stringx`/`wml`/`wesnoth.map`/units -- and this does the same: the primitives are TS ports in this
 * directory, and the Lua files run unchanged.
 *
 * This file is the state and the value conversions every module shares, ported from `lua_common.cpp`:
 * translatable strings as `"translatable string"` userdata, named tuples, locations, and WML tables
 * (`luaW_pushconfig`/`luaW_toconfig`). The modules install themselves on a `LuaKernel`
 * (`base.ts`, `game/*.ts`, `ai/*.ts`).
 *
 * Anything upstream has that is not ported yet is installed as a function raising "not available in this
 * port yet" (`unported`), so loading the core files stays quiet and a gap shows up at the call.
 */
import { WmlConfig, type WmlStoredValue } from '@wesnothweb2/engine/src/wml/config.js';
import { TString } from '@wesnothweb2/engine/src/i18n/tstring.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import { to_jsstring } from 'fengari';
import { newLuaState, lua, lauxlib, to_luastring, type LuaState } from '../luaEnv.js';

export { lua, lauxlib, to_luastring, type LuaState };

export type LuaCFunction = (L: LuaState) => number;

/** Where the kernel's messages go (`lg::log_domain` scripting/lua, and the Lua console's `cmd_log_`). */
export type KernelLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/**
 * The data directory as Lua sees it (`filesystem::get_wml_location`): Lua sources by data-relative path
 * (`lua/core/mathx.lua`, `ai/lua/ai_helper.lua`, `campaigns/The_South_Guard/lua/popups.lua`). Directories are
 * implied by the paths.
 */
export type VirtualDataDir = Readonly<Record<string, string>>;

export const TSTRING_KEY = 'translatable string';
export const GETTEXT_KEY = 'gettext';
const NAMED_TUPLE_BASE = 'named tuple';

export class LuaKernel {
  readonly L: LuaState;
  private readonly dirs: Map<string, { dirs: Set<string>; files: Set<string> }>;

  constructor(
    readonly files: VirtualDataDir,
    readonly log: KernelLog,
    /** `lua_kernel_base::my_name()`: `Game Lua Kernel` for the game. */
    readonly kernelType = 'Game Lua Kernel',
  ) {
    this.L = newLuaState();
    this.dirs = buildDirIndex(files);
  }

  // --- the data directory ---

  isFile(path: string): boolean {
    return this.files[path] !== undefined;
  }

  isDirectory(path: string): boolean {
    return this.dirs.has(path);
  }

  /** `filesystem::get_files_in_dir`: file and subdirectory names, each sorted, as upstream's listing is. */
  listDirectory(path: string): { files: string[]; dirs: string[] } {
    const entry = this.dirs.get(path);
    return { files: [...(entry?.files ?? [])].sort(), dirs: [...(entry?.dirs ?? [])].sort() };
  }

  // --- registering functions ---

  /** Sets `path[0].path[1]...` to a C function, creating missing tables on the way. */
  define(path: readonly string[], fn: LuaCFunction): void {
    const L = this.L;
    this.pushTablePath(path.slice(0, -1));
    lua.lua_pushcfunction(L, fn);
    lua.lua_setfield(L, -2, to_luastring(path[path.length - 1]!));
    lua.lua_pop(L, 1);
  }

  /** Several functions on one table (`luaL_setfuncs`). */
  defineAll(table: readonly string[], fns: Readonly<Record<string, LuaCFunction>>): void {
    for (const [name, fn] of Object.entries(fns)) this.define([...table, name], fn);
  }

  /**
   * Upstream API this port does not have yet: a function that raises a Lua error naming it. Loading the
   * core files reads many of these (to wrap them as deprecated aliases), which must not fail.
   */
  unported(path: readonly string[]): void {
    const name = path.join('.');
    this.define(path, (T) => lauxlib.luaL_error(T, to_luastring(`${name} is not available in this port yet`)));
  }

  /** Pushes the table at `path` (globals first), creating any that are missing. */
  pushTablePath(path: readonly string[]): void {
    const L = this.L;
    lua.lua_pushglobaltable(L);
    for (const part of path) {
      lua.lua_getfield(L, -1, to_luastring(part));
      if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
        lua.lua_pop(L, 1);
        lua.lua_createtable(L, 0, 0);
        lua.lua_pushvalue(L, -1);
        lua.lua_setfield(L, -3, to_luastring(part));
      }
      lua.lua_remove(L, -2);
    }
  }

  /** Runs a chunk now, on the main state; a Lua error becomes a JS one. */
  run(source: string, chunkName: string, nresults = 0): void {
    const L = this.L;
    if (lauxlib.luaL_loadbuffer(L, to_luastring(source), null, to_luastring(chunkName)) !== lua.LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_pop(L, 1);
      throw new Error(message);
    }
    this.pcall(0, nresults);
  }

  /** `lua_pcall` with a traceback, throwing a JS error on failure. */
  pcall(nargs: number, nresults: number): void {
    const L = this.L;
    const base = lua.lua_gettop(L) - nargs;
    lua.lua_pushcfunction(L, traceback);
    lua.lua_insert(L, base);
    const status = lua.lua_pcall(L, nargs, nresults, base);
    lua.lua_remove(L, base);
    if (status !== lua.LUA_OK) {
      const message = lua.lua_isstring(L, -1) ? lua.lua_tojsstring(L, -1) : String(lua.lua_typename(L, lua.lua_type(L, -1)));
      lua.lua_pop(L, 1);
      throw new Error(message);
    }
  }

  // --- userdata ---

  /** A full userdata carrying `value`, with the metatable registered as `metatable`. */
  pushUserdata(T: LuaState, metatable: string, value: unknown): void {
    const data = lua.lua_newuserdata(T, 0) as { value?: unknown };
    data.value = value;
    lauxlib.luaL_setmetatable(T, to_luastring(metatable));
  }

  /** The value of a userdata with metatable `metatable` at `idx` (`luaL_testudata`), else undefined. */
  userdata<V>(T: LuaState, idx: number, metatable: string): V | undefined {
    const data = lauxlib.luaL_testudata(T, idx, to_luastring(metatable)) as { value?: V } | null;
    return data ? data.value : undefined;
  }

  // --- translatable strings (lua_common.cpp) ---

  pushTString(T: LuaState, value: TString): void {
    this.pushUserdata(T, TSTRING_KEY, value);
  }

  tstringAt(T: LuaState, idx: number): TString | undefined {
    return this.userdata<TString>(T, idx, TSTRING_KEY);
  }

  /** `luaW_totstring`: strings, numbers, booleans (`yes`/`no`) and translatable strings. */
  toTString(T: LuaState, idx: number): TString | undefined {
    switch (lua.lua_type(T, idx)) {
      case lua.LUA_TBOOLEAN:
        return TString.literal(lua.lua_toboolean(T, idx) ? 'yes' : 'no');
      case lua.LUA_TNUMBER:
      case lua.LUA_TSTRING:
        return TString.literal(this.stringAt(T, idx));
      case lua.LUA_TUSERDATA:
        return this.tstringAt(T, idx);
      default:
        return undefined;
    }
  }

  checkTString(T: LuaState, idx: number): TString {
    const value = this.toTString(T, idx);
    if (value === undefined) typeError(T, idx, 'translatable string');
    return value!;
  }

  /** `lua_tostring` on a string or number (numbers formatted as Lua does). */
  stringAt(T: LuaState, idx: number): string {
    if (lua.lua_type(T, idx) === lua.LUA_TNUMBER) {
      lauxlib.luaL_tolstring(T, idx);
      const s = lua.lua_tojsstring(T, -1);
      lua.lua_pop(T, 1);
      return s;
    }
    return lua.lua_tojsstring(T, idx);
  }

  /** `luaW_iststring`. */
  isTStringLike(T: LuaState, idx: number): boolean {
    return lua.lua_isstring(T, idx) || this.tstringAt(T, idx) !== undefined;
  }

  // --- named tuples ---

  /** `lua_named_tuple_builder::push`: an empty table with the tuple metatable for `names`. */
  pushNamedTuple(T: LuaState, names: readonly string[]): void {
    lua.lua_createtable(T, names.length, 0);
    const key = `${NAMED_TUPLE_BASE}(${names.join(', ')})`;
    if (lauxlib.luaL_newmetatable(T, to_luastring(key)) !== 0) {
      const set = (name: string, fn: LuaCFunction): void => {
        lua.lua_pushcfunction(T, fn);
        lua.lua_setfield(T, -2, to_luastring(name));
      };
      set('__index', namedTupleGet);
      set('__newindex', namedTupleSet);
      set('__dir', (U) => {
        lauxlib.luaL_getmetafield(U, 1, to_luastring('__names'));
        return 1;
      });
      set('__eq', namedTupleCompare);
      set('__tostring', namedTupleToString);
      lua.lua_pushstring(T, to_luastring(key));
      lua.lua_setfield(T, -2, to_luastring('__metatable'));
      pushStringArray(T, names);
      lua.lua_setfield(T, -2, to_luastring('__names'));
    }
    lua.lua_setmetatable(T, -2);
  }

  // --- locations ---

  /** `luaW_pushlocation`: a named tuple `(x, y)`, 1-based. */
  pushLocation(T: LuaState, loc: Location): void {
    this.pushNamedTuple(T, ['x', 'y']);
    lua.lua_pushinteger(T, loc.wmlX);
    lua.lua_rawseti(T, -2, 1);
    lua.lua_pushinteger(T, loc.wmlY);
    lua.lua_rawseti(T, -2, 2);
  }

  /**
   * `luaW_tolocation`: a table or userdata with `x`/`y` (or `[1]`/`[2]`), or two numbers -- in which case the
   * first number is removed from the stack, so the caller's later indices shift by one, exactly as upstream.
   */
  toLocation(T: LuaState, index: number): Location | undefined {
    if (lua.lua_isnoneornil(T, index)) return undefined;
    const idx = lua.lua_absindex(T, index);
    const type = lua.lua_type(T, idx);
    if (type === lua.LUA_TTABLE || type === lua.LUA_TUSERDATA) {
      const read = (field: string | number): number | undefined => {
        if (typeof field === 'string') lua.lua_getfield(T, idx, to_luastring(field));
        else lua.lua_rawgeti(T, idx, field);
        const v = lua.lua_isinteger(T, -1) || (lua.lua_type(T, -1) === lua.LUA_TNUMBER && Number.isInteger(lua.lua_tonumber(T, -1)))
          ? Number(lua.lua_tonumber(T, -1))
          : lua.lua_type(T, -1) === lua.LUA_TSTRING && /^\s*-?\d+\s*$/.test(lua.lua_tojsstring(T, -1)) ? Number(lua.lua_tojsstring(T, -1)) : undefined;
        lua.lua_pop(T, 1);
        return v;
      };
      let x = read('x');
      let y = read('y');
      if (x === undefined || y === undefined) {
        if (type === lua.LUA_TUSERDATA) return undefined;
        x = read(1);
        y = read(2);
      }
      return x !== undefined && y !== undefined ? Location.fromWml(x, y) : undefined;
    }
    if (lua.lua_isnumber(T, idx) && lua.lua_isnumber(T, idx + 1)) {
      const x = Number(lua.lua_tointeger(T, idx));
      lua.lua_remove(T, idx);
      const y = Number(lua.lua_tointeger(T, idx));
      return Location.fromWml(x, y);
    }
    return undefined;
  }

  checkLocation(T: LuaState, index: number): Location {
    const loc = this.toLocation(T, index);
    if (!loc) typeError(T, index, 'location');
    return loc!;
  }

  /** `luaW_push_locationset`. */
  pushLocationSet(T: LuaState, locs: Iterable<Location>): void {
    const list = [...locs];
    lua.lua_createtable(T, list.length, 0);
    list.forEach((loc, i) => {
      this.pushLocation(T, loc);
      lua.lua_rawseti(T, -2, i + 1);
    });
  }

  /** `luaW_check_locationset`. */
  checkLocationSet(T: LuaState, idx: number): Location[] {
    if (lua.lua_type(T, idx) !== lua.LUA_TTABLE) typeError(T, idx, 'array of locations');
    const out: Location[] = [];
    const n = lauxlib.luaL_len(T, idx);
    for (let i = 1; i <= n; i++) {
      lua.lua_geti(T, idx, i);
      out.push(this.checkLocation(T, -1));
      lua.lua_pop(T, 1);
    }
    return out;
  }

  // --- WML tables ---

  /** `luaW_pushscalar`. */
  pushScalar(T: LuaState, value: WmlStoredValue | undefined): void {
    if (value === undefined) lua.lua_pushnil(T);
    else if (value instanceof TString) this.pushTString(T, value);
    else if (typeof value === 'boolean') lua.lua_pushboolean(T, value);
    else if (typeof value === 'number') {
      if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) lua.lua_pushinteger(T, value);
      else lua.lua_pushnumber(T, value);
    } else lua.lua_pushstring(T, to_luastring(value));
  }

  /** `luaW_toscalar`: booleans, numbers, strings and translatable strings; undefined for anything else. */
  toScalar(T: LuaState, idx: number): WmlStoredValue | undefined {
    switch (lua.lua_type(T, idx)) {
      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(T, idx);
      case lua.LUA_TNUMBER:
        return lua.lua_isinteger(T, idx) ? Number(lua.lua_tointeger(T, idx)) : lua.lua_tonumber(T, idx);
      case lua.LUA_TSTRING:
        return lua.lua_tojsstring(T, idx);
      case lua.LUA_TUSERDATA:
        return this.tstringAt(T, idx);
      default:
        return undefined;
    }
  }

  /** `luaW_pushconfig`/`luaW_filltable`: attributes by name, children as `(tag, contents)` tuples in order. */
  pushConfig(T: LuaState, cfg: WmlConfig): void {
    lauxlib.luaL_checkstack(T, 8, null);
    const children = cfg.allChildren();
    lua.lua_createtable(T, children.length, cfg.attributeNames().length);
    children.forEach(({ tag, config }, i) => {
      this.pushNamedTuple(T, ['tag', 'contents']);
      lua.lua_pushstring(T, to_luastring(tag));
      lua.lua_rawseti(T, -2, 1);
      this.pushConfig(T, config);
      lua.lua_rawseti(T, -2, 2);
      lua.lua_rawseti(T, -2, i + 1);
    });
    for (const key of cfg.attributeNames()) {
      this.pushScalar(T, cfg.getRaw(key));
      lua.lua_setfield(T, -2, to_luastring(key));
    }
  }

  /**
   * `luaW_toconfig`: undefined for a value that is not a WML table (nil and none give an empty config). An
   * attribute holding an array of scalars becomes their comma-joined text, as upstream.
   */
  toConfig(T: LuaState, index: number): WmlConfig | undefined {
    const idx = lua.lua_absindex(T, index);
    const type = lua.lua_type(T, idx);
    if (type === lua.LUA_TNONE || type === lua.LUA_TNIL) return new WmlConfig();
    if (type === lua.LUA_TUSERDATA) return this.userdataToConfig?.(T, idx);
    if (type !== lua.LUA_TTABLE) return undefined;
    lauxlib.luaL_checkstack(T, 8, null);
    const top = lua.lua_gettop(T);
    const cfg = new WmlConfig();
    const fail = (): undefined => {
      lua.lua_settop(T, top);
      return undefined;
    };
    const length = lua.lua_rawlen(T, idx);
    for (let i = 1; i <= length; i++) {
      lua.lua_rawgeti(T, idx, i);
      if (lua.lua_type(T, -1) !== lua.LUA_TTABLE) return fail();
      lua.lua_rawgeti(T, -1, 1);
      if (lua.lua_type(T, -1) !== lua.LUA_TSTRING) return fail();
      const tag = lua.lua_tojsstring(T, -1);
      if (!validTag(tag)) return fail();
      lua.lua_rawgeti(T, -2, 2);
      const child = this.toConfig(T, -1);
      if (!child) return fail();
      cfg.addChild(tag, child);
      lua.lua_pop(T, 3);
    }
    lua.lua_pushnil(T);
    while (lua.lua_next(T, idx) !== 0) {
      const keyType = lua.lua_type(T, -2);
      if (keyType === lua.LUA_TNUMBER) {
        lua.lua_pop(T, 1);
        continue;
      }
      if (keyType !== lua.LUA_TSTRING) return fail();
      const key = lua.lua_tojsstring(T, -2);
      if (!validAttribute(key)) return fail();
      if (lua.lua_type(T, -1) === lua.LUA_TTABLE) {
        const sub = lua.lua_absindex(T, -1);
        const items: string[] = [];
        for (let i = 1, n = lua.lua_rawlen(T, sub); i <= n; i++) {
          lua.lua_rawgeti(T, sub, i);
          const item = this.toScalar(T, -1);
          if (item === undefined) return fail();
          items.push(scalarText(item));
          lua.lua_pop(T, 1);
        }
        lua.lua_pushnil(T);
        while (lua.lua_next(T, sub) !== 0) {
          if (lua.lua_type(T, -2) !== lua.LUA_TNUMBER) return fail();
          lua.lua_pop(T, 1);
        }
        cfg.setAttribute(key, items.join(','));
      } else {
        const value = this.toScalar(T, -1);
        if (value === undefined) return fail();
        cfg.setAttribute(key, value);
      }
      lua.lua_pop(T, 1);
    }
    lua.lua_settop(T, top);
    return cfg;
  }

  /** `luaW_checkconfig`. */
  checkConfig(T: LuaState, idx: number): WmlConfig {
    const cfg = this.toConfig(T, idx);
    if (!cfg) typeError(T, idx, 'WML table');
    return cfg!;
  }

  /** How a userdata becomes a config (a vconfig upstream); installed by a module that has such userdata. */
  userdataToConfig?: (T: LuaState, idx: number) => WmlConfig | undefined;
}

// --- helpers shared by the modules ---

/** `luaW_type_error`. */
export function typeError(T: LuaState, idx: number, expected: string): never {
  let actual: string;
  if (lauxlib.luaL_getmetafield(T, idx, to_luastring('__name')) === lua.LUA_TSTRING) actual = lua.lua_tojsstring(T, -1);
  else if (lua.lua_type(T, idx) === lua.LUA_TLIGHTUSERDATA) actual = 'light userdata';
  else actual = to_jsstring(lauxlib.luaL_typename(T, idx));
  return argError(T, idx, `${expected} expected, got ${actual}`);
}

export function argError(T: LuaState, idx: number, message: string): never {
  lauxlib.luaL_argerror(T, idx, to_luastring(message));
  throw new Error('unreachable');
}

export function luaError(T: LuaState, message: string): never {
  lauxlib.luaL_error(T, to_luastring(message));
  throw new Error('unreachable');
}

/** `luaL_checkstring` (a number is converted in place, as Lua does). */
export function checkString(T: LuaState, idx: number): string {
  lauxlib.luaL_checklstring(T, idx);
  return lua.lua_tojsstring(T, idx);
}

/** `luaL_optstring`. */
export function optString(T: LuaState, idx: number, fallback: string): string {
  return lua.lua_isnoneornil(T, idx) ? fallback : checkString(T, idx);
}

/** `luaL_checkinteger`. */
export function checkInteger(T: LuaState, idx: number): number {
  return Number(lauxlib.luaL_checkinteger(T, idx));
}

/** `luaL_optinteger`. */
export function optInteger(T: LuaState, idx: number, fallback: number): number {
  return lua.lua_isnoneornil(T, idx) ? fallback : checkInteger(T, idx);
}

export function pushString(T: LuaState, s: string): void {
  lua.lua_pushstring(T, to_luastring(s));
}

export function pushStringArray(T: LuaState, values: readonly string[]): void {
  lua.lua_createtable(T, values.length, 0);
  values.forEach((v, i) => {
    lua.lua_pushstring(T, to_luastring(v));
    lua.lua_rawseti(T, -2, i + 1);
  });
}

/** `lua_check<std::vector<std::string>>`. */
export function checkStringArray(T: LuaState, idx: number): string[] {
  if (lua.lua_type(T, idx) !== lua.LUA_TTABLE) typeError(T, idx, 'table');
  const out: string[] = [];
  const n = lauxlib.luaL_len(T, idx);
  for (let i = 1; i <= n; i++) {
    lua.lua_geti(T, idx, i);
    out.push(lauxlib.luaL_tolstring(T, -1) ? lua.lua_tojsstring(T, -1) : '');
    lua.lua_pop(T, 2);
  }
  return out;
}

/** `luaW_toboolean`. */
export function toBoolean(T: LuaState, idx: number): boolean {
  return lua.lua_toboolean(T, idx);
}

/** `luaW_tableget`: pushes `t[key]` and reports whether it is non-nil (popping it if nil). */
export function tableGet(T: LuaState, idx: number, key: string): boolean {
  if (lua.lua_type(T, idx) !== lua.LUA_TTABLE) return false;
  lua.lua_getfield(T, idx, to_luastring(key));
  if (lua.lua_isnil(T, -1)) {
    lua.lua_pop(T, 1);
    return false;
  }
  return true;
}

export function scalarText(v: WmlStoredValue): string {
  if (v instanceof TString) return v.str();
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/** `config::valid_tag`. */
export function validTag(name: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(name);
}

/** `config::valid_attribute`. */
export function validAttribute(name: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(name);
}

function traceback(T: LuaState): number {
  const message = lua.lua_isstring(T, 1) ? lua.lua_tojsstring(T, 1) : null;
  if (message === null && !lua.lua_isnoneornil(T, 1)) {
    if (lauxlib.luaL_callmeta(T, 1, to_luastring('__tostring')) && lua.lua_type(T, -1) === lua.LUA_TSTRING) return 1;
  }
  lauxlib.luaL_traceback(T, T, message === null ? null : to_luastring(message), 1);
  return 1;
}

function namedTupleNames(T: LuaState, idx: number): string[] {
  lauxlib.luaL_getmetafield(T, idx, to_luastring('__names'));
  const names = checkStringArray(T, -1);
  lua.lua_pop(T, 1);
  return names;
}

function namedTupleGet(T: LuaState): number {
  if (lua.lua_type(T, 2) === lua.LUA_TSTRING) {
    const i = namedTupleNames(T, 1).indexOf(lua.lua_tojsstring(T, 2));
    if (i >= 0) {
      lua.lua_rawgeti(T, 1, i + 1);
      return 1;
    }
  }
  return 0;
}

function namedTupleSet(T: LuaState): number {
  if (lua.lua_type(T, 2) === lua.LUA_TSTRING) {
    const i = namedTupleNames(T, 1).indexOf(lua.lua_tojsstring(T, 2));
    if (i >= 0) {
      lua.lua_pushvalue(T, 3);
      lua.lua_rawseti(T, 1, i + 1);
      return 0;
    }
  }
  lua.lua_settop(T, 3);
  lua.lua_rawset(T, 1);
  return 0;
}

function namedTupleToString(T: LuaState): number {
  const parts: string[] = [];
  for (let i = 1, n = lua.lua_rawlen(T, 1); i <= n; i++) {
    lua.lua_rawgeti(T, 1, i);
    parts.push(lauxlib.luaL_tolstring(T, -1) ? lua.lua_tojsstring(T, -1) : '');
    lua.lua_pop(T, 2);
  }
  lua.lua_pushstring(T, to_luastring(`(${parts.join(',')})`));
  return 1;
}

function namedTupleCompare(T: LuaState): number {
  const notEqual = (): number => {
    lua.lua_pushboolean(T, false);
    return 1;
  };
  if (lua.lua_type(T, 1) !== lua.LUA_TTABLE || lua.lua_type(T, 2) !== lua.LUA_TTABLE) return notEqual();
  lauxlib.luaL_getmetafield(T, 1, to_luastring('__name'));
  lauxlib.luaL_getmetafield(T, 2, to_luastring('__name'));
  if (!lua.lua_rawequal(T, 3, 4)) return notEqual();
  lua.lua_pop(T, 2);
  const left = namedTupleNames(T, 1);
  const right = namedTupleNames(T, 2);
  if (left.join('\0') !== right.join('\0')) return notEqual();
  for (let i = 1; i <= left.length; i++) {
    lua.lua_rawgeti(T, 1, i);
    lua.lua_rawgeti(T, 2, i);
    const same = lua.lua_compare(T, -2, -1, lua.LUA_OPEQ);
    lua.lua_pop(T, 2);
    if (!same) return notEqual();
  }
  lua.lua_pushboolean(T, true);
  return 1;
}

function buildDirIndex(files: VirtualDataDir): Map<string, { dirs: Set<string>; files: Set<string> }> {
  const index = new Map<string, { dirs: Set<string>; files: Set<string> }>();
  const entry = (dir: string) => {
    let e = index.get(dir);
    if (!e) index.set(dir, (e = { dirs: new Set(), files: new Set() }));
    return e;
  };
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (i === parts.length - 1) entry(dir).files.add(parts[i]!);
      else entry(dir).dirs.add(parts[i]!);
    }
  }
  return index;
}
