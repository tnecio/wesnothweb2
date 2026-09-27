# Phase 21 — Main menu: working plan (drafted 2026-09-27)

Scope is the Phase 21 section of `IMPLEMENTATION_PLAN.md`: a title screen,
a campaign selection dialog with difficulty, persisted completion markers,
Load Game, Preferences and Credits. Starting a campaign and loading a save
should both go through that menu, with the real title screen's layout.

This file sets out how I intend to build it, stage by stage, so it can be
reviewed before work starts.

## Decisions (2026-09-27)

- **Title screen buttons.** The column holds Campaigns, Load, Preferences
  and Credits. Help, Multiplayer, Map Editor, Add-ons, Achievements,
  Community and Quit are left out, per the plan edit.
  - The bottom bar keeps upstream's version label and Language button.
  - Upstream's About button is left out. Its tabs are desktop-specific
    (paths, build info, libraries), and Credits already has its own
    button.
- **Preferences** opens an interim dialog with tabs, shaped like
  upstream's `preferences_dialog`. It carries only the settings that
  already exist (sound, font scaling and orb colours). Phase 24 adds the
  remaining tabs to the same dialog.
- **Tip-of-the-day panel.** The panel ships, but what text it shows will
  be decided later.
  - It is built around a content source that can be swapped.
  - Until the content is decided, it shows upstream's own `data/tips.cfg`
    (69 tips, all translated). That lets the layout be tested with real
    text in every shipped language.
  - Recording encountered units (for upstream's `encountered_units=`
    filter) waits until the content decision.
- **RNG and Modifications.** The Combat RNG menu (Default, Predictable,
  Reduced) and the Modifications menu are omitted. The RNG work is added
  to `IMPLEMENTATION_PLAN.md` as Phase 30, the last phase, after CI/CD
  and the AI. No modifications ship, so there is nothing to list.

## Ground rules (as in Phases 19 and 20)

- Port upstream's behaviour and layout, not an approximation. The sources
  are:
  - `src/gui/dialogs/title_screen.cpp` with
    `data/gui/themes/default/dialogs/title_screen.cfg`.
  - `campaign_selection.cpp` with `campaign_dialog.cfg`.
  - `campaign_difficulty.cpp` with `campaign_difficulty.cfg`.
  - `end_credits.cpp` with `end_credits.cfg`, and `src/about.cpp`.
  - `game_initialization/singleplayer.cpp` and `playcampaign.cpp`, for
    how the difficulty is applied and completion is recorded.
  - `preferences.cpp`, for `completed_campaigns`.
  - `data/core/hotkeys.cfg`, for the title-screen keys.
- Strings are upstream's own msgids from `wesnoth-lib`: "Campaigns",
  "Load", "Preferences", "Credits", "Play a Campaign", "Difficulty:",
  "Timeline", "Completed: Gold" and so on. They are translated from the
  first commit. Port-only strings go in `wesnothweb`, and the Phase 20
  audit test enforces both.
- Each stage ends with all suites green, a browser check, a commit and a
  `PROGRESS.md` entry.

## Where things stand (what shapes the plan)

