# Architecture

## Goal, and how this differs from wesnothweb

wesnothweb (attempt #1) compiled a subset of the real C++ engine to WASM and
kept it as the single source of truth for game state; the TypeScript side was
purely a rendering/input client talking to it over a worker message protocol.
That project got a WASM build working, a Svelte+PixiJS UI running, and got
deep into terrain/unit image rendering fidelity — but never reached gameplay
rules on the web side, because the rules always lived in WASM.

wesnothweb2 takes only the *content* (WML data files, images, audio/music)
from upstream Wesnoth, verbatim, and reimplements the *engine* — WML parsing,
data model, turn/event loop, combat/pathfinding, AI, RNG — natively in
TypeScript. Nothing is compiled from C++; nothing links against SDL, Boost,
or Emscripten. The `wesnoth` C++ tree is kept as a git submodule purely as
(a) a translation source — much of the port is a close reading of the
original C++, which LLM agents are well suited to — and (b) a build target
for small **native** (non-WASM) command-line "oracle" tools that dump
ground-truth output for testing (see `TESTING_STRATEGY.md`).

## System shape

```
                 ┌─────────────────────────┐
                 │   Web Worker: engine     │
                 │  (packages/engine)       │
                 │                          │
 Command ───────►│  WML → data model →      │
                 │  rules → event stream    │
 Event   ◄───────│                          │
 Query   ───────►│  Lua VM + wesnoth.* API  │
 Answer  ◄───────│  (packages/lua-bridge)   │
                 └─────────────────────────┘
                            │ events consumed by:
             ┌──────────────┴───────────────┐
             ▼                               ▼
   packages/renderer                  packages/ui
   (PixiJS board, sprites,            (Svelte shell: dialogs,
    terrain, animation)                side panel, menus)
```

The engine runs in a Web Worker, exactly as attempt #1 did — not because we
need to isolate a WASM module anymore, but because the worker boundary is a
disciplined way to *force* the separation that the original C++ engine does
not have (see below): the engine can only communicate what happened via a
serializable event, never by reaching into a renderer directly. It also keeps
the UI thread free during WML/Lua-heavy scenario loads.

Reuse the attempt #1 protocol shape as a starting template (documented in
its `doc/Refactor_game_state.md` and implemented in `frontend/src/engine/`):
a `Command` → `Event`/`GameEvent` union (`UNIT_MOVE`, `UNIT_ATTACK`,
`UNIT_DIE`, `RECRUIT`, `ADVANCE`, `MESSAGE`, `SOUND`, ...), plus a side-channel
`Query`/`Answer` pair (e.g. `QUERY_REACH`) for the UI to ask "what can this
unit do" without mutating state. The vocabulary carries over unchanged; only
what's behind it changes (TS engine instead of a WASM postMessage shim).

## Animation event context: what attempt #1 actually got stuck on

It's worth being precise about this, since it's the thing that stalled
attempt #1 and the natural worry is that porting the engine *and* imposing a
clean state/presentation split at the same time compounds the risk. It
doesn't, and here's why: attempt #1 already had a clean split (WASM engine →
`GameEvent`s → TS renderer over a worker boundary). What actually stalled
was (a) bit-exact image compositing, now solved and reused verbatim (see
above), and (b) **incomplete context in the events** —
`queryUnitTypeAnimations` used a hardcoded context because facing/terrain/
weapon/hit-or-miss were never fully plumbed through. That's a completeness
problem that exists in *any* architecture — a monolith has to compute
"which frame to draw" too, or animations don't work. Translating
`units/animation.cpp`/`frame.cpp`'s matching logic is just more C++-to-TS
translation, the same kind of work as everything else in this plan; the
only design decision is where the translated matcher lives (here,
`packages/renderer`, alongside terrain-image layering — WML-driven but
presentational, no gameplay-rule content) and what fields the engine must
hand it.

