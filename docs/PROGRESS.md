# Progress log

Running log of an autonomous execution session, updated as work happens so
it survives context compaction and is reviewable afterward. Newest entries
at the bottom. Each entry: what was done, what was decided/guessed without
asking, and what's known-incomplete.

Strategy note (2026-09-06): the phased plan in `IMPLEMENTATION_PLAN.md` is
strictly sequential (WML → data model → rules → Lua → rendering → UI), but
since the user wants something visible in a browser within a few hours,
execution here deliberately front-loads a *thin vertical slice* — enough
WML parsing + data model + rendering to show `Dead_Water`'s first
scenario's map and starting units in the browser via Vite — ahead of full
breadth on any one phase, then deepens each phase with remaining time.
This is a scope/ordering judgment call, not a change to the plan itself.

## 2026-09-06/07: Phase 0 scaffold + Phase 1 dispatch

- npm workspaces monorepo scaffolded (`packages/{engine,lua-bridge,renderer,ui}`,
  `apps/web`), Vite dev server confirmed serving a placeholder Svelte app
  end-to-end (verified via curl against a live server on :5173).
- `wesnoth` submodule added as a **shallow** clone (`--depth 1`,
  `wesnothlite` branch, `shallow = true` in `.gitmodules`) after an earlier
  full-history clone (~4GB) was caught and redone — flagged by the user,
  worth remembering for any future submodule/clone work: always shallow
  unless told otherwise.
- Bumped vite/vitest/vite-plugin-svelte past initially-installed versions
  after `npm audit` found dev-server CVEs (a critical vitest UI-server
  arbitrary-file-read, a high vite path-traversal) — not exploitable in
  production builds, but the dev server binds to all interfaces here.
- Defined `packages/engine/src/wml/config.ts` (`WmlConfig`) myself as a
  fixed shared contract — the parse-tree shape both the WML pipeline and
  the data model need to agree on — specifically to let those two be built
  in parallel by separate agents without them inventing incompatible
  shapes.
- Dispatched 5 agents in parallel, each scoped to non-overlapping
  directories: renderer port-forward (ipf/ImageCache/teamColor/hex-geometry
  from the old attempt), native oracle-tooling setup (wl-image-oracle +
  scaffolding for wl-wml-oracle/wl-rng-oracle), WML tokenizer+preprocessor+
  parser, the WFL formula interpreter, and the core data model
  (map/terrain/unit/team/game-board). Results and integration to follow in
  the next log entries.

## 2026-09-07: rate limit hit, Phase 1 finished directly

Both the WML-pipeline and core-data-model agents were cut off mid-task by
an account-wide spend limit (reset ~2:10am UTC) partway through. Rather
than wait, picked up their (already-substantial, already-typechecking)
work directly rather than re-spawning agents, since a shared account limit
would likely reject new agent spawns too.

- **WML pipeline**: verified it actually parses Dead_Water's real scenario
  1 end-to-end (not just synthetic snippets) -- required two "game-level"
  macro flags (`CAMPAIGN_DEAD_WATER`, the difficulty flag `NORMAL`) that
  upstream's `game_config_manager` injects before preprocessing, not
  something `preprocessor.cpp`'s job. Documented as a real integration
  test (`test/wml/deadWaterIntegration.test.ts`) and in ARCHITECTURE-
  adjacent code comments for whoever writes the scenario loader in Phase 2.
- **Found and fixed a real preprocessor bug** while chasing this down: any
  directive that consumes through end-of-line (plain `# comment`,
  `#textdomain`, `#undef`, `#error`, `#warning`, `#deprecated`, `#else`/
  `#endif`) was dropping the newline it consumed from the *output* text,
  silently merging that line with the next one. Not a narrow edge case --
  `data/core/terrain.cfg` hit it on an ordinary trailing `# comment` after
  a value, and any real WML file could. Fixed all 7 call sites; see the
  commit for the one look-alike spot (inside macro-body capture) that was
  traced by hand and confirmed NOT to need the same fix (would have
  double-spaced instead).
