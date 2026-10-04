/**
 * Units in Lua: the `"unit"` userdata (`lua_unit.cpp`), its `status`/`variables` proxies, its weapons
 * (`lua_unit_attacks.cpp`), and `wesnoth.units` (`game_lua_kernel.cpp`).
 *
 * A Lua unit refers to a unit the way upstream's `lua_unit` does: an on-map unit by underlying id (so it
 * becomes invalid when that unit leaves the map), a recall-list unit by side and underlying id, or a private
 * unit Lua owns (`units.create`, `clone`, `extract`). Pushing the same unit twice gives two userdata that
 * compare equal (`__eq` by underlying id).
 *
 * Reading an unknown key falls back to `wesnoth.units` (so `u:matches{}` works) and is otherwise an error,
 * as upstream's `luaW_Registry`.
 */
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { TString } from '@wesnothweb2/engine/src/i18n/tstring.js';
import { Location, getAdjacentTiles, parseDirection, writeDirection } from '@wesnothweb2/engine/src/model/Location.js';
import type { AnimatorEntry } from '@wesnothweb2/engine/src/events/interaction.js';
import { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import type { AttackType, Alignment } from '@wesnothweb2/engine/src/model/UnitType.js';
import { findUnits, unitMatchesFilter } from '@wesnothweb2/engine/src/events/filter.js';
import { effectEnvFor } from '@wesnothweb2/engine/src/events/actionWml.js';
import { getActiveAbilities, computeResistanceModifier } from '@wesnothweb2/engine/src/actions/abilityEffects.js';
import { parseTerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import { specialTag } from '@wesnothweb2/engine/src/model/UnitType.js';
import {
  argError,
  checkString,
  lauxlib,
  lua,
  luaError,
  pushString,
  pushStringArray,
  to_luastring,
  toBoolean,
  typeError,
  type LuaCFunction,
  type LuaKernel,
  type LuaState,
} from '../kernel.js';
import type { GameKernelHost } from './host.js';

export const UNIT_KEY = 'unit';
const WESNOTH = to_luastring('wesnoth');
const UNITS = to_luastring('units');
const STATUS_KEY = 'unit status';
const VARIABLES_KEY = 'unit variables';
const ATTACKS_KEY = 'unit attacks table';
const ATTACK_KEY = 'unit attack';

/** `lua_unit`: what a unit userdata refers to. */
export class LuaUnitRef {
  constructor(
    private readonly host: GameKernelHost,
    /** For a private unit, the unit itself; otherwise the unit as last seen (its underlying id is the key). */
    public unit: Unit,
    /** 0 on the map, a side on that side's recall list, -1 private. */
    public side: number,
  ) {}

  get onMap(): boolean {
    return this.side === 0;
  }

  get onRecall(): number {
    return this.side > 0 ? this.side : 0;
  }

  get isPrivate(): boolean {
    return this.side < 0;
  }

  /** `lua_unit::get`: the unit, or undefined once it has left the map or recall list. */
  get(): Unit | undefined {
    if (this.side < 0) return this.unit;
    const board = this.host.ctx().board;
    const uid = this.unit.underlyingId;
    if (this.side > 0) return board.recallList(this.side).find((u) => u.underlyingId === uid);
    if (board.unitAt(this.unit.location) === this.unit) return this.unit;
    const found = board.allUnits().find((u) => u.underlyingId === uid);
    if (found) this.unit = found;
    return found;
  }
}

/** A weapon handed to Lua: read-only (this port's `AttackType` is immutable). */
interface AttackRef {
  readonly attack: AttackType;
}

export class LuaUnits {
  /** Registry reference of the `wesnoth.units` table, where the unit metatable finds methods. */
  private unitsTableRef: number | undefined;

  constructor(
    private readonly k: LuaKernel,
    private readonly host: GameKernelHost,
  ) {}

  /** `luaW_pushunit` for a unit on the map or a recall list (whichever it is on), else as private. */
  push(T: LuaState, unit: Unit): void {
    const board = this.host.ctx().board;
    let side = -1;
    if (board.unitAt(unit.location) === unit) side = 0;
    else {
      const team = board.teams().find((t) => board.recallList(t.side).includes(unit));
      if (team) side = team.side;
    }
    this.k.pushUserdata(T, UNIT_KEY, new LuaUnitRef(this.host, unit, side));
  }

  pushPrivate(T: LuaState, unit: Unit): void {
    this.k.pushUserdata(T, UNIT_KEY, new LuaUnitRef(this.host, unit, -1));
  }

  ref(T: LuaState, idx: number): LuaUnitRef | undefined {
    return this.k.userdata<LuaUnitRef>(T, idx, UNIT_KEY);
  }

  /** `luaW_checkunit`: a valid unit, or a Lua error. */
  check(T: LuaState, idx: number): Unit {
    const ref = this.ref(T, idx);
    if (!ref) return typeError(T, idx, 'unit');
    const unit = ref.get();
    if (!unit) return argError(T, idx, 'unit not found');
    return unit;
  }

  checkRef(T: LuaState, idx: number): LuaUnitRef {
    const ref = this.ref(T, idx);
    if (!ref) return typeError(T, idx, 'unit');
    return ref;
  }

  /** The unit at `idx` if it is a unit userdata, undefined otherwise (`luaW_tounit`). */
  toUnit(T: LuaState, idx: number): Unit | undefined {
    return this.ref(T, idx)?.get();
  }

  pushWeapon(T: LuaState, attack: AttackType | undefined): void {
    if (attack) this.k.pushUserdata(T, ATTACK_KEY, { attack } satisfies AttackRef);
    else lua.lua_pushnil(T);
  }

  toWeapon(T: LuaState, idx: number): AttackType | undefined {
    return this.k.userdata<AttackRef>(T, idx, ATTACK_KEY)?.attack;
  }

  install(): void {
    this.installUnitMetatable();
    this.installProxies();
    this.installAttacks();
    this.installFunctions();
  }

  // --- the unit userdata ---

  private getter(unit: Unit, ref: LuaUnitRef, key: string, T: LuaState): boolean {
    const k = this.k;
    const push = (v: string | number | boolean | undefined): true => {
      if (v === undefined) lua.lua_pushnil(T);
      else k.pushScalar(T, v);
      return true;
    };
    switch (key) {
      case 'valid':
        return push(ref.onMap ? 'map' : ref.onRecall ? 'recall' : 'private');
      case 'x':
        return push(unit.location.wmlX);
      case 'y':
        return push(unit.location.wmlY);
      case 'loc':
        k.pushLocation(T, unit.location);
        return true;
      case 'goto':
        k.pushLocation(T, unit.goto ?? Location.NULL);
        return true;
      case 'side':
        return push(unit.side);
      case 'id':
        return push(unit.id);
      case 'type':
        return push(unit.type.id);
      case 'image_mods':
        return push(unit.imageMods);
      case 'usage':
        return push(unit.type.usage);
      case 'ellipse':
        return push(unit.ellipse);
      case 'halo':
        return push(unit.halo);
      case 'hitpoints':
        return push(unit.hitpoints);
      case 'max_hitpoints':
        return push(unit.maxHitpoints);
      case 'experience':
        return push(unit.experience);
      case 'max_experience':
        return push(unit.maxExperience);
      case 'recall_cost':
        return push(unit.recallCost);
      case 'moves':
        return push(unit.movesLeft);
      case 'max_moves':
        return push(unit.maxMoves);
      case 'max_attacks':
        return push(unit.maxAttacksPerTurn);
      case 'attacks_left':
        return push(unit.attacksLeft);
      case 'vision':
        return push(unit.visionRange);
      case 'jamming':
        return push(unit.jamming);
      case 'name': {
        const t = unit.translatableName;
        if (t) k.pushTString(T, t);
        else k.pushTString(T, TString.literal(unit.name));
        return true;
      }
      case 'canrecruit':
        return push(unit.canRecruit);
      case 'level':
        return push(unit.level);
      case 'cost':
        return push(unit.type.cost);
      case 'extra_recruit':
        pushStringArray(T, unit.extraRecruit);
        return true;
      case 'advances_to':
        pushStringArray(T, unit.advancesTo);
        return true;
      case 'alignment':
        return push(unit.alignment);
      case 'upkeep':
        return push(/^-?\d+$/.test(unit.upkeep) ? Number(unit.upkeep) : unit.upkeep);
      case 'advancements':
        pushConfigArray(k, T, unit.advancements);
        return true;
      case 'overlays':
        pushStringArray(T, unit.overlays);
        return true;
      case 'traits':
        pushStringArray(T, unit.modifications.filter((m) => m.kind === 'trait').map((m) => m.cfg.getString('id')));
        return true;
      case 'abilities':
        pushStringArray(T, unit.abilities.map((a) => a.config.getString('id')).filter((id) => id !== ''));
        return true;
      case 'status':
      case 'variables': {
        lua.lua_createtable(T, 1, 0);
        lua.lua_pushvalue(T, 1);
        lua.lua_rawseti(T, -2, 1);
        lauxlib.luaL_setmetatable(T, to_luastring(key === 'status' ? STATUS_KEY : VARIABLES_KEY));
        return true;
      }
      case 'attacks':
        lua.lua_createtable(T, 1, 0);
        lua.lua_pushvalue(T, 1);
        lua.lua_rawseti(T, -2, 0);
        lauxlib.luaL_setmetatable(T, to_luastring(ATTACKS_KEY));
        return true;
      case 'hidden':
        return push(unit.hidden);
      case 'resting':
        return push(unit.resting);
      case 'flying':
        return push(unit.isFlying());
      case 'fearless':
        return push(unit.fearless);
      case 'healthy':
        return push(unit.healthy);
      case 'zoc':
        return push(unit.emitZoc);
      case 'role':
        return push(unit.role);
      case 'race':
        return push(unit.type.raceId);
      case 'gender':
        return push(unit.gender);
      case 'variation':
        return push(unit.variation);
      case 'facing':
        return push(writeDirection(unit.facing));
      case 'portrait':
        return push(unit.portrait());
      case '__cfg': {
        const cfg = unit.toConfig();
        unit.location.writeToConfig(cfg);
        k.pushConfig(T, cfg);
        return true;
      }
      default:
        return false;
    }
  }

  private setter(unit: Unit, ref: LuaUnitRef, key: string, T: LuaState): boolean {
    const k = this.k;
    const int = (): number => Number(lauxlib.luaL_checkinteger(T, 3));
    const str = (): string => checkString(T, 3);
    const bool = (): boolean => toBoolean(T, 3);
    switch (key) {
      case 'x':
      case 'y':
      case 'loc': {
        let loc: Location;
        if (key === 'loc') loc = k.checkLocation(T, 3);
        else loc = key === 'x' ? Location.fromWml(int(), unit.location.wmlY) : Location.fromWml(unit.location.wmlX, int());
        this.moveUnit(T, ref, unit, loc);
        return true;
      }
      case 'goto': {
        const loc = k.checkLocation(T, 3);
        unit.goto = loc.valid() ? loc : undefined;
        return true;
      }
      case 'side':
        unit.side = int();
        return true;
      case 'id':
        if (ref.onMap) argError(T, 3, "can't modify id of on-map unit");
        unit.id = str();
        return true;
      case 'hitpoints':
        unit.hitpoints = int();
        return true;
      case 'max_hitpoints':
        unit.maxHitpoints = int();
        return true;
      case 'experience':
        unit.experience = int();
        return true;
      case 'max_experience':
        unit.maxExperience = int();
        return true;
      case 'recall_cost':
        unit.recallCost = int();
        return true;
      case 'moves':
        unit.movesLeft = int();
        return true;
      case 'max_moves':
        unit.maxMoves = int();
        return true;
      case 'max_attacks':
        unit.maxAttacksPerTurn = int();
        return true;
      case 'attacks_left':
        unit.attacksLeft = int();
        return true;
      case 'name': {
        const t = k.checkTString(T, 3);
        unit.name = t.str();
        return true;
      }
      case 'canrecruit':
        unit.canRecruit = bool();
        return true;
      case 'level':
        unit.level = int();
        return true;
      case 'extra_recruit':
        unit.extraRecruit = checkStringList(T, 3);
        return true;
      case 'advances_to':
        unit.advancesTo = checkStringList(T, 3);
        return true;
      case 'alignment': {
        const v = str();
        if (!['lawful', 'neutral', 'chaotic', 'liminal'].includes(v)) argError(T, 3, 'invalid unit alignment');
        unit.alignment = v as Alignment;
        return true;
      }
      case 'upkeep': {
        if (lua.lua_isnumber(T, 3)) unit.upkeep = String(int());
        else {
          const v = str();
          if (v === 'loyal' || v === 'free') unit.upkeep = 'loyal';
          else if (v === 'full') unit.upkeep = 'full';
          else argError(T, 2, `unknown upkeep value of unit: ${v}`);
        }
        return true;
      }
      case 'hidden':
        unit.hidden = bool();
        return true;
      case 'resting':
        unit.resting = bool();
        return true;
      case 'zoc':
        unit.emitZoc = bool();
        return true;
      case 'role':
        unit.role = str();
        return true;
      case 'facing':
        unit.facing = parseDirection(str());
        return true;
      case 'ellipse':
        unit.ellipse = str();
        return true;
      case 'halo':
        unit.halo = str();
        return true;
      default:
        return false;
    }
  }

  /** `handle_unit_move`: setting x/y/loc moves an on-map unit (the destination's occupant is not displaced). */
  private moveUnit(T: LuaState, ref: LuaUnitRef, unit: Unit, dst: Location): void {
    if (!ref.onMap) {
      unit.location = dst;
      return;
    }
    const board = this.host.ctx().board;
    if (unit.location.equals(dst)) return;
    if (!board.map.onBoard(dst)) argError(T, 2, `destination hex not on map (excluding border): ${dst.wmlX},${dst.wmlY}`);
    if (board.unitAt(dst)) return;
    board.moveUnit(unit.location, dst);
  }

  private installUnitMetatable(): void {
    const L = this.k.L;
    lauxlib.luaL_newmetatable(L, to_luastring(UNIT_KEY));
    setFuncs(L, {
      __index: (T) => {
        const ref = this.checkRef(T, 1);
        const key = checkString(T, 2);
        const unit = ref.get();
        if (unit && this.getter(unit, ref, key, T)) return 1;
        if (!unit && KNOWN_ATTRIBUTES.has(key)) {
          if (key === 'valid') {
            lua.lua_pushnil(T);
            return 1;
          }
          return argError(T, 1, 'unit not found');
        }
        // Methods (`u:movement_on(...)`, ...) are `wesnoth.units`' functions, looked up with the key already on
        // the stack, in the table as it was first used -- a Lua AI's path cost function runs this for every hex it explores.
        if (this.unitsTableRef === undefined) {
          lua.lua_getglobal(T, WESNOTH);
          lua.lua_getfield(T, -1, UNITS);
          this.unitsTableRef = lauxlib.luaL_ref(T, lua.LUA_REGISTRYINDEX);
          lua.lua_pop(T, 1);
        }
        lua.lua_rawgeti(T, lua.LUA_REGISTRYINDEX, this.unitsTableRef);
        lua.lua_pushvalue(T, 2);
        lua.lua_gettable(T, -2);
        if (!lua.lua_isnil(T, -1)) return 1;
        return argError(T, 2, `invalid property of unit: ${key}`);
      },
      __newindex: (T) => {
        const ref = this.checkRef(T, 1);
        const key = checkString(T, 2);
        const unit = ref.get();
        if (!unit) return argError(T, 1, 'unit not found');
        if (this.setter(unit, ref, key, T)) return 0;
        return argError(T, 2, `invalid modifiable property of unit: ${key}`);
      },
      __eq: (T) => {
        const a = this.check(T, 1);
        const b = this.check(T, 2);
        lua.lua_pushboolean(T, a.underlyingId === b.underlyingId);
        return 1;
      },
      __tostring: (T) => {
        const ref = this.checkRef(T, 1);
        const u = ref.get();
        let s = 'unit: <';
        if (!u) s += 'invalid';
        else s += `${u.id !== '' ? u.id : u.type.id} `;
        if (u) {
          if (ref.onRecall) s += `at (side ${ref.onRecall} recall list)`;
          else s += `${ref.onMap ? '' : 'private '}at (${u.location.wmlX},${u.location.wmlY})`;
        }
        pushString(T, `${s}>`);
        return 1;
      },
      __dir: (T) => {
        pushStringArray(T, [...KNOWN_ATTRIBUTES]);
        return 1;
      },
    });
    pushString(L, UNIT_KEY);
    lua.lua_setfield(L, -2, to_luastring('__metatable'));
    lua.lua_pop(L, 1);
  }

  private installProxies(): void {
    const L = this.k.L;
    const owner = (T: LuaState, what: string): Unit => {
      if (!lua.lua_istable(T, 1)) typeError(T, 1, what);
      lua.lua_rawgeti(T, 1, 1);
      const unit = this.toUnit(T, -1);
      lua.lua_pop(T, 1);
      if (!unit) argError(T, 1, 'unknown unit');
      return unit!;
    };
    lauxlib.luaL_newmetatable(L, to_luastring(STATUS_KEY));
    setFuncs(L, {
      __index: (T) => {
        const unit = owner(T, 'unit status');
        lua.lua_pushboolean(T, unit.hasStatus(checkString(T, 2)));
        return 1;
      },
      __newindex: (T) => {
        const unit = owner(T, 'unit status');
        unit.setStatus(checkString(T, 2), toBoolean(T, 3));
        return 0;
      },
    });
    pushString(L, STATUS_KEY);
    lua.lua_setfield(L, -2, to_luastring('__metatable'));
    lua.lua_pop(L, 1);

    lauxlib.luaL_newmetatable(L, to_luastring(VARIABLES_KEY));
    setFuncs(L, {
      __index: (T) => {
        const unit = owner(T, 'unit variables');
        const name = checkString(T, 2);
        const vars = unit.variables ?? new WmlConfig();
        if (name === '__cfg') {
          this.k.pushConfig(T, vars);
          return 1;
        }
        // variable_access_const over the unit's own variables: an attribute, or a child table as a config.
        if (vars.hasAttribute(name)) this.k.pushScalar(T, vars.getRaw(name));
        else {
          const child = vars.child(name);
          if (!child) return 0;
          this.k.pushConfig(T, child);
        }
        return 1;
      },
      __newindex: (T) => {
        const unit = owner(T, 'unit variables');
        const name = checkString(T, 2);
        if (!unit.variables) unit.variables = new WmlConfig();
        const vars = unit.variables;
        if (name === '__cfg') {
          unit.variables = this.k.checkConfig(T, 3);
          return 0;
        }
        if (lua.lua_isnoneornil(T, 3)) {
          if (vars.hasAttribute(name)) vars.setAttribute(name, '');
          vars.removeChildren(name);
          const copy = new WmlConfig();
          for (const key of vars.attributeNames()) if (key !== name) copy.setAttribute(key, vars.getRaw(key)!);
          for (const c of vars.allChildren()) copy.addChild(c.tag, c.config);
          unit.variables = copy;
          return 0;
        }
        const scalar = this.k.toScalar(T, 3);
        if (scalar !== undefined) vars.setAttribute(name, scalar);
        else {
          vars.removeChildren(name);
          vars.addChild(name, this.k.checkConfig(T, 3));
        }
        return 0;
      },
    });
    pushString(L, VARIABLES_KEY);
    lua.lua_setfield(L, -2, to_luastring('__metatable'));
    lua.lua_pop(L, 1);
  }

  private installAttacks(): void {
    const L = this.k.L;
    const attacksOf = (T: LuaState): readonly AttackType[] => {
      if (!lua.lua_istable(T, 1)) typeError(T, 1, 'unit attacks');
      lua.lua_rawgeti(T, 1, 0);
      const unit = this.toUnit(T, -1);
      const type = this.unitTypeOf?.(T, -1);
      lua.lua_pop(T, 1);
      if (unit) return unit.attacks;
      if (type) return type;
      return argError(T, 1, 'unit not found');
    };
    lauxlib.luaL_newmetatable(L, to_luastring(ATTACKS_KEY));
    setFuncs(L, {
      __index: (T) => {
        const attacks = attacksOf(T);
        const attack = lua.lua_isnumber(T, 2) ? attacks[Number(lua.lua_tointeger(T, 2)) - 1] : attacks.find((a) => a.id === checkString(T, 2));
        this.pushWeapon(T, attack);
        return 1;
      },
      __newindex: (T) => luaError(T, 'unit attacks cannot be modified in this port yet'),
      __len: (T) => {
        lua.lua_pushinteger(T, attacksOf(T).length);
        return 1;
      },
    });
    pushString(L, ATTACKS_KEY);
    lua.lua_setfield(L, -2, to_luastring('__metatable'));
    lua.lua_pop(L, 1);

    lauxlib.luaL_newmetatable(L, to_luastring(ATTACK_KEY));
    setFuncs(L, {
      __index: (T) => {
        const ref = this.k.userdata<AttackRef>(T, 1, ATTACK_KEY);
        if (!ref) return typeError(T, 1, 'unit attack');
        const a = ref.attack;
        const key = checkString(T, 2);
        const k = this.k;
        switch (key) {
          case 'read_only':
            lua.lua_pushboolean(T, true);
            return 1;
          case 'description':
            if (a.nameT) k.pushTString(T, a.nameT);
            else pushString(T, a.name);
            return 1;
          case 'name':
            pushString(T, a.id);
            return 1;
          case 'type':
            pushString(T, a.type);
            return 1;
          case 'icon':
            pushString(T, '');
            return 1;
          case 'range':
            pushString(T, a.range);
            return 1;
          case 'alignment':
            pushString(T, a.alignment ?? '');
            return 1;
          case 'damage':
            lua.lua_pushinteger(T, a.damage);
            return 1;
          case 'number':
            lua.lua_pushinteger(T, a.numAttacks);
            return 1;
          case 'attack_weight':
            lua.lua_pushnumber(T, a.attackWeight);
            return 1;
          case 'defense_weight':
            lua.lua_pushnumber(T, a.defenseWeight);
            return 1;
          case 'accuracy':
            lua.lua_pushinteger(T, a.accuracy);
            return 1;
          case 'movement_used':
            lua.lua_pushinteger(T, a.movementUsed);
            return 1;
          case 'attacks_used':
            lua.lua_pushinteger(T, a.attacksUsed);
            return 1;
          case 'parry':
            lua.lua_pushinteger(T, a.parry);
            return 1;
          case 'max_range':
            lua.lua_pushinteger(T, a.maxRange);
            return 1;
          case 'min_range':
            lua.lua_pushinteger(T, a.minRange);
            return 1;
          case 'specials':
            k.pushConfig(T, specialsConfig(a));
            return 1;
          default:
            if (lauxlib.luaL_getmetafield(T, 1, to_luastring(key)) !== lua.LUA_TNIL) return 1;
            return argError(T, 2, `unknown property of attack: ${key}`);
        }
      },
      __newindex: (T) => argError(T, 1, 'attack is read-only'),
      __eq: (T) => {
        lua.lua_pushboolean(T, this.toWeapon(T, 1) === this.toWeapon(T, 2));
        return 1;
      },
      __tostring: (T) => {
        pushString(T, `weapon: <${this.toWeapon(T, 1)?.id ?? ''}>`);
        return 1;
      },
      matches: (T) => {
        const attack = this.toWeapon(T, 1);
        if (!attack) return argError(T, 1, 'invalid attack');
        lua.lua_pushboolean(T, attack.matchesFilter(this.k.checkConfig(T, 2)));
        return 1;
      },
    });
    pushString(L, ATTACK_KEY);
    lua.lua_setfield(L, -2, to_luastring('__metatable'));
    lua.lua_pop(L, 1);
  }

  /** Set by the unit-types module: the unit type userdata at `idx`'s attacks, if it is one. */
  unitTypeOf?: (T: LuaState, idx: number) => readonly AttackType[] | undefined;

  // --- wesnoth.units ---

  private installFunctions(): void {
    const k = this.k;
    const ctx = () => this.host.ctx();
    const pushUnits = (T: LuaState, units: readonly Unit[]): number => {
      lua.lua_createtable(T, units.length, 0);
      units.forEach((u, i) => {
        this.push(T, u);
        lua.lua_rawseti(T, -2, i + 1);
      });
      return 1;
    };
    const terrainArg = (T: LuaState) => {
      const loc = k.toLocation(T, 2);
      if (loc) return ctx().board.map.getTerrain(loc);
      if (lua.lua_isstring(T, 2)) return parseTerrainCode(checkString(T, 2));
      return typeError(T, 2, 'location or terrain string');
    };
    k.defineAll(['wesnoth', 'units'], {
      get: (T) => {
        const board = ctx().board;
        if (lua.lua_isstring(T, 1) && !lua.lua_isnumber(T, 1)) {
          const id = checkString(T, 1);
          const unit = board.allUnits().find((u) => u.id === id);
          if (!unit) return 0;
          this.push(T, unit);
          return 1;
        }
        const loc = k.toLocation(T, 1);
        if (!loc) return argError(T, 1, 'expected string or location');
        const unit = board.unitAt(loc);
        if (!unit) return 0;
        this.push(T, unit);
        return 1;
      },
      find_on_map: (T) => pushUnits(T, findUnits(ctx().board, k.checkConfig(T, 1))),
      find_on_recall: (T) => {
        const board = ctx().board;
        const filter = k.checkConfig(T, 1);
        const empty = filter.attributeNames().length === 0 && filter.allChildren().length === 0;
        const units: Unit[] = [];
        for (const team of board.teams()) {
          for (const u of board.recallList(team.side)) if (empty || unitMatchesFilter(u, filter, board)) units.push(u);
        }
        lua.lua_createtable(T, units.length, 0);
        units.forEach((u, i) => {
          k.pushUserdata(T, UNIT_KEY, new LuaUnitRef(this.host, u, u.side));
          lua.lua_rawseti(T, -2, i + 1);
        });
        return 1;
      },
      matches: (T) => {
        const ref = this.checkRef(T, 1);
        const unit = ref.get();
        if (!unit) return argError(T, 1, 'unit not found');
        const filter = k.checkConfig(T, 2);
        if (filter.attributeNames().length === 0 && filter.allChildren().length === 0) {
          lua.lua_pushboolean(T, true);
          return 1;
        }
        const board = ctx().board;
        const at = this.toUnit(T, 3) ? undefined : k.toLocation(T, 3);
        if (at && !at.equals(unit.location) && ref.onMap) {
          // Matching as if the unit stood elsewhere: move it there for the filter, as `unit_filter::matches(u, loc)`.
          const from = unit.location;
          const occupant = board.unitAt(at);
          if (occupant) board.removeUnitAt(at);
          board.moveUnit(from, at);
          try {
            lua.lua_pushboolean(T, unitMatchesFilter(unit, filter, board));
          } finally {
            board.moveUnit(at, from);
            if (occupant) board.addUnit(occupant);
          }
          return 1;
        }
        if (at && !ref.onMap) {
          const from = unit.location;
          unit.location = at;
          try {
            lua.lua_pushboolean(T, unitMatchesFilter(unit, filter, board));
          } finally {
            unit.location = from;
          }
          return 1;
        }
        lua.lua_pushboolean(T, unitMatchesFilter(unit, filter, board));
        return 1;
      },
      to_map: (T) => this.putUnit(T),
      erase: (T) => {
        const board = ctx().board;
        let loc: Location | undefined;
        const ref = this.ref(T, 1);
        if (ref) {
          const unit = ref.get();
          if (!unit) return argError(T, 1, 'unit not found');
          if (ref.onMap) loc = unit.location;
          else if (ref.onRecall) {
            board.removeFromRecallList(ref.onRecall, unit.underlyingId);
            return 0;
          } else return argError(T, 1, "can't erase private units");
        } else {
          loc = k.toLocation(T, 1);
          if (!loc) return argError(T, 1, 'expected unit or location');
        }
        if (!board.map.onBoard(loc)) return argError(T, 1, 'invalid location');
        board.removeUnitAt(loc);
        return 0;
      },
      extract: (T) => {
        const ref = this.checkRef(T, 1);
        const unit = ref.get();
        if (!unit) return argError(T, 1, 'unit not found');
        const board = ctx().board;
        if (ref.onMap) {
          board.removeUnitAt(unit.location);
          ref.unit = unit;
          ref.side = -1;
        } else if (ref.onRecall) {
          board.removeFromRecallList(ref.onRecall, unit.underlyingId);
          ref.unit = cloneUnit(unit, ctx().resolveType);
          ref.side = -1;
        }
        return 0;
      },
      clone: (T) => {
        this.pushPrivate(T, cloneUnit(this.check(T, 1), ctx().resolveType));
        return 1;
      },
      create: (T) => {
        const cfg = k.checkConfig(T, 1);
        const unit = Unit.fromConfig(cfg, ctx().resolveType);
        if (!cfg.hasAttribute('x') || !cfg.hasAttribute('y')) unit.location = Location.NULL;
        this.pushPrivate(T, unit);
        return 1;
      },
      ability: (T) => {
        const unit = this.check(T, 1);
        const tag = checkString(T, 2);
        lua.lua_pushboolean(T, getActiveAbilities(ctx().board, unit, tag).length > 0);
        return 1;
      },
      defense_on: (T) => {
        const unit = this.check(T, 1);
        lua.lua_pushinteger(T, 100 - unit.defenseModifier(terrainArg(T)));
        return 1;
      },
      movement_on: (T) => {
        const unit = this.check(T, 1);
        lua.lua_pushinteger(T, unit.movementCost(terrainArg(T)));
        return 1;
      },
      vision_on: (T) => {
        const unit = this.check(T, 1);
        lua.lua_pushinteger(T, unit.moveType.visionCost(terrainArg(T)));
        return 1;
      },
      resistance_against: (T) => {
        const unit = this.check(T, 1);
        const damageType = checkString(T, 2);
        let attacker = false;
        let loc = unit.location;
        if (lua.lua_isboolean(T, 3)) {
          attacker = toBoolean(T, 3);
          if (!lua.lua_isnoneornil(T, 4)) loc = k.checkLocation(T, 4);
        } else if (!lua.lua_isnoneornil(T, 3)) loc = k.checkLocation(T, 3);
        lua.lua_pushinteger(T, 100 - computeResistanceModifier(ctx().board, unit, damageType, attacker, loc));
        return 1;
      },
      remove_modifications: (T) => {
        const unit = this.check(T, 1);
        const filter = k.checkConfig(T, 2);
        const kind = lua.lua_isstring(T, 3) ? checkString(T, 3) : 'object';
        const byAttr = Object.fromEntries(filter.attributeNames().map((key) => [key, filter.getString(key)]));
        unit.removeModifications(byAttr, [kind], effectEnvFor(ctx(), unit));
        return 0;
      },
    });
    this.installAnimator();
    for (const name of ['advance', 'transform', 'teleport', 'to_recall', 'jamming_on', 'add_modification', 'get_hovered', 'create_weapon']) {
      k.unported(['wesnoth', 'units', name]);
    }
  }

  /**
   * `intf_create_animator`: an animator collecting `add(unit, flag, hits, params)` calls; `run()` plays them
   * together and waits for the display (one `animateUnits` beat), then empties it, as `impl_run_animation`;
   * `clear()` empties it.
   */
  private installAnimator(): void {
    const k = this.k;
    const L = k.L;
    const ANIMATOR_KEY = 'unit animator';
    const entriesOf = (T: LuaState): AnimatorEntry[] => {
      const entries = k.userdata<AnimatorEntry[]>(T, 1, ANIMATOR_KEY);
      if (!entries) typeError(T, 1, 'unit animator');
      return entries!;
    };
    const methods: Record<string, LuaCFunction> = {
      add: (T) => {
        const entries = entriesOf(T);
        const unit = this.check(T, 2);
        const flag = checkString(T, 3);
        const hitsText = checkString(T, 4);
        const hits = (['hit', 'miss', 'kill'].includes(hitsText) ? hitsText : 'invalid') as AnimatorEntry['hits'];
        let target: Location | undefined;
        let value = 0;
        let value2 = 0;
        let withBars = false;
        let text = '';
        let color = { r: 255, g: 255, b: 255 };
        if (lua.lua_istable(T, 5)) {
          lua.lua_getfield(T, 5, to_luastring('target'));
          const dest = lua.lua_isnil(T, -1) ? undefined : k.toLocation(T, -1);
          lua.lua_pop(T, 1);
          if (dest) {
            if (dest.equals(unit.location)) return argError(T, 5, "target location must be different from animated unit's location");
            if (!getAdjacentTiles(unit.location).some((l) => l.equals(dest))) return argError(T, 5, 'target location must be adjacent to the animated unit');
            target = dest;
          }
          lua.lua_getfield(T, 5, to_luastring('value'));
          if (lua.lua_isnumber(T, -1)) value = Number(lua.lua_tointeger(T, -1));
          else if (lua.lua_istable(T, -1)) {
            lua.lua_rawgeti(T, -1, 1);
            value = Number(lua.lua_tointeger(T, -1));
            lua.lua_pop(T, 1);
            lua.lua_rawgeti(T, -1, 2);
            value2 = Number(lua.lua_tointeger(T, -1));
            lua.lua_pop(T, 1);
          }
          lua.lua_pop(T, 1);
          lua.lua_getfield(T, 5, to_luastring('with_bars'));
          withBars = lua.lua_toboolean(T, -1);
          lua.lua_pop(T, 1);
          lua.lua_getfield(T, 5, to_luastring('text'));
          if (!lua.lua_isnil(T, -1)) text = k.tstringAt(T, -1)?.str() ?? lua.lua_tojsstring(T, -1);
          lua.lua_pop(T, 1);
          lua.lua_getfield(T, 5, to_luastring('color'));
          if (lua.lua_istable(T, -1) && lua.lua_rawlen(T, -1) === 3) {
            const c: number[] = [];
            for (let i = 1; i <= 3; i++) {
              lua.lua_rawgeti(T, -1, i);
              c.push(Number(lua.lua_tointeger(T, -1)));
              lua.lua_pop(T, 1);
            }
            color = { r: c[0]!, g: c[1]!, b: c[2]! };
          }
          lua.lua_pop(T, 1);
        }
        entries.push({ unit, flag, hits, target, value, value2, withBars, text, color });
        return 0;
      },
      run: (T) => {
        const entries = entriesOf(T);
        if (entries.length === 0) return 0;
        const beat = [...entries];
        entries.length = 0;
        return this.host.yieldFlow(T, (function* () {
          yield { kind: 'beat' as const, beat: { kind: 'animateUnits' as const, entries: beat } };
        })());
      },
      clear: (T) => {
        entriesOf(T).length = 0;
        return 0;
      },
    };
    lauxlib.luaL_newmetatable(L, to_luastring(ANIMATOR_KEY));
    setFuncs(L, {
      __index: (T) => {
        const fn = methods[checkString(T, 2)];
        if (!fn) return 0;
        lua.lua_pushcfunction(T, fn);
        return 1;
      },
    });
    pushString(L, ANIMATOR_KEY);
    lua.lua_setfield(L, -2, to_luastring('__metatable'));
    lua.lua_pop(L, 1);
    k.define(['wesnoth', 'units', 'create_animator'], (T) => {
      k.pushUserdata(T, ANIMATOR_KEY, [] as AnimatorEntry[]);
      return 1;
    });
  }

  /** `intf_put_unit`: `units.to_map(unit, [loc], [fire_event])`, or a WML table (creating the unit). */
  private putUnit(T: LuaState): number {
    const k = this.k;
    const ctx = this.host.ctx();
    const board = ctx.board;
    let loc = k.toLocation(T, 2);
    if (loc && !board.map.onBoard(loc)) return argError(T, 2, 'invalid location');
    const fire = toBoolean(T, -1);
    const ref = this.ref(T, 1);
    if (ref) {
      const unit = ref.get();
      if (!unit) return argError(T, 1, 'unit not found');
      if (ref.onMap && loc && unit.location.equals(loc)) return 0;
      if (!loc) {
        loc = unit.location;
        if (!board.map.onBoard(loc)) return argError(T, 1, 'invalid location');
      }
      if (ref.onMap) {
        if (!unit.location.equals(loc)) {
          board.removeUnitAt(loc);
          board.moveUnit(unit.location, loc);
        }
      } else {
        if (ref.onRecall) board.removeFromRecallList(ref.onRecall, unit.underlyingId);
        board.removeUnitAt(loc);
        unit.location = loc;
        if (board.allUnits().some((u) => u.underlyingId === unit.underlyingId)) board.assignUnitId(unit);
        board.addUnit(unit);
        ref.unit = unit;
        ref.side = 0;
      }
    } else if (!lua.lua_isnoneornil(T, 1)) {
      const cfg = k.checkConfig(T, 1);
      if (!loc || !board.map.onBoard(loc)) {
        loc = Location.fromWml(cfg.getNumber('x', 0), cfg.getNumber('y', 0));
        if (!board.map.onBoard(loc)) return argError(T, 2, 'invalid location');
      }
      const unit = Unit.fromConfig(cfg, ctx.resolveType);
      board.removeUnitAt(loc);
      unit.location = loc;
      board.addUnit(unit);
    }
    if (fire) {
      const at = loc!;
      return this.host.yieldFlow(T, ctx.fireNow('unit_placed', at));
    }
    return 0;
  }
}

/** `unit::clone`: an independent copy, keeping the underlying id. */
export function cloneUnit(unit: Unit, resolveType: (id: string) => import('@wesnothweb2/engine/src/model/UnitType.js').UnitType): Unit {
  const cfg = unit.toConfig();
  unit.location.writeToConfig(cfg);
  const copy = Unit.fromConfig(cfg, resolveType);
  copy.underlyingId = unit.underlyingId;
  return copy;
}

const KNOWN_ATTRIBUTES = new Set([
  'valid', 'x', 'y', 'loc', 'goto', 'side', 'id', 'type', 'image_mods', 'usage', 'ellipse', 'halo', 'hitpoints',
  'max_hitpoints', 'experience', 'max_experience', 'recall_cost', 'moves', 'max_moves', 'max_attacks', 'attacks_left',
  'vision', 'jamming', 'name', 'canrecruit', 'level', 'cost', 'extra_recruit', 'advances_to', 'alignment', 'upkeep',
  'advancements', 'overlays', 'traits', 'abilities', 'status', 'variables', 'attacks', 'hidden', 'resting', 'flying',
  'fearless', 'healthy', 'zoc', 'role', 'race', 'gender', 'variation', 'facing', 'portrait', '__cfg',
]);

function setFuncs(L: LuaState, fns: Readonly<Record<string, LuaCFunction>>): void {
  for (const [name, fn] of Object.entries(fns)) {
    lua.lua_pushcfunction(L, fn);
    lua.lua_setfield(L, -2, to_luastring(name));
  }
}

function pushConfigArray(k: LuaKernel, T: LuaState, cfgs: readonly WmlConfig[]): void {
  lua.lua_createtable(T, cfgs.length, 0);
  cfgs.forEach((c, i) => {
    k.pushConfig(T, c);
    lua.lua_rawseti(T, -2, i + 1);
  });
}

/** `lua_check<std::vector<std::string>>`: a table of strings, or a comma-separated string. */
function checkStringList(T: LuaState, idx: number): string[] {
  if (lua.lua_isstring(T, idx)) return checkString(T, idx).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (!lua.lua_istable(T, idx)) return typeError(T, idx, 'table');
  const out: string[] = [];
  for (let i = 1, n = lauxlib.luaL_len(T, idx); i <= n; i++) {
    lua.lua_geti(T, idx, i);
    out.push(checkString(T, -1));
    lua.lua_pop(T, 1);
  }
  return out;
}

/** `attack_type::specials_cfg`: the weapon's `[specials]` contents. */
function specialsConfig(a: AttackType): WmlConfig {
  const cfg = new WmlConfig();
  for (const s of a.specials) cfg.addChild(specialTag(s) || s.getString('id', 'special'), s);
  return cfg;
}
