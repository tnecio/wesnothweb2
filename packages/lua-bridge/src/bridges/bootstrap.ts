/**
 * A small, hand-written Lua chunk providing just enough of the `wml`/
 * `wesnoth` global surface for this package's currently-loaded subset of
 * `data/lua/` (`wml-utils.lua`, `wml-flow.lua`) to load and run.
 *
 * This is deliberately NOT a port of `data/lua/core/wml.lua` (which is
 * ~580 lines and needs many more C++ engine primitives this phase doesn't
 * implement yet -- `wml.matches_filter`, `wesnoth.kernel_type`,
 * `wesnoth.sync.*`, real vconfig/`$(...)`-formula machinery, ...). Per the
 * Phase 3 task brief ("don't try to port all of it"), only the pieces
 * actually exercised by this package's tests are here:
 *
 *  - `wml.get_child`/`child_count`/`child_range` are verbatim ports of
 *    `core/wml.lua`'s own (pure-Lua, no C++ dependency) algorithms.
 *  - `wml.valid`, `wml.literal`/`parsed`/`shallow_literal`/`shallow_parsed`,
 *    and `wml.tovconfig` are permissive identity-shaped stubs: the real
 *    ones handle vconfig userdata and `$(...)`/`$var` substitution, but
 *    every config this package's tests construct is a plain literal Lua
 *    table with no such substitution pending, so identity behaves
 *    identically for them.
 *  - `wml.error` matches real behavior closely enough for this package's
 *    purposes (raises a Lua error with the given message).
 *  - `wml.array_variables` is a stub that always reports an empty array --
 *    see its own comment below for exactly what this does and doesn't
 *    cover.
 *  - `wml.variables` is NOT defined here -- see bridges/variables.ts, which
 *    installs a real bridge to a `VariableStore`.
 *  - `wesnoth.units`/`wesnoth.units.get` similarly is not defined here --
 *    see bridges/units.ts.
 *  - `wesnoth.require` is not defined here -- see bridges/require.ts (it
 *    needs direct Lua-stack/registry access `interop.push`-wrapped JS
 *    functions can't easily do).
 */
export const BOOTSTRAP_LUA_SOURCE = `
wesnoth = wesnoth or {}
wesnoth.wml_actions = wesnoth.wml_actions or {}
wesnoth.units = wesnoth.units or {}

-- wml-utils.lua's module-load-time deprecate_api() calls need this global to
-- exist; a real deprecation wrapper isn't needed for anything this package
-- tests, so this just returns the underlying function unchanged.
function wesnoth.deprecate_api(old_name, new_name, level, version, func, message)
  return func
end

-- wml-utils.lua references stringx.trim (only as an argument value, not
-- called) at module-load time; provide a minimal real implementation rather
-- than a dummy since it costs nothing extra.
stringx = stringx or {}
function stringx.trim(s)
  return (s:gsub('^%s*(.-)%s*$', '%1'))
end

wml = wml or {}

function wml.valid(cfg)
  return true
end

function wml.error(msg)
  error(msg, 0)
end

-- Verbatim port of core/wml.lua's wml.get_child (minus the ensure_config()
-- call, since wml.valid above is a permissive stub anyway).
function wml.get_child(cfg, name, id)
  for i, v in ipairs(cfg) do
    if v[1] == name then
      local w = v[2]
      if not id or w.id == id then return w, i end
    end
  end
end

-- Verbatim port of core/wml.lua's wml.child_count.
function wml.child_count(cfg, name)
  local n = 0
  for i, v in ipairs(cfg) do
    if v[1] == name then n = n + 1 end
  end
  return n
end

-- Verbatim port of core/wml.lua's wml.child_range (the single-tag-name form).
function wml.child_range(cfg, tag)
  local i = 0
  return function()
    while true do
      i = i + 1
      local v = cfg[i]
      if not v then return nil end
      if v[1] == tag then return v[2] end
    end
  end
end

function wml.literal(cfg) return cfg end
function wml.parsed(cfg) return cfg end
function wml.shallow_literal(cfg) return cfg end
function wml.shallow_parsed(cfg) return cfg end
function wml.tovconfig(t) return t end

-- Real core/wml.lua's wml.tag is a metatable-backed factory:
-- wml.tag.foo(cfg) returns {"foo", cfg or {}}, i.e. a child-tag entry in
-- the same {tag, subcfg} shape wml.get_child/child_range read.
wml.tag = setmetatable({}, {
  __index = function(_, name)
    return function(cfg) return { name, cfg or {} } end
  end
})

-- Real array-variable bridging (Lua table <-> the engine's VariableStore
-- array storage) is not implemented -- see bridges/variables.ts's module
-- doc comment. This stub always reports an empty array for any name, which
-- is exactly what wml-utils.lua's scoped_var (via start_var_scope) needs to
-- correctly fall through to scalar wml.variables handling -- sufficient for
-- every scalar-variable case this package's tests exercise, not sufficient
-- for any real WML array variable.
wml.array_variables = setmetatable({}, {
  __index = function(_, _name) return {} end,
  __newindex = function() end,
})
`;