Usefully, upstream Wesnoth has already done the analysis for us:
`units/animation.hpp` declares both `matches()` (display-coupled) and
`matches_headless()`, the latter added — per its own doc comment — "to be
callable without an active display (e.g. from the wesnothlite WASM API)".
Its parameter list *is* the complete animation-context schema: `loc`,
`second_loc`, `my_unit`, an `event` string ("attack"/"defend"/"movement"/
etc.), a damage `value`/`value2` pair, a `hit` result (`strike_result::type`
— hit/miss/kill), the `attack`/`second_attack` weapons involved, the
`terrain_at_loc`, and `second_unit`. **Phase 2 transcribes this signature
directly into the TS combat/move event schema** as a named, tested contract
— rather than discovering missing fields piecemeal while debugging
animations in Phase 4, which is what happened last time.

## Why the engine must decouple state from presentation itself

In upstream Wesnoth, `actions/move.cpp` and `actions/attack.cpp` call into
`display.hpp` directly while resolving a move or an attack — state mutation
and animation-triggering are interleaved, not layered. `units/unit.cpp`
likewise includes `display.hpp`. This is the seam that reportedly stalled
attempt #1's display work, and it does not come for free from the C++
structure — porting means *introducing* the split deliberately: engine code
computes an outcome and appends a semantic event describing it; nothing in
`packages/engine` ever touches a renderer, a `Sprite`, or a pixel.

## Package layout

- `packages/engine` — pure TS, no DOM/canvas dependency, runs standalone in
  Node for tests and inside a Worker in the browser. Contains:
  - WML pipeline: tokenizer → preprocessor (macro/`#define`/`{include}`
    expansion) → parser → `Config` tree (ported from `src/serialization/`).
  - Data model: map/terrain, unit types + unit instances, teams/sides,
    game board (ported from `map/`, `terrain/*` minus `terrain/builder.cpp`,
    `units/unit.cpp` minus its display calls, `game_board.cpp`).
  - WFL (Wesnoth Formula Language) interpreter — small, self-contained,
    ported from `formula/` — needed for unit filters (`formula=`) and
    ability conditions.
  - Rules: pathfinding (`pathfind/`), actions (move/attack/recruit/recall/
    heal/advancement + undo stack, from `actions/`), combat resolution and
    hit-chance prediction (`attack.cpp` + `attack_prediction.cpp`, which is
    already a self-contained statistical module upstream).
  - Turn/event engine: WML event pump and action-tag handlers
    (`game_events/pump.cpp`, `action_wml.cpp`), scenario/campaign flow
    (`play_controller.cpp` and its single-player subclass).
  - RNG: MT19937, both the casual and the seeded/deterministic variant
    (`random.cpp`, `random_deterministic.cpp`, `mt_rng.cpp`) — ported
    bit-for-bit, since combat outcomes, replay, and our own oracle-based
    testing all depend on exact reproducibility.
  - Savegame: serialize the `Config` tree back to WML text (the format
    upstream already uses, gzipped) — trivial once the WML serializer
    exists; store in IndexedDB.

- `packages/lua-bridge` — an in-browser Lua VM (see `OPEN_QUESTIONS.md` for
  the Fengari-vs-wasmoon choice) plus a hand-ported subset of the
  `wesnoth.*` host API that `scripting/game_lua_kernel.cpp` exposes:
  unit/map/effect accessors, event triggers, UI hook stubs. `data/lua/*.lua`
  (the standard library layer mainline content depends on) runs unmodified
  once the host API it calls exists. Lua is **load-bearing**, not optional —
  it's used directly in ~8% of mainline `.cfg` files and pervasively by
  abilities/AI beneath that.

