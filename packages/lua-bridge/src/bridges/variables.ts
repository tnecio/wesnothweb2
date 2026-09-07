/**
 * Bridges Lua's `wml.variables` to the real, tested
 * `@wesnothweb2/engine` `VariableStore` (`packages/engine/src/events/
 * variables.ts`) -- Task 2's highest-priority target, since (per the task
 * brief) "a huge fraction of `data/lua/wml-tags.lua`'s own implementation
 * depends on it."
 *
 * Implemented: scalar get/set, including dotted/bracketed paths and the
 * `.length` pseudo-attribute, by delegating directly to `VariableStore.get`/
 * `.set` -- both already implement WML's real path grammar (see that
 * module's doc comment), so this bridge does no path parsing of its own.
 * `wml.variables[name] = nil` clears the variable (`VariableStore.clear`),
 * matching real WML semantics (assigning nil removes it) rather than
 * storing a JS `undefined`.
 *
 * NOT implemented: `wml.array_variables` (WML array variables, i.e. a
 * variable that's really a same-named repeated child list) -- see
 * bridges/bootstrap.ts's stub and module doc comment for what that gap
 * does and doesn't affect. `VariableStore` already has full array support
 * (`getArray`/`setArray`/`pushArray`); wiring a Lua-table<->`VarNode[]`
 * converter through here is a reasonable follow-up once real content
 * actually needs it.
 */
import type { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { setNestedField, type LuaState } from '../luaEnv.js';

/** Installs `wml.variables` (assumes bootstrap.ts's `wml` global table already exists). */
export function installVariablesBridge(L: LuaState, store: VariableStore): void {
  const proxy = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (typeof prop !== 'string') return undefined;
        return store.get(prop);
      },
      set(_target, prop, value): boolean {
        if (typeof prop !== 'string') return true;
        if (value === undefined || value === null) {
          store.clear(prop);
        } else {
          store.set(prop, value as string | number | boolean);
        }
        return true;
      },
      has(): boolean {
        // Lua's `wml.variables[x]` always "exists" as an indexing operation
        // (it just yields nil for an unset variable) -- report true so a JS
        // Proxy `has` trap doesn't short-circuit unset-variable reads.
        return true;
      },
      // `wml.variables[name] = nil` from Lua reaches this trap, NOT `set`
      // with `value === undefined`: fengari-interop's userdata `__newindex`
      // handler (see node_modules/fengari-interop/src/js.js's `jsmt`)
      // special-cases a nil assignment as `Reflect.deleteProperty(u, k)`
      // rather than calling `u[k] = undefined` -- confirmed by writing this
      // bridge against a real `[for]`/`scoped_var` cleanup path (see
      // test/scopedVarClose.test.ts) and a dedicated regression test in
      // test/variablesBridge.test.ts.
      deleteProperty(_target, prop): boolean {
        if (typeof prop === 'string') store.clear(prop);
        return true;
      },
    },
  );
  setNestedField(L, ['wml', 'variables'], proxy);
}
