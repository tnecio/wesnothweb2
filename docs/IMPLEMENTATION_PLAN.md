# Implementation plan

Phased so each phase ends with something concretely checkable (a headless
test passing, a scenario rendering, a scenario playable end-to-end), not
just "code written." Later phases assume earlier ones are solid, but within
a phase, work is generally LLM-agent-friendly: a lot of it is close
translation of existing, readable C++ into TypeScript, subsystem by
subsystem, checked against an oracle (see `TESTING_STRATEGY.md`).

Explicitly **not ported, ever**: `display.cpp`, `draw*.cpp`, `sdl/`,
`units/animation.cpp`'s SDL-drawing half, all of `gui/` (382 files —
GUI2 dialogs/widgets), `src/server/wesnothd`'s implementation (may inform a
replacement, isn't reused), any Emscripten/WASM build tooling, and the
map/scenario **editor** (`EditorWML`/`PblWML` are explicitly out of scope
per the feature catalogue's own Appendix A). These are either replaced
outright (PixiJS, Svelte) or superseded by a from-scratch design
(multiplayer relay, which itself is struck out — see Phase 8).

## 2026-09-10 revision: mapped against `~/wesnoth-feature-catalogue.md`

This plan was cross-checked line by line against the feature catalogue (20
categories, ~1,000 testable features — the test-surface map for the whole
engine). Two things came out of that pass:

1. **Phase 3 (Lua) and large parts of Phase 2 were already delivered but
   this document didn't say so** — a documentation gap, now fixed below.
2. **Eight whole catalogue categories had no phase at all**: fog/shroud/
   vision, time-of-day schedules (beyond the raw damage formula), audio,
   localization, replay/statistics/achievements, minimap/labels/items,
   advanced UI chrome (hotkeys/mobile/help/preferences), and CI/CD/
   performance/platform. These are now **Phases 11–18**.

Every phase below (0–18) now carries a **Status** line and, where the
catalogue calls for more granularity than the original one-line bullets
gave, a **Catalogue checklist** referencing the relevant category number(s)
from `wesnoth-feature-catalogue.md`. A coverage table mapping all 20
categories onto phases is at the end of this document — use it to confirm
nothing was dropped when phases change in the future.

**What "done" means here**: a catalogue item marked done has *a* real,
tested implementation, verified against upstream WML/C++ where the
project's testing discipline requires it — not that every filter/edge
case/interaction listed under it is covered. Category 6/7 (abilities/
specials) especially: several specific specials are implemented but as
one-off, hand-checked logic per feature rather than through a single
generic filter/effect pipeline — see Phase 2's gap list.

## Phase 0 — Foundations

**Status: delivered** (2026-09-06/07).

- Monorepo scaffold: npm workspaces (matches attempt #1's tooling — no need
  for pnpm/Nx/Turborepo at this scale), `packages/{engine,lua-bridge,
  renderer,ui,oracle-tools}`, `apps/web` (Vite).
- Add `wesnoth` as a git submodule. Decide fork-vs-upstream (see
  `OPEN_QUESTIONS.md`); either way, install a native (non-WASM) CMake build
  so `packages/oracle-tools` can compile CLI oracles from it — this needs
  `cmake` and a C++ toolchain on this VM (currently only `g++` is present,
  no `cmake`).
- Stand up `wl-image-oracle` (already exists on the `wesnothlite` branch —
  port the CMake target forward or rebuild it) and a new `wl-rng-oracle` and
  `wl-wml-oracle`, since Phase 1 needs ground truth for WML parsing and RNG
  immediately, not after the fact.
- Copy forward from `wesnothweb`, adapting as needed: `board/images/ipf.ts`,
  `ImageCache.ts`, `teamColor.ts`, hex-grid math from `lib/utils.ts`, the
  `tween.ts`/`FloatingText.ts` animation helpers. These land in
  `packages/renderer` now even though rendering is a Phase 4 concern — no
  reason to re-derive fidelity work that already exists.
- **Milestone**: `npm test` runs (empty/trivial), `wl-image-oracle` and
  `wl-rng-oracle` build and run from the submodule, CI skeleton in place.

## Phase 1 — Data layer (WML + core model)

**Status: delivered** (2026-09-06/07), hardened continuously since by real
content (see Phase 6).

- Port `serialization/{tokenizer,preprocessor,parser}.cpp` → the WML
  pipeline. The preprocessor (macro/`#define`/`{include}`/`#ifdef`
  expansion, ~1800 lines upstream) is the hardest single piece in this
  phase — budget accordingly. Verify against `wl-wml-oracle` on a growing
  set of real `data/core/` and `data/campaigns/` files.
- Port `config.cpp`/`config_attribute_value.cpp` → the `Config` tree type.
- Port map/terrain (`map/map.cpp`, `map/location.cpp`,
  `terrain/type_data.cpp`, `terrain/translation.cpp`) and hook up to the
  hex-grid math already sitting in `packages/renderer` from Phase 0.
- Port `units/unit.cpp`'s data (stats, leveling, XP, status) *without* its
  `display.hpp`/`udisplay.cpp`/`drawer.cpp`/`animation.cpp` calls, and
  `game_board.cpp` (map+units+teams container).
- Port the WFL interpreter (`formula/*`, ~25 files, small and
  self-contained) — needed here because unit filters (`formula=`) and some
  ability conditions are evaluated while just building the data model.
- **Milestone**: given a real mainline scenario file, load WML → build a
  populated `GameBoard` (map, terrain, units, sides) → print/query it.
  No rules, no rendering, no Lua yet.

### Catalogue checklist (categories 1–3)

Done: basic/attribute/multi-key/quoted-string parsing, `+` concatenation,
comments, `_ "…"` + `#textdomain`, `#define`/`{MACRO}`/positional and
parenthesised args, nested macro expansion, `#ifdef`/`#ifndef`/`#else`/
`#endif`, `{path/}`/`{file.cfg}` inclusion, `~`/`@`/`.` path prefixes,
`$variable`/`$a.b.c`/`$arr[3].key`/`$|`/`$($x)` substitution, WFL `$(expr)`
evaluation, boolean/numeric/percentage/comma-list coercion, terrain code
parsing + aliasing (`aliasof=`/`mvt_alias=`/`def_alias=`, best-of
resolution), village/castle/keep terrain flags + castle connectivity,
`[terrain]` mid-scenario terrain change (layer control, `replace_if_failed`),
`[unit_type]`/`base_unit=`/`[movetype]`/movement-vision-jamming-defense-
resistance tables, `[attack]` definition (range/damage/number/type/weights/
accuracy/parry/movement_used/attacks_used), `advances_to=`, AMLA
definition, `[unit]` placement, `[status]` flags, `canrecruit=`, upkeep/
loyalty.

**Gap list** (not yet ported — real, tracked gaps, not oversights):
- `#ifhave`/`#ifver`/`#ifnver`, `#undef`, difficulty symbols wired through
  the preprocessor end-to-end (parsing exists; campaign-difficulty
  selection UI is Phase 6/17's job).
- Schema validation (`[wml_schema]`) and structured preprocessor
  error-location reporting (file+line) — currently errors exist but aren't
  audited against the real schema.
- `[insert_tag]`, `[literal]` blocks, deprecation warnings
  (`[deprecated_message]`) as a first-class mechanism (not just parsed and
  ignored).
- `[binary_path]` resolution order, `[core]`/`[modification]`/`[resource]`/
  `[load_resource]` add-on-over-core merge precedence — no add-on loading
  exists yet at all; single-core-plus-one-campaign is the only path tested.
- `[color_range]`/`[color_palette]`, `[fonts]`, `[advanced_preference]`
  declarations — parsed as generic WML if present, not specifically
  consumed anywhere yet (feeds Phases 14/17).
- Round-trip serialisation (parse → re-serialise → re-parse identical) —
  needed for save-file fidelity beyond the current gzipped-JSON snapshot
  approach; revisit alongside Phase 15's replay work.
- `[race]` random name generation (Markov generators), `[variation]`/
  `[male]`/`[female]` gendered variants, unit help-topic generation — data
  model has the hooks (`UnitType`) but generators/variation-switching
  aren't wired in yet; low priority until a campaign actually needs them
  (most don't rely on random naming for named story units).
- `[multiplayer]`/`[era]`/`[multiplayer_side]` tag parsing: the catalogue
  only requires these parse without erroring (MP *play* is struck out, see
  Phase 8) — should already be true since the WML parser is generic, but
  hasn't been asserted with a real MP-scenario fixture. Cheap to add as a
  Phase 6 regression test.

## Phase 2 — Rules engine (headless)

**Status: core delivered** (2026-09-07: RNG, pathfinding, event pump,
combat/attack-prediction, actions). **Actively extended since** by real
bugs Phase 5/6 work surfaced against real content — the zone-of-control
turn-accounting bug, attack-not-cancelling-movement, and this session's
village-capture + real per-turn income/upkeep are all Phase 2 (engine)
fixes discovered through Phase 5/6 (UI/content) work. This is the expected
pattern going forward, not a one-off.

- Port RNG (`random.cpp`, `random_deterministic.cpp`, `mt_rng.cpp`) —
  bit-exact MT19937, verified against `wl-rng-oracle`.
- Port pathfinding (`pathfind/astarsearch.cpp`, `pathfind.cpp`,
  `teleport.cpp`) — small, clean, verify against a new `wl-pathfind-oracle`.
- Port actions (`actions/*`: move, attack + `attack_prediction.cpp`,
  create/recruit/recall, heal, advancement, the undo-stack family) —
  **deliberately split** state mutation from the animation-triggering the
  original interleaves (see `ARCHITECTURE.md`). Verify combat resolution
  against a new `wl-combat-oracle` for fixed attacker/defender/terrain/seed
  inputs.
- Port the WML event pump and common action tags (`game_events/pump.cpp`,
  `action_wml.cpp`: `[message]`, `[if]`, `[modify_unit]`, `[store_unit]`,
  etc. — enough to drive simple scenario scripts) and the top-level
  single-player game loop (`play_controller.cpp` +
  `playsingle_controller.cpp`).
- Define and emit the engine's event vocabulary (`UNIT_MOVE`,
  `UNIT_ATTACK`, `UNIT_DIE`, `RECRUIT`, `ADVANCE`, `MESSAGE`, `SOUND`, ...)
  plus the `Query`/`Answer` side channel (`QUERY_REACH` etc.) — this is
  the seam the whole rest of the project renders against. Combat/move
  events carry the **full animation-context schema**, transcribed directly
  from `units/animation.hpp`'s `matches_headless()` parameter list (see
  `ARCHITECTURE.md`) — not whatever subset seems sufficient at the time.
  This is the one deliberate correction against attempt #1's actual failure
  mode (incomplete event context discovered late), so it's an explicit
  exit criterion here, not a Phase 4 concern.
- **Milestone**: a hand-written minimal scenario (no `[lua]`) plays start to
  finish headlessly via scripted commands, with combat outcomes matching
  `wl-combat-oracle` for the same seeds, snapshotted as a golden-scenario
  regression test — including asserting the emitted events carry every
  `matches_headless()` field, checked against real engine output via a new
  `wl-animation-oracle` (feeds fixed contexts through the real
  `matches_headless()` and dumps which animation it selects) even before
  the renderer exists to consume them.

### Catalogue checklist (categories 4, 5, 6 partial, 7 partial, 8, 9, 10, 12 partial)

Done: basic movement + MP pool + terrain cost lookup (incl. aliasing),
insufficient-MP-rule, impassable terrain, unit-blocking, zone of control
(including the 2026-09-09 ring-hop fix), skirmisher, A*/Dijkstra shortest
path + reachable-hex flood fill, ambush interruption, undo (single move/
recruit/recall, restores state exactly), village capture on move (added
this session — reassigns ownership, ends movement, doesn't fire the
`capture` event yet, see gap list) · attack initiation, weapon selection
(incl. player-facing weapon-choice UI), retaliation weapon choice + range
gating, strike sequencing, CTH calculation + clamping, damage calculation
(resistance × ToD × rounding, minimum-1 floor), synced-RNG hit rolls, kill/
death handling, `attack`/`attacker hits`/`defender hits`/`misses`/`attack
end`/`last breath`/`die` events, leader-death defeat, `[harm_unit]`/
`[kill]`/`[heal_unit]`, poison/slow/petrify/drain/berserk/firststrike/
charge/marksman/magical/backstab/swarm/plague specials, combat simulation
(incl. specials), attack-cancels-movement (fixed this session) · traits
(standard set + `availability=musthave` + exclusion), `[object]`/
`[remove_object]` (id/duration/rejection message), `[modifications]`
persistence + rebuild-on-change, most `apply_to=` effect variants that
don't require rendering (hitpoints/movement/vision/jamming/experience/
max_experience/max_attacks/new_attack/remove_attacks/attack-damage-and-
identity/loyal/fearless/movement_costs/defense/resistance/variation/type/
status/zoc/recall_cost/alignment/level/new_advancement/remove_advancement),
advancement + AMLA application, `advance`/`post advance` events, rest/
village/healer healing + exclusivity · `[side]` definition, controller
types, leader/multi-leader, team names/alliances, starting gold, **income/
upkeep/village-ownership** (built this session — real
`total_income()`/`side_upkeep`/`support()` formula, verified against
`play_controller.cpp`/`team.cpp`/`game_config.cpp`), turn order/counter/
limit, `prestart`/`start`/`turn refresh`/`side turn`/`new turn` events,
`[end_turn]`, victory (`no_leader_left`)/`[endlevel]`, gold carryover ·
recruit list/dialog/keep-and-castle-connectivity/gold deduction/recruited-
unit-state, `recruit`/`prerecruit` events, recall list/dialog/cost, `recall`/
`prerecall` events · `[event]` registration + `first_time_only=` +
`[filter]`/`[filter_second]`, several standard events (`moveto`, `capture`,
`select`, ...), `[if]`/`[then]`/`[else]`/`[elseif]`, `[set_variable]` (value/
arithmetic/rand/string ops/formula), `[store_unit]`/`[unstore_unit]`, SUF
basics (id/type/side/race/gender/level/canrecruit/role, numeric ranges,
`[filter_location]`, `[filter_adjacent]`, `[not]`/`[and]`/`[or]`).

