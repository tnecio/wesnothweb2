# Phase 28 — CI/CD, Platform, Performance

Planned 2026-09-27, after Phase 23 and the bugs7 fixes. Revised the same day
after review. This plan covers:

- CI on GitHub Actions;
- a production build that serves the game data with long cache lifetimes;
- tag-based deployment to Cloudflare;
- the platform items from `docs/IMPLEMENTATION_PLAN.md`: performance budgets,
  cross-browser support, error reporting, offline play and licence
  compliance.

## User decisions (2026-09-27)

1. **Branch model: trunk-based on `main`.** Done. `main` was
   fast-forwarded to `phase-17-events` (`ddda3a1`) and pushed. Both the
   old local and remote `main` were ancestors, so no merge commit was needed.
2. **The repo goes public before the first deployment.** GitHub Actions
   minutes are then unmetered, and the GPL source offer is the repo link.
3. **No staging environment.** Production deploys from `v*` tags only.
4. **No oracle tests in CI.** The C++ image-oracle test stays skipped
   there and is run locally when compositing code changes.
5. **Ship (nearly) all of the game data.** Pruning to "what the four built
   campaigns reference" is dropped, because Phase 28c and later content need
   most of `data/`. Instead the data is made smaller (S4) and cached for a
   long time (S3).
6. **Heavy data is cached client-side with long lifetimes.** Anything
   larger than a few KB is served from a versioned URL as `immutable`. Only
   `index.html` and small manifests revalidate.

7. **Generated scenario files are built, not committed** (2026-09-28): once
   they are split into core, campaign and scenario files (`docs/ASSETS.md` §6),
   they are generated at build time and removed from git.
8. **WAV sound effects become OGG** (lossy, approved 2026-09-28). Music stays
   as upstream ships it unless measurements say otherwise.
9. **Error reports stay on the device** (copy/download only) for now.
10. **First release is `v0.1.0`.**
11. **Test deployment on `wesnoth.tnec.io`.** `tnec.io` is registered
    elsewhere, but its DNS is already on Cloudflare (nameservers
    `devin`/`maeve.ns.cloudflare.com`), which is what Workers and R2 custom
    domains need. The zone must be in the same Cloudflare account as the Worker
    and the bucket. Game data goes on a sibling host such as
    `wesnoth-data.tnec.io` rather than `data.wesnoth.tnec.io`, because
    Cloudflare's free certificate covers only one subdomain level
    (`*.tnec.io`).

Done 2026-09-28: the `gh` CLI is authenticated with a fine-grained token; the
stale remote branches are deleted (`phase-29-real-ai` and `plan-ui-reorg` are
also merged and left for a later decision).

## Context: measured before planning

| Fact | Consequence |
|---|---|
| No `.github/` and no lint config. Existing checks: `npm test`, `npm run typecheck` and `svelte-check` per workspace, plus 11 `*-playthrough.mjs` browser scripts, which exit non-zero on failure. | The CI calls the existing commands. Lint is new and kept small (S2). |
| Unit suites, run one after another on this VM (4 cores): engine 58 s (800 tests), renderer 11 s (263), ui 96 s (375), lua-bridge 5 s (38), oracle-tools 1 s. All pass, **but the ui run exits 1**: vitest reports an unhandled `Timeout calling "onTaskUpdate"` because `scripts/ai-benchmark.test.ts` blocks its worker for 93 s. | One job per package keeps unit CI at a few minutes of wall time. The exit code must be fixed first (S1). |
| The `wesnoth` submodule checkout is 2.8 GB. The build and tests need only `data/`, `images/` and `sounds/`. | CI checks the submodule out shallow and sparse, cached by submodule SHA. |
| `apps/web/public/game-images*` are **symlinks** into the submodule. The browser fetches from them, one file at a time, everything the atlases don't cover: music, sounds, portraits, story art and fallback images. Lua is read from disk at build time (`dataLua.ts`), not fetched. | The deployed game data must be an explicit, versioned copy (S3), not whatever the symlink points at. |
| **What `data/` holds** (595 MB, 22.7k files): see the table below. The media alone (png/webp/jpg/ogg/wav in `core/` and `campaigns/`) is 18.9k files and 536 MB. | Everything together is **over Cloudflare's 20k-files-per-deploy limit**, so the raw game data can't live in the Workers upload (S3 moves it to R2). |
| **Our generated atlases are 212 MB**, 928 files, of which about 180 MB are per-scenario terrain atlases. That is more than the whole source `core/images/terrain` (38 MB) they are cut from. The biggest is 9.3 MB (UtBS 4). Each scenario's atlas repeats the same common tiles. | Each new scenario re-downloads its common tiles: 44 atlases hold 13k image slots but only 1.7k distinct images. Separately, unit bundles are 3× their palette-PNG sources. See `docs/ASSETS.md` §4 (S4). |
| Snapshots are committed JSON, 155 MB; the largest file is 4.7 MB. **Liberty 1's snapshot compresses 3.55 MB → 0.26 MB with gzip -9.** | They must be served compressed. Pre-compressing with Brotli at build time beats relying on the edge (S3). |
| The router is client-side (`pushState`): `/play/<campaign>?scenario=…&save=…`. | Needs an SPA fallback, which Workers provides natively. |
| No `window.onerror`, `unhandledrejection` handler or `<svelte:boundary>` anywhere. | A runtime error leaves a frozen or blank screen with nothing to report (S6). |
| Snapshots, i18n catalogues, credits, tips and derived images are committed and can be regenerated. | CI can check they are in sync. |
| Headless Chromium without a GPU renders the board at about 1 fps (SwiftShader). GitHub's hosted runners have no GPU either. | Frame rate and animation timing cannot be CI gates. Deterministic metrics can. |
| `packages/lua-bridge` patches 8 upstream Lua files for Fengari, and a test lists them. | The "upstream data unmodified" guard (S9) uses that list as its only allowed exceptions. |

