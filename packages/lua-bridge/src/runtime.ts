/**
 * Phase 28c: runs a campaign's own Lua, as upstream's `game_lua_kernel` does -- the Lua a campaign loads
 * (its `[lua]` preload scripts), `[lua]` action tags, and WML tags a campaign defines in Lua
 * (`function wesnoth.wml_actions.foo(cfg) ... end`).
 *
 * ## Suspending
 * The engine's WML actions are generators that can stop for the player (`Flow`, `interaction.ts`); Lua
 * called from JS cannot. So every piece of Lua runs in its own coroutine, which `drive` steps: when Lua
 * calls something that has to wait -- a native WML action such as `[message]`
 * (`wesnoth.wml_actions.message{...}`), `wesnoth.game_events.fire`, a custom dialog -- the JS function it
 * called yields a request to `drive`, which runs the request's `Flow` with `yield*` (so its interactions
 * travel out to the display) and resumes the coroutine with the result. Lua's own `pcall` and coroutine
 * semantics are untouched: Lua 5.3 lets a coroutine yield across `pcall`.
 *
 * ## `wesnoth.wml_actions`
 * A proxy table. Reading a tag gives the Lua function a campaign assigned to it, else a function that
 * runs the engine's own handler (`ActionRegistry`), captured when read -- so a campaign can wrap a native
 * tag (`skip_animations.lua` wraps `[animate_unit]`, `[sound]`, `[delay]`) and the wrapper still reaches
 * the original. Assigning a function registers it with the registry for that tag, so WML reaching the
 * tag runs the Lua.
 *
 * ## What is bridged
 * Only what the campaigns ported so far use (see `docs/PROGRESS.md`, Phase 28c): `wml.variables`,
 * `wml.load` (files the snapshot carries), `wml.tag`/`get_child`/`child_range`, `wesnoth.require`/
 * `dofile` (sources the snapshot carries), `wesnoth.textdomain` (translatable strings, `..` included),
 * `wesnoth.wml_actions`, `wesnoth.game_events.fire`, `wesnoth.interface.skip_messages`/
 * `is_skipping_messages`, `wesnoth.units.find_on_map`/`get`, `wesnoth.sync.evaluate_single` (run
 * locally: a dialog's answers are recorded for replay by the dialog itself), and `gui.show_dialog`
 * (`guiDialog.ts`). Anything else is a Lua error naming the missing field, so a gap shows up in the log
 * instead of misbehaving silently.
 */
import { WmlConfig, type WmlConfigJson } from '@wesnothweb2/engine/src/wml/config.js';
import { TString } from '@wesnothweb2/engine/src/i18n/tstring.js';
import { dsgettext, dsngettext } from '@wesnothweb2/engine/src/i18n/gettext.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import type { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import type { ActionHandler, EventContext } from '@wesnothweb2/engine/src/events/context.js';
import { isFlow, type Flow, type InteractionResult } from '@wesnothweb2/engine/src/events/interaction.js';
import { findUnits, unitMatchesFilter } from '@wesnothweb2/engine/src/events/filter.js';
import { effectEnvFor } from '@wesnothweb2/engine/src/events/actionWml.js';
import { buildGuiDialog, findGuiWidget, GUI_RETVAL, type GuiDialogSpec, type GuiNode } from '@wesnothweb2/engine/src/events/guiDialog.js';
import { newLuaState, doString, lua, lauxlib, to_luastring, interop, type LuaState } from './luaEnv.js';
import { BOOTSTRAP_LUA_SOURCE } from './bridges/bootstrap.js';

/** What a scenario's Lua may load at run time: the browser has no data directory to read. */
export interface LuaSources {
  /** Lua source by data-relative path (`campaigns/The_South_Guard/lua/popups.lua`). */
  readonly modules: Readonly<Record<string, string>>;
  /** Preprocessed WML by data-relative path, for `wml.load`. */
  readonly wml: Readonly<Record<string, WmlConfigJson>>;
}

/** A request a Lua coroutine yields to `drive`. */
type LuaRequest = { readonly kind: 'flow'; readonly flow: Flow<unknown> };

const TSTRING_MT = 'wesnoth.tstring';
const UNIT_MT = 'wesnoth.unit';

