# Phase 20 — Localization & Accessibility: working plan (decisions settled 2026-09-26)

Scope is the plan's Phase 20 section (`IMPLEMENTATION_PLAN.md`). This file
is how I intend to build it, stage by stage, so it can be reviewed before
work starts.

## Ground rules (same as Phase 19)

- Port upstream's behaviour, not an approximation. The sources are
  `src/tstring.cpp` (`t_string`: translatable parts, lazy translation,
  relocalizing when the language changes), `src/gettext.cpp`
  (`dsgettext`, `dsngettext`, the `^` context rule), `src/language.cpp`
  (language list, `min_translation_percent = 80`, locale selection),
  `src/serialization/preprocessor.cpp` + `parser.cpp` (how each `_ "…"`
  gets its textdomain), `src/picture.cpp` (`get_localized_path`,
  localized images and `--overlay`s), `data/languages/*.cfg`,
  `data/hardwired/fonts.cfg` (`family_order` is itself translatable, so
  each language picks its own font order) and `src/preferences/`
  (`font_scaling` 80–150 %, the orb colours).
- **Use upstream's strings and catalogues, not our own.** The full
  upstream `po/` tree is at `/home/tom/wesnothweb/wesnoth/po`: 36
  textdomains × 60 languages. The UI chrome uses upstream's exact msgids
  from `wesnoth-lib`/`wesnoth` (“End Turn”, “Recruit”, “Save Game”,
  “Objectives”, “Recall”, “Cancel”… are all there), so every language
  gets its existing translation for free. We don't write translations.
- **Layering.** The engine gets a pure `i18n/` module (the `t_string`
  port, the catalogue registry, gettext lookup, plural rules) with no
  browser APIs, so engine tests stay node-only. `packages/ui` loads
  catalogues, holds the reactive locale, and owns fonts and `dir`/`lang`.
- Each stage ends with all suites green, a browser check, a commit and a
  `PROGRESS.md` entry.

## Where things stand (what shapes the plan)

| Fact | Consequence |
|---|---|
| The parser recognises `_ "…"` but **stores a plain string**; `WmlAttributeValue` is `string \| number \| boolean` (`wml/parser.ts:10`) | Translatability is lost at build time. Nothing downstream can translate until it survives parsing |
| The preprocessor keeps **one un-scoped “last seen” textdomain** (`preprocessor.ts:29`) | A core macro expanded inside a campaign would get the campaign's domain. Must be scoped per file/macro, as upstream does, before any lookup can be right |
| Scenarios are **pre-built to JSON** (`build-scenario-snapshot.mjs`, 132 MB across 45 files) and read back through `WmlConfig.fromJSON` at run time | The marker has to be encoded in `WmlConfigJson`; the size growth must be measured |
| `UnitType.ts:73` strips the `female^` context by hand (bugs6.md) | That becomes the general `sgettext` rule inside the lookup |
| `Unit` has `gender` now, but `[message] male_message=`/`female_message=` are **not ported** (`actionWml.ts:219`) | The gendered-string item is small now |
| The Lua bridge has **no `wesnoth.textdomain`**; `wml-tags.lua` and `_initial.lua` call it | Needs at least a function returning translated plain strings (real `tstring` userdata stays in Phase 29) |
| Upstream catalogues for de: `wesnoth` 106 KB, `wesnoth-lib` 80 KB, `wesnoth-units` 193 KB, `wesnoth-dw` 43 KB, `wesnoth-utbs` 280 KB (gzipped `.po`; msgstr-only JSON is smaller) | Fetch per language × domain, only when used. English fetches nothing |
| Plural rules range from `nplurals=1` (ja) to 6 forms (ar) | A small C-expression evaluator, not `eval` |
| Localized images exist (`images/misc/l10n/<lang>/`) | `get_localized_path` is a small port |
| Upstream fonts: Lato (UI), WesScript (story), DejaVu Mono; CJK via NotoSansJP (9.1 MB) and DroidSansFallbackFull (5.3 MB); Lohit-Bengali (140 KB) | No shipped language is CJK or Bengali (see below), so none of those files ship now |
| Languages at upstream's 80 % (`data/languages/*.cfg`): en_US, it, es, en_GB, gl, cs, ar, hu, fi. **German is 76 %, Polish 68 %** | Shipped set = those plus pl_PL (your call). Arabic is the one RTL language. Polish per domain: `wesnoth` 1451/1465, `wesnoth-lib` 1349/1682, `wesnoth-dw` 426/475 translated |
| `ar.po` translates `family_order` “Lato” as “لاتو” (no such font) | Arabic falls through to the next font; we ship DejaVu Sans, which has Arabic glyphs, as the fallback |
| UI uses `px` everywhere and `font-family: sans-serif` in most components | Font scaling and the upstream font order both need a pass over the CSS |
| Phase 15 delivered hotkeys; `keyboard-playthrough.mjs` covers recruit/move/attack/end turn only | The milestone needs a whole scenario (story, dialogue, options, objectives, advancement, victory) without the mouse |
| `Modal.svelte` already has Escape, a focus trap, `aria-label`, `data-autofocus` | Screen-reader work is about roles, live regions and icon-button labels, not a rewrite |

