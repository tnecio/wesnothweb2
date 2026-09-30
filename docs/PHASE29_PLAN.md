# Phase 29 plan — real AI (RCA framework + Lua CAs/micro-AIs on fengari)

Recovered 2026-09-29 from the session that wrote it (2026-09-13). It first lived
at `~/.claude/plans/wise-squishing-deer.md`, a file later reused for the Phase 26
plan, so it is kept in the repo now. S0–S6 are delivered (see
`docs/PROGRESS.md`); the S7 revision below supersedes section C where they
differ.

## S7 revision (2026-09-29): an upstream-shaped Lua kernel

Since this plan was written, Phase 28c added `lua-bridge`'s `LuaRuntime` (a
campaign's own Lua: `[lua]`, Lua-defined tags, `gui.show_dialog`) on a small
hand-written bootstrap. The AI's Lua needs far more of the API, and upstream
builds that API in layers, so S7 follows the same layering instead of growing
the bootstrap:

1. **Base kernel** (`lua_kernel_base.cpp`): the C++ halves of `stringx`,
   `mathx` (its `random` on the game's RNG), `wml`, `filesystem` (over a
   virtual data directory), `wesnoth.{require,dofile,textdomain,log,
   named_tuple,version,...}`, the `wesnoth.map` location operations and
   `wesnoth.game_config`, then `data/lua/package.lua` **verbatim** for
   `wesnoth.require`.
2. **Game kernel** (`game_lua_kernel.cpp`, `lua_unit.cpp`, `lua_team.cpp`,
   `lua_terrainmap.cpp`, …): units, sides, the map, paths, combat simulation,
   schedule, sync — what `data/ai` and the core files use, nothing more.
   Anything not bridged is a Lua error naming it.
3. **Core** (`load_core`): `data/lua/core/*.lua` run **verbatim**, which is
   where the Lua halves of `mathx`/`stringx`/`wesnoth.map`/`wml`/units come
   from.
4. **AI** (`src/ai/lua/core.cpp`, `engine_lua.cpp`): the `ai` table per side
   and `engine=lua` candidate actions, injected into the engine's
   `AiManager` as a candidate-action factory (the engine never imports
   lua-bridge).

`LuaRuntime` moves onto this kernel, so a campaign's Lua and the AI's share
one state, as upstream's do. Sources reach the browser as a lazily fetched
bundle (S8).

---


## Context

Phase 7 shipped a deliberately simple heuristic AI (`packages/engine/src/ai/simpleAi.ts`, ~400 lines, wired into `GameSession.endTurn`) and postponed the real thing: "Later: port the candidate-action framework and relevant Lua micro-AIs using the Phase 3 Lua VM". `docs/OPEN_QUESTIONS.md` #4 records that a real AI is a required deliverable. The heuristic ignores every `[ai]` block (all of which already survive verbatim in `snapshot.scenarioConfigJson`), fires no WML events for its actions, and is too weak to survive Dead Water 1 when playing the human side.

Upstream's AI is a ~20k-line C++ framework (`src/ai/`, available byte-identical at `/home/tom/wesnothweb/wesnoth/src/ai`, version 1.19.21+dev, same as the data submodule) whose default main loop mixes 9 C++ candidate actions with 5 Lua ones, plus ~15k lines of Lua in `wesnoth/data/ai/` (`ai_helper.lua` 2548, `battle_calcs.lua` 1612, 20 micro-AI types across 54 CA files). None of `data/ai` uses Lua 5.4 syntax, so the existing fengari bridge (`packages/lua-bridge`, Phase 3) can run it unmodified.

**Decisions (user, 2026-09-13):**
1. TS-port the framework and the C++ CAs; run `data/ai/**/*.lua` **verbatim on fengari** behind a ported `wesnoth.*`/`ai.*` host API.
2. Micro-AI scope: shipped-campaign types first (zone_guardian, messenger_escort, simple_attack, assassin, coward, forest_animals), then other mainline types (goto, patrol, return_guardian, healer_support, hang_out, wolves, big_animals), test-only types last.
3. Include a headless AI-vs-AI benchmark harness.

**Milestone:** "Dead Water plays with the real default AI" is reachable with pure TS (stages S0–S5) because Dead Water uses only simplified aspects, `[avoid]`, `[goal]`, and `ai_algorithm=idle_ai`. The fengari stages add fidelity (retreat_injured, spread_poison, high_xp_attack, place_healers, move_to_any_enemy) and unlock Liberty/UtBS/HttT micro-AIs.