| Fact | Consequence |
|---|---|
| **Difficulty is baked in at build time.** `build-scenario-snapshot.mjs:232` sets `NORMAL` for every real campaign, because `#ifdef EASY` and similar are resolved by the preprocessor | A difficulty picker needs build output for each difficulty; nothing at run time can change it |
| **Two Brothers is built wrong today.** Its difficulties are `EASY` (the default) and `HARD`, and it has no `NORMAL`. Its scenarios test `#ifdef EASY` / `#ifndef EASY`, so our build gives the non-easy branches: the Grand Knight campaign, where upstream defaults to Horseman | S1 fixes this as a side effect |
| I built 01_Invasion and 04_Slavers at `EASY` and `NIGHTMARE` and compared them with the shipped `NORMAL` | Only `teams`, `units` and `scenarioConfigJson` differ, about 50 KB of a 3.4 MB snapshot. `unitTypeConfigs` (3 MB) and the terrain data are identical. A **per-difficulty overlay** is about 1.5 % of a full copy |
| Difficulties per campaign: DW 4, TB 2, Liberty 3, UtBS 4 (13 in all); the synthetic campaigns have none | Four campaigns need overlays. Campaigns without `[difficulty]` get upstream's behaviour: the menu is disabled and no define is set |
| Scenario snapshots are fetched at four sites: `PlayPage.svelte:71` and `GameShell.svelte:1906, 1991, 2098` | One `fetchScenarioSnapshot(id, difficulty)` helper replaces them all |
| `wesnothSave.ts:505` writes `difficulty=` as a hardcoded `NORMAL`. `SaveGameData` has no difficulty | A save has to carry its difficulty. A continuation has to keep it. Imported real saves have to read it |
| Upstream shows `campaign_difficulty` when a loaded save has no difficulty (`savegame.cpp:86`) | Not ported (decided 2026-09-27): a save without one gets the campaign's default difficulty |
| Completion is recorded in `playcampaign.cpp:205` as `add_completed_campaign(campaign, difficulty)`, only on a victory with no next scenario. It is stored as `completed_campaigns` (campaign id → set of difficulty defines) | Record it at the same point (our outro/end overlay). Store it through the existing `readSetting`/`writeSetting` (IndexedDB) |
| Laurels: `misc/laurel-bronze.png` (easiest), `misc/laurel-silver.png` (middle), `misc/laurel.png` (hardest, or a campaign with a single difficulty) | Port the exact selection rules from both dialogs |
| Campaign metadata (`icon`, `image`, `background`, `rank`, `year`/`start_year`/`end_year`, `[difficulty]`, `[about]`) comes from the `CAMPAIGN_DIFFICULTY` macros in `_main.cfg`, but `campaigns.json` has only name, description and the first scenario | A real preprocess of each `_main.cfg` at build time fills it in, keeping TStrings |
| Icons and difficulty images carry image path functions, for example `knight.png~RC(magenta>red)~CROP(6,4,72,72)`. `imageUrl()` (renderer) does not apply them, and `derived-images/` only holds story images | The DOM needs a small IPF-to-canvas helper (RC, CROP, SCALE, BLIT) built on the renderer's `parseIpf` |
| Campaign descriptions and tips contain Pango markup (`<small>`, `<i>`, `<b>`, `<span color=>`), which the current menu strips out | A safe Pango-subset renderer that builds DOM nodes and never uses `{@html}`. Credits headers and objectives can reuse it later |
| The outro already rolls a campaign's `[about]` credits, from a light text scan in `build-story-assets.mjs:86` | Credits reuse the same data, now properly preprocessed with translatable titles, plus core `data/core/about.cfg` (496 entries) |
| The title background is `maps/background.webp`, stretched to fill, with `maps/titlescreen.webp` scaled to fit and centred on top. Logo images are `misc/logo-bg.png` and `misc/logo.png` (all present in the submodule) | Pure CSS layering; no new art |
| `title_music=return_to_wesnoth.ogg`, and Phase 19 left main-menu music to this phase. `getAudioEngine()` is a singleton that waits for the first gesture | The title screen starts the title track, and a scenario's own playlist replaces it |
| `LoadGameDialog.svelte` is presentational. Storage, download, upload and the Wesnoth conversion are handlers inside `GameShell` | Move those handlers into a shared `saveManager.ts` so the title screen and the game use the same code |
| The game has no "Quit to Main Menu". A finished campaign has no way back except the browser | Add upstream's `quit` command (menu entry, with a confirmation) and a menu button on the final end screen. Browsers reserve Ctrl+W, so it has no key binding |
| The router doc names bookmarkable `/play/<id>` URLs as a user requirement. Four scripts use the old menu page: `i18n-screenshots`, `measure-story`, `story-screenshots` and `save-load-playthrough` | Keep the deep links (adding `?difficulty=`), but make the menu the only way in *through the UI*. Update the four scripts |

## Stage 1 — Difficulty in the build output

- `build-campaign-texts.mjs` becomes `build-campaigns.mjs`. It preprocesses
  each real campaign's `_main.cfg` with the real preprocessor and parser
  (with the campaign define set, like the snapshot build).
- For each campaign, it writes to `campaigns.json`:
  - `icon`, `image`, `background`, `rank`, and `year` (or `start_year`
    and `end_year`).
  - `difficulties: [{define, label, description, image, default,
    autoMarkup}]`, with TStrings kept.
  - `credits` (the `[about]` sections).
