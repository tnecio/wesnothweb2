# Campaign inventory: what the unported campaigns need

Generated 2026-10-01 by `apps/web/scripts/survey-campaigns.mjs` (data: `docs/campaign-inventory.json`). Every scenario of each
campaign not yet in `campaigns.json` was built at NORMAL difficulty and audited statically (every branch of every
event, the `[campaign]` block's events and resources merged in), and the campaigns' own Lua and WML scanned. It lists
what the port lacks; what it already supports is left out. Re-run after a subsystem lands to see what is left.

## Summary

| Campaign | Scenarios (built) | Missing tags | Campaign Lua tags | Lua (files / lines) | Unbridged Lua API | Core Lua modules missing | Micro AIs | Custom Lua AI | Dialogs | Achievements | Help topics | Own terrain rules / types |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Descent_Into_Darkness | 13 (13) | 2 | 0 | 0 / 0 | 0 | 0 | — | 0 | 0 | 7 | 0 | 0 / 0 |
| Dusk_of_Dawn | 6 (6) | 2 | 0 | 0 / 0 | 0 | 0 | — | 0 | 0 | 7 | 0 | 0 / 0 |
| Eastern_Invasion | 24 (24) | 3 | 2 | 2 / 337 | 0 | 0 | coward, zone_guardian, hang_out, goto, forest_animals | 35 | 2 | 2 | 0 | 0 / 0 |
| Heir_To_The_Throne | 35 (35) | 3 | 6 | 3 / 668 | 4 | 0 | zone_guardian, messenger_escort, simple_attack, goto, coward, wolves | 62 | 4 | 1 | 0 | 8 / 3 |
| Heir_To_The_Throne_Classic | 31 (31) | 1 | 4 | 2 / 82 | 2 | 0 | assassin | 0 | 1 | 1 | 0 | 0 / 0 |
| Legend_of_Wesmere | 24 (24) | 0 | 3 | 1 / 163 | 0 | 0 | patrol | 2 | 0 | 0 | 0 | 0 / 0 |
| Northern_Rebirth | 16 (16) | 0 | 1 | 1 / 38 | 0 | 0 | return_guardian | 0 | 0 | 0 | 0 | 0 / 0 |
| Of_Pearls_and_Pirates | 6 (6) | 0 | 1 | 1 / 87 | 0 | 0 | zone_guardian | 8 | 1 | 1 | 0 | 0 / 0 |
| Sceptre_of_Fire | 14 (14) | 0 | 1 | 1 / 11 | 0 | 0 | — | 0 | 0 | 0 | 0 | 3 / 2 |
| Secrets_of_the_Ancients | 22 (22) | 1 | 0 | 1 / 104 | 1 | 0 | zone_guardian, coward, messenger_escort | 0 | 1 | 0 | 0 | 33 / 33 |
| Son_Of_The_Black_Eye | 19 (19) | 0 | 0 | 1 / 173 | 1 | 0 | simple_attack, healer_support | 1 | 0 | 0 | 0 | 0 / 0 |
| The_Deceivers_Gambit | 20 (20) | 3 | 3 | 3 / 661 | 7 | 0 | zone_guardian, goto, simple_attack, healer_support, patrol, coward | 26 | 2 | 2 | 0 | 0 / 0 |
| The_Hammer_of_Thursagan | 11 (11) | 0 | 0 | 0 / 0 | 0 | 0 | zone_guardian | 10 | 0 | 3 | 0 | 0 / 0 |
| The_Rise_Of_Wesnoth | 27 (27) | 2 | 0 | 1 / 60 | 0 | 0 | — | 5 | 0 | 0 | 0 | 0 / 0 |
| WL_Test | 2 (2) | 0 | 0 | 0 / 0 | 0 | 0 | — | 0 | 0 | 0 | 0 | 0 / 0 |
| Winds_of_Fate | 16 (16) | 0 | 1 | 0 / 0 | 0 | 0 | big_animals, return_guardian | 0 | 0 | 0 | 0 | 0 / 0 |
| World_Conquest | 1 (0) | 0 | 0 | 111 / 18017 | 17 | 0 | — | 0 | 5 | 0 | 0 | 0 / 0 |

## WML action tags the port does not have

| Tag | Campaigns | Uses | Which |
|---|---|---|---|
| `[set_extra_recruit]` | 4 | 36 | Eastern_Invasion, Heir_To_The_Throne, The_Deceivers_Gambit, The_Rise_Of_Wesnoth |
| `[do_command]` | 3 | 30 | Eastern_Invasion, Heir_To_The_Throne, The_Deceivers_Gambit |
| `[find_path]` | 3 | 3 | Descent_Into_Darkness, Eastern_Invasion, Heir_To_The_Throne_Classic |
| `[end_turn]` | 2 | 3 | Heir_To_The_Throne, The_Deceivers_Gambit |
| `[petrify]` | 2 | 3 | Dusk_of_Dawn, Secrets_of_the_Ancients |
| `[unpetrify]` | 2 | 2 | Dusk_of_Dawn, The_Rise_Of_Wesnoth |
| `[story]` | 1 | 2 | Descent_Into_Darkness |

## Presentation tags that do nothing here

| Tag | Campaigns | Uses | Which |
|---|---|---|---|
| `[redraw]` | 15 | 161 | Descent_Into_Darkness, Dusk_of_Dawn, Eastern_Invasion, Heir_To_The_Throne, Heir_To_The_Throne_Classic, Legend_of_Wesmere, +9 |
| `[floating_text]` | 8 | 84 | Descent_Into_Darkness, Eastern_Invasion, Heir_To_The_Throne, Heir_To_The_Throne_Classic, Northern_Rebirth, Sceptre_of_Fire, +2 |
| `[unit_overlay]` | 6 | 11 | Descent_Into_Darkness, Dusk_of_Dawn, Legend_of_Wesmere, Northern_Rebirth, Sceptre_of_Fire, The_Rise_Of_Wesnoth |
| `[select_unit]` | 3 | 22 | Heir_To_The_Throne_Classic, The_Deceivers_Gambit, The_Hammer_of_Thursagan |
| `[remove_unit_overlay]` | 2 | 3 | Legend_of_Wesmere, Northern_Rebirth |

## Conditions not evaluated


| Condition | Campaigns | Uses | Which |
|---|---|---|---|
| `[proceed_to_next_scenario]` | 1 | 7 | Legend_of_Wesmere |


## WML tags defined in campaign Lua

These run through the Lua runtime (Phase 28c); what they need is in the Lua API sections below.

| Tag | Campaign | Uses |
|---|---|---|
| `[item_dialog]` | Eastern_Invasion | 24 |
| `[item_dialog_musttake]` | Eastern_Invasion | 1 |
| `[display_overworld_tutorial]` | Heir_To_The_Throne | 1 |
| `[display_scenario_preview]` | Heir_To_The_Throne | 1 |
| `[multihex_image]` | Heir_To_The_Throne | 1 |
| `[select_lintanir_boon]` | Heir_To_The_Throne | 1 |
| `[companion_message]` | Heir_To_The_Throne | 17 |
| `[display_lisar_tutorial]` | Heir_To_The_Throne | 6 |
| `[select_character]` | Heir_To_The_Throne_Classic | 1 |
| `[print]` | Heir_To_The_Throne_Classic | 2 |
| `[hint_message]` | Heir_To_The_Throne_Classic | 2 |
| `[show_countdown]` | Heir_To_The_Throne_Classic | 1 |
| `[replace_map_section]` | Legend_of_Wesmere | 1 |
| `[shift_labels]` | Legend_of_Wesmere | 1 |
| `[persistent_carryover_store]` | Legend_of_Wesmere | 1 |
| `[find_respawn_point]` | Northern_Rebirth | 9 |
| `[display_tip]` | Of_Pearls_and_Pirates | 6 |
| `[rune_choice]` | Sceptre_of_Fire | 8 |
| `[select_delfador_skills]` | The_Deceivers_Gambit | 20 |
| `[display_skills_dialog]` | The_Deceivers_Gambit | 20 |
| `[listen_for_mousemove]` | The_Deceivers_Gambit | 14 |
| `[print]` | Winds_of_Fate | 1 |

## Lua API the bridge does not provide yet

Names as the campaigns call them (`wesnoth.x.y`; a field read on a function's result may show as a name).

| Lua API | Campaigns | Places | Which |
|---|---|---|---|
| `wesnoth.add_known_unit` | 4 | 5 | Heir_To_The_Throne_Classic, Son_Of_The_Black_Eye, The_Deceivers_Gambit, World_Conquest |
| `wesnoth.interface.select_unit` | 2 | 21 | Heir_To_The_Throne, The_Deceivers_Gambit |
| `wesnoth.audio.play` | 2 | 3 | The_Deceivers_Gambit, World_Conquest |
| `wesnoth.units.create_animator` | 1 | 35 | Heir_To_The_Throne |
| `filesystem.have_asset` | 1 | 28 | Heir_To_The_Throne |
| `wesnoth.map.filter` | 1 | 8 | World_Conquest |
| `wesnoth.allow_undo` | 1 | 4 | World_Conquest |
| `wesnoth.interface.get_items` | 1 | 2 | World_Conquest |
| `filesystem.image_size` | 1 | 1 | Heir_To_The_Throne |
| `gui.show_prompt` | 1 | 1 | Secrets_of_the_Ancients |
| `gui.widget.add_help_page` | 1 | 1 | World_Conquest |
| `gui.widget.add_invest_category` | 1 | 1 | World_Conquest |
| `gui.widget.add_invest_item` | 1 | 1 | World_Conquest |
| `gui.widget.close` | 1 | 1 | The_Deceivers_Gambit |
| `items.only` | 1 | 1 | World_Conquest |
| `wesnoth.colors` | 1 | 1 | World_Conquest |
| `wesnoth.game_events.add_repeating` | 1 | 1 | World_Conquest |
| `wesnoth.game_events.on_mouse_action` | 1 | 1 | The_Deceivers_Gambit |
| `wesnoth.game_events.on_mouse_move` | 1 | 1 | The_Deceivers_Gambit |
| `wesnoth.interface.add_overlay_text` | 1 | 1 | Heir_To_The_Throne_Classic |
| `wesnoth.interface.get_displayed_unit` | 1 | 1 | The_Deceivers_Gambit |
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
| `zone_guardian` | 6 | 66 | Eastern_Invasion, Heir_To_The_Throne, Of_Pearls_and_Pirates, Secrets_of_the_Ancients, The_Deceivers_Gambit, The_Hammer_of_Thursagan |
| `coward` | 4 | 6 | Eastern_Invasion, Heir_To_The_Throne, Secrets_of_the_Ancients, The_Deceivers_Gambit |
| `simple_attack` | 3 | 25 | Heir_To_The_Throne, Son_Of_The_Black_Eye, The_Deceivers_Gambit |
| `goto` | 3 | 8 | Eastern_Invasion, Heir_To_The_Throne, The_Deceivers_Gambit |
| `messenger_escort` | 2 | 4 | Heir_To_The_Throne, Secrets_of_the_Ancients |
| `healer_support` | 2 | 2 | Son_Of_The_Black_Eye, The_Deceivers_Gambit |
| `patrol` | 2 | 2 | Legend_of_Wesmere, The_Deceivers_Gambit |
| `return_guardian` | 2 | 2 | Northern_Rebirth, Winds_of_Fate |
| `big_animals` | 1 | 3 | Winds_of_Fate |
| `assassin` | 1 | 1 | Heir_To_The_Throne_Classic |
| `forest_animals` | 1 | 1 | Eastern_Invasion |
| `hang_out` | 1 | 1 | Eastern_Invasion |
| `wolves` | 1 | 1 | Heir_To_The_Throne |

All run as upstream's own Lua (`lua/wml/micro_ai.lua`, Phase 29); listed so each can be checked when its campaign is ported.

## Custom Lua AI

`[ai]`/`[candidate_action]`/`[stage]`/`[engine]` with `engine=lua` or Lua code, per scenario. The Lua AI engine runs them (Phase 29); listed so each can be checked when its campaign is ported.

- **Eastern_Invasion** (35): 01_Eastern_Invasion: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 01_Eastern_Invasion: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 03_An_Unexpected_Appearance: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 03_An_Unexpected_Appearance: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 04a_An_Elven_Interlude: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 04a_An_Elven_Interlude: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, +29
- **Heir_To_The_Throne** (62): 01_The_Elves_Besieged: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 01_The_Elves_Besieged: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 02_Flight_of_the_Elves: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 02_Flight_of_the_Elves: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 03_Blackwater_Port: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 03_Blackwater_Port: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, +56
- **Legend_of_Wesmere** (2): 03_Kalian_under_Attack: [engine] name=lua, 03_Kalian_under_Attack: [stage] name=leader_retreat
- **Of_Pearls_and_Pirates** (8): 01_Pirates: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 01_Pirates: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 02_Swimming_with_Serpents: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 02_Swimming_with_Serpents: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 04_Lee_Shore: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 04_Lee_Shore: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, +2
- **Son_Of_The_Black_Eye** (1): 06_Black_Flag: [candidate_action] name=transport location=campaigns/Son_Of_The_Black_Eye/ai/ca_transport_S6.lua
- **The_Deceivers_Gambit** (26): 01_Stirrings_of_War: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 01_Stirrings_of_War: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 02_Fort_Garard: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 02_Fort_Garard: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 03_The_Ambassador: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 03_The_Ambassador: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, +20
- **The_Hammer_of_Thursagan** (10): 01_At_the_East_Gate: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 01_At_the_East_Gate: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 03_Strange_Allies: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 03_Strange_Allies: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 05_Mages_and_Drakes: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 05_Mages_and_Drakes: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, +4
- **The_Rise_Of_Wesnoth** (5): 08_Clearwater_Port: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 08_Clearwater_Port: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 12_A_Final_Spring: [candidate_action] name=ai_default_rca::spread_poison location=ai/lua/ca_spread_poison.lua, 12_A_Final_Spring: [candidate_action] name=ai_default_rca::high_xp_attack location=ai/lua/ca_high_xp_attack.lua, 15_A_New_Land: [candidate_action] name=aggressive_attack_no_suicide location=campaigns/The_Rise_Of_Wesnoth/ai/ca_aggressive_attack_no_suicide.lua

## Custom dialogs (`gui.show_dialog`)

| Campaign | Calls | Widgets the renderer lacks |
|---|---|---|
| Eastern_Invasion | 2 | — |
| Heir_To_The_Throne | 4 | — |
| Heir_To_The_Throne_Classic | 1 | — |
| Of_Pearls_and_Pirates | 1 | — |
| Secrets_of_the_Ancients | 1 | — |
| The_Deceivers_Gambit | 2 | `menu_button` (1), `option` (1), `rich_label` (1), `filter_wml` (1), `modifications` (1), `object` (1), `filter_location` (1), `filter` (1) |
| World_Conquest | 5 | `linked_group` (6), `tree_view` (5), `node` (10), `node_definition` (10), `toggle_button` (5), `multi_page` (2), `page_definition` (8), `unit_preview_pane` (1), `size_lock` (1), `scrollbar_panel` (1), `definition` (1), `slider` (1) |

## Achievements

| Campaign | Achievements declared | `[set_achievement]` / progress uses |
|---|---|---|
| Descent_Into_Darkness | 7 | (supported) |
| Dusk_of_Dawn | 7 | (supported) |
| Eastern_Invasion | 2 | (supported) |
| Heir_To_The_Throne | 1 | (supported) |
| Heir_To_The_Throne_Classic | 1 | (supported) |
| Of_Pearls_and_Pirates | 1 | (supported) |
| The_Deceivers_Gambit | 2 | (supported) |
| The_Hammer_of_Thursagan | 3 | (supported) |

Every campaign's `[set_achievement]` is supported since Phase 28c (recorded, not shown).

## Help topics opened (`[open_help]`)

None outside The South Guard (which opens three unit pages). Supported since Phase 24 (2026-09-30): the
help browser opens at the topic, and the event waits until it is closed.

## Campaign terrain

This port's terrain graphics rules are core's only (`terrain-graphics-rules.json`); a campaign's own `[terrain_graphics]` or `[terrain_type]` would not be drawn or known.

| Campaign | `[terrain_graphics]` | `[terrain_type]` |
|---|---|---|
| Heir_To_The_Throne | 8 | 3 |
| Sceptre_of_Fire | 3 | 2 |
| Secrets_of_the_Ancients | 33 | 33 |

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
