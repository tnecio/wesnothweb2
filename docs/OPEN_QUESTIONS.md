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

**Revisited 2026-09-30 (Phase 29 S12): Lua is now a bottleneck in large
battles.** The AI runs upstream's Lua candidate actions, and one of them,
`retreat_injured`, is the slowest thing in an AI turn:

- On every evaluation it rebuilds the enemies' and allies' attack maps
  (`battle_calcs.get_attack_map`). The RCA loop evaluates it after every
  action, and nothing is cached between evaluations.
- Each map is every unit's reach plus each reached hex's neighbours,
  inserted into two `location_set`s.
- Each insert allocates a named tuple in `wesnoth.map.read_location`
  (39% of the Lua work in the profile).

In the `fast` AI test scenario (100 units a side) this is about 3 s per
evaluation and about ten minutes per turn once the armies meet.

The same insert workload in both VMs:

| VM | One 100-unit attack map |
|---|---|
| fengari | 2.9 s |
| wasmoon (Lua 5.4 in WebAssembly) | 0.37 s |

Shipped campaign scenarios are far smaller. Most AI turns there take
20–300 ms of computing. The worst turns measured are 27 s in Dead Water 5 (two
AI sides, 29 units, fighting each other) and 6.8 s in Liberty 4
(`retreat_injured`).

**Decided: postponed until it matters in practice.** Two long-term options:

1. **Fix it upstream.** Open a pull request to Wesnoth that makes
   `retreat_injured` (or `battle_calcs.get_attack_map`/`location_set`)
   cheaper, and pull the fix down with the submodule. Upstream's C++ game
   would be faster too, and our Lua stays upstream's.
2. **Switch the Lua VM to wasmoon.** That gives about 8× on Lua-heavy code,
   and it runs Lua 5.4, so the 8 patched files could go back to upstream's
   originals. The kernel (`packages/lua-bridge/src/kernel/`) is written
   against fengari's JS API throughout. Suspending Lua for a player's choice
   (`yieldFlow`, coroutines across JS calls) would also need a new design.
   It would be a phase of its own.

Rewriting upstream's Lua locally to make it faster stays ruled out: it would
break the rule of running upstream's Lua unchanged. Running the AI in a Web
Worker would keep the page responsive during a slow turn without making the
turn any shorter; it is also postponed. Measured AI turn times for the
shipped campaigns are in `docs/PROGRESS.md` (Phase 29 S12).

## 3. MVP target content

**Decided: `Dead_Water`** (mainline campaign; used for debugging in
attempt #1 too, so there's prior familiarity with it). First scenario is
the Phase 4/5 milestone target; the full campaign is the Phase 6 milestone
target before moving on to other mainline content.

## 4. AI ambition

**Decided, delivered 2026-09-13 (Phase 29 S0–S6):** the real candidate-
action AI (`packages/engine/src/ai/`) has replaced Phase 7's heuristic
placeholder (`simpleAi.ts`, deleted). Dead Water plays a full turn under
the real RCA default AI, headlessly and end-to-end. The Lua-dependent
layers (S7–S12: `wesnoth/data/ai/**/*.lua` verbatim, every micro AI)
followed and were delivered 2026-09-30 -- see Phase 29's status in `docs/
IMPLEMENTATION_PLAN.md`, item 7 below, and item 2 for the Lua speed.

## 5. Multiplayer priority

**Decided:** not a current concern, but expected to be added eventually.
Phase 2's RNG/combat determinism work should stay compatible with the
lockstep-replay model (exact MT19937 reproducibility, command-based action
resolution) so this doesn't force revisiting settled design later. Phase 8
remains last and unscheduled.

## 6. Mainline only, or add-ons too?

**Decided: mainline only.** `data/core`, `data/campaigns`, `data/multiplayer`.
Add-ons are out of scope.

## 7. Lua AI content: run verbatim on fengari, or hand-port to TS?

**Decided 2026-09-13 (Phase 29 kickoff):** run `wesnoth/data/ai/**/*.lua`
verbatim on the existing fengari bridge (`packages/lua-bridge`, decision
2 above), TS-port the C++ candidate-action framework itself. Confirmed by
direct inspection that none of `data/ai` uses Lua 5.4-only syntax (the
`<const>`/`<close>` patch list stays at its existing 8 files), so no new
vendor patches are needed. The alternative (hand-porting `ai_helper.lua`/
`battle_calcs.lua`/the 5 default-loop Lua CAs/20 micro-AI types, ~15,000
lines) was rejected as slow and translation-error-prone for content this
large; the fengari bridge's host API (`wesnoth.*`/`ai.*`) needs real
extension either way, but extending it is bounded, testable work,
whereas a hand-port has to be re-verified line-by-line against upstream
forever. See `docs/PHASE29_PLAN.md` for the full staged
plan; this supersedes decision 4's "later" with a real, in-progress phase
(Phase 29).
