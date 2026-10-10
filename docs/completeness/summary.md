## Findings

Assessed 2026-10-10, on top of the status table (#30) and AI steps (#31). Of the 922 items:
- 665 (72%) are done;
- 183 are partial, most of them implemented but with nothing that tests them;
- 55 are missing;
- 19 are out of scope.

### Bugs that affect shipped campaigns

Each was confirmed against the code and the campaign data.

| What | Items | Effect |
|---|---|---|
| `[modify_side]` reads `side=` as one number; a list (`side=2,3`) or `[filter_side]` falls back to **side 1** | 9.6, 9.14 | The player receives what is meant for enemy sides. About 1,000 uses in shipped scenarios, mostly `[ai]` changes. In HttT 42 the player gets the orcs' income and a goblin recruit list. |
| `[modify_side]` ignores `fog=`, `shroud=`, `hidden=`, `color=`, `flag=`, `share_vision=`, `village_gold=`, `village_support=` | 9.14, 9.49, 9.50 | About 140 uses: fog, shroud and hidden sides do not change when a scenario says so. |
| An event's `[filter_attack]` / `[filter_second_attack]` is not evaluated, and `$weapon` / `$second_weapon` are not set | 5.22, 12.7 | 245 handlers in 73 shipped scenarios. On an `attack` event they fire for any weapon. |
| `attacker hits` / `defender hits` / `attacker misses` / `defender misses` are never fired | 5.23, 5.24 | Dead handlers in HttT 4, 7 and 24, Legend of Wesmere and Sceptre of Fire 9. |
| `advance` / `post advance` are never fired | 8.63, 8.64 | Used in 14 campaign files, including HttT, The South Guard, The Deceiver's Gambit and Dusk of Dawn. |
| `[modify_unit_type]` is never applied | 3.43 | Dead Water's Cuttle Fish cannot become a Kraken. OPP 2–4 recruit costs, and changes in HttT, DiD, EI and SotBE, do not happen. |
| The `[disable]` special is missing; `attacks_used=` / `movement_used=` are not applied | 5.54, 3.22 | TDG's Eldred can attack with a weapon meant only for retaliation. HttT's Jeniver can use her two-attack weapons once per turn as if they cost one. |
| Specials work only for mainline `id=`s; the generic special pipeline is not ported | 7.1–7.26 | A campaign's own `[damage]` / `[attacks]` / `[chance_to_hit]` specials and all special filters have no effect: Descent into Darkness's spells, and parry, smoke and stagger in about 20 campaign files. |
| An ability's `[filter_adjacent]` and `[filter_student]` are not evaluated | 6.18, 6.26 | Conditional abilities act as always on. |
| A side's `[filter_recall]` is not applied | 10.19 | Units the scenario forbids can be recalled. |

### Missing presentation

**Images:**
- Only 16 of upstream's 39 image path functions are implemented; the rest draw the image unmodified (16.43). Shipped content uses `~CS()` 192 times, `~ROTATE()` 39 and `~NO_TOD_SHIFT()` 26.
- `apply_to=image_mod`, a unit's `halo=` and `apply_to=new_animation` are not drawn (8.50, 8.52, 8.49).

**Animations** (18.3, 18.4, 18.11, 18.14, 18.16):
- Units stand still between actions: no standing or idle animations.
- Advancing and winning play no animation (and so no level-up sound).
- Draw/sheath-weapon animations are not played.

**Lighting:** time areas and illumination have the right combat bonuses but are not lit on the board (14.14, 14.15).

**Fog:** a fogged village shows its last-known owner. Upstream shows the current owner's flag, or none if that owner is an enemy (13.18).

**End of scenario** (9.36, 11.37, 11.9):
- no linger mode;
- defeat offers only Quit to Menu;
- no carryover report.

**Random names:** recruits get no random names, though the random draws for them are made (3.10).

### Test debt

About 120 of the partial items work but nothing tests them, or tests touch them only in passing. The clusters are:
- the mainline weapon specials (berserk, charge, marksman, magical, drain, firststrike, slow, poison, petrify);
- healing: villages, poison, regeneration and cures;
- most `apply_to=` effects;
- `[set_variable]` operations;
- a dozen WML tags with no test of their own.

A missing test here hides nothing obvious, but no test guards these against regressions either.

### Platform

These are Phase 28d's, as planned:
- offline play;
- cross-browser testing;
- full storage;
- memory;
- performance budgets and tracking;
- browser checks in CI.

## Proposed follow-ups

1. **Correctness fixes** (the bugs table above, except the special pipeline). Each is a targeted port of upstream's code with a test:
   - `[modify_side]` through the side filter, with all its keys;
   - event `[filter_attack]`/`[filter_second_attack]` and `$weapon`;
   - the hit/miss and advance events;
   - `[modify_unit_type]`;
   - `[disable]`, `attacks_used=` and `movement_used=`;
   - `[filter_recall]`.

   Highest priority: these change how shipped campaigns play.
2. **The ability and special pipeline**: port `units/abilities.cpp` (filters, `apply_to=`, `active_on=`, `cumulative=`, `[filter_adjacent]`, `[filter_student]`, the generic `[damage]`/`[attacks]`/`[chance_to_hit]`) and route the mainline specials through it. Its own phase, as the plan has long flagged it as Phase 2's largest gap.
3. **Presentation gaps**:
   - the missing image functions, led by `CS`, `ROTATE` and `NO_TOD_SHIFT`;
   - `image_mod` and halo effects;
   - standing, idle, level-up and victory animations;
   - time-area and illumination lighting;
   - linger mode, defeat options and the carryover report;
   - random unit names;
   - fogged village flags as upstream.
4. **Test debt**: tests for the untested partial items, starting with the mainline specials and healing.
5. **Unused WML**:
   - `[store_unit_type_ids]`, `[store_unit_defense(_on)]`, `[store_relative_direction]`, `[have_side]`;
   - `[test_condition]`, `[set_variable] formula=`, `$( )` tests;
   - delayed shroud updates.

   No shipped campaign needs these. Port them as one small batch, or leave them.
6. **Phase 28d** as planned, plus browser checks in CI.

## Out of scope: for confirmation

| Item | Reason |
|---|---|
| 1.39 Schema validation | A content-author tool; the port ships only mainline data. |
| 1.41, 11.26 Add-ons and `[modification]` | Add-ons are out of scope; a campaign's `[resource]`/`[load_resource]` is merged when the data is built. |
| 3.25 `[advancefrom]` | For add-ons; removed upstream. |
| 5.52 `[test_do_attack_by_id]`, 12.66 `[inspect]`, 16.20 hex coordinates | Upstream test and debug tools. |
| 11.25 `[multiplayer]` | Multiplayer is out of scope. |
| 16.42 Dirty-region redraw | The WebGL renderer redraws each frame by design. |
| 17.8, 17.9 `[theme]`, `[change_theme]` | The port's layout is its own responsive HTML, built to upstream's default theme. |
| 20.34 WASM build | The port has none; its Lua runs on fengari. |
| 20.44 Staging deployment | Decided against (docs/DEPLOYMENT.md). |
| 4.48, 10.27, 14.17, 15.23, 15.33, 19.12 | The catalogue describes behaviour upstream does not have. |
