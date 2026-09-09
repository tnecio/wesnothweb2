# Implementation plan

Phased so each phase ends with something concretely checkable (a headless
test passing, a scenario rendering, a scenario playable end-to-end), not
just "code written." Later phases assume earlier ones are solid, but within
a phase, work is generally LLM-agent-friendly: a lot of it is close
translation of existing, readable C++ into TypeScript, subsystem by
subsystem, checked against an oracle (see `TESTING_STRATEGY.md`).

Explicitly **not ported, ever**: `display.cpp`, `draw*.cpp`, `sdl/`,
`units/animation.cpp`'s SDL-drawing half, all of `gui/` (382 files —
GUI2 dialogs/widgets), `src/server/wesnothd`'s implementation (may inform a
replacement, isn't reused), any Emscripten/WASM build tooling. These are
either replaced outright (PixiJS, Svelte) or superseded by a from-scratch
design (multiplayer relay).

## Phase 0 — Foundations

- Monorepo scaffold: npm workspaces (matches attempt #1's tooling — no need
  for pnpm/Nx/Turborepo at this scale), `packages/{engine,lua-bridge,
  renderer,ui,oracle-tools}`, `apps/web` (Vite).
- Add `wesnoth` as a git submodule. Decide fork-vs-upstream (see
  `OPEN_QUESTIONS.md`); either way, install a native (non-WASM) CMake build
  so `packages/oracle-tools` can compile CLI oracles from it — this needs
  `cmake` and a C++ toolchain on this VM (currently only `g++` is present,
  no `cmake`).
- Stand up `wl-image-oracle` (already exists on the `wesnothlite` branch —
  port the CMake target forward or rebuild it) and a new `wl-rng-oracle` and
  `wl-wml-oracle`, since Phase 1 needs ground truth for WML parsing and RNG
  immediately, not after the fact.
- Copy forward from `wesnothweb`, adapting as needed: `board/images/ipf.ts`,
  `ImageCache.ts`, `teamColor.ts`, hex-grid math from `lib/utils.ts`, the
  `tween.ts`/`FloatingText.ts` animation helpers. These land in
  `packages/renderer` now even though rendering is a Phase 4 concern — no
  reason to re-derive fidelity work that already exists.
- **Milestone**: `npm test` runs (empty/trivial), `wl-image-oracle` and
  `wl-rng-oracle` build and run from the submodule, CI skeleton in place.

## Phase 1 — Data layer (WML + core model)

- Port `serialization/{tokenizer,preprocessor,parser}.cpp` → the WML
  pipeline. The preprocessor (macro/`#define`/`{include}`/`#ifdef`
  expansion, ~1800 lines upstream) is the hardest single piece in this
  phase — budget accordingly. Verify against `wl-wml-oracle` on a growing
  set of real `data/core/` and `data/campaigns/` files.
- Port `config.cpp`/`config_attribute_value.cpp` → the `Config` tree type.
- Port map/terrain (`map/map.cpp`, `map/location.cpp`,
  `terrain/type_data.cpp`, `terrain/translation.cpp`) and hook up to the
  hex-grid math already sitting in `packages/renderer` from Phase 0.
- Port `units/unit.cpp`'s data (stats, leveling, XP, status) *without* its
  `display.hpp`/`udisplay.cpp`/`drawer.cpp`/`animation.cpp` calls, and
  `game_board.cpp` (map+units+teams container).
- Port the WFL interpreter (`formula/*`, ~25 files, small and
  self-contained) — needed here because unit filters (`formula=`) and some
  ability conditions are evaluated while just building the data model.
- **Milestone**: given a real mainline scenario file, load WML → build a
  populated `GameBoard` (map, terrain, units, sides) → print/query it.
  No rules, no rendering, no Lua yet.

## Phase 2 — Rules engine (headless)

- Port RNG (`random.cpp`, `random_deterministic.cpp`, `mt_rng.cpp`) —
  bit-exact MT19937, verified against `wl-rng-oracle`.
- Port pathfinding (`pathfind/astarsearch.cpp`, `pathfind.cpp`,
  `teleport.cpp`) — small, clean, verify against a new `wl-pathfind-oracle`.
- Port actions (`actions/*`: move, attack + `attack_prediction.cpp`,
  create/recruit/recall, heal, advancement, the undo-stack family) —
  **deliberately split** state mutation from the animation-triggering the
  original interleaves (see `ARCHITECTURE.md`). Verify combat resolution
  against a new `wl-combat-oracle` for fixed attacker/defender/terrain/seed
  inputs.
- Port the WML event pump and common action tags (`game_events/pump.cpp`,
  `action_wml.cpp`: `[message]`, `[if]`, `[modify_unit]`, `[store_unit]`,
  etc. — enough to drive simple scenario scripts) and the top-level
  single-player game loop (`play_controller.cpp` +
  `playsingle_controller.cpp`).
- Define and emit the engine's event vocabulary (`UNIT_MOVE`,
  `UNIT_ATTACK`, `UNIT_DIE`, `RECRUIT`, `ADVANCE`, `MESSAGE`, `SOUND`, ...)
  plus the `Query`/`Answer` side channel (`QUERY_REACH` etc.) — this is
  the seam the whole rest of the project renders against. Combat/move
  events carry the **full animation-context schema**, transcribed directly
  from `units/animation.hpp`'s `matches_headless()` parameter list (see
  `ARCHITECTURE.md`) — not whatever subset seems sufficient at the time.
  This is the one deliberate correction against attempt #1's actual failure
  mode (incomplete event context discovered late), so it's an explicit
  exit criterion here, not a Phase 4 concern.
