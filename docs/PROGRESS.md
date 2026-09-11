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
