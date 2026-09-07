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