Numbering: new **Phase 29** in `docs/IMPLEMENTATION_PLAN.md` (28 is the highest); Phase 7's "Later" bullet gets a pointer to it.

## Verified facts that shape the design

| Fact | Consequence |
|---|---|
| `Unit` has no `goto`; `UnitType` has no `usage` | S0 adds both (goto CA; recruitment scouts/healers) |
| `Team.fromConfig` ignores `[ai]`; `findSideConfig(scenarioConfigJson, side)` exists (`actions/carryover.ts:185`) | AI config read from the snapshot by an `AiManager`; `Team` untouched |
| `events/filter.ts`: `locationMatchesFilter` is x/y only; `findLocations` (terrain=, and/or/not) is module-private; SUF lacks `role`/`race`/`ability`/`has_weapon`/`status` | S0 exports/extends these for `[avoid]`, `[filter_own]`, micro-AI `[filter]` |
| Human paths raise `moveto`/`capture`/`attack`/`attack end`/`last breath`/`die`/`recruit`/`sighted`; AI path raises none | S0 extracts move/attack choreography into engine so both paths share it |
| `goldenScenario.test.ts` scripts its own board (no AI) | AI RNG draws don't break bit-reproducibility test; only `ui/src/gameSession.test.ts:227-262` AI assertions are RNG-sensitive (they assert shape) |
| `lua-bridge/src/index.ts` re-exports `dataLua.ts` (imports `node:fs`) | Split a browser-safe barrel before `ui` can depend on lua-bridge |
| `installRequire` is exact-name only; `data/ai` needs `"ai/lua/ai_helper.lua"`, `"ai/lua/ai_helper"`, `"location_set"`, `"functional"`, and directory require `"ai/micro_ais/mai-defs"` | Port `resolve_package` from `wesnoth/data/lua/package.lua:17-64` |
| fengari `math.random` is JS `Math.random` | Rebind to the session RNG |
| `ai_default_rca.cfg`/`default_config.cfg` are macro-based | Pre-generate parsed configs into a checked-in TS module; a test diffs against regeneration |
| RCA loop is ~60 lines (`stage_rca.cpp:78-146`); scores live in `data/core/macros/ai_candidate_actions.cfg` | Loop must be exact: enable all → sort by max_score desc → early-break when `max_score <= best` → execute best if `> 0` → disable CA if gamestate unchanged → repeat until nothing executes |

## Stages

Each stage is its own commit(s), ends with all suites green (`vitest` engine/renderer/ui/lua-bridge, `tsc --noEmit`, `svelte-check`) and a dated `docs/PROGRESS.md` entry.

| # | Stage | Pkg | Dead Water milestone? | Checkable outcome |
|---|---|---|---|---|
| S0 | Engine prerequisites | engine | yes | New fields/filters/choreography unit-tested |
| S1 | Framework core + idle_ai + simple CAs (goto, move_leader_to_keep, leader_shares_keep, healing, villages) | engine | yes | `AiComposite.playTurn()` on synthetic boards; RCA/aspect/config tests |
| S2 | `attacks` aspect + `attack_analysis` + combat CA + power_projection | engine | yes | Rating tests vs hand-computed C++ formula |
| S3 | recruitment CA + aspect | engine | yes | Recruit scoring tests |
| S4 | move_to_targets + find_targets + move_leader_to_goals + retreat (1_14 config only) | engine | yes | Target rating/clustering tests |
| S5 | GameSession/GameShell integration, `ai turn` event, `[modify_ai]`/`[modify_side][ai]`, save/load, delete `simpleAi.ts` | engine+ui | **milestone** | Dead Water 1 side 2 plays a full RCA turn in vitest and in the browser |
| S6 | Headless AI-vs-AI benchmark harness | ui/scripts | recommended next | `npx tsx packages/ui/scripts/ai-benchmark.ts` prints win rate/turns/ms |
| S7 | Lua host API on fengari + `engine=lua` CAs; 5 default-loop Lua CAs | lua-bridge | no | Each Lua CA evaluates/executes in node tests |
| S8 | Browser wiring: Lua source bundle, ui→lua-bridge dep, lazy load | web+ui | no | Live browser: Dead Water 1 with Lua CAs, console clean |
| S9 | `[micro_ai]` + helpers + batch-1 micro-AIs | lua-bridge+engine | no (Liberty needs it) | Liberty 1 zone_guardian works; synthetic micro-AI tests |
| S10 | Batch-2 mainline micro-AIs | lua-bridge | no | Upstream micro-AI test scenarios as snapshots run headless |
| S11 | Test-only micro-AIs + remaining upstream AI test scenarios | lua-bridge | no | Remaining `data/ai/micro_ais/scenarios/*.cfg` run headless |
| S12 | Perf pass, docs finalisation, Web Worker note | all | no | Benchmark budget met; docs updated |