/** Lua-side support the JS functions below rely on: the action proxy, require/dofile, dialogs, sync. */
const RUNTIME_LUA_SOURCE = `
local native_action = wesnoth.__native_action
local register_action = wesnoth.__register_action
local lua_actions = {}
wesnoth.wml_actions = setmetatable({}, {
  __index = function(_, tag)
    local f = lua_actions[tag]
    if f ~= nil then return f end
    return native_action(tag)
  end,
  __newindex = function(_, tag, f)
    lua_actions[tag] = f
    register_action(tag, f ~= nil)
  end,
})
wesnoth.__lua_actions = lua_actions

local loaded = {}
local module_source = wesnoth.__module_source
local function load_module(name)
  local source, path = module_source(name)
  if not source then error("wesnoth.require: no such module '" .. tostring(name) .. "'", 2) end
  local chunk, message = load(source, "@" .. path)
  if not chunk then error(message, 0) end
  return chunk, path
end
function wesnoth.require(name)
  local cached = loaded[name]
  if cached ~= nil then return cached end
  local chunk = load_module(name)
  local result = chunk()
  if result == nil then result = true end
  loaded[name] = result
  return result
end
function wesnoth.dofile(name, ...)
  local chunk = load_module(name)
  return chunk(...)
end

wesnoth.sync = wesnoth.sync or {}
-- Run locally: in single player the choice is this client's. What the player answers in a dialog is
-- recorded for replay by gui.show_dialog itself.
function wesnoth.sync.evaluate_single(a, b)
  local f = type(a) == "function" and a or b
  return f()
end

gui = gui or {}
local callbacks = {}
wesnoth.__gui_callbacks = callbacks
local CALLBACK_KEYS = { on_modified = true, on_button_click = true, on_left_click = true, callback = true }
function gui.show_dialog(wml, preshow, postshow)
  local handle = wesnoth.__gui_new(wml)
  local function widget(id)
    return setmetatable({}, {
      __index = function(_, key) return wesnoth.__gui_get(handle, id, key) end,
      __newindex = function(_, key, value)
        if CALLBACK_KEYS[key] then
          callbacks[handle .. "|" .. id .. "|" .. key] = value
          wesnoth.__gui_set(handle, id, key, value ~= nil)
        else
          wesnoth.__gui_set(handle, id, key, value)
        end
      end,
    })
  end
  local dialog = setmetatable({
    close = function() wesnoth.__gui_close(handle) end,
  }, { __index = function(_, id) return widget(id) end })
  if preshow then preshow(dialog) end
  local result = wesnoth.__gui_run(handle)
  if postshow then postshow(dialog) end
  for key in pairs(callbacks) do
    if key:sub(1, #tostring(handle) + 1) == handle .. "|" then callbacks[key] = nil end
  end
  return result
end
`;

interface OpenDialog {
  root: GuiNode;
  closed: boolean;
  retval: number;
}

export class LuaRuntime {
  private readonly L: LuaState;
  /** Engine handlers for tags a campaign's Lua has taken over, as they were before. */
  private readonly natives = new Map<string, ActionHandler | undefined>();
  private readonly tstrings: TString[] = [];
  /** Units handed to Lua (`__uid` indexes this). */
  private readonly units: Unit[] = [];
  private readonly dialogs = new Map<number, OpenDialog>();
  private nextDialog = 1;

  constructor(
    private readonly sources: LuaSources,
    /** The event context actions run with (the pump's own, whose fields change per event). */
    private readonly ctx: () => EventContext,
  ) {
    this.L = newLuaState();
    doString(this.L, BOOTSTRAP_LUA_SOURCE, '=bootstrap');
    this.installTString();
    this.installUnit();
    this.installFunctions();
    doString(this.L, RUNTIME_LUA_SOURCE, '=runtime');
    this.ctx().registry.register('lua', (cfg) => this.runChunk(cfg.getString('code', ''), cfg.getString('name', '') || '=[lua]', cfg.child('args')));
  }

  /**
   * `game_lua_kernel::initialize`: the preload scripts (the game config's own `[lua]`, which the snapshot
   * builder marks `game_config=yes` and puts first), then the scenario's other top-level `[lua]`.
   */
  *initialize(scenario: WmlConfig): Flow {
    for (const lua of scenario.children('lua')) {
      try {
        yield* this.runChunk(lua.getString('code', ''), lua.getString('name', '') || '=[lua] preload', lua.child('args'));
      } catch (e) {
        this.ctx().log('error', `[lua] preload: ${(e as Error).message}`);
      }
    }
  }

