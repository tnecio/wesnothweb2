/**
 * TS port of the WML-authored, immutable half of upstream's unit data model:
 * `unit_type` (src/units/types.hpp/.cpp) and `attack_type` (src/units/
 * attack_type.hpp/.cpp) -- "what a `Merman Fighter` is", as opposed to
 * `unit`/`Unit.ts` which is "this particular Merman Fighter on the board,
 * with 14 of its 36 HP left".
 *
 * Deliberately NOT ported here (display/animation-coupled, or requiring the
 * WFL/Lua effects system that's out of scope until later phases):
 *  - `[attack_anim]`, `[defend]`/animation config, `halo()`, `ellipse()`,
 *    `image()`/`icon()`/profile fields, flag_rgb -- all rendering.
 *  - Ability *evaluation* (`has_ability_by_id`, adjacent-affecting auras,
 *    weapon specials' actual combat effect): abilities and weapon specials
 *    are kept as raw `WmlConfig` so filters/UI can still inspect them, but
 *    are never interpreted here. That needs the WFL interpreter (unit
 *    filters, `formula=`) and, for many abilities, Lua -- both later-phase
 *    work per the project plan.
 *  - `[male]`/`[female]`/`[variation]` sub-type inheritance and
 *    `base_unit`/`[base_unit]` config inheritance: these are WML-authoring
 *    conveniences resolved by flattening `config`s together before
 *    `unit_type` construction upstream; a loader building `UnitType`s from
 *    parsed WML should do the equivalent flattening before calling
 *    `UnitType.fromConfig`, so it isn't duplicated here.
 *  - Name generation / `[trait]` pools from `unit_race` (src/units/race.hpp):
 *    race is kept as a plain id string (`raceId`), not a full `unit_race`
 *    object, since name generators are a content-flavor feature, not core
 *    combat/turn state.
 */

import { WmlConfig } from '../wml/config.js';
import { MoveType } from './MoveType.js';
import type { TerrainTypeData } from './Terrain.js';

export type Alignment = 'lawful' | 'neutral' | 'chaotic' | 'liminal';

function parseAlignment(str: string, fallback: Alignment = 'neutral'): Alignment {
  return str === 'lawful' || str === 'neutral' || str === 'chaotic' || str === 'liminal' ? str : fallback;
}

/**
 * A single weapon. Mirrors the non-display, non-ability-evaluating fields of
 * `attack_type`. Note the WML-key/accessor mismatch ported verbatim from
 * upstream: `name=` is this weapon's *id* (`id()`/`id_`), `description=` is
 * its display name (`name()`/`description_`, defaulting to the id).
 */
export class AttackType {
  constructor(
    /** cfg["name"] -- yes, really; matches attack_type::id_. */
    public readonly id: string,
    /** cfg["description"], defaulting to `id`; matches attack_type::name(). */
    public readonly name: string,
    public readonly type: string,
    public readonly range: string,
    public readonly minRange: number,
    public readonly maxRange: number,
    public readonly damage: number,
    public readonly numAttacks: number,
    public readonly attackWeight: number,
    public readonly defenseWeight: number,
    public readonly accuracy: number,
    public readonly parry: number,
    public readonly alignment: Alignment | undefined,
    /** Raw `[specials]` sub-tag configs (each e.g. `[damage]`, `[poison]`), unevaluated. */
    public readonly specials: readonly WmlConfig[],
  ) {}

  static fromConfig(cfg: WmlConfig): AttackType {
    const id = cfg.getString('name');
    const name = cfg.hasAttribute('description') ? cfg.getString('description') : id;
    const alignmentStr = cfg.getString('alignment', '');
    const specialsCfg = cfg.child('specials');
    const specials = specialsCfg ? specialsCfg.allChildren().map((c) => c.config) : [];

    return new AttackType(
      id,
      name,
      cfg.getString('type'),
      cfg.getString('range'),
      cfg.getNumber('min_range', 1),
      cfg.getNumber('max_range', 1),
      cfg.getNumber('damage', 0),
      cfg.getNumber('number', 0),
      cfg.getNumber('attack_weight', 1),
      cfg.getNumber('defense_weight', 1),
      cfg.getNumber('accuracy', 0),
      cfg.getNumber('parry', 0),
      alignmentStr === '' ? undefined : parseAlignment(alignmentStr),
      specials,
    );
  }
}