## A. Engine module layout (`packages/engine/src/ai/`)

```
ai/
  index.ts                  barrel (replaces `export * from './ai/simpleAi.js'` in src/index.ts)
  types.ts                  AiAction, AiAnimationEvent (moved verbatim from simpleAi.ts), AiHost, AiWmlHooks
  manager.ts                AiManager: per-side holder, lazy create, component ops, save/restore   (manager.cpp:74-230, 581-593)
  context.ts                AiContext: move maps, caches, typed aspect getters, targets, is_active (contexts.cpp)
  moveMaps.ts               calculateMoves / MoveMap                                          (contexts.cpp:321-420)
  powerProjection.ts        powerProjection, bestDefensivePosition                           (contexts.cpp:972-1083, 445-489)
  keeps.ts                  keepsCache, nearestKeep, suitableKeep, leaderCanReachKeep         (contexts.cpp:869-971, 1144-1186)
  actions.ts                check*/execute* move/attack/recruit/recall/stopunit + result codes (actions.cpp)
  config/
    builtinAiConfigs.generated.ts   parsed default_config.cfg + ais/*.cfg (generated by packages/engine/scripts/gen-ai-configs.ts)
    upgrade.ts              expandSimplifiedAspects, parseSideAiConfig                       (configuration.cpp:196-390)
  composite/
    component.ts            Component, path parsing `stage[main_loop].candidate_action[x]`, add/change/delete (component.cpp:66-260)
    aspect.ts               CompositeAspect<T> (facets + default, last-active-facet-wins), StandardAspect, value parsers (aspect.hpp:203-330)
    goal.ts                 TargetUnitGoal, TargetLocationGoal, ProtectGoal, Target             (goal.cpp)
    stage.ts                Stage, IdleStage (name=empty)                                     (stage.cpp)
    rca.ts                  CandidateAction (BAD_SCORE=0, max_score default 1e7, enable/disable, [filter_own]); RcaStage loop (rca.cpp, stage_rca.cpp:78-146)
    engine.ts               AiEngine interface, DefaultEngine (engine=cpp), AiEngineFactory (injection point for the Lua engine)
    aiComposite.ts          AiComposite: playTurn/newTurn/toConfig                            (ai.cpp:48-190)
  default/
    attackAnalysis.ts       AttackAnalysis.analyze/rating/attackClose                         (attack.cpp:42-333)
    aspectAttacks.ts        analyzeTargets, doAttackAnalysis (depth 5, max_positions 1000), rateTerrain, [filter_own]/[filter_enemy] (aspect_attacks.cpp:45-406)
    findTargets.ts          findTargets (threat/village/leader/explicit/support + clustering)  (default/contexts.cpp:94-266)
    caGoto.ts               ca.cpp:53-153
    caCombat.ts             ca.cpp:154-266
    caMoveLeaderToGoals.ts  ca.cpp:267-388
    caMoveLeaderToKeep.ts   ca.cpp:389-534
    caVillages.ts           ca.cpp:535-1311 (find_villages, dispatch simple/complex bipartite matching, leader moves last)
    caHealing.ts            ca.cpp:1313-1387
    caRetreat.ts            ca.cpp:1388-1540 (only in ai_default_rca_1_14)
    caLeaderSharesKeep.ts   ca.cpp:1563-1620
    caMoveToTargets.ts      ca_move_to_targets.cpp:118-854 (rate_target, move_cost_calculator ×4 occupied, grouping)
    recruitment.ts          recruitment.cpp:118-1914 (jobs/limits, important hexes, compare_unit_types, diversity normalisation, randomness, save_gold, recalls)
    registry.ts             name → ctor: "ai_default_rca::goto_phase" … "default_recruitment::recruitment", "ai_default_rca::aspect_attacks", "composite_aspect", "standard_aspect", "ai_default_rca::candidate_action_evaluation_loop", "empty" (+ legacy "testing_ai_default::" aliases)
  wml/
    aiWmlActions.ts         [modify_ai] (port of data/lua/wml/modify_ai.lua), [modify_side] incl. [ai] child, [micro_ai] delegate → registered in events/actionWml.ts
```

