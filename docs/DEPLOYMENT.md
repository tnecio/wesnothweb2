# CI, releases and deployment

How the game is checked, built and deployed. For why it is built this way, see `PHASE28_PLAN.md` (design
and decisions), `ASSETS.md` (how the game data is split and cached) and the Phase 28 entries in
`PROGRESS.md`.

## At a glance

| What | Where |
|---|---|
| Source | https://github.com/tnecio/wesnothweb2 (public); `main` is protected, work lands through PRs |
| CI | `.github/workflows/ci.yml`, on every push to every branch |
| Deploy | `.github/workflows/deploy.yml`, on a `v*` tag (or started by hand) |
| The game | https://wesnoth.tnec.io (also https://wesnothweb2.tomasz-necio.workers.dev): Cloudflare Workers static assets, Worker `wesnothweb2` |
| Game media | https://wesnoth-data.tnec.io: R2 bucket `wesnothweb2-data` |
| Node | the version in `.nvmrc` (24), for CI, the deploy and local work |

There is no staging environment: a tag deploys straight to production.

## Making a change

1. Branch from `main`, commit, push. CI runs on the push.
2. Open a PR into `main`. Branch protection requires CI to pass before it can merge.
3. Merging does **not** deploy. Tag a release when you want the change live (next section).

## CI (`ci.yml`)

| Job | What it does |
|---|---|
| `lint` | `npm run lint`: ESLint, correctness rules only (`eslint.config.js`) |
| `typecheck` | `npm run typecheck --workspaces` (`tsc` and `svelte-check`) |
| `scenarios` | Checks the upstream content is unmodified (`check-upstream-unmodified.mjs`), then builds the scenario snapshots, cached by a hash of their inputs, and hands them to the jobs below as an artifact |
| `test (<package>)` | `vitest` for engine, renderer, ui, lua-bridge and oracle-tools, one job each |
| `generated-in-sync` | Regenerates the committed story assets and title image list, and fails if the images they reference differ from what is committed |

**Setup** (`.github/actions/setup`) installs Node and runs `npm ci`. It also makes a shallow, sparse
checkout of the `wesnoth` submodule, only what the build reads (`data/`, `images/`, `sounds/`, `po/wesnoth/`,
`.pot` files, `COPYING`, `copyrights.csv`), cached by the submodule commit. If you change the sparse
paths, bump the cache key (`wesnoth-sparse-vN`).

**Duration:** about 2–3 minutes when the scenario snapshots are cached, 6–7 when they must be rebuilt (any
change to `packages/engine/src`, the snapshot scripts, the campaign or scenario lists, or the submodule).

Not in CI (deliberately, or not yet):
- the browser playthrough scripts in `apps/web/scripts/*-playthrough.mjs` (run them locally against the dev
  server);
- the C++ image oracle test (skipped without its binary);
- performance budgets, cross-browser checks and a browser smoke test, which are Phase 28d.

## Releasing

```sh
git fetch origin
git tag -a v0.2.0 origin/main -m "v0.2.0: <what changed>"
git push origin v0.2.0
```

The tag starts `deploy.yml`, which takes about 3 minutes, or about 10 when game media must be uploaded
(see below). Use semantic-ish versions; the tag is what players see on the title screen
("Version 1.19.21 · web v0.2.0") and in error reports. A deploy started by hand (Actions → Deploy → Run
workflow) deploys the chosen branch, labelled `<branch>-run<N>`. Use that for testing, not releases.

## What a deploy does (`deploy.yml`)

1. **Scenario snapshots:** restored from the CI cache, or built.
2. **Game media to R2** (`apps/web/scripts/upload-game-data.mjs`):
   - It uploads every image, music and sound file of the submodule's `data/core`, `data/campaigns`,
     `images/` and `sounds/`, about 20.6k files and 516 MiB.
   - They go under the prefix `<submodule commit>-m<MEDIA_VERSION>/`.
   - WAVs are converted to Ogg Vorbis (`<name>.wav.ogg`, needs `ffmpeg`, which the job installs).
   - Every object is `Cache-Control: immutable`.
   - When `<prefix>/.complete` exists the step does nothing, so this only costs time after a submodule
     bump or a `MEDIA_VERSION` change. It uses R2's S3 API (about 7 minutes for a full upload) and skips
     objects already there if interrupted.
3. **Bucket CORS** (`apps/web/r2-cors.json`): GET/HEAD from any origin. The app reads media
   cross-origin, and Web Audio plays silence without it.