**Gap list**:
- **Generalized ability/effect filter pipeline** (ties categories 6/7
  together): `[heals]`/`[regenerate]`/skirmisher/hides are each
  hand-coded narrowly (e.g. `heals`/`regenerate` apply unconditionally,
  with no `[filter_self]`/`[filter_adjacent]`/`cumulative=`/`value|add|
  sub|multiply|divide`/`max_value|min_value` evaluation at all). Real
  content leans on that generic machinery constantly (custom abilities,
  `[resistance]` ability, ability-scope flags `affect_self/allies/
  enemies`, `affect_movement/vision`). **This is the single largest
  remaining Phase 2 gap** — worth a dedicated sub-effort before Phase 6
  goes much further into content that uses non-default abilities.
  (2026-09-11: the *shorthand* half of this — `specials_list=`/
  `abilities_list=`, the comma-separated id list real mainline unit files
  almost universally use instead of inline `[specials]`/`[abilities]` —
  is now resolved, via `UnitTypeDatabase.collectSpecialRegistry()` and
  `UnitType`/`AttackType.fromConfig()`'s new `registries` param, keyed by
  `unique_id ?? id` and matched by real upstream's **tag name**, not
  `id=` — ability `id=` is a distinct display id in real content, e.g.
  every `heals`-tag entry sets `id=healing`/`id=curing`, never
  `id=heals`. Before this fix, most real specials/abilities were silently
  inert, including Dead Water's own healer Cylanna. The deeper filter/
  effect *evaluation* gap this bullet describes remains open.)
