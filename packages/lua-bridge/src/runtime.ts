/**
 * Phase 28c: runs a campaign's own Lua, as upstream's `game_lua_kernel` does -- the Lua a campaign loads
 * (its `[lua]` preload scripts), `[lua]` action tags, and WML tags a campaign defines in Lua
 * (`function wesnoth.wml_actions.foo(cfg) ... end`). Phase 29: on the upstream-shaped kernel (`kernel/`),
 * which the AI's Lua shares, as upstream's does.
 *
 * ## Suspending
 * The engine's WML actions are generators that can stop for the player (`Flow`, `interaction.ts`); Lua
 * called from JS cannot. So every piece of Lua runs in its own coroutine, which `drive` steps: when Lua
 * calls something that has to wait -- a native WML action such as `[message]`
 * (`wesnoth.wml_actions.message{...}`), `wesnoth.game_events.fire`, a custom dialog -- the JS function it
 * called yields a request to `drive`, which runs the request's `Flow` with `yield*` (so its interactions
 * travel out to the display) and resumes the coroutine with the result. Lua's own `pcall` and coroutine
 * semantics are untouched: Lua 5.3 lets a coroutine yield across `pcall`. While the AI plays
 * (`runInline`), flows run to completion on the spot instead, with the session's responder, as the rest
 * of an AI turn does.
 *
 * ## `wesnoth.wml_actions`
 * A proxy table. Reading a tag gives the Lua function a campaign assigned to it, else a function that
 * runs the engine's own handler (`ActionRegistry`), captured when read -- so a campaign can wrap a native
 * tag (`skip_animations.lua` wraps `[animate_unit]`, `[sound]`, `[delay]`) and the wrapper still reaches
 * the original. Assigning a function registers it with the registry for that tag, so WML reaching the
 * tag runs the Lua. Upstream's `lua/wml-tags.lua` is not loaded: the engine implements those tags itself.
 *
 * ## What else is here
 * `wml.load` (files the snapshot carries, preprocessed at build time), `gui.show_dialog`
 * (`guiDialog.ts`) and `gui.show_help` (an `openHelp` beat). Everything else is the kernel's.
 */
import { WmlConfig, type WmlConfigJson } from '@wesnothweb2/engine/src/wml/config.js';
import { TString } from '@wesnothweb2/engine/src/i18n/tstring.js';
import type { ActionHandler, EventContext } from '@wesnothweb2/engine/src/events/context.js';
import { isFlow, runFlow, type Flow, type InteractionResult, type Responder } from '@wesnothweb2/engine/src/events/interaction.js';
import { addListboxRow, buildGuiDialog, findGuiWidget, findGuiWidgetByPath, GUI_RETVAL, type GuiDialogSpec, type GuiNode } from '@wesnothweb2/engine/src/events/guiDialog.js';
import type { Rng } from '@wesnothweb2/engine/src/rng/Rng.js';
import { MtRng } from '@wesnothweb2/engine/src/rng/MtRng.js';
import { RngDeterministic } from '@wesnothweb2/engine/src/rng/RngDeterministic.js';
import { lua, lauxlib, to_luastring, type LuaState } from './luaEnv.js';
import { createGameKernel, type LuaKernel, type LuaUnits, type VirtualDataDir } from './kernel/index.js';
import { checkString } from './kernel/kernel.js';
import type { GameKernelHost } from './kernel/game/host.js';
import { VCONFIG_KEY } from './kernel/game/misc.js';
import { wantsRawConfig } from '@wesnothweb2/engine/src/events/actionWml.js';

/** What a scenario's Lua may load at run time: the browser has no data directory to read. */
export interface LuaSources {
  /** Lua source by data-relative path (`campaigns/The_South_Guard/lua/popups.lua`). */
  readonly modules: Readonly<Record<string, string>>;
  /** Preprocessed WML by data-relative path, for `wml.load`. */
  readonly wml: Readonly<Record<string, WmlConfigJson>>;
}

