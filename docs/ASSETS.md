# Game assets: sources, build, runtime retrieval, and how to split them

Written 2026-09-27 as input to Phase 28 (S3/S4 of `docs/PHASE28_PLAN.md`). All numbers were measured on
this checkout:

- file sizes on disk;
- JSON analysis of every snapshot and atlas manifest;
- a Playwright trace of a cold session against the dev server: the title
  screen, Liberty 1, Liberty 2.

The dev server doesn't compress, so the trace shows raw bytes; compressed
sizes are given where they matter.

## 1. Where everything comes from

Upstream Wesnoth is the `wesnoth` git submodule, a fork pinned at `357eb9f`
on the `wesnothweb2-oracle` branch. The whole checkout is 2.8 GB; we read
from three directories.

| Upstream dir | Size | What we use it for |
|---|---|---|
| `data/` | 595 MB, 22.7k files | Everything: WML (`.cfg`), maps, Lua, and all game media (images, music, sounds). |
| `images/` | 11 MB | Engine UI chrome: buttons, dialog frames, cursors, `misc/ellipse-*`, icons. |
| `sounds/` | 1.2 MB | Engine UI sounds: `button.wav`, `bell.wav`, `timer.wav`, … |

What `data/` is made of:

| Kind | Size | Files | Notes |
|---|---|---|---|
| Music (`.ogg` under `music/`) | 229 MB | 52 | Vorbis at about 160 kbps. Core has 43 tracks (169 MB); a few campaigns bring their own. |
| WebP art | 181 MB | 922 | Portraits 34 MB. Story and campaign art (TRoW alone 29 MB, HttT 11 MB). Title screen and map backgrounds 10 MB (`maps/background.webp` is 4096×2160, 4.5 MB). |
| PNG | 100 MB | 17,969 | Terrain 38 MB (5.6k files), unit sprites 9 MB (7.1k files, mostly 8-bit palette PNGs), halos, items, campaign images. |
| WAV | 19 MB | 73 | Mostly two campaigns (TDG 8.9 MB, HttT 5.8 MB); core has 40 WAVs (2.5 MB) next to 216 OGGs. |
| `.cfg`, `.map`, `.lua`, `.py`, other | ~66 MB | ~3.7k | Never fetched by the browser. WML is baked into snapshots at build time. |

## 2. What we build from it (build time, `apps/web/scripts/`)

The browser never parses upstream WML. Build scripts run the real engine code
(preprocessor, parser, terrain builder) in Node and write JSON and images into
`apps/web/public/`:

| Output | Script | In git? | Size | Contents |
|---|---|---|---|---|
| `scenarios/<campaign>/<id>.json` | `build-scenario-snapshot.mjs` (+ `rebuild-snapshots.mjs`) | yes | **155 MB**, 44 base files + 75 difficulty overlays | One scenario's complete starting state: map, sides, scenario WML (for events), **plus the entire unit-type, movement-type, terrain-type, ability and weapon-special databases** (see §4.1). |
| `scenarios/<campaign>/<id>@<DIFF>.json` | same | yes | 4.8 MB total | Difficulty overlays: only the keys that differ from the default difficulty. Already a good design. |
| `terrain-graphics-rules.json` | `build-terrain-graphics-rules.mjs` | yes | 18 MB (0.36 MB gzip, 0.23 MB Brotli) | The ~10k parsed `[terrain_graphics]` rules. One file shared by every scenario. |
| `atlases/<campaign>/<id>/terrain-*.png` + `terrain.json` | `build-image-atlases.mjs` (runs on `predev`/`prebuild`) | no (generated) | **~186 MB**, 44 scenarios | Every source image the terrain builder needs for that scenario's map, packed into one or two ≤4096² RGBA PNGs. |
| `atlases/units/<type>-*.png` + `<type>.json` | same | no | 27.6 MB, 420 types | One bundle per unit type: its base sprite and every animation frame (still magenta; team colour is applied in the browser). |
| `story/<campaign>/<id>.json` | `build-story-assets.mjs` | yes | 1.6 MB, 31 files | The scenario's `[story]` WML, plus a table of every story image and portrait a `[message]` in it can show. |
| `derived-images/**.w<width>.webp` | same | yes | 12 MB, 158 files | Smaller WebP q80 copies of story art and portraits, so a phone isn't sent a 4k image. |
| `i18n/<locale>/<domain>.json` | `build-translations.mjs` | yes | 14 MB | 9 languages; one file per language × text domain, fetched only for domains in use. English downloads nothing. |
| `campaigns.json`, `credits.json`, `tips.json`, `team-colors.json` | `build-campaigns.mjs`, `build-team-colors.mjs` | yes | <100 KB | Menu data and colour ranges. |
| `packages/ui/src/audioFiles.json`, `campaignImages.json` | `build-audio-files.mjs`, `build-campaign-images.mjs` | yes (bundled into JS) | 22 KB | Lists of which music, sound and campaign image files exist, so paths resolve like upstream's binary-path search without probing the server. |
| JS/CSS/fonts | `vite build` | no | JS 1.34 MB (421 KB gzip) in one main chunk; Lato/WesScript/DejaVu WOFF2 ~0.8 MB (DejaVu only fetched when a glyph needs it) | The app. |