**Where the 595 MB of `data/` goes:**

| What | Size | Files | Note |
|---|---|---|---|
| Music (`*.ogg` under `music/`) | 229 MB | 52 | Vorbis at about 160 kbps, stereo, 44.1 kHz. `core/music` alone is 169 MB in 43 tracks. |
| WebP art | 181 MB | 922 | Portraits 34 MB; story and campaign art (`The_Rise_Of_Wesnoth` alone 29 MB); maps 10 MB |
| PNG | 100 MB | 17,969 | Terrain 38 MB (5.6k files), units 9 MB (7.1k files), campaign-specific images |
| WAV | 19 MB | 73 | Uncompressed sound effects |
| `.cfg` / `.map` / `.lua` / `.py` / other | ~66 MB | ~3.7k | Not fetched at runtime (baked into snapshots or read at build time) |

## Deployment: Cloudflare Workers static assets, plus R2 for game data

Workers static assets is Cloudflare's current recommendation for new
projects, and Pages has the same limits. Its free tier, checked on
Cloudflare's docs on 2026-09-27:

| Limit (free) | Value | Problem for us? |
|---|---|---|
| Files per deployed version | **20,000** | **Yes.** The game media alone is 18.9k files; with the app, atlases, snapshots and i18n it goes over. That is why raw game data goes to R2 (below). With game data out, the Workers upload is about 1.5k files. |
| Size per file | **25 MiB** | No. The largest are an 11 MB music track and a 9 MB atlas; after S4 both shrink. A guard in the build keeps it that way. |
| Requests to static assets | **Free and unlimited**; they don't count against the 100k/day Worker request limit | No, as long as we deploy **no Worker script** (or never set `run_worker_first`). Requests that run a script count against 100k/day and get a 429 once over. |
| `_headers` | 100 rules, 2,000 characters per line | No. About 10 rules are needed. |
| Default caching | `public, max-age=0, must-revalidate` + ETag (every use revalidates) | That's why every heavy file gets a versioned path and an `immutable` rule. |
| Compression | Negotiates Brotli/gzip/zstd for text types at the edge | The edge compresses at a moderate level. We ship pre-compressed `.br` snapshots to get the 14× ratio, and check the served `Content-Encoding` after deploy (S5). |
| SPA fallback | `not_found_handling = "single-page-application"`: unknown paths get `index.html` with 200 | Also means a missing asset under an HTML `Accept` returns HTML. The smoke test checks asset responses by content type, not only status. |
| Builds | Pages: 500 builds/month, 20 min timeout | Irrelevant: we build in GitHub Actions and upload with `wrangler`. |
| Content terms | Cloudflare's service-specific CDN terms reserve the right to limit sites that use the CDN "without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files". The Developer Platform (Workers, R2) is named as the kind of service meant for such content. | **The one real risk.** Serving media from Workers assets and R2 is the sanctioned route, rather than proxying another origin through the CDN, but the terms don't spell out the free tier. Mitigation: at hobby traffic it is unlikely to matter. If it ever does, Workers Paid ($5/month) removes the ambiguity. |

