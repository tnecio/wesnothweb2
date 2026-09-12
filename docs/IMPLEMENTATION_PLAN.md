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
  approach; revisit alongside Phase 25's replay work.
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
  `[killed]`/`[deaths]`) — tracked under Phase 25 alongside replay.
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

- Later: port the candidate-action framework and relevant Lua micro-AIs
  using the Phase 3 Lua VM, for closer-to-original behavior — not
  attempted here, deliberately (mainline AI is substantially Lua-driven,
  `data/ai/`, 131 files using `[lua]`).

### Catalogue checklist (category 9's AI bullets)

`[side]controller=ai` must act automatically and never hang -- now real.
`[modify_ai]`/`[aspect]`/`[facet]`/`[goal]`/`[stage]`, and AI recruitment
budgeting (`[recruitment_instructions]`/`[recruit]`/`[limit]`) are real
upstream surface that only matters once the candidate-action framework
(the "later" bullet above) is underway — not needed for the MVP
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
are tracked as real, in-scope work under **Phase 25**.

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
  Sound-in-frame playback, halo/blend/submerge compositing, and
  `[delay]`/screen-shake/floating-damage-text remain unbuilt (see
  `frame.ts`'s `applyFrameEffects` stub and the catalogue checklist
  below).

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

**Status: partially started (2026-09-11: schedule model + status-bar
indicator built)** — `combatStats.ts`'s `combatModifier()` implements the
real alignment × `lawful_bonus` damage-multiplier formula (lawful/
chaotic/liminal/neutral, fearless negation). `packages/engine/src/model/
Schedule.ts` ports `tod_manager`: parses a scenario's `[time]` entries
(`lawful_bonus=`, `current_time=`), advances once per game turn, and
`DEFAULT_MAX_LIMINAL_BONUS = 25` matches
`tod_manager::get_max_liminal_bonus()`'s simplified floor. Wired end to
end: `GameSession.currentTimeOfDay` feeds combat's `lawfulBonus`/
`maxLiminalBonus` options and `TurnBanner.svelte` shows a ToD icon +
name. Still missing: time areas, illumination, `random_start_time=`,
`[replace_schedule]`/`[store_time_of_day]`, ToD colour tinting on the
board, and a schedule preview.

- `[time]` definition (id/name/image/`lawful_bonus=`/colour shift) and the
  default six-phase day cycle used when a scenario specifies none; UtBS's
  15-step two-suns schedule as the non-default fixture.
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
- Rendering: ToD colour tinting on terrain/units/overlays (Phase 9's
  remaining item), illumination rendering brighter than neighbours, a
  status-bar ToD indicator with tooltip explaining the current bonus.
  (The schedule-preview dialog is Phase 14 status-bar work.)
- ToD-conditional events, underground/indoor fixed-darkness schedules
  (`{UNDERGROUND}`/`{INDOORS}`). ToD-driven music changes are Phase 19's.
- ToD state serialisation (current phase + time areas round-trip through
  save/load).
- **Milestone**: UtBS scenario 1 plays several turns across the two-suns
  schedule with combat bonuses matching a hand-computed table, UtBS
  scenario 3's `[time_area]` applies its own ToD inside the area, the board
  tint changes visibly with ToD, and the status bar shows the right ToD
  image/name throughout.

## Phase 13 — Modal dialogs: recruit, recall, combat