  /** Runs a chunk of Lua with `args` as its `...` (the `[lua]` tag). */
  *runChunk(code: string, chunkName: string, args?: WmlConfig): Flow {
    const T = this.newThread();
    try {
      if (lauxlib.luaL_loadbuffer(T.state, to_luastring(code), null, to_luastring(chunkName)) !== lua.LUA_OK) {
        throw new Error(lua.lua_tojsstring(T.state, -1));
      }
      if (args) this.pushConfig(T.state, args);
      else lua.lua_pushnil(T.state);
      yield* this.drive(T.state, 1);
    } finally {
      this.release(T.ref);
    }
  }

  // --- coroutines ---

  private newThread(): { state: LuaState; ref: number } {
    const state = lua.lua_newthread(this.L);
    const ref = lauxlib.luaL_ref(this.L, lua.LUA_REGISTRYINDEX);
    return { state, ref };
  }

  private release(ref: number): void {
    lauxlib.luaL_unref(this.L, lua.LUA_REGISTRYINDEX, ref);
  }

  /** Resumes `T` until it finishes, running each request it yields; returns what the coroutine returned. */
  private *drive(T: LuaState, nargs: number): Flow<unknown[]> {
    for (;;) {
      const status = lua.lua_resume(T, null, nargs);
      if (status === lua.LUA_YIELD) {
        const request = interop.tojs(T, -1) as LuaRequest;
        lua.lua_settop(T, 0);
        const result = yield* request.flow;
        nargs = this.pushResult(T, result);
        continue;
      }
      if (status === lua.LUA_OK) {
        const results: unknown[] = [];
        for (let i = 1; i <= lua.lua_gettop(T); i++) results.push(this.toJs(T, i));
        lua.lua_settop(T, 0);
        return results;
      }
      const message = lua.lua_isstring(T, -1) ? lua.lua_tojsstring(T, -1) : String(interop.tojs(T, -1));
      lauxlib.luaL_traceback(T, T, null, 0);
      const trace = lua.lua_tojsstring(T, -1);
      lua.lua_settop(T, 0);
      throw new Error(`${message}\n${trace}`);
    }
  }

  /** Yields `flow` from the running coroutine (call as a JS function's `return`). */
  private yieldFlow(T: LuaState, flow: Flow<unknown>): number {
    interop.push(T, { kind: 'flow', flow } satisfies LuaRequest);
    return lua.lua_yield(T, 1);
  }

  private pushResult(T: LuaState, result: unknown): number {
    if (result === undefined) return 0;
    this.pushJs(T, result);
    return 1;
  }

  /** Runs a Lua action a campaign defined: `wesnoth.wml_actions[tag](cfg)`. */
  private *runLuaAction(tag: string, cfg: WmlConfig): Flow {
    const T = this.newThread();
    try {
      lua.lua_getglobal(T.state, to_luastring('wesnoth'));
      lua.lua_getfield(T.state, -1, to_luastring('__lua_actions'));
      lua.lua_getfield(T.state, -1, to_luastring(tag));
      lua.lua_replace(T.state, 1);
      lua.lua_settop(T.state, 1);
      this.pushConfig(T.state, cfg);
      yield* this.drive(T.state, 1);
    } finally {
      this.release(T.ref);
    }
  }

  /** Calls a function stored in `wesnoth.__gui_callbacks[key]`, if any. */
  private *runCallback(key: string): Flow {
    const T = this.newThread();
    try {
      lua.lua_getglobal(T.state, to_luastring('wesnoth'));
      lua.lua_getfield(T.state, -1, to_luastring('__gui_callbacks'));
      lua.lua_getfield(T.state, -1, to_luastring(key));
      lua.lua_replace(T.state, 1);
      lua.lua_settop(T.state, 1);
      if (lua.lua_type(T.state, 1) !== lua.LUA_TFUNCTION) return;
      yield* this.drive(T.state, 0);
    } finally {
      this.release(T.ref);
    }
  }

  // --- values ---

  private installTString(): void {
    const L = this.L;
    lauxlib.luaL_newmetatable(L, to_luastring(TSTRING_MT));
    const set = (name: string, fn: (T: LuaState) => number): void => {
      lua.lua_pushcfunction(L, fn);
      lua.lua_setfield(L, -2, to_luastring(name));
    };
    set('__tostring', (T) => {
      lua.lua_pushstring(T, to_luastring(this.tstringAt(T, 1)!.str()));
      return 1;
    });
    set('__concat', (T) => {
      this.pushTString(T, this.asTString(T, 1).concat(this.asTString(T, 2)));
      return 1;
    });
    set('__len', (T) => {
      lua.lua_pushinteger(T, this.tstringAt(T, 1)!.str().length);
      return 1;
    });
    set('__eq', (T) => {
      lua.lua_pushboolean(T, this.asTString(T, 1).str() === this.asTString(T, 2).str());
      return 1;
    });
    lua.lua_pop(L, 1);
  }

