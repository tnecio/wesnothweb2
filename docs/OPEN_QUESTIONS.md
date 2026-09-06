# Decisions

Resolved 2026-09-06, in conversation. Kept as a log — future work should
match these rather than silently drift.

## 1. `wesnoth` submodule: fork or upstream?

**Decided: keep `tnecio/wesnoth` on the `wesnothlite` branch**, rebased
periodically on upstream `master`. It already has `wl_image_oracle.cpp`'s
CMake scaffolding and, notably, `units/animation.hpp`'s `matches_headless()`
— a display-decoupled animation-matching entry point added specifically for
the wesnothlite WASM API — which is directly useful for wesnothweb2 even
though we're not building WASM (see `ARCHITECTURE.md`).

## 2. Lua VM: Fengari or wasmoon?

**Decided: Fengari** (pure JS) — avoids reintroducing WASM toolchain
complexity for a component unlikely to be a performance bottleneck.

**Revisited 2026-09-06** after discovering Wesnoth vendors Lua 5.4.7 and
`data/lua/`'s own standard library (`core/wml.lua`, `wml-flow.lua`,
`wml-tags.lua`, four `wml/*.lua` action-tag files, `functional.lua` — the
layer underneath essentially all WML action-tag execution, not an edge
case) uses Lua 5.4's `<const>`/`<close>` attribute syntax, which Fengari
(Lua 5.3 only, confirmed via its own docs — no 5.4 roadmap found) cannot
even parse. No mature actively-maintained pure-JS Lua 5.4 alternative to
Fengari was found.

**Re-decided: stay with Fengari**, and carry a small maintained patch to
the ~8 affected `data/lua/` files (strip `<const>`, rewrite `<close>` call
sites to explicit pcall-based cleanup) rather than switch to wasmoon. This
keeps Lua embedding WASM-free at the cost of a bounded, mechanical patch
that needs re-checking on every submodule rebase (decision 1). See
`ARCHITECTURE.md`'s `packages/lua-bridge` section for the specifics.
`Dead_Water` (decision 3) doesn't use `<const>`/`<close>` directly, so this
doesn't block the MVP milestone, but the patch is still needed since
`Dead_Water` depends on `wml-tags.lua`/`wml-flow.lua` like everything else.

## 3. MVP target content

**Decided: `Dead_Water`** (mainline campaign; used for debugging in
attempt #1 too, so there's prior familiarity with it). First scenario is
the Phase 4/5 milestone target; the full campaign is the Phase 6 milestone
target before moving on to other mainline content.

## 4. AI ambition

**Decided:** heuristic placeholder AI is fine through the early phases, but
a real AI opponent is a required eventual deliverable, not something to
drop. Phase 7 reflects this: placeholder first, real candidate-action/Lua
AI later, but "later" is a schedule position, not an optional scope item.

## 5. Multiplayer priority

**Decided:** not a current concern, but expected to be added eventually.
Phase 2's RNG/combat determinism work should stay compatible with the
lockstep-replay model (exact MT19937 reproducibility, command-based action
resolution) so this doesn't force revisiting settled design later. Phase 8
remains last and unscheduled.

## 6. Mainline only, or add-ons too?

**Decided: mainline only.** `data/core`, `data/campaigns`, `data/multiplayer`.
Add-ons are out of scope.