4. **Build:**
   - `npm run build --workspace=apps/web` runs the scenario and atlas builds, then Vite, with
     `VITE_GAME_DATA_URL=https://wesnoth-data.tnec.io/<prefix>` and the version and commit.
   - Then `node apps/web/scripts/stage-dist.mjs` copies the app's own data into `dist/`. Each file goes to
     a content-hashed path `h/<hash>/<path>`, listed in a hashed `data-manifest.json` that `index.html`
     names.
   - It also writes `_headers` and fails if the upload would break Workers' limits (18k files, 24 MiB per
     file, kept with a margin).
5. **`wrangler deploy`** uploads `apps/web/dist` as static assets (`apps/web/wrangler.jsonc`). There is
   deliberately no Worker script, so requests are free and unmetered. Client-side routes fall back to
   `index.html`.
6. **Check:** the site, a deep link, `_core.json` and a bucket image answer 200 (retried for up to 3
   minutes while a new address comes up), plus the bucket's Cache-Control and CORS headers.

## Caching

- **Cached for a year (`immutable`):** everything except `index.html`. That covers Vite's `/assets/*`,
  the app's data under `/h/<hash>/…` and every R2 object. A file's URL changes exactly when its content
  does, so nothing stale can be served.
- **`index.html`:** revalidates on every visit (a 304 when unchanged).
- **Result:** a returning player downloads nothing else unless it changed.

Two rules if you touch this:
- Headers from every matching `_headers` rule are merged, so each Cache-Control rule must own a separate
  path prefix.
- Never overwrite an R2 object under an existing prefix. Change `MEDIA_VERSION` (or the submodule
  commit) so a new prefix is uploaded.

## Secrets and accounts

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Used for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `wrangler deploy` and `wrangler r2 bucket cors set` (Workers Scripts: Edit, Workers R2 Storage: Edit) |
| `CLOUDFLARE_ACCOUNT_ID` | the same, and the R2 S3 endpoint |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the media upload (an R2 API token with Object Read & Write on `wesnothweb2-data`) |

Cloudflare side, set up once by hand:
- the `tnec.io` zone is in the same account;
- the Worker has the custom domain `wesnoth.tnec.io`;
- the bucket has the custom domain `wesnoth-data.tnec.io`, a sibling name because the free certificate
  covers only one subdomain level.

Cloudflare creates the DNS records for both custom domains.

## Rolling back

- Fastest: Cloudflare dashboard → Workers & Pages → `wesnothweb2` → Deployments → roll back to an earlier
  version (or `npx wrangler rollback` with the token).
- Or re-run `deploy.yml` on an earlier tag.

Old R2 prefixes are never deleted, so an older build still finds its media.

## Working locally

| Task | Command |
|---|---|
| Dev server | `npm run dev --workspace=apps/web` (port 5173; builds scenario snapshots and atlases first when their inputs changed) |
| Rebuild scenario snapshots | `npx tsx apps/web/scripts/rebuild-snapshots.mjs [id ...]` (not in git; `apps/web/scenario-list.json` says which scenarios exist) |
| Lint / typecheck / tests | `npm run lint`, `npm run typecheck --workspaces`, `npm test --workspaces` |
| Production build | `VITE_GAME_DATA_URL=https://wesnoth-data.tnec.io/<prefix> npm run build --workspace=apps/web && node apps/web/scripts/stage-dist.mjs` |
| Serve that build like production | `cd apps/web && npx wrangler dev` (headers, SPA fallback, no upload) |
| See what a media upload would do | `node apps/web/scripts/upload-game-data.mjs --dry-run` |
| Check upstream content is unmodified | `node --import tsx apps/web/scripts/check-upstream-unmodified.mjs` |

The dev server serves game media from `public/game-images*`, symlinks into the submodule, so development
needs no bucket. If a browser check doesn't reflect an edit, confirm Vite is serving it
(`curl -s localhost:5173/@fs<absolute path> | grep …`) and restart Vite if not.

## When something fails

| Symptom | Likely cause |
|---|---|
| `scenarios` fails in `check-upstream-unmodified` | The submodule was moved or edited, or a Lua file was added to `vendor-lua-patches/`: upstream content must stay as upstream ships it |
| `generated-in-sync` fails | A change altered which images the story assets reference; run `node --import tsx apps/web/scripts/build-story-assets.mjs` and commit the result if it is intended |
| i18n audit test fails after a UI change | New or removed port strings: run `node --import tsx apps/web/scripts/extract-wesnothweb-pot.mjs` and commit `wesnothweb.pot` |
| The deploy's check step fails right after a first deploy | A new `workers.dev` address can take a minute; the step retries for 3 |
| Music silent or images missing only in production | A new way of loading media cross-origin without CORS mode (`crossOrigin = 'anonymous'` on `<audio>`/`<img>` that feed Web Audio or a canvas) |
| `stage-dist.mjs` fails on limits | Over 18k files or a file over 24 MiB in `dist/`; large media belongs in R2, not in `public/` |