- `packages/renderer` — PixiJS-based board renderer. Ports forward,
  near-verbatim, the parts of attempt #1's `frontend/src/board/` that had no
  WASM dependency and were already fidelity-tested against the real engine:
  - `images/ipf.ts` — Image Path Function chain parser (paren-depth-aware
    modifier splitting, e.g. `CROP(0,0,72,72)~MASK(...)~O(0.6)`).
  - `images/ImageCache.ts` — resolves a path+modifier chain to a
    `PIXI.Texture`, implementing `MASK` (per-pixel minimum, not
    canvas `destination-in`), `CROP`, `O` (opacity via truncated `n*256`
    integer math, not `globalAlpha`), `BLIT`, `FL`, `SCALE`, `GS`, `TC`,
    `RC` — this file alone encodes weeks of pixel-fidelity debugging from
    attempt #1 and should not be re-derived from scratch.
  - `images/teamColor.ts` — recolor palette mapping ported from
    `color_range.cpp`.
  - Hex-grid geometry (`hexToPixel`, `pixelToHex`, `hexNeighbours`,
    `hexDistance`, `hexCorners`) from attempt #1's `lib/utils.ts`.
  - Terrain hex-cropping (72×72 via the alphamask) and the per-layer
    neighbor-hex offset model attempt #1 reverse-engineered from
    `get_terrain_frames_at()` — documented in its `Refactor_display_layer.md`.
  - Animation: group frames by a shared `cycle_id` before building a
    `PIXI.AnimatedSprite` (fixes the "13 frames superimposed as a static
    ring" bug attempt #1 hit). Unlike attempt #1, animation *selection*
    (facing/terrain/weapon/damage-state context) is ported properly from
    `units/animation.cpp`/`units/frame.cpp` matching logic rather than
    hardcoded — this was explicitly left unfinished last time.
  - New from attempt #1's todo list: time-of-day tinting, frame position/
    halo/blend fields (needed for correct attack-lunge positioning),
    sound-in-frame playback, per-blow HP sync points, scenario-local
    `[terrain_graphics]` rules.

- `packages/ui` — Svelte components: campaign/scenario picker, side panel
  (unit/terrain info), recruit/recall dialog, combat prediction popup (fed
  directly by the ported `attack_prediction` module), objectives/turn
  dialog, save/load. Mine attempt #1's Svelte components and upstream's
  `gui/dialogs/` for *what data each screen needs*, not for logic — both are
  layout-only references.

- `packages/oracle-tools` — native (not WASM) CLI tools built from the
  `wesnoth` submodule via CMake, plus the TS-side comparison harness. See
  `TESTING_STRATEGY.md`.

- `apps/web` — Vite app wiring the engine worker, renderer, and UI together.

## Content pipeline

WML, images, and audio come from `wesnoth/data/` (and `wesnoth/images/`,
`wesnoth/sounds/`, `wesnoth/music/`) as-is. No FetchFS/IDBFS virtual
filesystem is needed this time (that existed to satisfy Emscripten's libc
file API) — the engine can `fetch()` and parse WML text directly, and
images/audio are ordinary browser asset loads through PixiJS/`Audio`/Web
Audio. Whether to fetch WML per-scenario at runtime or precompile parsed
`Config` trees at build time is an open perf question to revisit once the
WML pipeline exists (large campaigns may parse slowly if done cold in the
browser on every load).

## Multiplayer (sketch, deferred)

Upstream Wesnoth MP is **lockstep replay**, not state sync: player actions
that consume randomness or affect shared state are intercepted
(`synced_context.cpp`), recorded (`replay.cpp`), and the *commands* (not
resulting state) are relayed to other clients via a dumb relay server
(`wesnothd`) that does not itself simulate the game. Every client replays
identical commands through an identically-seeded RNG to converge on
identical state. A wesnothweb2 multiplayer mode means: a small Node/WS relay
service (not necessarily wire-compatible with `wesnothd`) plus exact RNG/
combat determinism, which Phase 2's RNG and combat work already targets.
This is scoped as a distinct, late, optional phase — see
`IMPLEMENTATION_PLAN.md`.
