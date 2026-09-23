/**
 * TS port of the WML-authored, immutable half of upstream's unit data model:
 * `unit_type` (src/units/types.hpp/.cpp) and `attack_type` (src/units/
 * attack_type.hpp/.cpp) -- "what a `Merman Fighter` is", as opposed to
 * `unit`/`Unit.ts` which is "this particular Merman Fighter on the board,
 * with 14 of its 36 HP left".
 *
 * The flattening loader this module's doc comment used to defer (see below)
 * is now implemented: `model/UnitTypeDatabase.ts`'s `flattenUnitTypeConfig`/
 * `flattenAllUnitTypes` resolve `base_unit=` inheritance before handing a
 * config to `UnitType.fromConfig` below.
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
 *  - Name generation from `unit_race` (src/units/race.hpp): race is kept as
 *    a plain id string (`raceId`), not a full `unit_race` object, since name
 *    generators are a content-flavor feature, not core combat/turn state.
 *  - `[trait]` pools ARE now partially ported (`possibleTraits`/`numTraits`,
 *    used by `actions/recruit.ts`'s `generateTraits` -- real, reported bug:
 *    recruited units never got random traits at all). What's ported: this
 *    type's own inline `[trait]` children (musthave traits like
 *    `{TRAIT_MECHANICAL}`/`{TRAIT_FEARLESS_MUSTHAVE}`, when a unit_type
 *    embeds them directly -- the common real-content pattern, see e.g.
 *    `data/core/units/undead/Corpse_Soulless.cfg`), plus the 4 real traits
 *    common to every unit type (`GLOBAL_TRAITS` below: strong/quick/
 *    intelligent/resilient, ported from `{TRAIT_STRONG}` etc in
 *    `data/core/macros/traits.cfg`, added unconditionally in upstream's own
 *    `unit_type` constructor). `numTraits` defaults to 2 (`cfg["num_traits"]`
 *    if set) -- correct for the overwhelming majority of real races. What's
 *    NOT ported: `[race]`-level `num_traits=`/`additional_traits`/
 *    `ignore_race_traits`/`ignore_global_traits` (race is a plain id string,
 *    see above) -- so a unit_type belonging to a race with a non-default
 *    `num_traits` (e.g. `mechanical`'s 1, only ever reached by
 *    scenario-placed `[unit]`s, not recruited ones -- see `generateTraits`'s
 *    own doc comment on why that's out of scope here) would, if recruited,
 *    wrongly get up to 2 slots instead of the race's real count.
 */

import { WmlConfig } from '../wml/config.js';
import { MoveType } from './MoveType.js';
import type { TerrainTypeData } from './Terrain.js';

export type Alignment = 'lawful' | 'neutral' | 'chaotic' | 'liminal';

function parseAlignment(str: string, fallback: Alignment = 'neutral'): Alignment {
  return str === 'lawful' || str === 'neutral' || str === 'chaotic' || str === 'liminal' ? str : fallback;
}

/** One entry from a `[units][weapon_specials]`/`[units][abilities]` registry -- see `UnitTypeDatabase.ts`'s `collectSpecialRegistry` for why the tag name travels alongside the config. */
export interface RegistryEntry {
  readonly tag: string;
  readonly config: WmlConfig;
}

const EMPTY_REGISTRY: ReadonlyMap<string, RegistryEntry> = new Map();

/**
 * Drops a translatable string's disambiguation context, mirroring what
 * `t_string`/gettext do when a `_ "context^text"` string is displayed:
 * the part before the `^` exists to tell translators *which* "Initiate"
 * this is, and is never shown to a player.
 *
 * Real, reported bug (bugs6.md): Dead Water 1's recruit list offered
 * "female^Mermaid Initiate", because this port stores WML strings raw
 * (it has no `t_string` -- see `wml/parser.ts`'s own note) and nothing
 * stripped the marker on the way to the screen.
 *
 * Only the FIRST `^` is treated as the separator, and only when
 * something follows it, so a name that legitimately contains `^` keeps
 * everything after the marker -- the same rule gettext itself uses.
 */
