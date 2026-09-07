/**
 * A simplified `wesnoth.require`: given a `name -> Lua source` lookup
 * function, compiles+runs the named module the first time it's requested
 * and caches its return value (via a `LUA_REGISTRYINDEX` ref, so the cached
 * value is a real Lua value, not a JS round-trip) for subsequent requests --
 * the same "load once, cache by name" contract real `wesnoth.require` (see
 * `wesnoth/data/lua/package.lua`) provides.
 *
 * What's NOT ported: real `wesnoth.require`'s path-resolution algorithm
 * (trying `name`, `name.lua`, `lua/name`, `./name`) and its directory-load
 * behavior (requiring a directory dofiles every `.lua` file in it -- this is
 * how `wesnoth.require "wml"` in real `wml-tags.lua` pulls in the whole
 * `data/lua/wml/` action-tag directory). Both are real, non-trivial
 * behavior this phase doesn't need: this package's tests only ever request
 * a handful of exact module names by hand, so the caller supplies an exact
 * `name -> source` map (see dataLuaModuleSource.ts) rather than this
 * function re-deriving it from a directory listing.
 */
import { lua, lauxlib, to_luastring, type LuaState } from '../luaEnv.js';
import { setNestedCFunction } from '../luaEnv.js';

export type ModuleSourceLookup = (name: string) => { source: string; chunkName: string } | undefined;

export function installRequire(L: LuaState, getModuleSource: ModuleSourceLookup): void {
  const registryRefs = new Map<string, number>();

  const requireFn = (state: LuaState): number => {
    const name = lua.lua_tojsstring(state, 1);
    const cached = registryRefs.get(name);
    if (cached !== undefined) {
      lua.lua_rawgeti(state, lua.LUA_REGISTRYINDEX, cached);
      return 1;
    }
    const found = getModuleSource(name);
    if (!found) {
      lua.lua_pushnil(state);
      return 1;
    }
    const loadStatus = lauxlib.luaL_loadbuffer(
      state,
      to_luastring(found.source),
      found.source.length,
      to_luastring(found.chunkName),
    );
    if (loadStatus !== lua.LUA_OK) {
      // The compile error message is already on top of the stack (pushed by
      // luaL_loadbuffer); re-raise it as this call's error.
      return lua.lua_error(state);
    }
    const callStatus = lua.lua_pcall(state, 0, 1, 0);
    if (callStatus !== lua.LUA_OK) {
      // Propagate the module's own error object/message as this call's error.
      return lua.lua_error(state);
    }
    // Stack: [... , moduleResult]. Duplicate it to store a registry ref
    // without consuming the value we're about to return.
    lua.lua_pushvalue(state, -1);
    const ref = lauxlib.luaL_ref(state, lua.LUA_REGISTRYINDEX);
    registryRefs.set(name, ref);
    return 1;
  };

  setNestedCFunction(L, ['wesnoth', 'require'], requireFn);
}