  private pushTString(T: LuaState, value: TString): void {
    this.tstrings.push(value);
    lua.lua_createtable(T, 0, 1);
    lua.lua_pushinteger(T, this.tstrings.length - 1);
    lua.lua_setfield(T, -2, to_luastring('__tsid'));
    lauxlib.luaL_setmetatable(T, to_luastring(TSTRING_MT));
  }

  private tstringAt(T: LuaState, idx: number): TString | undefined {
    if (lua.lua_type(T, idx) !== lua.LUA_TTABLE || !lua.lua_getmetatable(T, idx)) return undefined;
    lauxlib.luaL_getmetatable(T, to_luastring(TSTRING_MT));
    const same = lua.lua_rawequal(T, -1, -2);
    lua.lua_pop(T, 2);
    if (!same) return undefined;
    lua.lua_getfield(T, idx, to_luastring('__tsid'));
    const id = lua.lua_tointeger(T, -1);
    lua.lua_pop(T, 1);
    return this.tstrings[id];
  }

  private asTString(T: LuaState, idx: number): TString {
    return this.tstringAt(T, idx) ?? TString.literal(lua.lua_isnil(T, idx) ? '' : this.luaString(T, idx));
  }

  private luaString(T: LuaState, idx: number): string {
    if (lua.lua_type(T, idx) === lua.LUA_TBOOLEAN) return lua.lua_toboolean(T, idx) ? 'yes' : 'no';
    lauxlib.luaL_tolstring(T, idx);
    const s = lua.lua_tojsstring(T, -1);
    lua.lua_pop(T, 1);
    return s;
  }

  /** A WML config as upstream's Lua sees it: attributes by name, children as `{tag, cfg}` in the array part. */
  private pushConfig(T: LuaState, cfg: WmlConfig): void {
    // A JS function starts with only LUA_MINSTACK (20) free slots; each nesting level needs a few more.
    lauxlib.luaL_checkstack(T, 8, null);
    const children = cfg.allChildren();
    lua.lua_createtable(T, children.length, cfg.attributeNames().length);
    for (const key of cfg.attributeNames()) {
      this.pushJs(T, cfg.getRaw(key));
      lua.lua_setfield(T, -2, to_luastring(key));
    }
    children.forEach(({ tag, config }, i) => {
      lua.lua_createtable(T, 2, 0);
      lua.lua_pushstring(T, to_luastring(tag));
      lua.lua_rawseti(T, -2, 1);
      this.pushConfig(T, config);
      lua.lua_rawseti(T, -2, 2);
      lua.lua_rawseti(T, -2, i + 1);
    });
  }

  /** The inverse of `pushConfig`, for a WML table on the stack. */
  private toConfig(T: LuaState, index: number): WmlConfig {
    const idx = lua.lua_absindex(T, index);
    lauxlib.luaL_checkstack(T, 8, null);
    const cfg = new WmlConfig();
    if (lua.lua_type(T, idx) !== lua.LUA_TTABLE) return cfg;
    const length = lua.lua_rawlen(T, idx);
    for (let i = 1; i <= length; i++) {
      lua.lua_rawgeti(T, idx, i);
      if (lua.lua_type(T, -1) === lua.LUA_TTABLE) {
        lua.lua_rawgeti(T, -1, 1);
        lua.lua_rawgeti(T, -2, 2);
        if (lua.lua_type(T, -2) === lua.LUA_TSTRING) cfg.addChild(lua.lua_tojsstring(T, -2), this.toConfig(T, -1));
        lua.lua_pop(T, 2);
      }
      lua.lua_pop(T, 1);
    }
    lua.lua_pushnil(T);
    while (lua.lua_next(T, idx) !== 0) {
      if (lua.lua_type(T, -2) === lua.LUA_TSTRING) {
        const key = lua.lua_tojsstring(T, -2);
        const value = this.toAttribute(T, -1);
        if (value !== undefined) cfg.setAttribute(key, value);
      }
      lua.lua_pop(T, 1);
    }
    return cfg;
  }

  private toAttribute(T: LuaState, idx: number): string | number | boolean | TString | undefined {
    switch (lua.lua_type(T, idx)) {
      case lua.LUA_TNUMBER:
        return lua.lua_isinteger(T, idx) ? Number(lua.lua_tointeger(T, idx)) : lua.lua_tonumber(T, idx);
      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(T, idx);
      case lua.LUA_TSTRING:
        return lua.lua_tojsstring(T, idx);
      case lua.LUA_TTABLE:
        return this.tstringAt(T, idx);
      default:
        return undefined;
    }
  }