- **Milestone**: a hand-written minimal scenario (no `[lua]`) plays start to
  finish headlessly via scripted commands, with combat outcomes matching
  `wl-combat-oracle` for the same seeds, snapshotted as a golden-scenario
  regression test — including asserting the emitted events carry every
  `matches_headless()` field, checked against real engine output via a new
  `wl-animation-oracle` (feeds fixed contexts through the real
  `matches_headless()` and dumps which animation it selects) even before
  the renderer exists to consume them.

## Phase 3 — Lua integration

- Embed Fengari in `packages/lua-bridge` (see `OPEN_QUESTIONS.md`).
- Patch the ~8 `data/lua/` files using Lua 5.4's `<const>`/`<close>` syntax
  (`core/wml.lua`, `wml-flow.lua`, `wml-tags.lua`, four `wml/*.lua`
  action-tag files, `functional.lua`) so Fengari (Lua 5.3) can parse them:
  drop `<const>`, rewrite `<close>` call sites (the `scoped_var()` pattern)
  to explicit pcall-based cleanup preserving the same restore-on-error
  guarantee. Small and mechanical, but track it as a real task, not an
  afterthought — this was only discovered by actually grepping for the
  syntax, not by reading upstream docs.
- Hand-port the subset of `scripting/game_lua_kernel.cpp`'s `wesnoth.*` API
  surface that mainline content and `data/lua/*.lua` actually exercise
  (unit/map/effect accessors, event triggers; UI-hook parts of the API stub
  out until Phase 5's UI exists). Everything in `data/lua/*.lua` other than
  the patched files above runs unmodified.
- **Milestone**: a real mainline scenario that uses `[lua]` for custom logic
  (pick one of the simpler ones) plays correctly headlessly.

## Phase 4 — Rendering (PixiJS), target: Dead Water's first scenario

First playable-scenario milestone targets `Dead_Water` (mainline campaign),
starting with just its first scenario.



- Board renderer consuming the Phase 2 event stream: terrain layer (reusing
  Phase 0's `ImageCache`/`ipf` work), unit sprites, `cycle_id`-grouped
  animation, fog/shroud.
- Context-aware unit animation selection, ported properly from
  `units/animation.cpp`/`frame.cpp` matching logic (facing/terrain/weapon/
  damage-state) — attempt #1's biggest unfinished item.
- Time-of-day tinting, frame position/halo/blend fields (attack-lunge
  positioning), sound-in-frame playback, per-blow HP sync points,
  scenario-local `[terrain_graphics]` — all explicitly left undone by
  attempt #1, all in scope here.
- Verify visually via a generalized `compare-images.js`: render fixed
  scenes and diff against `wl-image-oracle` screenshots.
- **Milestone**: the Phase 2 golden scenario visibly plays in a browser tab
  with correct terrain/unit rendering and animation.

## Phase 5 — UI shell (Svelte), target: Dead Water's first scenario

- Campaign/scenario picker, side panel, recruit/recall dialog, combat
  prediction popup (fed by Phase 2's `attack_prediction` port), objectives/
  turn dialog, save/load (Phase 2's `Config`-tree serializer, gzipped, in
  IndexedDB). Mine attempt #1's Svelte components and upstream's
  `gui/dialogs/` for required data shape only.
- **Milestone**: a full scenario is playable start-to-finish through the UI
  by a human, not just scripted commands.

## Phase 6 — Content breadth

- Finish `Dead_Water` (remaining scenarios), then expand to other mainline
  campaigns one at a time; every failure is a missing WML tag, WFL feature,
  or Lua API surface to port, driven by concrete repro cases rather than
  up-front spec-reading. Mainline only — add-ons are out of scope for now.

## Phase 7 — AI opponent

- MVP: a simple heuristic AI (greedy attack/move) as a placeholder, since
  mainline AI is a 60-file candidate-action framework substantially driven
  by Lua (`data/ai/`, 131 files using `[lua]`) — not worth porting before
  the game is otherwise playable. This is a placeholder to unblock
  single-player testing, **not** a decision to skip real AI — a
  genuine opponent is a required deliverable, just a late-stage one.
- Later: port the candidate-action framework and relevant Lua micro-AIs
  using the Phase 3 Lua VM, for closer-to-original behavior.

## Phase 8 — Multiplayer (struck out — not needed for MVP)

**2026-09-09 decision**: multiplayer is out of scope entirely, not just
deferred. The user's call: this is a single-player MVP project and there's
still substantial single-player polish work ahead (Phase 5/6) that's a
better use of effort. `ARCHITECTURE.md`'s multiplayer-relay section is now
historical context, not a live design target. Phase 2's RNG/command-based
action resolution stays as it is regardless (it's the right design for
single-player determinism/testing on its own merits), but no relay service
will be built on top of it.

## Priority as of 2026-09-09

Explicit user direction: focus on **Phase 5 (UI polish) and Phase 6
(content breadth)** now. Phase 7 (real AI) is deferred until Phase 5 is
solid — hotseat cycling stays as the stand-in until then. Phase 8 is
struck out (see above). Known Phase 5 gaps, roughly in priority order:

1. **Unit selection visuals** — flagged directly as still lacking despite
   the selection-ring fix; needs a fresh look (see PROGRESS.md for
   findings once investigated).
2. **Real per-unit-type stats** — every unit type currently shares
   identical placeholder combat/movement stats (see PROGRESS.md, Post-
   Phase-5 revision #3's "next steps" discussion); a Merman Fighter and a
   Merman Citizen are numerically identical right now. Needs real
   `data/core/units.cfg` stat loading (base_unit/gender-variant
   inheritance flattening), not just image paths.
3. **Victory/defeat conditions** — scenarios currently never end.
4. **Save/load** — planned since the original Phase 5 scope, not started.
5. Terrain image rendering stays deferred (user's call, unchanged).