- Synthetic campaigns get `debug: true` and no difficulties.
- `build-scenario-snapshot.mjs --difficulty <DEFINE>` replaces the
  hardcoded `flag('NORMAL')`.
- `rebuild-snapshots.mjs` builds each real scenario once per difficulty
  in its campaign.
  - It writes the **default** difficulty as `scenarios/<id>.json`, so
    deep links and scripts that don't name a difficulty keep working.
  - Every other difficulty goes in `scenarios/<id>@<DEFINE>.json`, which
    holds only the top-level keys that differ from the base.
  - The build fails if a difficulty changes anything outside a small
    allow-list: `teams`, `units`, `scenarioConfigJson`, `map`, `story`,
    `terrainFlags`. That keeps the overlay assumption from silently going
    wrong.
- `build-story-assets.mjs` checks whether a scenario's story differs by
  difficulty. It usually doesn't, and one that does gets an overlay the
  same way.
- `packages/ui`: add `fetchScenarioSnapshot(id, difficulty)`, which
  fetches the base and the overlay in parallel and merges them. It
  replaces the four fetch sites.
- **Tests**:
  - Overlay merge unit tests.
  - A build-output test: every scenario of every campaign has an overlay
    for each non-default difficulty. Also, 01_Invasion at `EASY` merges
    to exactly what a direct `EASY` build produces (a golden comparison
    against a scratch build).
  - Two Brothers' default is now the `EASY` branch. Confirmed by a
    scenario-1 unit or gold value that is guarded by `#ifdef EASY`.

## Stage 2 — Difficulty and completion through the game

- `SaveGameData.difficulty?: string`, carried through
  `continueToNextScenario`, `loadIntoScenario`, replays and the
  scenario-start and autosaves.
  - `wesnothSave.ts` writes the real value and reads `difficulty=` on
    import. The fixed `NORMAL` goes away.
  - The round-trip fixture test gains the field.
- A save without a difficulty (every port save made before this phase)
  is treated as the campaign's default difficulty (decided 2026-09-27: no
  difficulty-choice dialog on load; upstream's `campaign_difficulty`
  dialog is not ported).
- The URL is `/play/<id>?difficulty=<DEFINE>`, which `PlayPage` passes
  to `GameShell` and on to the session.
  - An unknown or missing value falls back to the campaign default and
    logs it.
- Lua: `wesnoth.scenario.difficulty` (read-only), because upstream
  exposes it. No shipped scenario reads it; it is cheap and closes a gap.
- **Completion**: on a victory with no next scenario (where the outro and
  end screen already decide that), call
  `markCampaignCompleted(campaignId, difficulty)`.
  - It is stored as upstream's shape: campaign id → difficulty defines.
  - A campaign without difficulties records `""`, which
    `is_campaign_completed(id)` counts as completed.
  - The laurel choice (hardest, easiest or middle, for both the list and
    the difficulty menu) is a pure function with unit tests over upstream's
    rules. That includes "a single difficulty means gold" and "only the
    first of two or more means bronze".
- In-game menu: **Quit to Main Menu** (upstream's `quit` command, with a
  "Do you really want to quit?" confirmation), plus a **Main Menu**
  button on the end screen when the campaign has finished.

## Stage 3 — Shared pieces: markup, IPF images, save manager

- `packages/ui/src/markup/pango.ts` plus `Markup.svelte`: a tokenizer for
  the subset upstream content uses: `<b> <i> <u> <small> <big> <tt>`,
  `<span color= size= weight= style= font_family=>`, `&entities;`, and
  newlines.
  - It renders to DOM elements. Unknown tags become text, and there is no
    `{@html}`.
  - Unit tests run over the four campaigns' descriptions and every tip.
- `packages/ui/src/images/ipfImage.ts`: `ipfImageUrl(path)`.
  - It loads the base image, applies `RC` (the magenta team-colour
    range from the existing `team-colors.json`), `CROP`, `SCALE` and
    `BLIT` on a canvas, and caches object URLs.
  - It reuses the renderer's `parseIpf` and `splitRef`.
  - Tests run the pure parts; a browser check covers the four campaign
    icons and 13 difficulty images.
