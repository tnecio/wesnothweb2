# Open questions

Decisions worth making explicitly before/while starting Phase 0, rather than
defaulting silently. My recommendation is listed first in each.

## 1. `wesnoth` submodule: keep the `wesnothlite` fork, or track upstream?

**Recommend: keep `tnecio/wesnoth` on the `wesnothlite` branch**, since it
already has `wl_image_oracle.cpp` and its CMake scaffolding — a head start
on Phase 0's oracle tooling — and periodically rebase it on upstream
`master` to pick up content/engine updates. The alternative (fresh
`upstream/wesnoth` submodule, re-adding oracle tooling as a thin patch) is
cleaner in principle but throws away that scaffolding for no real benefit,
since we're not carrying forward any WASM-specific patches that would
otherwise create merge conflicts.

## 2. Lua VM: Fengari (pure JS) or wasmoon (WASM)?

**Recommend: Fengari.** wasmoon is faster but is itself a WASM module,
which reintroduces some of the toolchain complexity (Emscripten-adjacent
build steps, binary asset size, harder debugging) this project is
explicitly trying to avoid by not compiling C++. Fengari is pure JS,
simpler to embed and debug, and Lua performance is very unlikely to be the
bottleneck compared to rendering or WML parsing. Worth a quick spike in
Phase 3 before committing, since this is the one dependency choice with
real switching cost later.

## 3. MVP target content

Need a concrete "done" for the Phase 4/5 milestone (first playable
scenario) and Phase 6 (first playable campaign). Recommend starting with a
small, mostly-`[lua]`-free mainline scenario for Phase 4/5 (the tutorial is
a candidate — simple mechanically, but may lean on UI hooks Phase 5 doesn't
have yet; a short custom/mainline skirmish scenario may be a better first
target), and a short mainline campaign (e.g. "A Tale of Two Brothers", 4
scenarios) for Phase 6. Your call on which — you know the mainline content
better than this survey does.

## 4. AI ambition

Phase 7 defaults to a heuristic placeholder AI and defers the real
candidate-action/Lua-driven AI indefinitely. Confirm that's acceptable, or
flag if "playable against a competent AI" is actually a hard requirement
earlier than that — it would reshuffle priority meaningfully since the real
AI is large and Lua-dependent.

## 5. Multiplayer priority

Phase 8 treats MP as optional/deferred given it's a large, orthogonal
effort (relay server + exact determinism). Confirm this is fine, or flag if
MP is actually a primary goal — if so it changes how early RNG/combat
determinism work in Phase 2 needs to be pinned down and tested.

## 6. Mainline only, or add-ons too?

The plan as written only targets mainline `data/core`/`data/campaigns`/
`data/multiplayer` content. Add-ons (community content, typically using the
same WML/Lua surface but potentially exercising more of it, plus needing an
add-on server/distribution story) are out of scope unless you want them
folded in — recommend leaving them out until mainline is solid.
