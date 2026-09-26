# Real Wesnoth save fixtures

`dead-water-1-autosave-1.16.9.gz` is a **real save file written by the real
game** -- Wesnoth 1.16.9's own turn-1 autosave of Dead Water scenario 1
(`DW-Invasion!-Auto-Save1.gz`, straight out of `~/.config/wesnoth-1.16/saves/`).
It is committed unmodified, gzip and all, because the point of it is that
nothing in this project produced it: `wesnothSave.test.ts` asserts that this
port can read what the actual game writes, and that re-exporting it does not
quietly drop the parts this port does not model.

It is a mid-scenario save, so it has the full payload -- root classification
attributes, `[multiplayer]`, `[statistics]`, `[carryover_sides]`,
`[snapshot]` (2 sides, 9 units on side 1, `map_data`, every `[event]`),
`[replay_start]` and `[replay]` -- 120 KB of WML across 4,771 lines once
decompressed.

Scenario 1 of Dead Water is also this project's own primary test scenario
(`apps/web/public/scenarios/01_Invasion.json`), so the imported state can be
checked against a snapshot built from the same content by a completely
different route.

Note the version gap, which is deliberate and useful: the fixture is 1.16.9
content while this port ships 1.19 content. A save that survives that gap is
a stronger test than one written by the same version it is read by.

## Real AI games (Phase 18b)

`dead-water-1-real-ai-turn2-1.16.9.gz` and `dead-water-1-real-ai-turn5-1.16.9.gz`
are the real game's own autosaves (`DW-Invasion!-Auto-Save2.gz`/`-Save5.gz`)
from loading the fixture above in Wesnoth 1.16.9 and ending side 1's turn
without acting, four times over, so the real AI played side 2 (recruits,
moves). Nothing here produced them: their `[replay]` is the real game's own
command log -- 74 commands by turn 5 -- and their `[snapshot]` is its own
record of the board at that turn's start. `replay.test.ts` replays that log
here and compares the board with the turn-2 snapshot.

Made under Xvfb with `wesnoth --userdata-dir <scratch> --load <fixture>`,
ending turns with Ctrl+Space (confirming the "you have not started your turn"
prompt) and dismissing dialogue with Return.

## Real AI game on 1.19 (Phase 18c)

`dead-water-1-real-ai-turn{2,3,4,5}-1.19.21.gz` are autosaves written by a
desktop build of the checked-out 1.19.21+dev source -- the same version as
the port's data -- with side 1 ending its turns untouched and the real AI
playing side 2 for four turns (84 commands: recruits, moves, the `capture`
events that raise zombies). `replay.test.ts` replays the turn-5 log here and
compares every unit (id, type, variation, hitpoints, hex) with each turn's
autosave. Made with
`wesnoth --data-dir <src> --userdata-dir <scratch> --campaign Dead_Water
--campaign-difficulty 2 --campaign-skip-story` under Xvfb; 1.19 writes its
saves to `<userdata>/sync/saves`.

## `dead-water-2-autosave-turn1-1.19.21.gz` (Phase 18d)

The real 1.19.21+dev build's turn-1 autosave of Dead Water 2 ("Flight"),
normal difficulty, started with `--campaign Dead_Water
--campaign-scenario 02_Flight --campaign-skip-story`. Its `[snapshot]
map_data=` is the map after `prestart`'s `[terrain_mask]`, which the port
must reproduce exactly.