The raw game media is **not copied**. `public/game-images`,
`game-images-engine` and `game-sounds-engine` are symlinks into the
submodule's `data/`, `images/` and `sounds/`.

## 3. What the browser fetches, and when

The code paths:

- **Snapshot:** `ui/scenarioFetch.ts`. The base file, plus an overlay when
  the difficulty isn't the default.
- **Terrain rules:** `renderer/terrain/terrainLayout.worker.ts` fetches
  `/terrain-graphics-rules.json` for every board.
- **Images:** everything goes through `renderer/images/compositor.ts`
  `loadBitmap(path)`:
  1. look the path up in the loaded atlas manifests (the scenario's terrain
     manifest plus the manifests of unit types registered for the board);
  2. on a hit, crop it out of the bundle;
  3. otherwise `fetch('/game-images/<rooted path>')` for that single file.
  
  The worker pool shares one download per bundle.
- **Story and portraits:** `ui/story/storyImages.ts` picks the smallest
  `derived-images` variant that fits, falling back to the original.
- **Audio:** `ui/audio/audioPaths.ts` maps a name to
  `/game-images/{campaigns/<c>|core}/{music|sounds}/<file>` or
  `/game-sounds-engine/<file>`. Music streams (HTTP 206) and the next track
  is prefetched; sound effects are fetched whole and decoded with Web Audio.
  A few status sounds are preloaded when a board opens.
- **Text:** `ui/i18n/locale.ts` fetches `i18n/<locale>/<domain>.json` per
  domain as a scenario opens.

**Measured cold session** (bytes as sent by the dev server, i.e.
uncompressed; code modules excluded):

| Step | Requests | Bytes | Biggest items |
|---|---|---|---|
| Title screen | 9 | **6.3 MB** | `maps/background.webp` **4.5 MB** (4096×2160, stretched behind the menu), `maps/titlescreen.webp` 1.6 MB |
| Liberty 1: data | 5 | 21.6 MB raw (~0.4 MB Brotli) | `terrain-graphics-rules.json` 18 MB, snapshot 3.55 MB |
| Liberty 1: terrain | 2 + 38 | 5.3 MB + 0.36 MB | The atlas, plus **38 terrain images fetched one by one**: the `symbol_image` tiles the minimap draws, which the atlas doesn't include |
| Liberty 1: units | 6 | 0.2 MB | One bundle per unit type on the board |
| Liberty 1: UI chrome | ~30 | 0.05 MB | Buttons, icons, ellipses, flags, items: ~30 files of 0.2–5 KB each |
| Liberty 1: audio | 11 | 1.4 MB | A music track (streamed), preloaded status sounds as **WAV** (`slowed.wav` 151 KB, `bell.wav` 181 KB, `heal.wav` 69 KB) |
| Liberty 2 (new page load, same browser profile) | ~95 | 28 MB raw | **The same 18 MB rules and a 3.5 MB snapshot again**, a new 4.7 MB atlas with mostly the same tiles, the same 36 minimap tiles fetched again. The dev server's `no-cache` revalidation returned full 200s here. |

