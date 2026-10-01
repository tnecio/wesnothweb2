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
import { conditionalPassed } from '@wesnothweb2/engine/src/events/conditionalWml.js';
import {
  FLOATING_LABEL_COLOR,
  OVERLAY_TEXT_SIZE,
  nextOverlayLabelId,
  parseHexColor,
  parseRgbString,
  type OverlayFloatingLabel,
  type RgbColor,
} from '@wesnothweb2/engine/src/events/floatingLabels.js';
import {
  argError,
  checkString,
  tableGet,
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
import type { LuaUnits } from './units.js';

export const VCONFIG_KEY = 'wml object';

/** A vconfig: the literal config, read through the game's variables. */
interface VConfig {
  readonly cfg: WmlConfig;
}

export function installMisc(k: LuaKernel, host: GameKernelHost, units: LuaUnits): void {
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
  // `intf_eval_conditional`: `game_events::conditional_passed` over a vconfig (substituted as it is read).
  k.define(['wml', 'eval_conditional'], (T) => {
    const existing = k.userdata<VConfig>(T, 1, VCONFIG_KEY);
    const c = ctx();
    lua.lua_pushboolean(T, conditionalPassed(c.variables.expandConfig(existing ? existing.cfg : k.checkConfig(T, 1)), c));
    return 1;
  });

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
  installFloatingLabels(k, host);
  // `intf_select_unit(loc, highlight = true, fire_event)`, which upstream registers as `wesnoth.units.select`
  // (`core/interface.lua` makes it `wesnoth.interface.select_unit` too): under a command_disabler, so no select event.
  k.define(['wesnoth', 'units', 'select'], (T) => {
    if (lua.lua_isnoneornil(T, 1)) {
      ctx().selectHex?.(null, false);
      return 0;
    }
    const { loc, next } = locationArgs(k, T, 1);
    if (!ctx().board.map.onBoard(loc)) return argError(T, 1, 'not on board');
    ctx().selectHex?.(loc, lua.lua_isnoneornil(T, next) ? true : lua.lua_toboolean(T, next));
    return 0;
  });
  k.defineAll(['wesnoth', 'interface'], {
    // `intf_get_displayed_unit`: the unit the side panel shows, if any.
    get_displayed_unit: (T) => {
      const unit = ctx().displayedUnit?.();
      if (!unit) return 0;
      units.push(T, unit);
      return 1;
    },
    // `intf_scroll_to_tile(loc, check_fogged, immediate, only_if_needed)`: the `[scroll_to]` beat.
    scroll_to_hex: (T) => {
      const { loc, next } = locationArgs(k, T, 1);
      if (lua.lua_toboolean(T, next) && ctx().board.isFogged(host.currentSide(), loc)) return 0;
      const beat = { kind: 'scrollTo' as const, location: loc, immediate: lua.lua_toboolean(T, next + 1), onlyIfNeeded: lua.lua_toboolean(T, next + 2), highlight: false };
      return host.yieldFlow(
        T,
        (function* (): Flow {
          yield { kind: 'beat', beat };
        })(),
      );
    },
  });
  for (const name of [
    'add_hex_overlay', 'remove_hex_overlay', 'get_color_adjust', 'color_adjust', 'screen_fade', 'delay', 'deselect_hex',
    'highlight_hex', 'get_hovered_hex', 'get_selected_hex', 'lock', 'is_locked',
    'scroll', 'zoom', 'clear_menu_item', 'set_menu_item', 'allow_end_turn', 'clear_chat_messages',
    'end_turn',
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

const FLOATING_LABEL_KEY = 'floating label';

/** A floating label's handle (`luaW_check_floating_label`): its id, 0 once removed. */
interface LabelHandle {
  id: number;
}

/**
 * C1: `wesnoth.interface.float_label` (`intf_float_label`) and `add_overlay_text` (`intf_set_floating_label`),
 * through the engine's `EventContext.floatLabel` (`floatingLabels.ts`).
 */
function installFloatingLabels(k: LuaKernel, host: GameKernelHost): void {
  const L = k.L;
  const ctx = () => host.ctx();

  /** A colour option: `#rrggbb`, `{r, g, b}` as an array, or a table with `r`/`g`/`b` keys. */
  const readColor = (T: LuaState, idx: number, what: string): RgbColor => {
    if (lua.lua_type(T, idx) === lua.LUA_TSTRING) {
      const parsed = parseHexColor(lua.lua_tojsstring(T, idx));
      if (!parsed) return argError(T, idx, `invalid ${what}`);
      return parsed;
    }
    const channel = (key: string | number): number | undefined => {
      if (typeof key === 'number') lua.lua_rawgeti(T, idx, key);
      else lua.lua_getfield(T, idx, to_luastring(key));
      const v = lua.lua_isnumber(T, -1) ? Number(lua.lua_tointeger(T, -1)) : undefined;
      lua.lua_pop(T, 1);
      return v;
    };
    const arr = [channel(1), channel(2), channel(3)];
    if (arr.every((c) => c !== undefined)) return { r: arr[0]!, g: arr[1]!, b: arr[2]! };
    const named = [channel('r'), channel('g'), channel('b')];
    if (named.every((c) => c !== undefined)) return { r: named[0]!, g: named[1]!, b: named[2]! };
    return lauxlib.luaL_error(T, to_luastring(`floating label ${what} should be a hex string, an array of 3 integers, or a table with r,g,b keys`)) as never;
  };

  /** `intf_set_floating_label`: (re)creates `handle`'s label from the text at `idx` and the options after it. */
  const setLabel = (T: LuaState, handle: LabelHandle, idx: number): void => {
    const text = k.checkTString(T, idx);
    const opts = idx + 1;
    let size = OVERLAY_TEXT_SIZE;
    let color = FLOATING_LABEL_COLOR;
    let bgcolor: (RgbColor & { a: number }) | undefined;
    let duration = 2000;
    let fadeTime = 100;
    let x = 0;
    let y = 0;
    let halign: OverlayFloatingLabel['halign'] = 'center';
    let valign: OverlayFloatingLabel['valign'] = 'center';
    let maxWidth: OverlayFloatingLabel['maxWidth'];
    if (lua.lua_istable(T, opts)) {
      if (tableGet(T, opts, 'size')) {
        size = Number(lauxlib.luaL_checkinteger(T, -1));
        lua.lua_pop(T, 1);
      }
      if (tableGet(T, opts, 'max_width')) {
        if (lua.lua_isinteger(T, -1)) maxWidth = { px: Number(lua.lua_tointeger(T, -1)) };
        else {
          const value = lua.lua_tojsstring(T, -1) ?? '';
          const pct = /^(\d+)%$/.exec(value);
          if (!pct) return void argError(T, -1, 'max_width should be integer or percentage');
          maxWidth = { ratio: Number(pct[1]) / 100 };
        }
        lua.lua_pop(T, 1);
      }
      if (tableGet(T, opts, 'color')) {
        color = readColor(T, lua.lua_gettop(T), 'text color');
        lua.lua_pop(T, 1);
      }
      if (tableGet(T, opts, 'bgcolor')) {
        bgcolor = { ...readColor(T, lua.lua_gettop(T), 'background color'), a: 255 };
        lua.lua_pop(T, 1);
        if (tableGet(T, opts, 'bgalpha')) {
          bgcolor = { ...bgcolor, a: Number(lauxlib.luaL_checkinteger(T, -1)) };
          lua.lua_pop(T, 1);
        }
      }
      if (tableGet(T, opts, 'duration')) {
        if (lua.lua_isinteger(T, -1)) duration = Number(lua.lua_tointeger(T, -1));
        else if (lua.lua_tojsstring(T, -1) === 'unlimited') duration = -1;
        else return void argError(T, -1, "duration should be integer or 'unlimited'");
        lua.lua_pop(T, 1);
      }
      if (tableGet(T, opts, 'fade_time')) {
        fadeTime = Number(lua.lua_tointeger(T, -1));
        lua.lua_pop(T, 1);
      }
      if (tableGet(T, opts, 'location')) {
        const loc = k.checkLocation(T, lua.lua_gettop(T));
        x = loc.wmlX;
        y = loc.wmlY;
        lua.lua_pop(T, 1);
      }
      if (tableGet(T, opts, 'halign')) {
        const v = checkString(T, -1);
        if (v !== 'left' && v !== 'center' && v !== 'right') return void argError(T, -1, `invalid option '${v}'`);
        halign = v;
        lua.lua_pop(T, 1);
      }
      if (tableGet(T, opts, 'valign')) {
        const v = checkString(T, -1);
        if (v !== 'top' && v !== 'center' && v !== 'bottom') return void argError(T, -1, `invalid option '${v}'`);
        valign = v;
        lua.lua_pop(T, 1);
      }
    }
    const c = ctx();
    if (handle.id !== 0) c.floatLabel?.({ kind: 'removeOverlay', id: handle.id });
    handle.id = nextOverlayLabelId(c);
    c.floatLabel?.({ kind: 'overlay', id: handle.id, text, size, color, bgcolor, duration, fadeTime, halign, valign, x, y, maxWidth });
  };

  lauxlib.luaL_newmetatable(L, to_luastring(FLOATING_LABEL_KEY));
  setFuncs(L, {
    __index: (T) => {
      const handle = k.userdata<LabelHandle>(T, 1, FLOATING_LABEL_KEY)!;
      const m = checkString(T, 2);
      if (m === 'valid') {
        lua.lua_pushboolean(T, handle.id !== 0);
        return 1;
      }
      lua.lua_getmetatable(T, 1);
      lua.lua_getfield(T, -1, to_luastring(m));
      return 1;
    },
    remove: (T) => {
      const handle = k.userdata<LabelHandle>(T, 1, FLOATING_LABEL_KEY);
      if (!handle) return argError(T, 1, 'floating label expected');
      if (handle.id !== 0) ctx().floatLabel?.({ kind: 'removeOverlay', id: handle.id });
      handle.id = 0;
      return 0;
    },
    move: (T) => {
      if (!k.userdata<LabelHandle>(T, 1, FLOATING_LABEL_KEY)) return argError(T, 1, 'floating label expected');
      k.log('debug', 'floating label:move is not drawn in this port (the label stays where it is)');
      return 0;
    },
    replace: (T) => {
      const handle = k.userdata<LabelHandle>(T, 1, FLOATING_LABEL_KEY);
      if (!handle) return argError(T, 1, 'floating label expected');
      setLabel(T, handle, 2);
      lua.lua_settop(T, 1);
      return 1;
    },
  });
  lua.lua_pop(L, 1);

  k.defineAll(['wesnoth', 'interface'], {
    // `float_label(loc, text, color)` or, as `luaW_tolocation` reads two numbers, `float_label(x, y, text, color)`.
    float_label: (T) => {
      const { loc, next } = locationArgs(k, T, 1);
      const text = k.checkTString(T, next);
      let color = FLOATING_LABEL_COLOR;
      if (!lua.lua_isnoneornil(T, next + 1)) {
        const parsed = parseRgbString(checkString(T, next + 1));
        if (!parsed) return argError(T, next + 1, 'invalid color');
        color = parsed;
      }
      ctx().floatLabel?.({ kind: 'hex', loc, text, color });
      return 0;
    },
    add_overlay_text: (T) => {
      const handle: LabelHandle = { id: 0 };
      setLabel(T, handle, 1);
      k.pushUserdata(T, FLOATING_LABEL_KEY, handle);
      return 1;
    },
  });
}

/**
 * `luaW_checklocation(L, idx)` as upstream reads it: a location table, or two numbers -- of which upstream
 * removes the first from the stack, so the arguments after it are one place earlier. Returns the location and
 * where the next argument is.
 */
function locationArgs(k: LuaKernel, T: LuaState, idx: number): { loc: Location; next: number } {
  if (lua.lua_type(T, idx) === lua.LUA_TNUMBER && lua.lua_type(T, idx + 1) === lua.LUA_TNUMBER) {
    return { loc: Location.fromWml(Number(lua.lua_tointeger(T, idx)), Number(lua.lua_tointeger(T, idx + 1))), next: idx + 2 };
  }
  return { loc: k.checkLocation(T, idx), next: idx + 1 };
}