- `packages/ui/src/save/saveManager.ts`: the list, load, rename, delete,
  download and upload handlers that currently live in `GameShell`. The
  game and the title screen then run the same code, and `GameShell`
  becomes a caller.

## Stage 4 — Title screen

- `packages/ui/src/menu/TitleScreen.svelte` replaces `MenuPage`'s list.
  The layout follows `title_screen.cfg`:
  - Background image (stretched) under the scaled-to-fit centre image,
    with `logo-bg` and `logo` 30 px from the top.
  - Tip panel bottom-left and menu panel bottom-right, as translucent
    blurred panels (upstream's `box_display`, as `backdrop-filter`).
  - Bottom bar: "Version $version" on the left and the Language button on
    the right, showing the current language's own name, as
    `update_static_labels` does.
- **Buttons**: Campaigns, Load, Preferences, Credits. They are the
  `large` definition, full width in the column, with upstream's tooltips
  as `title` and `aria-description`.
- **Hotkeys**, from `hotkeys.cfg`:
  - `c` Campaigns, Ctrl+O Load, Ctrl+P Preferences, `l` Language,
    `space` Credits.
  - Left/Right move between tips.
  - They are registered through the Phase 15 hotkey system, and ignored
    while a dialog is open.
- **Tip panel**: Previous/Next and a hide/show toggle, persisted as
  upstream's `show_tips`. The content comes from a `TipSource`, and the
  provisional source is `tips.cfg`, built to `tips.json` with TStrings.
  There is no unit filter yet (see Decisions).
- **Title music**: `return_to_wesnoth.ogg` starts on the first gesture
  and yields to the scenario playlist when a game starts. Mute and volume
  follow the existing audio settings.
- **Phone width**: below 720 px the tip panel moves under the menu, and
  the column stays reachable without scrolling at a 150 % font scale.
  Phase 23 refines this further.
- The saved-games list under the campaign list goes away. Resuming a save
  is Load's job.

## Stage 5 — Campaign selection

`packages/ui/src/menu/CampaignSelectionDialog.svelte`, following
`campaign_dialog.cfg` and `campaign_selection.cpp`.

- **Left pane:**
  - A "Play a Campaign" title, and a filter box with keyboard capture.
    It searches the translated name, the English name, the description
    and the abbreviation, as `sort_campaigns` does.
  - A **Name** / **Timeline** sort toggle, with rank as the default
    order and cycling ascending, descending, rank.
  - The completion filter: Not Completed, Bronze, Silver, Gold, All.
  - The list shows icon, name and laurel.
- **Debug campaigns** come after the real ones, under a separate
  heading, visually muted but fully playable.
- **Right pane:**
  - The description (through `Markup`, honouring
    `description_alignment`) and the campaign image, over the campaign's
    `background` image.
  - When nothing is selected, upstream's landing page text.
- **Difficulty:** a menu of the campaign's difficulties.
  - Each entry shows its image, with the laurel blitted when that
    difficulty was completed, and its label and description.
  - The default comes from `default=yes`.
  - For campaigns without difficulties the menu is disabled, as upstream
    does.
- **Play** ("game^Play") and **Cancel**. Double-clicking or pressing
  Enter on a campaign plays it. Play navigates to
  `/play/<id>?difficulty=<DEFINE>`.
- **Accessibility**: a listbox pattern with arrow keys, and a labelled
  difficulty menu. A laurel's alt text says the level ("Completed:
  Gold"), so it is not colour-only, in line with Phase 20.

## Stage 6 — Load, Preferences, Credits

- **Load** (title screen) opens `LoadGameDialog` through `saveManager`.
  - Choosing a save navigates to `/play/<campaign>?save=<name>`, as the
    old menu list did.
  - "Show replay" goes through as `&replay=1`.
- **Preferences**: `PreferencesDialog.svelte` with upstream's tab strip.
  For now it has the tabs that have content: Display (font scaling and
  orb colours) and Sound.
  - The bodies of `AudioDialog` and `AccessibilityDialog` become panels,
    so the same panels appear in Preferences and in the game.
  - The in-game menu's Audio and Accessibility entries collapse into one
    "Preferences..." (Ctrl+P), as upstream has it. Language stays its own
    entry.
- **Credits**: `CreditsScreen.svelte`, a port of `end_credits`.
  - Data: `credits.json`, built from `data/core/about.cfg` and
    `about_i18n.cfg` plus each campaign's `[about]`, with the real
    preprocessor, and grouped as `about::get_credits_data` does.
  - The screen scrolls at upstream's speed, and Up/Down double or halve
    it within 50–400. Escape closes it.
  - The background is the focused campaign's `[about] images=` (else
    the title background).
  - It is text-only and lazy-loaded, so the title screen does not fetch
    it.
  - A `prefers-reduced-motion` user gets a static scrollable list.
  - The outro switches to the same `credits.json`, which retires the text
    scan in `build-story-assets.mjs`.