Key contracts:

```ts
export interface AiHost {
  board: GameBoard; rng: Rng; resolveType: (id: string) => UnitType;
  lawfulBonusAt: (loc: Location) => number; maxLiminalBonus: number;
  turnNumber: () => number; timeOfDayId: () => string;
  raise: (name: string, loc1?: Location, loc2?: Location, data?: WmlConfig) => void; pump: () => void;
  log: (level: 'debug'|'info'|'warn'|'error', msg: string) => void;
  scenarioEnded: () => boolean;   // stop the turn if [endlevel] fired mid-turn
}
export abstract class CandidateAction extends Component {
  id; name; engine; score; maxScore; enabled; toBeRemoved; filterOwn?: WmlConfig;
  abstract evaluate(): number; abstract execute(): void; isAllowedUnit(u: Unit): boolean; toConfig(): WmlConfig;
}
export type MoveMap = Map<string /* Location.key() */, Location[]>;   // srcdst / dstsrc multimaps
```

`gamestate_changed` semantics: `execute*` in `actions.ts` bumps `ctx.gamestateChangeCounter` only when the world changed; `RcaStage` compares before/after `execute()` and disables the CA for the rest of the stage run if unchanged. Add an execution cap per stage (1000, warn + break) that upstream lacks.

**Reused engine functions (no changes):** `reachableHexes`/`DestVect`, `findPath`, `aStarSearch`, `ShortestPathCalculator`, `enemyZoc`, `findVacantTile`, `isUnitVisibleToTeam`, `getVisibleUnit`, `buildBattleContext`, `simulateCombat` (with `prev` chaining for multi-attacker analysis), `chooseDefenderWeaponIndex`, `betterCombat`, `computeLeadershipBonus`, `computeResistanceModifier`, `isBackstabActive`, `combatModifier`, `executeMove`, `executeAttack`, `recruitUnit`, `recallUnit`, `checkRecruitLocation`, `findVacantCastleTile`, `canRecruitOn`, `connectedCastleTiles`, `advanceUnitFully`, `unitMatchesFilter`, `findUnits`, `WmlConfig`, `findSideConfig`, `Rng.getRandomInt/getRandomDouble`. The temporary-relocation pattern in `simpleAi.ts`'s `evaluateAttack` (board.moveUnit + restore, occupant guard) is the proven template for `attackAnalysis.analyze`.

### S0 engine additions

| Addition | File | Why |
|---|---|---|
| `Unit.goto?: Location` (`goto_x/goto_y` in `fromConfig`, snapshot, save) | `model/Unit.ts`, `snapshot/gameBoardSnapshot.ts` | goto CA |
| `UnitType.usage: string` (`usage=`) | `model/UnitType.ts`, snapshot `UnitTypeSnapshot`, `apps/web/scripts/build-scenario-snapshot.mjs` | recruitment scouts, `ca_place_healers` (`usage=="healer"`) |
| SUF keys `role=`, `race=`, `ability=`, `has_weapon=`, `status=`, `ai_special=` | `events/filter.ts` | `[filter_own]`, micro-AI `[filter]` |
| Export `findLocations`; add `locationMatchesFilterOnBoard(board, loc, cfg)` | `events/filter.ts` | `[avoid]`, `ai.aspects.avoid`, `wesnoth.map.find` |
| `actions/attackSequence.ts` `performAttack(...)`: raise `attack` → `executeAttack` → `last breath`/`die` → `attack end` → `advanceUnitFully` both; refactor `GameSession.confirmAttack` (~1930-1975) onto it | engine, ui | one choreography for human + AI |
| `actions/moveSequence.ts` `performMove(...)`: `executeMove` + `capture`/`moveto` raise (from gameSession.ts ~1780-1793) | engine, ui | same |
| `Unit.toConfig()` (extract from `actionStoreUnit`) | `model/Unit.ts` | `unit.__cfg` in Lua, `[engine][data]` |
| `packages/engine/scripts/gen-ai-configs.ts` → `ai/config/builtinAiConfigs.generated.ts` (`DEFAULT_AI_CONFIG`, `AI_ALGORITHM_CONFIGS['ai_default_rca'|'ai_default_rca_1_14'|'ai_experimental'|'idle_ai']`) | engine | browser has no WML preprocessor |
| Move `simpleAi.test.ts` helpers (`loadTerrainData`, `flatMoveType` keyed by terrain id, `makeWeapon`, `makeUnitType`, bordered board builder) into `test/ai/helpers.ts` | engine tests | shared by all CA tests |