- **Core data model**: finished `Team.ts` and `GameBoard.ts` (the two files
  the interrupted agent hadn't reached yet) on top of its already-solid
  `Location`/`Map`/`Terrain`/`MoveType`/`Unit`/`UnitType`. Wrote a
  real-content integration test loading Dead_Water scenario 1's actual map
  file and `[side]`/`[unit]` data through `GameBoard.fromConfig`, which
  caught a genuine bug in that same new code: inline `[side]` leaders with
  no explicit `x=`/`y=` (the normal case -- confirmed neither of this
  scenario's two leaders have one) all resolved to the same invalid-
  location sentinel and silently overwrote each other. Fixed with a
  `map.startingPosition(side)` fallback, matching upstream's real
  placement logic. The test also surfaced (and now documents rather than
  asserts around incorrectly) a *known, expected* Phase 1 limitation: units
  placed via `[event]`-nested `[unit]` tags from what are really two
  different, mutually-exclusive scenario events can collide on the same
  hex when naively loaded "all at once," because nothing here understands
  event timing yet -- that needs Phase 2's WML event pump, not a Phase 1
  data-model fix.
- Real unit-type-database loading (`data/core/units/`, which needs
  `[base_unit]`/gender-variation inheritance flattening that `UnitType.
  fromConfig`'s own module doc explicitly defers) is NOT done -- the
  GameBoard test uses a permissive stub `resolveType`. This is the next
  concrete gap, not yet a blocker for anything attempted so far.
- All 83 engine tests + 45 renderer tests + 3 oracle-tools tests passing,
  clean typecheck across every package. Phase 1 is DONE for its stated
  milestone (load real Dead_Water scenario 1 into a queryable in-memory
  model, headless).

## 2026-09-07: Phase 4 (unit animation slice) done -- terrain layering still deferred

Landed cleanly (~34 min, ~330K tokens), independently re-verified
(typecheck clean, 106/106 own tests, spot-checked the flagged ImageCache
change and the real Elvish/Merman Fighter content usage directly). See
the commit for full detail: the `matches_headless()`-derived animation-
context schema, real `[if]`/`[else]` branch expansion (a real load-
bearing macro dependency, not a stub), frame/position extraction, and a
ToD tint wired into `ImageCache` as a new `~TOD()` pseudo-op. Caught a
real bug via its own real-content test: the WML parser coerces
`hits=yes`/`hits=no` into booleans, which broke `hits_` filter parsing
until a dedicated string-reading fix landed.

Deliberately NOT attempted: full terrain *image* compositing
(`terrain/builder.cpp`'s `[terrain_graphics]` rule layering) -- this is
the specific thing that stalled the original wesnothweb attempt for
months, and it's flagged in this project's own plan as high-risk/
deferred. `SnapshotBoard.ts`'s flat-coloured terrain placeholder from the
vertical slice is untouched. Also not done: wiring the new animation
system into `SnapshotBoard` so combat actually animates visually in the
browser demo (the animation *logic* is real and tested; nothing yet
calls it from the renderer's PixiJS drawing code) -- a reasonable next
increment whenever picked back up, but not attempted this pass in favor
of moving on to Phase 5 given the user's original "up to phase 5"
request and the size this session has already reached.

## 2026-09-07: Phase 3 done -- Fengari embedded, Lua 5.4 patch, host API subset

Landed cleanly as a single large subagent run (~35 min, ~300K tokens --
the biggest single task of the session), with real verification built in
by the agent itself rather than needing rescue work afterward (unlike the
actions/combat agent earlier). Independently re-verified: typecheck
clean, all 32 of its own tests pass, and spot-checked its most notable
claims directly (the `debug.getmetatable` fix is really in the patched
`wml-flow.lua`; the `RETREAT_WHEN_WEAK` Lua snippet it claims to extract
really is at that exact line in the real `Heir_To_The_Throne/utils/
side_ai.cfg`). Full 265-test suite across all four packages passes.

The 8 Lua-5.4-syntax files (`<const>`/`<close>`) are patched in
`packages/lua-bridge/vendor-lua-patches/`, substituted transparently by a
loader that reads everything else straight from the submodule unmodified.
Real bug caught by its own tests, not by inspection: the first patch
attempt used `getmetatable(x).__close`, which silently returned `nil`
because `scoped_var()`'s `__metatable` field shadows plain `getmetatable`
with a string -- only surfaced once a test asserted the WML variable was
actually restored after a thrown error, not just that the files parsed.

Host API scope is deliberately narrow: `wml.variables` bridged to the
real `VariableStore`, `wesnoth.units.get` bridged to real `GameBoard`/
`Unit` objects (6 fields), a minimal `require`, and a hand-written `wml`/
`wesnoth` bootstrap covering just what the patched standard-library files
and its own verification targets need -- not the full `core/wml.lua`
bootstrap or directory-cascading `require()`. Verified against real,
unmodified content: extracted the literal `[lua]` conditional from
`Heir_To_The_Throne/utils/side_ai.cfg`'s `RETREAT_WHEN_WEAK` macro via
regex on the actual file (not retyped) and ran it through the bridge for
several turn numbers.

## 2026-09-07: Phase 2 core done -- RNG, pathfinding, event pump, actions/combat

All landed as subagents (with two more rate-limit interruptions along the
way, reset times shifting later each time -- account-wide, affects
subagent spawns and my own direct work equally once hit). RNG and
pathfinding finished cleanly with real verification built in by the
agents themselves (RNG against throwaway native C++ oracles plus a
published std::mt19937 test vector; pathfinding against Home_1.map's real
smallfoot/swimmer movetypes). The WML event pump landed cleanly too, with
a real test firing Dead_Water scenario 1's actual prestart event through
the real pump and checking real dialogue text and macro-computed values.

The actions/combat agent was cut off by a rate limit before writing a
single test for 2714 lines of code, including the highest-risk module in
the project (attackPrediction.ts, the from-scratch combat-probability
matrix engine). Picked this up directly rather than re-spawning (same
account-wide limit would likely reject a new spawn too) and wrote real
verification myself, which found two severe, confirmed bugs before
anything downstream could build on them:

1. **attackPrediction.ts**: `ProbMatrix` used maxHp values directly as
   row/column counts instead of maxHp+1, silently shifting every combat
   outcome down by one HP and dropping the top HP value's probability
   mass entirely. Confirmed against `attack_prediction.cpp` (`prob_matrix`'s
   real constructor does `rows_(a_max+1)`) and caught by a hand-computed
   binomial ground-truth test that needed no C++ oracle to know the right
   answer (two independent 50% hits must split HP exactly 0.25/0.5/0.25).
2. **MoveType.ts** (data model, outside the actions work's scope, but a
   clear one-liner worth fixing on sight): `resistanceAgainst` defaulted
   an unlisted damage type to 0 instead of the real default of 100,
   confirmed directly against `movetype.cpp`. Since real units only
   declare resistances for damage types they're unusually strong/weak
   against, this would have made most real combat deal 1 damage (the
   rounding floor) instead of the correct amount -- a bug broad enough to
   corrupt the overwhelming majority of real combat outcomes.

Also worth remembering for future test-writing in this repo: (a) small
hand-built test maps need extra border padding (an NxN map string parses
to (N-2)x(N-2) *playable* hexes -- caught this same thing on Home_1.map
during Phase 1 too, and hit it again writing new tests, so it's clearly
an easy trap, not a one-off); (b) MoveType per-terrain tables must be
keyed by `TerrainTypeData`'s *resolved* id (falls back to the terrain
code's own string, e.g. "Gg", when nothing's registered), not a made-up
label, since an unmatched key silently falls through to the table's
default rather than erroring.

183 passing engine tests total, clean typecheck. Phase 2's stated
milestone (a golden-scenario regression test playing a full scenario
headlessly, combat checked against a `wl-combat-oracle`) is NOT done yet
-- what exists is thorough per-module verification (RNG bit-exact,
pathfinding/combat against real content and hand-computed ground truth,
events against a real scenario's prestart handler), but no
`wl-combat-oracle` was built and no single test exercises RNG+pathfinding+
combat+events together end-to-end yet. That integration (and wiring the
event pump's `attack`/`recruit`/`move_unit` extension-point placeholders
to the real actions/ functions) is the natural next step before calling
Phase 2 fully done.

## 2026-09-07: vertical slice done -- real scenario renders in the browser

Task #3 (the browser-visible checkpoint, prioritized ahead of full Phase 2
per this log's opening strategy note): `npm run dev` now serves
Dead_Water scenario 1 with real terrain, real sides/units (13 of them,
correctly positioned), and real unit sprite art, all sourced from the
actual `wesnoth/` submodule content via the real WML/data-model pipeline
built in Phase 1 -- see the commit for full detail. Two honest
simplifications, both clearly marked in code and intended to be temporary:

1. **Build-time snapshot, not live in-browser WML loading.** The WML
   preprocessor's file-access is synchronous (mirrors Node's `fs`); making
   that work over `fetch()` (inherently async) is real, undone work.
   `apps/web/scripts/build-scenario-snapshot.mjs` bridges this by running
   the real pipeline in Node at build time and shipping the result as
   static JSON. Revisit when a real in-browser scenario loader is built.
2. **Flat-coloured terrain hexes, not real terrain image compositing.**
   That's genuinely Phase 4 scope (terrain_graphics rule matching), not
   something either interrupted Phase 1 agent was ever asked to build.
   Units DO use real sprite art through the ported ImageCache/ipf
   pipeline -- only terrain is a placeholder.

Also had to reconcile a real coordinate-convention mismatch between the
engine's `Location` (0-based, odd columns shifted down, verified against
`map_location.cpp`) and the renderer's `hexGeometry.ts` (1-based, even
columns shifted down, ported from attempt #1). Confirmed algebraically
these are the *same* convention once you account for the indexing offset
-- `location.wmlX`/`wmlY` feed `hexToPixel` directly, no transform needed
-- and documented this in `SnapshotBoard.ts` since it's exactly the kind
of thing the core-data-model agent flagged as a risk to get wrong.

Couldn't get an actual screenshot: Playwright requires Node 20+, this VM
has 18.20.4, and upgrading Node felt like too much risk for a
verification-only need. Verified everything else thoroughly instead --
`svelte-check` (plain `tsc` silently skips `.svelte` files, so this needed
setting up separately) passes clean, and curl confirmed every real request
the app makes at runtime (HTML, JS transforms, the workspace package's
source resolution through Vite, the snapshot JSON, real PNG assets)
resolves correctly. High confidence, but not the same as having looked at
pixels -- worth an actual look next time a browser is available.

## 2026-09-07: renderer + oracle tooling landed

- Renderer port-forward (ipf/ImageCache/teamColor/hex-geometry/tween/
  terrainPositioning) landed with 45 passing tests, committed. Fixed a
  tsconfig `rootDir`/`include` conflict (`TS6059`) proactively across all
  packages before the other agents' test files could hit the same wall.
- **Oracle tooling landed and works**: `wl-image-oracle` builds and runs
  (confirmed producing correct 72x72 PNGs for real locators, including a
  `~MASK(...)` hex case) via a minimal CMake target
  (`-DENABLE_IMAGE_ORACLE=ON`) that does NOT pull in the full SDL2_mixer/
  pango/fontconfig desktop build (`ENABLE_GAME=OFF` genuinely gates that
  off, confirmed rather than assumed). `packages/oracle-tools/` wraps it
  with a `runOracle.ts` helper and passing Vitest tests against checked-in
  fixtures. Build reproduction steps in `packages/oracle-tools/README.md`
  and `docs/ORACLE_BUILD_NOTES.md`.
- **Judgment call flagged for user review, not acted on autonomously**:
  the oracle source (`wl_image_oracle.cpp` + its CMake wiring) turned out
  to only exist as *unpushed local commits* in the old `wesnothweb`
  project's checkout (`/home/tom/wesnothweb/wesnoth`, 5 commits ahead of
  `origin/wesnothlite`) — never actually on GitHub. Those unpushed commits
  also contain a committed ~19MB binary and an actual crash core dump
  (`build-oracle/wl-image-oracle`, `build-oracle/core`), so I did not push
  that history as-is. Instead I re-committed just the source-level wiring
  (no binaries; added `build-oracle/` to the submodule's `.gitignore`) as
  a clean new commit on top of the current `origin/wesnothlite` tip,
  **directly in the `wesnoth` submodule checkout** — but pushing it to
  `github.com/tnecio/wesnoth` was blocked by the permission system as an
  action affecting a different repository than this session, which is the
  right call. **This means the fix currently exists only in this VM's
  local submodule checkout, not on GitHub** — a fresh clone of
  `wesnothweb2` elsewhere would not get a working oracle build until this
  is pushed. To publish it: `cd wesnoth && git push origin wesnothlite`
  (fast-forward, no force needed, no binaries in the diff — I checked).
  The outer repo's submodule pointer hasn't been bumped to this commit
  either, for the same reason (would reference an unpublished commit).
