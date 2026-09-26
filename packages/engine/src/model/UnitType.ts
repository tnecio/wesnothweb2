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
import { mergeUnitTypeConfig } from './UnitTypeDatabase.js';
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

/**
 * `utils::apply_modifier`: `amount` is added to `number` -- or, ending in
 * `%`, that percentage of it (rounded half away from zero, `div100rounded`)
 * -- with the result raised to `minimum` when `minimum > 0`.
 */
export function applyModifier(number: number, amount: string, minimum = 0): number {
  const parsed = Number.parseInt(amount.trim(), 10);
  let value = Number.isNaN(parsed) ? 0 : parsed;
  if (amount.trim().endsWith('%')) {
    const n = number * value;
    value = n < 0 ? -Math.trunc((-n + 50) / 100) : Math.trunc((n + 50) / 100);
  }
  value += number;
  return minimum > 0 && value < minimum ? minimum : value;
}

/** `in_ranges` over `parse_ranges`: a comma list of numbers and `a-b` ranges (`b` may be `infinity`). */
export function matchesRanges(value: number, list: string): boolean {
  for (const part of list.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const dash = token.indexOf('-', 1);
    if (dash === -1) {
      if (Number(token) === value) return true;
      continue;
    }
    const lo = Number(token.slice(0, dash));
    const hiText = token.slice(dash + 1);
    const hi = hiText === 'infinity' ? Infinity : Number(hiText);
    if (value >= lo && value <= hi) return true;
  }
  return false;
}

/** Resolves a comma-separated `*_list=` attribute value against a registry, mirroring `unit_type_data::add_registry_entries`'s id-resolution loop -- unknown ids are silently skipped (matches upstream's WRN-log-and-continue, not an error). */
function resolveIdList(listValue: string, registry: ReadonlyMap<string, RegistryEntry>): RegistryEntry[] {
  return listValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((id) => registry.get(id))
    .filter((c): c is RegistryEntry => c !== undefined);
}