In production, correct caching would stop the rules file and the minimap
tiles from being downloaded twice. It wouldn't help the snapshot or the atlas: those have
*different* URLs per scenario while holding mostly the *same* content.

## 4. Redundancies and inefficiencies, largest first

### 4.1 Every snapshot carries the whole unit database (≈95% of snapshot bytes)

**Fixed 2026-09-28:** split into `_core.json` and per-campaign databases (see PROGRESS).

| Key in each snapshot | Summed over 44 snapshots | Distinct content |
|---|---|---|
| `unitTypeConfigs` (fully flattened `[unit_type]` WML, 328–425 types) | 137 MB | **4.2 MB** (444 types; a type is byte-identical in every snapshot that has it) |
| `unitTypes` (summaries for UI lists) | 10.9 MB | 1.0 MB |
| `terrainTypeConfigs`, `movementTypeConfigs`, `abilityConfigs`, `weaponSpecialConfigs` | 6.1 MB | 0.16 MB (one value) |
| Genuinely per-scenario: map, `terrain`, `scenarioConfigJson`, sides, story | ~2.7 MB | ~2.7 MB |

**157 MB of stored snapshots hold about 8 MB of distinct data.** For a
player, Liberty 1's snapshot is 3.55 MB raw / 164 KB Brotli. The 328 core
types in it are 126 KB Brotli; the scenario itself is about 12 KB. Every
further scenario re-sends the ~125 KB core database. Types are already built
lazily on first lookup (`gameBoardSnapshot.ts` `buildSnapshotContextUncached`),
so moving them into shared files doesn't change how the engine uses them.

It is also the main reason git history grows (32 commits have rewritten
these 155 MB).

### 4.2 Per-scenario terrain atlases repeat the same tiles (186 MB for 16 MB of sources)

**Fixed 2026-09-28:** a shared bundle plus small per-scenario ones; terrain is now 25 MB in total (see PROGRESS).

- The 44 terrain atlases fill 12,988 image slots, but only **1,722 distinct
  images** (16.1 MB of source PNG). 479 images appear in ≥10 scenarios and
  make up 68% of all slots.
- One atlas is roughly the size of its sources (1.12×), so this is
  duplication, not bad packing.
- For a player: playing the whole of Liberty downloads 41 MB of terrain
  atlases for 9.7 MB of distinct images; Dead Water 84 MB for 9.4 MB.
- The minimap's `symbol_image` tiles aren't in the atlas, adding ~37
  one-by-one requests per scenario.

### 4.3 Unit bundles are 3× their sources (27.6 MB vs 9.1 MB)

**Fixed 2026-09-28:** exact palette PNGs, 9.8 MB.

- Upstream's unit sprites are mostly 8-bit palette PNGs. Our bundler decodes
  them and writes RGBA, which loses the palette compression.
- A unit bundle has few colours: Spearman has 51 across all 60 frames.
- **Measured:** re-encoding every bundle as an exact-palette PNG, or an
  optimised RGBA PNG when a bundle exceeds 256 colours, gives **27.6 MB →
  7.3 MB**. That is smaller than the sources, and every re-encoded bundle
  decodes to byte-identical RGBA.

### 4.4 Terrain atlases could be encoded smaller

Liberty 1's atlas has 554k colours, so a palette doesn't help. Lossless WebP
with `exact` (which keeps the RGB of fully transparent pixels): **5.30 →
3.61 MB (−32%)**, and it decodes to identical RGBA in Pillow. PNG `optimize`
alone gives −14%. The browser's decode path still has to pass the Phase 28a
golden hashes before we switch.

### 4.5 Title screen: 6.1 MB before the player clicks anything

`background.webp` (4096×2160, 4.5 MB) is displayed stretched to the window,
and `titlescreen.webp` is 1.6 MB. Story art already has smaller `derived-images`
variants; the title screen doesn't use them. Measured: resized to 1920 px wide at WebP q80 it is 0.74 MB, at 1280 px
0.28 MB. The full image would then load only on large screens (`srcset`).

### 4.6 Many tiny UI files