/**
 * A unit type's WML-authored definition. Mirrors the data half of
 * `unit_type`. Immutable: building a live `Unit` from one never mutates it.
 */
export class UnitType {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly raceId: string,
    public readonly alignment: Alignment,
    public readonly level: number,
    public readonly hitpoints: number,
    public readonly movement: number,
    public readonly vision: number,
    public readonly jamming: number,
    public readonly maxAttacksPerTurn: number,
    public readonly cost: number,
    /** -1 means "use the side's default recall cost" (matches `recall_cost_`'s -1 sentinel). */
    public readonly recallCost: number,
    /** Raw `experience=` value; call `experienceNeeded()` for the modifier-adjusted threshold. */
    public readonly experienceNeededBase: number,
    public readonly advancesTo: readonly string[],
    public readonly undeadVariation: string,
    public readonly zoc: boolean,
    public readonly hideHelp: boolean,
    public readonly doNotList: boolean,
    public readonly moveType: MoveType,
    public readonly attacks: readonly AttackType[],
    /** Raw `[abilities]` child tags (e.g. `[heals]`, `[hides]`), unevaluated -- see module doc comment. */
    public readonly abilities: readonly WmlConfig[],
  ) {}

  /** Mirrors `unit_type::experience_needed`: the modifier is the game-wide `[game_config] experience_modifier` (default 100 = unchanged). */
  experienceNeeded(experienceModifierPercent = 100): number {
    const exp = Math.floor((this.experienceNeededBase * experienceModifierPercent + 50) / 100);
    return Math.max(1, exp);
  }

  /**
   * Builds a UnitType from a (fully flattened -- see module doc comment)
   * `[unit_type]` config. `movementTypes` is the registry of top-level
   * `[movetype]` blocks (keyed by `name=`) that `movement_type=` refers to;
   * `terrainData` resolves terrain aliasing for movement/defense lookups.
   */
  static fromConfig(cfg: WmlConfig, movementTypes: ReadonlyMap<string, WmlConfig>, terrainData: TerrainTypeData): UnitType {
    const id = cfg.getString('id');
    const name = cfg.getString('name', id);
    const level = cfg.getNumber('level', 0);

    const moveTypeId = cfg.getString('movement_type', '');
    const baseMoveTypeCfg = movementTypes.get(moveTypeId);
    const baseMoveType = MoveType.fromConfig(baseMoveTypeCfg ?? new WmlConfig(), terrainData);
    const moveType = MoveType.overlay(baseMoveType, cfg);

    const attacks = cfg.children('attack').map((a) => AttackType.fromConfig(a));
    const abilities = cfg.hasChild('abilities') ? cfg.child('abilities')!.allChildren().map((c) => c.config) : [];

    return new UnitType(
      id,
      name,
      cfg.getString('race', ''),
      parseAlignment(cfg.getString('alignment', '')),
      level,
      cfg.getNumber('hitpoints', 1),
      cfg.getNumber('movement', 1),
      cfg.hasAttribute('vision') ? cfg.getNumber('vision') : cfg.getNumber('movement', 1),
      cfg.getNumber('jamming', 0),
      cfg.getNumber('attacks', 1),
      cfg.getNumber('cost', 1),
      cfg.getNumber('recall_cost', -1),
      cfg.getNumber('experience', 500),
      cfg.getString('advances_to', '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      cfg.getString('undead_variation', ''),
      cfg.hasAttribute('zoc') ? cfg.getBoolean('zoc') : level > 0,
      cfg.getBoolean('hide_help', false),
      cfg.getBoolean('do_not_list', false),
      moveType,
      attacks,
      abilities,
    );
  }
}