## Stage 7 — Milestone and docs

`apps/web/scripts/main-menu-playthrough.mjs` does the following, in order:

1. Loads `/`. The title screen shows every button, the version and the
   language. It takes a screenshot at desktop and phone width, with and
   without a 150 % font scale.
2. Opens Campaigns with `c`, filters "lib", picks Liberty and sets
   **Hard**. Play lands on `/play/liberty?difficulty=HARD`, and the
   board shows the `HARD` build (the number of enemy units that
   `3x enemies` implies).
3. Saves, then Quit to Main Menu. Load reopens the save, and it resumes
   on Hard at the same turn.
4. Plays `synth_keyboard_01` → `02` to victory from the menu. Back on the
   menu, the campaign shows a gold laurel (single difficulty), and the
   completion filter hides and shows it correctly.
5. Checks Two Brothers, left on its default, starts on the `EASY` build.
6. Covers Credits (scrolls, speed keys, Escape) and Preferences (a
   change is kept after a reload).
7. Runs the whole script once with `--keyboard-only`, counting 0 pointer
   events, as Phase 20's script does.

**Layout comparison**:
- A side-by-side of our title screen with a screenshot of the installed
  1.16.9 title screen, taken under Xvfb if it starts there.
- If it doesn't start, the comparison is against the layout rules in
  `title_screen.cfg`.
- Where the 1.16 layout differs from 1.19's `title_screen.cfg`, 1.19 wins,
  and the differences are recorded.

**Existing scripts** reach the game through the new menu (or through
their deep links, which stay): `i18n-screenshots`, `measure-story`,
`story-screenshots`, `save-load-playthrough` and `keyboard-playthrough`.
`i18n-playthrough` and `dialogue-playthrough` must stay green.

**Docs**: `PROGRESS.md` entries per stage, Phase 21 marked delivered in
`IMPLEMENTATION_PLAN.md`, and an Outcome section here.

## Files

| File | Change |
|---|---|
| `apps/web/scripts/build-campaigns.mjs` (was `build-campaign-texts.mjs`) | Real `_main.cfg` preprocess: metadata, difficulties, credits (S1, S6) |
| `apps/web/scripts/build-scenario-snapshot.mjs`, `rebuild-snapshots.mjs`, `build-story-assets.mjs` | `--difficulty`, overlays, allow-list guard (S1) |
| `apps/web/public/scenarios/*@*.json`, `campaigns.json`, `tips.json`, `credits.json` | Generated (S1, S4, S6) |
| `packages/ui/src/scenarioFetch.ts` | **new**: `fetchScenarioSnapshot` with overlay merge (S1) |
| `packages/ui/src/gameSession.ts`, `save/wesnothSave.ts`, `GameShell.svelte` | Difficulty through saves and continuation, completion, Quit to Main Menu (S2) |
| `packages/ui/src/menu/completion.ts` | **new**: completed campaigns and laurel rules (S2) |
| `packages/lua-bridge/src/bridges/…` | `wesnoth.scenario.difficulty` (S2) |
| `packages/ui/src/markup/pango.ts`, `Markup.svelte`, `images/ipfImage.ts`, `save/saveManager.ts` | **new** shared pieces (S3) |
| `packages/ui/src/menu/TitleScreen.svelte`, `TipPanel.svelte` | **new** (S4) |
| `packages/ui/src/menu/CampaignSelectionDialog.svelte` | **new** (S5) |
| `packages/ui/src/PreferencesDialog.svelte`, `CreditsScreen.svelte`, panels split from `AudioDialog`/`AccessibilityDialog` | (S6) |
| `apps/web/src/App.svelte`, `MenuPage.svelte` (becomes a thin host), `PlayPage.svelte`, `campaigns.ts` | Routing, `?difficulty=`, new manifest fields |
| `apps/web/scripts/main-menu-playthrough.mjs` | **new** milestone script (S7) |

