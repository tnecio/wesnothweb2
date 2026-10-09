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

## 2026-09-12 revision: UI split, gameplay-first ordering

User-directed reshuffle. Phases 0–12 keep their numbers (code comments cite
Phases 11/12); everything after is renumbered. Main changes:

- Phases 11 (fog/vision) and 12 (time of day) are the next focus — the
  last major gameplay systems — tested against Under the Burning Suns.
- The old UI bundle (parts of 14, all of 16/17) is split into seven
  areas: recruit/recall/combat modals (13), main game UI overhaul (14),
  main menu (21), keyboard shortcuts (core brought forward to 15;
  rebinding in 24), minimap/camera (22), mobile (23), advanced UI
  features (24). Modals and the main UI come before audio.
- New phases: narration overhaul (16), events incl. `[option]` and
  cutscenes (17), labels/items (18), save game handling (26), feature
  completeness assessment (27).
- Replay/statistics/achievements deprioritised (now 25).

See "Priority as of 2026-09-12" near the end for the full order and an
old→new number table for reading older `docs/PROGRESS.md` entries.

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
  consumed anywhere yet (feeds Phases 20/24).
- Round-trip serialisation (parse → re-serialise → re-parse identical) —
  needed for save-file fidelity beyond the current gzipped-JSON snapshot
  approach. The WML writer now exists (Phase 26 S2, `wml/writer.ts`,
  parse -> write -> parse tested on real content); the action-log side is
  Phase 18b's replay work.
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
  together): most of `[heals]`/`[regenerate]`/skirmisher/hides are still
  hand-coded narrowly rather than going through generic filter/effect
  evaluation. Real content leans on that generic machinery constantly
  (custom abilities, ability-scope flags `affect_self/allies/enemies`,
  `affect_movement/vision`). Some of this is now closed — see below —
  but it's not fully generalized.
  (2026-09-11: the *shorthand* half — `specials_list=`/`abilities_list=`,
  the comma-separated id list real mainline unit files almost universally
  use instead of inline `[specials]`/`[abilities]` — is now resolved, via
  `UnitTypeDatabase.collectSpecialRegistry()` and `UnitType`/
  `AttackType.fromConfig()`'s new `registries` param, keyed by
  `unique_id ?? id` and matched by real upstream's **tag name**, not
  `id=` — ability `id=` is a distinct display id in real content, e.g.
  every `heals`-tag entry sets `id=healing`/`id=curing`, never
  `id=heals`. Before this fix, most real specials/abilities were silently
  inert, including Dead Water's own healer Cylanna.
  2026-09-11 (cont'd): a real, tested-against-`data/core/macros/
  abilities.cfg` **query+composition engine** now exists
  (`packages/engine/src/actions/abilityEffects.ts`'s `getActiveAbilities`/
  `computeAbilityEffect`, a port of `foreach_active_ability`/`get_abilities`/
  `unit_abilities::effect`) — deliberately scoped to what
  `leadership`/`resistance` (steadfast) actually need: self vs. adjacent
  queries with `affects_side`/`affect_self`/`[affect_adjacent][filter]`
  (including WFL `formula=` with real `self`/`other`/`base_value`
  binding), and `value=`/`multiply=`/`max_value=`/`[filter_base_value]`/
  `priority=` composition. `[filter_self]`, `[filter_adjacent]` inside
  `[affect_adjacent][filter]`, non-adjacent `adjacent=` direction
  matching, and the weapon-special-only `EFFECT_CUMULABLE` mode are all
  still unported — none of the two abilities below need them. The
  deeper, fully generic filter/effect pipeline this bullet originally
  described (arbitrary custom abilities, `affect_movement`/`affect_vision`,
  etc.) remains open; revisit when real content demands a specific piece
  of it, per this project's standing philosophy.)
- ~~**`[leadership]`**~~ — now real (2026-09-11): `abilityEffects.ts`'s
  `computeLeadershipBonus`, evaluating the real
  `value="(25 * (level - other.level))"` formula, `cumulative=no`
  ("best bonus wins" with multiple adjacent leaders, not summed), and the
  real same-side-only adjacency scope. Wired into `combatStats.ts` via
  `UnitStatsOptions.attackerLeadershipBonus`/`defenderLeadershipBonus`,
  computed by callers with board access (`combat.ts`'s `executeAttack`,
  `GameSession.buildPreview`).
- ~~**Resistance-granting abilities (steadfast)**~~ — now real
  (2026-09-11): `abilityEffects.ts`'s `computeResistanceModifier`
  (`multiply=`/`max_value=`/`[filter_base_value]`/`active_on=`), wired
  into `combatStats.ts` via `UnitStatsOptions.attackerResistanceModifier`/
  `defenderResistanceModifier`.
- **`[illuminates]`** — still not implemented; upstream applies it via a
  dedicated, side-independent `tod_manager::get_illuminated_time_of_day`
  scan rather than the `affects_side` path the rest of the ability system
  uses, so it needs its own small piece of work on top of both the
  generic pipeline above and Phase 12's schedule model (which now
  exists, 2026-09-11).
- Teleport (`[teleport]` action *and* ability), `[tunnel]` routes (now
  scheduled as Phase 18a),
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
  (`[achievement]` family — tracked as Phase 25).
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
  `[killed]`/`[deaths]`) — tracked under Phase 25 (statistics &
  achievements).
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

### Catalogue checklist (category 15 done; category 17's "core play loop" slice done; remainder split across Phases 13–24)

Done: `[story]`/`[part]` playback, `[message]`/`speaker=`/portrait/
scroll-to-speaker, campaign picker, per-scenario routed pages, side panel
(unit info incl. position, gold/income/village display, weapon-choice UI,
recruit/recall lists with cost/affordability), objectives display (basic),
turn banner, save/load, end-turn hotseat cycling.

**Deferred** (not a Phase 5 gap so much as explicitly out-of-scope-for-
now UI chrome; now split — see the 2026-09-12 revision): `[option]`/`[text_input]` player choices,
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
satisfy. Now scheduled as Phase 17 (events), since it can block a
scenario's core logic from behaving sensibly at all, not just whether a
choice dialog shows up.

## Phase 6 — Content breadth

**Status: ongoing, no longer the headline focus** (2026-09-12: continues
as new phases pull in real content, e.g. UtBS for Phases 11/12). Dead Water scenario 1→2
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

**Two Brothers fully chained + a third campaign (2026-09-12)**: all 5
Two Brothers scenarios now build and chain end-to-end via the real UI
(forced-victory at each step, same technique as Dead_Water's own
chain) with zero engine/console errors — scenarios 1, 2, 4, and 5 also
confirmed rendering correctly (real story/board/terrain) in a live
browser screenshot. The `[option]` gap in scenario 3 is real and still
unfixed (`[message]`'s `variable=`/`[option]` children are silently
ignored by `actionMessage`, so the password exchange always takes the
"wrong password" branch) — not attempted here: doing this properly
needs the event pump to suspend mid-event for a live player choice and
resume afterward (this project's `[message]`/event execution is
currently 100% synchronous, with WML events run to completion before
their recorded messages are replayed to the player after the fact),
which is a real architecture change, not a small addition. Liberty (8
scenarios, the next-shortest mainline campaign after Two Brothers) was
then brought up the same way: builds cleanly end-to-end, registered in
`campaigns.json`, and all 8 scenarios chain via the real UI with zero
errors (scenario 1 also confirmed rendering correctly in a live
browser screenshot) — no gaps found in this pass. Dead_Water (13),
Two_Brothers (5), and Liberty (8) are now all fully buildable/
chainable mainline campaigns.

- AI-vs-AI (`simpleAi.ts`'s heuristic playing every side) was tried as a
  faster substitute for a real human playthrough, to find gameplay-shaped
  gaps beyond forced-victory chaining -- found instead that the current
  heuristic AI is too weak to reliably survive even Dead_Water scenario 1
  when playing the "player" side too (loses by turn 3), so a loss there
  conflates "AI is weak" with "engine has a real gap" and isn't a
  trustworthy signal without much deeper per-scenario investigation either
  way. A real (human-judgment-driven) playthrough, or a stronger AI, would
  still be needed to find the deeper gaps this phase's own goal calls for.

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

**Status: MVP delivered (2026-09-11).** `packages/engine/src/ai/
simpleAi.ts`'s `playAiTurn` is a real, working (if deliberately simple)
heuristic AI — not upstream's candidate-action framework (still a
60-file, substantially-Lua-driven system not worth porting yet, see
below), but every number it bases decisions on comes from the SAME real,
tested engine code a human's own UI uses: attack scoring reuses
`combatStats.ts`'s `buildBattleContext` + `attackPrediction.ts`'s
`simulateCombat` (leadership/steadfast/backstab included), movement uses
the real `reachableHexes`/`findPath` (ZoC-aware), recruiting uses the
real `checkRecruitLocation`/`findVacantCastleTile`/`recruitUnit`. The
decision policy itself (recruit greedily by hitpoints+damage-per-cost;
per unit, take the best-scoring reachable attack if it clears a
not-a-bad-trade threshold, else capture a reachable village, else close
distance to the nearest enemy) is a simple, documented heuristic, not a
port of anything upstream. Wired into `GameSession.endTurn`: ending a
human side's turn now auto-plays through any number of consecutive
`controller=ai`/`network_ai` sides and only returns once a human-
controlled side is reached (or the scenario ends), verified live in a
real browser against Dead Water scenario 1 (side 2, `controller=ai`) —
one "End Turn" click recruited 3 Soulless, moved the Dark Sorcerer, and
had a Skeleton attack a Merman Netcaster, landing back on side 1's turn
2 with the whole AI turn logged. 6 new engine tests
(`test/ai/simpleAi.test.ts`) plus a UI-level regression test cover
recruiting-until-unaffordable, taking a clearly-good trade, declining a
clearly-bad one, village capture, and closing distance.

- **Superseded by Phase 29** (2026-09-13): "port the candidate-action
  framework and relevant Lua micro-AIs" is now underway as its own
  phase (`docs/PHASE29_PLAN.md` has the full staged
  plan) rather than a deferred bullet here — real, dedicated scope, not
  optional. Real content leaning on `[modify_ai]`/`[aspect]`/`[facet]`/
  `[goal]`/`[stage]`/`[micro_ai]`/AI recruitment budgeting needs Phase 29,
  not this one.

### Catalogue checklist (category 9's AI bullets)

`[side]controller=ai` must act automatically and never hang -- now real
(the MVP heuristic here; the real RCA framework as of Phase 29).
`[modify_ai]`/`[aspect]`/`[facet]`/`[goal]`/`[stage]`, and AI recruitment
budgeting (`[recruitment_instructions]`/`[recruit]`/`[limit]`) are real
upstream surface Phase 29 covers — not needed for this phase's own MVP
heuristic, which reads `recruit=`/gold directly rather than any AI
configuration WML.

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
are tracked as real, in-scope work under **Phase 18b** (replay, undo &
redo).

## Phase 9 — Terrain visuals

**Status: real per-hex compositing delivered and live (2026-09-12).**
Rule parsing + client-side matching + `SnapshotBoard` wiring all land the
same day: real terrain art now renders in the actual game view (verified
live in a browser against the real Dead_Water scenario, cross-checked
against screenshots from the real Wesnoth binary on the identical map).
10,063 rules parsed, matching attempt #1's own oracle-verified count on
the same content exactly. See `docs/PROGRESS.md`'s two 2026-09-12
entries for the full account, including a real bug this surfaced (global
multi-hex image cropping, `center=`/`RuleImage.sourceLoc`) that WML
reading alone had wrongly written off as a minor edge case.
Second pass the same day fixed four real bugs (draw-time offsets, a
preprocessor quoting bug, paren-blind frame splitting, one truncating
division in `rotate()`) and the build cost (7.1s -> 0.43s via upstream's
own prefilter) -- see PROGRESS.md's second 2026-09-12 entry. Remaining:
ToD tinting (Phase 12), animation start-time jitter, `ImageCache.preload`
cost (~7s for ~3,400 masked crops), and more systematic screenshot
comparison beyond Dead_Water scenario 1.

Split out of Phase 4
(2026-09-09, user's call): real per-hex `[terrain_graphics]` image
compositing is large enough on its own, and is exactly one of the two
things that stalled attempt #1, to deserve its own explicit scope rather
than living inside "Phase 4 rendering" as an implicit, easy-to-forget gap.

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

### Re-scoping (2026-09-12), against real source

Attempt #1's approach (compile the real C++ engine to WASM, call
`terrain_builder::get_terrain_frames_at()` per hex through embind — see
`~/wesnothweb/doc/Refactor_display_layer.md`) got the imagery *right*
(measured to 1/255 against the engine's own oracle) but is a different
architecture from this project, which reimplements engine logic directly
in TypeScript (see `packages/engine/src/model/Terrain.ts`'s own doc
comment: "Deliberately NOT ported: `terrain/builder.cpp`... a rendering
concern for a later phase" — this phase). Re-reading
`wesnoth/src/terrain/builder.hpp`/`.cpp` (1280+842 lines) directly rather
than assuming attempt #1's shape still applies:

- `terrain_builder` has two phases upstream, and the port mirrors them:
  (1) **parse + build** `[terrain_graphics]` WML into a rule list, each
  rule a set of `[tile]` *constraints* (relative hex offsets + terrain-type
  match + flag conditions) each carrying `[image]`s (with `[variant]`
  sub-images filtered by `has_flag`/`tod`); rotation templates
  (`rotations=`) expand one rule into up to 6 concrete rules via a real
  hex-geometry rotation matrix (`rotate`/`rotate_rule`) plus `@Rn`/`@V`
  token substitution. This is static (independent of any specific map), so
  it belongs at **build time** in `apps/web/scripts/build-scenario-snapshot.mjs`
  (same place `core/terrain.cfg`/`core/units.cfg` already get preprocessed
  and parsed, per that script's own doc comment), *not* re-parsed in the
  browser — mirrors how `UnitTypeDatabase` ships already-flattened JSON,
  not raw WML, to the client.
  - `#meta-macro` (seen throughout `data/core/terrain-graphics/*.cfg`) is
    **not a real preprocessor directive** — confirmed against
    `preprocessor.cpp`'s directive dispatch (`"define"`/`"ifdef"`/
    `"textdomain"`/... /else `comment = true`): unrecognized `#word` lines
    are silently treated as comments. No support needed for it.
  - Dead_Water has no scenario-local `[terrain_graphics]` rules (checked),
    so the first milestone only needs `data/core/terrain-graphics/`.
  - `packages/engine/src/model/Terrain.ts` already ports
    `t_translation`'s `TerrainCode`/`terrainMatches`/`parseTerrainList`
    exactly (including the `*`/`!`/per-layer-wildcard semantics
    `ter_match` needs) — reused as-is, not reimplemented.
- (2) **match + apply rules against the live map, per hex**, is dynamic
  (terrain can change mid-scenario via `[terrain]`; ToD changes every
  turn) so it runs **client-side**, mirroring `build_terrains`/
  `rule_matches`/`apply_rule` (which rule) and `tile::rebuild_cache`/
  `get_terrain_frames_at` (which *variant*/frame, filtered by the tile's
  accumulated flags and current ToD, seeded by `get_noise()` — a 32-bit
  wraparound hash that must be replicated bit-exact via `Math.imul`/
  `>>> 0`, since it drives both `probability=` rejection and `@V`/variant
  random selection deterministically). Output feeds directly into the
  existing `TerrainFrame`/`TerrainLayer`/`makeLayerSprite` types in
  `packages/renderer/src/terrainPositioning.ts`, which already do the
  hex-cropping/positioning half of this and are otherwise unused today.
- Living in `packages/renderer/src/terrain/` (new), alongside
  `src/animation/` — WML-driven *imagery selection* lives in the renderer
  package by this project's existing convention, even though it has no
  direct PixiJS calls itself (`unitAnimation.ts` is the precedent).

### Catalogue checklist (category 2's terrain-graphics bullets, category 16's compositing bullets)

`[terrain_graphics]` base-tile rules, transitions (directional sprites
between adjacent terrain), `[variant]` probability/randomisation (seeded so
it's stable across reloads), `layer=` ordering (base/overlay/decoration vs.
units), `set_flag=`/`no_flag=`/`has_flag=` bookkeeping, structural-terrain
borders (keep/bridge/wall edge pieces against neighbours), off-map/border
background rendering, hidden-terrain display-as-alias, ToD colour tinting
applied consistently to terrain/units/overlays (ties into Phase 12).

## Phase 10 — Unit animation

**Status: attack-blow AND movement playback delivered (2026-09-11).**
Split out of Phase 4 (2026-09-09) for the same reason as Phase 9 —
attempt #1's other stalling point.

`packages/renderer/src/animation/` already had real, tested logic for
animation *selection* (context schema, filter matching, frame parsing);
what was missing was actually *playing* the selected animation against
the live board instead of drawing a static sprite. That playback half
now exists:
- `animation/playback.ts`'s `sampleAnimation` (new) is the pure "what
  should this animation show at elapsed time T" function: walks the
  `[frame]` sequence AND each frame's own bracket-range image
  sub-sequence, and applies the real `offset=` "frame value wins, else
  the animation-wide `particle::parameters_` value" merge rule (data
  that existed since Phase 4 but was never actually applied anywhere
  until now) to interpolate between the source/destination hex --
  driving both the attack lunge and (once wired) a movement slide.