- **`[leadership]`** — explicitly not applied yet (`combatStats.ts`'s own
  doc comment: `leadershipBonus` is always 0). Blocked on the same generic
  pipeline above (adjacency + level-difference scaling + `cumulative=`).
- **`[illuminates]`** — not implemented at all; blocked on both the
  generic ability pipeline and Phase 12 (needs a real ToD/schedule model
  to shift).
- Teleport (`[teleport]` action *and* ability), `[tunnel]` routes,
  `[fake_unit]`/`[move_unit_fake]`/`[move_units_fake]` (cutscene-only,
  doesn't touch game state), `goto_x=`/`goto_y=` queued multi-turn
  movement, move-interruption-on-event (`moveto` firing mid-path) — none
  built.
- ~~Village-capture doesn't yet fire the real `capture`/`village capture`
  event, and there's no `[capture_village]` scripted action~~ — `[capture_village]`
  is now real (2026-09-11, `side=`/`side=0` neutralise; `[filter_side]`
  still unsupported). It still doesn't fire the real `capture`/`village
  capture` WML event on either the scripted or move-triggered path, and
  there's still no `[store_villages]`/`owner_side=` query.
- `[recall]` (the scripted action, distinct from the player-facing Recall
  UI) is now real too (2026-09-11) — finds a recall-list unit by SUF
  across every side's list and places it via the same leader/vacancy
  search (`checkRecruitLocation`) the UI uses. Verified end-to-end: all
  13 Dead Water scenarios now chain and play through headlessly,
  including scenario 3+'s real `{RECALL_LOYAL_UNITS}` macro correctly
  placing named heroes each time. `[secondary_unit]`, per-leader
  `recall_filter=`, `location_id=`, and `show=`/`fire_event=` (no `recall`
  WML event fires yet, matching `capture_village`'s gap above) are not
  ported — see `actionWml.ts`'s own doc comment on `actionRecall`.
- `attacks_left`/max-attacks-per-turn interacts correctly with a *single*
  attack today; hasn't been exercised against units with `apply_to=
  max_attacks` > 1 or specials that add extra strikes mid-combat via
  `[attacks]`.
- `[modify_side]` movement/economy restrictions beyond gold/income/
  village_gold (e.g. blanket "no moves this turn"), `[have_side]`/SSF
  (`[has_unit]`/`[allied_with]`/`[enemy_of]`/`[has_ally]`), achievements
  (`[achievement]` family — tracked as Phase 15).
- Global persistent variables (`[set_global_variable]`/
  `[get_global_variable]`/`namespace=`), `[sync_variable]`, `[do_command]`,
  dynamic event registration/`[remove_event]`/`priority=`/multi-name
  events, `[fire_event]`, `[switch]`/`[while]`/`[for]`/`[repeat]`/
  `[foreach]`/`[break]`/`[continue]`/`[return]`, `[have_unit]`/
  `[have_location]`/`[variable]` condition ops beyond simple equality,
  `[insert_tag]`, `[random_placement]`, `[role]`. All well-scoped,
  incremental additions to the existing event-pump/conditional-WML/filter
  modules — good candidates to drive from real Phase 6 content rather than
  speculatively building ahead of a scenario that needs them.
- Statistics recording (`[statistics]`/`[team]`/`[attacks]`/`[defends]`/
  `[killed]`/`[deaths]`) — tracked under Phase 15 alongside replay.
- `[test_do_attack_by_id]`, `[disable]` special, `[damage_type]` override,
  attack alignment override (`set_alignment=`) — small, not yet ported.

## Phase 3 — Lua integration

**Status: core delivered** (2026-09-07: Fengari embedded, all 8 Lua-5.4-
syntax files in `data/lua/` patched and verified, a narrow but real host
API bridge). **API surface breadth is ongoing**, driven by real content
the same way Phase 6 drives WML/rules gaps — most `data/lua/*.lua` files
run unmodified against the patched loader, but `wesnoth.*` host calls
resolve only for the handful bridged so far (`wml.variables`,
`wesnoth.units.get` with 6 fields, a minimal `require`).

- Embed Fengari in `packages/lua-bridge` (see `OPEN_QUESTIONS.md`).
- Patch the ~8 `data/lua/` files using Lua 5.4's `<const>`/`<close>` syntax
  (`core/wml.lua`, `wml-flow.lua`, `wml-tags.lua`, four `wml/*.lua`
  action-tag files, `functional.lua`) so Fengari (Lua 5.3) can parse them:
  drop `<const>`, rewrite `<close>` call sites (the `scoped_var()` pattern)
  to explicit pcall-based cleanup preserving the same restore-on-error
  guarantee. Small and mechanical, but track it as a real task, not an
  afterthought — this was only discovered by actually grepping for the
  syntax, not by reading upstream docs.
- Hand-port the subset of `scripting/game_lua_kernel.cpp`'s `wesnoth.*` API
  surface that mainline content and `data/lua/*.lua` actually exercise
  (unit/map/effect accessors, event triggers; UI-hook parts of the API stub
  out until Phase 5's UI exists). Everything in `data/lua/*.lua` other than
  the patched files above runs unmodified.
- **Milestone**: a real mainline scenario that uses `[lua]` for custom logic
  (pick one of the simpler ones) plays correctly headlessly.

### Catalogue checklist / gap list (category 12's `[lua]` bullet)

`[lua]code=`/`[args]` execute for the bridged subset; broader
`wesnoth.*` surface (map/side/effect/animation accessors beyond `units.get`,
`wesnoth.game_events` triggers from Lua, `wesnoth.interface` UI hooks) is
unbuilt — extend per real scenario/AI-micro-AI need (Phase 7's "port the
candidate-action framework using the Phase 3 Lua VM" leans on this
directly, as would any mainline campaign whose scenario logic is
Lua-heavy rather than WML-tag-heavy).

## Phase 4 — Rendering (PixiJS), target: Dead Water's first scenario

**Status: delivered**, narrower than originally scoped (see split below).

First playable-scenario milestone targets `Dead_Water` (mainline campaign),
starting with just its first scenario.

- Board renderer consuming the Phase 2 event stream: hex geometry, layered
  `PIXI.Container`s (terrain/highlight/unit/selection), unit sprites with
  real per-side colour markers, click handling, pan/zoom.
- **Delivered, but narrower than originally scoped** — the two biggest
  original line items were split out into their own phases (2026-09-09,
  user's call: both are large enough, and both are exactly what stalled
  attempt #1, to deserve explicit scoping rather than living inside
  "Phase 4 rendering" as an implicit, easy-to-forget gap):
  - **Phase 9 — Terrain visuals**: real `[terrain_graphics]` image
    compositing (currently flat-coloured hexes, a deliberate, user-approved
    interim simplification).
  - **Phase 10 — Unit animation**: context-aware animation selection/
    playback (currently static sprites, no movement/attack/death animation
    at all).
- **Milestone** (as delivered): a real scenario renders and is clickable in
  a browser tab, with real unit art and terrain colour, but no terrain
  compositing or unit animation — see Phases 9/10 for those.

## Phase 5 — UI shell (Svelte), target: Dead Water's first scenario

**Status: delivered** (2026-09-08) and **extensively polished since**
(2026-09-09, "post-Phase-5 revision" work): unit selection visuals fixed
(contrast bug + a real intermittent reactivity race), real per-unit-type
stats, victory/defeat conditions, save/load, a campaign picker with three
synthetic debug campaigns (combat/economy/progression) on separate routed
pages, weapon selection UI, hex coordinate display, and — this session —
a real village-ownership/income/upkeep economy display. See
`docs/PROGRESS.md` for the full, dated account; this is the phase that's
absorbed the most iteration so far and will likely keep doing so as Phase
6 surfaces more real scenarios to play through.

- Campaign/scenario picker, side panel, recruit/recall dialog, combat
  prediction popup (fed by Phase 2's `attack_prediction` port), objectives/
  turn dialog, save/load (Phase 2's `Config`-tree serializer, gzipped, in
  IndexedDB). Mine attempt #1's Svelte components and upstream's
  `gui/dialogs/` for required data shape only.
- **Milestone**: a full scenario is playable start-to-finish through the UI
  by a human, not just scripted commands.

### Catalogue checklist (category 15 done; category 17's "core play loop" slice done; remainder deferred to Phase 17)

Done: `[story]`/`[part]` playback, `[message]`/`speaker=`/portrait/
scroll-to-speaker, campaign picker, per-scenario routed pages, side panel
(unit info incl. position, gold/income/village display, weapon-choice UI,
recruit/recall lists with cost/affordability), objectives display (basic),
turn banner, save/load, end-turn hotseat cycling.

**Deferred to Phase 17** (not a Phase 5 gap so much as explicitly
out-of-scope-for-now UI chrome): `[option]`/`[text_input]` player choices,
message `duration=`/`side_for=`, advancement-choice dialog, statistics
dialog, unit-list dialog, in-game help/encyclopedia, preferences dialog,
keyboard shortcuts/rebinding, mobile/touch layout, right-click context
menu + `[set_menu_item]`.

**`[option]`/`[text_input]` priority note (2026-09-11)**: confirmed via a
real second campaign (A Tale of Two Brothers, see Phase 6/`docs/
PROGRESS.md`) that missing `[option]` support isn't just a narrative-
flavor gap -- a scenario can use a `[message] variable=... [option]`
player choice to drive its own core WML logic (there: a password puzzle
whose "wrong answer" branch reassigns/kills the player's units), and with
no selection ever made, that variable-comparison silently and
deterministically takes whichever branch an empty/unset value happens to
satisfy. Worth prioritizing above the rest of Phase 17's UI chrome once
Phase 6 needs it again, since it can block a scenario's core logic from
behaving sensibly at all, not just whether a choice dialog shows up.

## Phase 6 — Content breadth

**Status: in progress** (current focus). Dead Water scenario 1→2
continuation (real gold/recall carryover) landed 2026-09-09. As of
2026-09-11, all 13 Dead Water scenarios build from real WML, run their
`prestart`/`start` events without error, and chain correctly end-to-end
(verified headlessly, forcing victory at each step) — the whole campaign
is reachable through the real UI's victory → Continue flow, not just
scenarios 1–2. This surfaced and fixed two real engine bugs (`[recall]`
removing the wrong recall-list entry; recall-list survivors silently
dropped on a second scenario transition — see Phase 2's gap list and
`docs/PROGRESS.md`'s 2026-09-11 entry) and implemented `[capture_village]`/
`[recall]` for real. Not yet done: a real (non-forced) human or AI
playthrough of scenarios 4–13 to find whatever gameplay-shaped gaps
(scripted `moveto`/`turn N` events, abilities, specials) only show up
under real play rather than a scripted "load, force victory, load next"
smoke chain — every other mainline campaign also remains.

**A second real campaign (2026-09-11)**: `apps/web/scripts/
build-scenario-snapshot.mjs` was generalized to build ANY real mainline
campaign (previously hardcoded to Dead_Water specifically — see its own
module doc comment), and A Tale of Two Brothers (5 scenarios, the
shortest mainline campaign) is now built, added to `campaigns.json`, and
verified in a real browser (scenario 1: real story art, dialogue, board,
gold/income). This found one real, narrow build-pipeline bug (a map-less
`[story]`-only epilogue scenario crashed the build; fixed with a
placeholder-map fallback) and confirmed — via a forced-victory chain
script correctly reporting "defeat" rather than a false "victory" — that
scenario 3's core WML logic genuinely depends on the still-missing
`[option]` player-choice support (see Phase 5's priority note above).

- Finish `Dead_Water` (remaining scenarios), then expand to other mainline
  campaigns one at a time; every failure is a missing WML tag, WFL feature,
  or Lua API surface to port, driven by concrete repro cases rather than
  up-front spec-reading. Mainline only — add-ons are out of scope for now.

This phase is also the **primary mechanism** for closing out the long-tail
catalogue items listed as gaps under Phases 1–3 and Phase 2's ability/
specials pipeline: rather than speculatively building every filter/effect/
event variant up front, let real campaign content demand them one at a
time, the same way this session's ZoC bug, attack-movement bug, and
village/income gap were all found by playing real content, not by
pre-auditing the spec. Difficulty selection, `[options]` campaign options,
and add-on-style `[modification]`s (catalogue category 11's remaining
items) belong here too, once a real campaign that uses them is in scope.

## Phase 7 — AI opponent

**Status: not started.**

- MVP: a simple heuristic AI (greedy attack/move) as a placeholder, since
  mainline AI is a 60-file candidate-action framework substantially driven
  by Lua (`data/ai/`, 131 files using `[lua]`) — not worth porting before
  the game is otherwise playable. This is a placeholder to unblock
  single-player testing, **not** a decision to skip real AI — a
  genuine opponent is a required deliverable, just a late-stage one.
- Later: port the candidate-action framework and relevant Lua micro-AIs
  using the Phase 3 Lua VM, for closer-to-original behavior.

### Catalogue checklist (category 9's AI bullets)

`[side]controller=ai` must act automatically and never hang (even the MVP
heuristic satisfies this); `[modify_ai]`/`[aspect]`/`[facet]`/`[goal]`/
`[stage]`, and AI recruitment budgeting (`[recruitment_instructions]`/
`[recruit]`/`[limit]`) are real upstream surface that only matters once the
candidate-action framework (the "later" bullet above) is underway — not
needed for the MVP heuristic.

## Phase 8 — Multiplayer (struck out — not needed for MVP)

**2026-09-09 decision**: multiplayer is out of scope entirely, not just
deferred. The user's call: this is a single-player MVP project and there's
still substantial single-player polish work ahead (Phase 5/6) that's a
better use of effort. `ARCHITECTURE.md`'s multiplayer-relay section is now
historical context, not a live design target. Phase 2's RNG/command-based
action resolution stays as it is regardless (it's the right design for
single-player determinism/testing on its own merits), but no relay service
will be built on top of it.

**Clarification (2026-09-10, from the feature-catalogue pass)**: this
strike-out covers *networked* multiplayer only (session/lobby/relay,
`side_proxy_controller`, observers). It does **not** cover replay
recording/playback, out-of-sync detection, or RNG/choice synchronisation
(catalogue category 20) — those matter for single-player determinism,
testing, and "watch your last game back" even with zero network code, and
are tracked as real, in-scope work under the new **Phase 15**.

## Phase 9 — Terrain visuals

**Status: not started.** Split out of Phase 4 (2026-09-09, user's call):
real per-hex `[terrain_graphics]` image compositing is large enough on its
own, and is exactly one of the two things that stalled attempt #1, to
deserve its own explicit scope rather than living inside "Phase 4
rendering" as an implicit, easy-to-forget gap.

- Real per-hex `[terrain_graphics]` image compositing: base + overlay
  layers, edge-blending between adjacent terrain types, time-of-day
  tinting — replaces the current flat-coloured-hex rendering (a
  deliberate, user-approved interim simplification since the playability
  pass, and — as of this session — with villages given one narrow,
  hand-picked colour override specifically so they're visible at all;
  this whole special case goes away once real compositing lands).
  `packages/renderer/src/images/ImageCache.ts`'s MASK/CROP/BLIT
  compositing (ported forward from attempt #1) is real and already used
  for unit sprites; this phase is about driving it from real per-hex
  terrain layer data the way `display.cpp`'s terrain drawing does, which
  nothing currently does.
- Worth a fresh, dedicated scoping pass before starting rather than
  assuming attempt #1's approach is still right — revisit what actually
  went wrong there first.

### Catalogue checklist (category 2's terrain-graphics bullets, category 16's compositing bullets)

`[terrain_graphics]` base-tile rules, transitions (directional sprites
between adjacent terrain), `[variant]` probability/randomisation (seeded so
it's stable across reloads), `layer=` ordering (base/overlay/decoration vs.
units), `set_flag=`/`no_flag=`/`has_flag=` bookkeeping, structural-terrain
borders (keep/bridge/wall edge pieces against neighbours), off-map/border
background rendering, hidden-terrain display-as-alias, ToD colour tinting
applied consistently to terrain/units/overlays (ties into Phase 12).

## Phase 10 — Unit animation

**Status: not started.** Split out of Phase 4 (2026-09-09) for the same
reason as Phase 9 — attempt #1's other stalling point.

- Context-aware unit animation selection/playback, ported from
  `units/animation.cpp`/`frame.cpp`'s matching logic (facing/terrain/
  weapon/damage-state), frame position/halo/blend fields (attack-lunge
  positioning), sound-in-frame playback, per-blow HP sync points,
  `cycle_id`-grouped idle/defend animation.
  `packages/renderer/src/animation/` already has real, tested logic for
  animation *selection* (context schema, filter matching, frame parsing —
  see `docs/PROGRESS.md`'s animation-context work from early in this
  project); what's missing is actually *playing* the selected animation
  against the live board instead of drawing a static sprite.

### Catalogue checklist (category 18 in full)

Standing/idle/movement/attack/defend/missile/death/recruit/recruiting/
level-in/level-out/healing/healed/leading/victory/teleport/draw-weapon/
sheath-weapon animations; `[animate_unit]`/`[extra_anim]`; `[if]`/`[else]`
branches inside animations; filters by direction/terrain/hits/weapon/
state; frame image modifiers (blend/brighten/alpha) and progressive values
(`1~5:200` interpolation); frame offsets/layers; halo frames; auto-flip;
animated terrain frames (feeds Phase 9 too); `[delay]` + acceleration
preference + skippability; animation-during-fog suppression (feeds Phase
11); screen shake/fade; floating text (damage/healing numbers); animation
performance under mass combat; clean interruption (skip/dialogue/save
mid-animation).

## Phase 11 — Fog, Shroud & Vision (new)

**Status: not started; a deliberate, documented gap up to now** — every
hex is currently treated as visible to every side regardless of a
`seeAll` flag threaded through `pathfind.ts` and friends for exactly this
future phase to replace. This is a substantial, self-contained subsystem
(closest analogue in scope to Phase 2's original pathfinding/actions
work) and touches move interruption, undo eligibility, rendering, the
minimap, and AI — sequence it after Phase 6 has exercised the
non-fog-dependent engine surface thoroughly, since fog/shroud changes the
*meaning* of a lot of existing queries (`unitAt`, reachability, event
filters) rather than adding new ones.

- Per-side shroud (terrain hidden until explored) and fog (units/village
  ownership hidden on explored-but-unobserved hexes) state, with
  `share_vision=`/`share_maps=` ally-sharing rules.
- Vision points (defaulting to max movement) spreading by real vision cost
  through terrain (not straight-line radius), plus jamming (enemy vision
  suppression in a radius).
- `sighted` event firing (once per newly-sighted unit per side) and move
  interruption on sighting — `pathfind.ts`'s own doc comment already flags
  this as the thing its `seeAll` parameter exists for.
- `[remove_shroud]`/`[place_shroud]`/`[lift_fog]`/`[reset_fog]` scripted
  control, "delay shroud updates" preference, undo-blocked-by-information-
  gain (any move that clears shroud/fog becomes non-undoable — a real
  interaction with Phase 2's existing undo stack).
- Rendering: shrouded hexes render black, fogged hexes darkened, with
  correct transition sprites (depends on Phase 9); hidden units not drawn/
  selectable/targetable; last-known village ownership shown under fog, not
  current; minimap reflects only the viewing side's knowledge.
- `[filter_vision]` in SUF (`visible=`/`respect_fog=`/`side=`), and its
  interaction with `[hides]` (hidden units are invisible even *without*
  fog, revealed by adjacency — category 6's existing `hides` gap connects
  here).
- Shroud/fog state serialisation (save/load round-trip).
- **Milestone**: a real mainline scenario with `shroud=yes` (several exist)
  plays correctly — units/terrain hidden appropriately, `sighted` events
  fire and interrupt movement, and a save/load round-trip preserves
  exactly what's been explored.

## Phase 12 — Time of Day & Schedules (new)

**Status: partially started (2026-09-11: schedule model + status-bar
indicator built)** — `combatStats.ts`'s `combatModifier()` implements the
real alignment × `lawful_bonus` damage-multiplier formula (lawful/
chaotic/liminal/neutral, fearless negation). `packages/engine/src/model/
Schedule.ts` now ports `tod_manager`: parses a scenario's `[time]`
entries (`lawful_bonus=`, `current_time=`), advances once per game turn,
and `DEFAULT_MAX_LIMINAL_BONUS = 25` matches
`tod_manager::get_max_liminal_bonus()`'s simplified floor. Wired end to
end: `GameSession.currentTimeOfDay` feeds combat's `lawfulBonus`/
`maxLiminalBonus` options (so alignment damage bonuses are schedule-aware
for the first time) and `TurnBanner.svelte` shows a ToD icon + name.
Still missing: time areas, illumination, `random_start_time=`,
`[replace_schedule]`/`[store_time_of_day]`, ToD colour tinting on the
board, and a schedule preview.

- `[time]` definition (id/name/image/`lawful_bonus=`/colour shift) and the
  default six-phase day cycle used when a scenario specifies none.
- Real per-turn schedule progression (wraps around), `random_start_time=`,
  and scenario-level `[time]` overrides of the default schedule.
- `[time_area]`/`[remove_time_area]`: named regions with their own
  schedule, and combat/rendering inside them using the area's ToD instead
  of the global one.
- `[illuminates]` ability: shifts the effective `lawful_bonus` on affected
  hexes with min/max clamping (blocked on Phase 2's generic ability
  pipeline gap — see there).
- `[replace_schedule]`, `[store_time_of_day]` (current or future, global or
  at a hex).
- Rendering: ToD colour tinting on terrain/units/overlays (feeds Phase 9),
  illumination rendering brighter than neighbours, a status-bar ToD
  indicator with tooltip explaining the current bonus, and a schedule
  preview (feeds Phase 17).
- ToD-conditional events, ToD-driven music/ambient sound changes (feeds
  Phase 13), underground/indoor fixed-darkness schedules
  (`{UNDERGROUND}`/`{INDOORS}`).
- ToD state serialisation (current phase + time areas round-trip through
  save/load).
- **Milestone**: a real scenario with a non-default schedule (or a
  `[time_area]`) plays with visibly correct combat bonuses matching a
  hand-computed table for several turns/phases, and the status bar shows
  the right ToD image/name throughout.

## Phase 13 — Audio & Music (new)

**Status: not started — not previously mentioned in this plan at all.**
Nothing in `packages/renderer` or `packages/ui` touches audio; this is a
whole missing subsystem, not a gap inside an existing one.

- `[music]` scenario playlists (`append=`/`immediate=`/`play_once=`/
  `ms_before=`/`ms_after=`), track transitions/crossfade, shuffle
  (never-repeat-adjacent), persistence across scenario boundaries unless
  overridden, main-menu music, victory/defeat stingers.
- `[sound]` one-off effects (`repeat=`, delayed), attack/movement/death/
  recruit/level-up sounds driven by animation frames (`[frame]sound=` —
  ties directly into Phase 10, since these fire *from* animation frame
  data, not standalone), UI sounds (clicks, dialog open/close, errors).
- `[sound_source]`/`[remove_sound_source]`: positional looping sounds with
  radius/delay/chance and distance-based attenuation (`full_range=`/
  `fade_range=`) from the viewport centre.
- `[volume]` scripted changes (restored afterwards) and persistent
  separate music/sound/UI/bell volume preferences, plus mute/unmute.
- **Web-specific**: browser autoplay policy (audio only starts after a
  user gesture, without losing the already-queued track), lazy asset
  loading with silent-but-logged failure for missing files, and a
  simultaneous-sound-channel limit so mass combat doesn't distort/exhaust
  channels.
- **Milestone**: a real scenario's `[music]` playlist audibly plays and
  transitions correctly across a turn boundary, at least one weapon's
  attack sound fires on hit, and toggling the mute preference silences
  everything immediately and restores it correctly on unmute.

## Phase 14 — Localization & Accessibility (new)

**Status: not started beyond WML-syntax recognition.** Phase 1 already
parses `_ "…"` and `#textdomain`/`[textdomain]` as syntax; nothing
resolves an actual translation catalogue, switches locale at runtime, or
addresses non-Latin text layout or accessibility.

- Gettext `.po` catalogue loading per textdomain, resolving `_ "…"` values
  at *display* time (not parse time) so a locale switch updates everything
  live without a reload.
- Runtime locale switching (`[language]`/`[locale]`), plural-form rules,
  gendered strings (`female_name=` and friends — connects to Phase 1's
  deferred `[variation]`/gender work).
- RTL and CJK (wide-glyph) text layout/wrapping, missing-translation
  fallback to English, locale-aware number/date formatting where the UI
  needs it.
- Accessibility: colourblind-safe team identity (not colour-only — ties
  into the existing side-marker-circle approach from Phase 4, which
  already does this partially by drawing a shape, not just a colour,
  under every unit sprite), full keyboard-only play path (ties into Phase
  17's hotkey work), font-size scaling preference that doesn't break
  layout.
- **Milestone**: switching the UI language at runtime (even with just one
  additional language's `.po` file as a fixture) updates every visible
  string — menu chrome, side panel, in-scenario dialogue — without a page
  reload, and a scripted keyboard-only playthrough of a small scenario
  succeeds without touching the mouse.

## Phase 15 — Replay, Statistics & Achievements (new)

**Status: partially started.** Undo (single action, real state
restoration) is done (Phase 2). Save/load (Phase 5) captures enough state
to resume a scenario, but not as a replayable *action log* — there's no
dedicated replay recording/playback system, no out-of-sync detection
(meaningless without networked play, but still valuable as a
determinism self-check), no statistics tallying, and no achievements.

- Replay recording: every synced action (move/attack/recruit/recall/
  end_turn/choose) logged in order, independent of the snapshot-based
  save system, so a finished scenario can be replayed from turn 1 and
  reproduce identical state at every step — this is also the natural
  place to finally close Phase 1's deferred "round-trip serialisation"
  gap, since a replay log has the same fidelity requirement.
- Redo stack (replays undone actions in order, invalidated by any new
  action) — extends Phase 2's existing undo stack rather than replacing
  it.
- Out-of-sync self-check: replaying a recorded scenario and diffing final
  state against the live run it was recorded from is a strong regression
  test in its own right, independent of ever needing it for real
  multiplayer.
- `[sync_variable]` correctness (already listed as a Phase 2 gap; belongs
  here too since it's meaningless without a working replay log to check
  it against).
- Statistics (`[statistics]`/`[team]`/`[attacks]`/`[defends]`/`[killed]`/
  `[deaths]`): damage dealt/taken (expected vs. actual), kills/losses,
  recruits/recalls/advances tallied per side per scenario and rolled up
  per campaign.
- Achievements (`[achievement]`/`[achievement_group]`/`[sub_achievement]`/
  `[set_achievement]`/`[progress_achievement]`/`[has_achievement]`):
  definition, progress tracking, durable persistence across
  reload/campaign restarts.
- Persistent global variables (`[set_global_variable]`/
  `[get_global_variable]`/`namespace=`) — listed under Phase 2's gap list
  too; the durable-storage half of it belongs here alongside achievement
  persistence, since both need the same "survives outside any one
  scenario/save" storage layer.
- **Milestone**: a scripted scenario's full action sequence replays from a
  recorded log to bit-identical final state (units, gold, variables), the
  statistics dialog (feeds Phase 17) shows correct expected-vs-actual
  combat numbers for that same run, and defining one real achievement from
  a real campaign and completing its condition marks it earned and
  durable across a reload.

## Phase 16 — Advanced Map Rendering: minimap, labels, items, camera scripting (new)

**Status: not started.** Phase 4 delivered the core board (terrain/unit/
highlight layers, click handling, pan/zoom); this phase covers everything
catalogue category 2/16 lists that Phase 4/9 don't already own.

- `[item]`/`[remove_item]`: decorative or functional images placed on
  hexes, with optional halo and team colour, queryable via
  `[store_items]`.
- Map labels (`[label]`, text/colour/team-scoping/fog-visibility, cleared
  by an empty `[label]`).
- Minimap generation: downscaled terrain-colour map with unit dots and
  village-flag markers, click/drag-to-navigate, and (once Phase 11 lands)
  reflecting only the viewing side's known state.
- Camera scripting: `[scroll_to]`/`[scroll_to_unit]`/`[scroll]`,
  `[lock_view]`/`[unlock_view]` (cutscene input lock), `[zoom]` action,
  edge-of-screen panning preference, camera-follow-on-move preference.
- `[screen_fade]`/`[color_adjust]` cutscene effects (always clean up
  afterwards).
- Terrain help data (names/descriptions/help topics for the in-game
  encyclopedia — feeds Phase 17) and `[store_map_dimensions]`/
  `[store_starting_location]`/`[store_locations]`/`[store_villages]` (the
  querying half of category 2's map-state actions; some of this may
  already be trivially derivable from `GameMap`/`GameBoard` and just needs
  WML-facing verbs).
- **Milestone**: a real scenario using `[label]`, at least one `[item]`,
  and a scripted `[scroll_to]` cutscene beat all render/behave correctly,
  and the minimap accurately reflects the live board including village
  ownership flags.

## Phase 17 — Advanced UI Shell: hotkeys, mobile/touch, help, preferences (new)

**Status: not started beyond the core play loop (Phase 5).** This is the
UI chrome catalogue category 17 lists beyond "select a unit, move it,
attack, recruit, recall, save/load" — deliberately deferred out of Phase 5
so that phase could ship a playable loop quickly.

- Theme system (`[theme]`/`[resolution]`/`[panel]`/`[status]`/`[menu]`,
  `[change_theme]` at runtime) — may end up thin (a CSS-driven layout
  rather than a literal WML-theme interpreter), but should still honour
  scenario/campaign-declared themes where they matter.
- Keyboard shortcuts + rebinding (end turn, next unit, undo/redo, zoom,
  toggle grid, cycle units), right-click context menu + `[set_menu_item]`/
  `[clear_menu_item]`, unmoved-unit end-turn warning.
- Dialogs deferred from Phase 5: `[option]`/`[text_input]` player choices,
  advancement-choice dialog (preview the resulting unit), statistics
  dialog (feeds off Phase 15), unit-list dialog (sortable, click-to-
  centre), in-game help/encyclopedia (`[topic]`/`[section]`/`[toplevel]`/
  `[open_help]`, unit/terrain/ability help topics), preferences dialog
  (display/sound/hotkeys/advanced, persisted).
- Mobile/touch: collapsing sidebar, larger tap targets, tap-select/tap-
  move/long-press-context-menu/pinch-zoom, responsive layout on resize
  without losing game state.
- Campaign-list polish: difficulty chooser dialog, credits screen
  (`[about]`/`[entry]`/`[credits_group]`), campaign completion/progress
  persistence in the picker (deferred from Phase 1/6).
- **Milestone**: a full scenario is playable start-to-finish on a touch-
  sized viewport using only tap input, the help browser opens and shows a
  real unit's stat/ability page, and every core hotkey is rebindable and
  persists across reload.

## Phase 18 — CI/CD, Performance & Platform (new)

**Status: partially started informally.** Every engine/UI change in this
project already ships with real unit/integration tests and (per this
session's own discipline) real-browser Playwright verification before a
commit — but that's a per-session practice, not a CI pipeline, and none of
the deployment/performance/cross-browser items below exist yet.

- CI pipeline: lint + unit + integration + UI suites on every commit, with
  clear failure reporting (formalizes the testing discipline already
  practiced manually into an actual pipeline).
- Staging deployment (auto-deploy from `main`, reachable for manual
  testing) and tagged-release deployment with versioning/rollback.
- Performance regression tracking: load time, frame rate, memory measured
  in CI, with regressions failing the build — needs real budgets set
  first (none currently defined).
- Cross-browser compatibility matrix, offline/service-worker behaviour
  (cached-asset play without network), deep-linking/routing survives
  refresh (the campaign-picker routing work from Phase 5 is a good
  foundation here — verify it survives a hard refresh mid-scenario, not
  just client-side navigation).
- Error reporting: runtime errors surface to the player with a recoverable
  path and are logged for diagnosis, rather than a blank screen.
- Asset licence compliance (bundled art/music/data retain upstream
  attribution/licence files) and upstream data compatibility (unmodified
  upstream campaign `.cfg` files load without local patching — this is
  already mostly true by construction, since the project loads real
  `wesnoth/data/` content directly, but hasn't been asserted as an
  explicit regression test against a *diff* of the submodule).
- **Milestone**: pushing to `main` triggers a CI run covering all four
  package test suites plus a browser smoke test, a staging build is
  reachable at a stable URL, and a deliberately-broken build fails CI
  before it can deploy.

---

## Priority as of 2026-09-09 (superseded in sequencing detail by the 2026-09-10 catalogue pass above, but the near-term focus is unchanged)

Explicit user direction: focus on **Phase 5 (UI polish) and Phase 6
(content breadth)** now. Phase 7 (real AI) is deferred until Phase 5 is
solid — hotseat cycling stays as the stand-in until then. Phase 8 is
struck out for networked play only (see its 2026-09-10 clarification
above — replay/statistics is real, in-scope work, now Phase 15). Phases
9/10 (terrain visuals, unit animation) and the new Phases 11–18 are all
scoped but not started, queued behind Phase 5/6 unless redirected.

Phase 5 gap list, all now done:

1. ~~Unit selection visuals~~ — done: both a real contrast bug (highlight
   colours blending into Dead Water's terrain) and a real intermittent
   reactivity race were found and fixed, not just a cosmetic pass.
2. ~~Real per-unit-type stats~~ — done: real `base_unit=`-aware loading
   from `data/core/units.cfg`, spot-checked against real WML by hand.
3. ~~Victory/defeat conditions~~ — done (the default `no_leader_left` case;
   see `packages/engine/src/actions/victory.ts`'s doc comment for what's
   deliberately not modeled yet).
4. ~~Save/load~~ — done (gzipped IndexedDB).
5. Terrain image rendering stays deferred — now formally Phase 9.

**Current focus**: Phase 6 content breadth, starting with scenario
progression (Dead Water scenario 1 → 2, gold/recall carryover — done) and
continuing with the remaining Dead Water scenarios and the village/income
economy loop (done this session for the synthetic debug campaign; real
Dead Water villages/income now also work correctly as a side effect, since
the fix was made at the engine level).

---

## Appendix — Feature-catalogue coverage map

Every category from `~/wesnoth-feature-catalogue.md`, mapped to the
phase(s) responsible. Use this to sanity-check that a future phase
reshuffle hasn't silently dropped a category.

| # | Category | Phase(s) |
|---|----------|----------|
| 1 | WML Parsing & Data Model | 1 (core), 6 (long-tail hardening) |
| 2 | Map & Terrain | 1 (data model), 9 (terrain graphics), 16 (labels/items/minimap) |
| 3 | Units & Unit Types | 1 (core), 6 (variations/naming, long-tail) |
| 4 | Movement & Pathfinding | 2 (core), 11 (vision-gated movement halts) |
| 5 | Combat | 2 |
| 6 | Abilities | 2 (partial — generic pipeline is the main gap), 12 (illuminates) |
| 7 | Weapon Specials | 2 (partial — same generic-pipeline gap as 6) |
| 8 | Unit Modifications & Progression | 2 (core), 9/10 (rendering-dependent `apply_to=` variants) |
| 9 | Sides, Economy & Turn Flow | 2 (core, incl. this session's income/upkeep), 7 (AI), 15 (achievements) |
| 10 | Recruitment & Recall | 2 |
| 11 | Scenario & Campaign Flow | 2/5 (core), 6 (difficulty/options/branching) |
| 12 | Events & WML Scripting | 2 (core + long-tail gap list), 3 (`[lua]`) |
| 13 | Fog, Shroud & Vision | 11 |
| 14 | Time of Day & Schedules | 12 |
| 15 | Story, Dialogue & Narrative | 5 |
| 16 | Game View & Map Rendering | 4 (core), 9 (terrain compositing), 16 (minimap/labels/camera) |
| 17 | UI, Menus, Input & Localization | 5 (core play loop), 14 (localization/accessibility), 17 (chrome) |
| 18 | Animation & Visual Effects | 10 |
| 19 | Audio & Music | 13 |
| 20 | Persistence, Undo, Replay & Platform | 2 (undo), 5 (save/load), 15 (replay/statistics/achievements), 18 (CI/CD/perf/platform) |

Editor (`EditorWML`/`PblWML`) is explicitly out of scope per the
catalogue's own Appendix A and this plan's opening paragraph — no phase
covers it, deliberately.
