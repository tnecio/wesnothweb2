## Findings

Assessed 2026-10-10, on top of the status table (#30) and AI steps (#31). Of the 922 items:
- 665 (72%) are done;
- 183 are partial, most of them implemented but with nothing that tests them;
- 55 are missing;
- 19 are out of scope.

### Bugs that affect shipped campaigns

None known. Phase 27a fixed the original list's correctness bugs; Phase 27b ported the ability and special
pipeline (`[disable]`, campaign-defined specials, ability filters), and found and fixed one more: core's own
Lua abilities -- the Ghast's feeding, stun, diversion -- never ran, for want of `wesnoth.game_events.add`.

### Presentation

Phase 27c closed the presentation gaps:
- every image path function, pixel-exact against the engine (16.43);
- `image_mod`, halo and `new_animation` effects (8.48-8.52);
- standing, idle, level-up, victory, draw/sheath and leading animations (18.3, 18.4, 18.11, 18.14, 18.16, 6.36);
- per-hex time-of-day lighting (14.14);
- linger mode at the end of a scenario (9.36);
- random unit names (3.10);
- fogged village flags (13.18).

Some of the planned items turned out not to be upstream 1.19's behaviour, and were not added:
- there is no carryover report dialog and no defeat dialog (11.9, 11.37);
- illuminated hexes are not drawn lit (14.15);
- units are not tinted by the time of day (the port's old overlay did tint them);
- a victory animation is played by the winner of a fight, not at a won scenario;
- there is no level-up sound.

The phase also found one correctness bug: a scenario's own `[time_area]`s were never loaded, so their hexes fought
at the day's lawful bonus.

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

1. **Correctness fixes**: done in Phase 27a, except `[disable]`, which moved to the special pipeline (2).
2. **The ability and special pipeline**: done in Phase 27b.
3. **Presentation gaps**: done in Phase 27c (see Presentation above).
4. **Test debt**: tests for the untested partial items, starting with the mainline specials and healing.
5. **Unused WML**: done in Phase 27a (`[store_unit_type_ids]`, `[store_unit_defense(_on)]`,
   `[store_relative_direction]`, `[have_side]`, `[set_variable] formula=`, a `$( )` test), except `[test_condition]`
   and delayed shroud updates.
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