- `SnapshotBoard.playAnimations` (new) is the PixiJS-side driver: plays
  any number of cues (e.g. an attacker's lunge and a defender's
  reaction) concurrently in real time via `requestAnimationFrame`,
  resolving once all finish. Required changing unit sprites from
  "destroy and rebuild every render" to persistent, reconciled
  `PIXI.Sprite`/marker pairs keyed by a stable per-unit identity
  (`GameSession.renderKeyFor`, a session-local `WeakMap<Unit, number>` --
  NOT the real engine `Unit.underlyingId`, which defaults to 0 and isn't
  reliably unique, see that method's own doc comment) -- a real, if
  secondary, visual fix on its own (every prior unit-state update used
  to flicker the whole unit layer).
- Wired into `GameShell.svelte`: confirming a human attack now plays
  each real blow's attacker+defender animation pair (lunge, frame/image
  cycling, hit/miss/kill-appropriate `defend` variant via the real
  `hits=` filter) before applying the attack's final state -- verified
  live in a real browser against both the synthetic Combat Debug
  scenario (real Spearman/Orcish Grunt art and `[attack_anim]`/`[defend]`
  data) and real Dead Water content, no console errors, correct timing
  (~4s for a 5-blow exchange). A unit type with no matching real
  animation still gets an honest synthetic lunge-and-return rather than
  silently doing nothing.
