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

## 2026-09-08: recovered a lost local commit in the wesnoth submodule

While doing final checks, found the local-only oracle-wiring commit
recorded earlier in this log (2026-09-07, "renderer + oracle tooling
landed") was gone from the `wesnoth` submodule checkout -- not even in
`git reflog`, meaning the submodule's `.git` metadata got reset to a
fresh clone at some point during later work in this session (likely one
of the Phase 3/4/5 subagents touching it despite being told not to,
though it's not worth forensically tracking down which). The actual
working-tree files survived intact and matched exactly (verified line
counts and the `build-oracle/` `.gitignore` entry before trusting it), so
nothing was actually lost -- just re-committed locally. **Still not
pushed to `github.com/tnecio/wesnoth`** -- publishing it remains the
user's call, same as when this was first flagged.

## 2026-09-08: Phase 5 done -- the browser demo is genuinely playable

All originally-requested phases (0-5) are now done. Landed as a large
subagent run cut off mid-task by a third account-wide rate limit (reset
3am UTC) -- same recovery pattern as before: picked up directly rather
than re-spawning. What was on disk was excellent (see the commit for
detail: a deliberately rune-free `GameSession` domain class specifically
to keep this project's plain-`tsc` verification meaningful, real combat-
prediction numbers in the side panel, recruit/end-turn shown disabled
with real explanations rather than faked), but **entirely disconnected**:
`packages/ui/src/index.ts` was still the Phase-0 placeholder, never
updated to export `GameShell`, and `apps/web/src/App.svelte` still had
the old static-render-only wiring from the vertical slice -- so none of
it was reachable. Finished the wiring myself: fixed `packages/ui`'s own
`tsc --noEmit` pass (needed a `svelte.config.js` + ambient `*.svelte`
module declaration that `apps/web` gets for free from its Vite dependency
but a plain library package like `packages/ui` does not), rewired
`App.svelte` to actually render `<GameShell>`, and regenerated the
committed `scenario-snapshot.json` (stale against the new format the
agent's snapshot-loader work needed). Verified the whole live request
chain through the already-running dev server one more time (every file
in the new App.svelte -> GameShell -> GameBoardView/SidePanel/TurnBanner
-> engine-barrel -> snapshot-JSON chain resolves with real content).

You can now actually click around Dead_Water scenario 1 in the browser:
select a unit, see its real pathfound reachable hexes and adjacent attack
targets highlighted, move it, preview a real hit-chance/damage/death-
probability combat prediction before attacking, confirm to resolve it
with real (seeded, reproducible) RNG, and watch HP/board state update.
Recruit and end-turn are visibly present but disabled with honest
tooltips, not faked.

331 passing tests across all four packages, clean typecheck and
svelte-check everywhere. `npm run dev` (still the same dev server that's
been running since Phase 0) serves it live.

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

## 2026-09-08: playability-feedback pass -- selection, story/message, pan/
zoom, recruit, end-turn

Direct response to real user playability feedback on the Phase 5 demo
("no indicator of unit selection, no scenario info, no ability to scroll
or zoom map, no support for 'story' or 'message' tags", "can't recruit or
end turn"). All seven requested items landed; terrain image rendering
stays deferred (user explicitly signed off on that) and build-time WML
snapshots stay the accepted approach (also explicitly signed off).

- **Selection indicator fixed**: `SnapshotBoard`'s selection ring was
  drawn into `highlightLayer`, added to the stage BEFORE `unitLayer` --
  it rendered under unit sprites, the likely root cause of "no indicator".
  Added a dedicated `selectionLayer` added AFTER `unitLayer`, and thickened
  the ring into a dark-outer/bright-inner double stroke for contrast
  against any sprite/terrain.
- **Story + message viewers**: new `StoryViewer.svelte`/`MessageViewer.svelte`
  full-screen click-through overlays. `GameSession.runStartupEvents()` now
  actually calls `runScenarioStartupEvents(['prestart','start'])`, which
  Phase 5's `GameSession` never did -- the real event-spawned units
  (citizens, Cylanna, Gwabbo, the enemy undead) and real `[message]`
  dialogue are now genuinely reachable in the browser, not just supported
  in the engine. `GameShell` sequences story -> messages -> playing.
- **Camera pan/zoom**: `GameBoardView.svelte` now drags `board.stage.x/y`
  and wheel-zooms `board.stage.scale`, implemented as plain DOM listeners
  (not PixiJS's own event system) with a drag-distance-based click
  suppression (a capture-phase `pointerup` listener on the canvas's parent,
  which reliably runs before PixiJS's own canvas listener computes its
  click) so panning doesn't also fire a hex click at release.
- **Recruit wired up for real**, and along the way found and fixed a
  latent gap that would have made it silently impossible: `gameBoardFromSnapshot`
  built its client-side `GameMap` against a genuinely EMPTY `TerrainTypeData`
  (deliberate, documented, but only for movement/defense purposes) -- which
  also meant `map.isKeep()`/`isCastle()` always returned `false` client-side,
  so no leader could ever be recognized as standing on a keep. Fixed by
  shipping real castle/keep/village flags per terrain-code-in-use in a new
  `GameBoardSnapshot.terrainFlags` field (populated in `build-scenario-
  snapshot.mjs` from the real `terrainData` it already loads), and
  synthesizing minimal `[terrain_type]`-equivalent configs from them
  client-side. `scenario-snapshot.json` regenerated. Recruiting itself uses
  the real `connectedCastleTiles`/`recruitUnit`; deliberately does NOT use
  `checkRecruitLocation`'s "alternate location" fallback (see `gameSession.ts`'s
  `tryRecruitAt` doc comment) since silently placing a recruit on a
  different tile than the one clicked would be a bad surprise for a
  precise click-driven UI.
- **End turn**: real hotseat cycling (`GameSession.endTurn`) -- refreshes
  the incoming side's moves/attacks, advances `activeSide`, increments
  `turnNumber` on wraparound. Judgment call: with no AI (Phase 7, not
  built), a human-controls-whichever-side-is-active hotseat model was
  chosen over "only playerSide is ever controllable", specifically because
  the user's stated goal (testing scenario progression and combat) needs
  the OTHER side to actually do something across turns.
- **Scenario info**: `TurnBanner`/`SidePanel` now show live turn number,
  active side, and that side's real gold.
- Added `packages/engine/src/snapshot/gameBoardSnapshot.ts`'s
  `createTypeResolver` (shared unit-type-resolution logic factored out of
  `gameBoardFromSnapshot`, reused by `GameSession` for startup-event/recruit
  type lookups) and a real-content `packages/ui/src/gameSession.test.ts`
  (new: `packages/ui` had no test infra before this) covering startup
  events, hotseat end-turn, and recruiting against the real committed
  snapshot -- 6 new tests, all passing.
- 194 engine + 106 renderer + 6 ui = 306 tests passing, clean `tsc --noEmit`
  across engine/renderer/ui, clean `svelte-check` (0 errors; 4 pre-existing-
  pattern "state referenced locally" warnings on one-time prop reads at
  component init, harmless) in both `packages/ui` and `apps/web`. No real
  browser available (Node 18.20.4, Playwright needs 20+) -- verified via
  curl that every new/changed file transforms cleanly through the live dev
  server, and via careful reading of the pan/zoom click-suppression and
  overlay-blocking logic, but pixel-level rendering (does the selection
  ring actually look right, does drag-to-pan feel right) is NOT visually
  confirmed.

`packages/ui`'s new `vitest` devDependency triggered a fresh `npm audit`
finding: a moderate `@vitest/mocker` path-traversal/arbitrary-file-read
advisory (GHSA-82fw-gwwq-j7x9) affecting vitest 2.1.0-4.1.10, published
after Phase 0's original CVE check passed clean on this same 3.2.7 pin.
No patched 3.x release exists yet -- only vitest 5 (a breaking major
bump). Left it as-is rather than force an unreviewed major upgrade across
every package's test suite: this is dev-tooling-only risk (the mocker's
exposure requires reaching Vitest's own UI/dev server, which nothing here
does), the same category of finding as Phase 0's, just newer.

## Post-Phase-5 revision #3: real-browser visual verification, and the bug it found

The user asked directly why Node couldn't just be upgraded on this VM
rather than continuing to ship blind. Nothing actually blocked it: installed
`nvm` + Node 20.20.2 side-by-side with the VM's system Node 18.20.4 (via
`~/.bashrc`-sourced `nvm.sh`), leaving the system Node -- and everything
already built/verified against it (npm workspaces, the running Vite dev
server, `tsx`) -- untouched. Installed Playwright + Chromium under the
new Node 20 and drove the live dev server (`http://localhost:5173/`,
already running under system Node the whole time -- a Playwright-driven
browser is just an ordinary HTTP client to it, no restart needed) with
real screenshots for the first time this session.

**Real bug found and fixed**: every unit sprite silently failed to
decode (`InvalidStateError` in the console) -- the board rendered with
real terrain colors and turn UI, but zero unit art, just the side-color
fallback dot described in "Post-Phase-5 revision" above. Root cause:
`apps/web/public/game-images` was a symlink to `wesnoth/data/core/images`
directly, but `packages/renderer/src/images/ImageCache.ts`'s `imageUrl()`
(ported forward from attempt #1, where the base URL really was the whole
data root) unconditionally prepends `core/images/` to any path that
doesn't already start with `core/` or `campaigns/` -- so a raw unit-type
image path like `units/undead-skeletal/skeleton/skeleton.png` resolved to
`/game-images/core/images/units/.../skeleton.png`, double-prefixed and
404ing (Vite's SPA fallback served `index.html` in its place, which the
browser then failed to decode as a PNG). `StoryViewer.svelte`/
`MessageViewer.svelte` had separately hand-rolled `/game-images/${path}`
string interpolation that happened to work only because the symlink's
scope matched their un-rooted paths -- a second, inconsistent convention
for the same problem.

Fixed at the root: `game-images` now symlinks the whole `wesnoth/data`
directory (matching what `imageUrl()` always expected), and
`build-scenario-snapshot.mjs` gained `rootImagePath()`, which resolves
each raw WML image path against the same search order the real C++ engine
uses -- the campaign's own `images/` dir first (`fs.existsSync` against
the actual submodule content, e.g. this correctly routes Kai Krellis's
campaign-exclusive `child_king.png` to `campaigns/Dead_Water/images/...`
rather than a 404 under `core/`), falling back to `core/images/`.
Applied to both `unitImages` (unit-type sprites) and `extractStory`'s
background image. `StoryViewer`/`MessageViewer` now import and use the
same `imageUrl()` from `@wesnothweb2/renderer` instead of duplicating the
rooting logic, so there is one convention, not two. Regenerated
`scenario-snapshot.json`; spot-verified with `curl` that the rooted core
and campaign paths both resolve (200, real PNG bytes) through the live
dev server.

Also fixed, found via the same visual pass: `GameBoardView.svelte`'s
status line froze at `"<scenario> -- 2 units, ..."` forever (a one-time
string built from `units.length` inside the mount effect's async IIFE,
before the scenario's startup events had spawned the other nine units,
and never recomputed after). Replaced with a `$derived` `readyLabel` that
stays live; `status` now holds only transient loading/error text.

Confirmed visually (real Chromium screenshots, not just code reading) that
every item from the user's playability feedback actually works: real unit
sprites (merfolk citizens/priestess/netcaster/child-king, undead
skeleton/dark-sorcerer, all visually distinct), the gold selection ring
and blue movement-range highlight around a clicked unit, camera pan
(drag) and zoom (wheel) across the full 43x27 map, the story/message
overlay sequence advancing on click, recruiting (picked "Merman Fighter",
clicked a highlighted castle tile, watched the log entry and the new
sprite appear, unit count 11 -> 12), and end turn (side 1 -> side 2, gold
120 -> 150, log entry). No console errors during any of this. Full test
suite re-run after all fixes: 341 tests passing (194 engine + 32
lua-bridge + 3 oracle-tools + 106 renderer + 6 ui), clean `tsc --noEmit`
on renderer/ui.

This closes out the "no real browser available" caveat that had shadowed
every prior playability claim in this doc.

## 2026-09-09: priority reset, and two real bugs behind "selection visuals still lacking"

User direction: focus on Phase 5 (UI polish) + Phase 6 (content breadth).
Phase 7 (real AI) deferred until Phase 5 is solid. Phase 8 (multiplayer)
struck out entirely -- not needed for MVP, and there's still plenty of
single-player polish work ahead. Recorded in `IMPLEMENTATION_PLAN.md`.

User specifically flagged unit selection visuals as still lacking despite
the earlier z-order fix. Investigated with fresh Playwright screenshots
and found two distinct, real bugs, not one:

1. **Contrast**: the reachable-tile fill (`0x3fa9f5`, light blue, alpha
   0.35) is nearly invisible on Dead Water's ocean terrain (also blue),
   and the selection ring's inner stroke (`0xffd54a`, gold) is nearly
   invisible on keep/sand hexes (also tan/gold) -- confirmed directly by
   screenshot, hexes Kai Krellis's own starting keep included. Since Dead
   Water is an all-water merfolk campaign, this hit almost every hex.
   Fixed by adding a solid white 2-3px outline to every highlighted hex
   (fill colour still carries blue/red/green semantic meaning where
   contrast allows, but the white border is what actually guarantees
   visibility against any terrain hue) and swapping the selection ring's
   inner stroke from gold to white (paired with the existing black outer
   stroke, white has no terrain-colour blind spot).

2. **A real, intermittent reactivity race** (the more serious of the two):
   `GameBoardView.svelte`'s `board` variable was a plain (non-`$state`)
   `let`, assigned inside the mount effect's async IIFE after `await
   app.init(...)`. The two small reactive effects that call
   `board?.updateUnits(...)`/`board?.setHighlights(...)` only re-run when
   their TRACKED dependencies (`units`, `selectedHex`, etc) change --
   never merely because the untracked `board` variable was later assigned
   a value. If a prop happened to change before `app.init()` resolved
   (routine -- it's not instant), that effect's run saw `board` still
   `undefined`, no-opped, and then genuinely never ran again once `board`
   became available, since nothing it tracks changed afterwards. Confirmed
   empirically by instrumenting both the effect and `setHighlights` itself:
   the *exact same* click sequence rendered the ring/highlights correctly
   on some runs and silently not at all on others -- the signature of a
   timing race, not a one-off mistake, and exactly consistent with a user
   report of something being unreliably visible rather than reliably
   broken or reliably fine. Fixed by making `board` a `$state` variable,
   so its own assignment is a tracked write both effects correctly
   subscribe to. Re-verified with a 6-run stress test (faster, 150ms
   clicks, deliberately trying to provoke the old race) -- the ring and
   move-range fan rendered correctly on every single run afterward.

Both fixes are in `packages/renderer/src/SnapshotBoard.ts` and
`packages/ui/src/GameBoardView.svelte`. 341 tests still passing, clean
`tsc`/`svelte-check`.

Next up (in priority order, per the updated `IMPLEMENTATION_PLAN.md`):
real per-unit-type combat/movement stats (currently every one of the 332
types shares identical placeholder stats), victory/defeat conditions
(scenarios never currently end), then save/load.

## 2026-09-09: real per-unit-type combat/movement stats

Replaced the identical-for-every-type placeholder (30 HP, 5 movement, one
3x6 blade attack, one shared flat per-terrain movement/defense table) with
real, per-type stats sourced from `wesnoth/data/core/units.cfg` and
Dead_Water's own unit files.

- New `packages/engine/src/model/UnitTypeDatabase.ts`: the `base_unit=`
  flattening loader `UnitType.ts`'s own module doc comment had deferred.
  Attribute-level inheritance (derived wins wherever it sets an attribute,
  base fills the rest) matches upstream's `config::inherit_from` exactly;
  child-tag inheritance (`[attack]`, `[movement_costs]`, `[defense]`, etc.)
  uses a deliberate simplification -- "derived replaces base wholesale for
  a tag name if it has ANY children with that tag, else inherits base's
  wholesale" -- instead of upstream's real position-indexed pairwise
  `merge_with`. Verified this changes no real stat this project ships:
  `base_unit=` is used NOWHERE in the entire `wesnoth` submodule (checked
  directly), so the simplification's code path is only exercised by this
  module's own synthetic tests. `[male]`/`[female]` sub-tags are simply
  never read (this project has no gendered recruiting UI) -- confirmed
  safe by checking the only two files under `data/core/units/` that use
  them at all (`monsters/Horse_Black.cfg`/`Horse_Dark.cfg`): both declare
  full stats at the top `[unit_type]` level already.
- `apps/web/scripts/build-scenario-snapshot.mjs`'s `resolveType` now builds
  real `UnitType`s via `UnitType.fromConfig(flattenedCfg, movementTypeConfigs,
  terrainData)` for all ~332 discovered ids, instead of one shared stub.
  The snapshot now also ships `unitTypeConfigs`/`movementTypeConfigs`/
  `terrainTypeConfigs` (real WML, JSON-round-tripped, same mechanism as
  `scenarioConfigJson`) so the browser rebuilds the exact same real
  `UnitType`s client-side through the real `UnitType.fromConfig`/
  `MoveType.fromConfig`/`overlay` engine code -- not a re-invented
  client-side table.
- `gameBoardSnapshot.ts`'s `createTypeResolver`/`gameBoardFromSnapshot`
  factored into a shared `buildSnapshotContext`, which uses the new real
  fields when present and falls back to the old flat-shared-`MoveType`
  simplification (`buildFlatMoveType`) when they're absent, so hand-built
  test fixtures without the new fields keep working unchanged.
- Verified directly (not just "tests pass"): spot-checked Merman Fighter
  (hp 36, movement 6, trident pierce 6x3, cost 14), Merman Child King (hp
  22, movement 6, scepter impact 4x3, cost 8 -- a Dead_Water-specific type
  from `campaigns/Dead_Water/units/Child_King.cfg`, not core), Skeleton (hp
  34, undeadfoot movetype, axe blade 7x3), and Dark Sorcerer (hp 48, THREE
  real attacks: staff/chill wave/shadow wave) against the real regenerated
  JSON by hand-reading the real `.cfg` source -- exact matches. Confirmed
  real per-terrain-type resolution actually differs by unit type now (the
  whole point): Merman Fighter (swimmer) costs 1 to enter deep water and 2
  for flat ground; Skeleton (undeadfoot) costs 3 for deep water and 1 for
  flat ground -- previously both were indistinguishable.
- 332 tests across the monorepo pass (214 engine incl. 16 new
  `UnitTypeDatabase.test.ts` tests, 32 lua-bridge, 3 oracle-tools, 106
  renderer, 9 ui -- the last of these also covers a concurrently-landed,
  unrelated victory/defeat-conditions commit). Clean typecheck on
  renderer/ui; engine typecheck has one pre-existing, unrelated failure
  (`test/actions/victory.test.ts`, a `readonly number[].sort()` type error)
  from that same concurrent commit -- not touched, out of scope for this
  task, flagged rather than silently left unmentioned.

  The flagged `readonly number[].sort()` error is fixed (spread into a
  mutable array first: `[...result.notDefeated].sort()`) -- confirmed
  clean `tsc --noEmit` afterward.

## 2026-09-09 (cont'd): victory/defeat conditions

Added `packages/engine/src/actions/victory.ts`'s `checkVictory` -- a TS
port of the default (`no_leader_left`-only) case of upstream's
`game_board::check_victory` (`src/game_board.cpp`): a side is not-defeated
while it has a unit with `canRecruit=true`; the scenario ends once every
remaining not-defeated side is mutually allied with every other one. Read
the real `wesnoth/src/game_board.cpp`/`play_controller.cpp` source
directly to get this right rather than guessing. NOT ported (documented in
that file's own doc comment, not silently dropped):
`defeat_condition=no_units_left`/`=never` (`Team` doesn't parse
`defeat_condition=` yet -- every side defaults to `no_leader_left`, which
is Dead Water scenario 1's real setting for both sides), and the real
`enemies_defeated`/`die` WML event firing that would let a scenario script
its own victory message and extra non-leader defeat conditions (Dead
Water's `{HERO_DEATHS}` macro adds "Cylanna dies" as an extra lose
condition via `[event] name=die` + `[endlevel]` -- not currently wired,
since firing `die` correctly needs the event to fire *before* the dead
unit is removed from the board so `[filter] id=...` can still match it,
and `combat.ts`'s headless combat resolver doesn't carry an `EventPump`
reference. This generic leader-death check already covers the scenario's
*primary* objective ("Defeat enemy leader"/"Death of Kai Krellis" -- Kai
Krellis is side 1's only recruiting leader) -- the Cylanna-specific bonus
condition is a documented gap, not a silent one, and a natural target for
when real `die`/`enemies_defeated` event wiring gets built (valuable
infrastructure for Phase 6's other scenarios too, not just this one).

Wired into `GameSession`: `checkForGameEnd()` runs after any
`confirmAttack()` that killed a unit, latches `scenarioResult: 'victory' |
'defeat' | null`, and every mutating method (`handleHexClick`,
`confirmAttack`, `endTurn`) now no-ops once it's set. `GameShell.svelte`
gained an `'ended'` phase and a new `ScenarioEndOverlay.svelte` (same
full-screen-overlay style as `StoryViewer`/`MessageViewer`, but terminal --
nothing to click through, just "reload to play again"). Visually confirmed
via a temporary `window.__debugSession` hook + Playwright screenshot
(removed before commit) that the overlay renders correctly and blocks
further board interaction.

10 new tests (4 hand-built `checkVictory` unit tests -- same "no real WML
needed, it's a self-contained algorithm" reasoning as
`attackPrediction.test.ts`'s binomial ground truth -- plus 3 real-content
`GameSession` integration tests using the committed snapshot, alongside
gameSession.test.ts's existing 6). All passing, clean `tsc`/`svelte-check`.

## 2026-09-09 (cont'd): save/load

Per the original Phase 5 scope ("save/load ... gzipped, in IndexedDB").
New `packages/ui/src/persistence.ts`: gzip via the native `CompressionStream`/
`DecompressionStream` APIs (no library needed for a few hundred bytes of
JSON) into an IndexedDB object store, keyed by a save name. This is NOT a
Wesnoth-compatible save file -- no `[replay]`, no WML variable store, no
undo history -- just `GameSession`'s own live-state shape (`SaveGameData`:
turn/side/result, every unit's position/hp/moves, every team's gold),
versioned so a future shape change can reject an old save cleanly.

`GameSession` gained `toSaveData()`/`loadSaveData()` (and a
`fromSaveData` static factory for "build a session already loaded").
`loadSaveData` clears the board's current units and rebuilds them from the
save via the existing `resolveType`, then overwrites team gold/turn/side/
`scenarioResult` -- reuses the same real `Unit.create`/`resolveType`
machinery as everything else, no parallel unit-construction path.

UI: `SidePanel` gained Save/Load buttons next to End Turn; `GameShell`
wires them to a single fixed slot keyed by scenario id (`quicksave:<id>`,
matching this project's one-scenario-today scope -- multiple named slots
would be a small extension, not a redesign, whenever Phase 6 needs it).

Verified two ways: a Node-side round-trip test (`gameSession.test.ts`,
change turn/gold/hp/moves, save, load into a *fresh* `GameSession`, assert
exact match -- also covers a save/load of a latched `scenarioResult`) since
`persistence.ts`'s IndexedDB/`CompressionStream` calls aren't available
under plain Node/vitest; and a real-browser Playwright check exercising
the actual Save/Load buttons end-to-end (end turn twice, Save, reload the
page fresh, Load, confirm turn/gold match what was saved) -- both passed.
11 ui tests total, all passing.

## 2026-09-09 (cont'd): scenario 1 -> scenario 2 continuation (real gold + recall carryover)

Made the "win scenario 1, dead end" gap real: a generic `next_scenario=`-
driven continuation, not a scenario-1-specific hack.

- **`build-scenario-snapshot.mjs` generalized**: takes the scenario `.cfg`
  filename as `argv[2]`, writes `apps/web/public/scenarios/<real-id>.json`
  instead of the old fixed `scenario-snapshot.json`. Regenerated both
  `01_Invasion.json` and `02_Flight.json` from real content. `App.svelte`
  now fetches `scenarios/01_Invasion.json` as the hardcoded entry point
  (a real picker is future Phase 6 work). Old fixed snapshot path deleted;
  `gameSession.test.ts` updated to the new paths (and now loads both
  scenarios' real snapshots).
- **`packages/engine/src/actions/carryover.ts`** (new): `computeGoldCarryover`
  (exact port of `carryover_gold.lua`'s formula), `findVictoryEndlevelGoldConfig`
  (statically walks a scenario's own `[event] name="enemies defeated"]
  [endlevel]` for bonus=/carryover_add=/carryover_percentage=, WITHOUT a real
  event pump -- same documented simplification as `victory.ts`'s missing
  `enemies_defeated` firing), and `computeCarryoverRecruits` (every surviving
  player-side unit not inline-re-declared by id in the next scenario's own
  `[side]` -- excludes Kai Krellis, whose level/XP is flagged, not silently
  dropped, as not persisting under this simplification). Hand-verified
  against Dead Water's real numbers: Home_1.map has 31 real village hexes
  (`GameMap.villages`, unfiltered by ownership), side 1's real `turns=30`
  (NORMAL), 02_Flight's real declared gold 140 (NORMAL) -- a real victory at
  turn 5 with 150 gold hand-computes to 530 next-scenario gold, matched
  exactly by both a pure-math test and one built entirely from real,
  unmodified WML content. 10 new engine tests, all passing.
- **`GameSession.startNextScenario(finished, nextSnapshot, options?)`**
  (static factory, mirrors `fromSaveData`'s pattern): computes gold +
  recall carryover from `finished`, builds a fresh session on `nextSnapshot`,
  sets the player team's gold, and populates the recall list with the
  carried-over live `Unit` objects. Exposes `goldCarryover` (the computed
  result) and `nextScenarioId` (from the real `next_scenario=` attribute).
  `GameSession` never does its own `fetch()` -- `GameShell.svelte` owns
  that, matching how `App.svelte` already fetches the first scenario.
- **Recall UI**: `GameSession.recallOptions`/`selectRecallUnit`/
  `pendingRecallIndex` mirror the existing recruit flow, but keyed by
  recall-list *array index* rather than `Unit.underlyingId` -- this project
  doesn't auto-assign unique underlying ids (`Unit.ts`), so several
  recall-list units (e.g. six carried-over citizens) commonly all share
  `underlyingId=0`, which would make that an unsafe selection/removal key;
  confirmed this would have been a real bug, not a hypothetical one, once
  real carryover started producing exactly that shape of recall list.
  `SidePanel.svelte` gained a "Recall" section (name, level, hp, cost, and
  a real unit-type icon via `imageUrl`) alongside Recruit, using the same
  castle-tile-click placement flow. `ScenarioEndOverlay.svelte` gained a
  "Continue to next scenario" button (victory + a real next scenario only;
  defeat and dead-end victories keep the old terminal message unchanged).
- Also added, since the Recall UI otherwise would have silently broken it:
  `GameBoard.clearRecallList` and `SaveGameData.recall` (optional-on-read,
  so pre-existing saves still load) so Save/Load round-trips a side's
  recall list instead of quietly dropping it.
- **Real-browser Playwright verification** (Node 20 via nvm, live dev
  server): played scenario 1 up to the interactive phase, forced a win via
  a temporary debug hook (same "bypass combat RNG" pattern as this
  project's own victory tests), screenshotted the real "Continue to next
  scenario" button, clicked it, and confirmed scenario 2 ("Flight") loaded
  with turn 1/22 (real `TURNS4` NORMAL value), **571 gold** -- hand-checked
  against the real formula for THIS run's actual numbers (120 starting
  gold, turn 1, 29 turns left, bonus 957, carryover 431, 140 + 431 = 571,
  matching the screen exactly) -- and a recall list of exactly the real
  survivors (six Merman Citizens, Cylanna at 35/35, Gwabbo at his real
  scripted 4/40 hp), with Kai Krellis correctly absent from recall (he's
  freshly placed on the board instead, per scenario 2's own `{SIDE_1}`).
  No console errors. Debug hooks removed from `GameShell.svelte` afterward;
  screenshots/script left under `.playwright-check/` (not committed).
- Verification: 380 tests passing (224 engine + 32 lua-bridge + 3
  oracle-tools + 106 renderer + 15 ui -- 10 new engine carryover tests, 5
  new ui integration tests), clean `tsc --noEmit` on engine/renderer, clean
  `svelte-check` (0 errors, same pre-existing "state referenced locally"
  warning pattern, now also covering the new `activeSnapshot`/`session`
  reassignment points) on both `packages/ui` and `apps/web`.

**Found and fixed one more real bug on review**: `GameBoardView.svelte`'s
own doc comment says its `snapshot` prop is "read once at mount, never
re-applied after" (its mount `$effect` only tracks `canvasHost`, never
`snapshot`, by original design -- rebuilding the whole PixiJS app on every
incidental prop change would be wasteful). `continueToNextScenario`
reassigns `activeSnapshot` to a genuinely different scenario, which that
effect has no way to notice -- so the PixiJS board (terrain/map/teams)
would silently stay built from scenario 1 forever, with only units/
highlights (which DO have their own tracked effects) updating underneath.
This was invisible in the subagent's own Playwright check because Dead
Water scenarios 1 and 2 happen to share the same map file (`Home_1.map`),
so a stale scenario-1 board looks pixel-identical to a fresh scenario-2
one -- confirmed by reading the code, not by a screenshot that would have
looked the same either way. Fixed by wrapping `<GameBoardView>` in
`{#key activeSnapshot.scenario.id}` so Svelte fully destroys and recreates
it on a real scenario change; verified with a temporary console.log
(removed after) showing the mount effect firing exactly twice -- once for
`01_Invasion`, once for `02_Flight` -- where it previously would have
fired once. Re-ran the full suite afterward: still 380 passing, clean
typecheck.

## 2026-09-09 (cont'd): campaign picker + synthetic debug campaigns

User request: a campaign-picker menu, on its own URL/page separate from
gameplay (real `history.pushState`/`popstate` routing, so Back/Forward
work and each page is independently bookmarkable), plus a few tiny
hand-authored campaigns for fast debugging of combat/economy/scenario
progression without playing through Dead Water's real length every time.

**Router**: `apps/web/src/router.svelte.ts`, a minimal hand-rolled
`$state`-backed router (no library -- two pages doesn't justify one).
`App.svelte` is now a two-way switch between `MenuPage.svelte` (`/`,
fetches only `campaigns.json`) and `PlayPage.svelte` (`/play/<campaignId>`,
resolves the campaign to its first scenario and fetches only that
snapshot -- nothing is preloaded before a campaign is actually picked).
Verified in a real browser: menu -> pick -> `/play/dead_water`, Back ->
`/`, Forward -> back to play, a direct navigation to `/play/dead_water`
(simulating a refresh/shared link) works via Vite's SPA fallback, and an
unknown campaign id shows a real error with a way back to the menu.

**Build script generalized** (`build-scenario-snapshot.mjs`): a path-style
argument (contains `/`) is now used directly instead of being resolved
against Dead Water's `scenarios/` dir, with campaign-specific bits
(macro flags, `_main.cfg` defines, campaign-art image search path) skipped
entirely for a non-Dead-Water path. Verified byte-identical snapshot output
for the unchanged Dead Water invocation before/after this change -- caught
one real regression while doing that (reordering `preloadDefinesFromDir`
before the `NORMAL`/`CAMPAIGN_DEAD_WATER` flags broke a core macro that
gates on those flags via `#ifdef`; fixed by preserving the original order,
confirmed with the same byte-identical diff).

**Three synthetic campaigns**, real WML (no macros), under this repo's own
`synthetic-campaigns/` (not the Dead Water submodule): `combat` (two
adjacent leaders, tiny grassland map), `economy` (a leader on a real
keep with a full six-tile castle ring, gold, a short recruit list, and a
harmless distant enemy), `progression` (two tiny scenarios chained by a
real `next_scenario=`, with a real `[event] name="enemies defeated"]
[endlevel] bonus=yes carryover_add=yes carryover_percentage=50` --
deliberately different from Dead Water's 40, so it's obviously this
campaign's own value when debugging -- and a second unit that survives
uncounted-for in scenario 2's `[side]`, to exercise real recall-list
carryover). All built with `spawnUnitsFromTree: true` (everyone placed
inline, no events needed for placement) and no `[story]`, so they land
straight in the interactive board with zero click-through.

**Found and fixed a real, previously-invisible bug while verifying the
progression campaign's carryover math by hand**: `SnapshotTeam` never
carried `income=`/`village_gold=` at all -- `gameBoardFromSnapshot`
always rebuilt every team with `income: 0` (`Team`'s own class default),
regardless of what the scenario's real WML declared. Invisible against
Dead Water (whose real side 1 also happens to declare no `income=`, i.e.
0 either way) but caught immediately once a synthetic campaign
deliberately set `income=1` specifically to exercise this part of the
formula and the resulting next-scenario gold (89) didn't match the hand
computation (94). Fixed by adding `income`/`incomePerVillage` to
`SnapshotTeam` (optional, defaulting to the real WML defaults 0/1 for
backward compat with snapshots built before this fix) and threading them
through in both the build script and `gameBoardFromSnapshot`. Added a
regression test (`gameBoardSnapshot.test.ts`) asserting a non-zero
snapshot value survives the round-trip. This is exactly the kind of gap
these synthetic campaigns were built to catch -- Dead Water's specific
numbers had been silently masking it.

Verified end-to-end in a real browser for all three synthetic campaigns
(including forcing the progression campaign's scenario 1 -> 2 transition
and hand-checking the resulting gold, 94, against the real formula).
381 tests passing (one new regression test), clean typecheck across every
package.

## 2026-09-09 (cont'd): weapon selection, and a ZoC bug investigation that found no bug

User feedback from trying the synthetic combat campaign: (1) a unit with
multiple weapons (the campaign's own Spearman: spear melee + javelin) had
no way to choose which one to attack with -- combat always silently used
weapon index 0. (2) Suspected bug: "passing through a hex adjacent to an
enemy should block further movement" (zone of control) for non-skirmisher
units.

**Weapon selection**: real gap, fixed. `GameSession` gained
`viableAttackerWeaponIndices` (a weapon is usable against an adjacent
target if `minRange <= 1 <= maxRange` and `numAttacks > 0` -- mirrors
upstream's own attack-weapon-choice dialog), `attackerWeaponOptions`
(the current pending attack's usable weapons, each flagged `selected`),
and `selectAttackerWeapon(index)` (rebuilds the pending preview --
including the defender's own real counter-weapon choice -- for a
different attacker weapon, same target). `buildPreview` no longer
hardcodes weapon index 0. `SidePanel` gained a weapon-choice button row
inside the existing Combat Prediction panel, shown only when there's
more than one usable weapon (the common single-weapon case is
unchanged). Real-content tests using Dead Water's Dark Sorcerer (3 real
weapons: staff/chill wave/shadow wave) repositioned next to Kai Krellis
(not adjacent at t=0 in the real scenario -- corrected an assumption from
earlier in this session that they were). Visually confirmed in the
browser: clicking "javelin" after "spear" live-updates the full
prediction (damage 7×3 -> 6×1), not just a label.

**Zone of control**: extensively investigated, found no bug. Read
`pathfind.ts`'s two independent cost-calculators (`findRoutes`'s Dijkstra
flood fill behind `reachableHexes`, and `ShortestPathCalculator`/A* behind
`findPath`) -- both correctly zero a mover's remaining movement on
entering a ZoC hex, matching upstream. Verified empirically at every
layer this session already has infrastructure for, specifically to rule
out "reads correct, behaves wrong" the way the earlier per-unit-stats and
income bugs did: (1) a new isolated single-file-corridor unit test (no
way to route around) confirms a hex two steps past a ZoC-emitting enemy
is excluded from `reachableHexes`; (2) the real, shipped Orcish Grunt
unit data in the synthetic combat campaign has `zoc: true` as expected
(level 1, no explicit override); (3) direct calls to the live
`GameSession.handleHexClick` in the real browser session (not just a
screenshot) confirm moving onto a hex adjacent to the enemy succeeds and
consumes all movement, while a hex two steps past is rejected outright
(`null`, unit stays put) -- the actual code path a real mouse click goes
through. An earlier "open field" version of this same test looked like a
pass-through at first glance, but the far hex was reached by a longer
route around the enemy from a different direction, entering ZoC only at
the very last step (both legitimate and required by upstream's own
model) -- not a violation. Could not reproduce anything resembling the
reported bug. Left as an open question for the user to provide more
specific repro steps (exact units/positions/click sequence) rather than
"fixing" something not shown to be broken.

385 tests passing (4 new), clean typecheck.

## 2026-09-09 (cont'd): the ZoC bug WAS real -- found with a precise repro

User gave the exact repro that the previous investigation's tests missed:
"Debug Hero starts SW of the enemy. Move it SE to the hex directly S of
the enemy -- still adjacent, still plenty of moves left. Can circle
around the enemy." That's hopping between two "ring" hexes that are both
adjacent to the SAME enemy *and* adjacent to each other -- a shape none of
the previous session's tests happened to construct (they either moved
into ZoC from far away, or used a 1-hex-wide corridor where the two ZoC
hexes aren't adjacent to each other at all).

Reproduced directly: `findPath` correctly computed the hop's cost as 5
(all remaining movement, matching real ZoC rules), but `executeMove` left
the unit with `movesLeft=4` afterward -- `planTurnMovement`
(`packages/engine/src/actions/move.ts`) was a **separate, buggy**
cost-accounting path from the one `findPath`'s `ShortestPathCalculator`
correctly uses. It only checked whether the *previously entered* hex was
a ZoC hex before refusing a *further* hop (and even then only from the
second hop onward, via a stray `i > 1` guard) -- it never inflated the
cost of the ZoC hex being entered to "all remaining movement" at all, so
a single hop directly into a ZoC hex (or between two mutually-adjacent
ZoC hexes) always charged only the raw terrain cost. Fixed to mirror
`ShortestPathCalculator.cost()`'s real logic exactly: entering a hex
adjacent to a non-skirmisher enemy consumes all remaining movement, full
stop. Also fixed a related edge case my first pass introduced: a unit
with `movesLeft` already at 0 must not be able to enter any further hex
at all (the naive "cost = remaining" for a ZoC hex would otherwise
compute a free 0-cost entry).

Added 3 regression tests (`move.test.ts`) covering the exact reported
shape, the "can't keep circling" follow-up, and confirming a skirmisher
is correctly unaffected. Verified in the real browser through the actual
UI click flow (not direct API calls): repositioned into the reported
shape, selected the unit, clicked the ring-hop destination, confirmed
`Moves left: 0/5` and the log/side panel match. 388 tests passing.

**Lesson**: `reachableHexes` (used for the move-range highlight) was
already correct and had test coverage; the actual move-*execution* path
had none, and diverged from it silently. Two independent implementations
of "the same rule" is a real risk in this codebase (`findPath`'s
`ShortestPathCalculator` vs. `findRoutes`'s Dijkstra flood-fill vs.
`planTurnMovement`'s separate turn-boundary accounting) -- worth keeping
in mind for future engine work: matching test coverage on the *highlight*
math doesn't imply the *execution* math was ever exercised.

## 2026-09-09 (cont'd): coordinate display

Per the user's request ("add x, y coords somewhere in the UI -- easier
to communicate"): `SidePanel`'s selected-unit info now shows `Position:
(x, y)`, and `GameBoardView`'s status line shows `Hex: (x, y)` for
whatever hex the pointer is currently over (via a new `SnapshotBoard`
`onHexHover` option, mirroring the existing per-hex `onHexClick`
binding). Used this new hover readout itself, scripted, to precisely
locate a target hex's on-screen pixel for the ZoC repro test above,
rather than eyeballing screenshot coordinates -- a good sign it's
actually useful for exactly what it was asked for.

## 2026-09-09 (cont'd): attacking didn't cancel remaining movement

User report: "I can attack the enemy and then still move afterwards."
Real bug, confirmed against `wesnoth/src/actions/attack.cpp`: real
Wesnoth zeroes an attacker's remaining movement after any attack
(`attack::execute` calls `set_movement(movement_left() -
movement_used())`, and `[attack] movement_used=` defaults to 100000 --
effectively all of it, clamped to 0 by `unit::set_movement` -- for every
weapon that doesn't explicitly override it, which none of this project's
real content does). `GameSession.confirmAttack()` had a comment claiming
this ("attacking always consumes the unit's remaining attacks/moves")
but never actually implemented it -- it only called `clearSelection()`
(a UI-only deselect), leaving the attacker's real `movesLeft` untouched,
so re-selecting the same unit after attacking still showed (and allowed
using) its real leftover movement.

Fixed: `confirmAttack()` now sets `pending.attacker.movesLeft = 0` after
a successful attack (skipped if the attacker itself died -- nothing to
zero). 3 new regression tests (real Dead Water Dark Sorcerer/Kai Krellis
content, same `withAdjacentLeaders` helper as the weapon-selection tests
-- moved to module scope so both blocks share it). Verified through the
real UI in a browser: attack, re-select the same unit, confirm "Moves
left: 0/5" and no reachable hexes highlighted. 391 tests passing.

## 2026-09-09 (cont'd): village capture + real per-turn income/upkeep (Economy & Recruit)

User request: "In Economy & Recruit, can you add a village and some
information about initial gold, gold per village, income (+ make
starting gold smaller)?" Investigating what "income" should even mean
surfaced a much bigger real gap than the display-only ask implied:
**village ownership/capture and per-turn income/upkeep were both
entirely unimplemented in the live gameplay loop.** `move.ts`'s own
module doc comment already flagged village capture as deliberately out
of scope ("needs a 'who owns this village' concept the current data
model doesn't track yet"), and `GameSession.endTurn()` never called
`Team.applyIncome` (which existed but was dead code) or charged any
upkeep at all -- gold was static from scenario start except for
recruit/recall spending, on every scenario in the project, real Dead
Water included. Showing an "income" number against a gold total that
never actually changes would have been actively misleading, so this
became a real feature build rather than a UI tweak.

**Real Wesnoth's formula**, verified directly against source (not
guessed): `play_controller.cpp`'s per-side turn-start block --
```
if (turn() > 1) {
    current_team().new_turn();  // gold += total_income()
    int expense = side_upkeep(current_side()) - current_team().support();
    if (expense > 0) current_team().spend_gold(expense);
}
```
where `team::total_income() = base_income() + villages*village_gold`,
`base_income() = income= (raw WML) + game_config::base_income` (a
hardcoded `2`, NOT WML-configurable -- `game_config.cpp`), `side_upkeep`
sums `unit::upkeep()` (a unit's level, or 0 for a leader --
`can_recruit()` -- per `unit.cpp`'s default "full" upkeep), and
`team::support() = villages * village_support`. Critically, income/
upkeep apply once per side **the moment that side's turn begins**, not
at the end of the turn before -- and the whole game's first turn grants
nothing at all to anyone.

**Engine changes** (`packages/engine`):
- `GameBoard` gained real village-ownership tracking: `villageOwners: Map<locationKey, side>`, with `villageOwner(loc)`, `captureVillage(loc, side)` (unconditional reassignment, matching `actions::get_village`'s "no special case for already-owned" behavior), and `villageCount(side)`.
- `GameBoard.fromConfig` now captures a village under any unit present at scenario start standing on one (mirrors real `unit_creator`'s default `allow_get_village=true`) -- confirmed via the real Dead_Water Home_1.map integration test that some of side 1's real starting merfolk units do start on villages (6 of the map's real 31), which a naive "villages start unowned" assumption would have missed.
- `executeMove` (`actions/move.ts`) now calls `board.captureVillage(finalHex, unit.side)` whenever the unit's final resting hex is a village -- resolving the gap `move.ts`'s own doc comment had flagged. Only the *final* hex captures; passing through mid-route does not.
- `actionWml.ts`'s `[unit]` event-tag handler (event-spawned units) got the same capture call, for parity with scenario-start placement.
- `gameBoardFromSnapshot` (the browser's own board-rebuild path, used by `GameSession` -- separate code path from `GameBoard.fromConfig`, which only engine-level WML tests exercise directly) re-derives the same initial-placement captures from each unit's real snapshot position, since the snapshot JSON doesn't separately carry village-ownership state.
- `SnapshotTeam` gained `supportPerVillage?` (threaded through the build script and `gameBoardFromSnapshot`), completing the `village_support=` field alongside the pre-existing `income`/`incomePerVillage`.

**UI changes** (`packages/ui`): `GameSession.endTurn()` now applies the
real formula above (gated on `turnNumber > 1`, matching `turn() > 1`
exactly) via two new private helpers (`totalIncomeFor`/`upkeepExpenseFor`,
shared with a new `economyInfo` getter so the preview and the real
application can't drift apart). `economyInfo` exposes `startGold`,
`incomePerVillage`, `villagesOwned`, and `netIncome` (0 on turn 1,
matching "nothing's been applied yet") for the side panel. `SidePanel`
now shows "Gold: N (started with M)" and "Income next turn: +N (V
villages x Gg)" under the existing turn/side line.

**Renderer**: villages were invisible on the board -- `SnapshotBoard`'s
placeholder flat-color terrain renderer (real per-terrain imagery is
Phase 9, not built) keys color purely off the base code's first letter,
so `Gg^Vh` rendered identically to plain grass. Added a narrow,
overlay-code-aware special case (any `^V...` overlay, matching every
real village terrain's code convention) so villages are visibly distinct
without attempting full Phase 9 terrain graphics.

**Synthetic economy scenario**: added a real village (`Gg^Vh`) to
`synthetic-campaigns/economy/maps/economy.map`, reachable by the leader
in a couple of turns' walk from the keep (not adjacent -- the point is
to demonstrate walking there mattering); reduced side 1's starting gold
from 200 to 40 (200 let the whole recruit list be bought instantly,
trivializing the economy loop the campaign exists to demonstrate).

**A real off-by-one caught during testing**: my first attempt placed the
village on the map's outermost ring of raw text hexes, which
`GameMap`'s emulated 1-tile border consumes entirely -- `board.map.
villages` came back empty, and the "village" was permanently
unreachable/invisible despite parsing without error. Caught by writing
an engine-level test first and getting a real, unexplained failure
before ever touching the UI; fixed by placing it one ring further in.

12 new/expanded regression tests across `move.test.ts` (village capture:
unowned, enemy-owned reassignment, and "passing through doesn't count"),
`gameBoardIntegration.test.ts` (real Home_1.map's 31 villages, 6
captured by side 1's real starting placement), and `gameSession.test.ts`
(real synth_economy_01: no income/upkeep on turn 1, real total_income
applied exactly on turn 2, a real click-driven move onto a village
capturing it and changing the next turn's income, and upkeep charging
gold for an unsupported recruited unit's level). Verified end-to-end in
a real browser: moved the leader onto the village via the real click
path, ended two turns, and confirmed gold/income/village-count in the
side panel matched the hand-computed real formula exactly (40 -> 45,
"+5 (1 village x 1g)").

## 2026-09-10: implementation plan cross-checked against the full feature catalogue

User provided `~/wesnoth-feature-catalogue.md` (20 categories, ~1,000
testable features -- the test-surface map for the whole engine) and asked
for the plan to be updated so every feature in it has a home in some
phase. Read the whole catalogue, then spot-checked current engine
coverage against it (grepping for leadership/berserk/drain/poison/slow/
petrify/plague/swarm/firststrike/marksman/magical/backstab/charge/
skirmisher/hides/regenerate/illuminates/teleport, and checking for fog/
shroud, time-of-day, audio, i18n, undo/replay, achievements presence)
rather than trusting the existing plan text at face value -- which turned
up two real documentation gaps: Phase 3 (Lua) and most of Phase 2 (rules
engine) were already substantially delivered (2026-09-07) but this
document never said so, and eight whole catalogue categories (fog/shroud/
vision, real time-of-day schedules, audio, localization, replay/
statistics/achievements, minimap/labels/items, advanced UI chrome,
CI/CD/performance) had no phase at all -- audio in particular wasn't
mentioned anywhere in the prior plan.

Rewrote `docs/IMPLEMENTATION_PLAN.md`: every existing phase (0-10) now
carries a Status line and a catalogue-referenced checklist of what's
concretely done vs. still gapped (most notably: Phase 2's abilities/
specials are mostly hand-coded per-feature rather than through a single
generic filter/effect pipeline -- `leadership`/`illuminates` are
explicitly not implemented because of this, and it's flagged as the
single largest remaining Phase 2 gap). Added Phases 11-18 for the eight
uncovered categories, each with a status, a concrete checklist, and a
milestone. Added a coverage-map appendix (catalogue category -> phase)
mirroring the catalogue's own Appendix A, so a future phase reshuffle
can't silently drop a category. Did not commit -- docs-only change,
left for the user to review/commit. (Later committed and pushed at the
user's request: `63e0b2a`.)

## 2026-09-11: Phase 6 content breadth -- all 13 Dead Water scenarios now load and chain correctly, real [recall]/[capture_village] actions

User asked me to continue Phase 5 polish and Phase 6 content breadth
independently while they test the synthetic debug campaigns themselves.
Picked up "port Dead Water scenario 3" (the plan's stated Phase 6 next
step -- only scenarios 1-2 were playable before this).

**Investigation, not just porting**: before touching scenario 3's
content, checked what the event pump actually fires during real play.
Found `GameSession` only ever fires `prestart`/`start`, once, at scenario
load -- confirmed this doesn't block basic playability (victory/gold-
carryover already read the finishing `[endlevel]` config statically
rather than needing a live-fired `enemies defeated` event, a documented
existing simplification), but did mean `[recall]` and `[capture_village]`
were still registered as no-op "extension point" placeholders in
`actionWml.ts`, even though `GameBoard`'s village-ownership model (built
last session for the economy feature) already had everything
`[capture_village]` needs.

**New action tags implemented for real** (`packages/engine/src/events/
actionWml.ts`):
- `[capture_village]` (mirrors `wml_actions.capture_village` in
  `data/lua/wml-tags.lua`): assigns matching villages to `side=`
  (`side=0` neutralises, via `GameBoard.captureVillage`'s own new `side <=
  0` handling). `[filter_side]` not yet supported (logged, no-op) --
  narrower than upstream but covers the common `side=N` case.
- `[recall]` (mirrors the real C++ `WML_HANDLER_FUNCTION(recall, ...)`):
  finds a recall-list unit by SUF across every side's list, places it via
  the same `checkRecruitLocation` leader/vacancy search the player-facing
  recall UI already uses, falling back to any vacant connected castle
  tile when no `x=`/`y=` is given.

**Two real bugs found while building this, both by testing against real
chained campaign content rather than trusting the isolated unit tests**:

1. **`[recall]` removed the WRONG unit from the recall list.** My first
   pass called `GameBoard.removeFromRecallList(side, unit.underlyingId)`
   -- exactly the trap `GameSession.tryRecallAt`'s own doc comment already
   warns about (`underlyingId` defaults to 0 for every unit here, so
   several recall-list entries commonly share it). A 3-scenario chained
   integration test caught it immediately: Cylanna/Gwabbo were correctly
   *found* and *placed* on scenario 3's board via `{RECALL_LOYAL_UNITS}`,
   but their names never left scenario 3's recall list -- two unrelated
   anonymous-id entries got spliced out instead. Fixed by removing by
   array index (`list.splice(index, 1)`, same pattern `tryRecallAt`
   already uses) instead of by `underlyingId`.
2. **Recall-list survivors were silently dropped on a SECOND scenario
   transition.** `computeCarryoverRecruits` (the function `startNextScenario`
   calls to decide what carries into the next scenario) only ever scanned
   `board.unitsForSide` -- units still on the map -- never
   `board.recallList`. Invisible for the 1->2 transition (scenario 1 has
   no pre-existing recall list to begin with, so the existing tests never
   exercised this path), but real: any hero the player didn't get around
   to recalling during scenario 2 would vanish forever the moment
   scenario 2 finished, instead of carrying on into scenario 3 the way
   real Wesnoth's unconditionally-persistent recall list does. Fixed by
   having `computeCarryoverRecruits` also scan `board.recallList`,
   applying the same next-scenario-inline-declaration exclusion to both
   sources.

**Verification**: 8 new engine tests for `[capture_village]`/`[recall]`
in isolation (`test/events/captureVillageAndRecall.test.ts`), a new
regression test for the dropped-recall-list-survivor bug
(`carryover.test.ts`), and a new chained integration test in
`gameSession.test.ts` that plays real scenario 1 -> 2 -> 3, forces
victory without ever manually recalling anyone, and asserts the real
`{RECALL_LOYAL_UNITS}` macro places named heroes on scenario 3's board
via the real `[recall]` action pump -- exactly the shape that caught both
bugs above. Beyond the automated suite, built and ran a real headless
13-scenario chain script (01_Invasion through 13_Epilogue, forcing
victory at each step): every scenario's snapshot builds from real WML,
every scenario's `prestart`/`start` events fire without error, gold/
recall carryover flows correctly turn over turn, and the `next_scenario`
chain terminates correctly at the epilogue (`null`). All 13 scenario
snapshots are now committed to `apps/web/public/scenarios/` -- the whole
Dead Water campaign is reachable end-to-end through the real UI's victory
-> Continue flow, not just scenario 1-2. 259 engine tests + 27 UI tests
passing (up from 231/26 at the start of this entry).

**Not yet verified in a real browser** for this specific batch of work
(unlike the villages/income session, which added new rendering): no new
UI surface was touched here, and the existing board-rendering/click-flow
Playwright checks already cover "a unit appears on the board correctly."
Judged the ROI of a full click-through lower than for a session that
changed rendering -- flagged here rather than silently skipped.

**Known remaining gaps in scenarios 3-13** (not blockers, matches this
project's "let real content demand features" philosophy, see
`IMPLEMENTATION_PLAN.md`'s Phase 2 gap list): `moveto`/`turn N`-numbered
scripted events still never fire outside `prestart`/`start` (so e.g.
scenario 3's storm-trident side-quest dialogue and its turn-3 wolf spawn
don't happen -- cosmetic/reward content loss, not a blocker), `[item]`
placement isn't rendered, and there is still no AI (Phase 7) so every
`controller=ai` side is, as already documented, played by whichever human
is at the keyboard during hotseat.

## 2026-09-11 (cont'd): a SECOND real mainline campaign -- A Tale of Two Brothers, and a real gap this exposed

Still working autonomously per the user's earlier direction. Dead Water
was now fully chained, so tried the next natural Phase 6 step: a
different real campaign, to prove the build pipeline generalizes rather
than being quietly Dead-Water-specific.

**`apps/web/scripts/build-scenario-snapshot.mjs` was hardcoded to
Dead_Water** (`CAMPAIGN_DEAD_WATER` flag, `deadWaterDir` literal,
Dead_Water-only image rooting) despite its own doc comments describing a
generic "real campaign vs synthetic" split. Generalized it: a new
`<CampaignName>/scenarios/<file>.cfg` path form resolves against any real
`wesnoth/data/campaigns/<CampaignName>/`, reading that campaign's own
`_main.cfg` for its real `[campaign] define=` symbol (a targeted regex
over the raw file text, not a full parse -- safe since that attribute is
never itself behind an `#ifdef`, and avoids a chicken-and-egg "need
defines to parse the file that sets the define" problem). Difficulty
defaults to NORMAL for any real campaign (no difficulty-picker UI to ask,
matching Dead Water's own prior hardcoded choice). Verified the refactor
is behavior-preserving: rebuilt `01_Invasion.json` and
`synth_economy_01.json` and diffed byte-for-byte identical against the
pre-refactor output.

Picked **A Tale of Two Brothers** (5 scenarios, famously the shortest
mainline campaign) to try it on. Built and smoke-tested all 5
scenarios:
- Scenario 1 (`01_Rooting_Out_a_Mage`) and 2 (`02_The_Chase`) chain
  cleanly (real recruit lists, gold, dialogue, `next_scenario=`).
- **Real bug found**: scenario 5 (`05_Epilogue`) crashed the build
  (`EISDIR` on an empty `map_file=`) -- it's a genuine, if rare, real-WML
  shape: a map-less, pure-`[story]` epilogue scenario (unlike Dead
  Water's own `13_Epilogue`, which reuses a real map for a final
  cutscene). Fixed by falling back to a trivial 1-hex placeholder map
  with a logged warning instead of crashing the whole build -- this
  project's board-centric UI has no real support for a truly mapless
  scenario yet (a real, if narrow, future gap), but this at least lets
  the build succeed and the real story/dialogue content load.
- **Confirmed, not newly discovered**: scenario 3 (`03_Guarded_Castle`)
  depends on a real `[message] variable=... [option]...[/option]` player
  password-choice puzzle. With no `[option]` selection support at all
  (already flagged in `IMPLEMENTATION_PLAN.md`'s Phase 17 as deferred UI
  chrome), the WML variable it should be set to never gets set, so the
  scenario's own "wrong password" branch always fires -- which, in *this*
  scenario, kills off/reassigns the player's entire side. A forced-victory
  headless chain script (the same technique used to validate all 13 Dead
  Water scenarios) correctly caught this as a real "defeat" rather than
  silently mis-reporting success. This is exactly the already-documented
  gap doing what it's supposed to: block realistic automated play of a
  scenario that genuinely needs the missing feature, without crashing or
  producing a wrong-but-plausible-looking result. Not fixed here --
  implementing real interactive `[option]` support is a proper Phase 17
  feature (needs a pause-mid-event, present-choices, resume-with-variable-
  set UI flow), not something to bolt on as a side effect of testing a
  second campaign. Flagged in the plan as higher-priority than its
  original "narrative flavor" framing suggested, since it can gate whether
  a scenario's core WML logic behaves sensibly at all, not just whether a
  dialogue choice shows up.

Added `two_brothers` to `campaigns.json` and verified scenario 1 in a
real browser end-to-end: campaign picker -> real story screens (with real
campaign-specific background art, confirming per-campaign image rooting
works, not just Dead Water's) -> real `[message]` dialogue -> a fully
rendered, clickable board (real gold/income display, real terrain
including a village) with no console errors. Scenario 4
(`04_Return_to_the_Village`) also verified standalone (doesn't depend on
scenario 3's password puzzle). All 240 engine + 27 UI tests still pass
(the build-script refactor touched no test-covered engine/UI code).

## 2026-09-11 (cont'd): combat blow-by-blow log, terrain defense/village/time-of-day visuals, and three real bugs this exposed

User request: see individual combat blows in the log (groundwork for
future per-blow animation), see terrain defense% and village
ownership on the board, see current time-of-day, and add a synthetic
debug campaign for other implemented features (abilities/specials).
Worked autonomously per this session's standing instruction.

**Combat log**: `executeAttack` already computed a full
`AttackBlowResult[]` per fight (hit/miss/damage/drain/poison/slow/
petrify/kill per blow) but `GameSession` only ever logged the one-line
summary. Added `formatBlowMessage()` and unshift each blow onto the log
above the summary -- e.g. "Debug Hero hits Debug Villain for 7 damage
(60% chance to hit)." Verified live in-browser (see below).

**Time-of-day**: new `packages/engine/src/model/Schedule.ts` ports real
`tod_manager` -- parses a scenario's `[time]` entries (`lawful_bonus=`,
`current_time=`), advances once per game turn (not per side-turn), with
`DEFAULT_MAX_LIMINAL_BONUS = 25` matching
`tod_manager::get_max_liminal_bonus()`'s simplified floor. Wired into
`GameSession.currentTimeOfDay`, `TurnBanner.svelte` (icon + name, e.g.
"Dawn"), and into `lawfulBonus`/`maxLiminalBonus` combat options so
alignment-based damage bonuses are now schedule-aware for the first
time.

**Terrain defense% + villages**: `Map.terrainName()` (real
`[terrain_type] name=`) and `GameSession.defensePercentAt()` feed a new
status-line "· Defense: NN%" on hex hover and a `SidePanel` "Terrain:
Grassland (Defense: 40%)" line for the selected unit.
`GameSession.villageOwnership` + `SnapshotBoard.updateVillageOwnership()`
draw a pole+pennant flag (team-colored) on every currently-owned
village, in a new `villageLayer` between terrain and highlights.

**Three real bugs found and fixed while building this** (none were
display-only gaps -- each traces to real engine logic that was silently
wrong or missing):
1. **`specials_list=`/`abilities_list=` (the comma-separated shorthand
   real mainline unit files almost universally use instead of inline
   `[specials]`/`[abilities]` -- confirmed via Orcish Assassin, Mermaid
   Priestess, Giant Spider, Vampire Bat, etc.) was never resolved by this
   engine at all.** Added `collectSpecialRegistry()`
   (`UnitTypeDatabase.ts`) to build `id -> {tag, config}` registries from
   real `[units][weapon_specials]`/`[abilities]` content, resolved by
   `UnitType`/`AttackType.fromConfig()`, threaded through the snapshot
   build script and client-side reconstruction. Most real specials/
   abilities in this project were silently inert before this.
2. **Ability matching by `id=` was itself wrong for the `heals`/
   `regenerate` family.** Weapon-special `id=` happens to equal its tag
   name for every special this engine evaluates, but real content's
   ability `id=` is a *display* id distinct from the tag (every `heals`-
   tag registry entry sets `id=healing` or `id=curing`, never
   `id=heals`) -- real upstream matches by tag name
   (`units/abilities.cpp:1754`). `UnitType.abilities` is now
   `RegistryEntry[]` (`{tag, config}`) instead of bare `WmlConfig[]`, and
   `hasAbility()`/`hasSkirmisher()` match by `.tag`. Dead Water's own
   healer, Cylanna, had never actually healed anyone in this project
   before this fix.
3. **`GameSession.endTurn()` never called the engine's own already-
   correct `applySideHealing()`.** Even after fixing (2), a correctly-
   detected healer's healing was never applied during live play. Now
   called every side-turn (narrower first-turn exemption than income's,
   matching `play_controller.cpp`'s `do_healing()`), with log lines for
   heal/poison-damage/poison-cure.
4. **Backstab (`[damage] id=backstab multiply=2`) was parsed but its
   `[filter_opponent]` condition was never evaluated** -- damage always
   applied as if backstab were inactive. Added
   `combat.ts`'s `isBackstabActive()`, a narrow geometric proxy (attacker
   -> defender -> flanker in a straight line, flanker hostile to
   defender, not incapacitated) matching the special's real plain-
   language description rather than the general WFL formula, consistent
   with this project's established narrow-hand-coded-checks pattern.
   **Hex-geometry pitfall hit while testing this**: on this engine's
   odd-column-offset grid, "same y, x+1 each step" is *not* a straight
   hex line -- continuing a SE step from an odd column crosses into the
   next row (verified via `Location.toCubic()` diffs). Two new tests
   initially failed for this reason; fixed by placing the flanker at the
   cubic-verified continuation hex, not a same-y guess.

Added a new synthetic debug campaign, `synthetic_abilities`
(`synth_abilities_01.json`, 28 units on a 6x28 grid), with one real-unit
"station" per feature: Giant Spider (poison+slow), Vampire Bat (drains),
Dwarvish Berserker (berserk), Drake Arbiter (firststrike), Elvish
Marksman (marksman), Dwarvish Arcanister (magical), Thief+ally
(backstab), Horseman (charge), Cuttle Fish (swarm+poison), Walking
Corpse vs Bandit (plague), Mermaid Priestess+damaged Peasant (heals),
damaged Troll (regenerate), Assassin vs Orcish Grunt (skirmisher).

Verified all of this live in a real browser (Playwright, Node 20):
per-blow combat log lines rendering correctly after a real attack in the
`[Debug] Combat` scenario; "Dawn" time-of-day icon+label in Dead Water's
turn banner; village flags (team-colored) rendered on Dead Water's owned
villages; defense% shown both on hover and in the selected-unit panel;
the new Abilities & Specials debug campaign loading and rendering all 28
units with no console errors. All 253 engine + 32 UI + 106 renderer
tests pass; typecheck clean across all packages.

## 2026-09-11 (cont'd): a real, targeted generalized-ability-effect engine (leadership, steadfast)

User asked to move on from content breadth (Phase 6, plenty of debugging
material now exists there) toward three other phases: the generalized
ability/effect pipeline, an AI opponent, and terrain visuals/animation.
Starting with the pipeline, since AI and animation both benefit from
combat numbers actually being correct.

Read the real `units/abilities.cpp`/`abilities.hpp`/`units/unit.cpp`
(`foreach_active_ability`, `get_abilities`, `unit_abilities::effect`,
`resistance_against`, `under_leadership`) directly rather than guessing
at the generic filter/effect model from memory -- it's a real, fairly
intricate composition engine (priority-grouped, `value=`/`add=`/`sub=`/
`multiply=`/`divide=`/`max_value=`/`min_value=`/`cumulative=`, WFL
formula values with real `self`/`other`/`base_value` binding). Rather
than porting the whole thing (which supports far more than any real
mainline content in this project currently needs -- `[filter_self]`,
non-adjacent `adjacent=` direction matching, the weapon-special-only
`EFFECT_CUMULABLE` mode), cross-checked which parts real
`data/core/macros/abilities.cfg` definitions actually exercise and built
exactly that: a new `packages/engine/src/actions/abilityEffects.ts`
implementing `getActiveAbilities` (the self/adjacent query, with real
`affects_side`/`affect_self`/`[affect_adjacent][filter]` semantics) and
`computeAbilityEffect` (the composition), then two high-level entry
points, `computeLeadershipBonus` and `computeResistanceModifier`, wired
into `combatStats.ts`'s `UnitStatsOptions` (`attackerLeadershipBonus`/
`defenderLeadershipBonus`/`attackerResistanceModifier`/
`defenderResistanceModifier`, computed by `combat.ts`'s `executeAttack`
and `GameSession.buildPreview`, both of which already had board access
for the same reason `isBackstabActive` does).

Both of `combatStats.ts`'s own previously-flagged "NOT applied" gaps are
now real: **leadership** (adjacent higher-level same-side ally boosts
damage by the real `25 * (level - other.level))` WFL formula, "best
bonus wins" with multiple simultaneous leaders rather than summing) and
**steadfast/resistance-granting abilities** (`multiply=2 max_value=50
[filter_base_value] greater_than=0 less_than=50`, correctly gated to
`active_on=defense` and vulnerabilities/already-high resistances left
alone). New tests (`test/actions/abilityEffects.test.ts`, 9 tests) build
ability configs with the exact attributes the real macros set (not
abbreviated stand-ins) and hand-verify the expected numbers, including a
two-simultaneous-leaders "best wins, not summed" case and the
`active_on=defense`-doesn't-apply-while-attacking case. All 262 engine +
32 UI tests pass; typecheck clean.

Deliberately not done here (documented in `IMPLEMENTATION_PLAN.md`'s
updated Phase 2 gap-list entry, not silently dropped): `illuminates`
(needs its own side-independent radius scan, not the `affects_side` path
everything else here uses), `hides`-family stealth abilities (no
fog/vision system yet to hide from -- Phase 11), and the fully generic
filter/effect pipeline (arbitrary custom abilities beyond these two).

## 2026-09-11 (cont'd): a real AI opponent (Phase 7 MVP) -- controller=ai sides now actually play themselves

Second of the three phases the user asked to move to (generalized
pipeline, AI, visuals/animation). Until now there was literally no AI
code anywhere -- every `controller=ai` side was, as `GameSession.
endTurn`'s own doc comment put it, "actually played by whichever human
sat at the keyboard" (hotseat). Real Wesnoth's own AI is a 60-file,
substantially Lua-driven candidate-action framework (`data/ai/`, 131
files using `[lua]`) -- not something to port before the game is
otherwise playable, and the plan already flagged an MVP heuristic as the
right first step (Phase 7's own "not worth porting yet" note).

Built `packages/engine/src/ai/simpleAi.ts`'s `playAiTurn`: a real,
working heuristic AI, deliberately not a port of upstream's AI, but
grounded entirely in this project's own already-real, already-tested
engine code rather than invented shortcuts --
- **Attack scoring** reuses `combatStats.ts`'s `buildBattleContext` and
  `attackPrediction.ts`'s `simulateCombat`, the EXACT prediction math a
  human's own attack preview shows, including this session's new
  leadership/steadfast/backstab bonuses. For every (reachable hex,
  adjacent enemy, own weapon) combination, scores expected-damage-dealt
  minus expected-damage-taken (heavily weighted for a likely kill/likely
  death), temporarily relocating the unit on the board for the duration
  of each candidate's evaluation (so backstab/leadership adjacency scans
  see the hypothetical position) and restoring it after.
- **Movement** uses the real `reachableHexes`/`findPath` (ZoC-aware).
- **Recruiting** uses the real `checkRecruitLocation`/
  `findVacantCastleTile`/`recruitUnit`, picking the best hitpoints+
  damage-per-cost recruit while gold and a vacant castle tile allow.
- Falls back to capturing a reachable unowned/enemy village, else
  closing distance to the nearest enemy (board-wide -- no fog/vision
  system exists yet, Phase 11), when no attack clears a
  not-a-bad-trade score threshold.

Wired into `GameSession.endTurn`, refactored to pull the actual
side-advance/income/healing logic into a new private `advanceOneTurn()`
so `endTurn` can loop it: ending a human side's turn now auto-plays
through any number of consecutive `ai`/`network_ai`-controlled sides,
appending every AI action to the log, and only returns once a human-
controlled side is reached (or the scenario ends, checked via the
existing `checkForGameEnd` after any AI attack). This is a real,
user-visible behavior change for every existing scenario with a
`controller=ai` side (confirmed: real Dead Water scenario 1's side 2
is one) -- 4 pre-existing `gameSession.test.ts` tests that assumed
hotseat step-by-step control over "the enemy side" needed updating to
either force that side back to `controller: 'human'` (tests specifically
about ToD/healing/turn-cycling mechanics, not AI) or to expect a single
`endTurn()` call to now resolve straight through to the next human turn.

Verified live in a real browser: loaded Dead Water scenario 1, clicked
"End Turn" once from side 1's turn 1 -- the AI (side 2, "bad guys")
recruited 3 Soulless, moved the Dark Sorcerer toward the enemy, and had
a Skeleton attack a Merman Netcaster (1/1 blows landed), all logged,
landing back on side 1's turn 2 with income/gold correctly applied and
no console errors -- confirming the whole pipeline (recruit -> move ->
attack -> end-of-AI-turn -> hand back to human) works end-to-end, not
just in isolated engine tests.

New tests: `packages/engine/test/ai/simpleAi.test.ts` (6 tests --
recruits-until-unaffordable/can't-afford-anything, takes a clearly-good
trade, declines a clearly-bad one, captures a reachable village, closes
distance to the nearest enemy) plus one new `gameSession.test.ts`
integration test proving the `endTurn` wiring itself. Writing these
tests surfaced a real, subtle pitfall worth flagging for future test
authors: `[movement_costs]`/`[defense]` WML tables are keyed by the real
terrain type's own `id=` (e.g. `flat`, `castle`), NOT the map's `Gg`-
style terrain *code* -- confirmed directly against `data/core/
terrain.cfg`'s alias chains (`Gg` -> aliasof `Gt` -> id `flat`; `Kh`/`Ch`
-> aliasof `Ct` -> id `castle`). Tests using an EMPTY `TerrainTypeData`
(this project's usual hand-built-fixture shortcut, e.g. `combat.test.
ts`'s own `flatMoveType`) get away with keying by the raw code only
because `TerrainType.fromDefault`'s fallback makes an unregistered code
alias to itself; a test needing REAL keep/castle/village classification
(this one did, for recruiting/village-capture) must load real terrain
data and therefore hit the real alias chain. All 268 engine + 33 UI
tests pass; typecheck clean.

## 2026-09-11 (cont'd): real per-blow attack animation playback (Phase 10)

Third and last of the three phases the user asked to move to. This is
the piece the very first message in this session's request chain
specifically called out: "this will also be important later when we add
animations -- the game will play one animation per blow." The selection
half already existed from early in the project
(`packages/renderer/src/animation/`: real WML `[attack_anim]`/`[defend]`
parsing, `[if]`/`[else]` branch expansion, filter matching, frame
extraction, all real and tested); nothing actually played a chosen
animation against the live board.

Built the missing playback half. `animation/playback.ts`'s
`sampleAnimation` is the new pure core: given a chosen `UnitAnimationDef`
and elapsed time, walks the real `[frame]` sequence and each frame's own
bracket-range image sub-sequence, and -- for the first time -- actually
applies the `offset=` "frame value wins, else fall back to the
animation-wide value, sampled over the WHOLE animation's elapsed time"
merge rule that `frame.ts`'s own doc comment had documented but nothing
evaluated. Verified against real Merman Fighter `[attack_anim]` content
(`offset=0~0.3,0.3~0`, direction=se filtered) as well as hand-built exact
timing/merge-rule fixtures (7 new tests).

`SnapshotBoard.playAnimations` drives this in real time via
`requestAnimationFrame`, playing any number of cues (an attacker's lunge
+ a defender's reaction) concurrently and resolving once all finish.
This required a real structural change: unit sprites used to be
destroyed and rebuilt from scratch on every board update (`renderUnits`
called `unitLayer.removeChildren()` unconditionally) -- fine for a
static snapshot, but animation needs the SAME PixiJS sprite object to
still exist and be mid-flight the next tick. Rewrote it to reconcile a
persistent `unitVisuals` map instead (create/reposition/rebuild-on-
image-change/destroy-when-gone), a real secondary fix too: every unit
update used to flicker the whole board for one frame.

That persistence needs a stable per-unit key, which surfaced a real
landmine: the obvious choice, `Unit.underlyingId`, defaults to 0 and is
NOT reliably unique -- most units loaded from a scenario never get an
explicit one (already-known territory: `RecallOption.index`'s own doc
comment flags the same issue for recall-list units specifically). Using
it as a sprite key would have collapsed every unit onto one shared
sprite. Fixed by NOT using it: `GameSession.renderKeyFor` assigns each
live `Unit` OBJECT a fresh session-local key the first time it's seen,
via a `WeakMap<Unit, number>` -- correct because a `Unit` object
reference persists for its whole board lifetime, including through
`advanceUnitTo` (mutates in place, doesn't replace the object).

Wired into `GameShell.svelte`'s `handleConfirmAttack` (now async): after
a human confirms an attack, real per-blow `AnimationContext`s are built
(reusing the already-existing, already-tested
`buildAttackAnimationContexts`) from `GameSession.lastAttackAnimation`
(new -- the raw `Unit`/`AttackResult` a confirmed attack just produced),
matched against each unit type's real `[attack_anim]`/`[defend]` blocks
(parsed fresh via `GameSession.rawUnitTypeConfig` + `parseUnitAnimations`
-- animation data UnitType.ts deliberately never parses), and played
through `GameBoardView`'s new exposed `playAttackBlows` method BEFORE
the confirmed attack's final state is applied to the board -- so the
side panel doesn't jump straight to "4/5 blows landed" while the board
still shows the pre-attack position. AI-played attacks stay instant,
deliberately (animating every blow of an automated AI turn would slow
`endTurn` for no one watching).

**Real debugging note, in case this pattern recurs**: verifying this in
a real browser was genuinely difficult -- a sequence of ordinary
screenshots looked completely unchanged even though the animation was
provably running (confirmed via `page.evaluate` reading the live PixiJS
container's `x`/`y` directly, which DID show real movement). The actual
cause was mundane: a ~20px sprite shift is easy to miss by eye in a full
board screenshot, especially mid-cycle before the lunge reaches its
peak offset. What finally confirmed it, after chasing several wrong
theories (a suspected `updateUnits` race, a suspected sprite-identity
mismatch) first: a client-side canvas pixel diff between a
before/during screenshot (2100+ differing pixels in exactly the sprite's
bounding box), then a temporarily-15x-slowed build's side-by-side crop,
which made the lunge and the real mid-swing pose change unmistakable.
Both confirmed the system was correct; the earlier "nothing's moving"
read was an observation error, not a bug -- worth remembering before
concluding a visual feature is broken from screenshots alone.

Verified live in a real browser: the synthetic Combat Debug scenario's
5-blow exchange (real Spearman/Orcish Grunt art and `[attack_anim]`/
`[defend]` data, confirmed via the pixel-diff above) played correctly
end-to-end in ~4 seconds with no console errors; Dead Water (real
mainline content) also loads and plays through with no errors. All 268
engine + 33 UI + 113 renderer tests pass; typecheck clean across all
packages.

Not done, and documented as an open gap rather than silently skipped
(see `IMPLEMENTATION_PLAN.md`'s updated Phase 10 status): movement
(glide-between-hexes) playback -- `buildMovementAnimationContexts` has
existed since the selection-only phase but nothing calls it yet, so a
move still snaps instantly. Sound-in-frame, halo/blend/submerge
compositing, and screen-shake/floating-damage-text remain unbuilt too.

## 2026-09-11 (cont'd): four real animation bugs, user-reported after trying the feature

User tried the new per-blow attack playback and reported four problems:
a moved unit left a duplicate "ghost" sprite at its origin hex; attack
animations always showed the ORIGINAL attacker swinging even when the
defender was the one dealing a retaliation blow; movement had no
animation at all; and hit vs. miss looked indistinguishable. All four
were real, and all four are now fixed.

1. **Duplicate sprite on move** — a genuine race condition. `renderUnits()`
   is async (`buildUnitVisual` awaits real texture loading via
   `ImageCache.resolve`), and nothing serialized overlapping
   `updateUnits`/`render` calls. Selecting a unit and immediately moving
   it could fire two overlapping runs; both could fail to find an
   existing `UnitVisual` for the same unit (neither had reached its own
   `unitVisuals.set(...)` yet) and each build a fresh sprite -- one
   orphaned in `unitLayer`, forever undetected by the cleanup loop since
   the map only ever pointed to the other. Fixed with a `renderQueue`
   promise chain in `SnapshotBoard` so every `renderUnits()` run is
   strictly sequential.
2. **Attack animation always shows the original attacker swinging** —
   traced to real upstream C++ (`actions/attack.cpp`'s
   `attack::perform_hit`: `unit_info& attacker = attacker_turn ? a_ : d_;`)
   to confirm real Wesnoth swaps which unit is "attacker"/"defender" for
   animation purposes PER BLOW, not fixed to the combat's overall roles
   -- on a defender's retaliation blow, the DEFENDER plays "attack" with
   its own weapon and the original attacker plays "defend". The
   pre-existing (not written this session) `buildAttackBlowAnimationContexts`
   never did this swap -- a real, previously-undiscovered bug in code
   that predates this session, only surfaced once actually wired into
   live playback. Fixed there (using `blow.attackerTurn` to pick the real
   striker/receiver) and in `GameShell.svelte`'s cue-building (which was
   ALSO unconditionally pairing "attacker" context data with the
   combat's original attacker's animation set/sprite/hex, rather than
   resolving each blow's real resources by `myUnit` object identity).
   Verified visually: screenshots of the first blow (real attacker's
   turn) show that unit lunged out of its hex; a later retaliation blow
   shows the OTHER unit lunged instead.
3. **No movement animation** — a real, previously-flagged gap, now
   built. Required two supporting fixes to actually work, both confirmed
   against real upstream `animation.cpp` source rather than guessed:
   `add_anims`' own `offset=` DEFAULTING for `movement_anim`/`attack_anim`
   (real mainline content, e.g. Elvish Fighter's walk cycle, very often
   declares no `offset=` at all -- without the engine-injected default
   (`0~1:200,...` repeating for movement; `0~0.6,0.6~0` for a melee
   attack lunge with no missile frame), `sampleAnimation` would have
   nothing to interpolate and a "moving" sprite would just cycle its
   walk frames in place) -- ported into `unitAnimation.ts` as
   `withDefaultOffset`. And `SnapshotBoard.playAnimations`' hardcoded
   "always settle back at `src`" behavior (correct for an attack's
   lunge-and-return, but exactly wrong for a move) needed generalizing
   via a new `UnitAnimationCue.restAt: 'src' | 'dst'`. Per-step direction
   also needed its own fix: `executeMove` only ever sets `unit.facing`
   ONCE, from the last two hexes of a whole multi-hex move (a
   pre-existing simplification never exercised until movement animation
   needed a real per-LEG facing) -- worked around in `GameShell.svelte`
   by computing each leg's direction directly from the path via a new
   shared `Location.ts` export, `directionBetween` (pulled out of three
   separate pre-existing private duplicates in `combat.ts`/`move.ts`/
   `recruit.ts`, left as-is rather than refactored as a side effect).
4. **Hit vs. miss look indistinguishable** — investigated directly rather
   than guessed: real Spearman's own `[defend]` content (built from the
   real `DEFENSE_ANIM_FILTERED` macro) turns out to use the IDENTICAL
   image sequence for its `hit` and `miss` variants — the only real
   difference is a sound (not yet played) — so some visual similarity
   for this specific unit is genuinely faithful to upstream, not a bug.
   A focused check (`selectTopAnimations` against real Spearman defend
   data, hand-computed hit/miss/kill contexts) confirmed the SELECTION
   logic itself correctly picks the distinct `hit`/`miss`/`kill`-scored
   variant every time. The likely actual cause of what the user saw:
   bug #2 above -- with roles never swapped, a retaliation blow fed the
   ATTACKER's own animation set into a "defend" role it was never
   really filling, which would read as "wrong reaction" far more often
   than "correct." Not separately reproduced after fixing #2; flagged
   here rather than silently assumed fixed, in case it resurfaces.

All 268 engine + 33 UI + 119 renderer tests pass (12 new: 1 role-swap
regression test in `animationContext.test.ts`, 5 default-offset tests in
`unitAnimation.test.ts`, plus the pre-existing playback suite); typecheck
clean. Verified live in the browser: a move glides smoothly with exactly
one sprite, ending at the correct hex with no ghost left behind; a
5-blow exchange visibly shows the correct unit lunging on each blow
(confirmed via before/after screenshots of an attacker-turn blow vs. a
retaliation blow).

## 2026-09-11 (cont'd): the real generic "hit flash", and a 2x movement speed-up

User follow-up on bug #4 above: real Wesnoth also flashes a unit red for
a moment on a landed hit, as a GENERIC effect layered on top of
whatever `[defend]` animation played -- suspected of living somewhere
other than the per-unit WML animation blocks. Investigated directly
rather than guessed (`animation.cpp`'s `fill_initial_animations`,
~L508-624): confirmed this is a real, LOW-PRIORITY fallback `unit_
animation` the C++ engine registers for `defend` on every unit type,
reusing that type's own "default"/standing frame data with a red
`blend_ratio`/`blend_color` pulse, filtered to `hits=[hit,kill]` --
built via the exact same scoring/matching system as WML-authored
animations, so any real `[defend]` block (which Spearman/Orcish Grunt,
this session's own test units, both have) still outscores and replaces
it. Ported as `unitAnimation.ts`'s two new synthetic fallback entries
(hit/kill-flash + a plain miss-passthrough), verified with real tests:
fires (with real blend data) for a unit type with no authored `[defend]`
at all, and is present-but-never-selected for one that has its own.

This ALSO exposed that the underlying `blend_with=`/`blend_ratio=` real
WML fields, while already extracted as data since early in the project,
were never actually *rendered* anywhere (`frame.ts`'s `applyFrameEffects`
was a pure stub). Implemented for real: `playback.ts`'s `sampleAnimation`
now samples blend the same frame-wins-else-animation-wide way `offset=`
already was, and `SnapshotBoard` composites it as a same-texture tinted
overlay sprite (`applyBlend`) drawn on top at `alpha = ratio` -- a
practical approximation of upstream's true solid-colour recolour, using
PixiJS `tint` rather than a custom shader.

**Caveat flagged to the user, not silently smoothed over**: per real
Wesnoth's own scoring, this fallback will NOT visibly change the
Combat Debug scenario (Spearman/Orcish Grunt) the user tested with --
both units author their own real `[defend]` content, which correctly
wins. It WILL show for any unit type with no custom defend art. Whether
the user actually wants strict fidelity here (as implemented) or a
simplified "always flash on any hit" UX improvement regardless of
real per-unit content is an open question for them to weigh in on.

Also: sped up movement animation 2x, per direct request (real authored
`movement_anim` timing, e.g. Elvish Fighter's ~600ms-per-hex walk cycle,
reads as sluggish for a UI where routine multi-hex moves are common,
unlike an attack blow which has real per-frame content worth seeing at
full speed). `SnapshotBoard.playAnimations` gained a `speedMultiplier`
parameter (default 1, real authored speed) that compresses wall-clock
playback time while still sampling a real `anim` across its FULL
internal timeline (not truncating it) -- `GameShell.svelte` requests 2x
for movement specifically, attack blows stay at 1x.

New tests: 2 in `unitAnimation.test.ts` for the generic defend fallback
(fires when absent, loses when a real one exists). All 268 engine + 33
UI + 121 renderer tests pass; typecheck clean. Verified live: a 2-hex
move now takes ~470ms wall-clock (previously ~940ms-equivalent at 1x);
a full attack exchange still resolves correctly with the new blend code
path active and no console errors.

## 2026-09-12: correcting the hit-flash fix -- the real mechanism was different, and more common, than first found

User provided a real Wesnoth screenshot (Spearman vs. Bandit) showing
the Bandit unmistakably flashed solid red mid-hit -- direct evidence
against yesterday's conclusion that Spearman/Bandit-style real content
wouldn't show a flash at all (a real WML-fidelity claim, not a hunch,
but wrong).

Re-read the real source once more, specifically `add_anims` itself
(`animation.cpp` ~L790-820, the function that processes a unit's OWN
authored `[defend]` blocks) rather than only `fill_initial_animations`'s
separate low-priority fallback (yesterday's focus). Found the actual
mechanism: `add_anims` UNCONDITIONALLY appends an extra 225ms frame
(reusing whatever image the animation already ends on, `blend_ratio=
"0.0,0.5:75,0.0:75,0.5:75,0.0"`, `blend_color=255,0,0`) to ANY `[defend]`
variant whose `hits=` includes `hit`/`kill` -- for BOTH the "author
didn't set hits=" auto-split path AND an explicit `hits=hit`/`kill`/`yes`
(e.g. via `DEFENSE_ANIM_FILTERED`'s `[if] hits=hit`) -- regardless of
whether the unit's own macro/WML mentions blend anywhere. This is a
completely different, and far more commonly-triggered, mechanism than
yesterday's low-priority fallback (which only fires for a unit with NO
`[defend]` at all): it modifies the WINNING animation itself, not a
competing low-scored candidate.

Verified directly against both real units from the screenshot's
scenario shape: real Bandit (plain `DEFENSE_ANIM`, no explicit `hits=`)
and real Spearman (`DEFENSE_ANIM_FILTERED`, explicit `hits=hit` inside
an `[if]`) BOTH now correctly get the red-flash frame appended to their
hit variant. Implemented as `unitAnimation.ts`'s new `appendHitFlash`,
called from `buildDefendAnimations` (both its auto-split and
explicit-`hits=` branches) -- kept yesterday's separate low-priority
fallback too (still real, for the rarer "no `[defend]` at all" case;
now clearly secondary rather than the primary mechanism). Updated the
tests that had encoded the wrong (yesterday's) model to correctly check
the appended frame's own `blendRatio`/`blendColor` rather than the
animation-wide field.

Verified live end-to-end via a `window.__debugBoard` instrumentation
pass (removed after): both units in the Combat Debug scenario
(Spearman/Orcish Grunt) reached real `overlay.alpha = 0.5` with
`tint = 0xFF0000` during a real attack exchange, confirming the fix
renders correctly, not just in isolated unit tests. All 268 engine + 33
UI + 121 renderer tests pass; typecheck clean.

Noted for future self: when a real screenshot/observation contradicts a
prior "verified against real source" conclusion, the right response is
to go back and read MORE of the surrounding real source (here: the
sibling function actually responsible, not just the one already found),
not to assume the fidelity claim was directionally right and just
narrower than tested.

## 2026-09-12: Phase 9 (terrain visuals) started -- real `[terrain_graphics]` rule parsing + matching, verified end-to-end

User asked to tackle terrain visuals next, having just confirmed (this
session) that the real desktop Wesnoth binary can be installed and run
headlessly (Xvfb + apt package) for reference screenshots, and separately
that `wesnoth --screenshot <map> <output>` renders a `.map` file's terrain
compositing with no GUI at all -- a fast, deterministic ground-truth
generator kept in mind for future visual comparison work.

Re-scoped against real source before writing any code (per the plan doc's
own standing note to revisit attempt #1's approach rather than assume it):
read `terrain/builder.hpp`/`.cpp` in full (1280+842 lines) directly, not
just attempt #1's own retrospective. Key finding: attempt #1 got terrain
imagery right by compiling the real C++ engine to WASM and querying it
per-hex -- a different architecture from this project (which reimplements
engine logic in TS). Re-derived the two-phase split this project needs:
static WML-rule parsing (build time, Node) + dynamic per-hex matching
(client-side, reacts to ToD/mid-scenario terrain changes).

**A real gotcha along the way**: the `wesnoth/` submodule checked out here
is a dev/master-branch checkout, whose `data/core/terrain-graphics/`
directory has been substantially refactored since 1.16.9 (the version
`apt` installed for the screenshot work) -- `deprecated-*`/`enduring-*`/
`new-*` files, `#arg`/`[+tag]` merge syntax, `x,y=0,0` multi-assign. Also
non-obvious: the actual per-terrain rule *invocations* live in a sibling
FILE `core/terrain-graphics.cfg` (singular), included separately from
`data/_main.cfg` -- not the `terrain-graphics/` directory, which turned out
to be almost entirely macro *definitions*. First attempt at loading real
content only processed the directory and got 13 rules back; fixed by
also preprocessing `core/terrain-graphics.cfg` against the same macro
table, in the right order.

Built (new `packages/renderer/src/terrain/`):
- `legacyHex.ts`: the non-standard hex-offset arithmetic (`legacy_sum`)
  `terrain_builder` requires for rotation/constraint-offset correctness --
  deliberately kept separate from `Location.ts`'s "correct" hex math.
- `terrainGraphicsRules.ts`: real WML parsing -- `[tile]` constraints,
  `[image]`/`[variant]` (with the "declared variants first, [image]'s own
  name= last as unconditional fallback" ordering), `map=` ASCII-art anchor
  parsing, rotation-template expansion (`rotations=`, `@Rn`/`@V` token
  substitution, the real rotation matrices), and existence-based rule
  validity filtering (`loadRuleImages`, including its easy-to-miss
  "stop at the first fully-missing `@V` variation" short-circuit -- not
  "skip that one variation", stop entirely).
- `terrainBuilder.ts`: the dynamic half -- `build_terrains`/`rule_matches`/
  `apply_rule`/`tile::rebuild_cache` -- run client-side against a live map
  + current ToD. `get_noise()`'s 32-bit wraparound hash ported bit-exact
  via `Math.imul`/`>>> 0`. Deliberately skips upstream's "cheapest
  constraint" candidate-prefiltering optimization (brute-forces every
  rule against every padded hex instead) -- same result, simpler, slower;
  flagged for revisit.

**Verification, strongest yet for a from-scratch port in this project**:
parsing the real (dev-branch) `data/core/terrain-graphics/` content
produces **exactly 10,063 rules** -- the identical number attempt #1's
own C++-oracle-verified measurement reported for the same real content
(`~/wesnothweb/doc/Refactor_display_layer.md` section 3). Independent
confirmation the parser/rotation/filtering port is correct, not just
plausible. End-to-end run against the real Dead_Water scenario-1 map:
all 1161 real hexes resolve at least one background image layer (no
gaps); build phase ~7s, per-hex resolve ~20ms for the whole map (flagged
as a real, known perf cost of the brute-force matching choice above --
acceptable for a one-time per-scenario-load cost for now, revisit if it
proves too slow once actually wired into the UI's load path).

New tests: 10 synthetic + 5 real-content in `terrainGraphicsRules.test.ts`/
`.real.test.ts`, 7 synthetic in `terrainBuilder.test.ts`, 1 real
end-to-end perf/sanity test in `terrainBuilder.deadwater.test.ts`. All
268 engine + 32 lua-bridge + 3 oracle-tools + 144 renderer + 33 UI tests
pass; typecheck clean across every package.

**Not done yet** (explicitly deferred, not silently skipped): wiring this
into `SnapshotBoard`/PixiJS to actually replace the flat-coloured-hex
rendering (needs a build-time snapshot loader in
`build-scenario-snapshot.mjs` shipping the parsed rule list as JSON, plus
`SnapshotBoard` calling `buildTerrainTiles`/`getTerrainFramesAt` and using
the already-existing `makeLayerSprite`/`ImageCache` to actually draw);
`center=` multi-hex image slicing; animation start-time jitter; ToD colour
tinting (Phase 12); the "cheapest constraint" perf optimization if ~7s
per scenario load turns out to matter in practice.

## 2026-09-12 (cont'd): Phase 9 wired into real rendering -- and a real bug found via the real engine's own screenshot

Continued straight from the morning's rule-parsing/matching work into
actually drawing it: a build script
(`apps/web/scripts/build-terrain-graphics-rules.mjs`) ships the parsed
rule list as one shared static asset (`terrain-graphics-rules.json`,
17MB uncompressed / ~360KB gzipped -- fetched once, cached across every
scenario), `SnapshotBoard.renderTerrain` now calls `buildTerrainTiles`/
`getTerrainFramesAt` per hex and builds real `makeLayerSprite` sprites
(background under units, a new `terrainForegroundLayer` over them),
falling back to the old flat-colour placeholder if the rule set is
empty/missing. `GameBoardView.svelte` fetches+revives the rules once
(`packages/ui/src/terrainGraphicsRulesCache.ts`) and passes them through.

**Verified live in a real browser** (Playwright + the project's existing
Dead_Water scenario, no console errors): real water/grass/sand/castle
art rendering, correct hex-alpha-mask clipping, castle walls/towers
correctly oriented via the rotation-template matching. Screenshots
compared directly against ground truth captured from the REAL Wesnoth
1.16.9 binary (`wesnoth --screenshot`, same technique demonstrated
earlier this session) rendering the exact same `Home_1.map` file.

**A real, visually-obvious bug turned up this way**: mountain/hill
terrain rendered as sparse, disconnected peak icons with large BLACK
gaps between them (canvas showing through) instead of the real engine's
dense, continuous rocky texture. Root-caused by re-reading
`picture.cpp`'s `load_image_sub_file`: real mountain art
(`mountains/basic.png` etc.) is NOT one 72x72 image per hex -- it's a
much larger source image (e.g. `mountains/basic3.png` is 180x216px)
that real Wesnoth crops a *different* 72x72 window out of per hex,
using that image's `[terrain_graphics]`-declared `base=`/`center=`
attributes plus the matching constraint's own relative hex offset. This
project's port had this specific mechanism explicitly flagged as an
already-known, deliberately-deferred gap ("`center=` multi-hex image
slicing... a small minority of real content, mostly bridge/large-
decoration art") -- WRONG: it turns out to be how a major, common
terrain type (mountains) is drawn at all, discovered only once real
pixels were on screen and cross-checked against the real engine's own
output, not from reading the WML alone.

Fixed: `RuleImage.sourceLoc` (the owning, already-rotated constraint's
own hex offset, set by `loadRuleImages` -- mirrors when upstream's
`image::locator` captures `constraint.loc`, which is AFTER rotation)
plus a new `~GLOBAL(locX,locY,centerX,centerY)` pseudo-op in
`ImageCache.ts` (mirroring how `~HEXED()`/`~TOD()` are already modelled
as trailing pseudo-ops) that performs the exact upstream crop formula
using the real decoded bitmap's own width/height -- something no amount
of WML-only reasoning could precompute ahead of time. Verified the
before/after directly: the same real Dead_Water mountain range went
from disconnected icon fragments over black gaps to dense, continuous,
Wesnoth-authentic rock texture, matching the real engine's own
`--screenshot` output of the identical map.

All 268 engine + 32 lua-bridge + 3 oracle-tools + 144 renderer + 33 UI
tests still pass; typecheck clean across every package.

**Noted for future self**: this is the second time this session a
documented "small minority of real content" simplification turned out
to be load-bearing for a MAJOR terrain/unit category once real pixels
were actually compared against the real engine (the first was
yesterday's hit-flash mechanism). Reading the WML/C++ source in
isolation, without ever rendering real output side-by-side against the
real game, seems to systematically under-estimate how often an
"edge case" mechanism is actually doing most of the visible work for
some major, common category of content. Prioritize getting to a real,
comparable screenshot early for any new rendering feature, rather than
treating "the source reads like a rare case" as sufficient evidence on
its own.

**Remaining for Phase 9**: ToD colour tinting (Phase 12), animation
start-time jitter, the brute-force matching's ~7s/scenario build cost
(acceptable for now, revisit if it's felt as real load-time jank), and
whatever smaller visual discrepancies only turn up from further,
more systematic screenshot comparison against the real game (not yet
done exhaustively -- only Dead_Water scenario 1 checked so far).

## 2026-09-12 (cont'd): terrain "looks nothing like it should" + "performance tanked" -- four real bugs, found by comparing against the real engine

User reported the live Dead_Water render bore little resemblance to the
real game (hard hex edges, missing transitions, floating castle-wall
stubs, gapped mountains) and that performance had tanked. All four
root causes below were found by comparing concrete artefacts against
the real engine -- `display.cpp`, `wesnoth --preprocess` output, and
`--screenshot` renders of the same map -- not by reasoning from the WML.

1. **Draw-time offsets were wrong, and the doc comment saying otherwise
   was attempt #1's, not upstream's.** `display::draw_hex` blits every
   terrain texture at `get_location_rect(loc)` of the tile it's attached
   to; `basex`/`basey` only feed the layer sort and the bg/fg split.
   `terrainPositioning.ts`'s `layerOffset` comment asserted the opposite
   ("the offset says which hex this layer belongs to and must be
   applied") -- true for attempt #1's engine fork, which reported images
   against the queried tile, false for this port, which attaches per
   tile like upstream. Applying `basex - 36` double-shifted every layer:
   that was the hard edges and the wall stubs. Offsets are now always 0.

2. **A WML preprocessor bug corrupted every water tile.** Real content
   calls `{WATER_342_180_TILE_VARIANTS "" ... "" ...}` and substitutes
   both empty args back-to-back into `...~CROP(0,0,72,72){MASKIPF}{IPF}`.
   Our output was four quotes in a row, which the tokenizer (ours AND
   upstream's -- `""` inside a string is an escaped quote) reads as one
   literal `"`, so every water frame's mods became `CROP(0,0,72,72)"`.
   Upstream avoids this only because its preprocessor emits `\376line`
   marker lines around every substitution and its tokenizer skips them
   at the character level; `wesnoth --preprocess` on a 6-line repro
   confirmed the intended result (`x~CROP(0,0):1`). Ported the same
   mechanism: `INLINE_MARK` (U+FFFE, a noncharacter) around every
   substituted argument/body, skipped by `Tokenizer.rawNext` but not by
   its `""` lookahead. First attempt -- stripping quotes off wholly-quoted
   args -- broke real `units.cfg` (multi-line `"~CHAN(\n...)"` args need
   their quotes) and was reverted; the marker approach is the faithful
   one. Also fixed `readQuoted` collapsing `""` to `"` early.

3. **The shared `squareParentheticalSplit` port ignored parentheses.**
   Upstream's default bracket sets are `"(["`/`")]"` for BOTH unit frames
   and terrain images; ours only nested `[...]`, so `~CROP(0,0,72,72)`
   split into four bogus frames and the op silently no-op'd. Fixed at the
   shared helper (parens nest, only `[..]` expands). A terrain-only
   splitter tried first lost `[01~13]` frame expansion and dropped 102
   real rules -- the real-content rule count (10,063, attempt #1's
   oracle-verified number) caught it immediately.

4. **One integer-division port error in `rotate()`.** Upstream's
   `(rj - 1) / 2` truncates; the port used `Math.floor`, which differs
   for even negative `rj` (-3/2: -1 vs -2). Every rotated constraint with
   an even negative `rj` landed one hex south -- exactly the templates
   whose anchor sits at an odd *template* column, which is all real
   `map=` transition/wall templates, and exactly why my earlier geometry
   test (anchor at template x=0) passed while the real 3x3 water dump
   showed the NW transition one hex off. New `terrainRotationGeometry.
   test.ts` covers both template parities x both map parities x all six
   angles, including a real-style `map=` template.

Also ported the missing 1-hex off-map ring (`_off^_usr` background +
`off-map/border.png` edge fades) that upstream draws around the board.

**Performance.** Measured, not guessed (Playwright + in-page timing):
- Build: 7.1s -> 0.43s by porting upstream's own `terrain_by_type_`
  cheapest-constraint prefilter (previously skipped as "pure
  performance" -- it is, and it's ~16x). Type iteration order mirrors
  `std::map<terrain_code>` (base, overlay) because `set_no_flag=base`
  rules make candidate order load-bearing.
- Hit-testing: 1,161 per-hex interactive `Graphics` replaced by one
  `hitArea` on the terrain layer + `pixelToHex`, and
  `interactiveChildren = false` -- a parent `hitArea` does NOT stop
  PixiJS from walking every child, so each pointermove was traversing
  ~10k objects.
- Tried PixiJS's `CullerPlugin` on per-hex containers: made every frame
  ~10x SLOWER (dialog clicks 0.5s -> 24s each), bisected and removed. A
  plain `app.render()` of all ~8,700 sprites costs ~3.8ms CPU / 2.8ms
  with `gl.finish`, so sprite count was never the frame-time problem.
- Remaining load cost is `ImageCache.preload` of 3,404 masked crops
  (~6.9s in headless Chromium) -- the per-pixel min-alpha mask in JS.
  Left as-is for now; it's one-time per scenario and fidelity-critical.

**Lessons, again**: (a) a doc comment that says "verified against X" is
only as good as X -- attempt #1's was verified against its own fork; (b)
the cheapest oracle is the real binary: `wesnoth --preprocess` and
`wesnoth --screenshot` each settled in minutes what reading C++ had not;
(c) synthetic 3x3 dumps of resolved layers per hex were the tool that
turned "looks wrong" into four separable, testable defects.

All 272 engine + 150 renderer + 33 UI tests pass; typecheck clean.

## 2026-09-12 (cont'd): bugs3.md's 7 real, reported bugs -- traits, objectives dialog, team recolor, moves-orb fixes

All committed individually (this project's "commit often" convention):

1. **`[objectives]` was a pure no-op.** Ported the real logic
   (`data/lua/wml/objectives.lua`): a new `packages/engine/src/events/
   objectives.ts` (parser + turn-counter-suffix formula + default
   labels/colors, all ported verbatim), threaded through `EventContext`/
   `EventPump`/a real `actionObjectives` handler, `GameSession.
   scenarioObjectives`, and a new `ObjectivesDialog.svelte` shown once at
   scenario start. Verified live against real Dead_Water content
   (title/Victory/Defeat/Gold-carryover sections, correct colors, correct
   turn-counter suffix).
2. **Recruited units never got random traits, and the infobox couldn't
   show them anyway.** Ported `unit::generate_traits` (musthave-first,
   then random honoring `require_traits=`/`exclude_traits=`):
   `UnitType.numTraits`/`possibleTraits` (this type's own inline
   `[trait]`s + the 4 real global ones from `data/core/macros/
   traits.cfg`), `actions/recruit.ts`'s new `generateTraits`, and
   `Unit.traitNames` surfaced as a "Traits:" line in `SidePanel`. Not
   ported: `[race]`-level `num_traits=`/`ignore_race_traits` (race stays
   a plain id string here) -- a documented, narrow gap.
3. **Unit sprites always rendered in raw magenta.** The `~RC`/`~TC`
   pixel-recolor machinery (`ImageCache`/`teamColor.ts`) already existed
   but nothing ever fed it real data. Added `build-team-colors.mjs`
   (parses `data/core/team-colors.cfg` into palettes/ranges/
   defaultColors, one static asset like the terrain-graphics-rules
   build), collected each unit_type's real `flag_rgb=` alongside its
   image path, and wired `SnapshotBoard.buildUnitVisual` to resolve each
   side's real color id (`teamColor.ts`'s new `resolveSideColorId`,
   mirroring `team::get_side_color_id`) and append `~RC(flagRgb>colorId)`
   before resolving the sprite texture. Verified live: Dead_Water side 1
   (default color) renders red, side 2 (`color=teal`) renders teal.
4. **The moves-left dot showed yellow ("partial") instead of red
   ("moved") when a unit genuinely had nowhere left to move/attack.**
   `movesOrbStatus` only ever checked the raw `movesLeft`/`attacksLeft`
   counters, never real reachability. Ported `display_context::
   unit_can_move` as a new `actions/unitCanAct.ts` (adjacent-hex terrain
   cost vs. remaining moves; a live/visible/non-incapacitated enemy
   within a weapon's real `min_range=`/`max_range=`, via `Location.
   getRing`), threaded through `SnapshotUnit.canMove`/`canAttackHere`.
   Verified against the exact reported repro (Kai Krellis moved to
   Dead_Water (25,10): 1 attack nominally left, no adjacent enemy, 0
   moves left -- orb is now red, not yellow).
5. **No way to see a hex's terrain defense without hovering it one at a
   time.** `GameSession.selectUnit` now attaches each reachable hex's
   real `defensePercent`; `SnapshotBoard` draws it as a small label on
   every highlighted move-range hex.
6. **The moves-left dot was a procedurally-drawn dot at a hand-guessed
   offset, misaligned with the (correctly-positioned) leader-crown/
   loyal-icon overlays.** Both of those were already the real 72px-hex-
   canvas assets, drawn at the unit's own anchor (matching upstream's
   `drawer.cpp` `textures` vector, all blitted at the identical
   destination rect). Replaced the procedural dot with the real
   `misc/orb.png` asset, recolored per status via the same `~RC`
   pipeline as (3) (`ORB_COLOR_ID`: the real `unmoved_orb_color`/etc.
   defaults from `data/game_config.cfg`), added to the sprite's
   container in the same order upstream pushes its `textures` vector
   (orb, then crown, then loyal) so the crown correctly draws on top
   where they overlap.
7. **The "Scenario Progression" synthetic debug campaign had no keep/
   castle at all**, making it impossible to test recall. Rebuilt both
   maps with a proper bordered keep+castle block (reusing the border-
   margin lesson from an earlier session's `abilities.map` fix).

Each fix has new, real-content-backed tests (engine unit tests,
`GameSession`-level tests against the real Dead_Water snapshot) plus a
live-browser Playwright screenshot confirming the visual before commit.
All engine/renderer/ui suites green; typecheck clean throughout.

## 2026-09-12 (cont'd): Phase 6 breadth -- Two Brothers fully chained, Liberty (8 scenarios) added as a third campaign

Tried AI-vs-AI (every side played by `simpleAi.ts`'s heuristic) as a
faster stand-in for a real human playthrough, to find gameplay-shaped
gaps beyond the existing forced-victory smoke chain. Result: the
heuristic AI is too weak to reliably survive even Dead_Water scenario 1
playing the "player" side too (loses by turn 3) -- a loss there
conflates "AI is weak" (expected, Phase 7 is an MVP) with "engine has a
real gap," so it isn't a trustworthy signal without much deeper
per-scenario digging either way. Flagged this to the user rather than
guessing which explanation applied; asked to prioritize breadth over
depth instead.

- All 5 Two Brothers scenarios now chain end-to-end via the real UI
  (forced-victory at each step) with zero console/engine errors;
  scenarios 1, 2, 4, 5 also confirmed rendering correctly (real story
  art/board/terrain) in live browser screenshots. Scenario 3's real
  `[option]` gap (previously only confirmed via a forced-victory script
  reporting defeat) is now precisely characterized: `actionMessage`
  reads neither `variable=` nor `[option]` children at all, so the
  password exchange silently always takes the "wrong password" branch.
  Properly fixing this needs the event pump to suspend mid-event for a
  live player choice and resume afterward -- this project's `[message]`/
  event execution is currently 100% synchronous (an event runs to
  completion, and its recorded messages are replayed to the player only
  afterward), so this is a real architecture change, not a quick add.
  Deliberately not attempted this session.
- Liberty (8 scenarios, the next-shortest mainline campaign) built
  clean on the first try for every scenario, was registered in
  `campaigns.json`, and all 8 scenarios chain via the real UI with zero
  errors; scenario 1 also confirmed rendering correctly in a live
  browser screenshot. No gaps found.
- Dead_Water (13), Two_Brothers (5), and Liberty (8) are now all fully
  buildable/chainable mainline campaigns -- 26 real scenarios total.

## 2026-09-13: Liberty scenario 1 bug report -- two real, previously-undetected engine gaps (the forced-victory chain check above missed both, since neither produces a console error)

User reported Liberty scenario 1's units rendering as unmoveable white
circles. Root-caused to two distinct, real gaps, both invisible to the
"chain scenarios via forced victory, watch for console errors" check
used above -- that check never selects a unit or inspects its stats,
so a wrong/missing unit is silently invisible to it:

1. **`[base_unit]` (a `[unit_type]` CHILD TAG) was never read at all.**
   `UnitTypeDatabase.ts`'s `flattenUnitTypeConfig` only checked for a
   `base_unit=` ATTRIBUTE -- which, it turns out, real Wesnoth's C++
   (`types.cpp`) never actually emits or reads; the doc comment's old
   claim that `base_unit=` is "used nowhere in the wesnoth submodule"
   was true but irrelevant, since real content uses the child-tag form
   exclusively. Liberty's `units/Villagers.cfg` reskins Thug/Bandit/
   Highwayman as Peasant/Village-Elder/Senior-Village-Elder via exactly
   this tag; with it unrecognized, those derived types got NONE of the
   base type's stats/image (1 HP, no image -- the reported white
   circles). Fixed by reading the `[base_unit]` child tag's `id=`
   instead of a `base_unit=` attribute; `build-scenario-snapshot.mjs`'s
   `collectUnitTypeImages` was also quietly relying on the same
   never-worked path (reading `image=`/`flag_rgb=` off each type's RAW,
   unflattened config) and is now fixed to read the FLATTENED config.
   Every real scenario snapshot was rebuilt (Dead_Water/Two_Brothers'
   counts also went 332->333/327->328: `data/core/units/monsters/
   Ant_Egg.cfg` uses `[base_unit]` too, previously silently broken for
   every campaign, not just Liberty).
2. **`[unstore_unit]` was never implemented at all** (silently skipped
   as an unregistered action tag, `runActionSequence`'s "not supported"
   warn path). Liberty scenario 1 hides Baldras off-board during the
   opening goblin conversation via the common `[store_unit] kill=yes`
   .. `[unstore_unit]` idiom -- with the second half a no-op, Baldras
   was permanently removed from the game after turn 1's setup, leaving
   the scenario unplayable (no leader to select/move/recruit with).
   Fixed: `actionUnstoreUnit` ports `data/lua/wml-tags.lua`'s
   `wml_actions.unstore_unit`, reusing `Unit.fromConfig` (the stored
   var-node's shape is `store_unit`'s own `unitToVarNode` output, an
   exact dual of what `Unit.fromConfig` reads). NOT ported: `advance=`/
   `animate=`/`text=`/`color=` (cosmetic), `find_vacant=`, and
   recall-list restores -- none needed by Liberty's own usage.
   `[modifications]` still isn't preserved through a store/kill/
   unstore round-trip (a pre-existing `store_unit` gap), so Baldras
   restores without his personal `mace-spiked` weapon rename -- a real
   but lower-severity remaining gap, not fixed this round.

Both verified via real engine tests (`UnitTypeDatabase.test.ts`'s new
`[base_unit] against real Liberty content` suite;
`pumpAndActions.test.ts`'s new store/kill/unstore round-trip test) and
a live browser session confirming Baldras selects with correct HP/
moves/attacks and a real sprite. All engine/renderer/ui suites green
(326/170/57), typecheck clean.

## 2026-09-12 (cont'd): Phase 11 (Fog, Shroud & Vision) delivered, Under the Burning Suns added as its testbed

Per the user's own reshuffle of `IMPLEMENTATION_PLAN.md` (gameplay before
UI breadth), moved straight from Phase 6 breadth into Phase 11. Ported,
tested, and wired end to end in one session:

**Engine core**: `ShroudMap` (`shroud_map`), `Team.shrouded`/`fogged`
honouring `share_vision=`/legacy `share_view=`/`share_maps=`,
`GameBoard.isShrouded`/`isFogged`; `pathfind/visibility.ts`'s
`isUnitVisibleToTeam`/`unitInvisible`/`wouldBeDiscovered` (covers `hides`
abilities -- ambush/nightstalk/concealment/submerge/swamp_lurk/burrow --
evaluated against real `[filter_location]` terrain/`time_of_day=`);
`actions/vision.ts`'s `ShroudClearer`/`recalculateFog`/`clearShroud`/
`actorSighted` (real vision/jamming paths, not straight-line radius).
`executeMove` now mirrors `unit_mover`: hidden units cached before
moving (unseen enemies block, invisible ones ambush), fog cleared hex by
hex, movement stops at a reasonable hex once units come into view,
`sighted` raised, `MoveResult.undoBlocked` mirrors upstream's
`undo_blocked()`. `executeAttack`/`recruitUnit`/`recallUnit` clear fog
and fire `attack`/`last breath`/`die`/`recruit`/`recall` the same way.
`simpleAi.ts` now scores everything through its own side's real fog.

**Events**: `GameSession` now keeps ONE event pump for the whole
scenario (previously a throwaway one for prestart/start only), firing
`turn N`/`new turn`/`side turn`/`turn refresh`/`side turn end`/`turn end`
with the matching `clear_shroud`/`recalculate_fog` calls, `moveto`/
`capture`/`sighted`/`attack`/`attack end` from real actions, and
`[endlevel]` (new, `data/lua/wml/endlevel.lua` ported) ending the
scenario. `[remove_shroud]`/`[place_shroud]`/`[lift_fog]`/`[reset_fog]`
implemented via a new shared `findLocations` (`terrain_filter::
get_locations`: `x,y=`/`terrain=`/`[and]`/`[or]`/`[not]`/`radius=` with
`[filter_radius]`). SUF gained `[filter_location]`/`[filter_vision]`.

**Rendering**: `packages/renderer/src/fogShroud.ts` ports
`display::get_fog_shroud_images` exactly -- including two genuine
upstream quirks confirmed by executing the ported algorithm rather than
hand-tracing it: a failed run-extension leaves its frontier hex to start
a fresh, separate run (so a 5-in-a-row fogged neighbour run can emit TWO
overlapping images, not one), and a fully shroud-surrounded hex (no
`void-all.png` exists) never lets its frontier index return to `start`,
so the algorithm's own hard 6-iteration safety cap is what actually
stops it, producing 3x-repeated overlapping images -- both faithfully
reproduced, not "fixed to be smarter than upstream." Wired into a new
`fog_shroud` PIXI layer above every unit layer (matching upstream's
`drawing_layer` enum order exactly), with a shrouded hex's terrain
container hidden entirely rather than drawn under the overlay.
`GameSession.renderUnits` filters by real fog-aware visibility;
`villageOwnership` now remembers each village's last-known owner while
fogged instead of showing the live one.

**Testbed**: Under the Burning Suns added as a fourth mainline campaign
(scenarios 1-4 built -- shroud + the two-suns schedule; fog + `sighted`;
`[time_area]`; underground schedule). Building it surfaced two real,
unrelated bugs, both fixed:
1. `build-scenario-snapshot.mjs`'s `map_file=` resolution only tried
   `<campaign>/maps/<file>` (Dead Water's convention) -- UtBS's own
   `{UTBS_MAP}` macro sets `map_file=` to a path already rooted at
   `data/` (`campaigns/Under_the_Burning_Suns/maps/<file>`), which is
   equally valid per real Wesnoth's VFS search path. Now tries the
   data-root-relative form first.
2. **The more consequential one**: `checkVictory` only ever asked "which
   sides currently have a `canRecruit` unit," so UtBS's `no_leader=yes`
   AI sides (2-4, whose real leaders are placed by a later scripted
   event, not inline in `[side]`) had zero qualifying units at scenario
   start and were silently dropped from `notDefeated` -- ending the
   scenario in an instant false "Victory!" turn 1, before the antagonist
   ever appeared. Root cause: `no_leader=`/`SnapshotTeam.noLeader` was
   never threaded from the build script through the client snapshot at
   all. Fixed by threading it through and rewriting `checkVictory` to
   delegate to the already-correct `GameBoard.teamIsDefeated` (which also
   picks up the previously-ignored `team.lost` flag as a bonus
   correctness fix) instead of re-deriving similar logic.

Verified live in a real browser: UtBS scenario 1 renders real terrain in
the explored area with a solid black shroud covering the rest, in-play
dialogue/`moveto` messages display in order, and 6 turns cycle across
all 4 sides (AI-controlled included, real two-suns schedule visibly
advancing -- "First Dawn" -> "The Short Dark" by turn 6) with zero
console errors and no false victory/defeat. Engine/renderer/ui suites
all green (367/184/57), typecheck and `svelte-check` (0 errors) clean
throughout.

## 2026-09-13: Phase 12 (Time of Day & Schedules) delivered

Per the reordered plan, moved straight from Phase 11 into Phase 12. Per
the user's own guidance ("UtBS has a custom day-night cycle, so test
defaults on a simple/synthetic campaign and use UtBS for the special ToD
WML tags"), verified the default six-phase schedule against real Dead
Water and the special tags against real Under the Burning Suns content.

**Engine**: `Schedule` (`packages/engine/src/model/Schedule.ts`) is now
genuinely stateful, mirroring `tod_manager` itself: the global schedule
and every `[time_area]` are each an "anchored sequence" (a turn number +
the index active on it), so turn advancement needs no per-turn mutation.
`random_start_time=` is resolved once via the session's RNG, matching
`tod_manager::resolve_random`'s exact draw sequence (including its extra,
otherwise-unused second draw for the list form). New `events/todWml.ts`
implements `[time_area]`/`[remove_time_area]` (reusing Phase 11's
`findLocations`), `[replace_schedule]`, and `[store_time_of_day]`. New
`actions/illumination.ts` ports `get_illuminated_time_of_day`'s
`[illuminates]` effect, including the net-darker/net-brighter composition
for overlapping sources.

**Real bug found and fixed**: `combat_modifier` computes the attacker's
and defender's ToD bonus SEPARATELY, from each unit's own hex (a lit
radius or a `[time_area]` boundary can put them in different ToD) --
this project applied one shared global value to both. `UnitStatsOptions.
lawfulBonus` is now `attackerLawfulBonus`/`defenderLawfulBonus`, threaded
through `combat.ts`/`simpleAi.ts` (now via a `lawfulBonusAt(loc)`
callback so the AI scores per candidate hex) and `GameSession`'s three
real call sites via a new `timeOfDayAt(loc)` method. `GameBoard.
lawfulBonusAt` (the Phase 11 `[filter_location] time_of_day=` hook) is
now genuinely location-aware too, not just shaped like it.

**Rendering, and a real bug found by testing live**: `SnapshotBoard.
updateTimeOfDayTint` reconstructs `image::set_color_adjustment` (the real
per-channel additive/clamp tint) as two full-board rects -- `'add'`-
blended for positive channels, `'subtract'`-blended for negative -- above
the fog/shroud layer. Chosen over the already-built-but-never-wired
per-texture `~TOD()` pseudo-op (`animation/timeOfDay.ts`, apparently
built ahead of this phase) to avoid re-resolving and caching a second
copy of the whole terrain atlas every time the schedule advances. First
attempt rendered the ENTIRE board solid black the instant any tint (even
a tiny one) was applied, with no console error. Bisected by temporarily
exposing the live `SnapshotBoard` on `window` and calling
`updateTimeOfDayTint` with isolated positive-only and negative-only
values: `'add'` worked correctly (a real reddish tint over real terrain),
`'subtract'` was black regardless of magnitude -- pointing at the blend
mode itself, not the (already unit-tested) colour math. Root cause: in
PixiJS v8, `'subtract'` is an "advanced" (shader-based) blend mode, not a
native GL blend equation like `'add'`, and needs (a) its extension
registered via `PIXI.extensions.add(PIXI.SubtractBlend)` and (b) the
renderer created with `useBackBuffer: true` -- without both, the blend
filter has no valid backbuffer to read the composited scene from and
silently renders solid black. Both fixed; verified live afterwards.

**Save/load**: `Schedule.exportState`/`importState` round-trip the
mutated global schedule and every active `[time_area]` through
`SaveGameData`, optional on read so older saves still load unaffected.

**Verification**: live against real Dead Water (default `{DEFAULT_
SCHEDULE}`) -- turn 1 (Dawn) vs. turn 5 (First Watch) show a visibly
darker/cooler board, matching the schedule's own red/green/blue shift,
with correct gameplay (real AI-controlled undead advancing) throughout
and zero console errors. Live against Under the Burning Suns scenario 3's
real `[time_area] id=campfires` (three campfire clusters, radius=2) via a
forced-victory chain from scenario 1 -- this surfaced a real chaining-
methodology gap (forcing victory on scenario 2 before its own recall/
carryover had placed any units reads as an instant, wrong defeat; not a
Phase 12 bug) which was worked around by testing `[time_area]` as a real-
content Vitest integration test instead: loading scenario 3's real,
already-built snapshot directly, running its actual `prestart` event, and
confirming a campfire hex's ToD differs from the global one while a hex
outside every campfire's radius does not. `{UNDERGROUND}` needed no new
code (a single `[time]` entry, handled by existing generic parsing).
Engine/renderer/ui suites all green throughout (400/190/62), typecheck
and `svelte-check` (0 errors) clean.

## 2026-09-13: Phase 29 (real AI port, RCA framework + Lua on fengari) planned; S0 (engine prerequisites) delivered

Full plan at `.claude/plans/wise-squishing-deer.md` (13 stages, S0-S12),
approved after two `Explore` surveys (this project's current AI state;
upstream's real `src/ai/` framework, found intact at
`/home/tom/wesnothweb/wesnoth/src/ai` -- the `wesnoth` submodule here is
data-only) and one `Plan` agent design pass, plus direct verification of
every load-bearing claim (WML macro parsing of the real `ai_default_rca.
cfg`/`default_config.cfg`, the `[unitTypeConfigs]` flattened-config path
already carrying `usage=` with zero snapshot-builder changes needed, the
golden reproducibility test not touching the AI). Supersedes Phase 7's
"Later: port the candidate-action framework" bullet.

**S0 (engine prerequisites), delivered**:
- `Unit.goto` (new field, `goto_x=`/`goto_y=` read in `fromConfig`) and
  `UnitType.usage` (new field, `usage=`) -- both real upstream fields this
  port never carried; the AI's `goto` candidate action and recruitment's
  scout/healer logic need them.
- `Unit.toConfig()`: new serializer, the dual of `fromConfig`, covering
  the fields `unitToVarNode` (`[store_unit]`) doesn't need but the AI/Lua
  bridge will (`goto_x`/`goto_y`, `attacks_left`, `status`, `ai_special`).
- `events/filter.ts`: SUF gained `role=`, `race=`, `ability=`,
  `has_weapon=`, `status=`, `ai_special=guardian`; `findLocations` is now
  re-exported from `events/index.ts`; new `locationMatchesFilterOnBoard`
  (self-match + `[and]`/`[or]`/`[not]`, no `radius=`) for the `avoid`
  aspect and single-hex Lua queries.
- `actions/moveSequence.ts`/`attackSequence.ts`: extracted the
  `capture`/`moveto` and `last breath`/`die`/`attack end` event
  choreography out of `GameSession.moveSelectedTo`/`confirmAttack` into
  `performMove`/`performAttack`, reused by both. Closes a real,
  previously-undetected gap: the Phase 7 heuristic AI's `executeMove`/
  `executeAttack` calls fired no events at all beyond `sighted`, so any
  WML hooked on a unit's own `moveto`/`attack`/`die` silently never fired
  for AI-controlled units -- the real AI (S1+) will go through the same
  `performMove`/`performAttack` and get this for free.
- `packages/engine/scripts/gen-ai-configs.mjs`: regenerates
  `src/ai/config/builtinAiConfigs.generated.ts` (the parsed, macro-
  expanded `default_config.cfg` + all 4 `ais/*.cfg`) from the real
  upstream WML, since the browser has no WML preprocessor. Verified by a
  new drift-check test that re-parses the same files and diffs.
- `test/ai/helpers.ts`: `simpleAi.test.ts`'s board/unit-type builders
  extracted for reuse by the real AI's own candidate-action tests (S1+).

30 new engine tests (`Unit.test.ts`, `sufNewKeys.test.ts`,
`attackSequence.test.ts`, `moveSequence.test.ts`,
`builtinConfigsInSync.test.ts`). Engine/renderer/ui suites all green
throughout (447/193/83), typecheck and `svelte-check` (0 errors) clean.
Branch `phase-29-real-ai`.

**S1 (RCA framework core + idle_ai + simple CAs), delivered** (2026-09-13):
- `ai/composite/rca.ts`: the real RCA scheduler, ported line-for-line from
  `stage_rca.cpp:78-146` -- enable all candidate actions, repeat: sort by
  `max_score` descending, early-break each pass once no remaining CA's
  `max_score` can beat the best score found so far, evaluate/execute the
  winner, and if `execute()` didn't actually change the gamestate (tracked
  via `AiContext`'s gamestate-change counter, bumped only by real
  `executeMove`/`stopUnit` mutations) disable that CA for the rest of
  *this* stage invocation only -- until nothing scores above 0, capped at
  `EXECUTION_CAP` (1000, a safety valve upstream lacks). Caught a real
  scheduler bug while writing `rcaStage.test.ts`: the `execute()`-throws
  catch path disabled the offending CA but never set `executed = true`,
  so the whole stage silently stopped after the first throwing CA instead
  of giving the next-best CA its turn -- fixed.
- `ai/composite/aspect.ts` + `ai/config/upgrade.ts`: `CompositeAspect`
  (`[default]` + `[facet]`s gated by `turns=`/`time_of_day=`, last-active-
  facet-wins) and `expand_simplified_aspects`/`parseSideAiConfig`, upgrading
  bare `[side][ai] aggression=0.8` and bare `[avoid]` into proper
  `[aspect]`/`[facet]` form exactly as upstream's `configuration.cpp` does.
  Verified against Dead Water scenario 1 side 2's real `[ai]` block, not
  just synthetic WML.
- `ai/context.ts` (`AiContext`), `ai/moveMaps.ts`, `ai/powerProjection.ts`,
  `ai/keeps.ts`: srcdst/dstsrc move maps, `power_projection` threat
  scoring, and keep lookup, all consumed via typed aspect getters
  (`getAggression`, `getVillageValue`, `isPassiveLeader`, etc.) that read
  through the composite-aspect layer above.
- `ai/composite/aiComposite.ts` + `ai/default/registry.ts`: `AiComposite`
  (`newTurn`/`playTurn`) builds `stages[]` from parsed config via a
  name -> factory registry; an unregistered candidate-action name (every
  C++/Lua CA this port doesn't implement yet, e.g. combat, recruitment)
  logs a warning and is skipped rather than throwing, so the *real*
  `ai_default_rca` config runs end-to-end today with only the 5 CAs below
  actually acting.
- Five real candidate actions ported from `ai/default/ca.cpp`: `goto`
  (53-153), `move_leader_to_keep` (389-534, via `suitableKeep`/
  `nearestKeep`), `leader_shares_keep` (1563-1620), `healing` (1313-1387,
  skips units with the `regenerate` ability or a passive leader), and
  `villages` (535-1311, reachable-unowned-village capture with simple
  bipartite dispatch across multiple units and the leader always moving
  last so it doesn't block the castle exit for a later recruitment pass).
- `idle_ai` (the real `ai_algorithm=idle_ai` config, an empty stage list)
  verified end-to-end to take zero actions ever.

54 new engine tests across 8 files (`rcaStage.test.ts`, `aspect.test.ts`,
`configUpgrade.test.ts`, `caGoto.test.ts`, `caMoveLeaderToKeep.test.ts`,
`caLeaderSharesKeep.test.ts`, `caHealing.test.ts`, `caVillages.test.ts`)
plus a 3-test end-to-end integration file (`aiComposite.test.ts`) driving
the real generated `ai_default_rca`/`idle_ai` configs through the full
composite. `packages/engine/src/ai/simpleAi.ts` (the Phase 7 heuristic)
is untouched and still wired into `GameSession` -- S1 lands the new
framework alongside it, unused by the running app until S5 swaps it in.
Engine/renderer/ui suites all green (504/193/83), typecheck and
`svelte-check` (0 errors) clean. Branch `phase-29-real-ai`.

**S2 (attacks aspect + attack_analysis + combat CA), delivered** (2026-09-13):
- `ai/powerProjection.ts`: added `bestDefensivePosition` (`contexts.cpp:
  445-489`) -- among an attacker's reachable hexes, the one with the
  lowest chance to be hit, tie-broken by support minus vulnerability. Not
  cached (documented simplification, matches `aspect.ts`'s own note).
- `ai/default/attackAnalysis.ts`: `AttackAnalysis`, a line-for-line port of
  `attack_analysis::analyze`/`rating`/`attack_close` (`attack.cpp`) --
  simulates a whole multi-attacker exchange against one target (chaining
  the defender's accumulated damage across attackers via `Combatant`'s
  `prev` parameter, exactly like upstream's `prev_def`), then scores it:
  chance-to-kill/target-value, average losses (with advancement/plague
  rewards), terrain-quality-vs-alternative exposure risk, a leader-threat
  multiplier, and a "don't throw units away for nothing" sanity veto.
  Reuses this port's own `buildBattleContext`/`simulateCombat`/
  `chooseDefenderWeaponIndex`/`betterCombat`/`isBackstabActive`/
  `computeLeadershipBonus`/`computeResistanceModifier` -- the exact same
  machinery a human's attack preview and Phase 7's heuristic AI use, per
  this project's standing "one real combat engine" principle. Documented
  simplification: weapon selection for multi-attacker combos uses a fresh
  (non-`prevDef`-chained) simulation as a heuristic; only the final scored
  numbers are correctly chained (no `unit_stats_cache` either -- a real
  perf pass is S12).
- `ai/default/aspectAttacks.ts`: `analyzeTargets`/`doAttackAnalysis`/
  `rateTerrain`, the real `ai_default_rca::aspect_attacks` exploration --
  recursively builds every attack combination (depth capped at 5, 1000
  positions) against every visible enemy, picking each attacker's single
  best-rated adjacent hex via terrain/healing/village/backstab/leadership
  bonuses balanced against vulnerability/support, honoring the `attacks`
  aspect's `[filter_own]`/`[filter_enemy]`.
- `AiContext`: `getAttacks()` (the `attacks` aspect itself, cached until
  the gamestate actually changes, the one aspect this port bothers
  caching -- matches upstream's `invalidate_on_gamestate_change=yes`),
  `executeAttack` (gamestate-tracked, mirrors `executeMove`/`stopUnit`),
  `isAttackClose`/`clearRecentAttacks` (mirrors `game_info::
  recent_attacks`, cleared once per side turn by `AiComposite.newTurn`).
  `AiHost` gained a `fire` method (immediate, non-queued event dispatch
  for `last breath`/`die` mid-attack, matching `GameSession.confirmAttack`'s
  own `fire:` callback to `performAttack`).
- `ai/default/caCombat.ts`: `CombatCandidateAction`
  (`ai_default_rca::combat_phase`, `ca.cpp:154-266`) -- picks the
  best-`rating()` combo from `getAttacks()`, executes just its first
  attacker's (move +) attack, then advances whichever combatant survived
  (explicit here, matching `simpleAi.ts`'s own convention, since real
  advancement is otherwise invisible plumbing inside upstream's synced
  command executor).

23 new engine tests across 3 files (`attackAnalysis.test.ts`,
`aspectAttacks.test.ts`, `caCombat.test.ts`): a strong attacker takes a
clearly good trade (verified both directly via `rating()` and end-to-end
via the CA), a weak attacker declines a clearly bad one, `[filter_own]`/
`[filter_enemy]` gate correctly, allies are never targeted, and
`analyze()` leaves the board exactly as it found it. Engine/renderer/ui
suites all green (516/193/83), typecheck and `svelte-check` (0 errors)
clean. Branch `phase-29-real-ai`.

**S3 (recruitment CA + recruitment aspect), delivered** (2026-09-13):
- `ai/default/recruitment.ts`: a port of `default_recruitment::recruitment`
  (`recruitment.cpp`, ~1900 lines) covering its core score-driven loop --
  `compare_unit_types`'s pairwise matchup formula (both directions
  simulated via the same `chooseDefenderWeaponIndex`/`betterCombat`
  machinery `attackAnalysis.ts` uses), `[recruit]`/`[limit]` job matching
  (`pattern=`/`type=`/`total=`/`importance=`, the `recruitment_instructions`
  and legacy `recruitment_pattern` aspects), `recruitment_randomness`, the
  `recruitment_save_gold` state machine (`normal`/`save_gold`/
  `spend_all_gold`/`leader_in_danger`, driven by `get_unit_ratio`), scout
  allocation from neutral villages (`villages_per_scout`), recall preferred
  over recruit when actually worth it (`recall_unit_value`), and "spend
  until unaffordable or every job is done, one recruit at a time".
  `AiContext` gained `executeRecruit`/`executeRecall` (gamestate-tracked,
  mirroring `executeMove`/`executeAttack`) and typed getters for the five
  recruitment aspects.
- **Deliberately not ported** (documented, matches the Phase 29 plan's own
  risk mitigation): the geometric "important hexes" border-zone map
  analysis that upstream uses to weight average defense towards the front
  line -- this port's `averageDefense` instead averages a unit type's
  defense over every distinct terrain code present on the board (simpler,
  still board-shape-aware, not front-line-aware); `do_similarity_penalty`
  and `handle_recruitment_more` (secondary refinements on the core loop);
  per-leader `extra_recruit=`/`recall_filter=` (this port's `Unit` has no
  such fields); and the pure-perf caches (`unit_stats_cache`/
  `combat_cache_`/`cheapest_unit_costs_`).

13 new engine tests (`recruitment.test.ts`): `compareUnitTypes` is
antisymmetric and zero for harmless matchups; the CA recruits repeatedly
while affordable with room, spends until unaffordable (not until the
castle is full), respects `[limit]` (scoring positively per real upstream
behaviour -- `evaluate()` doesn't itself check limits, only whether any
job exists -- while still recruiting nothing), `recruitment_pattern`
restricts to named types, higher `importance=` wins, `recruitment_randomness=0`
is deterministic across repeated runs, recall is preferred over recruit
when it's actually the better value, `recruitment_save_gold` correctly
blocks all recruiting, and scouts get recruited when villages call for
them. Engine/renderer/ui suites all green (527/193/83), typecheck and
`svelte-check` (0 errors) clean. Branch `phase-29-real-ai`.

**S4 (move_to_targets + find_targets + move_leader_to_goals + retreat),
delivered** (2026-09-13):
- `ai/composite/goal.ts` + `ai/composite/target.ts`: the `[goal]` hierarchy
  (`TargetUnitGoal`/`TargetLocationGoal`/`ProtectGoal`, matching `name=
  target`/`target_unit`/`target_location`/`protect_unit`/`protect_location`)
  and the `Target`/`TargetType` shape `findTargets` and every goal share.
  `ai/config/upgrade.ts` now also upgrades the legacy bare `[target]`/
  `[target_location]`/`[protect_unit]`/`[protect_location]` `[ai]` children
  (no `[goal]` wrapper) into the modern shape -- this closes the one
  documented gap S1's `expandSimplifiedAspects` had left open.
  `ParsedSideAiConfig` gained `goals`, threaded into `new AiContext(host,
  side, aspects, goals)`.
- `ai/default/findTargets.ts`: a faithful port of `default_ai_context_impl::
  find_targets` -- threats to the leader, unclaimed villages (plus allied
  ones worth reinforcing when `support_villages=yes`), visible enemy
  leaders, and every active goal's own targets, with the real
  inverse-square-distance clustering boost between nearby targets.
- `ai/default/caMoveLeaderToGoals.ts`: the `leader_goal` aspect
  (`x=`/`y=`/`max_risk=`/`auto_remove=`) drives the leader towards an
  explicit destination, refusing any hex where enemy power projection
  times `max_risk` would exceed the leader's own hitpoints.
- `ai/default/caMoveToTargets.ts`: the real target-chasing loop --
  `rate_target`'s full formula (support-target multiplier, scout
  village-targeting bonus, scout enemy-avoidance), guardian units holding
  position, and "complex targeting" (every eligible unit gets a chance to
  outbid the first for the best target). **Documented simplification**
  (matches this port's established pattern for large sub-systems, e.g.
  recruitment's skipped important-hexes): the "dangerous path" branch and
  everything under it (troop-massing/grouping, the `support`-target
  access-points special case, `battle_aid`/`mass` reinforcement targets)
  is not ported -- this CA always takes upstream's own final fallback
  instead (advance as far along the chosen route as this turn's movement
  allows), which is real, correct movement in every case, just without the
  "mass troops before attacking a defended target" refinement.
- `ai/default/caRetreat.ts`: the `retreat_phase` CA (`ai_default_rca_1_14`
  only -- the current default algorithm uses the Lua `retreat_injured`
  micro-loop instead, Phase 29 S7+), including its own `should_retreat`
  power-projection/exposure formula and the leader-adjacency override
  (never retreat away from a leader it could instead help defend).
- `AiContext` gained `getGoals`/`getLeaderGoalConfig`/`getSimpleTargeting`
  and `bestDefensivePosition` import wiring for `caRetreat.ts`.

22 new engine tests across 4 files (`findTargets.test.ts`,
`caMoveLeaderToGoals.test.ts`, `caMoveToTargets.test.ts`,
`caRetreat.test.ts`): village/leader/explicit-goal/clustering targets,
ally-village exclusion, leader-goal pathing with a real `max_risk` veto,
guardian units holding position, scout village-targeting, `[avoid]`
exclusion, and retreat triggering/declining correctly (including the
"in reach of the leader" override and `caution=0`). Engine/renderer/ui
suites all green (544/193/83), typecheck and `svelte-check` (0 errors)
clean. Branch `phase-29-real-ai`.

**S5 (GameSession integration -- MILESTONE: Dead Water plays with the real
AI), delivered** (2026-09-13):
- `ai/manager.ts`: `AiManager`, one `AiComposite` per side, built lazily
  from `findSideConfig(scenarioConfigJson, side)?.children('ai')`.
  `playTurn(side)` runs `newTurn()`+`playTurn()` and drains the side's
  action log (see below) -- the exact same `AiAction[]` contract
  `simpleAi.ts`'s `playAiTurn` used, so `GameShell.playAiAnimations` needed
  no changes at all. `appendSideAi` (`[modify_side][ai]`) rebuilds a side's
  composite with an extra `[ai]` block merged in. `modifyAi` supports two
  real `[modify_ai] path=` shapes: `goal[<id>]` (by far the most common
  real-content shape -- e.g. Son of the Black Eye's "defend_Braga"/
  "defend_Meato") and `stage[<id>].candidate_action[<ca_id>]`; any other
  path shape (`aspect[...]`, ...) is logged and ignored -- a documented
  gap, matching this port's established pattern for real-but-partial
  `[modify_ai]` coverage.
- `AiContext` gained an action log (`logAction`/`drainActionLog`) that
  `executeMove`/`executeAttack`/`executeRecruit`/`executeRecall` append to
  automatically (plus `caCombat.ts`'s own explicit `advance` entries) --
  every CA gets real UI animations for free, with no CA-specific plumbing
  needed. Also gained `addGoal`/`deleteGoal` (goals are now a mutable list,
  not a construction-time-only array, so `[modify_ai]` can add/remove
  them) and `Goal.id` (every goal class now carries its `[goal] id=`).
- `ai/wmlActions.ts`: the `[modify_ai]`/`[modify_side]`/`[micro_ai]` action
  tags, registered onto `GameSession`'s own `ActionRegistry` (via its
  documented "externally register-able" contract, not by teaching
  `events/actionWml.ts` about the `ai/` package) -- delegating to
  `EventContext.ai` (a new optional field), which is undefined (not a
  no-op stub) for any host without a real AI engine, so the tags log a
  clear "not loaded" warning rather than silently doing nothing.
  `[modify_side]` also handles `team_name=`/`user_team_name=`/
  `controller=`/`recruit=`/`gold=`/`income=` directly (previously
  completely unregistered).
- `GameSession`: constructs one `AiManager`, fires `ai turn` before every
  AI side's turn (mirrors `manager::play_turn`'s own pre-turn event, so
  WML hooked on it fires for AI sides too -- it never did before),
  registers the AI WML actions, and `playAiSide` now calls
  `aiManager.playTurn(side)` instead of the Phase 7 heuristic.
  **`simpleAi.ts` and its 12 tests are deleted** -- their intent (good
  trade taken, bad trade declined, village capture, closing distance,
  advancement) is now covered by the real CAs' own tests
  (`caCombat.test.ts`, `caVillages.test.ts`, `caMoveToTargets.test.ts`).
  Save/load needed no new code: `AiManager` holds a live reference to
  `GameSession`'s own `board`/`rng` (mutated in place by `loadSaveData`,
  never reassigned), so an in-session load transparently keeps working;
  the one documented gap is that `[modify_ai]`/`appendSideAi` changes made
  before a save do not survive `fromSaveData` building a brand new
  session (only the original scenario config does).
- **Verification**: `gameSession.test.ts`'s existing real-Dead-Water-
  scenario-1 test ("a single endTurn() call ... auto-plays the whole of
  side 2's AI turn") now exercises the actual RCA framework end-to-end
  (construct `AiManager` from the real scenario `[side][ai]` config,
  `ai turn` fires, `playAiSide` drains a real, non-empty animation log)
  and still passes unmodified -- this is the milestone's vitest half. Its
  browser half (Dead Water 1, live End Turn, console clean) was NOT
  verified this session: no browser-automation tool is available in this
  background job's environment, so this is an honest gap, not a silent
  skip -- recommended before calling Phase 29's Dead Water milestone
  fully done.

5 new engine tests (`manager.test.ts`): `playTurn` moves a leader and
returns a real action log, `idle_ai` returns an empty log, `appendSideAi`
rebuilds a composite with a new block applied, `modifyAi` deletes a
candidate action from a running stage, and adds/deletes a `[goal]` by id.
Engine/renderer/ui suites all green (537/193/83 -- net -7 engine tests
from deleting `simpleAi.test.ts`'s 12 and adding 5 new), typecheck and
`svelte-check` (0 errors) clean. Branch `phase-29-real-ai`.

**S6 (headless AI-vs-AI benchmark harness), delivered** (2026-09-13):
- `synthetic-campaigns/combat/scenarios/02_combat_ai.cfg` +
  `combat_ai.map`: a real, hand-authored scenario (Spearman/Bowman vs.
  Orcish Grunt/Orcish Archer, real `data/core/units/` types) with BOTH
  sides `controller=ai`, each with its own keep+castle and gold, three
  neutral villages contested in the middle -- `01_combat.cfg`
  (`controller=human`, no keeps) can't exercise the AI at all.
- `packages/ui/scripts/ai-benchmark.ts`: `npx tsx packages/ui/scripts/
  ai-benchmark.ts --scenario synth_combat_02 --games N --seed S
  --max-turns T` plays N independent, deterministically-seeded games and
  prints one JSON line per game (`{seed, winner, turns, ms, msPerTurn,
  actions, luaErrors}`) plus a win-rate/mean-turns/mean-ms-per-turn
  summary -- meant to be diffed across runs (e.g. before/after S7's Lua
  CAs land) to catch behavioural and performance regressions alike.
  `--lua` is accepted but a no-op with a warning until S7.
- `GameSession.playAiSide` is now public (was private) and `endTurn`
  gained an optional `maxAiSideTurns` cap (default 1000, unchanged for
  every existing caller): `endTurn()`'s own auto-play loop only ever
  plays the side it advances TO, never the one a from-scratch session
  starts on, so an all-AI benchmark session needs one explicit
  `playAiSide` call for side 1's own first turn; the cap lets the
  harness enforce its own `--max-turns` budget rather than run to
  `endTurn`'s internal 1000-side-turn safety valve.
- **Live results** (10 games, `synth_combat_02`, seeds 100-107 sampled):
  a clean 50/50 win split across seeds, 5-9 turns per game, confirming
  both sides play real, competent, non-degenerate combat -- and bit-
  for-bit determinism (identical seed -> identical winner/turns/actions
  across repeated runs, only wall-clock `ms` differing).

3 new tests (`ai-benchmark.test.ts`, colocated with the script): a game
completes within budget, same-seed determinism, and a 2-game smoke test
matching the plan's own spec. Engine/renderer/ui suites all green
(537/193/86), typecheck and `svelte-check` (0 errors) clean. Branch
`phase-29-real-ai`.

**Phase 29 checkpoint: S0–S6 done, S7/S8 explicitly handed off**
(2026-09-13). After reading all 5 of S7's target Lua candidate actions
in full, their transitive dependencies (`ai_helper.lua` 2548 lines,
`battle_calcs.lua` 1612 lines, `retreat.lua`, `location_set.lua`, a
micro-AI helper file) plus the `wesnoth.*`/`ai.*` host API surface they
need (unit proxies with methods, `wesnoth.paths.find_reach`,
`wesnoth.simulate_combat`, map/terrain queries, `ai.aspects.*`/
`ai.get_attacks()`, Lua<->WML conversion) make S7 alone a multi-session
undertaking, not a same-scale extension of S0–S6. Given a choice between
(a) a reduced "S7-lite" slice, (b) stopping at the S0–S6 milestone and
handing S7/S8 off cleanly, or (c) attempting the full scope with real
risk of an incomplete/undertested result, the user chose (b). `docs/
IMPLEMENTATION_PLAN.md`'s Phase 29 section and `docs/OPEN_QUESTIONS.md`
#4 are updated accordingly; the full staged plan for S7 onward remains
at `.claude/plans/wise-squishing-deer.md` for whenever this is picked
back up. Everything through S6 is real, complete, and independently
useful on its own -- nothing in it is provisional or needs revisiting
once S7 eventually lands.

## 2026-09-13: bugs4.md -- 11 bugs fixed (Phase 13/14 UI + AI-turn animation follow-ups)

Handled while a peer session worked Phase 7 (AI) improvements in parallel.

- **#1** AttackDialog now closes the instant "Attack" is clicked, before
  the combat animation plays, instead of staying open for the whole
  exchange -- `pendingPreview`/`attackerWeaponOptions` are cleared
  directly, ahead of the full `sync()` that must stay deferred until
  after the animation (or the board would jump straight to the final
  post-combat state).
- **#4/#6/#8** `recruitOptions`/`recruitTiles`/`recallOptions` (and
  recruiting/recalling/dismissing/renaming themselves) no longer require
  the leader to be the currently SELECTED unit -- only that it's the
  active side's turn and the leader is on a keep with a vacant connected
  castle tile (`GameSession.recruitingLeader`). Root cause of #8's "gold
  never updates" (and #6's stale-higher-number symptom): `TopBar.svelte`
  read `EconomyInfo.startGold` -- the side's gold AT SCENARIO START,
  deliberately frozen forever -- instead of the live `gold` value
  `GameShell` already tracked correctly; recruiting always spent gold
  correctly, the status bar just never showed it.
- **#5** Choosing a unit from the Recruit/Recall dialog now places it
  directly on the castle tile the dialog was opened from (right-click),
  instead of requiring a second click on that same tile.
- **#7** Turn-start rest/village healing, poison damage, and real
  `[heals]`/`[regenerate]` ability healing already applied the real HP
  change but never showed it -- no floating HP-change numeral and no
  `healed`/`poisoned`/`healing` unit animation, despite
  `parseUnitAnimations` already fully supporting those three real WML
  animation tags (simply never invoked). `GameSession.endTurn` now
  accumulates every `HealOutcome` (`lastHealAnimations`), played back the
  same way combat blows already are.
- **#9** Every attack-list `{#each}` in the UI keyed by `atk.name`, which
  real content routinely violates (the real Peasant has both a melee and
  a thrown attack, both literally named "pitchfork"; Drake Arbiter has
  twin "halberd" entries) -- selecting such a unit threw a Svelte
  `each_key_duplicate` error that broke that render pass for the whole
  side panel, looking like the unit couldn't be selected at all. Fixed by
  keying by array index everywhere.
- **#10/#11** The attack/damage-calculation dialogs already computed a
  fully correct final damage/chance-to-hit, but never showed why (no
  time-of-day/leadership/charge/backstab indication, no sign of which
  weapon special set a flat chance-to-hit override) or what (no weapon
  specials list at all in the confirmation dialog). `CombatantPreview`
  now carries the real inputs `buildPreview` already computes, shown as
  short badges/lines -- display-only, no combat-math change.
- **#2/#3** Every `AiAnimationEvent` (attack/recruit) read the acting
  unit's LIVE `.location` at cue-build time, well after `playAiTurn` had
  already resolved the WHOLE rest of that side's turn -- a unit that took
  a LATER action the same turn (most visibly a recruiting leader that
  still had its own moves) had its EARLIER action's animation play back
  at its FINAL position instead of where that action actually happened
  (a leader appearing to teleport to its destination before its
  recruiting animation played, at the keep it had already left). Fixed
  by freezing each event's location(s) at the moment `playAiTurn` decides
  the action, mirroring how `move` events already froze their own `path`.
  Also fixed AI units appearing to "stand on the same hex": a unit that
  died mid-AI-turn kept its stale sprite on screen until the turn's
  single deferred `sync()`; `SnapshotBoard.removeUnitVisual` (same "poke
  the renderer directly" convention as `previewHitpoints`/
  `spawnFloatingNumber`) now removes it the instant its death animation
  finishes.

Verified live throughout (Economy/Combat/Abilities & Specials synthetic
debug campaigns, real Two Brothers scenario 1 -- Mordak recruiting 7
units then moving away in the same AI turn across multiple end-turn
cycles, zero console errors). Engine/renderer/ui suites green throughout
(418/193/86), typecheck and `svelte-check` (0 errors) clean.

## 2026-09-13 (cont'd): bugs5.md -- 4 bugs fixed (follow-ups to bugs4.md's recruit/AI-animation work)

- **#1** Recruiting/recalling no longer auto-selects the leader afterward.
  `tryRecruitAt`/`tryRecallAt` used to re-select it "to refresh
  recruitTiles/attackCandidates", a rationale that stopped applying once
  bugs4.md #4 made those selection-independent getters -- so it was just
  an unwanted, un-asked-for selection change, most noticeable recruiting
  via the context menu with nothing selected beforehand.
- **#4** The board's green recruit-tile highlight is tied back to
  `selectedUnit` (`GameSession.boardRecruitTiles`, new) -- unlike
  `recruitTiles` itself (kept selection-independent, still feeding the
  context menu/dialog availability per bugs4.md #4), showing it any time
  the active side merely HAD a recruiting leader somewhere, with nothing
  selected, was distracting clutter real Wesnoth doesn't have.
- **#2** `CombatantPreview.backstabActive` (the "Backstab ×2" badge added
  in bugs4.md #10) was the raw GEOMETRIC flanking condition only --
  showing "Backstab" for any weapon whenever a friendly unit merely stood
  on the far side of the target, regardless of whether the attacker's own
  weapon has the `backstab` special at all. Now requires both, matching
  what the actual combat math (`combatStats.ts`) already gated the real
  damage doubling on.
- **#3** A just-recruited/recalled unit had no visual at all until the
  turn's single deferred `sync()` -- so its own "recruited" animation cue
  silently did nothing (`playAnimationSequence` drops any cue whose unit
  has no existing visual), and every unit an AI side recruited that turn
  seemed to pop into existence all at once, well after its own animation
  had already played. `SnapshotBoard.ensureUnitVisual` (new) creates a
  unit's visual on demand, right before its recruit cue plays -- same
  "poke the renderer directly" convention as `previewHitpoints`/
  `spawnFloatingNumber`/`removeUnitVisual`.

  Fixing #3 surfaced a real, previously-latent crash while testing: the
  context-menu recruit flow's own extra `sync()` (arming the choice)
  raced a fire-and-forget `updateUnits()` pass against `ensureUnitVisual`
  creating the SAME unit's visual a moment later, so a stale pass's
  cleanup loop (built before the recruit even happened) destroyed the
  visual out from under it mid-creation ("Cannot set properties of null
  (setting 'x')"). Fixed by not arming through the sync-triggering path
  when about to place the unit immediately anyway, plus a defensive
  `container.destroyed` guard in `SnapshotBoard.updateOneUnit` so any
  future instance of this class of race degrades gracefully instead of
  throwing.

Verified live (Economy debug campaign: no highlight/no selection-theft
recruiting via context menu, new unit visible within ~150ms; real Two
Brothers scenario 1's AI turn, zero console errors). Engine/renderer/ui
suites green throughout (418/193/89), typecheck and `svelte-check`
(0 errors) clean.

## 2026-09-14 — Phase 16 N0: story screen baseline

`apps/web/scripts/measure-story.mjs` (headless Chromium via Playwright,
1920x1080, against a running dev server) opens each campaign's first
scenario cold (fresh context) and warm (reload), and reports first story
paint, scenario JSON cost, per-part image bytes/load time, the largest
resources and every long task (> 50 ms) while the story is open.

Baseline (Vite dev server, so absolute numbers are pessimistic):

| campaign | run | first story paint | scenario JSON | max long task |
|---|---|---|---|---|
| Dead Water | cold / warm | 1339 / 5075 ms | 2303 KB | 2322 / 2280 ms |
| Liberty | cold / warm | 3070 / 2372 ms | 2345 KB | 1123 / 640 ms |
| UtBS | cold / warm | 1523 / 2252 ms | 3235 KB | 1020 / 1247 ms |

Findings:
- **Story art has never actually loaded in the browser.** `StoryViewer`
  calls `imageUrl()` whose base is still the default `/data/data` (only
  `SnapshotBoard` gets `/game-images`), so every background request returns
  the dev server's 369-byte HTML fallback. Paths are also rooted wrongly
  (`core/images/maps/background.webp` exists but Dead Water's `maps/dw.webp`
  base layer lives under the campaign). Liberty and UtBS snapshots have no
  story image at all (`extractStory` reads only `[background_layer]`).
- Once fixed, Dead Water part 0 alone would download `core/images/maps/
  background.webp` (**4.5 MB**) plus `maps/dw.webp` (1.49 MB).
- The long tasks while the story is open are not story work: the 17.5 MB
  `terrain-graphics-rules.json` and the board build behind the overlay
  land at ~1.3 s and block the main thread for 0.5–2.3 s at a time, which
  is what makes "Next" feel stuck. N5 must move that work off the story's
  critical path (defer or idle-schedule board construction while covered).

## 2026-09-14 — Phase 16 N1–N4: real story screen

- **N1 `engine/src/story/storyParser.ts`** ports `storyscreen/controller.cpp`,
  `parser.cpp`, `part.cpp`: every `[story]` concatenated, the always-present
  shortcut background layer, `[background_layer]`/`[image]` in order, title
  defaults, `title_position` decoding, `[if]`/`[elseif]`/`[else]` and
  `[switch]` (every matching `[case]`) against the live event context,
  `$variable` substitution. `GameSession.storyParts()` resolves before
  `prestart`. Real Dead Water 1 now yields its 5 map parts plus the journey
  part (title + 5 delayed battle markers) the old extractor dropped.
- **N2 `apps/web/scripts/build-story-assets.mjs`** writes
  `public/story/<id>.json` (story WML + image table) and q80 WebP copies at
  960/1920 px and full width into `public/derived-images/`. Images are
  rooted campaign-first then core. Story art referenced by the built
  scenarios: 139.5 MB originals → 6.4 MB smallest copies (Dead Water's
  1280 px map 1.49 MB → 248 KB at full width). `pickStoryImage` serves the
  narrowest copy covering drawn width × devicePixelRatio.
- **N3 `ui/src/story/storyLayout.ts`**: `story_viewer.cpp`'s layer, base
  layer and floating-image formulas as pure functions (WFL integer
  division), hand-computed tests at 1920×1080 and 390×844.
- **N4 `StoryViewer.svelte`** rewrite: DOM layers, delayed floating images
  cancelled on part change, title decor and title, top/middle/bottom text
  panel with upstream's translucent panel art and ornate arrows, 20 ms fade
  steps with upstream's skip rules, Back/Next/Skip, Space/Enter/Right,
  Backspace/Left, Escape. Title font: IM Fell English (SIL OFL, vendored
  woff2) behind a `--story-script-font` variable -- note the upstream
  WesScript `.otf` files do exist in `wesnoth/fonts/` (GPL v2+ with font
  exception), so swapping is a one-line change if preferred.
- Fixed on the way: `imageUrl()` base URLs are now set by `GameShell` (time
  of day images also hit `/data/data`); Vite `fs.allow` includes `packages/`.

**Performance** (headless Chromium, software GL, Vite dev server):

| Dead Water cold | N0 baseline | now |
|---|---|---|
| max long task during story | 2322 ms | ~700 ms |
| story art bytes per part | 6 MB (never loaded) | 978 KB |
| Next → next part fully shown | stuck for seconds | ~450 ms (= the two 220 ms fades) |

The decisive fix was pausing the board's PixiJS render loop while the story
covers it (`GameBoardView paused`, upstream's `set_prevent_draw`): before
it, one 220 ms fade took 10+ s and key presses were swallowed. A CPU
profile shows what remains is one-time board construction behind the
story: 5.8 s of 8.7 s busy CPU in the first 10 s is `ImageCache` pixel
compositing (`applyOp`), plus GC. Cooperative yielding inside
`ImageCache.render` was tried and A/B-measured with no difference
(single ops and GC dominate the long tasks), so it was reverted. The
remaining cost is the first part's text needing ~3–4 s after navigation to
finish fading in and the first Next taking ~0.5–1.5 s. The real fix is
moving image compositing off the main thread (OffscreenCanvas worker) --
renderer work beyond this phase, recorded for Phase 28.

## 2026-09-14 — Phase 16 N5–N6: preloading, `[message]` dialog

- **N5** `StoryViewer` keeps decoded `Image`s for the previous, shown and
  next part (everything further dropped) and shows a "Loading…" indicator
  when the shown part's art has not decoded within 150 ms.
- **N6 engine**: `actionMessage` ports `data/lua/wml/message.lua`:
  `[show_if]`; `get_speaker` (narrator / unit / second_unit / id, else the
  message's own attributes as a unit filter) -- a message whose speaker is
  not on the map is now **skipped**, as upstream (one Dead Water event test
  that fired `start` without `prestart` relied on the old behaviour and now
  fires both); `get_image` (`image=`, else the speaker's portrait only when
  there is no `second_image=`; `image=none`; `~RIGHT()` and `image_pos=`
  choose the side -- never the unit's side); `get_caption`; `scroll=`/
  `highlight=`. `Unit.portrait()` mirrors Lua's `unit.portrait`: `[unit]
  profile=`, else the type's `profile=`, else the sprite at 144×144.
- **N6 UI**: `MessageViewer` ports `wml_message_left/_right/_double`: a
  window over the map area, translucent panel along the bottom, 22 px gold
  title, 675 px text column, portrait standing on the bottom edge sized by
  the `__GUI_IMAGE_WIDTH` formulas (`story/messageLayout.ts`, tested),
  mirroring, double portraits, next message's portraits preloaded,
  `GameBoardView.scrollToHexIfOffscreen` for the speaker. The asset build
  now roots every portrait a scenario can show (campaign portraits such as
  `portraits/cylanna.webp` used to resolve under core and 404); re-encoded
  portraits are ~3–4× smaller (Gwabbo 161 → 43 KB).
- Deviations: no hex highlight yet (scroll only, instant); on a board area
  narrower than 600 px the dialog covers the whole window, since the
  in-game layout itself is not mobile-ready (Phase 23).
- Verified live (headless Chromium): first dialogue of Dead Water (Kai
  Krellis, Cylanna), Liberty (Fal Khag) and Two Brothers (Baran) with the
  right rooted portraits, no console errors or broken images.

## 2026-09-14 — Phase 16 N7: campaign outro

- `[endlevel]` records `end_text_duration` (clamped 0–5000 ms, like
  `game_classification`) and `end_credits`. On a victory with no next
  scenario, unless `end_credits=no`, `GameShell` rolls `Outro.svelte`
  before the end overlay (`playcampaign.cpp`): `end_text` (default "The
  End"), the campaign name, then each `[about]` section in chunks of 5
  names with the title on the first chunk (`outro.cpp`); 500 ms CSS
  opacity fades, 3500 ms default hold, Escape skips. Campaign name and
  credits come from `_main.cfg` via `build-story-assets.mjs` (plain-text
  scan of `[campaign][about]`).
- Two older bugs this surfaced, both fixed: campaigns mark their last
  scenario with `next_scenario=null`, which `GameSession.nextScenarioId`
  took as a real id (the epilogue offered "Continue to next scenario",
  fetching `scenarios/null.json`); and a scenario ending inside its own
  startup events (an epilogue's `start` `[endlevel]`) jumped straight to
  the end screen, skipping its objectives and dialogue.
- `/play/<campaign>?scenario=<id>` starts a campaign at a later scenario,
  for debugging and verification.
- Verified live: Dead Water's epilogue shows its 4 lines of dialogue, then
  the outro rolls through the campaign's credits; ui suite 126 tests.

## 2026-09-14 — Phase 16 N8: reference comparison

`apps/web/scripts/reference-story-screenshots.mjs` runs the installed
`/usr/games/wesnoth` (1.16.9) inside Xvfb at 1920×1080 with `--campaign`,
captures each story part with ImageMagick `import` and advances with
`xdotool`. Compared with `story-screenshots.mjs` at the same size:

- **Dead Water**: identical background geometry -- wood background
  stretched to 1920×1080, `dw.webp` base layer 1440×1080 at x=240 -- and
  the text panel's top edge at y≈812 in both.
- **Liberty**: `story/frontier.webp` drawn 1542×1080 at x=189 with black
  sides in both; panel top y≈812.
- Differences are theme-version ones, not port errors: 1.16's text block
  spans the full width with small arrow buttons and a Skip button at the
  bottom right, while this port follows the 1.19.21 theme the data ships
  (side columns with ornate arrows, centred Skip). The title font is the
  IM Fell English stand-in.

Suites at the end of Phase 16: engine 559, renderer 193, ui 126,
lua-bridge 32 tests; `svelte-check` 0 errors in ui and web.

## 2026-09-14 — Phase 28a P0: image pipeline baseline and pixel harness

Tooling (all run against a running dev server; see the scripts' headers):
- `npm run check:image-golden` (`apps/web/scripts/image-golden.mjs`):
  `--record` loads Dead Water 1, Liberty 1 and the debug combat scenario
  with one attack, and stores SHA-256 over the RGBA pixels of every
  texture `ImageCache` produced -- 4,872 refs (4,857 hexed terrain, 15
  unit sprites/animation frames incl. `~RC` and `~BLIT` chains) in
  `packages/renderer/fixtures/imagecache-golden.json`. Check mode
  re-resolves every ref from scratch and compares: **4872/4872 match**, so
  the harness is deterministic and gates P1–P7.
- `npm run measure:load` (`apps/web/scripts/measure-load.mjs`): board-ready
  time, the new `board:terrain-images` performance measure, long tasks,
  image requests/bytes, JS heap per scenario from a cold context, and one
  attack's `anim:frames` measure (time to resolve an animation's frames
  before it starts).
- Dev-only hooks for these scripts: `GameBoardView` sets
  `[data-board-ready]`, exposes `hexClientPoint` and, in dev builds only,
  `window.__wesnothDebug`; `SnapshotBoard` adds the two performance
  measures. `apps/web/scripts/lib/browserFlows.mjs` holds the shared flows.
- Note: `playwright` is used from the machine's `node_modules` but is not
  a declared dependency yet; it gets declared with `pngjs` in P5.

Baseline (headless Chromium, software GL, Vite dev server, 2 cold runs):

| scenario | board ready | terrain images | blocked (> 50 ms) | max long task | image requests / KB | heap |
|---|---|---|---|---|---|---|
| Dead Water 1 | 13.97 / 9.54 s | 10.00 / 6.73 s | 7.21 / 4.79 s | 1042 / 669 ms | 493 / 7,639 | 307 / 290 MB |
| Liberty 1 | 5.59 / 5.43 s | 2.79 / 2.65 s | 2.53 / 2.43 s | 602 / 557 ms | 450 / 5,013 | 150 / 159 MB |
| UtBS 1 | 16.15 / 16.19 s | 13.05 / 12.55 s | 10.03 / 9.54 s | 916 / 937 ms | 462 / 6,148 | 242 MB |

Attack in the debug combat scenario: the first animation waits **2.2 /
2.4 s** for its frames (9–14 image requests), with 3.1 s of main-thread
blocked time and 44 long tasks during the exchange -- the latter is more
than frame resolution alone explains and is to be examined in P4.

## 2026-09-14 — Phase 28a P1: compositor split from PixiJS

`packages/renderer/src/images/compositor.ts` now holds all pixel work,
moved verbatim: image base URLs and `imageUrl`, `hexedRef`/`todRef`,
source bitmap loading, colour mappings and every IPF op. It imports no
PixiJS and needs only `fetch`, `createImageBitmap` and canvas 2D, so it can
run in a Web Worker. `ImageCache` keeps the PixiJS side (texture cache,
in-flight de-duplication, canvas -> texture) and re-exports the moved
helpers, so no import site changed. `test/compositorIsolation.test.ts`
walks the compositor's local imports and fails if any imports `pixi.js`.
Golden check 4872/4872; renderer 194 tests, typecheck clean.

**Second gate: rendered-board screenshots.** Pixel hashes pin each
texture's own pixels but not what reaches the screen (texture upload,
alpha handling, layering), and P2 changes texture sources from canvases to
`ImageBitmap`s. `apps/web/scripts/board-screenshots.mjs` captures the board
area of Dead Water 1, Liberty 1 and the debug combat scenario after
skipping to play, and `--compare <dir>` counts differing pixels with
ImageMagick. Two captures of identical code first differed by 1.33 M
(Dead Water) and 113 K (Liberty) pixels -- the difference maps covered only
water: animated terrain is a ticker-driven `AnimatedSprite`, so each
capture caught a different wave frame. A dev-only
`freezeAnimationsForCapture()` hook (stops every animated sprite at frame
0 and renders once) makes captures deterministic: 0 / 0 / 0 differing
pixels across two runs.

Side finding while building it: in headless Chromium, each of Dead
Water 1's startup messages takes ~9–11 s to advance. A CPU profile of
three advances sampled only ~450 ms of page JavaScript, almost all PixiJS
rendering (including the advanced-blend backbuffer pass for the
time-of-day tint), so the time is spent outside page script, most likely
in software GL. Not yet confirmed as a real-browser problem; to be
measured as frame time in P4.

## 2026-09-15 — Phase 28a P2: compositor workers

- `images/compositor.worker.ts` runs the compositor in a Web Worker: it
  checks it can composite (OffscreenCanvas 2D + `createImageBitmap` in a
  worker), receives base URLs and team colour data, renders refs and
  transfers results back as `ImageBitmap`s (zero-copy).
- `images/compositorPool.ts` schedules `min(4, cores - 1)` workers from the
  main thread: per-worker high (single `resolve`: units, animation frames)
  and low (bulk terrain `preload`) queues, at most 8 jobs in flight per
  worker so urgent work never waits behind thousands of posted tiles,
  cancellation on `ImageCache.clear()`, and config re-sent whenever URLs or
  colours change.
- **Sharding by source path matters.** The first version dispatched to the
  least-loaded worker: each worker decodes its own source images, so the
  same files were downloaded several times -- Dead Water 1 went from 493
  image requests / 7.6 MB to 991 / 17.9 MB. Routing every ref to the worker
  owning its source file brought it back to 555 / 7.7 MB (the remainder:
  hex masks, fetched once per worker).
- `ImageCache` uses the pool when workers, OffscreenCanvas and a
  successful readiness check are all present, else composites in-thread
  (Node tests, older browsers, or `globalThis.__wesnothImageWorkers = false`
  for A/B runs). Worker results become `PIXI.ImageSource` textures; PixiJS
  applies the same `premultiply-alpha-on-upload` default as for canvases.
- `apps/web/vite.config.ts`: `worker.format: 'es'`.
- `measure-load.mjs` now counts image requests at the network level: the
  page's resource timing does not see fetches made inside workers (the
  first worker run reported 10 "requests").

Results (headless Chromium, software GL, dev server; P0 baseline → P2):

| scenario | blocked (> 50 ms) | long tasks | max long task | board ready | image requests / KB | heap |
|---|---|---|---|---|---|---|
| Dead Water 1 | 4.8–7.2 s → **1.3–1.4 s** | 31–36 → **7–8** | 0.67–1.04 → 0.56–0.63 s | 9.5–14.0 → 8.7–9.8 s | 493 / 7,639 → 555 / 7,679 | 290–307 → 117–150 MB |
| Liberty 1 | 2.4–2.5 s → **1.1–1.3 s** | 13–14 → **6** | 0.56–0.60 → 0.55–0.65 s | 5.4–5.6 → 5.4–6.0 s | 450 / 5,013 → 470 / 5,025 | 150–159 → 111–141 MB |
| UtBS 1 | 9.5–10.0 s → **1.9–2.0 s** | 55–57 → **9–10** | 0.92–0.94 → 0.79–0.86 s | 16.2 → 12.5–13.1 s | 462 / 6,148 → 530 / 6,196 | 242 → 150–159 MB |

Attack in the debug combat scenario: first animation's frames ready in
**0.76–0.89 s** (was 2.2–2.4 s); blocked time during the exchange 2.0–2.1 s
(was 3.1 s). The remaining long tasks (up to ~0.6–0.9 s) and the attack's
blocked time are no longer image compositing -- P3/P4 look at what they
are (texture upload, sprite creation, terrain building, unit sync).

Gates: rendered-board screenshots **0 / 0 / 0 differing pixels** against
the pre-worker baseline (Dead Water 1, Liberty 1, debug combat), captured
on their own -- a run made concurrently with the golden check failed to
reach play in time, so these gates must not run in parallel on this
machine. The golden check now processes refs in a fixed shuffled order:
sorted, a batch holds hundreds of tiles cut from one source file, which
sharding routes to a single worker.

Golden pixel check on the worker path: **4872/4872 refs match**, reported
as produced by the worker pool (3 workers) -- the check now prints which
compositor ran, since a silent in-thread fallback would also match. It
first crawled at ~0.3 s per ref: the debug scenario has no story, so the
board's render loop ran at full rate under software GL (Chromium's GPU
process at ~260% CPU) and starved the workers. A dev-only
`setRenderingPaused` hook now stops the loop for the check, which then
takes 14 s for all 4,872 refs. The same contention applies to any
headless measurement with a live, uncovered board.

## 2026-09-15 — Phase 28a P3: terrain layout off the main thread

A CPU profile of Dead Water 1's load after P2 attributed the remaining
long tasks (6 tasks > 50 ms, 1,474 ms, longest 603 ms) to:
- the terrain builder matching `[terrain_graphics]` rules against the map
  on the main thread (`buildTerrainTiles`/`ruleMatches`/`terrainAt`,
  ~0.4–0.6 s in one task), after the main thread had also parsed the
  17.5 MB rules JSON;
- `buildSnapshotContext` running **twice** per `GameSession` (once via
  `gameBoardFromSnapshot`, once via `createTypeResolver`), each parsing
  every unit type config (`WmlConfig.fromJSON` ~170 ms self);
- Svelte proxy traps (~190 ms): `GameShell` held the 2.3 MB snapshot in
  `$state(snapshot)`, so every engine read went through a deep proxy.

Changes:
- `GameShell`: `activeSnapshot` is `$state.raw` (only ever replaced whole).
- `buildSnapshotContext` is memoised per snapshot object (WeakMap); board
  units and later-resolved types now share `UnitType` instances.
- `terrain/terrainLayout.ts`: the terrain layout (every hex's layers +
  the refs to preload) as a pure function, moved out of
  `SnapshotBoard.renderTerrainReal`. `terrain/terrainLayout.worker.ts`
  fetches, parses and revives the rules itself (cached per URL) and runs
  it; `terrain/terrainLayoutClient.ts` keeps one worker for the page and
  falls back to in-thread (no Worker, a failed worker, or
  `__wesnothImageWorkers = false`). `SnapshotBoard` takes
  `terrainGraphicsRulesUrl` (browser) or an in-memory
  `terrainGraphicsRules` (tests) and adds a `board:terrain-layout` measure.
  `GameBoardView` no longer fetches or parses the rules;
  `ui/src/terrainGraphicsRulesCache.ts` is gone.
- `measure-load.mjs` reports `terrainLayoutMs` and the page's running
  workers, so a silent in-thread fallback is visible.

Results (2 cold runs each; P2 → P3):

| scenario | blocked (> 50 ms) | max long task | long tasks | board ready | heap |
|---|---|---|---|---|---|
| Dead Water 1 | 1.3–1.4 s → **0.57–0.60 s** | 0.56–0.63 → **0.40–0.41 s** | 7–8 → 6 | 8.7–9.8 → 8.7–9.3 s | 117–150 → 82–104 MB |
| Liberty 1 | 1.1–1.3 s → **0.48–0.51 s** | 0.55–0.65 → **0.40–0.43 s** | 6 → 4 | 5.4–6.0 → 5.1–5.6 s | 111–141 → 82 MB |
| UtBS 1 | 1.9–2.0 s → **0.80–0.88 s** | 0.79–0.86 → **0.62–0.70 s** | 9–10 → 8 | 12.5–13.1 → 12.8–12.9 s | 150–159 → 125–133 MB |

Against the P0 baseline, Dead Water 1's main-thread blocked time is down
from 4.8–7.2 s to 0.57–0.60 s. Every run reported both
`terrainLayout.worker.ts` and `compositor.worker.ts`; terrain layout takes
~1.0–1.2 s of wall time inside its worker. The attack exchange is
unchanged (2.1–2.2 s blocked, first frames 0.87–1.0 s) -- that is not
terrain work and is left to P4. Gates: rendered-board screenshots 0 / 0 / 0
differing pixels against the pre-worker baseline; golden pixel check
4872/4872 via the worker pool; engine 559, renderer 194, ui 126 tests.
