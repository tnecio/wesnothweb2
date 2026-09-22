/**
 * TS port of upstream Wesnoth's `movetype` (src/movetype.hpp/.cpp): a unit's
 * (or unit type's) terrain-dependent movement/vision/jamming cost, defense,
 * and resistance tables, resolved through the terrain-aliasing scheme
 * described by `TerrainType.mvtType`/`defType` (see Terrain.ts).
 *
 * WML shape (`[movement_costs]`, `[defense]`, `[resistance]` children of
 * either a reusable `[movetype]` tag or inline in `[unit_type]`): each is a
 * flat map of *terrain type id* (e.g. `flat`, `forest`, `deep_water` -- the
 * `id` of a `[terrain_type]`, not the map's `Gg`-style terrain *code*) to an
 * integer. A terrain not listed directly is resolved via its
 * `TerrainType.mvtType`/`defType` alias list, recursively, honouring `+`
 * (prefer the better value) and `-` (prefer the worse value) combinators --
 * this is a direct port of `movetype::terrain_info::data::calc_value`.
 */

import type { WmlConfig } from '../wml/config.js';
import { TerrainTypeData, TerrainCode, MINUS, PLUS, isIndivisible } from './Terrain.js';

/** Mirrors `movetype::UNREACHABLE`. */
export const UNREACHABLE = 99;

interface TableParams {
  readonly defaultValue: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly highIsGood: boolean;
  readonly useMove: boolean;
  /** `parameters::eval`: converts a value read from the config before it is clamped (`config_to_min`/`config_to_max` for defense). */
  readonly evaluate?: (value: number) => number;
}

const MOVEMENT_PARAMS: TableParams = {
  defaultValue: UNREACHABLE,
  minValue: 1,
  maxValue: UNREACHABLE,
  highIsGood: false,
  useMove: true,
};
const JAMMING_PARAMS: TableParams = {
  defaultValue: 0,
  minValue: 0,
  maxValue: UNREACHABLE,
  highIsGood: false,
  useMove: true,
};
/**
 * `movetype::terrain_defense` reads the one `[defense]` table two ways
 * (movetype.cpp ~L35-83): a negative value (`forest=-70` for mounted units)
 * is a *cap* -- the chance to be hit can't go below 70 however good the
 * other half of a mixed terrain is. `params_min_` sees only the caps
 * (`config_to_min`: -v, else 0) and keeps the highest; `params_max_` sees
 * every value as positive (`config_to_max`) and keeps the lowest, as a
 * plain table would. The defense is the larger of the two.
 */
const DEFENSE_MIN_PARAMS: TableParams = {
  defaultValue: 0,
  minValue: 0,
  maxValue: 100,
  highIsGood: true,
  useMove: false,
  evaluate: (value) => (value < 0 ? -value : 0),
};
const DEFENSE_MAX_PARAMS: TableParams = {
  defaultValue: 100,
  minValue: 0,
  maxValue: 100,
  highIsGood: false,
  useMove: false,
  evaluate: (value) => (value < 0 ? -value : value),
};

/**
 * Resolves a terrain's cost/defense value from a flat by-terrain-id table,
 * falling back to alias resolution (and then to `fallback`) exactly as
 * `movetype::terrain_info::data::calc_value` does.
 */
function resolveValue(
  terrain: TerrainCode,
  table: ReadonlyMap<string, number>,
  params: TableParams,
  terrainData: TerrainTypeData,
  fallback: ReadonlyMap<string, number> | undefined,
  recurseCount = 0,
): number {
  if (recurseCount > 100) return params.defaultValue;

  const info = terrainData.getTerrainInfo(terrain);
  const underlying = params.useMove ? info.mvtType : info.defType;

  if (isIndivisible(terrain, underlying)) {
    let result = params.defaultValue;
    const direct = table.get(info.id);
    if (direct !== undefined) {
      result = params.evaluate ? params.evaluate(direct) : direct;
    } else if (fallback) {
      result = resolveValue(terrain, fallback, params, terrainData, undefined, recurseCount + 1);
    }
    return Math.min(params.maxValue, Math.max(params.minValue, result));
  }

  let preferHigh = params.highIsGood;
  let result = params.defaultValue;
  if (underlying.length > 0 && underlying[0]!.equals(MINUS)) {
    result = result === params.maxValue ? params.minValue : params.maxValue;
  }

  for (const t of underlying) {
    if (t.equals(PLUS)) {
      preferHigh = params.highIsGood;
      continue;
    }
    if (t.equals(MINUS)) {
      preferHigh = !params.highIsGood;
      continue;
    }
    const num = resolveValue(t, table, params, terrainData, fallback, recurseCount + 1);
    if ((preferHigh && num > result) || (!preferHigh && num < result)) {
      result = num;
    }
  }
  return result;
}

function readIntTable(cfg: WmlConfig | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!cfg) return map;
  for (const key of cfg.attributeNames()) {
    map.set(key, cfg.getNumber(key));
  }
  return map;
}

function mergeIntTable(base: ReadonlyMap<string, number>, overrides: WmlConfig | undefined): Map<string, number> {
  const merged = new Map(base);
  if (overrides) {
    for (const key of overrides.attributeNames()) merged.set(key, overrides.getNumber(key));
  }
  return merged;
}