**R2 for game data** (free tier: 10 GB storage, 1M writes and 10M reads a
month, **free egress**). We upload the media under a versioned prefix
(`/data/<submodule-sha>/…`) to a public bucket on a custom domain, with
`Cache-Control: public, max-age=31536000, immutable` set on each object, so
Cloudflare's cache serves most requests. 10M reads a month is far more than
we'll need, since cached hits don't count as reads. A new submodule SHA
uploads under a new prefix; old prefixes are pruned after a release.

Alternatives considered: GitHub Pages (no custom headers, 1 GB site limit),
Netlify and Vercel (bandwidth metered on their free tiers), and our GCP VM
(egress about $0.12/GB, plus we'd run TLS and uptime ourselves). Cloudflare is
the only free option that meets the caching needs without a traffic bill.

## Stages

Each stage is its own PR, ends green, and gets a dated entry in
`docs/PROGRESS.md`.

### S0 — Branch reconciliation: done 2026-09-27

`main` is at `ddda3a1` on GitHub. Branch protection on `main` (S1's checks
required, no force push) is enabled once S1 has passed. The stale remote
branches (`phase-11-fog` … `phase-17-events`, `perf-image-pipeline`,
`fix-two-brothers-bugs`) are all ancestors of `main` and get deleted after
you confirm.

### S1 — Unit CI (`.github/workflows/ci.yml`)

**Done 2026-09-28** (see PROGRESS). CI runs on every push, since the token can't open PRs. A
`scenarios` job builds the generated snapshots for the test jobs. The `generated-in-sync` job is dropped for
scenarios, which are no longer committed; for the remaining committed generated files it moves to S3.

Runs on pushes to `main` and on PRs. Superseded runs are cancelled.

- **Setup** (composite action): checkout, then a shallow, sparse submodule
  checkout of `data/ images/ sounds/`, cached by SHA. Node from a new
  `.nvmrc` (20). `npm ci` with the npm cache.
- **Fix first:** make the ui suite exit 0. `ai-benchmark.test.ts` moves to
  its own vitest project (`npm run test:slow`, its own CI job), or the
  benchmark yields between turns.
- **Jobs:** `typecheck` (includes `svelte-check`); `test` as one job per
  package, with JUnit output in the check summary; `generated-in-sync`
  (regenerate snapshots, i18n, credits and tips, then
  `git diff --exit-code`).
- **Checkable:** a deliberately failing test turns the PR red, and the check
  names the package and the test.

### S2 — Lint (small)

- ESLint flat config (`typescript-eslint`, `eslint-plugin-svelte`) with
  correctness rules only, and no formatter.
- A restricted-import rule enforces the Phase 28a risk: the compositor and
  worker modules must not import `pixi.js`.
- **Checkable:** adding a `pixi.js` import to `compositor.ts` fails the
  `lint` job.

### S3 — Versioned, long-lived asset delivery

The caching contract: **every file larger than a few KB is requested from a
URL that changes whenever its content changes, and is served
`public, max-age=31536000, immutable`.** Only `index.html` and small
manifests are `no-cache` with an ETag. After the first visit, a player
downloads a file again only when that file itself has changed.

| Asset | Today | After S3 |
|---|---|---|
| JS/CSS (Vite) | hashed file names | unchanged, `immutable` |
| Atlases | hashed PNGs, fixed-name JSON manifests | Manifests hashed as well, referenced from one small root manifest (`assets.<hash>.json`, the only `no-cache` data file besides `index.html`) |
| Game media (`game-images*`, music, sounds) | symlinks, unversioned, `no-cache` | Uploaded to R2 under `/data/<submodule-sha>/`, `immutable`. The app gets the prefix from the root manifest. |
| Scenario snapshots, i18n, `terrain-graphics-rules.json`, story assets | fixed names, fetched uncompressed | Content-hashed names via the root manifest, pre-compressed `.br`, `immutable` |

- New `apps/web/scripts/stage-assets.mjs`, run after `vite build`:
  - hashes and renames the data files;
  - writes the root manifest;
  - emits `_headers` and the Workers `wrangler.jsonc` (assets directory,
    SPA fallback, no script);
  - stages the media for R2: every png/webp/jpg/ogg/wav under `core/` and
    `campaigns/`, **minus** data that is never fetched (`.cfg`, `.map`,
    `.lua`, `.py`, `data/test`, `tools`, `schema`).
- The dev server keeps working unchanged: the root manifest falls back to
  the current paths when absent.
- A report in the job summary lists total bytes, file count and the largest
  file for each target. It fails if the Workers upload exceeds 18k files or
  any file exceeds 24 MiB.
- **Checkable:**
  - a warm reload of Dead Water 1 in Playwright makes **zero** requests
    besides `index.html` and the root manifest (both 304);
  - changing one snapshot changes only that snapshot's URL and the root
    manifest.

### S4 — Shrink what players download

`docs/ASSETS.md` has the full measured walkthrough and the proposed
core / campaign / scenario split. It supersedes the item list below where
they differ: unit bundles and snapshots dominate, not music.

These are measured one by one (bytes per scenario load, and total); each is
kept only if it is lossless or you sign off on it.

1. **Terrain atlases (lossless, largest win per scenario).**
   - Replace per-scenario terrain atlases with shared ones: common tiles
     (grass, hills, water, castles…) in bundles cached across all scenarios,
     plus a small per-scenario remainder.
   - Recompress the PNGs with `oxipng`, which is lossless.
   - The Phase 28a golden hashes must still match exactly.
   - Target: a second scenario downloads under 20% of the terrain bytes a
     first scenario does.
2. **PNG optimisation of staged media (lossless).** Run `oxipng` over the
   staged PNGs, verified by comparing decoded RGBA hashes. The gain is
   probably modest, since upstream already optimises many files; it is
   measured first.
3. **WAV → Ogg/Opus for sound effects (lossy, needs your sign-off):**
   19 MB → about 2 MB.
4. **Music (lossy, needs your sign-off).** 229 MB of Vorbis at 160 kbps.
   Opus at 96 kbps is generally considered transparent for music at about
   60% of the size. It needs a fallback for Safari versions without
   Opus-in-Ogg, for example Vorbis at a lower quality, or AAC.
   - Music is streamed per track and cached `immutable`, so this saves
     bytes on the first play of each track only.
   - **Recommendation:** leave music as upstream ships it unless a
     measurement shows it dominates first-session downloads.
5. **Portraits and story art** are already WebP. Leave them.

### S5 — Browser smoke test and deployment

- **Smoke test** (`apps/web/scripts/smoke-playthrough.mjs`, reusing
  `lib/browserFlows.mjs`, in `ci.yml` on the **production build** via
  `vite preview`):
  - main menu → Liberty → skip story → one move, one confirmed attack →
    End Turn (answering the confirm) → AI turn;
  - quicksave → reload → load;
  - a hard refresh on `/play/Liberty?scenario=01_The_Raid`.
  
  It fails on any `pageerror`, `console.error`, failed request, or an asset
  response with the wrong content type. On failure it uploads a Playwright
  trace, screenshots and the console log.
- **Deploy** (`.github/workflows/deploy.yml`) runs on `v*` tags only:
  - it builds and smoke-tests the tagged commit, uploads the new R2 prefix
    (skipped if that submodule SHA is already there), then deploys the
    Workers assets with `cloudflare/wrangler-action` (API token as a repo
    secret);
  - the build embeds the tag and SHA, shown on the title screen and in
    error reports.
- **Post-deploy check:** the smoke test runs against the production URL,
  and `curl -I` confirms three things: an atlas and an R2 music file are
  `immutable`, `index.html` is `no-cache`, and a snapshot is served with
  Brotli encoding.
- **Rollback:** `wrangler rollback`, or re-run the workflow on the previous
  tag. Old R2 prefixes stay until the next release, so a rollback still
  finds its data.
- Per-PR preview deployments are free and could be added later; they are
  left out for now, per decision 3.
- **Checkable:** pushing tag `v0.1.0` deploys, and the post-deploy check
  passes. A tag on a commit that breaks the smoke test does not deploy.

### S6 — Error reporting

- Global `error` and `unhandledrejection` handlers, and
  `<svelte:boundary>` around `GameShell` and the menu.
- A recoverable error screen: back to menu, reload the last autosave, and
  "Copy report" / "Download report". The report holds:
  - version and SHA, browser, campaign / scenario / turn;
  - the stack;
  - the last N WML/Lua log lines;
  - optionally, if the player ticks it, the current save as JSON.
- Errors in the AI, Lua or event paths are caught per turn where possible:
  the turn ends with a visible warning instead of freezing.
- **Nothing is sent automatically** (see the explanation in the reply this
  plan came with; an opt-in remote endpoint is a later, separate decision).
- **Checkable:** a debug flag that throws inside an event handler shows the
  error screen, the copied report contains the stack and version, and
  "reload autosave" resumes play.

### S7 — Performance budgets and the nightly run

- **Per PR** (Chromium, production build): `measure-load.mjs` on Dead Water 1
  and Liberty 1. Gates on metrics that are stable on shared runners:
  - request count and bytes transferred;
  - JS bundle size;
  - heap after load;
  - main-thread blocked time, with 2× slack.
  
  The numbers go into the job summary next to `main`'s last run.
- **AI benchmark:** the Dead Water 12 AI-vs-AI benchmark (the bugs7
  speed-up) becomes `apps/web/scripts/bench-ai.mjs`, gated at 2× the
  runner's baseline.
- **Nightly** (cron plus manual dispatch): every `*-playthrough.mjs`,
  `check:image-golden`, the cross-browser matrix (S8) and `test:slow`.
  Failures open or update a GitHub issue.
- Frame rate stays a manual pre-release check on real devices, listed in
  `docs/RELEASE_CHECKLIST.md`. Budgets are recorded in
  `docs/TESTING_STRATEGY.md`.
- **Checkable:** a PR that disables an atlas, or adds a 1 MB dependency,
  fails the budget step with a before/after table.

### S8 — Cross-browser and offline

- **Nightly smoke matrix:**
  - Chromium, Firefox and WebKit;
  - Pixel 7 and iPhone emulation running the `mobile-playthrough.mjs`
    flow.
  
  Known gaps go in a compatibility table.
- **Deep links:** `?save=` and `&replay=1` survive a hard refresh.
- **Service worker** (handwritten, small):
  - precache the app shell;
  - cache-first for everything under the immutable rule, which after S3
    is nearly everything;
  - versioned by SHA, old caches purged on activate;
  - an "update available" prompt applied only on the menu, never under a
    running game.
  
  Scope: a scenario you have opened once plays again offline.
- **Checkable:** after playing Liberty 1 once, it reloads and plays with the
  network disabled.

### S9 — Licence compliance and upstream-fidelity guard

- **Licences:** ship `COPYING` (GPL-2), Wesnoth's `copyrights.csv` and the
  data licence notes under `/licenses/`, linked from the credits screen. Add
  a "Source code" link to the public repo on the title screen.
- **Unmodified media:** `stage-assets` checks that every staged media file
  matches the pinned submodule commit. The only exceptions are the S4
  transformations, which are recorded per file with the source hash.
- **Unmodified upstream `.cfg`:** every campaign `.cfg` a snapshot is built
  from is byte-identical to the submodule. The only allowed deviations are
  the 8 Fengari Lua patches.
- **Checkable:** editing a campaign `.cfg` in `wesnoth/` locally fails the
  guard, naming the file.

## Milestone

- Pushing to `main` or opening a PR runs every package suite plus the
  browser smoke test on the production build.
- A `v*` tag deploys to production and passes the post-deploy check.
- A deliberately broken commit fails CI, and a broken tag does not deploy.
- A warm reload makes no requests beyond `index.html` and the root manifest.
- The S6–S9 checkables pass.

## Order

S1 → S3 → S5 reach the milestone. Then S4 (shrinking), S2, S6, S7, S8, S9.
The repo goes public before S5's first tag.

## Risks

| Risk | Mitigation |
|---|---|
| Cloudflare content terms on media-heavy sites | Media served from R2 and Workers assets, the Developer Platform route the terms point to; Workers Paid ($5/month) if Cloudflare ever objects. The hosting setup is contained in one workflow file, one `_headers` file and one `wrangler.jsonc`. |
| The 20k-file limit is hit again as campaigns are added (Phase 28c) | Game media is in R2, which has no file limit; the Workers upload holds only the app, atlases and hashed data (~1.5k files). A guard fails the build above 18k. |
| A player downloads a whole new data prefix when the submodule is bumped | Submodule bumps are rare. If they become frequent, switch from a per-SHA prefix to per-file content hashes (the root manifest can map paths → hashes). |
| Pre-compressed `.br` served with the wrong headers | The post-deploy `curl -I` check. The fallback is to let the edge compress (smaller win, still compressed). |
| Headless timing flakiness at 1 fps | Smoke and budget steps wait on state, never on durations. Only deterministic metrics gate. One retry, with the trace uploaded. |
| Service worker serving a stale build mid-game | Versioned caches, and updates only at the menu or on reload. |
