# Vendor Lua patches

Wesnoth vendors Lua 5.4.7. Fengari (the pure-JS VM this package embeds, see
`OPEN_QUESTIONS.md` decision 2) only implements Lua 5.3 and cannot even
*parse* Lua 5.4's `<const>`/`<close>` variable-attribute syntax. Exactly 8
files under `wesnoth/data/lua/` use it:

- `core/wml.lua`
- `wml-flow.lua`
- `wml-tags.lua`
- `wml/find_path.lua`
- `wml/harm_unit.lua`
- `wml/modify_unit.lua`
- `wml/random_placement.lua`
- `functional.lua`

This directory holds hand-patched copies of exactly those 8 files, applied
as a small mechanical diff on top of an unmodified copy from the `wesnoth`
git submodule (`wesnoth/data/lua/...`). **Every other file under
`data/lua/` is loaded completely unmodified straight from the submodule**
-- see `../src/dataLua.ts`'s loader, which serves a patched copy only for
these 8 relative paths and reads everything else off disk untouched.

## Patch strategy

### `<const>`

Dropped outright. It's a compile-time-only reassignment check (the
compiler rejects a second assignment to the same local) with zero runtime
effect, so removing the annotation changes nothing about program behavior.
Only `functional.lua` uses it (2 occurrences).

### `<close>`

Every other occurrence (10 call sites across the other 7 files) is the
pattern `local x <close> = utils.scoped_var(name)` (`scoped_var` lives in
`wesnoth/data/lua/wml-utils.lua`, itself unmodified -- it doesn't use
`<const>`/`<close>` syntax, only a plain `__close` *metatable field*, which
is ordinary Lua 5.3 syntax; only the `<close>` *attribute* at the
declaration site is what makes a variable to-be-closed and thus needs
Fengari-incompatible syntax at all). `scoped_var(name)` snapshots the WML
variable `name`, and its `__close` metamethod restores the snapshot when
the to-be-closed variable's scope ends -- by falling off the end of the
block, an early `return`, a `break`/`goto` that exits the block, *or* an
error propagating through it. This is exactly the guarantee
`pcall`-based cleanup gives in any Lua version, so each call site is
rewritten as:

```lua
-- before (Lua 5.4):
local x <close> = utils.scoped_var(name)
<body...>

-- after (Fengari/Lua 5.3):
local x = utils.scoped_var(name)
local ok, err = pcall(function()
  <body...>
end)
debug.getmetatable(x).__close(x, ok and nil or err)
if not ok then error(err, 0) end
```

`debug.getmetatable(x).__close` is called directly (rather than some
`x:close()` method) because `scoped_var`'s returned object's `__index`/
`__newindex` are deliberately locked down (only `.__original` is readable,
everything else errors) -- exactly mirroring what real `<close>` handling
does under the hood (call the object's `__close` metamethod, not a regular
method). Note it's specifically `debug.getmetatable`, not plain
`getmetatable`: `scoped_var`'s metatable sets `__metatable = "scoped WML
variable"` (a deliberate protection against `setmetatable`/`getmetatable`
tampering on the real object), which makes plain `getmetatable(x)` return
that *string* instead of the real metatable table -- `debug.getmetatable`
is the standard way to see through that protection. This was caught the
hard way: an earlier version of this patch used plain `getmetatable` and
passed a syntax/compile check fine, but silently failed to restore the
variable on the error path (`__close` end up being looked up on a string,
i.e. nil, so calling it threw "attempt to call a nil value" *instead of*
the original propagating error) -- only caught by
test/scopedVarClose.test.ts actually exercising the error path with a real
assertion on restored state, not just checking that the call didn't throw.

Two wrinkles handled at each site, not just a blind wrap:

1. **Return values.** `core/wml.lua`'s `global_vars_ns.__index` returns a
   value from inside the original `<close>`-guarded block (`return res` /
   `return nil`). The rewrite captures the anonymous function's return via
   `pcall`'s second return value and re-returns it after closing.
2. **`goto`/`break` crossing the original block boundary.** Real Lua 5.4
   closes a to-be-closed variable not just on error/return but also when a
   `goto`/`break` exits its block early. `wml-flow.lua`'s `[for]` action
   only ever `goto`s to a label *inside* the same scope as the `<close>`
   variable (right before the function's own closing `end`), so no early
   close was ever needed there -- the `goto`s are replaced with a plain
   `return` from the wrapping anonymous function, which is behaviorally
   identical. `[foreach]`, however, has two `<close>` locals in one `do...end`
   block whose `goto exit` targets a label *outside* that block -- a real
   early close. Its rewrite closes both (in the same reverse-declaration
   order Lua itself would use: `i` before `this_item`) on every exit path,
   normal or early, by replacing `goto exit` with `return` from the
   wrapped body and running both closes unconditionally right after the
   `pcall`.

## Verification

- `test/patchedFilesParse.test.ts`: compiles (via `luaL_loadstring`, i.e.
  parse-only, no execution) all 8 patched files through Fengari and
  confirms zero syntax errors -- and, as a control, confirms the
  *unpatched* originals from the submodule fail to compile under Fengari
  with exactly the `<close>`/`<const>` syntax error, so the test would
  catch a patch silently reverting to invalid syntax.
- `test/scopedVarClose.test.ts`: loads the real, unmodified
  `wml-utils.lua` plus this directory's patched `wml-flow.lua` through
  Fengari, then actually calls the patched `wml_actions["for"]` with an
  inner action that throws, and asserts the shadowed WML variable is
  restored to its pre-call value afterward -- the exact guarantee `<close>`
  made, now provided by the rewritten `pcall` cleanup instead.

## Maintenance

This patch needs re-checking whenever the `wesnoth` submodule is rebased
on upstream (`docs/OPEN_QUESTIONS.md` decision 1): if upstream adds a new
`<const>`/`<close>` use, or changes one of these 8 files' control flow
around an existing one, the corresponding patched copy here needs updating
by hand -- there's no automated diff/merge tooling for this, it's a small
enough surface (10 `<close>` call sites, 2 `<const>` uses, all listed
above) to re-grep and eyeball on each rebase:
`grep -rn "<const>\|<close>" wesnoth/data/lua/`.