**Status: not started.** Recruit/recall lists and the attack/weapon
choice currently live inline in `SidePanel.svelte`; real Wesnoth uses
modal dialogs for all three. First of the UI areas split out of the old
Phase 14/16/17 bundle (2026-09-12, user's call), prioritised ahead of
audio because it's what a player touches every single turn.

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

**Status: not started.** Goal: the in-game screen matches the real
Wesnoth default theme closely. Spec source: `data/themes/default.cfg`
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

**Status: not started.** Brought forward from the old Phase 17
(2026-09-12). Two reasons: Phase 14's command registry makes this cheap
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

## Phase 16 — Narration & story-telling overhaul

**Status: not started** (`StoryViewer.svelte`/`MessageViewer.svelte` work,
but don't match upstream visually and load slowly). Spec sources:
`src/gui/dialogs/story_viewer.cpp`, `storyscreen/`, `wml_message.cpp`,
`outro.cpp`.

- `[story]`/`[part]` backgrounds rendered as upstream does: `[background_
  layer]` scaling/`keep_aspect_ratio=`/`tile_h`/`tile_v`/`base_layer=`,
  `[image]` overlays with `x,y=`/`centered=`, text layout/`text_layout=`,
  `title_alignment=`, and `[part]` delay/`show_title=`.
- Journey tracks (`{..._JOURNEY}`/`[image]` dot-and-cross sequences) with
  their timed reveal.
- Fast loading: preload the next part's images while the current one is
  shown, size images appropriately; where a load can't be made fast, a
  clear loading indicator so the player knows the game hasn't hung.
- `[message]` dialog visuals matching upstream (portrait placement left/
  right by side, `mirror=`, speaker name, scroll-to-speaker, `image=`
  overrides), and the campaign outro/end-credits screen.
- **Milestone**: Dead Water's, Liberty's and UtBS's opening stories render
  side by side against the real binary's screenshots with matching
  backgrounds and layout, and no part takes more than a brief, visibly-
  indicated load.

## Phase 17 — Events: in-order dialogue, cutscenes, `[option]`

**Status: not started; a known architecture gap.** The event pump
(`packages/engine/src/events/pump.ts`, `actionWml.ts`) is fully
synchronous: events run to completion and their `[message]`s are replayed
to the player afterwards, so dialogue and unit movement don't interleave
the way they do upstream, and `[option]`/`[text_input]` can't feed a
choice back into the running event (Two Brothers scenario 3's password
puzzle; UtBS 2/4/5).

- Make the event pump suspendable (async actions or an explicit
  continuation/replay-of-choices model — pick the one that keeps headless
  tests deterministic), so a `[message]` blocks the event until
  dismissed and later actions render in order.
- `[option]` (with `[show_if]`, `[command]`, `variable=`/`value=`) and
  `[text_input]`; choices recorded as synced choices so Phase 25's replay
  reproduces them.
- Cutscene actions rendered in sequence: `[move_unit_fake]`,
  `[move_unit]`, `[animate_unit]`, `[delay]`, unit appear/disappear on
  `[unit]`/`[kill]` `animate=`.
- Camera scripting moved here from the old Phase 16 (it's event
  sequencing, not map rendering): `[scroll_to]`/`[scroll_to_unit]`/
  `[scroll]`, `[lock_view]`/`[unlock_view]`, `[zoom]`, `[screen_fade]`/
  `[color_adjust]` (always cleaned up afterwards).
- Message `duration=`/`side_for=`, skip-dialogue (Escape skips the rest of
  an event's messages as upstream does).
- **Milestone**: Two Brothers scenario 3's password puzzle takes the
  branch the player actually chooses, and a UtBS scenario 1 cutscene
  shows its messages, unit movements and scrolls interleaved in source
  order.

## Phase 18 — Map labels & items

**Status: not started.** Split from the old Phase 16.

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

## Phase 19 — Audio & Music (was Phase 13)

**Status: not started.** Nothing in `packages/renderer` or `packages/ui`
touches audio; this is a whole missing subsystem.

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
- **Milestone**: a real scenario's `[music]` playlist audibly plays and
  transitions correctly across a turn boundary, at least one weapon's
  attack sound fires on hit, and toggling mute silences everything
  immediately and restores it correctly on unmute.

## Phase 20 — Localization & Accessibility (was Phase 14)

**Status: not started beyond WML-syntax recognition.** Phase 1 already
parses `_ "…"` and `#textdomain`/`[textdomain]` as syntax; nothing
resolves an actual translation catalogue, switches locale at runtime, or
addresses non-Latin text layout or accessibility.

- Gettext `.po` catalogue loading per textdomain, resolving `_ "…"` values
  at *display* time (not parse time) so a locale switch updates everything
  live without a reload.
- Runtime locale switching, plural-form rules, gendered strings
  (`female_name=` and friends — connects to Phase 1's deferred
  `[variation]`/gender work).
- RTL and CJK (wide-glyph) text layout/wrapping, missing-translation
  fallback to English, locale-aware number formatting where the UI needs
  it.
- Accessibility: colourblind-safe team identity (not colour-only), full
  keyboard-only play path (built on Phase 15), font-size scaling that
  doesn't break layout, screen-reader labels on modal dialogs.
- Ordering note: the language picker lands here as a minimal selector and
  moves into the Phase 24 preferences dialog later; UI built in Phases
  13–18 should already route user-visible strings through the translation
  lookup so this phase isn't a rewrite of them.
- **Milestone**: switching the UI language at runtime (with one additional
  language's `.po` file as a fixture) updates every visible string — menu
  chrome, dialogs, in-scenario dialogue — without a page reload, and a
  scripted keyboard-only playthrough of a small scenario succeeds without
  touching the mouse.

## Phase 21 — Main menu

**Status: not started** (the current campaign picker is a plain routed
list). Spec sources: `title_screen.cpp`, `campaign_selection.cpp`,
`campaign_difficulty.cpp`.

- Title screen with the real background and button column: Campaigns,
  Load Game, Preferences, Help, Credits (multiplayer/editor/add-ons
  entries omitted — out of scope).
- Campaign selection modal: campaign list with icon, description, image,
  difficulty chooser (`[difficulty]`), and campaign completion markers
  (persisted); debug campaigns kept but visually separated.
- Load Game opens the existing load flow (fully reworked in Phase 26);
  Preferences opens Phase 24's dialog; credits screen
  (`[about]`/`[entry]`/`[credits_group]`).
- **Milestone**: starting a campaign at a chosen difficulty, and loading a
  save, are both reachable only via the main menu, matching the real
  title screen's layout.

## Phase 22 — Advanced map rendering: minimap & camera

**Status: not started.** Remainder of the old Phase 16 after labels/
items (Phase 18) and camera scripting (Phase 17) moved out.

- Minimap: downscaled terrain-colour map with unit dots and village-flag
  markers, click/drag-to-navigate, viewport rectangle, reflecting only the
  viewing side's knowledge under Phase 11's fog/shroud.
- Camera: smooth scroll-to on selection/next-unit, follow-unit-on-move,
  edge-of-screen panning, keyboard panning, zoom levels matching
  upstream's, map-bounds clamping.
- Grid overlay toggle, show-enemy-moves overlay, terrain-help data for
  Phase 24's help browser.
- **Milestone**: the minimap accurately reflects the live board including
  village ownership and fog, and clicking it recentres the camera.

## Phase 23 — Mobile UI

**Status: not started.** Sequenced after the desktop layout (Phases
13–15, 21, 22) has settled, so it adapts a stable design instead of
chasing a moving one.

- Responsive layout: collapsing infobox/status bar, full-screen modals on
  narrow viewports, larger tap targets.
- Touch input: tap-select/tap-move (with a confirm tap for moves/attacks),
  long-press context menu, pinch-zoom, drag-pan, and resize/orientation
  change without losing game state.
- **Milestone**: a full scenario is playable start-to-finish on a phone-
  sized viewport using only touch input.

## Phase 24 — Advanced UI features

**Status: not started.** The rest of the old Phase 17.

- Preferences dialog (`preferences_dialog.cpp`): display (animation speed,
  turbo/acceleration, grid, show-floating-numbers), sound volumes, hotkey
  rebinding (on Phase 15's registry), language (hosting Phase 20's
  selector), advanced — persisted.
- Unit list dialog (sortable, click-to-centre), in-game help/encyclopedia
  (`[topic]`/`[section]`/`[toplevel]`/`[open_help]`; unit/terrain/ability
  pages), statistics dialog (feeds off Phase 25), advancement-choice
  dialog polish (preview the resulting unit).
- **Milestone**: the help browser opens a real unit's stat/ability page,
  animation speed changes take effect immediately, and a rebound hotkey
  persists across reload.

## Phase 25 — Replay, Statistics & Achievements (was Phase 15)

**Status: partially started; deprioritised 2026-09-12 (user's call).**
Undo (single action, real state restoration) is done (Phase 2). Save/load
(Phase 5) captures enough state to resume a scenario, but not as a
replayable *action log* — there's no replay recording/playback, no
out-of-sync self-check, no statistics tallying, and no achievements.

- Replay recording: every synced action (move/attack/recruit/recall/
  end_turn/choose, incl. Phase 17's `[option]` choices) logged in order,
  independent of the snapshot-based save system, so a finished scenario
  replays from turn 1 to identical state — also the natural place to close
  Phase 1's deferred "round-trip serialisation" gap.
- Redo stack (extends Phase 2's undo stack; invalidated by any new
  action).
- Out-of-sync self-check: replay a recorded scenario and diff final state
  against the live run — a strong regression test in its own right.
- `[sync_variable]` correctness.
- Statistics (`[statistics]`/`[team]`/`[attacks]`/`[defends]`/`[killed]`/
  `[deaths]`): damage dealt/taken (expected vs. actual), kills/losses,
  recruits/recalls/advances per side per scenario, rolled up per campaign.
- Achievements (`[achievement]`/`[achievement_group]`/`[sub_achievement]`/
  `[set_achievement]`/`[progress_achievement]`/`[has_achievement]`) —
  UtBS ships a real `achievements.cfg` to test against.
- Persistent global variables (`[set_global_variable]`/
  `[get_global_variable]`/`namespace=`) — same durable storage layer as
  achievements.
- **Milestone**: a scripted scenario's full action sequence replays from a
  recorded log to bit-identical final state, the statistics dialog shows
  correct expected-vs-actual combat numbers for that run, and one real
  UtBS achievement completes and stays earned across a reload.

## Phase 26 — Save game handling

**Status: basic save/load only** (Phase 5: gzipped config tree in
IndexedDB, no management UI). Sequenced after Phase 25 because upstream
save files embed the `[replay]` log, so format compatibility depends on it.

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

**Status: partially started informally.** Every engine/UI change already
ships with real unit/integration tests and real-browser Playwright
verification before a commit — but that's a per-session practice, not a
CI pipeline, and none of the deployment/performance/cross-browser items
below exist yet.

- CI pipeline: lint + unit + integration + UI suites on every commit, with
  clear failure reporting.
- Staging deployment (auto-deploy from `main`) and tagged-release
  deployment with versioning/rollback.
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
  test suites plus a browser smoke test, a staging build is reachable at a
  stable URL, and a deliberately-broken build fails CI before it can
  deploy.

---

## Priority as of 2026-09-12

Explicit user direction (2026-09-12), superseding the 2026-09-09 priority
section. Phases 0–5, 7, 9, 10 are delivered (see each phase's status);
Phase 6 content breadth continues opportunistically as each new phase
pulls in real content, rather than as the headline focus.

1. **Phases 11 + 12** (fog/shroud/vision, time of day) with the Under the
   Burning Suns testbed. ← **current focus**
2. **Phase 13** (recruit/recall/combat modals), **Phase 14** (main game UI
   overhaul), **Phase 15** (core keyboard shortcuts).
3. **Phase 16** (narration), **Phase 17** (events/`[option]`/cutscenes).
4. **Phase 18** (labels/items), **Phase 19** (audio/music).
5. **Phase 20** (localization/accessibility).
6. **Phases 21–24** (main menu, minimap/camera, mobile, advanced UI).
7. **Phase 25** (replay/statistics/achievements).
8. **Phase 26** (save game handling).
9. **Phase 27** (feature completeness assessment).
10. **Phase 28** (CI/CD/performance/platform).

### Old → new phase numbers

`docs/PROGRESS.md` entries dated before 2026-09-12 use the old numbers.

| Old | New |
|---|---|
| 11 Fog, Shroud & Vision | 11 (unchanged) |
| 12 Time of Day | 12 (unchanged) |
| 13 Audio & Music | 19 |
| 14 Localization & Accessibility | 20 |
| 15 Replay, Statistics & Achievements | 25 |
| 16 Advanced Map Rendering | 18 (labels/items), 17 (camera scripting, screen fade), 22 (minimap/camera) |
| 17 Advanced UI Shell | 13 (recruit/recall/combat), 14 (theme/context menu/menu items), 15 (hotkeys), 17 (`[option]`/`[text_input]`, message options), 21 (campaign list/difficulty/credits), 23 (mobile), 24 (preferences/help/unit list/stats dialog) |
| 18 CI/CD, Performance & Platform | 28 |
| — | 16 Narration (new), 26 Save games (new), 27 Completeness assessment (new) |

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
| 9 | Sides, Economy & Turn Flow | 2 (core), 7 (AI), 25 (achievements) |
| 10 | Recruitment & Recall | 2 (rules), 13 (dialogs) |
| 11 | Scenario & Campaign Flow | 2/5 (core), 6 (options/branching), 21 (difficulty selection) |
| 12 | Events & WML Scripting | 2 (core + long-tail gap list), 3 (`[lua]`), 17 (suspendable events, `[option]`, cutscenes) |
| 13 | Fog, Shroud & Vision | 11 |
| 14 | Time of Day & Schedules | 12 |
| 15 | Story, Dialogue & Narrative | 5 (core), 16 (story overhaul), 17 (in-order dialogue, choices) |
| 16 | Game View & Map Rendering | 4 (core), 9 (terrain compositing), 17 (camera scripting), 22 (minimap/camera) |
| 17 | UI, Menus, Input & Localization | 5 (core play loop), 13/14 (dialogs, main UI), 15 (hotkeys), 20 (localization/accessibility), 21 (main menu), 23 (mobile), 24 (preferences/help) |
| 18 | Animation & Visual Effects | 10 |
| 19 | Audio & Music | 19 |
| 20 | Persistence, Undo, Replay & Platform | 2 (undo), 5 (save/load), 25 (replay/statistics/achievements), 26 (save management/format), 28 (CI/CD/perf/platform) |

Editor (`EditorWML`/`PblWML`) is explicitly out of scope per the
catalogue's own Appendix A and this plan's opening paragraph — no phase
covers it, deliberately.
