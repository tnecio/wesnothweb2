/**
 * `[lua]` as a WML condition (`data/lua/wml-conditionals.lua`'s
 * `wml_conditionals.lua`): `load(cfg.code, cfg.name)` run with the
 * `[args]` child, passing if it returns a Lua-true value (anything but
 * `nil`/`false` -- `0` passes, unlike WFL). A runtime error is a fail
 * (`run_wml_conditional`: "Any runtime error is considered a fail").
 *
 * One Lua state per `VariableStore` (a game's variables), bootstrapped
 * with `wml.variables` bridged to it. `[args]` is not bridged (no shipped
 * scenario passes one); the chunk gets `nil`.
 *
 * Returned as a factory rather than registered here so the app registers
 * it through its own import of the engine (`setLuaConditionalEvaluator`).
 */
import type { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import type { EventContext } from '@wesnothweb2/engine/src/events/context.js';
import type { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { newLuaState, doString, type LuaState } from './luaEnv.js';
import { BOOTSTRAP_LUA_SOURCE } from './bridges/bootstrap.js';
import { installVariablesBridge } from './bridges/variables.js';
import { installTextdomainBridge } from './bridges/textdomain.js';

export function createLuaConditionalEvaluator(): (cfg: WmlConfig, ctx: EventContext) => boolean {
  const states = new WeakMap<VariableStore, LuaState>();
  const stateFor = (store: VariableStore): LuaState => {
    let L = states.get(store);
    if (!L) {
      L = newLuaState();
      doString(L, BOOTSTRAP_LUA_SOURCE, '=bootstrap');
      installVariablesBridge(L, store);
      installTextdomainBridge(L, (source) => void doString(L!, source, '=textdomain'));
      states.set(store, L);
    }
    return L;
  };
  return (cfg, ctx) => {
    const code = cfg.getString('code', '');
    const name = cfg.getString('name', '') || '=[lua] condition';
    try {
      const result = doString(stateFor(ctx.variables), code, name);
      return result !== undefined && result !== null && result !== false;
    } catch (e) {
      ctx.log('error', `[lua] condition: ${(e as Error).message}`);
      return false;
    }
  };
}