## Stage 1 — Translatable strings survive parsing (engine)

- `packages/engine/src/i18n/tstring.ts`: port of `t_string`. A value is
  a list of parts, each either a literal or `{domain, msgid}`
  (upstream's `UNTRANSLATABLE_PART`/`TRANSLATABLE_PART`), so
  `_ "a" + "b"` concatenation keeps working. `str()` translates through
  the global catalogue and caches by a translation generation counter,
  exactly as `t_string_base::str()` checks `translation_timestamp`.
- `WmlAttributeValue` gains `TString`. `getString()` returns the
  translated text, `get()` returns the `TString`, and `==` in
  conditionals compares translated text, as `config_attribute_value`
  does. Every `get()` caller doing `=== 'literal'` gets audited (a
  typecheck pass will flag most).
- Preprocessor: scope `#textdomain` per file and per macro body, emitting
  a domain marker into the output the way upstream emits its
  `\376textdomain` lines; the tokenizer/parser stamp the current domain on
  each `_ "…"`.
- `WmlConfigJson` encoding: an attribute that is translatable becomes
  `{"t": [[domain, msgid] | literal, …]}`; plain values are unchanged.
  The writer emits `#textdomain` + `_ "…"` again (it already documents
  the gap). Saves (`SaveGameData`, `wesnothSave.ts`) carry the same
  encoding, so a translatable variable stays translatable after a load,
  as upstream's saves do.
- Rebuild all scenario snapshots, story and campaign JSON with markers.
- **Verification**: a coverage script checks that every `{domain, msgid}`
  in every shipped scenario, unit type and story file exists in that
  domain's `.pot`. This is what proves the domain scoping, and the target
  is zero misses (or a short list of upstream's own missing strings).
  Also measure the snapshot size change and run `measure-load.mjs`.

## Stage 2 — Catalogues and runtime locale switching

- `apps/web/scripts/build-translations.mjs`: `.po` → one JSON per
  language × domain, holding only translated, non-fuzzy entries
  (msgctxt, plural forms, and the `Plural-Forms` header), plus a
  `languages.json` from `data/languages/*.cfg` (name, locale,
  alternates, `percent`, and `rtl=` where set). The domains shipped are
  the core ones (`wesnoth`, `wesnoth-lib`, `wesnoth-units`,
  `wesnoth-help`) plus one per shipped campaign (`wesnoth-dw`,
  `wesnoth-tb`, `wesnoth-l`, `wesnoth-utbs`).
- Engine `i18n/gettext.ts`: `dsgettext` (strips up to `^` when
  untranslated, replacing the hand-rolled one in `UnitType.ts`),
  `dsngettext`, `dpgettext`, and a plural-rule evaluator (a small
  recursive-descent parser for the C subset gettext uses). Missing
  entries fall back to English.
- UI `i18n/locale.svelte.ts`: the current locale as a rune, lazy fetch of
  a language's domains (only the core domains and the running campaign's),
  a generation bump on switch that re-renders everything, and `lang`/`dir`
  on `<html>`. The default comes from `navigator.languages` matched
  against each language's `locale` and `alternates`, as upstream matches
  the system locale. The choice is kept in `localStorage`, like the audio
  settings.
- Minimal language picker: Menu > Language in game and an entry on the
  menu page. It lists the shipped set only: upstream's ≥ 80 % languages
  plus Polish, with no “show all” toggle. The set is one list in
  `build-translations.mjs`, so adding a language later is a one-line
  change. It moves into the Phase 24 preferences dialog later.
- Tests: plural evaluator over all 60 `Plural-Forms` headers, context
  stripping, fallback, and a TString concatenation relocalizing after a
  switch.

## Stage 3 — Everything visible goes through the lookup

- **UI chrome**: a `t(msgid)`/`tn(s, p, n)` helper over the `wesnoth-lib`
  domain (and `wesnoth` where upstream's string lives there). The helper
  uses upstream's msgids verbatim, including `%s`/`$var` placeholders and
  `^` contexts. An audit test scans every `.svelte` file for bare English
  text nodes and `title`/`aria-label`/`placeholder` values that bypass
  `t()`, and fails on new ones. Strings upstream has no msgid for go into
  our own `wesnothweb` textdomain: an extract script writes
  `i18n/wesnothweb.pot`, a translator can add `.po` files next to it, and
  the build treats it like any upstream domain. It is English-only for
  now.
- **Engine-made text**: turn announcements, floating combat and heal
  labels, status and trait names, the “level up” text, and victory and
  defeat captions are all built with upstream's msgids and domains.
- **Model text keeps its `TString`**: unit names, type names and
  descriptions, attack names, abilities and specials, terrain names,
  objectives, story parts, and campaign names and descriptions in
  `campaigns.json`. These are resolved when drawn, not when the model is
  built, so they follow a language switch.
- **Interpolation order**: translate, then substitute `$variables`, as
  upstream's `interpolate_variables_into_tstring` does. A dialogue that
  is open at switch time re-renders from its stored `TString` and the same
  variables. Nothing in the game changes while a modal is up, so the
  result is the same text in the new language.
- **Gender**: `[message] male_message=`/`female_message=` pick by the
  speaker's gender, and `[female]` unit-type names use the
  `female^…` msgids.
- **Localized images**: port `get_localized_path` (standalone image
  first, then a `--overlay`) so `images/misc/l10n/<lang>/` art is used.
- **Lua**: `wesnoth.textdomain(domain)` returns a callable that yields a
  translated plain string (plus the plural form); real `tstring` userdata
  is Phase 29.

## Stage 4 — Scripts, fonts and layout

- **Fonts**: bundle upstream's Lato, WesScript and DejaVu Sans Mono as
  `@font-face`s, and take the font order from the translated
  `family_order` in `fonts.cfg`, as upstream does, with DejaVu Sans as
  the fallback (it covers Arabic, Cyrillic and Greek). The loader fetches
  a font only when the current language's `family_order` names it, so a
  CJK language added later would pull upstream's NotoSansJP/Droid files
  on demand. None is in the shipped set, so no CJK file ships now.
- **RTL (he, ar)**: text runs get `dir="auto"` and `<html dir="rtl">`, and
  the board, map and side panel stay left-to-right. Upstream renders bidi
  text through Pango but does not mirror its GUI, so this matches it.
- **Wrapping**: set `line-break`/`word-break`/`hyphens` so story and
  dialogue text wraps well, and check the story viewer and message box with
  long Finnish and Hungarian compounds (the longest words in the set).
- **Numbers**: upstream shows plain integers almost everywhere. Only the
  few places it formats numbers (percentages, `si_string`) get a locale
  formatter.
- **Verification**: screenshots of dialogue, story, the recruit dialog
  and the side panel in pl, ar, fi, hu and cs at 1280×720 and at phone
  width.

## Stage 5 — Accessibility

- **Font scaling**: upstream's `font_scaling` range of 80–150 %. The UI
  CSS moves from `px` to `rem`, with the scale on the root. Layouts are
  checked at 150 % at desktop and phone widths, and nothing overflows or
  clips.
- **Keyboard-only play**: audit and fill the gaps between Phase 15 and a
  whole scenario. That covers story skip and advance, dialogue `[option]`
  choice and `[text_input]`, the objectives dialog, advancement choice,
  the scenario-end screen and Next, the menu, the save and load dialogs,
  and the language picker. `keyboard-playthrough.mjs` grows a mode that
  plays a small synthetic scenario from story to victory with keys only.
- **Screen readers**:
  - `role="dialog"`, `aria-modal` and `aria-labelledby` on `Modal`.
  - Labels on icon-only buttons such as mute and the menu.
  - One polite `aria-live` region that announces dialogue lines, turn
    changes, combat results and scenario end.
  - A description of the hex under the keyboard cursor: terrain, defence,
    and the unit with its HP, moves and side. This makes keyboard play
    usable without the canvas.
- **Colour-independent team identity**: see Decisions. At minimum, every
  place that shows a side by colour also names it, with the side number
  or name, in the side panel, unit tooltip, turn indicator and attack
  dialog. Upstream's configurable orb colours are ported as settings.

## Milestone (from the plan)

1. `apps/web/scripts/i18n-playthrough.mjs` opens Dead Water 1 in English
   and stops on a dialogue line. It then switches to Polish from the
   menu. It checks that the menu labels, an open dialog, the dialogue
   text, the unit names in the side panel and the objectives all change
   to their known `pl.po` msgstrs, and that the page did not reload (a
   marker set on `window` survives). It switches back and checks English
   returns.
2. The keyboard-only mode of `keyboard-playthrough.mjs` plays a
   synthetic scenario start to victory without one mouse event.
3. The Stage 1 coverage script reports zero unknown msgids for every
   shipped campaign.
4. A real-binary spot check: the same Dead Water 1 dialogue line and
   recruit list in `wesnoth --language pl_PL` (1.16.9 is installed) read
   the same as ours.

## Decisions (settled 2026-09-26)

1. **Languages**: upstream's ≥ 80 % set plus Polish, with no “show all”
   toggle. Because German is 76 %, it is out, and the milestone uses
   Polish instead.
2. **Team identity**: option (a). Port upstream's orb colours and name the
   side wherever a colour identifies it. No badge on the board.
3. **Port-only UI strings**: collected into our own `wesnothweb`
   textdomain with a generated `.pot`, English-only until someone
   translates it.
4. **Fonts**: ship upstream's font files and load them on demand. No
   shipped language needs a CJK font, so only Lato, WesScript, DejaVu Sans
   and DejaVu Sans Mono ship now; the on-demand path is there for later.

## Out of scope

- Real `tstring` userdata in Lua (Phase 29).
- The full preferences dialog, which hosts the picker later (Phase 24).
- Help-browser text (Phase 24): the `wesnoth-help` domain is built here
  but nothing shows it yet.
- Mirroring the GUI layout for RTL: upstream doesn't.
- Writing translations of our own.