export interface LuaRuntimeOptions {
  /** The data directory's own Lua (`lua/**`, `ai/**`: `dataLua.ts`'s `loadLuaDataDir`, or the browser's bundle). */
  readonly dataFiles: VirtualDataDir;
  /** `randomness::generator`; defaults to the event context's RNG. */
  readonly rng?: () => Rng;
  /** `wesnoth.current.side`; defaults to `$side_number`. */
  readonly currentSide?: () => number;
  /** A side's `[ai]` as `wesnoth.sides[n].__cfg` shows it. */
  readonly sideAiConfigs?: (side: number) => readonly WmlConfig[];
  /** Where the kernel's messages go; defaults to the event context's log. */
  readonly log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /**
   * `wesnoth.sync.invoke_command`: records and runs `[custom_command]` as a synced command (the session's
   * recorder), which calls `customCommand` back. Without it the command just runs.
   */
  readonly invokeCommand?: (name: string, data: WmlConfig) => Flow<unknown>;
}

/** A request a Lua coroutine yields to `drive`. */
type LuaRequest = { readonly kind: 'flow'; readonly flow: Flow<unknown> };

/** Lua-side support the JS functions below rely on: the action proxy and dialogs. */
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

local callbacks = {}
wesnoth.__gui_callbacks = callbacks
local CALLBACK_KEYS = { on_modified = true, on_button_click = true, on_left_click = true, on_link_click = true, callback = true }
function gui.show_dialog(wml, preshow, postshow)
  local handle = wesnoth.__gui_new(wml)
  local widget
  -- A widget by path (see findGuiWidgetByPath): its properties, else a child widget by id, as upstream's
  -- widget proxies; a listbox also has add_item().
  function widget(id)
    return setmetatable({}, {
      __index = function(_, key)
        if key == "add_item" then
          return function() return widget(id .. "#" .. wesnoth.__gui_add_item(handle, id)) end
        end
        local value = wesnoth.__gui_get(handle, id, key)
        if value ~= nil then return value end
        if wesnoth.__gui_has(handle, id .. "/" .. key) then return widget(id .. "/" .. key) end
        return nil
      end,
      __newindex = function(self, key, value)
        if CALLBACK_KEYS[key] then
          -- Upstream calls a widget's callback with the widget itself.
          callbacks[handle .. "|" .. id .. "|" .. key] = value and function(...) return value(self, ...) end
          wesnoth.__gui_set(handle, id, key, value ~= nil)
        else
          wesnoth.__gui_set(handle, id, key, value)
        end
      end,
    })
  end
  local dialog = setmetatable({
    close = function() wesnoth.__gui_close(handle) end,
    __handle = handle,
  }, { __index = function(_, id) return widget(id) end })
  if preshow then preshow(dialog) end
  local result = wesnoth.__gui_run(handle)
  -- postshow reads the widgets as they were left, before the dialog is gone (window::show's caller).
  if postshow then postshow(dialog) end
  wesnoth.__gui_free(handle)
  for key in pairs(callbacks) do
    if key:sub(1, #tostring(handle) + 1) == handle .. "|" then callbacks[key] = nil end
  end
  return result
end

-- gui.widget.close(window): what dialog:close() does (intf_dialog_close); the window is the dialog table.
gui.widget = gui.widget or {}
function gui.widget.close(window)
  local handle = rawget(window, "__handle")
  if handle then wesnoth.__gui_close(handle) end
end

-- lua_gui2.cpp's show_message_box: a title, the message and the buttons of a style ("" closes on a click,
-- "ok", "close", "cancel", "ok_cancel", "yes_no", or any other text as one button's label), shown as a
-- dialog. ok_cancel and yes_no return whether OK/Yes was chosen.
function gui.show_prompt(title, message, button, markup)
  local _ = wesnoth.textdomain("wesnoth-lib")
  if button ~= nil and type(button) ~= "string" then button, markup = nil, button end
  local style = string.lower(button or "ok")
  local labels
  if style == "" or style == "ok" then labels = { { _ "OK", "ok" } }
  elseif style == "close" then labels = { { _ "Close", "ok" } }
  elseif style == "cancel" then labels = { { _ "Cancel", "cancel" } }
  elseif style == "ok_cancel" then labels = { { _ "OK", "ok" }, { _ "Cancel", "cancel" } }
  elseif style == "yes_no" then labels = { { _ "Yes", "ok" }, { _ "No", "cancel" } }
  else labels = { { button, "ok" } } end
  local T = wml.tag
  local buttons = {}
  for _, b in ipairs(labels) do
    table.insert(buttons, T.column { T.button { id = b[2], label = b[1], return_value_id = b[2] } })
  end
  local rows = {}
  if title ~= nil and tostring(title) ~= "" then
    table.insert(rows, T.row { T.column { T.label { id = "title", definition = "title", label = title, use_markup = markup } } })
  end
  table.insert(rows, T.row { T.column { T.label { id = "label", label = message, use_markup = markup, wrap = true } } })
  table.insert(rows, T.row { T.column { T.grid { T.row(buttons) } } })
  local result = gui.show_dialog { T.grid(rows) }
  if style == "ok_cancel" or style == "yes_no" then return result == -1 end
end
-- core/gui.lua made its deprecated alias from the placeholder this replaces.
wesnoth.show_message_box = wesnoth.deprecate_api('wesnoth.show_message_box', 'gui.show_prompt', 1, nil, gui.show_prompt)
`;

function* openHelpFlow(topic: string): Flow {
  yield { kind: 'beat', beat: { kind: 'openHelp', topic } };
}

interface OpenDialog {
  root: GuiNode;
  closed: boolean;
  retval: number;
}

export class LuaRuntime {
  readonly kernel: LuaKernel;
  readonly units: LuaUnits;
  private readonly L: LuaState;
  /** Engine handlers for tags a campaign's Lua has taken over, as they were before. */
  private readonly natives = new Map<string, ActionHandler | undefined>();
  private readonly dialogs = new Map<number, OpenDialog>();
  private nextDialog = 1;
  private readonly invokeCommand: (name: string, data: WmlConfig) => Flow<unknown>;
  /** Set while the AI runs Lua: flows run on the spot with this responder instead of suspending. */
  private inlineResponder: Responder | null = null;
  private readonly fallbackRng = new RngDeterministic(new MtRng(0));

  constructor(
    private readonly sources: LuaSources,
    /** The event context actions run with (the pump's own, whose fields change per event). */
    private readonly ctx: () => EventContext,
    options: LuaRuntimeOptions,
  ) {
    const host: GameKernelHost = {
      ctx,
      yieldFlow: (T, flow) => this.yieldFlow(T, flow),
      currentSide: options.currentSide ?? (() => ctx().variables.getNumber('side_number', 1)),
    };
    const game = createGameKernel(host, {
      files: { ...options.dataFiles, ...sources.modules },
      log: options.log ?? ((level, message) => ctx().log(level, message)),
      rng: options.rng ?? (() => ctx().rng ?? this.fallbackRng),
      sideAiConfigs: options.sideAiConfigs,
      beforeCore: (k) => this.installFunctions(k),
    });
    this.kernel = game.kernel;
    this.units = game.units;
    this.L = this.kernel.L;
    this.invokeCommand = options.invokeCommand ?? ((name, data) => this.customCommand(name, data));
    this.kernel.run(RUNTIME_LUA_SOURCE, '=runtime');
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

  /**
   * `wml_conditionals.lua` (`[lua]` as a condition), in this kernel: `load(cfg.code, cfg.name)` called with the
   * `[args]` child, passing on a true result. Any error is a fail, logged (`run_wml_conditional`).
   */
  evaluateCondition(cfg: WmlConfig): boolean {
    const L = this.L;
    const top = lua.lua_gettop(L);
    try {
      const code = cfg.getString('code', '');
      const name = cfg.getString('name', '') || code;
      if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(name)) !== lua.LUA_OK) {
        this.ctx().log('error', `[lua] condition: ~lua:${lua.lua_tojsstring(L, -1)}`);
        return false;
      }
      const args = cfg.child('args');
      if (args) this.kernel.pushConfig(L, args);
      else lua.lua_pushnil(L);
      if (lua.lua_pcall(L, 1, 1, 0) !== lua.LUA_OK) {
        this.ctx().log('error', `[lua] condition: ${lua.lua_tojsstring(L, -1)}`);
        return false;
      }
      return lua.lua_toboolean(L, -1);
    } finally {
      lua.lua_settop(L, top);
    }
  }

  /** Whether content has set `wesnoth.game_events[name]` (rather than reading upstream's do-nothing default). */
  hasCallback(name: string): boolean {
    const L = this.L;
    lua.lua_getglobal(L, to_luastring('wesnoth'));
    lua.lua_getfield(L, -1, to_luastring('game_events'));
    lua.lua_pushstring(L, to_luastring(name));
    lua.lua_rawget(L, -2);
    const set = lua.lua_isfunction(L, -1);
    lua.lua_pop(L, 3);
    return set;
  }

  /**
   * `game_lua_kernel::select_hex_callback`/`mouse_over_hex_callback`: the content's `on_mouse_action` or
   * `on_mouse_move` with the hex, run as a flow, since it may open a dialog or fire events.
   */
  *mouseCallbackFlow(name: 'on_mouse_action' | 'on_mouse_move', x: number, y: number): Flow {
    yield* this.runChunk(`wesnoth.game_events.${name}(${Math.trunc(x)}, ${Math.trunc(y)})`, `=${name}`);
  }

  /** Runs a chunk of Lua with `args` as its `...` (the `[lua]` tag). */
  *runChunk(code: string, chunkName: string, args?: WmlConfig): Flow {
    const T = this.newThread();
    try {
      if (lauxlib.luaL_loadbuffer(T.state, to_luastring(code), null, to_luastring(chunkName)) !== lua.LUA_OK) {
        throw new Error(lua.lua_tojsstring(T.state, -1));
      }
      if (args) this.kernel.pushConfig(T.state, args);
      else lua.lua_pushnil(T.state);
      yield* this.drive(T.state, 1);
    } finally {
      this.release(T.ref);
    }
  }

  /** `game_lua_kernel::custom_command`: `wesnoth.custom_synced_commands[name](data)` (a `[custom_command]`, live or replayed). */
  *customCommand(name: string, data: WmlConfig): Flow {
    const T = this.newThread();
    try {
      lua.lua_getglobal(T.state, to_luastring('wesnoth'));
      lua.lua_getfield(T.state, -1, to_luastring('custom_synced_commands'));
      lua.lua_getfield(T.state, -1, to_luastring(name));
      if (lua.lua_type(T.state, -1) !== lua.LUA_TFUNCTION) {
        this.ctx().log('error', `custom command '${name}' is not defined`);
        return;
      }
      lua.lua_replace(T.state, 1);
      lua.lua_settop(T.state, 1);
      this.kernel.pushConfig(T.state, data);
      yield* this.drive(T.state, 1);
    } finally {
      this.release(T.ref);
    }
  }

  /**
   * Runs `fn` with every flow Lua starts run on the spot with `respond` (the AI's turn: its events and
   * dialogs are answered the way the rest of the AI turn's are).
   */
  inline<T>(respond: Responder, fn: () => T): T {
    const previous = this.inlineResponder;
    this.inlineResponder = respond;
    try {
      return fn();
    } finally {
      this.inlineResponder = previous;
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
        const request = this.pendingRequest;
        this.pendingRequest = null;
        lua.lua_settop(T, 0);
        if (!request) throw new Error('Lua yielded outside of a request (coroutine.yield at the top level?)');
        const result = yield* request.flow;
        nargs = this.pushResult(T, result);
        continue;
      }
      if (status === lua.LUA_OK) {
        const results: unknown[] = [];
        for (let i = 1; i <= lua.lua_gettop(T); i++) results.push(this.kernel.toScalar(T, i) ?? this.kernel.toConfig(T, i));
        lua.lua_settop(T, 0);
        return results;
      }
      const message = lua.lua_isstring(T, -1) ? lua.lua_tojsstring(T, -1) : String(lua.lua_typename(T, lua.lua_type(T, -1)));
      lauxlib.luaL_traceback(T, T, null, 0);
      const trace = lua.lua_tojsstring(T, -1);
      lua.lua_settop(T, 0);
      throw new Error(`${message}\n${trace}`);
    }
  }

  private pendingRequest: LuaRequest | null = null;

  /** Suspends the running coroutine on `flow` (call as a JS function's `return`), or runs it now when inline. */
  private yieldFlow(T: LuaState, flow: Flow<unknown>): number {
    if (this.inlineResponder) return this.pushResult(T, runFlow(flow, this.inlineResponder));
    this.pendingRequest = { kind: 'flow', flow };
    return lua.lua_yield(T, 0);
  }

  private pushResult(T: LuaState, result: unknown): number {
    if (result === undefined) return 0;
    if (result instanceof WmlConfig) this.kernel.pushConfig(T, result);
    else this.kernel.pushScalar(T, result as string | number | boolean | TString);
    return 1;
  }

  /**
   * Runs a Lua action a campaign defined: `wesnoth.wml_actions[tag](cfg)`, `cfg` being the action's config as
   * written, wrapped as a vconfig that substitutes `$variables` as it is read (`handle_event_commands`).
   */
  private *runLuaAction(tag: string, cfg: WmlConfig): Flow {
    const T = this.newThread();
    try {
      lua.lua_getglobal(T.state, to_luastring('wesnoth'));
      lua.lua_getfield(T.state, -1, to_luastring('__lua_actions'));
      lua.lua_getfield(T.state, -1, to_luastring(tag));
      lua.lua_replace(T.state, 1);
      lua.lua_settop(T.state, 1);
      this.kernel.pushUserdata(T.state, VCONFIG_KEY, { cfg });
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

  // --- the runtime's own API ---

  private installFunctions(k: LuaKernel): void {
    // wesnoth.sync.invoke_command: a synced `[custom_command]`.
    k.define(['wesnoth', 'sync', 'invoke_command'], (T) => {
      const name = checkString(T, 1);
      const data = k.checkConfig(T, 2);
      return this.yieldFlow(T, this.invokeCommand(name, data));
    });

    // wml.load: the preprocessed files the snapshot carries.
    k.define(['wml', 'load'], (T) => {
      const path = normalisePath(lua.lua_tojsstring(T, 1));
      const json = this.sources.wml[path];
      if (!json) return lauxlib.luaL_error(T, to_luastring(`wml.load: '${path}' is not available`));
      k.pushConfig(T, WmlConfig.fromJSON(json));
      return 1;
    });

    k.define(['wesnoth', '__native_action'], (T) => {
      const tag = lua.lua_tojsstring(T, 1);
      const handler = this.natives.has(tag) ? this.natives.get(tag) : this.ctx().registry.get(tag);
      if (!handler) return 0;
      lua.lua_pushcfunction(T, (U: LuaState) => {
        const ctx = this.ctx();
        // A vconfig reaches the native as the event pump would have passed it; a plain table is literal values.
        const vconfig = k.userdata<{ cfg: WmlConfig }>(U, 1, VCONFIG_KEY);
        const cfg = !vconfig ? k.checkConfig(U, 1) : wantsRawConfig(tag, handler) ? vconfig.cfg : ctx.variables.expandConfig(vconfig.cfg);
        const result = handler(cfg, ctx);
        return isFlow(result) ? this.yieldFlow(U, result) : 0;
      });
      return 1;
    });
    k.define(['wesnoth', '__register_action'], (T) => {
      const tag = lua.lua_tojsstring(T, 1);
      const registry = this.ctx().registry;
      if (!this.natives.has(tag)) this.natives.set(tag, registry.get(tag));
      if (lua.lua_toboolean(T, 2)) registry.register(tag, Object.assign((cfg: WmlConfig) => this.runLuaAction(tag, cfg), { rawConfig: true }));
      else {
        const native = this.natives.get(tag);
        if (native) registry.register(tag, native);
      }
      return 0;
    });

    // gui.show_dialog's JS half: the dialog model, its widgets, and the wait for the player.
    k.define(['wesnoth', '__gui_new'], (T) => {
      const handle = this.nextDialog++;
      this.dialogs.set(handle, { root: buildGuiDialog(k.checkConfig(T, 1)).root, closed: false, retval: GUI_RETVAL.NONE });
      lua.lua_pushinteger(T, handle);
      return 1;
    });
    k.define(['wesnoth', '__gui_get'], (T) => {
      const widget = this.widget(T);
      if (!widget) return 0;
      const key = lua.lua_tojsstring(T, 3);
      if (key === 'visible') lua.lua_pushboolean(T, widget.visibility === 'visible');
      else if (key === 'selected_index' && widget.type === 'listbox') lua.lua_pushinteger(T, widget.selectedIndex);
      else if (key === 'label' && 'label' in widget) {
        const label = widget.label;
        if (typeof label === 'string') lua.lua_pushstring(T, to_luastring(label));
        else k.pushTString(T, TString.fromJSON(label));
      } else if (key === 'id') lua.lua_pushstring(T, to_luastring(widget.id));
      else if (key === 'item_count' && widget.type === 'listbox') lua.lua_pushinteger(T, widget.rows.length);
      else if (key === 'selected_index' && widget.type === 'menu_button') lua.lua_pushinteger(T, widget.selectedIndex);
      else if (key === 'enabled' && (widget.type === 'button' || widget.type === 'menu_button')) lua.lua_pushboolean(T, widget.enabled);
      else if (key === 'type') lua.lua_pushstring(T, to_luastring(widget.type === 'panel' ? 'toggle_panel' : widget.type));
      else if (key === 'use_markup' && (widget.type === 'label' || widget.type === 'button')) lua.lua_pushboolean(T, widget.markup);
      else return 0;
      return 1;
    });
    k.define(['wesnoth', '__gui_set'], (T) => {
      const widget = this.widget(T);
      const key = lua.lua_tojsstring(T, 3);
      if (!widget) return lauxlib.luaL_error(T, to_luastring(`gui: no widget '${lua.lua_tojsstring(T, 2)}'`));
      if (key === 'visible') {
        if (lua.lua_type(T, 4) === lua.LUA_TBOOLEAN) widget.visibility = lua.lua_toboolean(T, 4) ? 'visible' : 'invisible';
        else {
          const v = lua.lua_tojsstring(T, 4);
          widget.visibility = v === 'hidden' || v === 'invisible' ? v : 'visible';
        }
      } else if (key === 'selected_index' && (widget.type === 'listbox' || widget.type === 'menu_button')) widget.selectedIndex = Number(lua.lua_tointeger(T, 4));
      else if (key === 'enabled' && (widget.type === 'button' || widget.type === 'menu_button')) widget.enabled = lua.lua_toboolean(T, 4);
      else if (key === 'label' && (widget.type === 'label' || widget.type === 'button')) {
        const ts = k.tstringAt(T, 4);
        widget.label = ts ? (ts.translatable ? ts.toJSON() : ts.str()) : luaString(T, 4);
      } else if (key === 'label' && widget.type === 'image') widget.label = luaString(T, 4);
      else if (key === 'use_markup' && (widget.type === 'label' || widget.type === 'button')) widget.markup = lua.lua_toboolean(T, 4);
      else if (!['on_modified', 'on_button_click', 'on_left_click', 'on_link_click', 'callback', 'tooltip', 'enabled'].includes(key)) {
        this.ctx().log('warn', `gui: widget property '${key}' is not supported (ignored)`);
      }
      return 0;
    });
    k.define(['wesnoth', '__gui_add_item'], (T) => {
      const widget = this.widget(T);
      if (widget?.type !== 'listbox') return lauxlib.luaL_error(T, to_luastring(`gui: '${lua.lua_tojsstring(T, 2)}' is not a listbox`));
      lua.lua_pushinteger(T, addListboxRow(widget));
      return 1;
    });
    k.define(['wesnoth', '__gui_has'], (T) => {
      lua.lua_pushboolean(T, this.widget(T) !== undefined);
      return 1;
    });
    k.define(['wesnoth', '__gui_free'], (T) => {
      this.dialogs.delete(Number(lua.lua_tointeger(T, 1)));
      return 0;
    });
    k.define(['wesnoth', '__gui_close'], (T) => {
      const dialog = this.dialogs.get(Number(lua.lua_tointeger(T, 1)));
      if (dialog) dialog.closed = true;
      return 0;
    });
    k.define(['wesnoth', '__gui_run'], (T) => this.yieldFlow(T, this.dialogFlow(Number(lua.lua_tointeger(T, 1)))));
    // Phase 24: `gui.show_help(topic)` (`lua_gui2.cpp`): the help browser, until the player closes it.
    k.define(['gui', 'show_help'], (T) => {
      const topic = lua.lua_isnoneornil(T, 1) ? '' : checkString(T, 1);
      return this.yieldFlow(T, openHelpFlow(topic));
    });
  }

  private widget(T: LuaState): GuiNode | undefined {
    const dialog = this.dialogs.get(Number(lua.lua_tointeger(T, 1)));
    return dialog ? findGuiWidgetByPath(dialog.root, lua.lua_tojsstring(T, 2)) : undefined;
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
          if (widget?.type === 'listbox' || widget?.type === 'menu_button') widget.selectedIndex = Number(selection[2]);
          yield* this.runCallback(`${handle}|${selection[1]}|on_modified`);
          continue;
        }
        // A button: its on_button_click runs first (it may close the dialog itself, as gui.widget.close does);
        // then a button with a return value closes it with that, and one without (0) leaves it open.
        const click = /^click:(.*)$/.exec(answer.text ?? '');
        if (click) {
          yield* this.runCallback(`${handle}|${click[1]}|on_button_click`);
          if (dialog.closed) break;
          if ((answer.value ?? 0) === GUI_RETVAL.NONE) continue;
        }
        dialog.retval = answer.value ?? GUI_RETVAL.CANCEL;
        dialog.closed = true;
      }
      return dialog.retval;
    } finally {
      // Kept until gui.show_dialog's postshow has run (`__gui_free`).
      dialog.closed = true;
    }
  }
}

function normalisePath(path: string): string {
  return path.replace(/^~?\/?/, '').replace(/^data\//, '');
}

/** `lua_tostring`-like text of any value (booleans as yes/no, as WML). */
function luaString(T: LuaState, idx: number): string {
  if (lua.lua_type(T, idx) === lua.LUA_TBOOLEAN) return lua.lua_toboolean(T, idx) ? 'yes' : 'no';
  lauxlib.luaL_tolstring(T, idx);
  const s = lua.lua_tojsstring(T, -1);
  lua.lua_pop(T, 1);
  return s;
}