## B. GameSession / GameShell integration (S5)

1. **`AiManager`** (`ai/manager.ts`): `getOrCreate(side)` = `parseSideAiConfig(default_config + ai_algorithm base + [side][ai] blocks)` then apply the blocks' `[modify_ai]`/`[micro_ai]` children (holder::init, manager.cpp:80-114); `playTurn(side): AiAction[]`; `addComponent/changeComponent/deleteComponent(side, path, cfg)`; `appendSideAi(side, cfg)` for `[modify_side][ai]`; `toSaveData()/restore()`. `GameSession` constructs it with `sideAiConfigs: side => findSideConfig(snapshot.scenarioConfigJson, side)?.children('ai') ?? []`.
2. **`playAiSide`** (gameSession.ts ~1457): `this.fire('ai turn')` (manager.cpp:587), then `aiManager.playTurn(side)`, push messages/animations as today, `pumpEvents()`. `AiAction`/`AiAnimationEvent` contract unchanged, so `GameShell.playAiAnimations` (GameShell.svelte:730-748) is untouched. `AiHost.scenarioEnded = () => !!this.scenarioResult`.
3. **WML actions** registered in `createDefaultActionRegistry()`: `modify_ai` (path syntax + add/change/delete/try_delete), `modify_side` (currently unregistered at all: side fields + `[ai]` child), `micro_ai` (delegates to `EventContext.ai?.microAi(cfg)`; logs "Lua AI engine not loaded" when absent). `EventContext` gains optional `ai?: AiWmlHooks`.
4. **RNG:** single session RNG (`AiHost.rng = session.rng`; S7 rebinds Lua `math.random`/`randomseed` to it), matching upstream's synced-RNG model needed for Phase 25 replay.
5. **Synchronous** turn execution as now; Web Worker with the `AiAction[]` log as protocol documented as future work.
6. **Save/load:** `SaveGameData.ai?: {side, cfg}[]` from `AiComposite.toConfig()` (ai.cpp:173: aspects+facets incl. those added by `[modify_ai]`, stages/CAs incl. micro-AI-added Lua CAs with `[args]`, `[engine name=lua][data]`); `units[].variables` and `goto` persisted. Recruitment's per-turn caches are recomputed at `newTurn` (nothing to persist).
7. **Delete `simpleAi.ts`**; port its 12 tests' intent (good trade taken, bad trade declined, village capture, closing distance, plague, advancement) onto the combat/villages/move_to_targets CAs.

## C. Lua layer (S7–S11), in `packages/lua-bridge`

- **Package split:** `src/index.ts` browser-safe (no `node:fs`); `src/node.ts` for `readDataLuaFile` + `loadAiLuaSourcesFromDisk(repoRoot): LuaSourceMap` (all `wesnoth/data/ai/**/*.lua` + `data/lua/{location_set,functional,...}.lua`, patched files substituted). `packages/ui/package.json` gains `@wesnothweb2/lua-bridge`. Engine never imports lua-bridge: lua-bridge implements `AiEngineFactory` (`src/ai/luaAiEngine.ts: createLuaAiEngineFactory(sources, opts)`), passed via `GameSessionOptions.aiEngines`.
- **Lua state:** one state per `GameSession` (global `wesnoth.micro_ais`, `wesnoth.package`), one `ai` table per side swapped before each CA call; `wesnoth.current.side` follows the active side.
- **Sources to the browser:** `apps/web/scripts/build-lua-bundle.mjs` → `apps/web/public/lua/ai-bundle.json` (`{path: source}`, ~600 KB raw / ~120 KB gzip); `PlayPage.svelte` fetches it lazily only when a side is `ai`/`network_ai`, before `runStartupEvents()` (prestart `[micro_ai]`). Node tests and browser consume the identical `LuaSourceMap`.
- **`wesnoth.require`** (`src/host/require.ts`): port `resolve_package` (package.lua:17-38: try `name`, `name.lua`, `lua/name`, `./name` relative to the requiring chunk) and directory require (package.lua:56-64, sorted `*.lua`), cache in `wesnoth.package`; add `wesnoth.dofile`.
- **Lua↔WML** (`src/host/wmlConvert.ts`): `luaToWmlConfig`/`pushWmlConfig` mirroring `luaW_toconfig`/`luaW_pushconfig` (string keys → attributes, integer keys → `{tag, subtable}` children). Used for SUF/SLF args, `[args]`, `add_ai_component` cfgs, `[engine][data]`.
- **Host API, in order of need** (grep `data/ai` at S7 start for the exact `wml.*`/`stringx.*`/`mathx.*` set):