/** Mirrors `movetype::resistances`. */
export class Resistances {
  constructor(private readonly byDamageType: ReadonlyMap<string, number> = new Map()) {}

  /**
   * Vulnerability to `damageType` (>100 = weak to it, <100 = resistant),
   * 100 (i.e. normal, unmodified damage) if unspecified -- mirrors
   * `movetype::resistances::resistance_against`'s exact fallback
   * (`cfg_[damage_type].to_int(100)` in movetype.cpp), confirmed against
   * that source directly. A prior version of this defaulted to 0, which
   * silently made every unit nearly immune (1 damage, the roundDamage()
   * floor) to any damage type its [resistance] table didn't explicitly
   * list -- almost all real content only lists the damage types a unit is
   * unusually strong/weak against and relies on this default for
   * everything else, so that bug would have corrupted the overwhelming
   * majority of real combat outcomes. Caught by
   * packages/engine/test/actions/combat.test.ts.
   */
  resistanceAgainst(damageType: string): number {
    return this.byDamageType.get(damageType) ?? 100;
  }

  damageTable(): ReadonlyMap<string, number> {
    return this.byDamageType;
  }
}

/**
 * A unit type's (or unit instance's) full terrain-interaction profile.
 * Mirrors `movetype`.
 */
export class MoveType {
  private constructor(
    readonly flying: boolean,
    private readonly movementTable: ReadonlyMap<string, number>,
    private readonly visionTable: ReadonlyMap<string, number>,
    private readonly jammingTable: ReadonlyMap<string, number>,
    private readonly defenseTable: ReadonlyMap<string, number>,
    readonly resistances: Resistances,
    private readonly terrainData: TerrainTypeData,
  ) {}

  /** Builds a fresh MoveType from a `[movetype]` (or `[unit_type]`-inline) config. */
  static fromConfig(cfg: WmlConfig, terrainData: TerrainTypeData): MoveType {
    const flying = cfg.hasAttribute('flying') ? cfg.getBoolean('flying') : cfg.getBoolean('flies');
    return new MoveType(
      flying,
      readIntTable(cfg.child('movement_costs')),
      readIntTable(cfg.child('vision_costs')),
      readIntTable(cfg.child('jamming_costs')),
      readIntTable(cfg.child('defense')),
      new Resistances(readIntTable(cfg.child('resistance'))),
      terrainData,
    );
  }

  /**
   * Merges `cfg`'s `[movement_costs]`/`[vision_costs]`/`[jamming_costs]`/
   * `[defense]`/`[resistance]`/`flying` children over `base`, returning a new
   * MoveType (mirrors `movetype::merge`'s overwrite mode -- the "relative
   * improvement" non-overwrite mode upstream supports for `[effect]`
   * modifications is not implemented; not needed to build the static data
   * model from WML).
   */
  static overlay(base: MoveType, cfg: WmlConfig): MoveType {
    const flying = cfg.hasAttribute('flying')
      ? cfg.getBoolean('flying')
      : cfg.hasAttribute('flies')
        ? cfg.getBoolean('flies')
        : base.flying;
    return new MoveType(
      flying,
      mergeIntTable(base.movementTable, cfg.child('movement_costs')),
      mergeIntTable(base.visionTable, cfg.child('vision_costs')),
      mergeIntTable(base.jammingTable, cfg.child('jamming_costs')),
      mergeIntTable(base.defenseTable, cfg.child('defense')),
      cfg.hasChild('resistance')
        ? new Resistances(mergeIntTable(base.resistances.damageTable(), cfg.child('resistance')))
        : base.resistances,
      base.terrainData,
    );
  }

  movementCost(terrain: TerrainCode, slowed = false): number {
    const result = resolveValue(terrain, this.movementTable, MOVEMENT_PARAMS, this.terrainData, undefined);
    return slowed && result !== UNREACHABLE ? 2 * result : result;
  }

  visionCost(terrain: TerrainCode, slowed = false): number {
    const result =
      this.visionTable.size === 0
        ? resolveValue(terrain, this.movementTable, MOVEMENT_PARAMS, this.terrainData, undefined)
        : resolveValue(terrain, this.visionTable, MOVEMENT_PARAMS, this.terrainData, this.movementTable);
    return slowed && result !== UNREACHABLE ? 2 * result : result;
  }

  jammingCost(terrain: TerrainCode, slowed = false): number {
    const result = resolveValue(terrain, this.jammingTable, JAMMING_PARAMS, this.terrainData, undefined);
    return slowed && result !== UNREACHABLE ? 2 * result : result;
  }

  defenseModifier(terrain: TerrainCode): number {
    // Real, reported bug (bugs6.md): with one plain table, mounted units'
    // `forest=-70` cap clamped to 0 -- 100% defense in every forest.
    return Math.max(
      resolveValue(terrain, this.defenseTable, DEFENSE_MIN_PARAMS, this.terrainData, undefined),
      resolveValue(terrain, this.defenseTable, DEFENSE_MAX_PARAMS, this.terrainData, undefined),
    );
  }

  resistanceAgainst(damageType: string): number {
    return this.resistances.resistanceAgainst(damageType);
  }
}
