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
 * `wml.load` (files the snapshot carries, preprocessed at build time) and `gui.show_dialog`
 * (`guiDialog.ts`). Everything else is the kernel's.
 */
import { WmlConfig, type WmlConfigJson } from '@wesnothweb2/engine/src/wml/config.js';
import { TString } from '@wesnothweb2/engine/src/i18n/tstring.js';
import type { ActionHandler, EventContext } from '@wesnothweb2/engine/src/events/context.js';
import { isFlow, runFlow, type Flow, type InteractionResult, type Responder } from '@wesnothweb2/engine/src/events/interaction.js';
import { buildGuiDialog, findGuiWidget, GUI_RETVAL, type GuiDialogSpec, type GuiNode } from '@wesnothweb2/engine/src/events/guiDialog.js';
import type { Rng } from '@wesnothweb2/engine/src/rng/Rng.js';
import { MtRng } from '@wesnothweb2/engine/src/rng/MtRng.js';
import { RngDeterministic } from '@wesnothweb2/engine/src/rng/RngDeterministic.js';
import { lua, lauxlib, to_luastring, type LuaState } from './luaEnv.js';
import { createGameKernel, type LuaKernel, type LuaUnits, type VirtualDataDir } from './kernel/index.js';
import { checkString } from './kernel/kernel.js';
import type { GameKernelHost } from './kernel/game/host.js';

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

  /** Runs a Lua action a campaign defined: `wesnoth.wml_actions[tag](cfg)`, with the action's config as a vconfig. */
  private *runLuaAction(tag: string, cfg: WmlConfig): Flow {
    const T = this.newThread();
    try {
      lua.lua_getglobal(T.state, to_luastring('wesnoth'));
      lua.lua_getfield(T.state, -1, to_luastring('__lua_actions'));
      lua.lua_getfield(T.state, -1, to_luastring(tag));
      lua.lua_replace(T.state, 1);
      lua.lua_settop(T.state, 1);
      this.kernel.pushConfig(T.state, cfg);
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
        const result = handler(k.checkConfig(U, 1), ctx);
        return isFlow(result) ? this.yieldFlow(U, result) : 0;
      });
      return 1;
    });
    k.define(['wesnoth', '__register_action'], (T) => {
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
      } else if (key === 'selected_index' && widget.type === 'listbox') widget.selectedIndex = Number(lua.lua_tointeger(T, 4));
      else if (key === 'label' && (widget.type === 'label' || widget.type === 'button')) {
        const ts = k.tstringAt(T, 4);
        widget.label = ts ? (ts.translatable ? ts.toJSON() : ts.str()) : luaString(T, 4);
      } else if (key === 'label' && widget.type === 'image') widget.label = luaString(T, 4);
      else if (!['on_modified', 'on_button_click', 'on_left_click', 'callback', 'tooltip', 'enabled'].includes(key)) {
        this.ctx().log('warn', `gui: widget property '${key}' is not supported (ignored)`);
      }
      return 0;
    });
    k.define(['wesnoth', '__gui_close'], (T) => {
      const dialog = this.dialogs.get(Number(lua.lua_tointeger(T, 1)));
      if (dialog) dialog.closed = true;
      return 0;
    });
    k.define(['wesnoth', '__gui_run'], (T) => this.yieldFlow(T, this.dialogFlow(Number(lua.lua_tointeger(T, 1)))));
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

/** `lua_tostring`-like text of any value (booleans as yes/no, as WML). */
function luaString(T: LuaState, idx: number): string {
  if (lua.lua_type(T, idx) === lua.LUA_TBOOLEAN) return lua.lua_toboolean(T, idx) ? 'yes' : 'no';
  lauxlib.luaL_tolstring(T, idx);
  const s = lua.lua_tojsstring(T, -1);
  lua.lua_pop(T, 1);
  return s;
}