| Group | Surface | First consumer |
|---|---|---|
| core | `wesnoth.current.{side,turn,map}`, `require/dofile/package`, `log`, `deprecate_api`, `named_tuple`, `ms_since_init`, `game_config.{poison_amount,combat_experience,kill_experience,debug}`, `scenario.turns`, `interface.*` no-ops, `math.random` → session RNG | ai_helper.lua load |
| units | `units.get(x,y)/get(id)`, `find_on_map(SUF)`, `find`, `create`, `to_map`, `erase`; proxy fields x,y,id,type,side,hitpoints,max_hitpoints,moves,max_moves,attacks_left,max_attacks,experience,max_experience,level,cost,canrecruit,usage,alignment,race,name,role,status.*,variables,abilities,attacks[] (name/damage/number/range/type/specials/__cfg),hidden,advances_to,movement_type,__cfg; methods `matches(SUF)`, `resistance_against`, `defense_on`, `movement_on`, `ability` | all Lua CAs |
| sides | `sides[n].{side,gold,recruit,team_name,is_enemy(),__cfg}` (with live `[ai]` from `AiComposite.toConfig()`), `sides.is_enemy`, `add_ai_component`, `delete_ai_component`, `change_ai_component` | retreat.lua, micro_ai_helper |
| map | `map.find(SLF)`, `current.map[{x,y}]`/`get`, `distance_between`, `get_owner`, `matches`, `on_board`, `iter`, `width/height`; `terrain_types[code]`; `unit_types[id]`; `races` | ai_helper, retreat, recruit CAs |
| paths | `paths.find_reach(unit, {ignore_units, additional_turns, viewing_side, max_cost})`, `find_path(…, {ignore_units, max_cost, viewing_side, ignore_teleport, calculate = Lua cost fn})`, `find_vacant_hex` | ai_helper |
| combat | `simulate_combat(att, [w], def, [w])` → stat tables (`hp_chance`, `average_hp`, `poisoned`, `slowed`, `untouched`) + weapon tables, built natively from `buildBattleContext`+`simulateCombat` | battle_calcs, high_xp_attack, spread_poison |
| schedule | `schedule.get_time_of_day([turn],[loc])`, `get_illumination` | `get_unit_time_of_day_bonus` |
| wml actions | `wml_actions.{message,fire_event,clear_variable,store_items,redraw}` → engine `ActionRegistry`; `wml.variables` (existing); `sync.invoke_command` (forest_animals) | micro-AIs |
| `ai` table | mutators (execution only): `move`, `move_full`, `attack`, `recruit`, `recall`, `stopunit_*`, `fallback_human`; `check_*`; `ai.side`; `ai.aspects.<id>` (core.cpp:747; `attacks` → `{own, enemy}` unit lists); deprecated `ai.get_*` (core.cpp:915-930); `get_new_dst_src`/`src_dst`/`enemy_*`, `is_*_valid`, `recalculate_*_move_maps`; `get_targets`, `get_attacks` (core.cpp:313-370); `suitable_keep`; `ai.cache` via verbatim `cache.lua`, `stdlib.lua` via `dummy_engine_lua.lua` | all CAs |

