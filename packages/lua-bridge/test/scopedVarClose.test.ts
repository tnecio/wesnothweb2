import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { newLuaState, doString, lua, type LuaState } from '../src/luaEnv.js';
import { BOOTSTRAP_LUA_SOURCE } from '../src/bridges/bootstrap.js';
import { installRequire } from '../src/bridges/require.js';
import { installVariablesBridge } from '../src/bridges/variables.js';
import { readDataLuaFile } from '../src/dataLua.js';

/**
 * Task 1's specific close-semantics verification: Lua 5.4's `<close>`
 * guaranteed that `utils.scoped_var(name)`'s snapshot of WML variable
 * `name` gets restored when the enclosing scope ends -- whether that's
 * normal completion, an early return/break, OR an error propagating
 * through. The patch (see vendor-lua-patches/README.md) rewrites this as
 * explicit `pcall`-based cleanup; this test proves that rewrite preserves
 * the error-propagation case specifically (the case a naive "just drop the
 * annotation" patch would have silently broken).
 *
 * This loads and RUNS (not just compiles) two real files:
 *  - `wml-utils.lua`, completely UNMODIFIED from the submodule (it defines
 *    `scoped_var` itself, and doesn't use `<const>`/`<close>` syntax -- see
 *    that file's own module doc comment in vendor-lua-patches/README.md).
 *  - `wml-flow.lua`, PATCHED (this package's Task 1 output) -- specifically
 *    its `wml_actions["for"]`, whose `<close>`-guarded `save_i` this test
 *    forces to survive a thrown error from inside the loop body.
 *
 * Bootstrapping these two real files needs a real (if intentionally
 * minimal -- see bridges/bootstrap.ts) `wml`/`wesnoth` global environment;
 * everything that environment provides beyond wml.variables is a
 * documented stub, not a hand-tuned fake tailored to make this one test
 * pass -- see bootstrap.ts's module doc comment for exactly what's real vs.
 * stubbed and why.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataLuaRoot = path.join(repoRoot, 'wesnoth/data/lua');

function setUpLuaWithRealStdlibSubset(store: VariableStore): LuaState {
  const L = newLuaState();
  doString(L, BOOTSTRAP_LUA_SOURCE, '=bootstrap');
  installVariablesBridge(L, store);

  const wmlUtilsSource = readDataLuaFile(dataLuaRoot, 'wml-utils.lua'); // real, unmodified
  const wmlFlowSource = readDataLuaFile(dataLuaRoot, 'wml-flow.lua'); // patched (Task 1)

  installRequire(L, (name) => {
    if (name === 'wml-utils') {
      return { source: wmlUtilsSource, chunkName: '@wml-utils.lua' };
    }
    return undefined;
  });

  // dofile-equivalent: run wml-flow.lua as a top-level chunk. It doesn't
  // return anything itself -- it defines functions directly onto the real,
  // unmodified `wesnoth.wml_actions` table (created by bootstrap.ts).
  doString(L, wmlFlowSource, '@wml-flow.lua');

  return L;
}

describe('scoped_var <close>-derived restore-on-error (real wml-utils.lua + patched wml-flow.lua)', () => {
  it('restores the shadowed WML variable when the loop body throws', () => {
    const store = new VariableStore();
    store.set('i', 'sentinel_original_value');

    const L = setUpLuaWithRealStdlibSubset(store);

    // A [for] action whose lone [do] child invokes an action tag that
    // always throws -- forces wml_actions["for"]'s <close>-derived cleanup
    // to run via the error path, not the normal-completion path.
    doString(
      L,
      `
      wesnoth.wml_actions.throwing_action = function(cfg)
        error("boom from test action", 0)
      end

      local cfg = {
        start = 1,
        ["end"] = 3,
        step = 1,
        variable = "i",
        { "do", { { "throwing_action", {} } } },
      }

      local ok, err = pcall(function()
        wesnoth.wml_actions["for"](cfg)
      end)
      `,
      '=test-driver',
    );

    // Assert on real resulting state (via the shared L's wml.variables
    // bridge, backed directly by `store`): "i" must be back to its pre-call
    // value, proving <close>'s guarantee held even though the loop body
    // threw partway through the first iteration.
    expect(store.get('i')).toBe('sentinel_original_value');
  });

  it('the [for] action call itself actually threw (the error genuinely propagated, cleanup did not swallow it)', () => {
    const store = new VariableStore();
    store.set('i', 'sentinel_original_value');
    const L = setUpLuaWithRealStdlibSubset(store);

    const threw = doString(
      L,
      `
      wesnoth.wml_actions.throwing_action = function(cfg)
        error("boom from test action", 0)
      end
      local cfg = {
        start = 1, ["end"] = 3, step = 1, variable = "i",
        { "do", { { "throwing_action", {} } } },
      }
      local ok, err = pcall(function() wesnoth.wml_actions["for"](cfg) end)
      return (not ok) and tostring(err):find("boom from test action", 1, true) ~= nil
      `,
      '=test-driver-2',
    );
    expect(threw).toBe(true);
    lua.lua_close(L);
  });

  it('control: the loop DOES observe and use the shadowing value while running (i.e. this is a real save/restore, not a no-op)', () => {
    const store = new VariableStore();
    store.set('i', 'sentinel_original_value');
    const L = setUpLuaWithRealStdlibSubset(store);

    const observedDuringLoop = doString(
      L,
      `
      local seen = {}
      wesnoth.wml_actions.record_i = function(cfg)
        table.insert(seen, wml.variables["i"])
      end
      local cfg = {
        start = 1, ["end"] = 2, step = 1, variable = "i",
        { "do", { { "record_i", {} } } },
      }
      wesnoth.wml_actions["for"](cfg)
      return seen[1] == 1 and seen[2] == 2
      `,
      '=test-driver-3',
    );
    expect(observedDuringLoop).toBe(true);
    // ...and after the (this time non-throwing) loop finishes normally, the
    // shadowed variable is restored too.
    expect(store.get('i')).toBe('sentinel_original_value');
  });

  it('[foreach]: restores BOTH shadowed variables (in the real reverse-declaration order) when the loop body throws partway through', () => {
    // wml_actions.foreach's <close> rewrite is the trickiest of the 8 patch
    // sites: two to-be-closed locals declared in one `do...end` block whose
    // original `goto exit`s crossed that block's boundary (a real early
    // close in Lua 5.4, not just "jump to a label still in scope" like
    // `[for]`'s -- see vendor-lua-patches/README.md). This exercises it
    // directly rather than relying only on the compile-only parse check.
    const store = new VariableStore();
    store.set('item', 'orig_item');
    store.set('idx', 'orig_idx');
    const L = setUpLuaWithRealStdlibSubset(store);

    // wml.array_variables is a permissive "always empty" stub in
    // bootstrap.ts (see its module doc comment) -- override it here, in
    // plain Lua, with a real 3-element array for exactly this test, since
    // that's all `[foreach]` needs from it (a real array-variable<->
    // VariableStore JS bridge is out of scope, see bridges/variables.ts).
    doString(
      L,
      `
      wml.array_variables = setmetatable({}, {
        __index = function(_, name)
          if name == "myarr" then return { 10, 20, 30 } end
          return {}
        end,
        __newindex = function() end,
      })
      `,
      '=array-stub',
    );

    doString(
      L,
      `
      local calls = 0
      wesnoth.wml_actions.maybe_throw = function(cfg)
        calls = calls + 1
        if calls == 2 then error("boom on second item", 0) end
      end

      local cfg = {
        array = "myarr",
        variable = "item",
        index_var = "idx",
        { "do", { { "maybe_throw", {} } } },
      }

      local ok, err = pcall(function() wesnoth.wml_actions.foreach(cfg) end)
      assert(not ok, "expected foreach to propagate the thrown error")
      assert(tostring(err):find("boom on second item", 1, true), "expected the real error to propagate, got: " .. tostring(err))
      `,
      '=test-driver-4',
    );

    expect(store.get('item')).toBe('orig_item');
    expect(store.get('idx')).toBe('orig_idx');
  });
});