About 30 requests of 0.2–5 KB each for engine chrome (buttons, icons,
ellipses, orbs, flags, dialog borders). Over HTTP/2 each costs little, but
they come in bursts as UI appears, and each one is a cache-revalidation
candidate. A single "UI chrome" sprite bundle (the same manifest mechanism as
terrain) would make that one request.

### 4.7 WAV sound effects

Core sounds are mostly OGG already. The 40 core WAVs are 2.5 MB, and some
of them are preloaded on every board (`slowed.wav` 151 KB, `bell.wav`
181 KB). Converting them to OGG at upstream's quality is ~10× smaller but
lossy (needs your sign-off, as in PHASE28_PLAN S4). The two campaigns with
most of the WAV bytes (TDG, HttT) aren't built yet.

### 4.8 Story JSON repeats its image table

Each story file lists every portrait a `[message]` in that scenario can
show. Across 31 files that is 1.6 MB, of which the distinct image entries
are 50 KB. It's small in absolute terms and fine to leave, or it could fold
into a shared per-campaign table.

### 4.9 Things that are fine as they are

- **Difficulty overlays:** already stored as deltas.
- **i18n:** per language and domain, on demand.
- **Unit bundles one per type:** that is the right granularity (see §5).
- **Music:** streamed, one track at a time.
- **Fonts:** fetched per glyph range.
- **JS:** one 421 KB gzip main chunk. Could be split so the title screen
  loads before the engine, but it isn't a size problem.

## 5. How to split: principles

Each asset's granularity is decided by three questions:

1. **Who shares it?** Everything, one campaign, one scenario, or one unit
   type.
2. **Is it always needed together with its neighbours?** If yes, bundle it
   (fewer requests, better compression). If only a subset is used each
   time, keep it separate (less transfer).
3. **How often does it change?** Different change rates shouldn't share a
   file, or a small change invalidates a large cached file.

Then:

- **One URL per content.** A name contains a hash of its bytes, is served
  `immutable`, and the same content is never published under two URLs
  (that duplication is what §4.1 and §4.2 are). A small root manifest
  (`no-cache`) maps logical names to hashed URLs.
- **Storage and transfer usually point the same way.** Deduplicating storage
  also stops the re-downloads. The exception is terrain (below), where a
  bigger shared bundle costs more on the first scenario and much less over a
  campaign.
- **Requests matter less than before, but not zero.** Over HTTP/2 a request
  costs a header and scheduling, not a connection. Hundreds of 1 KB files
  are still worth bundling; a dozen 100 KB bundles are fine.

## 6. Proposed split

| Tier | What | Scope and lifetime | Files a player fetches | Size (compressed) |
|---|---|---|---|---|
| **App** | JS, CSS, fonts, `index.html` | Per release | ~10 | ~0.5 MB |
| **Core data** | Core unit-type database (`unitTypeConfigs` + summaries of the 328 core types), movement/terrain types, abilities, weapon specials, `terrain-graphics-rules`, team colours | Whole game; changes only when the submodule is bumped | 2–3 JSON files | ~125 KB + ~225 KB + small (Brotli) |
| **Core terrain bundle** | Terrain images used by ≥5 of the built scenarios (837 images, 9.2 MB of source PNG) | Whole game | 1–3 WebP atlases | ~6 MB (after −32% WebP) |
| **UI chrome bundle** | Engine and core UI images: buttons, icons, ellipses, flags, orbs, items commonly placed, minimap `symbol_image` tiles | Whole game | 1 | ~0.3 MB |
| **Campaign data** | Campaign-only unit types (e.g. 14 for Liberty, ~100 for UtBS), the campaign's story image table | One campaign | 1–2 JSON | ~10–60 KB |
| **Scenario** | Map, `terrain`, `scenarioConfigJson`, sides, story, difficulty overlays | One scenario | 1 (+1 overlay) | ~12 KB |
| **Scenario terrain remainder** | Terrain images not in the core bundle | One scenario | 0–1 | median 0.3 MB, max 2 MB (source bytes) |
| **Unit type bundles** | One per type, as now, palette-encoded | Per unit type, shared by every scenario | one per type on the board or in the recruit list | ~7.3 MB total stored; ~20–100 KB each |
| **Media on demand** | Portraits and story art (derived variants), music (streamed), sounds, campaign images | Per file | as used | as used |