- **CA wrapper** (`src/ai/luaCandidateAction.ts`, engine_lua.cpp:160-215): compile once `local self, params, data, filter_own = ...\nreturn wesnoth.require("<location>").evaluation(self, params, data, filter_own)` (+ `.execution`), or inline `evaluation=`/`execution=`; `sticky=yes` variant. `params` = `[args]`, `data` = per-CA persistent table serialised into `[engine][data]`.
- **Read-only evaluation:** mutators check a JS phase flag and `error("ai.<fn> is not available during evaluation")`.
- **Errors:** every evaluate/execute under `lua_pcall`; on error → `host.log('error', traceback)`, disable CA for this stage run, count; after 3 errors mark `toBeRemoved`. Non-number evaluate → `BAD_SCORE`. Throwing execute = no gamestate change → disabled.
- **Performance:** move maps computed in TS, exposed lazily as location_set-shaped tables cached per turn; `find_reach`/`find_path`/`simulate_combat`/`unit:matches` native; unit proxies cached per `Unit` (WeakMap) so Lua equality holds (verify fengari-interop wrapper identity in the first test); measure with S6 before/after S7.
- **`[micro_ai]`** (S9): run `data/lua/wml/micro_ai.lua`, `micro_ai_helper.lua`, `micro_ai_self_data.lua`, `micro_ai_unit_variables.lua` verbatim; `wesnoth.sides.add_ai_component(side, "stage[main_loop].candidate_action", cfg)` → `AiManager.addComponent` with `luaToWmlConfig(cfg)`; unique `ai_id` derivation reads `sides[n].__cfg` `[ai]` children served from `AiComposite.toConfig()`.

## D. Tests per stage

| Stage | Tests |
|---|---|
| S0 | Unit goto/usage round-trip; SUF new keys; `[avoid]`-style SLF terrain=/not; `attackSequence` event order (`attack`, `last breath`, `die`, `attack end`) via recording `raise`; `builtinConfigsInSync` regenerates from `wesnoth/data/ai` and diffs |
| S1 | `rcaStage`: sort desc, early-break, disable-on-no-change, all-zero ends, cap. `aspect`: last-added active facet wins, `turns=1-3,7`, `time_of_day=`, invalidation. `configUpgrade`: plain keys → facets, `[target]`/`[protect_*]` → `[goal]`+`[criteria]`, `ai_algorithm=idle_ai`, no `[stage]` → default RCA, merge by id, real Dead Water 1 side 2 `[side]`. `component` path ops. `moveMaps`: self-move, allied villages excluded, avoid, enemy full-MP/visibility. CA tests on the bordered 6×6 synthetic board: goto, move_leader_to_keep (suitable_keep/next_hop), villages simple+complex (2 units × 2 villages crossing), healing, leader_shares_keep, idle_ai produces zero actions |
| S2 | `attackAnalysis`: hand-computed `rating()` (attack.cpp:268-333) at aggression 0.4 and 1.0; chance_to_kill/avg_losses/terrain_quality; `powerProjection` vs hand formula (contexts.cpp:1010-1080); sanity veto; leader_threat ×5. `aspectAttacks`: `[filter_own]`/`[filter_enemy]`, depth bound, surround/backstab. Combat CA takes a good trade, declines a bad one |
| S3 | `recruitment`: `compare_unit_types` sign symmetry, pattern → job, `[limit]`, `importance`, `recruitment_randomness=0` deterministic, save_gold, scouts from villages, recall preferred, spends until unaffordable |
| S4 | `findTargets`: village/leader/explicit/clustering `+= v_j/dist²`. `moveToTargets`: scout × `scout_village_targeting`, occupied ×4, grouping modes. move_leader_to_goals with `[goal] name=target_location`. retreat under `ai_default_rca_1_14` |
| S5 | ui `gameSession.test.ts`: Dead Water 1 `endTurn()` completes side 2, animations non-empty, recording pump shows `ai turn`/`recruit`/`moveto`; idle_ai side → no actions; prestart `[modify_ai] action=delete …candidate_action[combat]` → no attacks; save→load round-trips a modify_ai facet; `[modify_side][ai]` appends |
| S6 | `aiBenchmark.test.ts`: 2 games × 8 turns on `synth_combat_02` all-AI complete; same seed → identical action log; ms/turn under a generous budget |
| S7 | lua-bridge: `require` resolution + directory require; `wmlConvert` round-trip; `hostApi` vs engine ground truth; each of the 5 default-loop Lua CAs fires on a board built to trigger it (injured unit near village; poisoner adjacent; high-XP target; healer + wounded; lone enemy); throwing CA is disabled and the turn ends; `math.random` sequence equals engine RNG |
| S8 | `build-lua-bundle` output exists; live browser Dead Water 1 End Turn, console clean, retreat_injured observed |
| S9 | `microAi.test.ts` per batch-1 type on new `synthetic-campaigns/ai/` scenarios; ui: Liberty 1 prestart `[micro_ai]` applies and plays; two zone_guardians on one side get unique ids |
| S10–S11 | Build `wesnoth/data/ai/micro_ais/scenarios/*.cfg` and `data/ai/scenarios/*.cfg` via `build-scenario-snapshot.mjs` (may need a `--define TEST` flag) into `apps/web/public/scenarios/ai_test_*.json`; headless N turns without Lua errors |

