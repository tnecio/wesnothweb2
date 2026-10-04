# Campaign inventory: what the unported campaigns need

Generated 2026-10-04 by `apps/web/scripts/survey-campaigns.mjs` (data: `docs/campaign-inventory.json`). Every scenario of each
campaign not yet in `campaigns.json` was built at NORMAL difficulty and audited statically (every branch of every
event, the `[campaign]` block's events and resources merged in), and the campaigns' own Lua and WML scanned. It lists
what the port lacks; what it already supports is left out. Re-run after a subsystem lands to see what is left.

## Summary

| Campaign | Scenarios (built) | Missing tags | Campaign Lua tags | Lua (files / lines) | Unbridged Lua API | Core Lua modules missing | Micro AIs | Custom Lua AI | Dialogs | Achievements | Help topics | Own terrain rules / types |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| WL_Test | 2 (2) | 0 | 0 | 0 / 0 | 0 | 0 | — | 0 | 0 | 0 | 0 | 0 / 0 |
| World_Conquest | 1 (0) | 0 | 0 | 111 / 18017 | 15 | 0 | — | 0 | 5 | 0 | 0 | 0 / 0 |

## WML action tags the port does not have

| Tag | Campaigns | Uses | Which |
|---|---|---|---|

## Presentation tags that do nothing here

| Tag | Campaigns | Uses | Which |
|---|---|---|---|

## Conditions not evaluated

None.

## WML tags defined in campaign Lua

These run through the Lua runtime (Phase 28c); what they need is in the Lua API sections below.

| Tag | Campaign | Uses |
|---|---|---|

## Lua API the bridge does not provide yet

Names as the campaigns call them (`wesnoth.x.y`; a field read on a function's result may show as a name).

| Lua API | Campaigns | Places | Which |
|---|---|---|---|
| `wesnoth.map.filter` | 1 | 8 | World_Conquest |
| `wesnoth.allow_undo` | 1 | 4 | World_Conquest |
| `wesnoth.interface.get_items` | 1 | 2 | World_Conquest |
| `gui.widget.add_help_page` | 1 | 1 | World_Conquest |
| `gui.widget.add_invest_category` | 1 | 1 | World_Conquest |
| `gui.widget.add_invest_item` | 1 | 1 | World_Conquest |
| `items.only` | 1 | 1 | World_Conquest |
| `wesnoth.colors` | 1 | 1 | World_Conquest |
| `wesnoth.game_events.add_repeating` | 1 | 1 | World_Conquest |
| `wesnoth.interface.remove_item` | 1 | 1 | World_Conquest |
| `wesnoth.map.create` | 1 | 1 | World_Conquest |
| `wesnoth.map.filter_tags` | 1 | 1 | World_Conquest |
| `wesnoth.map.generate` | 1 | 1 | World_Conquest |
| `wesnoth.name_generator` | 1 | 1 | World_Conquest |
| `wesnoth.units.add_modification` | 1 | 1 | World_Conquest |

## Core Lua modules the runtime cannot load

`wesnoth.require` of mainline Lua (`data/lua/...`, `data/ai/lua/...`) that fails in the port's runtime; a campaign's own `./` modules are its Lua files, counted above.

| Module | Campaigns | Places | Which |
|---|---|---|---|

## Micro AIs (`[micro_ai] ai_type=`)

| ai_type | Campaigns | Scenarios | Which |
|---|---|---|---|

All run as upstream's own Lua (`lua/wml/micro_ai.lua`, Phase 29); listed so each can be checked when its campaign is ported.

## Custom Lua AI

`[ai]`/`[candidate_action]`/`[stage]`/`[engine]` with `engine=lua` or Lua code, per scenario. The Lua AI engine runs them (Phase 29); listed so each can be checked when its campaign is ported.


## Custom dialogs (`gui.show_dialog`)

| Campaign | Calls | Widgets the renderer lacks |
|---|---|---|
| World_Conquest | 5 | `linked_group` (6), `tree_view` (5), `node` (10), `node_definition` (10), `toggle_button` (5), `multi_page` (2), `page_definition` (8), `unit_preview_pane` (1), `size_lock` (1), `scrollbar_panel` (1), `definition` (1), `slider` (1) |

## Achievements

| Campaign | Achievements declared | `[set_achievement]` / progress uses |
|---|---|---|

Every campaign's `[set_achievement]` is supported since Phase 28c (recorded, not shown).

## Help topics opened (`[open_help]`)

None outside The South Guard (which opens three unit pages). Supported since Phase 24 (2026-09-30): the
help browser opens at the topic, and the event waits until it is closed.

## Campaign terrain

Supported since Phase 28c C1: a campaign's own `[terrain_type]`s and `[terrain_graphics]` (and a scenario's) are built into its snapshots and joined to the core rules. Listed so each can be checked when its campaign is ported.

| Campaign | `[terrain_graphics]` | `[terrain_type]` |
|---|---|---|

## Preprocessor gaps the survey found (fixed)

Building every campaign exposed places where the port's preprocessor differed from upstream's; each is fixed and
the shipped campaigns' snapshots rebuilt unchanged:

- **Macro state across files.** Upstream preprocesses a whole campaign in one pass, so a scenario sees the macros as
  they stand when its file is reached; the builder used the state after the last file. Heir to the Throne's last
  scenario `#undef`s `HTTT_BIGMAP`, and Secrets of the Ancients swaps its `JOURNEY_STAGE*` per chapter. The builder now
  copies the macro table as the campaign's preload reaches the scenario's file.
- **`#` inside macro arguments** goes through the same directive/comment handling as elsewhere (Eastern Invasion, The
  Deceiver's Gambit).
- **`#enddefs`**, a typo in `data/campaigns/*/utils/side_ai.cfg` of Of Pearls and Pirates and The Hammer of Thursagan:
  upstream's define scanner matches `#enddef` as a prefix, so it ends the definition; so does the port now (the stray
  `s` is dropped rather than emitted).
- **Theme macros** (`data/themes/`, e.g. `CUTSCENE_THEME_BACKGROUND`) are loaded with core's, as upstream's game
  config includes them.

## Builds


| Campaign | Scenario | Error |
|---|---|---|
| World_Conquest | `campaigns/World_Conquest/scenarios/WC_II_scenario.cfg` | TypeError: Cannot read properties of undefined (reading 'allChildren') |

World Conquest is a random-map multiplayer campaign: its one scenario file builds each map with Lua at game start
(`wesnoth.map.generate`, its own era and invest dialogs), which the snapshot builder cannot model, so it was surveyed
from its WML and Lua alone. It is a separate project from the story campaigns.
