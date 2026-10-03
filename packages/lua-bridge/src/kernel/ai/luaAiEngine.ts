/**
 * The Lua AI engine (`src/ai/lua/engine_lua.cpp`, `core.cpp`): `engine=lua` candidate actions for the
 * engine's RCA loop, running `data/ai/**` Lua unchanged on the game's kernel.
 *
 * Per side there is one Lua AI context (`lua_ai_context`): a state table holding the side's `ai` table, the
 * engine's code (`[engine name=lua] code=`, else `ai/lua/dummy_engine_lua.lua`), its `params` (`[args]`),
 * persistent `data` (`[data]`) and the `self` the code returned. A candidate action is a pair of compiled
 * chunks, called as `(self, params, data, filter_own)` with the global `ai` set to the side's table
 * (`lua_ai_load`): read-only while evaluating, with the mutating functions while executing. A Lua error is
 * logged and scores 0, as upstream's `luaW_pcall` does.
 *
 * Lua runs inline (`LuaRuntime.inline`): events it fires run to completion with the AI turn's responder.
 */
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import type { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import type { Responder } from '@wesnothweb2/engine/src/events/interaction.js';
import { findLocations, unitMatchesFilter } from '@wesnothweb2/engine/src/events/filter.js';
import { reachableHexes } from '@wesnothweb2/engine/src/pathfind/pathfind.js';
import { CandidateAction, BAD_SCORE } from '@wesnothweb2/engine/src/ai/composite/rca.js';
import type { AiEngine } from '@wesnothweb2/engine/src/ai/composite/aiComposite.js';
import type { AiContext } from '@wesnothweb2/engine/src/ai/context.js';
import type { Stage } from '@wesnothweb2/engine/src/ai/composite/stage.js';
import type { MoveMap } from '@wesnothweb2/engine/src/ai/moveMaps.js';
import type { AttackAnalysis } from '@wesnothweb2/engine/src/ai/default/attackAnalysis.js';
import { findTargets } from '@wesnothweb2/engine/src/ai/default/findTargets.js';
import { lua, lauxlib, to_luastring, argError, checkString, pushString, pushStringArray, typeError, type LuaKernel, type LuaState, type LuaCFunction } from '../kernel.js';
import type { LuaUnits } from '../game/units.js';
import type { LuaRuntime } from '../../runtime.js';
import { attackAction, errorName, moveAction, recallAction, recruitAction, stopunitAction, type ActionResult } from './aiActions.js';

const DUMMY_ENGINE_CODE = 'wesnoth.require("ai/lua/dummy_engine_lua.lua")';

/** Aspect value types (`src/ai/registry.cpp`'s composite aspect factories). */
const ASPECT_KINDS: Record<string, 'double' | 'bool' | 'int' | 'string' | 'config' | 'variant' | 'strings' | 'filter' | 'attacks' | 'advancements'> = {
  advancements: 'advancements',
  aggression: 'double',
  allow_ally_villages: 'bool',
  attacks: 'attacks',
  avoid: 'filter',
  caution: 'double',
  grouping: 'string',
  leader_aggression: 'double',
  leader_goal: 'config',
  leader_ignores_keep: 'variant',
  leader_value: 'double',
  passive_leader: 'variant',
  passive_leader_shares_keep: 'variant',
  recruitment_diversity: 'double',
  recruitment_instructions: 'config',
  recruitment_more: 'strings',
  recruitment_pattern: 'strings',
  recruitment_randomness: 'int',
  recruitment_save_gold: 'config',
  retreat_enemy_weight: 'double',
  retreat_factor: 'double',
  scout_village_targeting: 'double',
  simple_targeting: 'bool',
  support_villages: 'bool',
  village_value: 'double',
  villages_per_scout: 'int',
};

/** `std::hash<map_location>`: Lua's move maps are keyed by it. */
function locationHash(loc: Location): number {
  return loc.wmlX * 16384 + loc.wmlY + 2000;
}

/** What the Lua engine needs from the game's AI manager. */
export interface AiComponentHost {
  modifyAi(side: number, action: 'add' | 'change' | 'delete', path: string, cfg?: WmlConfig): boolean;
  appendSideAi(side: number, cfg: WmlConfig): void;
}

interface SideContext {
  readonly ctx: AiContext;
  readonly code: string;
  /** Registry reference of the state table (`ai`, `params`, `data`, `self`, `update_self`). */
  readonly stateRef: number;
  /** The gamestate as of each move map's last fetch from Lua (`set_*_valid_lua`), or undefined. */
  readonly validAt: Map<string, number>;
}

export class LuaAiEngine implements AiEngine {
  private readonly contexts = new WeakMap<AiContext, SideContext>();
  private readonly k: LuaKernel;
  private readonly units: LuaUnits;
  private loadDepth = 0;

  constructor(
    private readonly runtime: LuaRuntime,
    /** The responder events fired during the AI's turn answer with (the session's collecting responder). */
    private readonly respond: () => Responder,
  ) {
    this.k = runtime.kernel;
    this.units = runtime.units;
    // The `[micro_ai]` tag is Lua (`lua/wml/micro_ai.lua`, which upstream loads with the other WML tags).
    try {
      this.k.run('wesnoth.require("lua/wml/micro_ai.lua")', '=micro_ai');
    } catch (e) {
      this.k.log('error', `[micro_ai] tag: ${(e as Error).message}`);
    }
  }

  /**
   * Attaches the game's AI manager: `wesnoth.sides.add_ai_component`/`delete_ai_component`/
   * `change_ai_component` (`intf_modify_ai`) change a side's AI through it.
   */
  attach(manager: AiComponentHost): void {
    const k = this.k;
    const sideOf = (T: LuaState, idx: number): number => k.userdata<number>(T, idx, 'side') ?? Number(lauxlib.luaL_checkinteger(T, idx));
    const modify = (action: 'add' | 'change' | 'delete'): LuaCFunction => (T) => {
      const side = sideOf(T, 1);
      const path = checkString(T, 2);
      const cfg = action === 'delete' ? undefined : k.checkConfig(T, 3);
      manager.modifyAi(side, action, path, cfg);
      return 0;
    };
    k.defineAll(['wesnoth', 'sides'], {
      add_ai_component: modify('add'),
      delete_ai_component: modify('delete'),
      change_ai_component: modify('change'),
      // `intf_append_ai`: the table, or its `[ai]` child when it has one.
      append_ai: (T) => {
        const side = sideOf(T, 1);
        const cfg = k.checkConfig(T, 2);
        manager.appendSideAi(side, cfg.child('ai') ?? cfg);
        return 0;
      },
    });
  }

  /** `engine_lua::apply_micro_ai`: `wesnoth.wml_actions.micro_ai(cfg)`. */
  applyMicroAi(_ctx: AiContext, _sideConfigs: readonly WmlConfig[], cfg: WmlConfig): void {
    const L = this.k.L;
    this.runtime.inline(this.respond(), () => {
      const top = lua.lua_gettop(L);
      lua.lua_getglobal(L, to_luastring('wesnoth'));
      lua.lua_getfield(L, -1, to_luastring('wml_actions'));
      lua.lua_getfield(L, -1, to_luastring('micro_ai'));
      this.k.pushConfig(L, cfg);
      try {
        this.k.pcall(1, 0);
      } catch (e) {
        this.k.log('error', `[micro_ai]: ${(e as Error).message}`);
      }
      lua.lua_settop(L, top);
    });
  }

  /** `engine_lua::to_config`: `[engine name=lua]` with its code and persistent data. */
  engineConfig(ctx: AiContext): WmlConfig | undefined {
    const side = this.contexts.get(ctx);
    if (!side) return undefined;
    const L = this.k.L;
    const cfg = new WmlConfig();
    cfg.setAttribute('name', 'lua');
    cfg.setAttribute('code', side.code);
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, side.stateRef);
    lua.lua_getfield(L, -1, to_luastring('data'));
    const data = this.k.toConfig(L, -1);
    lua.lua_pop(L, 2);
    cfg.addChild('data', data ?? new WmlConfig());
    return cfg;
  }

  /** `engine_lua::do_parse_candidate_action_from_config`. */
  candidateAction(ctx: AiContext, cfg: WmlConfig, sideConfigs: readonly WmlConfig[]): CandidateAction | undefined {
    const side = this.contextFor(ctx, sideConfigs);
    if (!side) return undefined;
    let evalCode: string;
    let execCode: string;
    if (cfg.hasAttribute('location')) {
      const load = `wesnoth.require("${cfg.getString('location')}")`;
      const preamble = 'local self, params, data, filter_own = ...\n';
      evalCode = `${preamble}return ${load}.evaluation(self, params, data, filter_own)`;
      execCode = `${preamble}${load}.execution(self, params, data, filter_own)`;
    } else {
      evalCode = cfg.getString('evaluation', '');
      execCode = cfg.getString('execution', '');
    }
    const evalRef = this.compile(evalCode);
    const execRef = this.compile(execCode);
    return new LuaCandidateAction(ctx, cfg, this, side, evalRef, execRef);
  }

  /** `engine_lua::do_parse_stage_from_config`: a `lua_stage_wrapper` running the stage's `code`. */
  stage(ctx: AiContext, cfg: WmlConfig, sideConfigs: readonly WmlConfig[]): Stage | undefined {
    const side = this.contextFor(ctx, sideConfigs);
    if (!side) return undefined;
    return new LuaStage(ctx, cfg, this, side, this.compile(cfg.getString('code', '')));
  }

  /** `lua_ai_action_handler::create`: a compiled chunk kept in the registry, or undefined on a syntax error. */
  private compile(code: string): number | undefined {
    const L = this.k.L;
    if (lauxlib.luaL_loadbufferx(L, to_luastring(code), null, to_luastring(code), to_luastring('t')) !== lua.LUA_OK) {
      this.k.log('error', `error while creating ai function: ${lua.lua_tojsstring(L, -1)}`);
      lua.lua_pop(L, 1);
      return undefined;
    }
    return lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
  }

  /** `engine_lua`'s constructor and `lua_ai_context::create`/`update_state`, once per side AI. */
  private contextFor(ctx: AiContext, sideConfigs: readonly WmlConfig[]): SideContext | undefined {
    const existing = this.contexts.get(ctx);
    if (existing) return existing;
    const L = this.k.L;
    let engineCfg: WmlConfig | undefined;
    for (const c of sideConfigs) for (const e of c.children('engine')) if (e.getString('name', '') === 'lua') engineCfg ??= e;
    const code = engineCfg?.hasAttribute('code') ? engineCfg.getString('code') : DUMMY_ENGINE_CODE;
    if (lauxlib.luaL_loadbufferx(L, to_luastring(code), null, to_luastring(code), to_luastring('t')) !== lua.LUA_OK) {
      this.k.log('error', `error while initializing ai: ${lua.lua_tojsstring(L, -1)}`);
      lua.lua_pop(L, 1);
      return undefined;
    }
    lua.lua_createtable(L, 0, 6);
    this.pushAiTable(L, ctx);
    lua.lua_setfield(L, -2, to_luastring('ai'));
    lua.lua_pushvalue(L, -2);
    lua.lua_setfield(L, -2, to_luastring('update_self'));
    this.k.pushConfig(L, engineCfg?.child('data') ?? new WmlConfig());
    lua.lua_setfield(L, -2, to_luastring('data'));
    this.k.pushConfig(L, engineCfg?.child('args') ?? new WmlConfig());
    lua.lua_setfield(L, -2, to_luastring('params'));
    const stateRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
    lua.lua_pop(L, 1);
    const side: SideContext = { ctx, code, stateRef, validAt: new Map() };
    this.contexts.set(ctx, side);
    // update_state: self = update_self(params, data), with the ai table loaded read-only.
    this.withAi(side, true, () => {
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, stateRef);
      const state = lua.lua_gettop(L);
      lua.lua_getfield(L, state, to_luastring('update_self'));
      lua.lua_getfield(L, state, to_luastring('params'));
      lua.lua_getfield(L, state, to_luastring('data'));
      try {
        this.k.pcall(2, 1);
        lua.lua_setfield(L, state, to_luastring('self'));
      } catch (e) {
        this.k.log('error', `Lua AI engine: ${(e as Error).message}`);
      }
      lua.lua_settop(L, state - 1);
    });
    return side;
  }

  /** `lua_ai_action_handler::handle`: the chunk called with (self, params, data[, filter_own]); a number result if asked. */
  handle(side: SideContext, ref: number, args: WmlConfig, filterOwn: WmlConfig | undefined, readOnly: boolean, wantResult: boolean): number {
    const L = this.k.L;
    return this.runtime.inline(this.respond(), () =>
      this.withAi(side, readOnly, () => {
        const top = lua.lua_gettop(L);
        lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, side.stateRef);
        const state = lua.lua_gettop(L);
        lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
        lua.lua_getfield(L, state, to_luastring('self'));
        this.k.pushConfig(L, args);
        lua.lua_getfield(L, state, to_luastring('data'));
        let n = 3;
        if (filterOwn && (filterOwn.attributeNames().length > 0 || filterOwn.allChildren().length > 0)) {
          this.k.pushConfig(L, filterOwn);
          n = 4;
        }
        let result = 0;
        try {
          this.k.pcall(n, wantResult ? 1 : 0);
          if (wantResult) result = lua.lua_tonumber(L, -1) || 0;
        } catch (e) {
          this.k.log('error', `Lua AI: ${(e as Error).message}`);
        }
        lua.lua_settop(L, top);
        return result;
      }),
    );
  }

  /** `lua_ai_load`: the side's `ai` table as the global `ai` (nested loads keep and restore `read_only`). */
  private withAi<T>(side: SideContext, readOnly: boolean, fn: () => T): T {
    const L = this.k.L;
    lua.lua_getglobal(L, to_luastring('ai'));
    const loaded = !lua.lua_isnil(L, -1);
    let wasReadOnly = false;
    if (loaded) {
      lua.lua_getfield(L, -1, to_luastring('read_only'));
      wasReadOnly = lua.lua_toboolean(L, -1);
      lua.lua_pop(L, 1);
      lua.lua_pushboolean(L, readOnly);
      lua.lua_setfield(L, -2, to_luastring('read_only'));
      lua.lua_pop(L, 1);
    } else {
      lua.lua_pop(L, 1);
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, side.stateRef);
      lua.lua_getfield(L, -1, to_luastring('ai'));
      lua.lua_pushboolean(L, readOnly);
      lua.lua_setfield(L, -2, to_luastring('read_only'));
      this.setGlobalAi(L);
      lua.lua_pop(L, 1);
    }
    this.loadDepth++;
    try {
      return fn();
    } finally {
      this.loadDepth--;
      if (this.loadDepth === 0) {
        lua.lua_pushnil(L);
        this.setGlobalAi(L);
      } else {
        lua.lua_getglobal(L, to_luastring('ai'));
        lua.lua_pushboolean(L, wasReadOnly);
        lua.lua_setfield(L, -2, to_luastring('read_only'));
        lua.lua_pop(L, 1);
      }
    }
  }

  /** Sets the global `ai` bypassing the strict-mode guard (upstream's `lua_setglobal` does not go through it either). */
  private setGlobalAi(L: LuaState): void {
    lua.lua_pushglobaltable(L);
    lua.lua_insert(L, -2);
    lua.lua_pushstring(L, to_luastring('ai'));
    lua.lua_insert(L, -2);
    lua.lua_rawset(L, -3);
    lua.lua_pop(L, 1);
  }

  // --- the ai table (generate_and_push_ai_table) ---

  private pushAiTable(L: LuaState, ctx: AiContext): void {
    const k = this.k;
    const loc = (T: LuaState, idx: number): Location => k.checkLocation(T, idx);
    const pushResult = (T: LuaState, r: ActionResult): number => {
      lua.lua_createtable(T, 0, 4);
      lua.lua_pushboolean(T, r.status === 0);
      lua.lua_setfield(T, -2, to_luastring('ok'));
      lua.lua_pushboolean(T, r.gamestateChanged);
      lua.lua_setfield(T, -2, to_luastring('gamestate_changed'));
      lua.lua_pushinteger(T, r.status);
      lua.lua_setfield(T, -2, to_luastring('status'));
      pushString(T, errorName(r.status));
      lua.lua_setfield(T, -2, to_luastring('result'));
      return 1;
    };
    const move = (exec: boolean, removeMovement: boolean): LuaCFunction => (T) => {
      const from = loc(T, 1);
      const to = loc(T, 2);
      const unreachIsOk = lua.lua_isboolean(T, 3) ? lua.lua_toboolean(T, 3) : false;
      return pushResult(T, moveAction(ctx, exec, from, to, removeMovement, unreachIsOk));
    };
    const attack = (exec: boolean): LuaCFunction => (T) => {
      const attacker = loc(T, 1);
      const defender = loc(T, 2);
      let weapon = -1;
      if (!lua.lua_isnoneornil(T, 3)) {
        weapon = Number(lua.lua_tointeger(T, 3));
        if (weapon !== -1) weapon--;
      }
      let aggression = ctx.getAggression();
      if (!lua.lua_isnoneornil(T, 4) && lua.lua_isnumber(T, 4)) aggression = lua.lua_tonumber(T, 4);
      return pushResult(T, attackAction(ctx, exec, attacker, defender, weapon, aggression));
    };
    const stopunit = (exec: boolean, moves: boolean, attacks: boolean): LuaCFunction => (T) => pushResult(T, stopunitAction(ctx, exec, loc(T, 1), moves, attacks));
    const recruit = (exec: boolean): LuaCFunction => (T) => {
      const type = checkString(T, 1);
      const where = k.toLocation(T, 2) ?? Location.NULL;
      return pushResult(T, recruitAction(ctx, exec, type, where));
    };
    const recall = (exec: boolean): LuaCFunction => (T) => {
      const id = checkString(T, 1);
      const where = k.toLocation(T, 2) ?? Location.NULL;
      return pushResult(T, recallAction(ctx, exec, id, where));
    };
    const mutating: Record<string, LuaCFunction> = {
      attack: attack(true),
      move: move(true, false),
      move_full: move(true, true),
      recall: recall(true),
      recruit: recruit(true),
      stopunit_all: stopunit(true, true, true),
      stopunit_attacks: stopunit(true, false, true),
      stopunit_moves: stopunit(true, true, false),
      fallback_human: (T) => lauxlib.luaL_error(T, to_luastring('ai.fallback_human is not available in this port')),
    };

    const side = () => this.contexts.get(ctx);
    const moveMapFn = (name: string, get: () => MoveMap): LuaCFunction => (T) => {
      const map = get();
      side()?.validAt.set(name, ctx.gamestateSnapshot());
      this.pushMoveMap(T, map);
      return 1;
    };
    const validFn = (name: string): LuaCFunction => (T) => {
      const at = side()?.validAt.get(name);
      lua.lua_pushboolean(T, at !== undefined && at === ctx.gamestateSnapshot());
      return 1;
    };
    const number = (get: () => number): LuaCFunction => (T) => {
      lua.lua_pushnumber(T, get());
      return 1;
    };

    const callbacks: Record<string, LuaCFunction> = {
      get_new_dst_src: moveMapFn('dst_src', () => ctx.getDstSrc()),
      get_new_src_dst: moveMapFn('src_dst', () => ctx.getSrcDst()),
      get_new_enemy_dst_src: moveMapFn('enemy_dst_src', () => ctx.getEnemyDstSrc()),
      get_new_enemy_src_dst: moveMapFn('enemy_src_dst', () => ctx.getEnemySrcDst()),
      recalculate_move_maps: () => {
        ctx.recalculateMoveMaps();
        return 0;
      },
      recalculate_enemy_move_maps: () => {
        ctx.recalculateEnemyMoveMaps();
        return 0;
      },
      is_dst_src_valid: validFn('dst_src'),
      is_enemy_dst_src_valid: validFn('enemy_dst_src'),
      is_src_dst_valid: validFn('src_dst'),
      is_enemy_src_dst_valid: validFn('enemy_src_dst'),
      get_targets: (T) => {
        const targets = findTargets(ctx, ctx.getEnemyDstSrc());
        lua.lua_createtable(T, targets.length, 0);
        targets.forEach((t, i) => {
          lua.lua_createtable(T, 0, 3);
          pushString(T, t.type);
          lua.lua_setfield(T, -2, to_luastring('type'));
          k.pushLocation(T, t.loc);
          lua.lua_setfield(T, -2, to_luastring('loc'));
          lua.lua_pushnumber(T, t.value);
          lua.lua_setfield(T, -2, to_luastring('value'));
          lua.lua_rawseti(T, -2, i + 1);
        });
        return 1;
      },
      get_attacks: (T) => {
        const attacks = ctx.getAttacks();
        lua.lua_createtable(T, attacks.length, 0);
        attacks.forEach((a, i) => {
          this.pushAttackAnalysis(T, ctx, a);
          lua.lua_rawseti(T, -2, i + 1);
        });
        return 1;
      },
      get_aggression: number(() => ctx.getAggression()),
      get_avoid: (T) => {
        k.pushLocationSet(T, sortLocations(findLocations(ctx.board, ctx.getAvoidConfig())));
        return 1;
      },
      get_caution: number(() => ctx.getCaution()),
      get_grouping: (T) => {
        pushString(T, ctx.getGrouping());
        return 1;
      },
      get_leader_aggression: number(() => ctx.getLeaderAggression()),
      get_leader_goal: (T) => {
        k.pushConfig(T, ctx.getLeaderGoalConfig());
        return 1;
      },
      get_leader_ignores_keep: (T) => this.pushAspect(T, ctx, 'leader_ignores_keep'),
      get_leader_value: number(() => ctx.getLeaderValue()),
      get_passive_leader: (T) => this.pushAspect(T, ctx, 'passive_leader'),
      get_passive_leader_shares_keep: (T) => this.pushAspect(T, ctx, 'passive_leader_shares_keep'),
      get_recruitment_pattern: (T) => this.pushAspect(T, ctx, 'recruitment_pattern'),
      get_scout_village_targeting: number(() => ctx.getScoutVillageTargeting()),
      get_simple_targeting: (T) => {
        lua.lua_pushboolean(T, ctx.getSimpleTargeting());
        return 1;
      },
      get_support_villages: (T) => {
        lua.lua_pushboolean(T, ctx.getSupportVillages());
        return 1;
      },
      get_village_value: number(() => ctx.getVillageValue()),
      get_villages_per_scout: number(() => ctx.getVillagesPerScout()),
      suitable_keep: (T) => {
        const leader = this.units.toUnit(T, 1);
        if (!leader) return lua.lua_isuserdata(T, 1) ? argError(T, 1, 'unknown unit') : typeError(T, 1, 'unit');
        const paths = reachableHexes(ctx.board, leader, { viewingTeam: ctx.team() });
        const keep = ctx.suitableKeep(leader.location, paths.destinations);
        if (!keep || !keep.valid()) return 0;
        lua.lua_pushinteger(T, keep.wmlX);
        lua.lua_pushinteger(T, keep.wmlY);
        return 2;
      },
      check_recall: recall(false),
      check_move: move(false, false),
      check_stopunit: stopunit(false, true, true),
      check_attack: attack(false),
      check_recruit: recruit(false),
    };

    lua.lua_createtable(L, 0, Object.keys(callbacks).length);
    for (const [name, fn] of Object.entries(callbacks)) {
      lua.lua_pushcfunction(L, fn);
      lua.lua_setfield(L, -2, to_luastring(name));
    }
    lua.lua_createtable(L, 0, 2);
    lua.lua_pushcfunction(L, (T: LuaState) => {
      if (!lua.lua_isstring(T, 2)) return 0;
      const m = lua.lua_tojsstring(T, 2);
      if (m === 'side') {
        lua.lua_pushinteger(T, ctx.side);
        return 1;
      }
      if (m === 'aspects') {
        this.pushAspectsTable(T, ctx);
        return 1;
      }
      lua.lua_pushstring(T, to_luastring('read_only'));
      lua.lua_rawget(T, 1);
      const readOnly = lua.lua_toboolean(T, -1);
      lua.lua_pop(T, 1);
      if (readOnly) return 0;
      const fn = mutating[m];
      if (!fn) return 0;
      lua.lua_pushcfunction(T, fn);
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring('__index'));
    lua.lua_pushcfunction(L, (T: LuaState) => {
      const names = [...Object.keys(callbacks), 'side', 'aspects'];
      lua.lua_pushstring(T, to_luastring('read_only'));
      lua.lua_rawget(T, 1);
      if (!lua.lua_toboolean(T, -1)) names.push(...Object.keys(mutating));
      pushStringArray(T, names);
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring('__dir'));
    lua.lua_setmetatable(L, -2);
  }

  private pushAspectsTable(T: LuaState, ctx: AiContext): void {
    lua.lua_createtable(T, 0, 0);
    lua.lua_createtable(T, 0, 3);
    lua.lua_pushcfunction(T, (U: LuaState) => {
      const id = checkString(U, 2);
      if (!ctx.aspectIds().includes(id)) return 0;
      return this.pushAspect(U, ctx, id);
    });
    lua.lua_setfield(T, -2, to_luastring('__index'));
    lua.lua_pushcfunction(T, (U: LuaState) => lauxlib.luaL_error(U, to_luastring('attempted to write to the ai.aspects table, which is read-only')));
    lua.lua_setfield(T, -2, to_luastring('__newindex'));
    lua.lua_pushcfunction(T, (U: LuaState) => {
      pushStringArray(U, ctx.aspectIds());
      return 1;
    });
    lua.lua_setfield(T, -2, to_luastring('__dir'));
    lua.lua_setmetatable(T, -2);
  }

  /** `impl_ai_aspect_get` / `typesafe_aspect::get_lua`. */
  private pushAspect(T: LuaState, ctx: AiContext, id: string): number {
    const k = this.k;
    const facet = ctx.aspect(id) ?? new WmlConfig();
    switch (ASPECT_KINDS[id]) {
      case 'double':
      case 'int':
        lua.lua_pushnumber(T, facet.getNumber('value', 0));
        return 1;
      case 'bool':
        lua.lua_pushboolean(T, facet.getBoolean('value', false));
        return 1;
      case 'string':
        pushString(T, facet.getString('value', ''));
        return 1;
      case 'config':
        k.pushConfig(T, facet.child('value') ?? facet);
        return 1;
      case 'strings':
        pushStringArray(T, facet.getString('value', '').split(',').map((s) => s.trim()).filter((s) => s !== ''));
        return 1;
      case 'variant': {
        const raw = facet.getString('value', 'no').trim();
        if (raw === '' || raw === 'no' || raw === 'false') lua.lua_pushboolean(T, false);
        else if (raw === 'yes' || raw === 'true') lua.lua_pushboolean(T, true);
        else pushStringArray(T, raw.split(',').map((s) => s.trim()).filter((s) => s !== ''));
        return 1;
      }
      case 'filter':
        k.pushLocationSet(T, sortLocations(findLocations(ctx.board, ctx.getAvoidConfig())));
        return 1;
      case 'attacks': {
        const cfg = ctx.getAttacksAspectConfig();
        const filterOwn = cfg.child('filter_own');
        const filterEnemy = cfg.child('filter_enemy');
        const own: Unit[] = [];
        const enemy: Unit[] = [];
        const team = ctx.team();
        for (const u of ctx.board.allUnits()) {
          if (u.side === ctx.side) {
            if (!filterOwn || unitMatchesFilter(u, filterOwn, ctx.board)) own.push(u);
          } else {
            const t = ctx.board.getTeam(u.side);
            if (t && team.isEnemy(t) && (!filterEnemy || unitMatchesFilter(u, filterEnemy, ctx.board))) enemy.push(u);
          }
        }
        lua.lua_createtable(T, 0, 2);
        this.pushUnitList(T, own);
        lua.lua_setfield(T, -2, to_luastring('own'));
        this.pushUnitList(T, enemy);
        lua.lua_setfield(T, -2, to_luastring('enemy'));
        return 1;
      }
      case 'advancements': {
        // Per own unit (keyed by location hash): the advancement it would choose; "" -- any -- for all here.
        lua.lua_createtable(T, 0, 0);
        for (const u of ctx.board.unitsForSide(ctx.side)) {
          lua.lua_pushinteger(T, locationHash(u.location));
          pushStringArray(T, []);
          lua.lua_settable(T, -3);
        }
        return 1;
      }
      default:
        k.pushConfig(T, facet);
        return 1;
    }
  }

  private pushUnitList(T: LuaState, units: readonly Unit[]): void {
    lua.lua_createtable(T, units.length, 0);
    units.forEach((u, i) => {
      this.units.push(T, u);
      lua.lua_rawseti(T, -2, i + 1);
    });
  }

  /** `push_move_map`: location hash -> array of locations. */
  private pushMoveMap(T: LuaState, map: MoveMap): void {
    lua.lua_createtable(T, 0, map.size);
    const keys = [...map.keys()].map((key) => Location.fromKey(key)).sort((a, b) => a.compare(b));
    for (const key of keys) {
      lua.lua_pushinteger(T, locationHash(key));
      const locs = map.get(key.key()) ?? [];
      lua.lua_createtable(T, locs.length, 0);
      locs.forEach((l, i) => {
        this.k.pushLocation(T, l);
        lua.lua_rawseti(T, -2, i + 1);
      });
      lua.lua_settable(T, -3);
    }
  }

  /** `push_attack_analysis`, with `rating` bound to this analysis. */
  private pushAttackAnalysis(T: LuaState, ctx: AiContext, a: AttackAnalysis): void {
    const k = this.k;
    lua.lua_createtable(T, 0, 18);
    lua.lua_pushcfunction(T, (U: LuaState) => {
      lua.lua_pushnumber(U, a.rating(ctx.getAggression(), ctx));
      return 1;
    });
    lua.lua_setfield(T, -2, to_luastring('rating'));
    lua.lua_createtable(T, a.movements.length, 0);
    a.movements.forEach((m, i) => {
      lua.lua_createtable(T, 0, 2);
      k.pushLocation(T, m.from);
      lua.lua_setfield(T, -2, to_luastring('src'));
      k.pushLocation(T, m.to);
      lua.lua_setfield(T, -2, to_luastring('dst'));
      lua.lua_rawseti(T, -2, i + 1);
    });
    lua.lua_setfield(T, -2, to_luastring('movements'));
    k.pushLocation(T, a.target);
    lua.lua_setfield(T, -2, to_luastring('target'));
    const num = (key: string, v: number) => {
      lua.lua_pushnumber(T, v);
      lua.lua_setfield(T, -2, to_luastring(key));
    };
    const bool = (key: string, v: boolean) => {
      lua.lua_pushboolean(T, v);
      lua.lua_setfield(T, -2, to_luastring(key));
    };
    num('target_value', a.targetValue);
    num('avg_losses', a.avgLosses);
    num('chance_to_kill', a.chanceToKill);
    num('avg_damage_inflicted', a.avgDamageInflicted);
    lua.lua_pushinteger(T, Math.trunc(a.targetStartingDamage));
    lua.lua_setfield(T, -2, to_luastring('target_starting_damage'));
    num('avg_damage_taken', a.avgDamageTaken);
    num('resources_used', a.resourcesUsed);
    num('terrain_quality', a.terrainQuality);
    num('alternative_terrain_quality', a.alternativeTerrainQuality);
    num('vulnerability', a.vulnerability);
    num('support', a.support);
    bool('leader_threat', a.leaderThreat);
    bool('uses_leader', a.usesLeader);
    bool('is_surrounded', a.isSurrounded);
  }
}

function sortLocations(locs: readonly Location[]): Location[] {
  return [...locs].sort((a, b) => a.compare(b));
}

/**
 * `lua_candidate_action_wrapper(_external)` and the sticky variant: evaluation read-only with a number
 * result, execution with the mutating functions. A sticky action is bound to the unit at `unit_x,unit_y`
 * and removed once that unit is gone, disabled after it runs.
 */
export class LuaCandidateAction extends CandidateAction {
  private readonly args: WmlConfig;
  private readonly filterOwnCfg: WmlConfig | undefined;
  private readonly boundUnit: number | undefined;

  constructor(
    ctx: AiContext,
    readonly cfg: WmlConfig,
    private readonly luaEngine: LuaAiEngine,
    private readonly side: SideContext,
    private readonly evalRef: number | undefined,
    private readonly execRef: number | undefined,
  ) {
    super(ctx, cfg);
    this.args = cfg.child('args') ?? new WmlConfig();
    this.filterOwnCfg = cfg.child('filter_own');
    if (cfg.getBoolean('sticky', false)) {
      const unit = ctx.board.unitAt(Location.fromWml(cfg.getNumber('unit_x', 0), cfg.getNumber('unit_y', 0)));
      this.boundUnit = unit?.underlyingId;
    }
  }

  evaluate(): number {
    if (this.boundUnit !== undefined && !this.ctx.board.allUnits().some((u) => u.underlyingId === this.boundUnit)) {
      this.toBeRemoved = true;
      return 0;
    }
    if (this.evalRef === undefined) return BAD_SCORE;
    return this.luaEngine.handle(this.side, this.evalRef, this.args, this.filterOwnCfg, true, true);
  }

  execute(): void {
    if (this.execRef !== undefined) this.luaEngine.handle(this.side, this.execRef, this.args, this.filterOwnCfg, false, false);
    if (this.boundUnit !== undefined) this.disable();
  }
}

/** `lua_stage_wrapper`: the stage's code run once per turn with the mutating functions, `[args]` as its params. */
export class LuaStage implements Stage {
  readonly id: string;
  readonly name: string;
  private readonly args: WmlConfig;

  constructor(
    private readonly ctx: AiContext,
    cfg: WmlConfig,
    private readonly luaEngine: LuaAiEngine,
    private readonly side: SideContext,
    private readonly ref: number | undefined,
  ) {
    this.id = cfg.getString('id', '');
    this.name = cfg.getString('name', '');
    this.args = cfg.child('args') ?? new WmlConfig();
  }

  playStage(): boolean {
    const before = this.ctx.gamestateSnapshot();
    if (this.ref !== undefined) this.luaEngine.handle(this.side, this.ref, this.args, undefined, false, false);
    return this.ctx.gamestateSnapshot() !== before;
  }
}