## Risks

| Risk | Mitigation |
|---|---|
| A difficulty changes more than the overlay keys (a map, a unit type) | The build fails on any key outside the allow-list, and a golden test compares a merged overlay with a direct build |
| Build time: 13 difficulty builds × about 10 scenarios is about 4× the current rebuild | `rebuild-snapshots.mjs` already runs jobs in parallel. Overlays are only regenerated when a snapshot is rebuilt |
| Saves from before this phase have no difficulty | They get the campaign's default difficulty (not a hardcoded `NORMAL`, which Two Brothers doesn't have) |
| IPF helper drift from the renderer's own compositing | It reuses the renderer's parser and team-colour table, and the browser check covers every campaign and difficulty image |
| Pango markup as an injection path | No `{@html}`. Unknown tags and attributes are shown as text, and colours and sizes are validated |
| Autoplay: title music can't start before a gesture | Same mechanism as Phase 19. The track starts on the first key or click, and the menu works silently until then |
| Ctrl+W (upstream's quit) closes the browser tab | Menu entry only, noted in the hotkey table |

## Out of scope (by decision)

- Help, Multiplayer, Map Editor, Add-ons, Achievements, Community, Quit
  and the About dialog.
- The Combat RNG menu (now Phase 30) and Modifications.
- The "More campaigns..." and "Missing Campaigns" pages.
- Debug clock, test dialog and core selection.
- The tip panel's final content, and the encountered-units filter.

## Outcome (2026-09-27)

Delivered in the commits listed in `docs/PROGRESS.md`. Where it differs from the plan above:

- **No difficulty dialog for old saves** (your call): a save without a difficulty gets the campaign's default.
- **Lua `wesnoth.scenario.difficulty`: not built.** The bridge has no scenario table (its per-state data is the
  variable store); no shipped scenario reads it. It belongs to Phase 29's host API.
- **Overlays needed table patches:** Under the Burning Suns changes a few unit types per difficulty, so an
  overlay can carry per-entry patches to the unit-type tables as well as whole top-level keys.
- **No tip hide button, no `encountered_units` filter:** neither exists in this version's `title_screen.cfg` /
  `tips.cfg`.
- ~~Load from the title screen has no "Show replay"~~ -- fixed 2026-09-27, see `docs/PROGRESS.md`.
- **The plan's "campaign with no difficulties gets a gold laurel" was wrong:** upstream gives gold only when the
  last of the listed difficulties was won, so a campaign with none gets silver (the rule is ported exactly, with
  tests).
- **Outro credits** moved to `credits.json` in this phase (they were a text scan), which translates their titles.
- **Found on the way:** the keyboard cursor survived a scenario change (fixed); Two Brothers was built at a
  difficulty it does not have (fixed); `13_Epilogue` exists in two campaigns and the snapshot is named by id
  (unchanged; UtBS's last scenario resolves to Dead Water's).


## Addendum (2026-09-27): a real bug the plan missed -- scenario ids collide across campaigns

Flagged by the user right after delivery: the Outcome section above said "13_Epilogue exists in two
campaigns and the snapshot is named by scenario id... I left it alone" as if it were a cosmetic footnote.
It was not: it meant Under the Burning Suns' own epilogue never got built at all (Dead Water's silently
took its place), and the same flat-by-id scheme affected story assets and, worse, terrain image atlases --
where it meant a board could render with the *wrong* campaign's terrain images, not just lose data.

Fixed properly, not patched: every campaign's scenario/story/atlas output now nests under its own directory
(`CampaignInfo.assetDir`), and every id-based "just search all campaigns and pick one" shortcut
(`rebuild-snapshots.mjs`'s `PREFER` map included) is gone. Full details and verification:
`docs/PROGRESS.md`'s "real bug -- scenario/story/atlas JSON was keyed only by scenario id" entry
(2026-09-27, same date). `packages/ui/src/scenarioFetch.test.ts` now asserts the fix directly: the same
scenario id fetched from two different campaign directories comes back as two different snapshots.
