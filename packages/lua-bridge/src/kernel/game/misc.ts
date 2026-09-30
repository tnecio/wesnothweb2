/**
 * The rest of the game kernel's API (`game_lua_kernel.cpp`, `lua_common.cpp`): the `"wml object"` userdata
 * (vconfig -- a WML table whose attributes are `$`-substituted against the game's variables when read),
 * `wml.tovconfig`/`get_variable`/`set_variable`/`get_all_vars`, `wesnoth.sync`, `wesnoth.interface`,
 * `wesnoth.game_events`, and the tables the core files expect (`wml_actions`, `wml_conditionals`, `effects`,
 * `custom_synced_commands`). What is not ported is installed as named "not available" functions.
 */
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import type { Flow } from '@wesnothweb2/engine/src/events/interaction.js';
import {
  argError,
  checkString,
  lua,
  lauxlib,
  pushString,
  pushStringArray,
  to_luastring,
  type LuaCFunction,
  type LuaKernel,
  type LuaState,
} from '../kernel.js';
import type { GameKernelHost } from './host.js';

export const VCONFIG_KEY = 'wml object';

/** A vconfig: the literal config, read through the game's variables. */
interface VConfig {
  readonly cfg: WmlConfig;
}

export function installMisc(k: LuaKernel, host: GameKernelHost): void {
  const L = k.L;
  const ctx = () => host.ctx();
  const expand = (value: ReturnType<WmlConfig['getRaw']>) => (typeof value === 'string' ? ctx().variables.substitute(value) : value);

  /** `vconfig::get_parsed_config`: every attribute substituted, recursively. */
  const parsed = (cfg: WmlConfig): WmlConfig => {
    const out = new WmlConfig();
    for (const key of cfg.attributeNames()) out.setAttribute(key, expand(cfg.getRaw(key))!);
    for (const { tag, config } of cfg.allChildren()) out.addChild(tag, parsed(config));
    return out;
  };
  const pushVConfig = (T: LuaState, cfg: WmlConfig): void => k.pushUserdata(T, VCONFIG_KEY, { cfg } satisfies VConfig);
  k.userdataToConfig = (T, idx) => {
    const v = k.userdata<VConfig>(T, idx, VCONFIG_KEY);
    return v ? parsed(v.cfg) : undefined;
  };

  lauxlib.luaL_newmetatable(L, to_luastring(VCONFIG_KEY));
  setFuncs(L, {
    __index: (T) => {
      const v = k.userdata<VConfig>(T, 1, VCONFIG_KEY)!;
      const children = v.cfg.allChildren();
      if (lua.lua_isnumber(T, 2)) {
        const pos = Number(lua.lua_tointeger(T, 2)) - 1;
        const child = children[pos];
        if (!child) return 0;
        k.pushNamedTuple(T, ['tag', 'contents']);
        pushString(T, child.tag);
        lua.lua_rawseti(T, -2, 1);
        pushVConfig(T, child.config);
        lua.lua_rawseti(T, -2, 2);
        return 1;
      }
      const m = checkString(T, 2);
      if (m === '__literal') {
        k.pushConfig(T, v.cfg);
        return 1;
      }
      if (m === '__parsed') {
        k.pushConfig(T, parsed(v.cfg));
        return 1;
      }
      if (m === '__shallow_literal' || m === '__shallow_parsed') {
        const literal = m === '__shallow_literal';
        lua.lua_createtable(T, children.length, 0);
        for (const key of v.cfg.attributeNames()) {
          k.pushScalar(T, literal ? v.cfg.getRaw(key) : expand(v.cfg.getRaw(key)));
          lua.lua_setfield(T, -2, to_luastring(key));
        }
        children.forEach((c, j) => {
          k.pushNamedTuple(T, ['tag', 'contents']);
          pushString(T, c.tag);
          lua.lua_rawseti(T, -2, 1);
          pushVConfig(T, c.config);
          lua.lua_rawseti(T, -2, 2);
          lua.lua_rawseti(T, -2, j + 1);
        });
        return 1;
      }
      if (!v.cfg.hasAttribute(m)) return 0;
      k.pushScalar(T, expand(v.cfg.getRaw(m)));
      return 1;
    },
    __len: (T) => {
      lua.lua_pushinteger(T, k.userdata<VConfig>(T, 1, VCONFIG_KEY)!.cfg.allChildren().length);
      return 1;
    },
    __pairs: (T) => {
      const v = k.userdata<VConfig>(T, 1, VCONFIG_KEY)!;
      const keys = v.cfg.attributeNames();
      let i = 0;
      lua.lua_pushcfunction(T, (U: LuaState) => {
        const key = keys[i++];
        if (key === undefined) return 0;
        pushString(U, key);
        k.pushScalar(U, expand(v.cfg.getRaw(key)));
        return 2;
      });
      lua.lua_pushvalue(T, 1);
      return 2;
    },
    __dir: (T) => {
      pushStringArray(T, k.userdata<VConfig>(T, 1, VCONFIG_KEY)!.cfg.attributeNames());
      return 1;
    },
  });
  pushString(L, VCONFIG_KEY);
  lua.lua_setfield(L, -2, to_luastring('__metatable'));
  lua.lua_pop(L, 1);

  // The game's variables (`luaW_pushvariable`/`luaW_checkvariable`): an attribute as a scalar, a container as
  // its (first) table.
  const pushVariable = (T: LuaState, name: string): number => {
    const store = ctx().variables;
    const raw = store.getRaw(name);
    if (raw !== undefined) {
      k.pushScalar(T, raw);
      return 1;
    }
    if (!store.getContainerNode(name)) return 0;
    const cfg = store.getConfig(name) ?? new WmlConfig();
    k.pushConfig(T, cfg);
    return 1;
  };
  k.defineAll(['wml'], {
    tovconfig: (T) => {
      const existing = k.userdata<VConfig>(T, 1, VCONFIG_KEY);
      pushVConfig(T, existing ? existing.cfg : k.checkConfig(T, 1));
      return 1;
    },
    get_variable: (T) => pushVariable(T, checkString(T, 1)),
    set_variable: (T) => {
      const name = checkString(T, 1);
      if (name === '') return argError(T, 1, 'empty variable name');
      const store = ctx().variables;
      if (lua.lua_isnoneornil(T, 2)) {
        store.clear(name);
        return 0;
      }
      const scalar = k.toScalar(T, 2);
      if (scalar !== undefined) store.set(name, scalar);
      else store.setConfig(name, k.checkConfig(T, 2));
      return 0;
    },
    get_all_vars: (T) => {
      k.pushConfig(T, ctx().variables.toConfig());
      return 1;
    },
  });
  k.unported(['wml', 'eval_conditional']);

  // wesnoth.sync: single player, so a choice is this client's own.
  k.defineAll(['wesnoth', 'sync'], {
    evaluate_single: (T) => {
      const f = lua.lua_isfunction(T, 1) ? 1 : 2;
      lua.lua_settop(T, f);
      lua.lua_callk(T, 0, 1, 0, () => 1);
      return 1;
    },
    run_unsynced: (T) => {
      lua.lua_settop(T, 1);
      lua.lua_callk(T, 0, 0, 0, () => 0);
      return 0;
    },
  });
  for (const name of ['invoke_command', 'evaluate_multiple']) k.unported(['wesnoth', 'sync', name]);

  // wesnoth.interface: there is no display for Lua to drive yet; what the AI and the ported campaigns call is here.
  k.defineAll(['wesnoth', 'interface'], {
    handle_user_interact: () => 0,
    skip_messages: (T) => {
      ctx().skipMessages = lua.lua_isnone(T, 1) ? true : lua.lua_toboolean(T, 1);
      return 0;
    },
    is_skipping_messages: (T) => {
      lua.lua_pushboolean(T, ctx().skipMessages);
      return 1;
    },
    get_viewing_side: (T) => {
      lua.lua_pushinteger(T, host.currentSide());
      lua.lua_pushboolean(T, false);
      return 2;
    },
    add_chat_message: (T) => {
      const n = lua.lua_gettop(T);
      k.log('info', `chat: ${n >= 2 ? `${k.checkTString(T, 1).str()}: ${k.checkTString(T, 2).str()}` : k.checkTString(T, 1).str()}`);
      return 0;
    },
  });
  for (const name of [
    'add_hex_overlay', 'remove_hex_overlay', 'get_color_adjust', 'color_adjust', 'screen_fade', 'delay', 'deselect_hex',
    'highlight_hex', 'float_label', 'get_displayed_unit', 'get_hovered_hex', 'get_selected_hex', 'lock', 'is_locked',
    'scroll', 'scroll_to_hex', 'zoom', 'clear_menu_item', 'set_menu_item', 'allow_end_turn', 'clear_chat_messages',
    'end_turn', 'add_overlay_text',
  ]) {
    k.unported(['wesnoth', 'interface', name]);
  }

  // wesnoth.game_events.fire: runs the event now (the engine's flow), suspending the calling coroutine.
  k.define(['wesnoth', 'game_events', 'fire'], (T) => {
    const name = checkString(T, 1);
    const loc = (i: number): Location =>
      lua.lua_type(T, i) === lua.LUA_TNUMBER && lua.lua_type(T, i + 1) === lua.LUA_TNUMBER
        ? Location.fromWml(Number(lua.lua_tointeger(T, i)), Number(lua.lua_tointeger(T, i + 1)))
        : Location.NULL;
    const c = ctx();
    const flow = (function* (): Flow<boolean> {
      yield* c.fireNow(name, loc(2), loc(4));
      return true;
    })();
    return host.yieldFlow(T, flow);
  });
  for (const name of ['add', 'add_repeating', 'add_menu', 'add_wml', 'remove', 'fire_by_id', 'add_undo_actions', 'set_undoable']) {
    k.unported(['wesnoth', 'game_events', name]);
  }

  for (const table of ['wml_actions', 'wml_conditionals', 'effects', 'custom_synced_commands', 'persistent_tags']) {
    k.pushTablePath(['wesnoth', table]);
    lua.lua_pop(L, 1);
  }
  k.define(['wesnoth', 'redraw'], () => 0);
  for (const name of ['add_known_unit', 'get_era', 'get_resource', 'modify_ai', 'cancel_action', 'log_replay']) k.unported(['wesnoth', name]);
  k.unported(['wesnoth', 'audio', 'play']);
  for (const name of ['set', 'has', 'get', 'progress', 'has_sub_achievement', 'set_sub_achievement']) k.unported(['wesnoth', 'achievements', name]);
  for (const name of [
    'show_inspector', 'show_recruit_dialog', 'show_recall_dialog', 'show_dialog', 'show_menu', 'show_narration', 'show_popup',
    'show_story', 'show_prompt', 'show_lua_console', 'add_widget_definition', 'show_help',
  ]) {
    k.unported(['gui', name]);
  }
  // `wesnoth.interface.game_display`: the theme's report items; none are drawn from Lua here.
  k.pushTablePath(['wesnoth', 'interface', 'game_display']);
  lua.lua_pop(L, 1);
  // The AI module replaces these when an AI is attached.
  for (const name of ['add_ai_component', 'delete_ai_component', 'change_ai_component']) k.unported(['wesnoth', 'sides', name]);
}

function setFuncs(L: LuaState, fns: Readonly<Record<string, LuaCFunction>>): void {
  for (const [name, fn] of Object.entries(fns)) {
    lua.lua_pushcfunction(L, fn);
    lua.lua_setfield(L, -2, to_luastring(name));
  }
}