**Why the terrain line is drawn at "used by ≥5 scenarios"** (simulated on
the real manifests, source-PNG bytes, before WebP):

| Common bundle threshold | Common bundle | Per-scenario remainder (median / max) | Total stored | Liberty: 1st scenario | Liberty: whole campaign |
|---|---|---|---|---|---|
| Today (per-scenario atlases) | — | — | 186 MB | 5.3 MB | 41.2 MB |
| ≥3 scenarios | 11.1 MB | 0.1 / 1.4 MB | 17.7 MB | 11.1 MB | 12.2 MB |
| **≥5 scenarios** | **9.2 MB** | **0.3 / 2.0 MB** | **22.5 MB** | **9.3 MB** | **12.2 MB** |
| ≥8 scenarios | 7.5 MB | 0.7 / 2.6 MB | 31.0 MB | 7.9 MB | 13.1 MB |
| ≥20 scenarios | 4.3 MB | 2.1 / 3.8 MB | 62.5 MB | 6.2 MB | 19.8 MB |

- The first scenario costs ~4 MB more than today; everything after it costs
  almost nothing.
- Splitting the common bundle further by terrain family (water, forest,
  castle…) was also simulated, and doesn't pay: nearly every scenario
  touches most families, so a cold scenario would still fetch ~15 bundles
  and 9 MB.
- The threshold is recomputed at build time as campaigns are added.
  Phase 28c's campaigns will mostly reuse the same core tiles, so the common
  bundle grows slowly.
- **Phase 28c change: three tiers, keyed by campaigns.** With The South Guard's 11 scenarios the "≥5
  scenarios" rule grew the common bundle from 9.2 to 12 MB, all of it loaded by every scenario of every
  campaign, and it would keep growing with each campaign added. Now:
  - `_common`: images used by at least half of the real campaigns (at least 2): 11.8 MB with five
    campaigns (about 990 images really are used that widely);
  - `<campaign>/_campaign`: the rest that 2 or more of that campaign's scenarios use (0.1–2.5 MB);
  - the scenario's own.
  A new campaign now adds to `_common` only what half of all campaigns use.

**Why unit bundles stay per type:** a scenario uses 5–30 of ~440 types, and
the same type recurs across campaigns. Per-type bundles give exact transfer
at ~20–100 KB each, cached across everything. Grouping by faction would
fetch unused units.

**Estimated effect**, from the measurements above (compressed, per player):

| Scenario | Today (with correct caching) | Proposed |
|---|---|---|
| Title screen, first visit | ~6.1 MB | ~0.3–1 MB (screen-sized variants) + app |
| First scenario (cold) | ~0.4 MB data + ~5.3 MB terrain + ~0.2 MB units + ~0.4 MB minimap/UI | ~0.35 MB core data + ~6 MB core terrain + ~0.2 MB remainder + ~0.05 MB units + 1 chrome bundle |
| Each further scenario | ~0.17 MB snapshot + ~4–7 MB terrain atlas + ~40 small requests | ~12 KB scenario + ~0.2 MB remainder + new unit types only |
| Whole Liberty campaign (terrain only) | 41 MB | ~8–9 MB (12.2 MB source, WebP) |
| Stored/deployed (snapshots + atlases) | 157 + 214 MB | ~15 + ~25 MB |

## 7. Where this lands in the Phase 28 plan

- **S3 (versioned delivery):** the root manifest, content-hashed names, the
  split data files (core/campaign/scenario), and `immutable` caching.
- **S4 (shrinking):**
  - terrain tiers and WebP;
  - palette-encoded unit bundles;
  - the UI chrome bundle, with minimap tiles included;
  - title-screen variants;
  - WAV→OGG pending your sign-off.
  
  Each change is gated by the Phase 28a golden hashes and a screenshot
  diff.
- Snapshot splitting (§4.1) also shrinks the repo's growth: the database
  lives in 2–3 generated files instead of 44 copies. Whether generated JSON
  stays committed at all can be decided alongside it.