- **Movement (glide-between-hexes) playback is now also real**
  (2026-09-11, same session as the four user-reported bug fixes below):
  `buildMovementAnimationContexts` (context-builder, existed since the
  selection-only phase) now actually gets called, one real glide per hex
  entered. Needed two supporting real-upstream fixes, not guesses:
  `add_anims`' own `offset=` DEFAULTING for `movement_anim`/`attack_anim`
  (most real content, e.g. Elvish Fighter's walk cycle, declares no
  `offset=` at all — ported as `unitAnimation.ts`'s `withDefaultOffset`),
  and a generalized `UnitAnimationCue.restAt: 'src' | 'dst'` so a cue can
  end relocated (movement) instead of bounced back (attack). Per-step
  facing also needed its own fix (`executeMove` only sets `unit.facing`
  once, from a move's LAST leg) — worked around by computing each leg's
  direction directly via a new shared export, `Location.ts`'s
  `directionBetween`.
- **Four real bugs found by the user actually trying the feature, all
  fixed** (2026-09-11, see `docs/PROGRESS.md`'s own entry for the full
  writeup): a moved unit left a duplicate ghost sprite at its origin hex
  (a real async race in `SnapshotBoard.renderUnits`, fixed with a
  `renderQueue` promise chain); attack animations always showed the
  original attacker swinging even on a defender's retaliation blow (a
  real, previously-undiscovered bug in the pre-existing
  `buildAttackBlowAnimationContexts` — confirmed against real
  `actions/attack.cpp`'s `perform_hit`, which swaps attacker/defender
  roles PER BLOW, not just once for the whole exchange); no movement
  animation (see above); and hit vs. miss appearing indistinguishable
  (investigated directly — real Spearman's own `[defend]` content
  genuinely uses the same image for both, so this was likely just a
  symptom of the retaliation-swap bug, not a separate defect — flagged
  as not independently reproduced after the swap fix rather than
  silently assumed resolved).
- AI-played attacks (`GameSession.playAiSide`) are still instant,
  deliberately (see that field's own doc comment: animating every blow
  of every automated AI turn would slow `endTurn` for no benefit).
  Particles and halos are now drawn (2026-09-22, bugs6.md: every
  `[*_frame]` family as its own particle -- missiles included -- on a
  shared per-beat clock aligned on the blow, plus `halo=` images; see
  docs/PROGRESS.md). Sound-in-frame playback, submerge/highlight
  compositing and screen-shake remain unbuilt (see `frame.ts`'s
  `applyFrameEffects` stub and the catalogue checklist below).

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

## Phases 11 + 12 shared testbed: Under the Burning Suns

**Chosen 2026-09-12 (user's call)**: port Under the Burning Suns (UtBS)
alongside Phases 11/12 as their real-content fixture, the same way Dead
Water anchored Phases 4–6. Surveyed against the real `.cfg` files before
committing to it:

| Scenario | Exercises |
|---|---|
| `01_The_Morning_After` (**primary**) | `shroud=yes`, scripted `[remove_shroud]` (radius and x/y-range forms) + `[place_shroud]` reveal-then-rehide cutscene, `{TWO_SUNS_DEFAULT_SCHEDULE}` (15-step, two uneven days — `core/macros/schedules.cfg`), 86 `[message]`s, `[foreach]`, `[store_locations]`, `{ON_DIFFICULTY}` |
| `02_Across_the_Harsh_Sands` | `fog=yes`, `sighted` event, two-suns schedule |
| `03_Stirring_in_the_Night` | `[time_area]` |
| `04_Descending_into_Darkness` | `{UNDERGROUND}` + `[time_area]` + two-suns schedule |

**Pushback recorded with the choice**: scenario 1 alone covers shroud and
a non-default schedule well, but has *no* fog, `sighted`, `[time_area]`,
or underground schedule — so scenarios 2–4 are pulled in as secondary
fixtures for exactly those. Scenarios 2, 4 and 5 also use `[option]`,
which won't work until Phase 17: verify the fog/ToD behaviour there, and
treat any `[option]`-driven branch as a known Phase 17 gap (same
treatment as Two Brothers scenario 3), not as a Phase 11/12 bug.

## Phase 11 — Fog, Shroud & Vision

**Status: delivered (2026-09-12).** Every bullet below is real, tested,
and verified live against Under the Burning Suns (added as this phase's
testbed — see its own campaign entry, scenarios 1–4 built).

- Per-side shroud/fog state (`ShroudMap`, ported from `shroud_map`),
  `Team.shrouded`/`fogged` honouring `share_vision=`/legacy `share_view=`/
  `share_maps=`, and `GameBoard.isShrouded`/`isFogged` convenience
  wrappers. `unitCanAct`/pathfinding/AI all consult real fog-aware
  visibility (`pathfind/visibility.ts`'s `isUnitVisibleToTeam`/
  `getVisibleUnit`) instead of `seeAll` placeholders.
- Vision (`actions/vision.ts`'s `unitVisionPath`/`unitVisionRange`, real
  `vision=`/movement fallback) and jamming (`createJammingMap`) through
  real per-terrain vision cost, not straight-line radius.
- `sighted` event firing (`ShroudClearer`, `actorSighted`,
  `getSidesNotSeeing`) and move interruption on sighting: `executeMove`
  now mirrors `unit_mover` — hidden units are cached before moving (an
  unseen enemy on the route blocks it, an adjacent invisible one ambushes
  it), the unit steps hex by hex clearing fog, and stops at a reasonable
  hex once a unit comes into view.
- `[remove_shroud]`/`[place_shroud]`/`[lift_fog]`/`[reset_fog]` (with
  `multiturn=`/`reset_view=`), `[endlevel]`, and a scenario-lifetime event
  pump in `GameSession` that fires the real turn/side-turn/turn-refresh/
  side-turn-end sequence (with the matching `clear_shroud`/
  `recalculate_fog` calls) instead of only prestart/start once at load.
  `MoveResult.undoBlocked` mirrors `unit_mover::undo_blocked` (ambush,
  blocked, or fog changed).
- Rendering: `packages/renderer/src/fogShroud.ts` ports
  `display::get_fog_shroud_images` exactly (base void/fog cover plus the
  directional transition-sprite walk, including its real "frontier
  revisited" and "no void-all.png" quirks) into a new `fog_shroud` PIXI
  layer sitting above every unit layer, matching upstream's
  `drawing_layer` order; a shrouded hex's terrain is hidden entirely.
  `GameSession.renderUnits` filters by real visibility; `villageOwnership`
  shows the last-known owner while fogged, not the live one. Minimap
  fog-awareness is still Phase 22 (no minimap exists yet).
- `[filter_location]`/`[filter_vision]` in the Standard Unit Filter
  (`events/filter.ts`), covering `terrain=`/radius=/`[and]`/`[or]`/`[not]`
  and per-side fog/hides visibility respectively.
- AI (`simpleAi.ts`) now scores attacks/targets/pathing through its own
  side's real fog-aware visibility instead of seeing the whole board.
- Shroud/fog state serialisation: `SaveGameData`/`GameBoardSnapshot` both
  carry `shroud_data=`/`fog_data=` (round-tripped through `ShroudMap`).
- Found and fixed along the way: `checkVictory` only ever asked "which
  sides have a `canRecruit` unit right now", so a `no_leader=yes` AI side
  whose leader is placed by a later scripted event (UtBS's antagonists)
  read as already-defeated at scenario start, ending the level in an
  instant false "Victory!" — it now delegates to `GameBoard.
  teamIsDefeated` (honouring `no_leader=`/`lost`), with `noLeader` threaded
  through the snapshot pipeline. Also fixed `build-scenario-snapshot.mjs`'s
  `map_file=` resolution, which only tried `<campaign>/maps/<file>` (Dead
  Water's convention) and didn't handle UtBS's own `{UTBS_MAP}` macro
  (`map_file=` already rooted at `data/`) — both forms are valid per real
  Wesnoth's VFS search path, so the data-root-relative form is tried
  first now.
- **Milestone**: verified live — UtBS scenario 1 renders real terrain in
  the explored area with a solid black shroud covering the rest,
  in-play dialogue/`moveto` messages display in order, and 6 turns cycle
  across all 4 sides (AI-controlled included) with zero console errors
  and no false victory/defeat. Not separately re-verified: UtBS scenario
  2's `fog=`/`sighted` combination and a save/load round-trip specifically
  on a fogged save (both are exercised by the same real, tested code
  paths as scenario 1, but weren't play-tested end-to-end here).

## Phase 12 — Time of Day & Schedules

**Status: delivered (2026-09-13).** Every bullet below is real, tested,
and verified live against Dead Water (default schedule) and Under the
Burning Suns (its own two-suns schedule, `[time_area]`).

- `Schedule` (`packages/engine/src/model/Schedule.ts`) is now genuinely
  stateful, mirroring `tod_manager` itself rather than a one-shot parse:
  the global schedule and every `[time_area]` are each an "anchored
  sequence" (a turn number + the index active on it), so turn advancement
  needs no per-turn mutation -- creating an area or replacing the
  schedule just re-anchors at the turn it happens on.
  `random_start_time=` (boolean or a comma-separated list of 1-based
  indices) is resolved once at construction via the session's own RNG,
  matching `tod_manager::resolve_random`'s exact draw sequence.
- `[time_area]`/`[remove_time_area]` (`events/todWml.ts`): a named region
  following its own schedule, reusing Phase 11's `findLocations` for the
  standard location filter. Overlapping areas resolve most-recently-added
  wins, matching upstream's reverse iteration. `[replace_schedule]`
  replaces the global schedule outright; `[store_time_of_day]` writes the
  (non-illuminated) ToD fields into a WML array variable.
- `[illuminates]` (`actions/illumination.ts`): every real mainline
  definition (`value=25, max_value=25`, default radius=1) shifts the
  lawful bonus at a hex, including the net-darker/net-brighter
  composition upstream uses when multiple sources overlap.
  `effectiveTimeOfDayAt` combines this with `Schedule.timeOfDayAt` into
  the one function combat/rendering/event-filter code calls.
- Location-aware combat: `combat_modifier` computes the attacker's and
  defender's ToD bonus SEPARATELY from each unit's own hex (they can
  differ: a lit radius, a `[time_area]` boundary) -- this project used to
  apply one shared global value to both. Fixed throughout combat.ts/
  simpleAi.ts/GameSession's three real call sites; `GameBoard.
  lawfulBonusAt` (the `[filter_location] time_of_day=` hook) is now
  genuinely location-aware too.
- Rendering: `SnapshotBoard.updateTimeOfDayTint` reconstructs
  `image::set_color_adjustment` (the real per-channel additive/clamp tint
  every terrain/unit/fog blit gets) as a single composite step -- an
  `'add'`-blended rect for positive channels, a `'subtract'`-blended one
  for negative, both covering the whole board above the fog/shroud layer.
  Chosen over the already-built-but-unwired per-texture `~TOD()`
  pseudo-op (`animation/timeOfDay.ts`) to avoid re-resolving and caching
  a second copy of the whole terrain atlas every time the schedule
  advances. Real bug found by testing live: PixiJS v8's `'subtract'` is
  an advanced (shader-based) blend mode needing its extension registered
  and `useBackBuffer: true` on the renderer -- without both, it silently
  rendered the whole board solid black. Per-`[time_area]` regional
  tinting (a visually different tint just for that region) is a
  deliberate, documented gap -- the combat/event-filter consequences that
  actually matter for gameplay are already fully correct.
- ToD state serialisation: `Schedule.exportState`/`importState` round-trip
  the mutated global schedule and every active `[time_area]` through
  `SaveGameData`, optional on read so older saves still load.
- Underground/indoor fixed-darkness schedules (`{UNDERGROUND}`/
  `{INDOORS}`) needed no new code -- they're just a single `[time]` entry,
  handled by the existing generic parsing (verified via UtBS scenario 4).
- **Deliberately not ported** (see each module's own doc comment):
  `calculate_best_liminal_bonus`'s exact search heuristic (a flat `25`
  floor is used instead, matching upstream's own floor value); terrain-
  type `light=`/`max_light=`/`min_light=` feeding into illumination's
  base value (`TerrainType` doesn't model these fields); a schedule-
  preview dialog (Phase 24 UI chrome).
- **Milestone**: verified live -- real Dead Water shows a visibly
  darker/cooler board at turn 5 (First Watch) than turn 1 (Dawn), with
  the status bar's ToD name/icon updating correctly throughout; Under the
  Burning Suns scenario 3's real `[time_area]` (three campfire clusters)
  gives a hex inside it a different ToD than a hex outside every
  campfire's radius, confirmed both live and as a real-content
  integration test.

## Phase 13 — Modal dialogs: recruit, recall, combat

**Status: delivered (2026-09-13)**, branch `phase-13-modals`, with
follow-ups in the bugs4.md/bugs5.md rounds (see docs/PROGRESS.md). Every
bullet below is real: `Modal.svelte` is the shared framework and all six
dialogs use it (recruit, recall, attack, combat simulation, plus the
migrated advancement and objectives dialogs), and the side panel no
longer carries inline recruit/recall lists. First of the UI areas split
out of the old Phase 14/16/17 bundle (2026-09-12, user's call),
prioritised ahead of audio because it's what a player touches every
single turn.

Spec sources (data shape and behaviour, not ported code — GUI2 itself
stays out of scope): `src/gui/dialogs/units_dialog.cpp`
(`build_recruit_dialog`/`build_recall_dialog` — one dialog serves both),
`unit_attack.cpp`, `attack_predictions.cpp`, and their layouts under
`data/gui/themes/default/dialogs/`.

- A shared modal framework (overlay, focus trap, Escape/Enter handling,
  Wesnoth-GUI2-like visual style) that Phases 14/16/17/21/24/26 reuse
  rather than each dialog rolling its own. Existing `AdvancementDialog`/
  `ObjectivesDialog` migrate onto it.
- Recruit dialog: unit-type list with portrait, cost, affordability
  greying, and a detail pane (stats, attacks, resistances, traits) for
  the highlighted type; opened from the keep, recruits onto the chosen
  castle hex.
- Recall dialog: recall list with name/type/level/XP/traits, sorting,
  recall cost (incl. per-unit `recall_cost=`), and dismiss-unit with
  confirmation.
- Attack dialog: weapon list per attacker/defender pairing with
  damage×strikes, specials, and chance-to-hit, best weapon preselected.
- Combat simulation (damage calculations) view: per-side HP distribution
  bars and expected-damage breakdown from the existing
  `attackPrediction.ts`, matching `attack_predictions.cpp`'s layout.
- **Milestone**: a Dead Water scenario 1 turn — recruit, recall,
  inspect the damage calculation, attack — is completed entirely through
  the modals with the side panel's inline versions removed, verified in a
  Playwright run.

## Phase 14 — Main game UI overhaul

**Status: delivered (2026-09-13)**, branch `phase-14-mainui`, with
follow-ups in the bugs4.md/bugs5.md rounds (see docs/PROGRESS.md) --
**except two bullets still open**: the unmoved-units end-turn warning and
`[change_theme]`. The top menu/status bar, infobox, right-click context
menu, `[set_menu_item]`/`[clear_menu_item]` and the command registry
(`packages/ui/src/commands.ts`) are all real. Goal: the in-game screen
matches the real Wesnoth default theme closely. Spec source: `data/themes/default.cfg`
(`[theme]`/`[resolution]`/`[panel]`/`[status]`/`[menu]`) and
`src/hotkey/hotkey_command.cpp` for the menu command set.

- Top menu bar (Menu, Actions, and the real theme's menu entries) and the
  top status bar (turn/limit, gold, villages, units, upkeep, income, ToD
  icon + tooltip, schedule preview) in the real layout.
- Right-hand unit infobox matching the real theme: portrait/sprite,
  name/type, level, alignment, traits, HP/XP/MP bars, resistances tooltip,
  attacks list, status icons (poisoned/slowed/petrified), plus terrain
  info for the hovered hex.
- Right-click context menu (move/attack/recruit/recall/label/etc. per
  hex, per the real hotkey handler's context-sensitive enablement) and
  `[set_menu_item]`/`[clear_menu_item]` custom WML menu entries.
- A single **command registry** (Wesnoth's `HOTKEY_COMMAND` model: id,
  label, enabled-predicate, handler) that the menu bar, context menu, and
  Phase 15's hotkeys all dispatch through — built once here so keyboard
  support is wiring, not a retrofit.
- Unmoved-units end-turn warning; `[change_theme]` honoured to the extent
  real campaigns use it.
- **Milestone**: side-by-side screenshots of Dead Water scenario 1 against
  the real Wesnoth binary show matching chrome layout (menu bar, status
  bar, infobox), and every core action is reachable from the menu bar or
  the right-click menu.

## Phase 15 — Keyboard shortcuts (core)

**Status: delivered (2026-09-20)**, branch `phase-15-hotkeys`, stages
H0-H4; see docs/PROGRESS.md. The milestone playthrough
(`apps/web/scripts/keyboard-playthrough.mjs`) drives recruit, move,
attack and end turn with no clicks at all. Brought forward from the old
Phase 17 (2026-09-12). Two reasons: Phase 14's command registry makes this cheap
immediately afterwards, and Playwright tests become shorter and less
coordinate-fragile when actions like end turn, undo, recruit, next unit
and zoom are one keypress instead of a pixel click on a menu. Rebinding
UI stays in Phase 24 (it lives in the preferences dialog).

- Default bindings matching upstream `data/core/hotkeys.cfg` (end turn,
  undo/redo, next/previous unit, recruit, recall, show enemy moves, toggle
  grid, zoom in/out/default, save/load, objectives, statistics, unit list,
  labels, help, …) dispatched through Phase 14's registry.
- Keyboard navigation inside every modal (arrows/Enter/Escape/Tab) and a
  keyboard hex cursor (move selection, select, move/attack confirm) so the
  play loop is completable without a mouse.
- Hotkey hints shown in menu entries and tooltips.
- **Milestone**: a scripted Playwright playthrough of the synthetic
  economy campaign's recruit→move→attack→end turn loop drives every
  non-hex-choice action via keyboard only.

**Scope note (2026-09-20).** Three of the bullet list's example bindings
have no feature behind them yet and are therefore *not* in this phase:
`undo`/`redo` (the engine has a tested `UndoStack`,
`actions/undo.ts`, from Phase 2, but `GameSession` never uses it -- wiring
it up is Phase 18b), `togglegrid` and `statistics`/
`unitlist` (no such views). They get their upstream bindings when the
features land. Everything else below is wired to something real.

| # | Stage | Checkable outcome |
|---|---|---|
| H0 | **Hotkey model.** `commands.ts` gains `Hotkey` (`key` + ctrl/shift/alt, with ctrl meaning cmd on macOS), `matchesHotkey(event, hotkey)` and `formatHotkey(hotkey)` for display; `Command` gains an optional `hotkey`. Dependency-free, so it unit-tests headlessly. | Unit tests over key matching (modifier exactness, case, macOS cmd) and label formatting |
| H1 | **Global dispatcher + existing commands.** A `svelte:window` keydown handler in `GameShell` dispatches to the active command list, ignoring repeats, typing targets (`input`/`textarea`/`contenteditable`) and any open modal. Upstream bindings for what exists today: end turn `ctrl+space`, recruit `ctrl+r`, recall `alt+r`, objectives `ctrl+j`, save `ctrl+s`, load `ctrl+o`. | Each binding fires its command in a ui test; none fire while a dialog is open |
| H2 | **Commands the play loop needs.** Next/previous unit (`n`/`shift+n`, cycling own units that can still act, scrolling each into view), scroll to leader (`l`), zoom in/out/default (`=`/`-`/`0`, reusing `GameBoardView`'s existing pan/zoom state), deselect (`Escape`). | Cycling order matches "can still act", zoom clamps to the existing limits |
| H3 | **Keyboard hex cursor.** Arrow keys move a cursor hex (hex-grid directions, not a square grid), `Enter` acts on it exactly as a left click does (select / move / attack), `Escape` deselects; the cursor is drawn and scrolled into view. | Move + attack completed from the keyboard alone in a ui test |
| H4 | **Modal nav, hints, milestone.** Arrow/Enter selection inside the recruit, recall and attack dialogs (on top of `Modal`'s existing Escape/Tab/focus handling); hotkey hints rendered in menu entries; the Playwright milestone run. | The milestone playthrough above, plus hints visible in the menus |

## Phase 16 — Narration & story-telling overhaul

**Status: delivered N0–N8 (2026-09-14)**, see docs/PROGRESS.md. Story
screen, `[message]` dialog and campaign outro are ports of upstream; story
art per part dropped from 6 MB (never actually loaded before) to under
1 MB, and Next responds in ~450 ms (the two fades) once the board's render
loop pauses under the story. Verified against 1.16.9 reference captures
(`apps/web/scripts/reference-story-screenshots.mjs`) and headless
Chromium (`story-screenshots.mjs`, `measure-story.mjs`). Open follow-ups:
- first story part can take ~3–4 s to finish fading in on cold load
  while the board's textures are composited on the main thread -- move
  `ImageCache` compositing to an OffscreenCanvas worker (Phase 28);
- `[message]` speaker hex highlight and smooth scrolling; in-order,
  blocking dialogue and `[option]` (Phase 17); story/outro music, sound
  and voice playback (Phase 19, fields already parsed);
- mobile: the in-game layout itself (Phase 23); the dialog falls back to
  the full window on narrow boards.

Original plan (`StoryViewer.svelte`/`MessageViewer.svelte` worked but didn't
match upstream visually and loaded slowly). Spec sources:
`src/gui/dialogs/story_viewer.cpp`, `storyscreen/{parser,part}.cpp`,
`wml_message.cpp`, `outro.cpp`, `data/lua/wml/message.lua`,
`data/gui/themes/default/{dialogs/story_viewer,widgets/panel_story_viewer,dialogs/wml_message,dialogs/outro}.cfg`.

**Findings that correct the original spec:**
- Upstream shows the story *before* `prestart` and concatenates **all**
  `[story]` children (Dead Water 1's journey track is a second `[story]`,
  dropped today). `[if]`/`[switch]` inside `[story]` (710/30 occurrences in
  story-bearing scenarios) evaluate against carried-over variables.
- Message portraits are **not** placed by side: default left; `~RIGHT()`
  suffix or `image_pos=` puts them right; `mirror=`, `second_image=`.
- Today's `extractStory` (build time) keeps only text + first background
  layer of the first `[story]`.

**Performance facts:** scenario JSON ~2.3 MB (87% `unitTypeConfigs`) gates
story start; story art is served raw and never preloaded (Dead Water
`maps/dw.webp` 1.49 MB, Liberty 340–490 KB; `The_Rise_Of_Wesnoth/images/story`
alone is 23 MB); the Pixi board keeps rendering under full-screen overlays.

**Decisions (user, 2026-09-14):**
1. Title font: a self-hosted, openly licensed web font (bundled via npm,
   not a runtime CDN) instead of upstream's `WesScript`.
2. Build-time derived story/portrait images now: re-encoded, lower
   resolution WebP variants (measured: `dw.webp` at 1024 px wide, q80 →
   139 KB, 0.45 s with ImageMagick), originals as fallback.
3. Visual reference: `/usr/games/wesnoth` 1.16.9 under `xvfb-run` is good
   enough — layout parity, not pixel parity.

| # | Stage | Checkable outcome |
|---|---|---|
| N0 | Baseline measurement | perf marks: campaign click → first story paint, part→part, bytes per part (cold/warm) in PROGRESS |
| N1 | Engine story resolver (`engine/src/story/`, port of `parser.cpp`/`part.cpp`): all `[story]`s, layers, `[image]`, title, layouts, music/sound/voice fields, `[if]`/`[switch]`; resolved in `GameSession` before `runStartupEvents`; `extractStory` removed | tests on Dead Water 1 (5 parts + journey with `base_layer`), `[if]`/`[switch]` with carryover, Liberty/UtBS openings |
| N2 | Build-time image pipeline: `apps/web/scripts/build-story-images.mjs` walks every story/portrait reference, emits WebP variants (e.g. `w960`, `w1920`, never upscaled) into `public/derived-images/` + `image-manifest.json` (`{w,h,bytes,variants}`); incremental via mtime/hash; `imageUrl` picks the smallest variant ≥ viewport × DPR | manifest covers all references; Dead Water map ≤ 200 KB at 1024 w |
| N3 | Pure layout functions implementing `story_viewer.cpp:159-226` (base-layer scale drives overlay coords, tiling, `centered`, title/text positions) | hand-computed rects at 1920×1080 and 390×844 |
| N4 | `StoryViewer` rewrite: absolutely positioned DOM layers, `delay=` overlay timers (cancelled on part change), title + decor in the web font, text panel top/middle/bottom, ~200 ms fade, Back/Next, Space/Enter/Right, Backspace/Left | component tests; old story path gone |
| N5 | Performance: preload + `img.decode()` next part (current/prev/next LRU); 150 ms loading indicator, 5 s no-art fallback; small story payload fetched in parallel with the snapshot; Pixi ticker paused while fully covered; no `backdrop-filter` blur | budgets below met, numbers in PROGRESS |
| N6 | Message dialog: `RecordedMessage` enriched via port of `message.lua` `get_image`/`get_caption`; layout per `wml_message.cfg`; portrait preload; camera-focus API for scroll-to-speaker | enrichment tests (`~RIGHT()`, `image_pos`, `image=none`, `second_image`, caption fallbacks) |
| N7 | Outro/credits: `end_text`, `end_text_duration`, `end_credits`, campaign `[about]` → `campaigns.json`; `outro.cpp` timings | tests + live check |
| N8 | Verification + docs: Dead Water/Liberty/UtBS openings next to 1.16.9 screenshots; live browser at desktop and phone widths | screenshots + PROGRESS |

**Budgets:** first story text ≤ 500 ms (warm cache); preloaded next part
within one frame + fade; indicator after 150 ms if art isn't ready; no
main-thread task > 50 ms while a story is open; board idle while covered.
Music/sound/voice are parsed and surfaced as hooks only (playback is Phase 19).
Blocking/in-order messages and `[option]` stay in Phase 17.

- **Milestone**: Dead Water's, Liberty's and UtBS's opening stories render
  with matching layout next to the reference binary's screenshots, and no
  part takes more than a brief, visibly-indicated load.

## Phase 17 — Events: in-order dialogue, cutscenes, `[option]`

**Status: delivered E0–E7 (2026-09-20)**, branch `phase-17-events`; see
docs/PROGRESS.md. The event pump suspends now, so dialogue and action
interleave as upstream's do and a `[message]` can ask the player
something and use the answer.

The gap this closed: the pump was fully synchronous, so events ran to
completion and their `[message]`s were replayed to the player
afterwards. Phase 16 had worked around the resulting mismatch with
`RecordedMessage.unitsBefore` (a per-message snapshot of every unit's
position, so the UI could fake a board in sync with the story) — deleted
here, because the live board is now simply correct at each line.

**Approach: generators, not promises.** `packages/engine` has no
`async`/`Promise` anywhere and ~30 synchronous call sites fire events, so
a blocking handler returns a generator that yields an `Interaction` and
is resumed with its result (`events/interaction.ts`); `pump()`/`fire()`
keep their synchronous signatures by driving those with a pure
`autoRespond`, leaving every headless caller and test unchanged. Only
`packages/ui`'s `GameSession` steps the generator itself and parks on a
real dialog. This also closed the nested-fire divergence `pump.ts` had
documented since Phase 2 (`ctx.fireNow`, and a real `[fire_event]`).

| # | Stage | Delivered |
|---|---|---|
| E0 | Suspendable pump: `Interaction`/`Flow`/`runFlow`, `runActionFlow`, `ctx.fireNow`, `[fire_event]`, per-context skip flag | mechanism only, zero behaviour change, full suite green |
| E1 | Blocking `[message]`: `[option]` (`[show_if]`/`label=`/`message=`/`description=`/`image=`/`default=`/`value=`/`[command]`), `[text_input]`, `variable=`, `side_for=`, Escape-skip, choices recorded in upstream's `[input]` shape | 13 tests |
| E2 | Flow control (`flowWml.ts`): `[while]`/`[for]`/`[foreach]`/`[repeat]`/`[switch]`/`[command]` + `[break]`/`[continue]`/`[return]` | 12 tests |
| E3 | Cutscene and camera beats (`cutsceneWml.ts`): `[delay]`, `[scroll_to]`/`[scroll_to_unit]`/`[scroll]`, `[lock_view]`/`[unlock_view]`, `[zoom]`, `[color_adjust]`/`[screen_fade]`, `[move_unit_fake]`/`[move_units_fake]`, `[animate_unit]`, `[kill]`/`[unit]` `animate=`, `[move_unit]`'s walk | 7 ordering tests |
| E4–E5 | `GameSession` drives the pump through an `InteractionHost`; `MessageViewer` shows one line at a time with options and a text field; `unitsBefore` deleted | ui suite green, live browser |
| E6 | `[set_variable] rand=` on the synced RNG; WML variables across a scenario boundary and a save | 6 tests |
| E7 | Milestones, browser script, docs | below |

- **Milestone (met)**: Two Brothers scenario 3's password puzzle takes
  the branch the player actually chooses (`phase17Milestone.test.ts`),
  and Dead Water 5's opening cutscene shows its `[move_unit_fake]` ghost
  flight, spawn and dialogue in source order (same test, and
  `apps/web/scripts/dialogue-playthrough.mjs` in a real browser). The
  browser script answers its `[option]`/`[text_input]` prompts on a new
  synthetic debug campaign rather than on Two Brothers 3, which cannot
  be entered cold: its prompt is spoken by Arvith, who arrives on the
  recall list from scenario 2, so `message.lua`'s own `get_speaker` rule
  skips the message when the scenario is opened directly. The cutscene half moved from UtBS 1 (user's call, 2026-09-20):
  UtBS 1's events are near-pure dialogue — it has no `[move_unit_fake]`
  and no scrolls — so it verifies `[foreach]` and message ordering
  instead.

**Deviations, recorded rather than hidden.** `[message] duration=` is
named in this plan but does not exist in current mainline (nothing in
`message.lua` or `wml_message.cpp` reads it), so it is not implemented.
An AI side resolves its whole turn before any of it is animated, so
events raised during an AI turn (and the `last breath`/`die` events
`performAttack` fires from a plain callback) cannot stop for the player:
they are answered inline and their dialogue shown after the animations,
as *all* dialogue was before this phase — revisit with Phase 29.
`male_message=`/`female_message=` fall back to the plain text (no gender
in this port's `Unit` yet), and `[animate_unit]`'s
`[primary_attack]`/`hits=`/`[facing]`/nested `[animate]` are out (the
renderer plays one named animation per cue).

## Phase 18 — Map labels & items

**Status: delivered 2026-09-26.** Items (`[item]`/`[remove_item]`/
`[store_items]`, scenario-level `[item]`s, halos, `[filter_team]`/
`team_name=`/`visible_in_fog=`/`z_order=`), labels (`[label]`, per-team,
scenario-level, fog/shroud flags), player labels (Place Label Alt+L /
Ctrl+L team-only, context menu, Clear Labels Ctrl+C; recorded as
upstream's non-undoable replay commands), Label Settings, and
`[store_map_dimensions]`; all saved and carried through Wesnoth saves.
Campaign images are now searched before core (upstream's binary-path
order), which runtime WML images needed. Not done: item `submerge=`
(drawn whole), `~NO_TOD_SHIFT()` items (tinted like the rest), Pango markup
in labels (shown as plain text), label tooltips. See `docs/PROGRESS.md`.

Original scope (split from the old Phase 16):

- `[item]`/`[remove_item]`: decorative or functional images placed on
  hexes, with optional halo and team colour, `visible_in_fog=`, queryable
  via `[store_items]`.
- Map labels: `[label]` (text/colour/`team_name=`/`visible_in_fog=`/
  `immutable=`, cleared by an empty `[label]`), plus player-placed labels
  via the Phase 14 context menu and a label-settings dialog
  (`label_settings.cpp`).
- `[store_map_dimensions]`/`[store_starting_location]`/`[store_villages]`
  WML-facing verbs where not already present.
- **Milestone**: a real scenario using `[label]` and at least one `[item]`
  renders both correctly, including under Phase 11's fog.

## Phase 18a — Teleport and the hotseat viewing side (planned 2026-09-22)

**Status: delivered T1–T6 (2026-09-23)**, see docs/PROGRESS.md. Location
filters gained `gives_income=`/`owner_side=`/`formula=` (with
`teleport_unit`/`unit_at`); `pathfind/teleport.ts` ports `teleport.cpp`;
A*, reachable hexes and `executeMove` use teleports; `[teleport]`/
`[tunnel]` tags; tunnels saved; pre/post_teleport animation; Silver Mage
station; `GameSession.viewingSide` for hotseat. Left open: vision paths
ignore teleports, `[tunnel]` variables are not re-substituted per use,
no hotseat "hand over" dialog. Originally scheduled from bugs6.md. Both are gaps found while adding debug stations to
the Abilities & Specials synthetic scenario.

- **Teleport, ability and action.** Port `pathfind/teleport.cpp`
  (`teleport_map`, `[tunnel]` with `[source]`/`[target]`/`[filter]`,
  `bidirectional=`, `always_visible=`, `pass_allied_units=`) and feed it
  to `astar.ts`/`pathfind.ts` (both currently document it as not ported)
  and `executeMove` (`try_teleport`, a blocked exit failing the move,
  `teleport_failed`). `ABILITY_TELEPORT`'s tunnel filters use WFL
  location formulas (`owner_side`, `unit_at(loc)`, `teleport_unit`), so
  location filters need `formula=` support -- today only unit filters
  have it (`events/filter.ts`). Then the `[teleport]` ActionWML tag, the
  `pre_teleport`/`post_teleport` animations (`[teleport_anim]` is already
  parsed) and the reach overlay showing teleport destinations.
- **Abilities & Specials station**: a Silver Mage on one side-1 village
  with a second side-1 village elsewhere (row y=35 is reserved for it in
  `synthetic-campaigns/abilities/maps/abilities.map`).
- **Hotseat viewing side.** The board is always drawn from
  `GameSession.playerSide` (side 1), so on another human side's turn its
  fog, shroud and hidden units (e.g. an ambusher) are shown from side 1's
  point of view. Upstream switches the viewing team to the current human
  side (`play_controller::update_gui_to_player`). Low priority (user,
  2026-09-22).
- **Milestone**: the Silver Mage teleports between the two villages using
  one move and the reach overlay offers it; ending side 1's turn in the
  Ambush station hides the Ranger from side 2.

## Phase 18b — Replay, undo & redo (split from Phase 25, 2026-09-23)

**Status: delivered (2026-09-23)** -- R0–R7 in commits `1d7a3eb`,
`575f735`, `b21be21`, `d0ac1ca`. What landed, and where it differs from the
plan below:

- Every state change -- the player's, the AI's (`AiCommandHost`), a
  replay's and a redo's -- runs as one synced command through one executor
  (`GameSession.runSynced`/`execCommand`); the log, with `[random_seed]`/
  `[input]`/`[choose]` dependents and a state digest per command, is saved
  with the state it starts from. Per-action seeds as upstream's default
  `random_mode` (real entropy in the browser, derived from the session seed
  headless); `deterministic` kept.
- Replay: headless (`GameSession.forReplay`/`replayCommand`) with a
  divergence report per command, and the minimal viewer ("Show replay" in
  the Load dialog: play/pause, restart, continue playing).
- Undo/redo (`u`/`r`, menu entries, `[undo_stack]` in saves) as upstream's
  step containers, with `[allow_undo]`/`[disallow_undo]`/`[on_undo]`.
  **Deviation from milestone 2 as planned:** a recruit that draws random
  numbers (traits, gender, name) cannot be undone -- upstream's rule
  ("Removed the possibility to undo unit recruits because it caused oos";
  any synced draw blocks undo), so "redo repeats the recruit with the same
  traits" does not arise; recalls, dismissals and moves undo and redo
  exactly. There is no `[on_redo]` upstream (redo re-runs the command).
- Real `[replay]` both ways. Replaying through the real 1.16.9 binary
  found and fixed real rules gaps: unit creation's synced draws (gender,
  race-resolved trait pools in upstream's order, name-generator draw
  counts), `place_recruit`'s event order (`prerecruit` was never fired),
  `$unit`/`$second_unit`, `[disallow_recruit]` (so `LIMIT_RECRUITS` never
  worked), recruit-list validation, and moves recorded as walked.
- **Milestone 3:** a Dead Water 1 game played here opens in the real binary
  with `--with-replay` and replays all its commands; seeds, recruits
  (traits included) and moves stay in sync until the first fight, where
  this port's missing trait effects (e.g. resilient's hitpoints) change the
  outcome. **Milestone 4:** the real binary's own `[start]` (seed
  `e5eacb0f`) gives the same 11 units, traits and genders here; a real AI
  game (fixture) replays through turn 1 to the real game's turn-2 board,
  except Walking Corpses, whose swimmer variation is an `[object]`. Both
  divergences are Phase 18c's.

User decisions (2026-09-23):

- **Per-action RNG seeds**, as upstream's default `random_mode`: a reload
  before an attack gives a new roll; replays stay exact. A deterministic
  whole-game stream remains as an option for tests and AI benchmarks.
- **Real-binary compatibility both ways**: export a real `[replay]`
  (verified with `wesnoth --with-replay`) *and* import and replay real
  Wesnoth replays here.
- **Minimal replay viewer**: play/pause and restart, opened from the Load
  dialog.

### Where things stand

| Fact | Consequence |
|---|---|
| Human actions go through `GameSession` (`performMove`, `confirmAttack`, `tryRecruitAt`/`tryRecallAt`, `dismissRecallUnit`, `endTurn`, `runMenuItem`); AI actions through `ai/context.ts`'s executors; both end in the same engine functions | One command layer under both is enough to record, replay and redo everything |
| One `MtRng` stream for the whole game, saved as seed + call count | Replays work only if every draw happens in the same order; one divergent draw corrupts the rest of the game |
| Upstream's default `random_mode` seeds a **fresh RNG per action**, lazily on its first draw, and records the seed as a dependent `[random_seed]` command | Replays are deterministic and a divergence stays inside one action -- and reloading before an attack gives a new roll, as in the real game |
| Real saves: `[replay_start]` (scenario before prestart) + `[replay]` of `[command]`s -- `[move]` (steps), `[attack]` (source/destination/weapons), `[recruit]`/`[recall]`/`[disband]`, `[init_side]`, `[end_turn]`, `[fire_event]` (menu items), dependent `[random_seed]`/`[input]` | The log format to emit and read (`replay_helper.cpp`) |
| `[checkup]` blocks are optional: a replayed command without one is simply not checked (`synced_checkup::local_checkup`) | Our exported replay can omit upstream checkups instead of matching its unit checksums exactly |
| The engine's `UndoStack` (move/recruit/recall/dismiss) is tested but unused; upstream's undo is a container of *steps* per action (the move, `take_village_step` restoring an owner, `[on_undo]` events), blocked by randomness in deterministic mode, fog reveals, ambushes and any event that does something without `[allow_undo]` | The port's stack needs village restoration and event-aware blocking before it is wired in |
| Upstream redo re-runs the undone action's recorded `[command]` (with its seed) through `synced_context::run` | Redo falls out of the command layer for free |
| `wesnoth --load <save> --with-replay` replays a save's `[replay]` in the real binary (1.16.9 installed) | Export can be verified against the real game, as Phase 26 was |

### Stages (one commit each, suites green, PROGRESS.md entry)

- **R0 -- Synced command layer** (`engine/src/actions/synced.ts`, port of
  `synced_commands.cpp`): a `SyncedCommand` union in upstream's `[command]`
  shapes and one `runSyncedCommand` that executes it through the existing
  engine functions. `GameSession` and the AI context route every
  state-changing action through it. No behaviour change.
- **R1 -- Per-action RNG** (`random_synced.cpp`): each command gets its own
  MT stream, seeded lazily on the first draw from a seed source and
  recorded; the whole-game stream stays for scenario setup and as a
  `random_mode=deterministic` option (tests, AI benchmarks). Saves carry
  `random_mode`. All in-action randomness (combat, traits, `rand=`,
  `[option]`-driven branches) draws from the action RNG.
- **R2 -- Recorder**: an ordered log of commands with their dependents
  (seeds, `[option]`/`[text_input]` answers -- replacing Phase 17's
  `choices` list) and a per-command state digest of our own (unit
  positions/hp/xp, gold, RNG position) for out-of-sync checks. Saved in
  `SaveGameData` together with the scenario-start state it replays from.
- **R3 -- Headless replay + out-of-sync self-check**: rebuild the
  scenario-start state, re-run the startup events feeding recorded
  answers, apply commands one by one (`stepTo(n)`), compare digests. A
  test harness replays any recorded session; the AI benchmark and the
  synthetic scenarios become regression tests.
- **R4 -- Undo/redo in play**: per-action undo containers (move with
  village restore, recruit, recall, dismiss), blocked by attacks, fog or
  shroud reveals, ambushes, teleport failures and events that fire without
  `[allow_undo]`/`[on_undo]`; `[allow_undo]`/`[on_undo]`/`[on_redo]`
  tags; the redo stack re-runs recorded commands with their seeds; undo
  cuts the command from the log. Upstream hotkeys `u` (undo) and `r`
  (redo), menu entries, and `[undo_stack]` in saves.
- **R5 -- Replay viewer (minimal, user's call)**: "Show replay" in the
  Load dialog (upstream's checkbox); play/pause and restart, on the
  normal board with normal animations. Step controls, skip-animations and
  viewpoint selection are left for later.
- **R6 -- Wesnoth `[replay]`, both ways**: export the real command log
  (with `[random_seed]`, `[input]`, `[init_side]`, `[end_turn]`) instead
  of Phase 26's minimal one; import a real save's `[replay_start]` +
  `[replay]` and replay it here through R3, reporting where it goes out
  of sync; `[sync_variable]`. Oracle: a replay recorded by the real
  binary on Dead Water 1 (its scenario-1 content matches ours).
- **R7 -- Milestones and docs.**

### Milestones

1. A scripted scenario (synthetic combat/economy, then Dead Water 1 with
   its AI side) replays from its log to a bit-identical final state, and
   an injected divergence is reported as out of sync at the right command.
2. Undo and redo of a move (capturing a village) and of a recruit restore
   the exact prior state -- gold, moves, village owner, facing -- and redo
   repeats the recruit with the same traits.
3. A save downloaded here opens in the real binary with `--with-replay`
   and replays through to the saved turn.
4. A replay recorded by the real binary on Dead Water 1 imports and
   replays here; every command up to the first recorded divergence
   matches, and that divergence (if any) is named in docs/PROGRESS.md.

### Risks

| Risk | Mitigation |
|---|---|
| The real binary replays our log with *its* engine: any rule the port computes differently (traits, name generation, AI-free but rule-dependent outcomes) makes that replay diverge | Per-action seeding confines a divergence to one action; milestone 3 measures how far a real replay gets and records the gaps rather than blocking the phase |
| Every mutation path must go through the command layer, or replays silently miss it | R0 routes all known paths; R3's self-check on AI-vs-AI games catches anything that bypasses it |
| Events that change state during an action make undo unsafe | Upstream's rule: block undo unless the event says `[allow_undo]`/`[on_undo]` |
| Content version gap (our 1.19 data, the 1.16.9 binary) | Same approach as Phase 26: verify on Dead Water, whose scenario 1 matches |

## Phase 18c — Unit modifications: `[effect]`, traits, `[object]`, runtime `[event]`

**Status: delivered 2026-09-26** (found 2026-09-23 by Phase 18b's real-binary
replays). Both milestone directions verified against a desktop build of the
checked-out 1.19.21+dev source: a real 1.19 AI game replays here unit for
unit at every turn start, and a 3-turn AI game played here (130 commands,
20 fights) replays through the real binary to a board identical in every
unit's position, hp, xp, traits, statuses, gold, villages and variables.
The only differences left are ones upstream does not sync: facings drawn
from its unsynced RNG or set by the recruit animation, and moves an AI
`stop_unit` removed (never recorded, so a real replay keeps them).
`[filter]` inside an AMLA `[advancement]` is not evaluated. See
`docs/PROGRESS.md`, 2026-09-26.

Original scope:
The port records traits and objects on a unit but applies none of their
effects (`Unit.ts`'s own module comment: "a freshly-built Unit here has its
listed traits' names but not their numeric effects"), `[object]` is an
unsupported action tag (19 scenario files in the four ported campaigns use
it), and an `[event]` nested inside an event (WML adding a handler at run
time) is skipped. So a strong unit hits no harder, a resilient one has no
extra hitpoints, a quick one no extra move, a Walking Corpse given the
swimmer variation still walks water on its land movetype, and a scenario's
items do nothing. It is also what keeps real Wesnoth replays from staying in
sync past the first fight (Phase 18b milestones 3–4).

- `[effect]` application (`unit::add_modification`/`apply_modifications`):
  every `apply_to=` upstream supports -- hitpoints, movement, attack
  (damage/number/specials/new attacks), resistance, defense, movement_costs,
  vision_costs, jamming, variation/type, status, profile/image_mod, zoc,
  loyal, experience, max_experience, level, alignment, overlay, halo,
  new_ability/remove_ability, new_animation -- with `[filter]`, `times=`
  and gender-specific effects.
- Traits apply on creation, advancement re-applies modifications
  (`advance_to` + `apply_modifications`), AMLA (`[advancement]`).
- `[object]` (with `duration=`, `[filter]`, `silent=`, `[then]`/`[else]`)
  and `[remove_object]`; `[modify_unit] [object]`.
- Runtime `[event]` registration (and `[remove_event]`), `id=` dedupe.
- `[remove_object]`, `[remove_trait]`, `[transform_unit]` (the audit's
  other modification tags), and upstream's unit-id counter (`underlying_id`
  from `next_underlying_unit_id`, `Type-N` ids for recruits) so recalls by
  id line up with the real game.
- **Milestone:** the Phase 18b real-AI fixture replays its whole log here
  in sync, and a replay recorded here replays in the real binary past the
  first fight. Verified against a desktop build of the checked-out 1.19
  source (the same version as the port's data), not the 1.16.9 package.

## Phase 18d — Missing WML action tags (from the 2026-09-26 audit)

**Status: delivered 2026-09-26.** The audit reports every action tag the
shipped scenarios use as implemented except `[item]`/`[remove_item]`
(Phase 18) and `[set_achievement]` (Phase 25); every condition tag is
evaluated. Found and fixed along the way: the scenario turn limit was never
enforced (no `time over`, no defeat), mid-scenario objectives never popped
up and the menu showed stale ones, and `exit hex`/`enter hex` never fired.
`[terrain_mask]` is verified against the real 1.19 build (Dead Water 2's
map after prestart, hex for hex). Not ported: `[terrain_mask] mask_file=`,
side-filter `formula=`, `[random_placement]`'s deprecated Lua `num_items=`.
See `docs/PROGRESS.md`, 2026-09-26.

Original scope: `packages/ui/scripts/audit-wml.ts` walks every
branch of every event in the 40 shipped scenarios and checks each action
and condition tag against what the port implements; the result is
`docs/WML_AUDIT.md` (regenerate it after each change). After Phase 18c
takes the modification tags and runtime `[event]`/`[remove_event]`, the
gameplay-relevant remainder is:

- `[store_starting_location]` (20 scenarios), `[store_locations]`,
  `[store_unit_type]`, `[store_villages]`, `[store_side]`, `[store_turns]`.
- `[terrain]` and `[terrain_mask]` (map changes, with the terrain-change
  consequences for villages and castles), `[modify_turns]`,
  `[set_recruit]`, `[role]`, `[hide_unit]`/`[unhide_unit]`,
  `[random_placement]`, `[unit_worth]`, `[put_to_recall_list]`,
  `[cancel_action]`, `[insert_tag]`, `[wml_message]`.
- Conditions: `[have_location]` (done in 18c) and `[lua]` -- done
  2026-09-26: `[lua]` conditions run in Fengari through lua-bridge
  (`wml.variables` bridged). An unknown condition passes with an error
  logged, which is upstream's own rule (`run_wml_conditional`), not a bug.
- `[show_objectives]` belongs with the objectives UI; `[item]`/
  `[remove_item]` stay in Phase 18 (labels/items); `[set_achievement]` in
  Phase 25.
- **Milestone:** the audit reports no missing gameplay tag in the shipped
  scenarios.

## Phase 19 — Audio & Music (was Phase 13)

**Status: delivered 2026-09-26** (`docs/PHASE19_PLAN.md`, `docs/PROGRESS.md`).
The playlist, `[music]`, the victory/defeat stinger, `[sound]`, frame and
status sounds, the turn bell and time-of-day sounds, interface clicks,
sound sources and `[volume]` are in, all as upstream does them (ported from
`sound.cpp`, `soundsource.cpp`, `lua_audio.cpp`, `wml-tags.lua`), with
streamed music, decoded-once effects, a channel budget, autoplay handling,
a mute toggle and a small Audio dialog. Where the text below differs from
what upstream really does (a `[volume]` scale is not "restored afterwards":
it lasts until the player moves that slider; a sound with no free channel
is skipped, not stolen), upstream won. Main-menu (`title_music`) music
belongs to Phase 21, which reuses the same audio engine and playlist.

- `[music]` scenario playlists (`append=`/`immediate=`/`play_once=`/
  `ms_before=`/`ms_after=`), track transitions/crossfade, shuffle
  (never-repeat-adjacent), persistence across scenario boundaries unless
  overridden, main-menu music, victory/defeat stingers, ToD-driven changes.
- `[sound]` one-off effects (`repeat=`, delayed), attack/movement/death/
  recruit/level-up sounds driven by animation frames (`[frame]sound=` —
  ties directly into Phase 10), UI sounds (clicks, dialog open/close,
  errors).
- `[sound_source]`/`[remove_sound_source]`: positional looping sounds with
  radius/delay/chance and distance-based attenuation (`full_range=`/
  `fade_range=`) from the viewport centre.
- `[volume]` scripted changes (restored afterwards) and persistent
  separate music/sound/UI/bell volume settings, plus mute/unmute (a
  minimal toggle here; full controls in Phase 24's preferences).
- **Web-specific**: browser autoplay policy (audio only starts after a
  user gesture, without losing the already-queued track), lazy asset
  loading with silent-but-logged failure for missing files, and a
  simultaneous-sound-channel limit so mass combat doesn't distort/exhaust
  channels.
- Formats (decided 2026-09-26): the shipped Ogg Vorbis/WAV files as they
  are; old Safari without Vorbis is not supported. A size-reducing
  transcode (e.g. Opus) is a Phase 23 option only if real-world tests show
  the download is a problem. Working plan: `docs/PHASE19_PLAN.md`.
- **Milestone**: a real scenario's `[music]` playlist audibly plays and
  transitions correctly across a turn boundary, at least one weapon's
  attack sound fires on hit, and toggling mute silences everything
  immediately and restores it correctly on unmute.

## Phase 20 — Localization & Accessibility (was Phase 14)

**Status: delivered 2026-09-27.** How it was built, the decisions taken, and
what each stage proved are in `docs/PHASE20_PLAN.md` and the five Phase 20
entries in `docs/PROGRESS.md`. The original scope, for reference:

- Gettext catalogue loading per textdomain, resolving `_ "…"` values at
  *display* time so a locale switch updates everything live without a reload.
- Runtime locale switching, plural-form rules, gendered strings.
- RTL text layout and wrapping, missing-translation fallback to English,
  locale-aware formatting where the UI needs it.
- Accessibility: colour-independent team identity, keyboard-only play,
  font-size scaling that does not break layout, screen-reader labels.

What was delivered, and where it differs from the sketch above:

- `_ "…"` survives parsing as a `TString` stamped with the textdomain the
  author wrote it under (per-macro and per-file scoping in the preprocessor,
  as upstream), is stored in the built JSON as `{"t": [...]}`, and stays
  translatable through variables, saves and the Wesnoth save converter.
  Model text (unit, type, weapon and terrain names, story, objectives,
  scenario and campaign names) is read when drawn.
- Catalogues come from upstream's `.po` files, not our own translations: 10
  languages (upstream's 80 %-translated set plus Polish), fetched per
  language and domain, only when used. Strings upstream has no counterpart
  for live in our own `wesnothweb` domain (`apps/web/i18n/wesnothweb/`).
- **Not built, by decision:** CJK and Bengali fonts (none of the shipped
  languages needs one; the on-demand loader is in place), a "show all
  languages" toggle, and a mirrored right-to-left GUI (upstream does not
  mirror it either).
- **Deferred:** real `tstring` userdata in Lua (Phase 29; `wesnoth.textdomain`
  returns plain translated strings), the full preferences dialog that will host
  the language and accessibility settings (Phase 24), help-browser text.
- **Milestones, all met:** the runtime switch (Dead Water 1 to Polish and back
  mid-dialogue, no reload, exact catalogue strings), the whole-scenario
  keyboard-only playthrough with zero pointer events, zero unknown msgids across
  every shipped campaign, and the same Dead Water 1 strings agreeing 1058/1058
  with the real Wesnoth 1.16.9 Polish catalogues.

## Phase 21 — Main menu

**Status: delivered 2026-09-27.** How it was built, the decisions taken,
and what each stage proved are in `docs/PHASE21_PLAN.md` and the Phase 21
entries in `docs/PROGRESS.md`. Spec sources: `title_screen.cpp`,
`campaign_selection.cpp`, `campaign_difficulty.cpp`, `end_credits.cpp`,
`about.cpp`. Original scope, for reference:

- Title screen with the real background and button column: Campaigns,
  Load Game, Preferences, Credits (help/multiplayer/editor/add-ons
  entries omitted — out of scope).
- Campaign selection modal: campaign list with icon, description, image,
  difficulty chooser (`[difficulty]`), and campaign completion markers
  (persisted); debug campaigns kept but visually separated.
- Load Game opens the existing load flow; Preferences opens Phase 24's
  dialog; credits screen (`[about]`/`[entry]`/`[credits_group]`).
- **Milestone**: starting a campaign at a chosen difficulty, and loading a
  save, are both reachable only via the main menu, matching the real
  title screen's layout.

What was delivered, and where it differs from the sketch above:

- **Difficulty is build output.** The preprocessor resolves `#ifdef EASY`,
  so each difficulty of a scenario is its own build. The campaign's default
  ships whole; the others ship as small overlays (`<id>@<DEFINE>.json`,
  50-280 KB against 3.4 MB; per-entry patches for the few unit types a
  campaign changes). This also fixed Two Brothers, which had been built at
  a `NORMAL` it does not have. Saves, continuation and exported Wesnoth saves
  carry the difficulty; a save without one gets the campaign's default (no
  difficulty-choice dialog, decided 2026-09-27).
- **Title screen** as `title_screen.cfg` lays it out (real background, logo,
  translucent tip and button panels, version, language), with upstream's
  keys, title music, and a phone layout. Tips: upstream's own `tips.cfg` until
  the content is decided.
- **Campaign dialog** with search, Name/Timeline sort, completion filter,
  laurels (upstream's exact rules), a difficulty chooser and debug campaigns
  set apart. Completion is recorded on a campaign's last victory. **Not
  built:** the Combat RNG and Modifications menus (RNG modes are now Phase 30).
- **Preferences** is an interim tabbed dialog (Display: font size, orb
  colours, show tips; Sound); Phase 24 adds the rest. In a game it replaces
  the separate Audio and Accessibility entries (Ctrl+P).
- **Credits** scroll as upstream's (100 px/s, Up/Down change the speed), with a
  pause button and no motion under `prefers-reduced-motion`. The campaign
  outro now reads the same data, so its section titles are translated.
- **Quit to Menu** in a game and on the end screen.
- **Not done:** Load's "Show replay" from the title screen (a replay opens
  inside a running game), `wesnoth.scenario.difficulty` in Lua (the bridge
  has no scenario table; Phase 29's host API).

## Phase 22 — Advanced map rendering: minimap & camera

**Status: delivered 2026-09-27** (`docs/PHASE22_PLAN.md`, outcome at its
end). Remainder of the old Phase 16 after labels/items (Phase 18) and camera
scripting (Phase 17) moved out. Terrain-help data moved to Phase 24 (user's
call, 2026-09-27): it has no consumer until the help browser exists.

Delivered: upstream's nine zoom levels and map bounds; `scroll_to_xy`'s
glide for scripted scrolls, messages and followed unit actions (next unit
and goto leader stay instant, as upstream's `WARP`); the wheel pans and
Ctrl+wheel zooms (user's call); edge panning; the minimap with its outline,
click/drag navigation and upstream's six buttons; the grid; Show Enemy
Moves / Best Possible Enemy Moves; General/Advanced preference tabs.
Verified by `apps/web/scripts/minimap-camera-playthrough.mjs`.

- Minimap: downscaled terrain-colour map with unit dots and village-flag
  markers, click/drag-to-navigate, viewport rectangle, reflecting only the
  viewing side's knowledge under Phase 11's fog/shroud.
- Camera: smooth scroll-to on selection/next-unit, follow-unit-on-move,
  edge-of-screen panning (arrow keys stay on the hex cursor), zoom levels matching
  upstream's, map-bounds clamping.
- Grid overlay toggle, show-enemy-moves overlay.
- **Milestone**: the minimap accurately reflects the live board including
  village ownership and fog, and clicking it recentres the camera.

## Phase 23 — Mobile UI

**Status: delivered 2026-09-27** (`docs/PHASE23_PLAN.md`; the Phase 23
entry in `docs/PROGRESS.md`). Phone layout in both orientations, full-screen
dialogs, 44 px touch targets, pinch/two-finger pan/long press, a confirm tap
for moves, and title/story art kept undistorted and in view. The audio
transcode was not needed. Verified by `apps/web/scripts/mobile-playthrough.mjs`
(a whole scenario on an emulated Pixel 7, touch only). Original scope:

- Responsive layout: collapsible infobox, full-screen modals on
  narrow viewports, larger tap targets.
- In infobox: selected unit info replaces minimap; deselection restores it.
- Status bar at the top wraps around so that all info is visible even on narrow
  viewports. Collapsible.
- Touch input: tap-select/tap-move (with a confirm tap for moves/attacks),
  long-press context menu, pinch-zoom, drag-pan, and resize/orientation
  change without losing game state.
- Visuals: story and main menu illustrations should not be stretched too much
  and should be placed in visible position.
- *Conditional* (from Phase 19): transcode music/sounds (e.g. Opus) to
  shrink the audio download -- only if real-world tests on mobile show the
  size (~162 MB of music as shipped) is actually a problem.
- **Milestone**: a full scenario is playable start-to-finish on a phone-
  sized viewport using only touch input.

## Phase 23a — Playtest fixes (bugs7.md, 2026-09-27)

**Status: delivered 2026-09-27** (docs/PROGRESS.md). Found playtesting
Phase 23 on a phone and on desktop:

- Phone: the "loading scenario..." line was hidden; the collapse switches
  did not work while a `[message]` waited for a tap; a gap in the infobox
  header let the scrolling body show through.
- AI turns on big maps looked like a hang: upstream's
  `defensive_position_cache_` ported, illuminators and terrain/defense
  lookups cached (Dead Water 12, 30 AI side turns: 167 s -> 34 s).
- Pango markup in messages, story text and objectives.
- Recruits hidden until their animation starts; frame `alpha=`; every unit
  moves at upstream's 200 ms per hex (horses were twice as fast).
- Unit ellipses and animated village flags in the side's colour, as
  upstream draws them (Liberty's blue side showed grey dots and triangles).
- Selecting an enemy highlights its reach (with full moves).
- End Turn greyed out during the other sides' turns, Skip Animation while
  their moves play, and upstream's "You have not started your turn yet".
- Phone: a collapsed infobox shows the selected unit as one line.
- **Deliberate departure from upstream** (user's call): zoom is continuous
  between upstream's smallest and largest hex sizes (pinch, Ctrl+wheel);
  the `+`/`-` hotkeys and WML `[zoom]` still land on upstream's levels.
- `dialogue-playthrough.mjs` fixed: not a Phase 23 regression (fails the
  same on the pre-Phase-23 build); headless Chromium draws at ~1 fps and
  each glide to the next speaker hit its 4 s timeout, so the test now waits
  for each line.

## Phase 24 — Advanced UI features

**Status: help browser delivered 2026-09-30** (branch `help-browser`, see `docs/PROGRESS.md`; the real
game's help is shown in `docs/reference/help/`). The milestone's first part is met: the help opens a real
unit's stat and ability page, from F1, the menus, the context menu, the unit dialogs, the side panel and
`[open_help]`/`gui.show_help`. Every unit and terrain is listed, with no encountered-only filter (the
user's call). **The rest resumed 2026-10-05** (user's call: Phase 24, then Phase 25), on branch
`phase-24`, one PR, tag `v0.11.0` -- **delivered 2026-10-05** (all five stages below; see `PROGRESS.md`
and `apps/web/scripts/phase24-playthrough.mjs`). The statistics dialog moves to Phase 25, which records what it
shows. Language keeps its own dialog, as upstream's does.

Stages (one commit each at least, suites green, `PROGRESS.md` entry):

1. **Hotkey registry** (`hotkey/hotkey_command.cpp`, `hotkey_item.cpp`, `data/core/hotkeys.cfg`): every
   command's default bindings, several per command as upstream allows, taken from `hotkeys.cfg`; the
   player's changes saved per browser on top of them. The menus, the context menu and the global key
   handler all read their bindings from it instead of hard-coding them.
2. **Hotkeys tab** (`preferences_dialog.cpp` hotkey page, `hotkey_bind.cpp`): the commands with their
   bindings, Add Hotkey (press the key, Esc cancels; a key already bound elsewhere asks before it moves),
   Clear Hotkey and Reset Defaults.
3. **The rest of the preferences**, each upstream's own preference with its default, and only those the
   port has something to apply them to:
   - General: Accelerated speed and its speed slider (`turbo`, `turbo_speed`: animations, camera
     glides, `[delay]` and floating labels run faster; also the `accelerated` hotkey); Skip AI moves
     (`skip_ai_moves`: AI sides' moves and attacks are not animated); Turn prompt (`turn_dialog`: "It is
     now X's turn" with the board hidden, at the start of each human turn); Save replays, Delete
     auto-saves at the end of scenarios and the auto-save limit (`save_replays`, `delete_saves`,
     `auto_save_max`).
   - Display: Combat damage indicators (`floating_labels`), Team color indicators (`show_side_colors`,
     the ellipses), Animate map and Animate water (`animate_map`, `animate_water`).
   - Advanced: Show combat (`show_combat`), Confirm deleting saves (`ask_delete`), Show missed attack
     indicator (`show_attack_miss_indicator`), Allow damage calculation with Monte Carlo simulation.
   - Left out, with the reason recorded: window size, pixel scale, VSync and themes (the browser owns
     these); standing and idle unit animations (the board draws units still between actions, so there
     is nothing to switch); planning mode (no whiteboard); multiplayer, lobby, add-ons, editor, logging,
     cache and SIMD.
4. **Unit list** (`units_dialog::build_unit_list_dialog`, the `unitlist` command, Alt+U): the side's
   units in upstream's columns (name, type, level, moves, HP, XP, status, traits), sortable, with the
   unit's details beside the list, Scroll To and Rename.
5. **Advancement preview** (`unit_advance.cpp`): selecting an advancement shows the unit it becomes, as
   upstream does, built by the engine's own advance on a copy (AMLAs included).

- **Milestone**: animation speed changes take effect immediately; a rebound hotkey persists across
  reload; the unit list scrolls to the chosen unit; selecting an advancement previews the advanced unit.

## Phase 25 — Statistics & Achievements (was Phase 15)

**Status: delivered 2026-10-05** (user's call: right after Phase 24), branch `phase-25`, tag `v0.12.0`; see
`PROGRESS.md`. The milestone's achievement is The South Guard's "Thug Beater": Under the Burning Suns ships
no achievements in this data version.
Split 2026-09-23 (user's call): replay, undo and redo moved forward to Phase 18b; this phase keeps the
rest of the old Phase 15. Already in place: `[set_global_variable]`/`[get_global_variable]` (Phase 28c,
kept per browser) and `[set_achievement]`/`[set_sub_achievement]`/`[progress_achievement]`, recorded per
browser with nothing showing them yet.

Stages: statistics recorded by the engine (`statistics.cpp`) and saved with the game and the campaign;
the statistics dialog (`statistics_dialog.cpp`, also on the `statistics` hotkey); the achievements data
(`data/achievements.cfg` and each campaign's), the achievements dialog (`achievements_dialog.cpp`, from
the title screen and the `achievements` hotkey) and the "achievement unlocked" notice; `[has_achievement]`
and `wesnoth.achievements`. Planned in detail when Phase 24 is done.

- Statistics (`[statistics]`/`[team]`/`[attacks]`/`[defends]`/`[killed]`/
  `[deaths]`): damage dealt/taken (expected vs. actual), kills/losses,
  recruits/recalls/advances per side per scenario, rolled up per campaign.
  Recorded from the same synced actions Phase 18b logs; saves already
  carry an imported `[statistics]` subtree verbatim (Phase 26), which this
  phase starts writing for real.
- Achievements (`[achievement]`/`[achievement_group]`/`[sub_achievement]`/
  `[set_achievement]`/`[progress_achievement]`/`[has_achievement]`) —
  UtBS ships a real `achievements.cfg` to test against.
- Persistent global variables (`[set_global_variable]`/
  `[get_global_variable]`/`namespace=`) — same durable storage layer as
  achievements (IndexedDB, like saves).
- **Milestone**: the statistics dialog shows correct expected-vs-actual
  combat numbers for a played scenario, and one real UtBS achievement
  completes and stays earned across a reload.

## Phase 26 — Save game handling

**Status: delivered S1–S8 (2026-09-22)**, pulled forward ahead of Phases
18–25 (user's call); see docs/PROGRESS.md. Canonical saves stay JSON
(`SaveGameData` v2, now complete: XP/traits/statuses/villages/RNG
position...) in IndexedDB; WML appears only at the download/upload
boundary (`save/wesnothSave.ts`, over a new WML writer). Verified both
ways against the real 1.16.9 binary; a round-trip test diffs a real save
field by field. The "sequenced after Phase 25" assumption below turned
out wrong: a turn-start save needs only a minimal `[replay]`, which is
what is emitted -- a real action log comes with Phase 18b. The
thumbnail in the list below was not built.

- Save/load dialogs (`game_save.cpp`/`game_load.cpp`): list with
  campaign/scenario/turn/date/thumbnail, rename, delete (with
  confirmation), filter by campaign.
- Download a save as a file and upload one back (standard file picker and
  browser download).
- Autosave: at turn start and scenario start, rotating a configurable
  number of autosaves; start-of-scenario saves for campaign restart.
  (Cheap enough to pull earlier on its own if losing progress during long
  testing sessions becomes painful.)
- Wesnoth save-format compatibility: read and write upstream `.gz` save
  files (`[snapshot]`/`[replay_start]`/`[replay]`/`[carryover_sides_start]`)
  so a save made in the real binary loads here and vice versa, for
  mainline campaigns this project supports.
- **Milestone**: a save made in the real Wesnoth binary mid-scenario
  uploads and resumes here with matching state, and a save downloaded
  from here loads in the real binary.

## Phase 27 — Feature completeness assessment

**Status: not started.** A deliberate audit pass, not new feature work.

- Walk `~/wesnoth-feature-catalogue.md` category by category (all ~1,000
  items) against the implementation: for each item record done / partial
  / missing / out-of-scope, with the test or real-content scenario that
  demonstrates it.
- Re-check this plan's per-phase gap lists and the coverage map below
  against that result; turn every "missing" into either a follow-up task
  or an explicit out-of-scope decision.
- **Milestone**: a completeness report committed under `docs/` with no
  catalogue item left unclassified.

## Phase 28 — CI/CD, Performance & Platform (was Phase 18)

**Status: delivered 2026-09-29** (S0–S6 and S9; released as `v0.1.0`, see
`docs/PHASE28_PLAN.md` and PROGRESS). S7 (performance budgets and the nightly
run), S8 (cross-browser and offline) and the CI browser smoke test from S5 were
moved to **Phase 28d** (user's call, 2026-09-29). Planned 2026-09-27; the plan covers:

- GitHub Actions CI on `main` and PRs;
- versioned, `immutable`-cached assets, with the game media in R2 because
  of Workers' 20k-file limit;
- data shrinking;
- tag-only production deploys to Cloudflare Workers static assets, with no
  staging environment and no oracle tests in CI;
- error reporting, budgets, cross-browser and offline support, and licence
  guards.

The work is split into stages S0–S9; S0 (merge into `main`) is done. Before this plan, every engine/UI change already
ships with real unit/integration tests and real-browser Playwright
verification before a commit — but that's a per-session practice, not a
CI pipeline, and none of the deployment/performance/cross-browser items
below exist yet.

- CI pipeline: lint + unit + integration + UI suites on every commit, with
  clear failure reporting.
- Tagged-release deployment with versioning/rollback (no staging
  environment, user's call 2026-09-27). Hosting must send these caching
  headers (from Phase 28a P7; the dev server already does the first):
  - `/atlases/**/*.<12 hex>.png` (content-hashed image bundles):
    `Cache-Control: public, max-age=31536000, immutable`.
  - `/atlases/**/*.json` (bundle manifests, fixed names that point at the
    hashed files): `Cache-Control: no-cache`, served with an `ETag`.
  - `/game-images/**`, `/game-images-engine/**` (per-file fallback,
    unhashed): `no-cache` + `ETag` until they get versioned URLs.
  - `npm run build` produces the bundles (`prebuild` runs
    `build:atlases`); they are not in git.
- Performance regression tracking: load time, frame rate, memory measured
  in CI against defined budgets (none defined yet).
- Cross-browser compatibility matrix, offline/service-worker behaviour,
  deep-linking/routing surviving a hard refresh mid-scenario.
- Error reporting: runtime errors surface to the player with a recoverable
  path and are logged for diagnosis, rather than a blank screen.
- Asset licence compliance (bundled art/music/data retain upstream
  attribution/licence files) and an explicit regression test that
  unmodified upstream campaign `.cfg` files load without local patching.
- **Milestone**: pushing to `main` triggers a CI run covering all package
  test suites plus a browser smoke test, a `v*` tag deploys to production, and a
  deliberately-broken build fails CI before it can deploy.

### Phase 28b — Movement visualisation & multi-turn moves (added 2026-09-27)

**Status: delivered 2026-09-29** (see `PROGRESS.md`). Directly after Phase 28
(user's call). Upstream's `mouse_handler` reach and route display, and `goto` moves:

- Hovering any unit (own or enemy, nothing selected) highlights its reach;
  an enemy's with full moves (`unit_movement_resetter`), as when selected.
- With a unit selected, hovering any hex previews the route to it
  (footsteps, `marked_route`).
- Hexes beyond this turn's reach still get a route preview, with the
  defense on each hex and the number of turns needed to get there (the
  route's turn markers, as upstream's `display::draw_movement_info`).
- Clicking an unreachable hex with an own unit selected queues a
  multi-turn move (`unit::goto`): the unit goes as far as it can now and
  continues along the planned path at the start of each later turn
  (`play_controller`'s "continue move"). The plan is dropped when the unit
  gets another order, is double-clicked, or the move is interrupted (an
  ambush, a sighted enemy, the path blocked). Saves already carry
  `goto_x`/`goto_y`.
- **Move-and-attack in one order** (user's requirements, 2026-09-27):
  - *Touch*: with an own unit selected, tapping a reachable hex adjacent
    to an enemy and then tapping that enemy means "move to that hex and
    attack the enemy from it". (Today the first tap arms a move -- the
    confirm tap -- and tapping the enemy then targets it from where the
    unit stands, if adjacent.)
  - *Mouse*: with an own unit selected, moving the cursor onto an enemy
    from a reachable hex next to it targets the enemy from that hex (the
    hex the cursor came from is the attack position, as upstream's
    `mouse_handler::current_unit_attacks_from`); clicking the enemy
    starts the combined order.
  - Either way the attack dialog opens first, showing the prediction as
    fought **from the chosen hex** (its terrain, time of day there,
    leadership, backstab/flanking there), and the unit does **not move
    yet**. Confirming the attack performs the move, then the attack.
    Dismissing the dialog does nothing at all: no move, the selection
    stays as it was.
  - The move is a normal move and can be interrupted as usual (an ambush,
    a sighted enemy, an event); if it is, the unit stops where the
    interruption left it and **the attack does not happen**. The attack
    also does not happen if, after the move, the target is no longer
    adjacent or attackable.
  - Undo treats the move as any move (upstream: the move is undoable
    until the attack commits; the attack is not).
- **Milestone**: a Playwright script hovers an enemy and sees its reach,
  previews a three-turn route with turn numbers, queues it, and watches
  the unit continue on the next two turns until a new order cancels it;
  a second one (touch and mouse) moves-and-attacks, checks that a
  dismissed dialog leaves the unit where it was, and that an ambush on
  the way cancels the attack.

### Phase 28c — The rest of the bundled single-player campaigns (added 2026-09-27)

**Status: resumed 2026-10-01** (user's call, ahead of achievements); **C1 delivered 2026-10-01** (see
`PROGRESS.md`: the shared tags, scenario end events, floating labels, unit overlays, campaign terrain and
generated caves; the generated caves are made at build time, one per scenario, by the user's call); **B1 delivered 2026-10-03**
(six campaigns, 68 scenarios; see `PROGRESS.md`); **B2 delivered 2026-10-03** (four campaigns, 84 scenarios); **B3 delivered 2026-10-03** (Under the Burning Suns
complete, Secrets of the Ancients, Eastern Invasion: 56 more scenarios); **B4 delivered 2026-10-03** (Heir to the
Throne, HttT Classic, The Deceiver's Gambit I and II: 86 scenarios -- every mainline single-player campaign but
World Conquest now ships). Plan:
- **C1, shared gaps**, before any campaign:
  - the missing tags (`[set_extra_recruit]`, `[do_command]`, `[find_path]`, `[end_turn]`,
    `[petrify]`/`[unpetrify]`, `[story]`, `[print]`, `[proceed_to_next_scenario]`);
  - `[floating_text]`, unit overlays and `[select_unit]`;
  - campaign and scenario `[terrain_type]`/`[terrain_graphics]`;
  - Lua-generated cave maps.
- **Batches, easiest first:**
  - **B1:** Hammer of Thursagan, Northern Rebirth, Winds of Fate, Of Pearls and Pirates, Dusk of Dawn,
    Descent into Darkness;
  - **B2:** The Rise of Wesnoth, Legend of Wesmere, Son of the Black Eye, Sceptre of Fire;
  - **B3:** UtBS 05-12, Secrets of the Ancients, Eastern Invasion;
  - **B4:** Heir to the Throne, HttT Classic, The Deceiver's Gambit.
- World Conquest gets its own phase. WL_Test is not upstream and is not ported.

Paused 2026-09-29 after The South Guard so that Phase 29 and the help browser came first. The South
Guard done (2026-09-29, see `PROGRESS.md`): with it came a campaign
Lua runtime (`lua-bridge`'s `LuaRuntime`, custom `gui.show_dialog` dialogs), the `[campaign]` block's
events and resources merged into scenarios, and nine more mainline tags. After Phase 28b. Built before it: Dead Water (13
scenarios), Liberty (8), Two Brothers (5), Under the Burning Suns (5 of
15). Still to build: the other ten UtBS scenarios and Descent into
Darkness, Dusk of Dawn, Eastern Invasion, Heir to the Throne (and its
Classic version), Legend of Wesmere, Northern Rebirth, Of Pearls and
Pirates, Sceptre of Fire, Secrets of the Ancients, Son of the Black Eye,
The Deceiver's Gambit, The Hammer of Thursagan, The Rise of Wesnoth, The
South Guard and Winds of Fate. World Conquest (random maps, mostly Lua)
and WL_Test are assessed separately.

- Mostly the existing build steps (`build-scenario-snapshot.mjs`/
  `rebuild-snapshots.mjs`, campaign images, story assets, translations,
  `campaigns.json`).
- First, a check for features the port doesn't support: run every
  scenario's WML through the preprocessor and list unknown action tags,
  `[lua]`/`[micro_ai]` code paths (most campaigns have some: HttT 25
  files, Eastern Invasion 16, The Deceiver's Gambit 15), custom units,
  terrains and images; each gap becomes a fix or a recorded limitation.
- **Milestone**: every scenario of every added campaign loads, its opening
  events run to play without errors, and one scenario per campaign is
  played headless to its end (AI against AI, as `replay.test.ts` does).

### Phase 28d — Performance budgets, cross-browser and offline (split from Phase 28, 2026-09-29)

**Status: not started.** After Phase 24, 25 and 27 (user's call). The work is
already planned in `docs/PHASE28_PLAN.md`:

- **S7:** performance budgets in CI and a nightly run. Per PR: request count, bytes, bundle size and
  heap from `measure-load.mjs`, main-thread blocked time with slack, and the AI benchmark. Nightly: every
  `*-playthrough.mjs`, `check:image-golden` and `test:slow`, with failures opening an issue.
- **S8:** cross-browser and offline. A nightly Chromium / Firefox / WebKit and phone-emulation smoke
  matrix; deep links (`?save=`, `&replay=1`) surviving a hard refresh; a small service worker, cache-first
  for the (already immutable) hashed data, so a scenario opened once plays offline.
- **The CI browser smoke test** planned in S5 (`smoke-playthrough.mjs` on the production build, failing on
  page errors and 404s): deploys are checked over HTTP only (`deploy.yml`).
- **Milestone:** a PR that grows a budgeted metric fails with a before/after table; the nightly matrix
  runs green on all three engines; Liberty 1, opened once, reloads and plays with the network off.

### Phase 28a — Image pipeline performance (planned 2026-09-14)

**Status: P0–P7 delivered (2026-09-15)**, see docs/PROGRESS.md. Dead Water 1
main-thread blocked time while loading 4.8–7.2 s → 0.32 s, longest task
0.7–1.0 s → 0.16 s, JS heap ~300 → 58 MB, pixel output unchanged (golden
hashes + rendered-board screenshots). Beyond the plan, profiling also
removed a deep Svelte proxy of the snapshot, a duplicated snapshot context
build and eager parsing of every unit type. P5 (terrain bundles) delivered:
Dead Water 1 image requests 555 → 15, pixels unchanged. P6 (unit type
bundles) delivered: attack animation frames come from bundles (the attack
dialog's 2 DOM portraits still fetch files). P7 (delivery): a warm reload
takes every bundle from the disk cache; production headers are listed under
Phase 28 above; the optional service worker is deferred to Phase 28's
offline work.

**Problem, measured** (Dead Water 1, headless Chromium, Vite dev server):
- **Jank.** `ImageCache` runs entirely on the main thread: every IPF op
  (`~MASK`, `~RC`, `~TC`, `~BLEND`, `~HEXED`...) reads pixels back with
  `getImageData`, loops in JS and writes them with `putImageData`. A CPU
  profile of the first 10 s showed 5.8 s of 8.7 s busy CPU in
  `applyOp`/`render`/`ctx2d`, plus ~1 s GC; long tasks up to ~0.7 s.
  Cooperative yielding inside `render` was tried and made no measurable
  difference (single ops and GC dominate), so the work must leave the
  thread. The 17.5 MB `terrain-graphics-rules.json` parse and the terrain
  builder pass also run on the main thread.
- **Requests.** One GET per source image, memoised per page (493 image
  requests, 493 distinct URLs, 0 repeats while loading Dead Water; 479 of
  them terrain). Unit animation frames are fetched the first time each
  animation plays (`SnapshotBoard.playAnimations` pre-resolves them). No
  atlases, no content-hashed names. The dev server adds
  `Cache-Control: no-cache` (every reload revalidates every file) and
  HTTP/1.1's ~6-connection limit.

**Non-negotiable:** output stays pixel-identical. `ImageCache` encodes
weeks of fidelity work against the C++ engine; every stage below is gated
by a golden hash corpus (P0) that must reproduce exactly.

**Order:** P0–P4 remove the jank first; P5–P7 cut requests. Each stage is
its own commit(s) with before/after numbers in docs/PROGRESS.md.

| # | Stage | Checkable outcome |
|---|---|---|
| P0 | **Baseline + pixel harness.** Extend `measure-story.mjs` into `measure-load.mjs`: board-ready time, total main-thread blocked time (sum of long tasks), max long task, image request count/bytes, JS heap, first-play latency of an attack animation (scripted in `synth_combat_01`). Golden corpus: in headless Chromium, resolve a fixed ref set (every terrain ref of Dead Water 1 and Liberty 1, unit frames with `~RC` for two sides, `~TOD` and `~GS` variants, portraits) through today's `ImageCache` and store SHA-256 of each RGBA buffer in `packages/renderer/fixtures/imagecache-golden.json`. | Baseline table in PROGRESS; `npm run check:image-golden` passes on current code |
| P1 | **Split compositing from PixiJS.** Move the op implementations, colour mappings and IPF parsing into `images/compositor.ts`: `render(ref) -> ImageBitmap | null` over `OffscreenCanvas`, no PixiJS, no DOM. `ImageCacheImpl` keeps the texture/pending/memo maps and wraps results as `PIXI.Texture` (ImageBitmap source). An in-thread `Compositor` stays for Node tests and as the fallback. | Golden hashes identical; renderer suite green |
| P2 | **Worker compositor.** `images/compositor.worker.ts` (Vite `new Worker(new URL(...), { type: 'module' })`), a pool of `min(4, hardwareConcurrency - 1)` workers sharded by source path. Protocol: `init` (base URLs, colour data), `render` (batched refs with priority: visible units > terrain > animation preload), results transferred as `ImageBitmap` (`transferToImageBitmap`, zero-copy), `cancel` on board teardown. Feature-detect `OffscreenCanvas` 2D in workers (Firefox 105+, Safari 16.4+), else in-thread. | Golden hashes identical via the worker path; no `applyOp` on the main thread in a profile |
| P3 | **Rest of the board build off-thread / paced.** Fetch + parse `terrain-graphics-rules.json` and run `getTerrainFramesAt` over the map in a worker (both PixiJS-free), returning per-hex frames and the ref list. On the main thread, create sprites and let PixiJS upload textures in per-frame batches (~8 ms budget via `requestAnimationFrame`) so ~8,700 sprites + thousands of uploads never land in one task. | Board visually identical (screenshot diff = 0 on Dead Water, Liberty, UtBS 1) |
| P4 | **Measure + tune.** Re-run P0. Budgets: max long task < 100 ms while the story or board loads; first story part fully faded in within 1 s of the story appearing (warm cache); board-ready time no worse than baseline +10%; attack first-play latency < 100 ms once frames are preloaded. | Budget table in PROGRESS; misses documented with profiles |
| P5 | **Scenario terrain bundles.** `apps/web/scripts/build-image-atlases.mjs` (run with `tsx`, `pngjs`): per scenario snapshot, run the real terrain builder over the map + graphics rules to get exactly the source files of the initial board; pack them losslessly (simple shelf/maxrects packing, ≤ 4096², RGBA PNG without gAMA/iCCP/sRGB chunks) into one or a few atlases + a JSON rect manifest. The compositor's `loadBitmap(path)` looks the path up in the loaded manifests and crops with `createImageBitmap(atlasBlob, sx, sy, sw, sh, { colorSpaceConversion: 'none' })`; anything else falls back to the per-file fetch. | Golden hashes identical; Dead Water 1 terrain requests 479 → single digits |
| P6 | **Unit type bundles.** One bundle per unit type: its base image plus every frame its animations reference (`parseUnitAnimations` over the flattened type config), keyed by type id + content hash. Built from the unit type configs alone (core, campaign or add-on), independent of any scenario, so the browser caches each once across every scenario. Loaded when a type is first placed or about to be (recruit list), which also covers spawns, transforms and advancement. Raw magenta sprites are bundled; team colour is still applied by the compositor. | Zero image requests during an attack in `synth_combat_01` after load |
| P7 | **Delivery.** Content-hashed atlas names (`<name>.<hash>.png`) so production can serve them `immutable`; hosting headers recorded for the Phase 28 deploy work; optional service-worker cache (ties into the offline item above). | Warm reload of Dead Water 1 makes no image revalidations for atlased assets |

**Risks**
- *Pixel drift in workers:* same Chromium Skia path, but gated by hashes
  regardless; Firefox/Safari checked manually until CI has them.
- *Texture upload becomes the new long task:* why P3 paces uploads.
- *Worker bundle pulling in PixiJS:* the compositor module must stay
  PixiJS-free (lint rule / import check in P1).
- *Atlas decode memory:* an atlas is only a network container, cropped
  into per-ref bitmaps in the worker and released; cap atlas size.
- *Build time / repo size:* per-scenario terrain atlases for ~38 scenarios
  could be tens of MB.

**Decisions (user, 2026-09-14)**
1. Generated atlases are gitignored and built by `npm run build` / a
   `predev` hook, not committed.
2. `pngjs` for build-time PNG decode/encode (exact RGBA; build time is not
   a concern).
3. Keep the bundle build simple and generic -- it should later cover all
   mainline campaigns and extend to add-ons and user scenarios, and it is
   not the project's core focus. Scenario bundles hold **terrain only**
   (the initial board's exact sources); units are bundled **per unit type
   with their animations**; no per-scenario extras lists, no static
   guessing of runtime terrain changes, no shared-core split.

**Bundles are a cache, not a manifest.** What a scenario draws cannot be
fully known at build time: WML `[terrain]` (with `terrain=`/`layer=`),
`[terrain_mask]`, `[replace_map]`, `[item]`/`[remove_item]` (arbitrary
`image=`/`halo=`), Lua `wesnoth.current.map[...] =`/`wesnoth.map`
terrain setters and `wesnoth.interface.add_item_image`, `[unit] type=$var`,
`[transform_unit]`, advancement, `[allow_recruit]`, `[object] image=`. A
single changed hex also changes the transition images of its neighbours
through `[terrain_graphics]` rules (scenario-defined ones included --
UtBS ships its own). In the four built campaigns today: `[terrain]` 1 / 3
/ 3 / 51 times (Dead Water / Liberty / Two Brothers / UtBS), `[item]`-style
image placement 22 / 51 / 40 / 165, `MODIFY_TERRAIN`/`PLACE_IMAGE` macros
in 6 / 7 / 3 / 11 files, 2 scenario `[terrain_graphics]` files in UtBS,
`[terrain_mask]` in 2 files, no variable-driven `terrain=$...` but 33
variable-driven `type=$...`; our
engine implements none of those actions yet, so today's board is static,
but it will not stay that way. Therefore:
- **Correctness never depends on a bundle.** The loader falls back to a
  per-file fetch for any source image no loaded manifest contains:
  terrain changed at runtime, `[item]` images, portraits, or a scenario/
  add-on that never went through the build. A miss costs one request,
  never a wrong or missing sprite. Dev builds log each fallback at debug
  level so a broken bundle is noticeable; nothing more.
- **What is bundled is exactly derivable:** a scenario's initial board
  (terrain builder over its map) and a unit type's own config. Both
  inputs exist for any scenario or add-on, so the same build works for
  all mainline campaigns later without special cases.

---

## Phase 29 — Real AI: RCA framework port + Lua CAs/micro-AIs on fengari

**Status: delivered (S0–S12, 2026-09-30).**
- The AI runs upstream's RCA framework (TS port) with upstream's Lua candidate actions and every micro AI
  (`data/ai`, unchanged) on an upstream-shaped Lua kernel on fengari.
- Every shipped scenario that uses a micro AI plays cleanly.
- 23 of upstream's 24 AI test scenarios play three turns cleanly. `fast`, 100 units a side, is too slow on
  fengari to run in the suite.
- AI turns in shipped campaigns mostly take 20–300 ms. The outliers and the Lua-speed options (an upstream
  fix, or wasmoon), postponed until needed, are in `docs/PROGRESS.md` (S12) and `docs/OPEN_QUESTIONS.md` #2.

The rest of this section is as written at the S6 milestone (2026-09-13). Supersedes
Phase 7's own "Later" bullet (candidate-action framework + Lua micro-AI
port), which is now this phase's full scope rather than a deferred
aside. Full staged plan (13 stages S0–S12, module layout, upstream
file:line citations, test plan per stage) in `docs/PHASE29_PLAN.md` —
kept there rather than duplicated here since it's long; this section is a pointer + milestone summary for the phase
list/coverage map's sake.

Dead Water now plays a full turn under the real RCA default AI end to
end (S5's milestone), `simpleAi.ts` is deleted, and a headless AI-vs-AI
benchmark harness (S6, `packages/ui/scripts/ai-benchmark.ts`) confirms
both sides play competent, non-degenerate, bit-for-bit-deterministic
combat. **S7 (the Lua host API needed to run `wesnoth/data/ai/**/*.lua`
verbatim) and S8 (browser wiring for it) are explicit, deliberate
handoff points**, not an oversight: S7 alone (reading all 5 of its
target Lua candidate actions confirmed this) transitively needs
`ai_helper.lua` (2548 lines), `battle_calcs.lua` (1612 lines),
`retreat.lua`, `location_set.lua`, and a micro-AI helper file, behind a
`wesnoth.*`/`ai.*` host API surface (unit proxies with methods,
`wesnoth.paths.find_reach`, `wesnoth.simulate_combat`, map/terrain
queries, `ai.aspects.*`/`ai.get_attacks()`, Lua<->WML conversion, error
handling) that is its own multi-session undertaking, not a same-scale
extension of S0–S6 -- the user chose to stop here and hand it off
explicitly (2026-09-13) rather than risk an incomplete or undertested
attempt. The pure-TS AI (everything through S6) is real, complete, and
independently useful without S7+; nothing about it is provisional or
needs revisiting once S7 eventually lands.

- TS-ports upstream's real candidate-action framework (`src/ai/composite`/
  `src/ai/default`: the RCA loop, aspects/facets/goals/stages, move maps/
  power_projection, and all 9 C++ candidate actions — goto, combat,
  recruitment, move_leader_to_{goals,keep}, get_villages, get_healing,
  move_to_targets, leader_shares_keep) into `packages/engine/src/ai/`,
  replacing `simpleAi.ts`'s Phase 7 heuristic.
- Runs the real `wesnoth/data/ai/**/*.lua` (5 default-loop Lua candidate
  actions, `ai_helper.lua`/`battle_calcs.lua`, and micro-AIs) **verbatim**
  on the existing fengari bridge (`packages/lua-bridge`, Phase 3),
  extended with the `wesnoth.*`/`ai.*` host API surface real content
  needs — decided over hand-porting Lua to TS, since none of `data/ai`
  uses Lua 5.4-only syntax.
- Micro-AI scope, in order: shipped-campaign types first (zone_guardian,
  messenger_escort, simple_attack, assassin, coward, forest_animals),
  then other mainline types, then test-only types.
- Includes a headless AI-vs-AI benchmark harness (win rate/turns/ms,
  seeded) as a deliverable alongside unit tests and live-browser checks.
- **Milestone (S5)**: a real mainline scenario (Dead Water 1) plays a
  full turn under the real RCA default AI — recruiting, moving, attacking
  by the real upstream algorithm and scoring, not a heuristic — headlessly
  and in a live browser, before the Lua-dependent stages (S7+) begin.

### Catalogue checklist (category 9's AI bullets, continued from Phase 7)

`[modify_ai]`/`[aspect]`/`[facet]`/`[goal]`/`[stage]`/`[micro_ai]` and AI
recruitment budgeting (`[recruitment_instructions]`/`[recruit]`/
`[limit]`) become real here.

## Phase 29a — AI turns shown action by action (added 2026-10-09)

**Status: delivered 2026-10-09 (branch `ai-step-by-step`), see `docs/PROGRESS.md`.** Planned as below; the one change in the doing is that a step with nothing to show (a unit's moves stopped) is not passed on, and Save/Load wait for the other sides' turns to end.

**Today:**
- `GameSession.endTurn` runs every AI side's whole turn (`AiManager.playTurn`) before anything is shown.
- The shell then replays the recorded `AiAnimationEvent`s. Each event records the positions of its own
  moment, because by then the board is at the end of the turn.

**What that costs:**
- The page freezes while all the thinking happens, and only then do the animations start.
- Hit-point bars and positions do not update between animations.
- Units killed earlier in the turn have to be removed by hand.
- A `[message]` raised by an AI-triggered event is shown only after every animation.
- Several bugs came from the replay and the board disagreeing (bugs4.md #2/#3, bugs5.md #3).

**Upstream:** thinking and display alternate on one thread.
- The RCA loop (`stage_rca.cpp`) calls `best_ptr->execute()`, which animates the action
  (`unit_display::move_unit`) before it returns. Only then is the next candidate action evaluated.
- Input and redraws are handled while the AI thinks (`ai::manager::raise_user_interact`, at most every 30 ms).
- Events fire in place, so their dialogue appears mid-turn.

**The port, after this phase:** the AI pauses after each candidate action's `execute()`, and the display
catches up before the AI goes on.
- **Granularity is one candidate-action execution.** The AI cannot pause inside a Lua call, so a
  candidate action that both moves and attacks (`ca_messenger_move`) shows as one step. Upstream draws
  even within that.
- **A `[message]` with options raised on an AI side's turn is still answered at once,** as today. It is
  shown in its place now, not after the turn.

### Stages (one commit each, suites green)

1. **The engine AI pauses after each action.**
   - `Stage.playStage` becomes a generator that yields after each executed action:
     - `RcaStage` yields after every `execute()`;
     - `LuaStage` yields once at its end;
     - `IdleStage` never yields.
   - `AiComposite.playTurnSteps` and `AiManager.playTurnSteps(side)` yield each step's actions
     (`drainActionLog`).
   - `playTurn` runs the steps to the end, so every existing caller (tests, the oracle tools, the
     benchmark) is unchanged.
   - Test: with the same seed, the steps add up to exactly what `playTurn` returns, one step per
     executed candidate action.
2. **The session hands each step to the display.**
   - `endTurnFlow` plays AI sides step by step. After each step it yields a session-level `aiStep`
     carrying what has happened since the last one: turn-start healing and the step's animation events.
     It also carries the dialogue that events deferred.
   - `drive` awaits the new `InteractionHost.aiStep` with it.
   - With no host (headless), the steps are passed over. The game, its RNG and its replay are identical.
   - `playAiSide` stays synchronous for the scripts and tests that call it.
   - Tests:
     - a headless `endTurn` gives the same board, replay and log as before;
     - a recording host gets the steps in order, and the board is at each step's end state when that
       step reaches the host;
     - an AI-triggered `[message]` arrives with its step.
3. **The shell plays each step as it arrives.**
   - `GameShell` implements `aiStep`. It plays that step's healing and animations, then `sync()`s the
     board, then shows that step's dialogue, and only then lets the AI go on.
   - The end screen still waits until the turn is over.
   - `otherSidesTurn` alternates between `thinking` and `animating`.
   - Skip Animation and the Skip AI moves preference stop animating but still update the board each step.
   - What is left in `lastTurnTimeline` after `endTurn` (the player's own turn-start healing) plays as now.
   - The "known simplification" comment and the hand removal of dead units' sprites go.
4. **Browser check.** A new script, `ai-turn-playthrough.mjs`, plays an AI turn of Dead Water 1 and of
   Liberty 1, checking:
   - steps arrive one by one, the board view matching the session after each;
   - the page stays responsive between steps;
   - no page errors.

   Plus the scripts the change touches: `turn-end-playthrough`, `dialogue-playthrough`,
   `undo-replay-playthrough`, and `campaign-playthrough --campaign liberty`.

**Then:**
- `docs/PROGRESS.md` entry;
- this section marked delivered;
- a PR, merged and tagged only when you say so.

## Phase 30 — Combat RNG modes (added 2026-09-27, deliberately last)

**Status: not started.** Split out of Phase 21 (user's call, 2026-09-27):
the campaign dialog's "Combat:" menu is omitted there, and this phase —
after CI/CD (28) and the AI (29) — makes sure it is not forgotten.

- Upstream's three modes (`campaign_dialog.cfg` `rng_menu`,
  `singleplayer.cpp:60-97`, `synced_context::get_rng_for_action`):
  **Default RNG** (`random_mode=""`: each action gets a fresh seed),
  **Predictable RNG** (`"deterministic"`: actions draw from the game's
  saved RNG, so reloading a save does not change an attack's outcome) and
  **Reduced RNG** (`"biased"`: `attack.cpp:739` `use_prng_`, hits and
  misses made more consistent).
- First establish which of these the port's current behaviour actually
  matches: Phase 26 restores the RNG position on load, which is what
  "Predictable" means upstream.
- `random_mode` recorded in `SaveGameData`, carried over between
  scenarios, and written/read by the Wesnoth save converter
  (`game_classification`, `savegame.cpp:607`).
- The menu added to Phase 21's campaign selection dialog with upstream's
  labels and tooltips.
- **Milestone**: the same attack, reloaded from a save, gives the same
  result under Predictable and may differ under Default; Reduced RNG's
  hit distribution matches upstream's on a fixed seed.

## Phase 31 — World Conquest (added 2026-10-05)

**Status: not started, not scheduled.** Split out of Phase 28c (user's call, 2026-10-01). World Conquest
is a randomly generated campaign written almost entirely in Lua: 111 files, about 18,000 lines
(`docs/CAMPAIGN_INVENTORY.md`). What the 2026-10-04 survey lists for it:

- 15 Lua API names the bridge does not provide yet, and 5 custom dialogs;
- its maps are generated in Lua when each scenario starts, not at build time as the other campaigns'
  generated caves are (Phase 28c C1), so the map generator has to run in the browser;
- its own achievements (`World_Conquest/achievements.cfg`), after Phase 25.

A plan is written when the phase is scheduled.

---

## Priority as of 2026-10-05

Explicit user direction (2026-09-23), superseding the 2026-09-12 list.
Phases 0–5, 7, 9–17 are delivered (see each phase's status); Phase 6
content breadth continues opportunistically. Phase 26 (save games) was
pulled forward and delivered 2026-09-22.

1. **Phase 18a** (teleport, hotseat viewing side) — delivered 2026-09-23.
2. **Phase 18b** (replay, undo & redo) — delivered 2026-09-23.
3. **Phase 18c** (unit modifications: `[effect]`, traits, `[object]`,
   runtime `[event]`, unit ids) — delivered 2026-09-26.
4. **Phase 18d** (missing WML action tags, from the audit) — delivered 2026-09-26.
5. **Phase 18** (labels/items) — delivered 2026-09-26. **Phase 19**
   (audio/music) — delivered 2026-09-26.
6. **Phase 20** (localization/accessibility) — delivered.
7. **Phase 21** (main menu) — delivered 2026-09-27. **Phase 22**
   (minimap/camera) — delivered 2026-09-27. **Phase 23** (mobile) and
   **23a** (bugs7.md playtest fixes) — delivered 2026-09-27.
8. **Phase 28** (CI/CD/performance/platform) — brought forward to right
   after Phase 23 and its fixes (user's call, 2026-09-27); delivered
   2026-09-29 as `v0.1.0`, with S7/S8 moved to Phase 28d.
9. **Phase 28b** (movement visualisation & multi-turn moves) — delivered
   2026-09-29. **Phase 28c** (the rest of the bundled campaigns) started
   with The South Guard (delivered 2026-09-29, `v0.3.0`), then **paused**
   (user's call, 2026-09-29): porting campaigns against missing subsystems
   leaves stubs to audit later, so the subsystems come first, and the
   campaigns after them in batches. First, every remaining campaign was
   surveyed statically (`docs/CAMPAIGN_INVENTORY.md`,
   `apps/web/scripts/survey-campaigns.mjs`), so the subsystems below are
   built against what the campaigns actually use.
10. **Phase 29** (real AI: RCA framework + Lua on fengari), including the
   `[micro_ai]`s and custom Lua AI the inventory ranks by use -- delivered 2026-09-30.
11. **Help browser** (from Phase 24): unit, terrain and topic pages,
   `[open_help]` -- delivered 2026-09-30 (`v0.5.0`).
12. **Phase 28c resumed** (user's call, 2026-10-01: before achievements):
   first the gaps several campaigns share (C1), then the remaining
   campaigns in four batches, easiest first (B1-B4); see Phase 28c --
   delivered 2026-10-03 (`v0.10.0`, fixes in `v0.10.1`). Every mainline
   single-player campaign but World Conquest ships.
13. **Phase 24** (the rest of the advanced UI: preferences, hotkeys, unit
   list, advancement preview; delivered 2026-10-05), then **Phase 25** (statistics, the
   statistics dialog, achievements; delivered 2026-10-05) -- the user's call, 2026-10-05, which
   moves achievements into Phase 25 rather than ahead of Phase 24.
14. **Phase 29a** (AI turns shown action by action, as upstream does) -- the user's call, 2026-10-09; delivered 2026-10-09.
15. **Phase 27** (feature completeness assessment), then **Phase 28d**
   (performance budgets, cross-browser, offline; split from Phase 28).
16. **Phase 31** (World Conquest), not yet scheduled.
17. **Phase 30** (combat RNG modes, split from Phase 21) — last, after
   everything above.

### Old → new phase numbers

`docs/PROGRESS.md` entries dated before 2026-09-12 use the old numbers.

| Old | New |
|---|---|
| 11 Fog, Shroud & Vision | 11 (unchanged) |
| 12 Time of Day | 12 (unchanged) |
| 13 Audio & Music | 19 |
| 14 Localization & Accessibility | 20 |
| 15 Replay, Statistics & Achievements | 18b (replay, undo & redo), 25 (statistics & achievements) |
| 16 Advanced Map Rendering | 18 (labels/items), 17 (camera scripting, screen fade), 22 (minimap/camera) |
| 17 Advanced UI Shell | 13 (recruit/recall/combat), 14 (theme/context menu/menu items), 15 (hotkeys), 17 (`[option]`/`[text_input]`, message options), 21 (campaign list/difficulty/credits), 23 (mobile), 24 (preferences/help/unit list/stats dialog) |
| 18 CI/CD, Performance & Platform | 28 |
| — | 16 Narration (new), 18a Teleport & hotseat view (new), 18c Unit modifications (new), 18d Missing WML tags (new), 26 Save games (new), 27 Completeness assessment (new) |

---

## Appendix — Feature-catalogue coverage map

Every category from `~/wesnoth-feature-catalogue.md`, mapped to the
phase(s) responsible. Use this to sanity-check that a future phase
reshuffle hasn't silently dropped a category; Phase 27 audits it item by
item.

| # | Category | Phase(s) |
|---|----------|----------|
| 1 | WML Parsing & Data Model | 1 (core), 6 (long-tail hardening) |
| 2 | Map & Terrain | 1 (data model), 9 (terrain graphics), 18 (labels/items), 22 (minimap) |
| 3 | Units & Unit Types | 1 (core), 6 (variations/naming, long-tail) |
| 4 | Movement & Pathfinding | 2 (core), 11 (vision-gated movement halts) |
| 5 | Combat | 2 (rules), 13 (attack/prediction dialogs) |
| 6 | Abilities | 2 (partial — generic pipeline is the main gap), 12 (illuminates) |
| 7 | Weapon Specials | 2 (partial — same generic-pipeline gap as 6) |
| 8 | Unit Modifications & Progression | 2 (core), 9/10 (rendering-dependent `apply_to=` variants) |
| 9 | Sides, Economy & Turn Flow | 2 (core), 7 (MVP AI), 29 (real AI), 25 (achievements) |
| 10 | Recruitment & Recall | 2 (rules), 13 (dialogs) |
| 11 | Scenario & Campaign Flow | 2/5 (core), 6 (options/branching), 21 (difficulty selection) |
| 12 | Events & WML Scripting | 2 (core + long-tail gap list), 3 (`[lua]`), 17 (suspendable events, `[option]`, cutscenes), 29 (`[micro_ai]`/`[modify_ai]`) |
| 13 | Fog, Shroud & Vision | 11 |
| 14 | Time of Day & Schedules | 12 |
| 15 | Story, Dialogue & Narrative | 5 (core), 16 (story overhaul), 17 (in-order dialogue, choices) |
| 16 | Game View & Map Rendering | 4 (core), 9 (terrain compositing), 17 (camera scripting), 22 (minimap/camera) |
| 17 | UI, Menus, Input & Localization | 5 (core play loop), 13/14 (dialogs, main UI), 15 (hotkeys), 20 (localization/accessibility), 21 (main menu), 23 (mobile), 24 (preferences/help) |
| 18 | Animation & Visual Effects | 10 |
| 19 | Audio & Music | 19 |
| 20 | Persistence, Undo, Replay & Platform | 2 (undo stack), 5 (save/load), 18b (replay, undo/redo in play), 25 (statistics/achievements), 26 (save management/format), 28 (CI/CD/perf/platform) |

Editor (`EditorWML`/`PblWML`) is explicitly out of scope per the
catalogue's own Appendix A and this plan's opening paragraph — no phase
covers it, deliberately.