export function stripTranslationContext(text: string): string {
  const marker = text.indexOf('^');
  return marker > 0 && marker < text.length - 1 ? text.slice(marker + 1) : text;
}

/** Builds a raw `[trait]`-shaped `WmlConfig` for one of the 4 real traits common to every unit type -- see `UnitType`'s module doc comment. */
function globalTrait(id: string): WmlConfig {
  return new WmlConfig().setAttribute('id', id).setAttribute('male_name', id).setAttribute('female_name', id).setAttribute('availability', 'any');
}

/** The 4 real traits ported verbatim from `{TRAIT_STRONG}`/`{TRAIT_QUICK}`/`{TRAIT_INTELLIGENT}`/`{TRAIT_RESILIENT}` (`data/core/macros/traits.cfg`), added to every unit type's trait pool by upstream's own `unit_type` constructor -- see `UnitType`'s module doc comment. */
export const GLOBAL_TRAITS: readonly WmlConfig[] = [globalTrait('strong'), globalTrait('quick'), globalTrait('intelligent'), globalTrait('resilient')];

/** Resolves a comma-separated `*_list=` attribute value against a registry, mirroring `unit_type_data::add_registry_entries`'s id-resolution loop -- unknown ids are silently skipped (matches upstream's WRN-log-and-continue, not an error). */
function resolveIdList(listValue: string, registry: ReadonlyMap<string, RegistryEntry>): RegistryEntry[] {
  return listValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((id) => registry.get(id))
    .filter((c): c is RegistryEntry => c !== undefined);
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

  /**
   * `specialsRegistry` resolves `specials_list=` (a comma-separated list of
   * ids, e.g. `specials_list=marksman,poison` -- common in real
   * `data/core/units/` content) against the real `[units][weapon_specials]`
   * registry (see `UnitTypeDatabase.ts`'s `collectSpecialRegistry`),
   * appended after any literal inline `[specials]` children -- mirrors
   * `attack_type`'s own construction (`unit_type_data::add_registry_entries`:
   * starts from the inline `[specials]` block, then appends each resolved
   * registry id). Omitted/empty registry means `specials_list=` silently
   * resolves to nothing (matches every existing call site that doesn't
   * pass one, e.g. hand-built test fixtures with no registry at all).
   */
  static fromConfig(cfg: WmlConfig, specialsRegistry: ReadonlyMap<string, RegistryEntry> = EMPTY_REGISTRY): AttackType {
    const id = cfg.getString('name');
    const name = cfg.hasAttribute('description') ? cfg.getString('description') : id;
    const alignmentStr = cfg.getString('alignment', '');
    const specialsCfg = cfg.child('specials');
    const inlineSpecials = specialsCfg ? specialsCfg.allChildren().map((c) => c.config) : [];
    const listedSpecials = resolveIdList(cfg.getString('specials_list', ''), specialsRegistry).map((e) => e.config);
    const specials = [...inlineSpecials, ...listedSpecials];

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

/** `unit_type`'s gender list: `gender=male,female` in order, male when absent or empty. */
function parseGenders(raw: string): string[] {
  const genders = raw
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g === 'male' || g === 'female');
  return genders.length > 0 ? [...new Set(genders)] : ['male'];
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
    /**
     * This type's `[abilities]` children (each e.g. `[heals]`, `[hides]`),
     * unevaluated, WITH their tag name preserved -- unlike
     * `AttackType.specials`, a bare `WmlConfig` isn't enough here: real
     * content's ability `id=` is a *display* id (e.g. the real `heals`-tag
     * registry entries set `id=healing`/`id=curing`, never literally
     * `id=heals`), not a type discriminator -- matching by tag name is
     * what upstream itself does (`tag_name == "heals"`,
     * `src/units/abilities.cpp`). See `RegistryEntry`'s own doc comment.
     */
    public readonly abilities: readonly RegistryEntry[],
    /** How many `[trait]` slots `generateTraits` fills for a freshly recruited unit of this type -- mirrors `unit_type::num_traits()`, see module doc comment on what's NOT ported (race-level defaults). */
    public readonly numTraits: number = 2,
    /** Raw `[trait]` candidate configs (this type's own inline ones, then `GLOBAL_TRAITS`) -- see module doc comment. */
    public readonly possibleTraits: readonly WmlConfig[] = GLOBAL_TRAITS,
    /** Whether `vision=` was set; upstream's `vision_ < 0` means "use max movement" (see `actions/vision.ts`'s `unitVisionRange`). */
    public readonly hasExplicitVision: boolean = false,
    /**
     * Mirrors `unit_type::usage()` (`usage=`, e.g. `"scout"`, `"healer"`,
     * `"fighter"`, `"mixed fighter"`) -- a free-form WML-authored hint the
     * AI's recruitment/scouting/healer-placement candidate actions key off
     * (`villages_per_scout`, `ca_place_healers`'s `usage=="healer"` check).
     * Purely descriptive; the core engine never interprets it itself.
     */
    public readonly usage: string = '',
    /** `profile=`: the type's portrait (`unit_type::big_profile`), shown in `[message]` dialogs. Empty when the type has none. */
    public readonly profile: string = '',
    /** `image=`: the type's base sprite, the portrait fallback when there is no profile. */
    public readonly image: string = '',
    /** `gender=`: the genders a unit of this type can have, in declaration order (`unit_type::genders()`); male when unset. */
    public readonly genders: readonly string[] = ['male'],
    /** Synced random numbers naming a new unit of this type consumes, per gender (see `nameDrawCount`). */
    public readonly nameDraws: { readonly male: number; readonly female: number } = { male: 0, female: 0 },
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
   * `registries` (see `AttackType.fromConfig`'s own doc comment on the
   * `weaponSpecials` half) resolves this type's own `abilities_list=`
   * (e.g. `abilities_list=skirmisher`, `abilities_list=heals_4,cures` --
   * both real, common patterns) the same way, appended after any literal
   * inline `[abilities]` children, and is threaded down to every
   * `[attack]`'s own `specials_list=` resolution too.
   */
  static fromConfig(
    cfg: WmlConfig,
    movementTypes: ReadonlyMap<string, WmlConfig>,
    terrainData: TerrainTypeData,
    registries: { weaponSpecials?: ReadonlyMap<string, RegistryEntry>; abilities?: ReadonlyMap<string, RegistryEntry> } = {},
  ): UnitType {
    const id = cfg.getString('id');
    const name = stripTranslationContext(cfg.getString('name', id));
    const level = cfg.getNumber('level', 0);

    const moveTypeId = cfg.getString('movement_type', '');
    const baseMoveTypeCfg = movementTypes.get(moveTypeId);
    const baseMoveType = MoveType.fromConfig(baseMoveTypeCfg ?? new WmlConfig(), terrainData);
    const moveType = MoveType.overlay(baseMoveType, cfg);

    const attacks = cfg.children('attack').map((a) => AttackType.fromConfig(a, registries.weaponSpecials));
    const inlineAbilities: RegistryEntry[] = cfg.hasChild('abilities') ? cfg.child('abilities')!.allChildren().map((c) => ({ tag: c.tag, config: c.config })) : [];
    const listedAbilities = resolveIdList(cfg.getString('abilities_list', ''), registries.abilities ?? EMPTY_REGISTRY);
    const abilities = [...inlineAbilities, ...listedAbilities];

    // A snapshot built since Phase 18b carries the race-resolved pool, in
    // upstream's order (`resolveTraitPools`). Anything else (hand-built test
    // types) gets the old approximation, in upstream's order at least:
    // the global traits first, then the type's own.
    const resolved = cfg.getBoolean('traits_resolved', false);
    const numTraits = cfg.getNumber('num_traits', resolved ? 0 : 2);
    const possibleTraits = resolved ? cfg.children('trait') : [...GLOBAL_TRAITS, ...cfg.children('trait')];

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
      numTraits,
      possibleTraits,
      cfg.hasAttribute('vision'),
      cfg.getString('usage', ''),
      cfg.getString('profile', ''),
      cfg.getString('image', ''),
      parseGenders(cfg.getString('gender', '')),
      { male: cfg.getNumber('name_draws_male', 0), female: cfg.getNumber('name_draws_female', 0) },
    );
  }
}
