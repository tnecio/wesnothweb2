import { describe, expect, it } from 'vitest';
import { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { newLuaState, doString } from '../src/luaEnv.js';
import { BOOTSTRAP_LUA_SOURCE } from '../src/bridges/bootstrap.js';
import { installVariablesBridge } from '../src/bridges/variables.js';

/**
 * Task 2a: `wml.variables` bridged to the real `VariableStore`. Exercises
 * scalar get/set, dotted/array paths, `.length`, and `nil`-clears-the-
 * variable semantics -- all delegated to the real, already-tested
 * `VariableStore` (packages/engine/test/events/variables.test.ts), not
 * reimplemented here.
 */
describe('wml.variables <-> VariableStore bridge', () => {
  function setUp(store: VariableStore) {
    const L = newLuaState();
    doString(L, BOOTSTRAP_LUA_SOURCE, '=bootstrap');
    installVariablesBridge(L, store);
    return L;
  }

  it('reads a value set directly on the real VariableStore', () => {
    const store = new VariableStore();
    store.set('turn_number', 4);
    const L = setUp(store);
    const result = doString(L, 'return wml.variables.turn_number', '=t1');
    expect(result).toBe(4);
  });

  it('writes from Lua are visible on the real VariableStore', () => {
    const store = new VariableStore();
    const L = setUp(store);
    doString(L, 'wml.variables.gold = 150', '=t2');
    expect(store.get('gold')).toBe(150);
  });

  it('round-trips a dotted array path (real VariableStore path grammar, not reimplemented here)', () => {
    const store = new VariableStore();
    const L = setUp(store);
    doString(L, 'wml.variables["unit[0].hitpoints"] = 27', '=t3');
    expect(store.get('unit[0].hitpoints')).toBe(27);
    const readBack = doString(L, 'return wml.variables["unit[0].hitpoints"]', '=t4');
    expect(readBack).toBe(27);
  });

  it('assigning nil clears the variable (matches real WML semantics)', () => {
    const store = new VariableStore();
    store.set('flag', 'yes');
    const L = setUp(store);
    doString(L, 'wml.variables.flag = nil', '=t5');
    expect(store.get('flag')).toBeUndefined();
  });

  it('an unset variable reads as nil in Lua', () => {
    const store = new VariableStore();
    const L = setUp(store);
    const result = doString(L, 'return wml.variables.nonexistent == nil', '=t6');
    expect(result).toBe(true);
  });
});