/** What `UnitType` keeps beyond its positional stats (see its constructor). */
export interface UnitTypeExtras {
  readonly registries?: { readonly weaponSpecials: ReadonlyMap<string, RegistryEntry>; readonly abilities: ReadonlyMap<string, RegistryEntry> };
  readonly advancements?: readonly WmlConfig[];
  readonly upkeep?: string;
  readonly variationId?: string;
  readonly halo?: string;
  readonly makeVariation?: (id: string) => UnitType | undefined;
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
    /** `movement_used=`: movement an attack with this weapon spends (upstream default 100000, i.e. all of it). */
    public readonly movementUsed: number = 100000,
    /** `attacks_used=`: how many of the unit's attacks this weapon spends. */
    public readonly attacksUsed: number = 1,
  ) {}

  /**
   * `attack_type::matches_filter` (`matches_simple_filter` plus in-order
   * `[and]`/`[or]`/`[not]`) -- a weapon filter, e.g. `[effect]
   * apply_to=attack`'s own attributes. `special_id`/`special_type` and the
   * `*_active` forms check the weapon's own specials (not whether they are
   * active in a given fight); `formula=` is not evaluated (matches nothing,
   * as upstream does on a formula error).
   */
  matchesFilter(filter: WmlConfig): boolean {
    let matches = this.matchesSimpleFilter(filter);
    for (const { tag, config } of filter.allChildren()) {
      if (tag === 'and') matches = matches && this.matchesFilter(config);
      else if (tag === 'or') matches = matches || this.matchesFilter(config);
      else if (tag === 'not') matches = matches && !this.matchesFilter(config);
    }
    return matches;
  }

  private matchesSimpleFilter(filter: WmlConfig): boolean {
    const set = (key: string) => new Set(filter.getString(key, '').split(',').map((v) => v.trim()).filter((v) => v !== ''));
    const inRanges = (value: number, key: string) => !filter.hasAttribute(key) || matchesRanges(value, filter.getString(key));
    if (!inRanges(this.minRange, 'min_range') || !inRanges(this.maxRange, 'max_range')) return false;
    const range = set('range');
    if (range.size > 0 && !range.has(this.range)) return false;
    if (!inRanges(this.damage, 'damage') || !inRanges(this.numAttacks, 'number')) return false;
    if (!inRanges(this.accuracy, 'accuracy') || !inRanges(this.parry, 'parry')) return false;
    if (!inRanges(this.movementUsed, 'movement_used') || !inRanges(this.attacksUsed, 'attacks_used')) return false;
    const alignment = set('alignment');
    if (alignment.size > 0 && !alignment.has(this.alignment ?? '')) return false;
    const name = set('name');
    if (name.size > 0 && !name.has(this.id)) return false;
    const type = set('type');
    if (type.size > 0 && !type.has(this.type)) return false;
    const baseType = set('base_type');
    if (baseType.size > 0 && !baseType.has(this.type)) return false;
    const specialIds = new Set(this.specials.map((s) => s.getString('id', '')));
    for (const key of ['special', 'special_id', 'special_type', 'special_active', 'special_id_active', 'special_type_active']) {
      const wanted = set(key);
      if (wanted.size > 0 && ![...wanted].some((id) => specialIds.has(id))) return false;
    }
    if (filter.hasAttribute('formula')) return false;
    return true;
  }

  /**
   * `attack_type::apply_effect`: this weapon with one `[effect]
   * apply_to=attack` applied -- names, type, range, specials
   * (`remove_specials=`, `[set_specials]` in `append`/`replace` mode),
   * ranges, damage and strikes (never below 0; strikes via
   * `apply_modifier`), accuracy, parry, movement/attacks used, weights.
   * `specialsRegistry` resolves `[set_specials] specials_list=`.
   */
  withEffect(cfg: WmlConfig, specialsRegistry: ReadonlyMap<string, RegistryEntry> = EMPTY_REGISTRY): AttackType {
    const str = (key: string) => (cfg.hasAttribute(key) && cfg.getString(key) !== '' ? cfg.getString(key) : null);
    let specials = [...this.specials];
    const removeIds = str('remove_specials');
    if (removeIds) {
      const ids = removeIds.split(',').map((v) => v.trim());
      specials = specials.filter((sp) => !ids.includes(sp.getString('id', '')));
    }
    const setSpecials = cfg.child('set_specials');
    if (setSpecials) {
      if (setSpecials.getString('mode', '') !== 'append') specials = [];
      specials.push(...resolveIdList(setSpecials.getString('specials_list', ''), specialsRegistry).map((e) => e.config));
      specials.push(...setSpecials.allChildren().map((c) => c.config));
    }
    const removeSpecials = cfg.child('remove_specials');
    if (removeSpecials) {
      const ids = removeSpecials.getString('id', '').split(',').map((v) => v.trim()).filter((v) => v !== '');
      if (ids.length > 0) specials = specials.filter((sp) => !ids.includes(sp.getString('id', '')));
    }
    let minRange = this.minRange;
    if (str('set_min_range')) minRange = cfg.getNumber('set_min_range');
    if (str('increase_min_range')) minRange = applyModifier(minRange, cfg.getString('increase_min_range'));
    let maxRange = this.maxRange;
    if (str('set_max_range')) maxRange = cfg.getNumber('set_max_range');
    if (str('increase_max_range')) maxRange = applyModifier(maxRange, cfg.getString('increase_max_range'));
    let damage = this.damage;
    if (str('set_damage')) damage = Math.max(0, cfg.getNumber('set_damage'));
    if (str('increase_damage')) damage = Math.max(0, applyModifier(damage, cfg.getString('increase_damage')));
    let numAttacks = this.numAttacks;
    if (str('set_attacks')) numAttacks = Math.max(0, cfg.getNumber('set_attacks'));
    if (str('increase_attacks')) numAttacks = applyModifier(numAttacks, cfg.getString('increase_attacks'), 1);
    let accuracy = this.accuracy;
    if (str('set_accuracy')) accuracy = cfg.getNumber('set_accuracy');
    if (str('increase_accuracy')) accuracy = applyModifier(accuracy, cfg.getString('increase_accuracy'));
    let parry = this.parry;
    if (str('set_parry')) parry = cfg.getNumber('set_parry');
    if (str('increase_parry')) parry = applyModifier(parry, cfg.getString('increase_parry'));
    let movementUsed = this.movementUsed;
    if (str('set_movement_used')) movementUsed = cfg.getNumber('set_movement_used');
    if (str('increase_movement_used')) movementUsed = applyModifier(movementUsed, cfg.getString('increase_movement_used'), 1);
    let attacksUsed = this.attacksUsed;
    if (str('set_attacks_used')) attacksUsed = cfg.getNumber('set_attacks_used');
    if (str('increase_attacks_used')) attacksUsed = applyModifier(attacksUsed, cfg.getString('increase_attacks_used'), 1);
    const alignment = str('set_alignment');
    return new AttackType(
      str('set_name') ?? this.id,
      str('set_description') ?? this.name,
      str('set_type') ?? this.type,
      str('set_range') ?? this.range,
      minRange,
      maxRange,
      damage,
      numAttacks,
      str('attack_weight') ? cfg.getNumber('attack_weight', 1) : this.attackWeight,
      str('defense_weight') ? cfg.getNumber('defense_weight', 1) : this.defenseWeight,
      accuracy,
      parry,
      alignment ? parseAlignment(alignment) : this.alignment,
      specials,
      movementUsed,
      attacksUsed,
    );
  }

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
      cfg.getNumber('movement_used', 100000),
      cfg.getNumber('attacks_used', 1),
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
    /** The rest of what a unit takes from its type, and what effects need to resolve against (Phase 18c). */
    extras: UnitTypeExtras = {},
  ) {
    this.registries = extras.registries ?? { weaponSpecials: EMPTY_REGISTRY, abilities: EMPTY_REGISTRY };
    this.advancements = extras.advancements ?? [];
    this.upkeep = extras.upkeep ?? 'full';
    this.variationId = extras.variationId ?? '';
    this.halo = extras.halo ?? '';
    this.makeVariation = extras.makeVariation;
  }

  /** The `[units]` registries this type was built with, which `[effect]`s resolve `specials_list=`/`new_ability` against. */
  readonly registries: { readonly weaponSpecials: ReadonlyMap<string, RegistryEntry>; readonly abilities: ReadonlyMap<string, RegistryEntry> };
  /** `[advancement]`s (AMLA and advancement options), as configs. */
  readonly advancements: readonly WmlConfig[];
  /** `upkeep=`: `full` (the unit's level), `loyal` (none), or a number. */
  readonly upkeep: string;
  /** Which `[variation]` this type is (`variation_id=`); `''` for the base type. */
  readonly variationId: string;
  /** `halo=`. */
  readonly halo: string;
  private readonly makeVariation: ((id: string) => UnitType | undefined) | undefined;
  private readonly variationCache = new Map<string, UnitType | undefined>();

  /**
   * `unit_type::get_variation`: the type a unit of this type with
   * `variation=id` actually has -- the `[variation]` merged over this type
   * when it says `inherit=yes` (`create_sub_type`), with its own movetype,
   * hitpoints, attacks. This type itself for `''` or an unknown id.
   */
  variation(id: string): UnitType {
    if (id === '' || id === this.variationId || !this.makeVariation) return this;
    if (!this.variationCache.has(id)) this.variationCache.set(id, this.makeVariation(id));
    return this.variationCache.get(id) ?? this;
  }

  /** Whether this type declares `[variation] variation_id=id`. */
  hasVariation(id: string): boolean {
    return id !== '' && this.variation(id) !== this;
  }

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
        // `advances_to=null` is "nowhere" (types.cpp: `advances_to_val != "null"`).
        .filter((s) => s.length > 0 && s !== 'null'),
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
      {
        registries: { weaponSpecials: registries.weaponSpecials ?? EMPTY_REGISTRY, abilities: registries.abilities ?? EMPTY_REGISTRY },
        advancements: cfg.children('advancement'),
        upkeep: cfg.getString('upkeep', 'full'),
        variationId: cfg.getString('variation_id', ''),
        halo: cfg.getString('halo', ''),
        makeVariation: (variationId) => {
          const varCfg = cfg.children('variation').find((v) => v.getString('variation_id') === variationId);
          if (!varCfg) return undefined;
          // create_sub_type: inherit=yes merges the variation over the base
          // (`inherit_from`); the sub-type keeps no [variation]s of its own.
          const base = cfg.clone();
          base.removeChildren('variation');
          const merged = varCfg.getBoolean('inherit', false) ? mergeUnitTypeConfig(base, varCfg) : varCfg.clone();
          merged.removeChildren('male');
          merged.removeChildren('female');
          merged.setAttribute('id', id);
          merged.setAttribute('variation_id', variationId);
          return UnitType.fromConfig(merged, movementTypes, terrainData, registries);
        },
      },
    );
  }
}
