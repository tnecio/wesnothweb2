/// <reference path="./vendor.d.ts" />
/**
 * Thin wrapper around Fengari (the pure-JS Lua 5.3 VM this package embeds --
 * see `docs/OPEN_QUESTIONS.md` decision 2) plus `fengari-interop` (the
 * JS<->Lua value-marshalling library). Everything else in this package
 * programs against this module rather than fengari's raw C-API-shaped
 * exports directly, so the handful of stack-manipulation footguns (matching
 * `lua_pop`/`lua_settop` counts, `LUA_REGISTRYINDEX` refs for caching, etc.)
 * are concentrated in one place.
 */
import { lua, lauxlib, lualib, to_luastring } from 'fengari';
import * as interop from 'fengari-interop';

export type LuaState = unknown;

/** Creates a fresh Lua state with the standard library and fengari-interop's `js` library loaded. */
export function newLuaState(): LuaState {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // Loads fengari-interop's "js" library, which is what makes `interop.push`
  // able to wrap an arbitrary JS object (not just primitives) as a Lua
  // value backed by a `Reflect`-based metatable (get/set hit the JS object's
  // own properties, including getters/setters) -- see bridges/*.ts, which
  // all build plain JS adapter objects and hand them to `interop.push`
  // rather than manually building Lua tables/metatables via the C API.
  lauxlib.luaL_requiref(L, to_luastring('js'), interop.luaopen_js, 1);
  lua.lua_pop(L, 1);
  return L;
}

export interface CompileResult {
  ok: boolean;
  error?: string;
}

/**
 * Compiles (but does not run) a chunk of Lua source, to check for syntax
 * errors only. Used by Task 1's "does Fengari accept this file's syntax"
 * verification -- see test/patchedFilesParse.test.ts.
 */
export function compileOnly(L: LuaState, source: string, chunkName: string): CompileResult {
  const status = lauxlib.luaL_loadstring(L, to_luastring(source));
  if (status === lua.LUA_OK) {
    lua.lua_pop(L, 1); // pop the compiled function, we don't run it
    return { ok: true };
  }
  const message = lua.lua_tojsstring(L, -1);
  lua.lua_pop(L, 1);
  return { ok: false, error: `${chunkName}: ${message}` };
}

/**
 * Loads and immediately runs a chunk of Lua source (the `dofile`/`dostring`
 * pattern), returning its single return value (converted to JS via
 * `interop.tojs`) or throwing a JS `Error` with the Lua error message if
 * compilation or execution fails.
 */
export function doString(L: LuaState, source: string, chunkName: string): unknown {
  const loadStatus = lauxlib.luaL_loadbuffer(
    L,
    to_luastring(source),
    source.length,
    to_luastring(chunkName),
  );
  if (loadStatus !== lua.LUA_OK) {
    const message = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`failed to compile ${chunkName}: ${message}`);
  }
  const callStatus = lua.lua_pcall(L, 0, 1, 0);
  if (callStatus !== lua.LUA_OK) {
    const message = interop.tojs(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`error running ${chunkName}: ${String(message)}`);
  }
  const result = interop.tojs(L, -1);
  lua.lua_pop(L, 1);
  return result;
}

/**
 * Like `doString`, but for a chunk that returns a Lua array table: converts
 * it to a plain JS array by walking indices `1..#t` with `lua_geti`/
 * `interop.tojs` per element. Needed because `interop.tojs` on a Lua table
 * returns a callable wrapper object with `.get()/.set()` methods (so JS can
 * call back into Lua generically), NOT a plain indexable JS array/object --
 * see https://github.com/fengari-lua/fengari-interop's `tojs` docs (the
 * "wrapped in a JavaScript function object" case).
 */
export function doStringArray(L: LuaState, source: string, chunkName: string): unknown[] {
  const loadStatus = lauxlib.luaL_loadbuffer(
    L,
    to_luastring(source),
    source.length,
    to_luastring(chunkName),
  );
  if (loadStatus !== lua.LUA_OK) {
    const message = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`failed to compile ${chunkName}: ${message}`);
  }
  const callStatus = lua.lua_pcall(L, 0, 1, 0);
  if (callStatus !== lua.LUA_OK) {
    const message = interop.tojs(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`error running ${chunkName}: ${String(message)}`);
  }
  const idx = lua.lua_absindex(L, -1);
  const len = lauxlib.luaL_len(L, idx);
  const result: unknown[] = [];
  for (let i = 1; i <= len; i++) {
    lua.lua_geti(L, idx, i);
    result.push(interop.tojs(L, -1));
    lua.lua_pop(L, 1);
  }
  lua.lua_pop(L, 1); // pop the table itself
  return result;
}

/**
 * Sets `path[0].path[1]....path[n-1] = value` where `value` is an arbitrary
 * JS object/function, wrapped via `fengari-interop` so its (possibly
 * getter/setter-backed) properties, or its callability, are transparently
 * usable from Lua -- see bridges/*.ts's module doc comments for why this is
 * preferred over hand-building Lua tables/metatables through the C API.
 * Every table but the last path segment must already exist (typically set
 * up by a bootstrap Lua chunk -- see bridges/bootstrap.ts) -- this only ever
 * creates the final field, never intermediate tables.
 */
/** Navigates to `path[0..n-2]`, leaving the second-to-last table on top of the stack. */
function navigateToParent(L: LuaState, path: readonly string[]): void {
  if (path.length < 2) throw new Error('path must have at least 2 segments (a table and a field name)');
  lua.lua_getglobal(L, to_luastring(path[0]!));
  if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
    throw new Error(`global '${path[0]}' is not a table (bootstrap Lua must define it first)`);
  }
  for (let i = 1; i < path.length - 1; i++) {
    lua.lua_getfield(L, -1, to_luastring(path[i]!));
    if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
      throw new Error(`field '${path.slice(0, i + 1).join('.')}' is not a table (bootstrap Lua must define it first)`);
    }
    lua.lua_remove(L, -2);
  }
}

export function setNestedField(L: LuaState, path: readonly string[], value: unknown): void {
  navigateToParent(L, path);
  interop.push(L, value);
  lua.lua_setfield(L, -2, to_luastring(path[path.length - 1]!));
  lua.lua_pop(L, 1);
}

/**
 * Like `setNestedField`, but for a raw Lua C function (`(L) => number of
 * results pushed`) rather than a `fengari-interop`-wrapped JS value. Needed
 * for functions that must manipulate the Lua stack/registry directly
 * (`wesnoth.require`'s module cache in bridges/require.ts) rather than ones
 * that just marshal a few JS primitives per call (most of bridges/*.ts).
 */
export function setNestedCFunction(
  L: LuaState,
  path: readonly string[],
  fn: (L: LuaState) => number,
): void {
  navigateToParent(L, path);
  lua.lua_pushcfunction(L, fn);
  lua.lua_setfield(L, -2, to_luastring(path[path.length - 1]!));
  lua.lua_pop(L, 1);
}

export { lua, lauxlib, lualib, to_luastring, interop };