  private toJs(T: LuaState, idx: number): unknown {
    const attribute = this.toAttribute(T, idx);
    if (attribute !== undefined) return attribute;
    return lua.lua_type(T, idx) === lua.LUA_TTABLE ? this.toConfig(T, idx) : undefined;
  }

  private pushJs(T: LuaState, value: unknown): void {
    if (value === undefined || value === null) lua.lua_pushnil(T);
    else if (value instanceof TString) this.pushTString(T, value);
    else if (value instanceof WmlConfig) this.pushConfig(T, value);
    else if (typeof value === 'number') {
      if (Number.isInteger(value)) lua.lua_pushinteger(T, value);
      else lua.lua_pushnumber(T, value);
    } else if (typeof value === 'boolean') lua.lua_pushboolean(T, value);
    else lua.lua_pushstring(T, to_luastring(String(value)));
  }

  // --- units ---

  /**
   * A unit as Lua sees it (`wesnoth.units.find_on_map` and friends): its fields, a few writable ones, and
   * the methods the ported campaigns call. Reading a field this does not know is `nil`, as for upstream's
   * unit userdata's unknown keys.
   */
  private installUnit(): void {
    const L = this.L;
    lauxlib.luaL_newmetatable(L, to_luastring(UNIT_MT));
    lua.lua_pushcfunction(L, (T: LuaState) => {
      const unit = this.unitAt(T, 1);
      if (!unit) return 0;
      const key = lua.lua_tojsstring(T, 2);
      const board = this.ctx().board;
      const onMap = board.unitAt(unit.location) === unit;
      const value: unknown = (() => {
        switch (key) {
          case 'x':
            return onMap ? unit.location.wmlX : undefined;
          case 'y':
            return onMap ? unit.location.wmlY : undefined;
          case 'id':
            return unit.id;
          case 'type':
            return unit.type.id;
          case 'name':
            return unit.translatableName ?? unit.name;
          case 'side':
            return unit.side;
          case 'level':
            return unit.level;
          case 'race':
            return unit.type.raceId;
          case 'gender':
            return unit.gender;
          case 'hitpoints':
            return unit.hitpoints;
          case 'max_hitpoints':
            return unit.maxHitpoints;
          case 'experience':
            return unit.experience;
          case 'max_experience':
            return unit.maxExperience;
          case 'moves':
            return unit.movesLeft;
          case 'max_moves':
            return unit.maxMoves;
          case 'attacks_left':
            return unit.attacksLeft;
          case 'canrecruit':
            return unit.canRecruit;
          case 'valid':
            return onMap ? 'map' : 'recall';
          default:
            return undefined;
        }
      })();
      if (value !== undefined) {
        this.pushJs(T, value);
        return 1;
      }
      if (key === 'remove_modifications') {
        lua.lua_pushcfunction(T, (U: LuaState) => {
          const self = this.unitAt(U, 1);
          if (!self) return 0;
          const filter = this.toConfig(U, 2);
          const kind = lua.lua_isstring(U, 3) ? lua.lua_tojsstring(U, 3) : 'object';
          const byAttr = Object.fromEntries(filter.attributeNames().map((k) => [k, filter.getString(k)]));
          self.removeModifications(byAttr, [kind], effectEnvFor(this.ctx(), self));
          return 0;
        });
        return 1;
      }
      if (key === 'matches') {
        lua.lua_pushcfunction(T, (U: LuaState) => {
          const self = this.unitAt(U, 1);
          lua.lua_pushboolean(U, !!self && unitMatchesFilter(self, this.toConfig(U, 2), this.ctx().board));
          return 1;
        });
        return 1;
      }
      return 0;
    });
    lua.lua_setfield(L, -2, to_luastring('__index'));
    lua.lua_pushcfunction(L, (T: LuaState) => {
      const unit = this.unitAt(T, 1);
      const key = lua.lua_tojsstring(T, 2);
      if (!unit) return 0;
      const n = Number(lua.lua_tonumber(T, 3));
      if (key === 'hitpoints') unit.hitpoints = n;
      else if (key === 'moves') unit.movesLeft = n;
      else if (key === 'experience') unit.experience = n;
      else if (key === 'side') unit.side = n;
      else return lauxlib.luaL_error(T, to_luastring(`unit.${key} is not writable here`));
      return 0;
    });
    lua.lua_setfield(L, -2, to_luastring('__newindex'));
    lua.lua_pop(L, 1);
  }

