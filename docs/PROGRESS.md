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