**Benchmark harness (S6):** `packages/ui/scripts/ai-benchmark.ts` (`npx tsx`; `GameSession` is DOM-free). Flags: `--scenario 01_Invasion|synth_combat_02 --games 10 --seed 1 --max-turns 40 --all-ai --lua`. Output: one JSON line per game `{seed, winner, turns, ms, msPerTurn, actions, luaErrors}` + summary (win rate per side, mean/median turns, mean ms/turn). Add `synthetic-campaigns/combat/scenarios/02_combat_ai.cfg` (both sides `controller=ai`, keep + gold each).

**Live-browser checks:** S5 Dead Water 1 End Turn (recruits, leader stays on keep, villages grabbed, attacks; console clean; save/load then End Turn); S8 same with Lua CAs; S9 Liberty 1 zone_guardian.

## E. Docs

- `docs/IMPLEMENTATION_PLAN.md`: new `## Phase 29 — Real AI: RCA framework port + Lua CAs/micro-AIs on fengari` (stage table, module layout, milestone after S5); Phase 7 "Later" bullet (~561-565) → "Superseded by Phase 29"; Phase 7 catalogue checklist points to 29; coverage map row 9 → `2, 7 (MVP), 29 (real AI), 25`, row 12 adds `29 ([micro_ai]/[modify_ai])`; priority list entry.
- `docs/PROGRESS.md`: one dated entry per stage appended at the bottom, with test counts.
- `docs/OPEN_QUESTIONS.md`: `## 7. Lua AI on fengari` — decided: verbatim `data/ai` Lua on fengari, TS framework + C++ CAs, host API in `packages/lua-bridge`, sources as a JSON bundle; #4 marked in progress via Phase 29.
- `docs/ARCHITECTURE.md`: engine ↔ lua-bridge boundary (`AiEngineFactory` injection), browser vs node entry points, single-RNG note, Web Worker option.

## F. Risks

| Risk | Mitigation |
|---|---|
| fengari speed on ai_helper loops | Native reach/path/combat; per-turn caches; S6 harness before/after S7; fall back to Worker or restricting Lua CAs if a budget is blown |
| Host API surface creep | Only what `data/ai` greps and the current stage need; unknown `wesnoth.x.y` access throws a clear "not bridged" error, never silent nil |
| `attacks` aspect / attack_analysis complexity | Line-by-line port with cited C++; hand-computed rating tests; reuse the proven temporary-relocation pattern |
| Recruitment cost maps O(units × map) | Reuse `findRoutes` with `additionalTurns`, cache per side per turn; land recruitment without important-hex analysis behind a flag if the benchmark shows it dominates |
| RNG stream changes | Golden test unaffected; ui AI tests assert shape; benchmark tests seed explicitly |
| Lua bundle size | Lazy JSON fetch only when an AI side exists (~120 KB gzip), not in the JS bundle |
| SUF/SLF gaps | S0 adds the keys `data/ai` uses; Lua `unit:matches`/`map.find` share the engine filters so gaps surface as one failing test |
| Lua error hangs a turn | pcall everywhere + disable/remove policy + RCA execution cap |
| `sides[].__cfg` shape mismatch with micro_ai_helper's scan | Build from `AiComposite.toConfig()`; test unique-id derivation with two zone_guardians |

## Reference sources

- Upstream C++: `/home/tom/wesnothweb/wesnoth/src/ai/` (byte-identical to the submodule's version; not in the data-only submodule).
- Upstream data: `wesnoth/data/ai/`, `wesnoth/data/core/macros/ai_candidate_actions.cfg`, `wesnoth/data/core/macros/ai.cfg`, `wesnoth/data/lua/wml/{modify_ai,micro_ai}.lua`, `wesnoth/data/lua/package.lua`.
- Current code to replace/extend: `packages/engine/src/ai/simpleAi.ts`, `packages/ui/src/gameSession.ts` (`endTurn`/`playAiSide` ~1434-1470, choreography ~1780-1793 and ~1930-1975, `SaveGameData` ~579), `packages/engine/src/events/filter.ts`, `packages/lua-bridge/src/{luaEnv,bridges/require,bridges/units,dataLua}.ts`.