  private pushUnit(T: LuaState, unit: Unit): void {
    let uid = this.units.indexOf(unit);
    if (uid < 0) uid = this.units.push(unit) - 1;
    lua.lua_createtable(T, 0, 1);
    lua.lua_pushinteger(T, uid);
    lua.lua_setfield(T, -2, to_luastring('__uid'));
    lauxlib.luaL_setmetatable(T, to_luastring(UNIT_MT));
  }

  private unitAt(T: LuaState, idx: number): Unit | undefined {
    if (lua.lua_type(T, idx) !== lua.LUA_TTABLE) return undefined;
    lua.lua_getfield(T, idx, to_luastring('__uid'));
    const uid = lua.lua_isinteger(T, -1) ? Number(lua.lua_tointeger(T, -1)) : -1;
    lua.lua_pop(T, 1);
    return this.units[uid];
  }

  // --- the API ---

  private installFunctions(): void {
    const L = this.L;
    const define = (path: readonly string[], fn: (T: LuaState) => number): void => {
      lua.lua_getglobal(L, to_luastring(path[0]!));
      if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
        lua.lua_pop(L, 1);
        lua.lua_createtable(L, 0, 0);
        lua.lua_pushvalue(L, -1);
        lua.lua_setglobal(L, to_luastring(path[0]!));
      }
      for (const part of path.slice(1, -1)) {
        lua.lua_getfield(L, -1, to_luastring(part));
        if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
          lua.lua_pop(L, 1);
          lua.lua_createtable(L, 0, 0);
          lua.lua_pushvalue(L, -1);
          lua.lua_setfield(L, -3, to_luastring(part));
        }
        lua.lua_remove(L, -2);
      }
      lua.lua_pushcfunction(L, fn);
      lua.lua_setfield(L, -2, to_luastring(path[path.length - 1]!));
      lua.lua_pop(L, 1);
    };

    // wesnoth.textdomain: _ "msgid" is a translatable string.
    define(['wesnoth', 'textdomain'], (T) => {
      const domain = lua.lua_tojsstring(T, 1);
      lua.lua_pushcfunction(T, (U: LuaState) => {
        // Called as _ "msgid" (one argument) or _("singular", "plural", n).
        if (lua.lua_gettop(U) >= 3) {
          lua.lua_pushstring(U, to_luastring(dsngettext(domain, lua.lua_tojsstring(U, 1), lua.lua_tojsstring(U, 2), Number(lua.lua_tonumber(U, 3)))));
          return 1;
        }
        this.pushTString(U, TString.translatable(domain, lua.lua_tojsstring(U, 1)));
        return 1;
      });
      return 1;
    });
    define(['wesnoth', '__gettext'], (T) => {
      lua.lua_pushstring(T, to_luastring(dsgettext(lua.lua_tojsstring(T, 1), lua.lua_tojsstring(T, 2))));
      return 1;
    });

    // wml.variables: a table whose reads and writes go to the game's variables.
    lua.lua_getglobal(L, to_luastring('wml'));
    lua.lua_createtable(L, 0, 0);
    lua.lua_createtable(L, 0, 2);
    lua.lua_pushcfunction(L, (T: LuaState) => {
      const name = this.luaString(T, 2);
      const store = this.ctx().variables;
      const raw = store.getRaw(name);
      if (raw !== undefined) this.pushJs(T, raw);
      else this.pushJs(T, store.getConfig(name));
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring('__index'));
    lua.lua_pushcfunction(L, (T: LuaState) => {
      const name = this.luaString(T, 2);
      const store = this.ctx().variables;
      if (lua.lua_isnil(T, 3)) store.clear(name);
      else if (lua.lua_type(T, 3) === lua.LUA_TTABLE && !this.tstringAt(T, 3)) store.setConfig(name, this.toConfig(T, 3));
      else store.set(name, this.toAttribute(T, 3) ?? this.luaString(T, 3));
      return 0;
    });
    lua.lua_setfield(L, -2, to_luastring('__newindex'));
    lua.lua_setmetatable(L, -2);
    lua.lua_setfield(L, -2, to_luastring('variables'));
    lua.lua_pop(L, 1);

    // wml.load: the preprocessed files the snapshot carries.
    define(['wml', 'load'], (T) => {
      const path = normalisePath(lua.lua_tojsstring(T, 1));
      const json = this.sources.wml[path];
      if (!json) return lauxlib.luaL_error(T, to_luastring(`wml.load: '${path}' is not available`));
      this.pushConfig(T, WmlConfig.fromJSON(json));
      return 1;
    });

    define(['wesnoth', '__module_source'], (T) => {
      const found = findModule(this.sources.modules, lua.lua_tojsstring(T, 1));
      if (!found) return 0;
      lua.lua_pushstring(T, to_luastring(found.source));
      lua.lua_pushstring(T, to_luastring(found.path));
      return 2;
    });

    define(['wesnoth', '__native_action'], (T) => {
      const tag = lua.lua_tojsstring(T, 1);
      const handler = this.natives.has(tag) ? this.natives.get(tag) : this.ctx().registry.get(tag);
      if (!handler) return 0;
      lua.lua_pushcfunction(T, (U: LuaState) => {
        const ctx = this.ctx();
        const result = handler(this.toConfig(U, 1), ctx);
        return isFlow(result) ? this.yieldFlow(U, result) : 0;
      });
      return 1;
    });
    define(['wesnoth', '__register_action'], (T) => {
      const tag = lua.lua_tojsstring(T, 1);
      const registry = this.ctx().registry;
      if (!this.natives.has(tag)) this.natives.set(tag, registry.get(tag));
      if (lua.lua_toboolean(T, 2)) registry.register(tag, (cfg) => this.runLuaAction(tag, cfg));
      else {
        const native = this.natives.get(tag);
        if (native) registry.register(tag, native);
      }
      return 0;
    });

    define(['wesnoth', 'game_events', 'fire'], (T) => {
      const name = lua.lua_tojsstring(T, 1);
      const loc = (i: number): Location =>
        lua.lua_type(T, i) === lua.LUA_TNUMBER && lua.lua_type(T, i + 1) === lua.LUA_TNUMBER
          ? Location.fromWml(Number(lua.lua_tointeger(T, i)), Number(lua.lua_tointeger(T, i + 1)))
          : Location.NULL;
      const ctx = this.ctx();
      const flow = (function* (): Flow<boolean> {
        yield* ctx.fireNow(name, loc(2), loc(4));
        return true;
      })();
      return this.yieldFlow(T, flow);
    });

    define(['wesnoth', 'interface', 'skip_messages'], (T) => {
      this.ctx().skipMessages = lua.lua_isnone(T, 1) ? true : lua.lua_toboolean(T, 1);
      return 0;
    });
    define(['wesnoth', 'interface', 'is_skipping_messages'], (T) => {
      lua.lua_pushboolean(T, this.ctx().skipMessages);
      return 1;
    });

    const pushUnits = (T: LuaState, units: readonly Unit[]): number => {
      lua.lua_createtable(T, units.length, 0);
      units.forEach((u, i) => {
        this.pushUnit(T, u);
        lua.lua_rawseti(T, -2, i + 1);
      });
      return 1;
    };
    define(['wesnoth', 'units', 'find_on_map'], (T) => pushUnits(T, findUnits(this.ctx().board, this.toConfig(T, 1))));
    define(['wesnoth', 'units', 'find'], (T) => pushUnits(T, findUnits(this.ctx().board, this.toConfig(T, 1), true)));
    define(['wesnoth', 'units', 'find_on_recall'], (T) => {
      const filter = this.toConfig(T, 1);
      const board = this.ctx().board;
      return pushUnits(T, findUnits(board, filter, true).filter((u) => board.unitAt(u.location) !== u));
    });
    define(['wesnoth', 'units', 'get'], (T) => {
      const board = this.ctx().board;
      const unit = lua.lua_type(T, 1) === lua.LUA_TSTRING
        ? board.allUnits().find((u) => u.id === lua.lua_tojsstring(T, 1))
        : board.unitAt(Location.fromWml(Number(lua.lua_tointeger(T, 1)), Number(lua.lua_tointeger(T, 2))));
      if (!unit) return 0;
      this.pushUnit(T, unit);
      return 1;
    });

    // gui.show_dialog's JS half: the dialog model, its widgets, and the wait for the player.
    define(['wesnoth', '__gui_new'], (T) => {
      const handle = this.nextDialog++;
      this.dialogs.set(handle, { root: buildGuiDialog(this.toConfig(T, 1)).root, closed: false, retval: GUI_RETVAL.NONE });
      lua.lua_pushinteger(T, handle);
      return 1;
    });
    define(['wesnoth', '__gui_get'], (T) => {
      const widget = this.widget(T);
      if (!widget) return 0;
      const key = lua.lua_tojsstring(T, 3);
      if (key === 'visible') lua.lua_pushboolean(T, widget.visibility === 'visible');
      else if (key === 'selected_index' && widget.type === 'listbox') lua.lua_pushinteger(T, widget.selectedIndex);
      else if (key === 'label' && 'label' in widget) {
        const label = widget.label;
        if (typeof label === 'string') lua.lua_pushstring(T, to_luastring(label));
        else this.pushTString(T, TString.fromJSON(label));
      } else if (key === 'id') lua.lua_pushstring(T, to_luastring(widget.id));
      else return 0;
      return 1;
    });
    define(['wesnoth', '__gui_set'], (T) => {
      const widget = this.widget(T);
      const key = lua.lua_tojsstring(T, 3);
      if (!widget) return lauxlib.luaL_error(T, to_luastring(`gui: no widget '${lua.lua_tojsstring(T, 2)}'`));
      if (key === 'visible') {
        if (lua.lua_type(T, 4) === lua.LUA_TBOOLEAN) widget.visibility = lua.lua_toboolean(T, 4) ? 'visible' : 'invisible';
        else {
          const v = lua.lua_tojsstring(T, 4);
          widget.visibility = v === 'hidden' || v === 'invisible' ? v : 'visible';
        }
      } else if (key === 'selected_index' && widget.type === 'listbox') widget.selectedIndex = Number(lua.lua_tointeger(T, 4));
      else if (key === 'label' && (widget.type === 'label' || widget.type === 'button')) {
        const ts = this.tstringAt(T, 4);
        widget.label = ts ? (ts.translatable ? ts.toJSON() : ts.str()) : this.luaString(T, 4);
      } else if (key === 'label' && widget.type === 'image') widget.label = this.luaString(T, 4);
      else if (!['on_modified', 'on_button_click', 'on_left_click', 'callback', 'tooltip', 'enabled'].includes(key)) {
        this.ctx().log('warn', `gui: widget property '${key}' is not supported (ignored)`);
      }
      return 0;
    });
    define(['wesnoth', '__gui_close'], (T) => {
      const dialog = this.dialogs.get(Number(lua.lua_tointeger(T, 1)));
      if (dialog) dialog.closed = true;
      return 0;
    });
    define(['wesnoth', '__gui_run'], (T) => this.yieldFlow(T, this.dialogFlow(Number(lua.lua_tointeger(T, 1)))));
  }

  private widget(T: LuaState): GuiNode | undefined {
    const dialog = this.dialogs.get(Number(lua.lua_tointeger(T, 1)));
    return dialog ? findGuiWidget(dialog.root, lua.lua_tojsstring(T, 2)) : undefined;
  }

  /**
   * The dialog waiting for the player (upstream's modal `window::show`): a button closes it with its return
   * value; picking a listbox row updates `selected_index` and runs the widget's `on_modified`, which may
   * itself `close()` it; Escape cancels.
   */
  private *dialogFlow(handle: number): Flow<number> {
    const dialog = this.dialogs.get(handle);
    if (!dialog) return GUI_RETVAL.CANCEL;
    try {
      while (!dialog.closed) {
        const spec: GuiDialogSpec = { root: structuredClone(dialog.root) };
        const answer: InteractionResult = yield { kind: 'guiDialog', dialog: spec };
        const selection = /^select:(.*):(\d+)$/.exec(answer.text ?? '');
        if (selection) {
          const widget = findGuiWidget(dialog.root, selection[1]!);
          if (widget?.type === 'listbox') widget.selectedIndex = Number(selection[2]);
          yield* this.runCallback(`${handle}|${selection[1]}|on_modified`);
          continue;
        }
        dialog.retval = answer.value ?? GUI_RETVAL.CANCEL;
        dialog.closed = true;
      }
      return dialog.retval;
    } finally {
      this.dialogs.delete(handle);
    }
  }
}

function normalisePath(path: string): string {
  return path.replace(/^~?\/?/, '').replace(/^data\//, '');
}

/** `wesnoth.require`'s lookup: the name as given, with `.lua` added, or as a directory's `_main.lua`. */
function findModule(modules: Readonly<Record<string, string>>, name: string): { source: string; path: string } | undefined {
  const base = normalisePath(name);
  for (const path of [base, `${base}.lua`, `${base}/_main.lua`, `lua/${base}`, `lua/${base}.lua`]) {
    const source = modules[path];
    if (source !== undefined) return { source, path };
  }
  return undefined;
}
