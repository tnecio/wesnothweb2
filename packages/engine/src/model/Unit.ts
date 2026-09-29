/**
 * TS port of the mutable, on-the-board half of upstream's unit data model:
 * `unit` (src/units/unit.hpp/.cpp) -- "this particular Merman Fighter, at
 * this hex, with 14 of its 36 HP left, poisoned" -- as opposed to the
 * immutable `UnitType` ("what a Merman Fighter is").
 *
 * Deliberately NOT ported (display/animation-coupled -- see `units/
 * udisplay.cpp`, `units/drawer.cpp`, `units/animation.cpp`, `units/
 * animation_component.*`, and anything in unit.cpp that reaches into
 * `display.hpp`/`resources::screen`):
 *  - `anim_comp_` (the `unit_animation_component`), `set_standing`,
 *    `refresh`, halo/ellipse/image fields, `getsHit`/redraw scheduling.
 *  - `hidden_`/`invisible()`'s *rendering* half (fade/ghosting) -- the
 *    *rule* half (fog/shroud/ability-based invisibility affecting combat
 *    and visibility queries) is kept, see `isVisibleToTeam` below, but
 *    matches upstream's simplified form since ability evaluation
 *    (`hides`-type abilities) isn't ported yet either (abilities are raw
 *    data throughout this port, per `UnitType`'s doc comment).
 *  - `[event]`/`[abilities][*][event]`/`[attack][specials][*][event]`
 *    extraction and the AI micro_ai/candidate_action wiring `unit::init`
 *    does inline -- these belong to the WML event pump (Phase 2), not the
 *    data model.
 *  - Full `[modifications]`/`[effect]` application (trait and item stat
 *    bonuses, e.g. "resilient" adding max HP): applying an `[effect]`
 *    requires the same effects/WFL machinery as ability evaluation, which
 *    is out of scope for Phase 1. `Unit.fromConfig`/`Unit.recruit` record
 *    the modification configs verbatim (`modifications`) and the
 *    unit_type's *unmodified* base stats, matching upstream's state right
 *    after `advance_to()` but *before* `apply_modifications()` runs. This
 *    is flagged clearly rather than silently wrong: a freshly-built `Unit`
 *    here has its listed traits' *names* but not their numeric effects.
 *  - AMLA (after-max-level-advancement, `[advancement]` past the normal
 *    `advances_to` list) and multi-step advancement chains needing
 *    `get_modification_advances()`: `advances()`/`advanceTo()` here only
 *    implement plain `advances_to=` leveling.
 */

import type { TString } from '../i18n/tstring.js';
import { WmlConfig } from '../wml/config.js';
import { Location, Direction, parseDirection } from './Location.js';
import type { TerrainCode } from './Terrain.js';
import { AttackType, UnitType, type Alignment, type RegistryEntry } from './UnitType.js';
import type { MoveType } from './MoveType.js';
import { applyModificationEffects, type EffectEnv } from './effects.js';

/** Built-in status/state ids, ported verbatim from `unit::known_boolean_state_names_`. */
export const UnitStatus = {
  Slowed: 'slowed',
  Poisoned: 'poisoned',
  Petrified: 'petrified',
  Uncovered: 'uncovered',
  NotMoved: 'not_moved',
  Unhealable: 'unhealable',
  Guardian: 'guardian',
  Invulnerable: 'invulnerable',
} as const;

/** A `[modifications]` entry's identity (trait/object/advancement), kept as raw data -- see module doc comment. */
export interface UnitModification {
  readonly kind: string; // "trait", "object", "advancement", ...
  readonly cfg: WmlConfig;
}

export interface UnitOptions {
  id?: string;
  /** The unit's name; a `TString` when the WML wrote it `_ "..."`, so it follows the language. */
  name?: string | TString;
  facing?: Direction;
  canRecruit?: boolean;
  role?: string;
  hidden?: boolean;
  underlyingId?: number;
  modifications?: readonly UnitModification[];
  variables?: WmlConfig;
  profile?: string;
  /** `gender=`; defaults to the type's first gender. */
  gender?: string;
  /** `variation=`: which of the type's `[variation]`s this unit is (the Walking Corpse's `swimmer`). */
  variation?: string;
  /** `[game_config] experience_modifier` percentage the unit's XP threshold is scaled by. */
  experienceModifier?: number;
  /** Where the modifications' `[effect]`s resolve filters and types (see `EffectEnv`). */
  effectEnv?: EffectEnv;
}

let abilitiesEpoch = 0;

/** Counts every change to any unit's ability list, so a cache over abilities (`illumination.ts`) knows when it is stale. */
export function currentAbilitiesEpoch(): number {
  return abilitiesEpoch;
}

/**
 * A live unit instance on (or off, e.g. on a recall list) the board.
 * Mirrors `unit`'s non-display state.
 */
export class Unit {
  type: UnitType;
  side: number;
  location: Location;
  hitpoints: number;
  maxHitpoints: number;
  experience: number;
  maxExperience: number;
  /** Current moves remaining this turn (mirrors the confusingly-named `unit::movement_`). */
  movesLeft: number;
  /** This unit's total movement allowance (mirrors `unit::max_movement_`, i.e. `total_movement()`). */
  maxMoves: number;
  attacksLeft: number;
  maxAttacksPerTurn: number;
  level: number;
  facing: Direction;
  canRecruit: boolean;
  resting: boolean;
  hidden: boolean;
  id: string;
  role: string;
  underlyingId: number;
  /** Weapons currently in effect (defaults to `type.attacks`; an override list may replace them). */
  attacks: readonly AttackType[];
  modifications: readonly UnitModification[];
  /** Free-form WML status flags (`slowed`, `poisoned`, ..., plus any ability/scenario-defined string). */
  readonly statuses: Set<string>;
  /** Arbitrary WML variable bag (`[variables]` child), opaque to the core model. */
  variables: WmlConfig | undefined;
  /**
   * Mirrors `unit::get_goto()`/`set_goto()` (`goto_x=`/`goto_y=` in WML): a
   * pending destination a `[move_unit_fake]`-adjacent mechanism or (from
   * Phase 29 onward) the AI's `goto` candidate action wants this unit to
   * walk toward across however many turns it takes, cleared once reached.
   * `undefined` means "no pending goto", matching upstream's off-board
   * sentinel location.
   */
  goto: Location | undefined;
  /**
   * Mirrors `unit::get_interrupted_move()`: where the unit's last move was
   * headed when sighting other units stopped it, for "Continue Move"
   * (`menu_handler::continue_move`). Cleared at the end of its side's turn,
   * and not saved (upstream doesn't write it either).
   */
  interruptedMove: Location | undefined;
  /** `[unit] profile=`: this unit's own portrait, overriding its type's; empty when not overridden. */
  profile: string;
  /** `[unit] gender=` (`unit::gender_`): `male` or `female`. */
  gender: string;

  // --- Phase 18c: what a unit takes from its type, then its modifications change ---
  /** The type before any variation (`type.variation(variation)` is `type`). */
  baseType: UnitType;
  /** `variation=`: the `[variation]` in effect, `''` for none. */
  variation: string;
  /** Movement costs, defense and resistances, after `[effect]`s. */
  moveType: MoveType;
  /** Abilities, after `new_ability`/`remove_ability` effects. Replaced, never edited in place: see `abilitiesEpoch`. */
  get abilities(): readonly RegistryEntry[] {
    return this.abilityList;
  }
  set abilities(list: readonly RegistryEntry[]) {
    this.abilityList = list;
    abilitiesEpoch++;
  }
  private abilityList: readonly RegistryEntry[] = [];
  alignment: Alignment;
  /** `unit::emit_zoc_`. */
  emitZoc: boolean;
  /** Vision range; negative means "same as `maxMoves`" (upstream's `vision_ < 0`). */
  vision: number;
  jamming: number;
  advancesTo: readonly string[];
  /** AMLA/advancement options (`[advancement]`). */
  advancements: readonly WmlConfig[];
  /** The fearless trait's effect: no penalty from an unfavourable time of day. */
  fearless: boolean;
  /** The healthy trait's effect: always rests-heals, and poison cannot kill it past 1 HP. */
  healthy: boolean;
  /** `full` (the unit's level), `loyal` (none) or a number. */
  upkeep: string;
  /** `recall_cost=`, -1 for the side's default. */
  recallCost: number;
  imageMods: string;
  overlays: readonly string[];
  halo: string;
  ellipse: string;
  /** `[game_config] experience_modifier` the XP threshold was computed with. */
  experienceModifier: number;

  private constructor(type: UnitType, side: number, location: Location, options: UnitOptions) {
    this.baseType = type;
    this.type = type.variation(options.variation ?? '');
    // advance_to: `variation_ = new_type.variation_id()` -- an unknown or
    // `none` variation is no variation at all.
    this.variation = this.type.variationId;
    this.side = side;
    this.location = location;
    this.experienceModifier = options.experienceModifier ?? 100;
    // Placeholders, all overwritten by resetFromType below.
    this.hitpoints = 0;
    this.maxHitpoints = 0;
    this.experience = 0;
    this.maxExperience = 0;
    this.movesLeft = 0;
    this.maxMoves = 0;
    this.attacksLeft = 0;
    this.maxAttacksPerTurn = 0;
    this.level = 0;
    this.moveType = type.moveType;
    this.abilities = [];
    this.alignment = type.alignment;
    this.emitZoc = true;
    this.vision = -1;
    this.jamming = 0;
    this.advancesTo = [];
    this.advancements = [];
    this.fearless = false;
    this.healthy = false;
    this.upkeep = 'full';
    this.recallCost = -1;
    this.imageMods = '';
    this.overlays = [];
    this.halo = '';
    this.ellipse = '';
    this.attacks = [];
    this.facing = options.facing ?? Direction.Indeterminate;
    this.canRecruit = options.canRecruit ?? false;
    this.resting = false;
    this.hidden = options.hidden ?? false;
    this.id = options.id ?? '';
    const givenName = options.name ?? '';
    if (typeof givenName === 'string') this.nameText = givenName;
    else {
      this.nameText = givenName.baseStr();
      this.nameT = givenName.translatable ? givenName : undefined;
    }
    this.role = options.role ?? '';
    this.underlyingId = options.underlyingId ?? 0;
    this.modifications = options.modifications ?? [];
    this.statuses = new Set();
    this.variables = options.variables;
    this.goto = undefined;
    this.interruptedMove = undefined;
    this.profile = options.profile ?? '';
    this.gender = options.gender ?? type.genders[0] ?? 'male';
    // `unit::init`: the type's stats, then every modification's effects,
    // then a new unit starts full (`movement_ = max_movement_` and friends).
    this.resetFromType(this.type);
    this.applyModifications(options.effectEnv ?? {});
    this.hitpoints = this.maxHitpoints;
    this.movesLeft = this.maxMoves;
    this.attacksLeft = this.maxAttacksPerTurn;
  }

  /**
   * The scalar half of `unit::advance_to`: every stat a unit takes from its
   * type, reset to `type`'s -- before the unit's modifications are applied
   * again on top (`applyModifications`). Leaves hitpoints, moves, attacks
   * left, experience and statuses alone; `advanceTo` restores those.
   */
  resetFromType(type: UnitType): void {
    this.type = type;
    this.fearless = false;
    this.healthy = false;
    this.imageMods = '';
    this.overlays = [];
    this.ellipse = type.ellipse;
    this.halo = type.halo;
    this.abilities = [...type.abilities];
    this.advancements = [...type.advancements];
    this.advancesTo = [...type.advancesTo];
    this.maxExperience = type.experienceNeeded(this.experienceModifier);
    this.level = type.level;
    this.recallCost = type.recallCost;
    this.alignment = type.alignment;
    this.maxHitpoints = type.hitpoints;
    this.maxMoves = type.movement;
    this.vision = type.hasExplicitVision ? type.vision : -1;
    this.jamming = type.jamming;
    this.moveType = type.moveType;
    this.emitZoc = type.zoc;
    this.attacks = [...type.attacks];
    this.maxAttacksPerTurn = type.maxAttacksPerTurn;
    this.upkeep = type.upkeep;
  }

  /**
   * `unit::apply_modifications`: every modification's `[effect]`s, in order,
   * with `no_add` semantics (`apply_to=type`/`variation` skipped).
   */
  applyModifications(env: EffectEnv = {}): void {
    for (const mod of this.modifications) applyModificationEffects(this, mod.cfg, true, env);
  }

  /**
   * `unit::add_modification` for a new modification (an `[object]`, an
   * advancement, a trait added later): recorded, then its effects applied to
   * the unit as it stands.
   */
  addModification(kind: string, cfg: WmlConfig, env: EffectEnv = {}): void {
    this.modifications = [...this.modifications, { kind, cfg }];
    applyModificationEffects(this, cfg, false, env);
  }

  /**
   * Rebuilds the unit from its type and modifications, keeping its current
   * hitpoints, moves, attacks and experience (clamped to the new maximums)
   * -- what upstream does after removing an `[object]` or a trait.
   */
  rebuild(env: EffectEnv = {}): void {
    this.advanceTo(this.baseType, env);
  }

  /**
   * `unit::expire_modifications(duration)`: drops every modification whose
   * `duration=` matches -- `''` means every temporary one (anything but
   * `forever` or unset), otherwise exactly that value (`turn`, `turn end`,
   * `scenario`, `now`) -- then rebuilds the unit from its type, or from a
   * removed modification's `prev_type=` (an `apply_to=type` object reverting).
   */
  expireModifications(duration: string, env: EffectEnv = {}): void {
    const matches = (mod: UnitModification) => {
      const d = mod.cfg.getString('duration', '');
      return duration === '' ? d !== '' && d !== 'forever' : d === duration;
    };
    const expiring = this.modifications.filter(matches);
    if (expiring.length === 0) return;
    let rebuildFrom: UnitType = this.baseType;
    for (const mod of expiring) {
      const prev = mod.cfg.getString('prev_type', '');
      if (prev !== '' && env.resolveType) {
        try {
          rebuildFrom = env.resolveType(prev);
        } catch {
          /* unknown type: keep the current one */
        }
      }
    }
    this.modifications = this.modifications.filter((m) => !matches(m));
    this.advanceTo(rebuildFrom, env);
  }

  /**
   * `wesnoth.units.remove_modifications(unit, filter, kinds)`: every
   * modification of the given kinds (default `object`) whose attributes
   * include all of `filter`'s is removed, and the unit rebuilt
   * (`[remove_object] object_id=`, `[remove_trait] trait_id=`).
   */
  removeModifications(filter: Readonly<Record<string, string>>, kinds: readonly string[] = ['object'], env: EffectEnv = {}): void {
    const hit = (mod: UnitModification) =>
      kinds.includes(mod.kind) && Object.entries(filter).every(([k, v]) => mod.cfg.getString(k, '') === v);
    if (!this.modifications.some(hit)) return;
    this.modifications = this.modifications.map((m) => (hit(m) ? { kind: m.kind, cfg: m.cfg.clone().setAttribute('duration', 'now') } : m));
    this.expireModifications('now', env);
  }

  /** `unit::new_turn`: `duration=turn` modifications expire; moves and attacks refill; an ambusher can hide again. */
  newTurn(env: EffectEnv = {}): void {
    this.expireModifications('turn', env);
    this.movesLeft = this.maxMoves;
    this.attacksLeft = this.maxAttacksPerTurn;
    this.setStatus(UnitStatus.Uncovered, false);
  }

  /** `unit::end_turn` (at the end of the unit's own side's turn): `duration=turn end` modifications expire, slow wears off, and an interrupted move is forgotten. */
  endTurn(env: EffectEnv = {}): void {
    this.expireModifications('turn end', env);
    this.setStatus(UnitStatus.Slowed, false);
    this.interruptedMove = undefined;
  }

  /** `unit::move_interrupted()`: a move stopped by sighting units can be continued (it has moves left). */
  get moveInterrupted(): boolean {
    return this.movesLeft > 0 && this.interruptedMove !== undefined;
  }

  /**
   * `unit::new_scenario`: a unit carried into the next scenario loses its
   * `goto`, every temporary modification, and its damage and afflictions.
   */
  newScenario(env: EffectEnv = {}): void {
    this.goto = undefined;
    this.expireModifications('', env);
    this.healToFull();
    this.setStatus(UnitStatus.Slowed, false);
    this.setStatus(UnitStatus.Poisoned, false);
    this.setStatus(UnitStatus.Petrified, false);
    this.setStatus(UnitStatus.Guardian, false);
  }

  /** Must-have traits of the current type the unit lacks (`generate_traits(must_have_only=true)`). */
  private addMustHaveTraits(): void {
    const have = new Set(this.modifications.filter((m) => m.kind === 'trait').map((m) => m.cfg.getString('id')));
    const add = this.type.possibleTraits.filter((t) => t.getString('availability', '') === 'musthave' && !have.has(t.getString('id')));
    if (add.length > 0) this.modifications = [...this.modifications, ...add.map((cfg) => ({ kind: 'trait', cfg }))];
  }

  /**
   * The portrait `[message]` shows for this unit -- Lua's `unit.portrait`
   * (`lua_unit.cpp`) over `unit::big_profile()`: its own `profile=`, else
   * its current type's, unless empty or `unit_image`; otherwise the unit's
   * image scaled to 144x144. (Upstream appends the unit's team-colour image
   * mods to that fallback; they are left to the renderer here.)
   */
  portrait(): string {
    const profile = this.profile || this.type.profile;
    if (profile !== '' && profile !== 'unit_image') return profile;
    return this.type.image === '' ? '' : `${this.type.image}~SCALE_SHARP(144,144)`;
  }

  /** A fresh unit of `type`, as if just recruited/created (mirrors `advance_to` applied to a new unit). */
  static create(type: UnitType, side: number, location: Location, options: UnitOptions = {}): Unit {
    return new Unit(type, side, location, options);
  }

  /**
   * Builds a Unit from a `[unit]`/`[recall]` config, applying the overrides
   * `unit::init`/the post-`advance_to` section of the constructor apply on
   * top of the base type (hitpoints, experience, moves, resting,
   * attacks_left, facing, canrecruit, hidden, level, max_hitpoints,
   * max_moves, max_experience, status flags). `resolveType` looks up a
   * `UnitType` by its WML `type=`/`parent_type=` id (a scenario-level unit
   * registry, since the config alone only carries the id string).
   */
  static fromConfig(cfg: WmlConfig, resolveType: (id: string) => UnitType, experienceModifierPercent = 100): Unit {
    const typeId = cfg.hasAttribute('parent_type') ? cfg.getString('parent_type') : cfg.getString('type');
    const type = resolveType(typeId);
    const side = Math.max(1, cfg.getNumber('side', 1));
    const location = Location.fromConfig(cfg);

    const modifications: UnitModification[] = [];
    for (const modsCfg of cfg.children('modifications')) {
      for (const { tag, config } of modsCfg.allChildren()) {
        modifications.push({ kind: tag, cfg: config });
      }
    }

    const unit = new Unit(type, side, location, {
      id: cfg.getString('id', ''),
      name: cfg.isTranslatable('name') ? cfg.getTString('name') : cfg.getString('name', ''),
      role: cfg.getString('role', ''),
      canRecruit: cfg.getBoolean('canrecruit', false),
      hidden: cfg.getBoolean('hidden', false),
      underlyingId: cfg.getNumber('underlying_id', 0),
      modifications,
      variables: cfg.child('variables'),
      profile: cfg.getString('profile', ''),
      ...(cfg.hasAttribute('gender') ? { gender: cfg.getString('gender') } : {}),
      variation: cfg.getString('variation', ''),
      experienceModifier: experienceModifierPercent,
    });

    // Overrides applied on top of the base type, mirroring unit::init/unit's constructor tail.
    if (cfg.hasAttribute('max_hitpoints')) unit.maxHitpoints = Math.max(1, cfg.getNumber('max_hitpoints'));
    if (cfg.hasAttribute('max_moves')) unit.maxMoves = Math.max(0, cfg.getNumber('max_moves'));
    if (cfg.hasAttribute('max_experience')) unit.maxExperience = Math.max(1, cfg.getNumber('max_experience'));
    if (cfg.hasAttribute('level')) unit.level = cfg.getNumber('level');
    if (cfg.hasAttribute('max_attacks')) unit.maxAttacksPerTurn = Math.max(0, cfg.getNumber('max_attacks'));
    if (cfg.hasChild('attack')) unit.attacks = cfg.children('attack').map((a) => AttackType.fromConfig(a));

    unit.attacksLeft = Math.max(0, cfg.getNumber('attacks_left', unit.maxAttacksPerTurn));
    unit.movesLeft = Math.max(0, cfg.getNumber('moves', unit.maxMoves));
    unit.hitpoints = cfg.getNumber('hitpoints', unit.maxHitpoints);
    unit.experience = cfg.getNumber('experience', 0);
    unit.resting = cfg.getBoolean('resting', false);
    if (cfg.hasAttribute('ellipse')) unit.ellipse = cfg.getString('ellipse');

    const facing = parseDirection(cfg.getString('facing', ''));
    unit.facing = facing; // upstream falls back to a *random* facing; left Indeterminate here (a rendering concern -- see module doc comment on what's display-only).

    const statusCfg = cfg.child('status');
    if (statusCfg) {
      for (const key of statusCfg.attributeNames()) {
        if (!statusCfg.getBoolean(key)) continue;
        // `not_living` is upstream's legacy alias (`unit::set_state`): it
        // stands for the three statuses below and is never kept itself --
        // `get_states` only writes it back when all three are set.
        if (key === 'not_living') for (const s of ['undrainable', 'unpoisonable', 'unplagueable']) unit.statuses.add(s);
        else unit.statuses.add(key);
      }
    }
    if (cfg.getString('ai_special', '') === 'guardian') unit.statuses.add(UnitStatus.Guardian);
    if (cfg.hasAttribute('invulnerable') && cfg.getBoolean('invulnerable')) {
      unit.statuses.add(UnitStatus.Invulnerable);
    }
    if (cfg.hasAttribute('goto_x') && cfg.hasAttribute('goto_y')) {
      const gotoLoc = Location.fromWml(cfg.getNumber('goto_x'), cfg.getNumber('goto_y'));
      if (gotoLoc.valid()) unit.goto = gotoLoc;
    }

    return unit;
  }

  /**
   * Serializes this unit into a `[unit]`-shaped `WmlConfig` -- the dual of
   * `Unit.fromConfig` (every attribute written here is one `fromConfig`
   * reads back), covering the same field set `unitToVarNode`
   * (`events/actionWml.ts`, for `[store_unit]`) writes plus the fields that
   * matter for Phase 29's AI/Lua bridge (`goto_x`/`goto_y`, `attacks_left`,
   * `status`, `ai_special`) that `unitToVarNode` doesn't need. Used for
   * `unit.__cfg` in the Lua host API and for persisting AI-visible unit
   * state (e.g. a pending `goto`) across save/load. Does NOT serialize
   * `modifications` (same known gap `unitToVarNode`/`actionUnstoreUnit`
   * document) or attack overrides beyond the base type's weapons.
   */
  toConfig(): WmlConfig {
    const cfg = new WmlConfig();
    cfg.setAttribute('type', this.type.id);
    cfg.setAttribute('id', this.id);
    cfg.setAttribute('name', this.nameT ?? this.nameText);
    cfg.setAttribute('role', this.role);
    cfg.setAttribute('side', this.side);
    if (this.location.valid()) {
      cfg.setAttribute('x', this.location.wmlX);
      cfg.setAttribute('y', this.location.wmlY);
    } else {
      cfg.setAttribute('x', 'recall');
      cfg.setAttribute('y', 'recall');
    }
    cfg.setAttribute('hitpoints', this.hitpoints);
    cfg.setAttribute('max_hitpoints', this.maxHitpoints);
    cfg.setAttribute('moves', this.movesLeft);
    cfg.setAttribute('max_moves', this.maxMoves);
    cfg.setAttribute('attacks_left', this.attacksLeft);
    cfg.setAttribute('max_attacks', this.maxAttacksPerTurn);
    cfg.setAttribute('experience', this.experience);
    cfg.setAttribute('max_experience', this.maxExperience);
    cfg.setAttribute('level', this.level);
    cfg.setAttribute('canrecruit', this.canRecruit);
    cfg.setAttribute('resting', this.resting);
    cfg.setAttribute('hidden', this.hidden);
    cfg.setAttribute('underlying_id', this.underlyingId);
    if (this.profile !== '') cfg.setAttribute('profile', this.profile);
    if (this.ellipse !== '') cfg.setAttribute('ellipse', this.ellipse);
    cfg.setAttribute('gender', this.gender);
    if (this.variation !== '') cfg.setAttribute('variation', this.variation);
    if (this.guardian) cfg.setAttribute('ai_special', 'guardian');
    if (this.goto) {
      cfg.setAttribute('goto_x', this.goto.wmlX);
      cfg.setAttribute('goto_y', this.goto.wmlY);
    }
    if (this.statuses.size > 0) {
      const statusCfg = cfg.addChild('status');
      for (const s of this.statuses) statusCfg.setAttribute(s, true);
    }
    if (this.variables) {
      cfg.addChild('variables', this.variables);
    }
    return cfg;
  }

  // --- status flags ---

  hasStatus(status: string): boolean {
    return this.statuses.has(status);
  }
  setStatus(status: string, value: boolean): void {
    if (value) this.statuses.add(status);
    else this.statuses.delete(status);
  }
  get slowed(): boolean {
    return this.hasStatus(UnitStatus.Slowed);
  }
  get poisoned(): boolean {
    return this.hasStatus(UnitStatus.Poisoned);
  }
  get petrified(): boolean {
    return this.hasStatus(UnitStatus.Petrified);
  }
  get guardian(): boolean {
    return this.hasStatus(UnitStatus.Guardian);
  }
  get invulnerable(): boolean {
    return this.hasStatus(UnitStatus.Invulnerable);
  }
  /** Mirrors `unit::incapacitated()`: petrified or stone-like states prevent acting. */
  get incapacitated(): boolean {
    return this.petrified;
  }

  private nameText = '';
  private nameT: TString | undefined;

  /** The unit's name, in the current language while it is still the translatable one from WML. */
  get name(): string {
    return this.nameT ? this.nameT.str() : this.nameText;
  }

  /** A rename (or `[modify_unit] name=`) replaces the WML name with plain text. */
  set name(value: string) {
    this.nameText = value;
    this.nameT = undefined;
  }

  /** The name as a `TString`, when it is still translatable. */
  get translatableName(): TString | undefined {
    return this.nameT;
  }

  /** Mirrors `unit::loyal()` (`upkeep_ == upkeep_loyal`): the loyal trait's `[effect] apply_to=loyal`, or `upkeep=loyal`. */
  get loyal(): boolean {
    return this.upkeep === 'loyal';
  }

  /**
   * Display names of this unit's `[trait]` modifications (e.g. "strong",
   * "intelligent") -- real, reported bug: there was no way to see whether a
   * unit had any traits at all, or what they were. See `UnitType`'s module
   * doc comment for how `modifications` gets `kind: 'trait'` entries in the
   * first place (`actions/recruit.ts`'s `generateTraits`, for freshly
   * recruited units) and this file's own module doc comment for why a
   * trait's numeric `[effect]`s still don't apply to anything.
   */
  get traitNames(): readonly string[] {
    return this.modifications
      .filter((m) => m.kind === 'trait')
      .map((m) => m.cfg.getString('male_name', m.cfg.getString('name', m.cfg.getString('id'))));
  }

  // --- XP / leveling (mirrors unit::experience_to_advance/advances/advance_to) ---

  experienceToAdvance(): number {
    return Math.max(0, this.maxExperience - this.experience);
  }

  experienceOverflow(): number {
    return Math.max(0, this.experience - this.maxExperience);
  }

  /** `unit::advances()`: enough XP, and somewhere to go -- a type in `advancesTo`, or an AMLA (`modificationAdvances`). */
  advances(): boolean {
    return this.experience >= this.maxExperience && (this.advancesTo.length > 0 || this.modificationAdvances().length > 0);
  }

  /** How many modifications of `kind` with `id=` this unit has (`unit::modification_count`). */
  modificationCount(kind: string, id: string): number {
    return this.modifications.filter((m) => m.kind === kind && m.cfg.getString('id', '') === id).length;
  }

  /**
   * `unit::get_modification_advances`: the `[advancement]`s (AMLAs) this
   * unit can take now -- not `strict_amla=yes` ones while it still has
   * types to advance to, not ones already taken `max_times=` (default 1;
   * negative is unlimited), and only if `require_amla=`/`exclude_amla=`
   * (counted lists of AMLA ids) allow it. `[filter]` is not evaluated.
   */
  modificationAdvances(): WmlConfig[] {
    const out: WmlConfig[] = [];
    for (const adv of this.advancements) {
      if (adv.getBoolean('strict_amla', false) && this.advancesTo.length > 0) continue;
      const maxTimes = adv.getNumber('max_times', 1);
      if (maxTimes >= 0 && this.modificationCount('advancement', adv.getString('id', '')) >= maxTimes) continue;
      const counted = (list: string) => {
        const counts = new Map<string, number>();
        for (const id of list.split(',').map((v) => v.trim()).filter((v) => v !== '')) counts.set(id, (counts.get(id) ?? 0) + 1);
        return counts;
      };
      const exclude = counted(adv.getString('exclude_amla', ''));
      if ([...exclude].some(([id, n]) => this.modificationCount('advancement', id) >= n)) continue;
      const require = counted(adv.getString('require_amla', ''));
      if ([...require].some(([id, n]) => this.modificationCount('advancement', id) < n)) continue;
      out.push(adv);
    }
    return out;
  }

  /**
   * `unit::advance_to(newType)`: the unit becomes `newType` (in its current
   * variation), every type-derived stat is reset and every modification
   * re-applied, then hitpoints, moves and attacks left come back clamped
   * to the new maximums and experience, slow and poison come back as they
   * were (`stats_storage_resetter`). Advancing a unit a level is this plus
   * a full heal and XP overflow (`advancement.ts`'s `advanceUnitTo`).
   */
  advanceTo(newType: UnitType, env: EffectEnv = {}): void {
    const hitpoints = this.hitpoints;
    const moves = this.movesLeft;
    const attacks = this.attacksLeft;
    const experience = this.experience;
    const slowed = this.slowed;
    const poisoned = this.poisoned;
    this.baseType = newType;
    const type = newType.variation(this.variation);
    this.variation = type.variationId;
    this.resetFromType(type);
    this.addMustHaveTraits();
    this.applyModifications(env);
    this.movesLeft = Math.min(this.maxMoves, moves);
    this.hitpoints = Math.min(this.maxHitpoints, hitpoints);
    this.attacksLeft = Math.min(this.maxAttacksPerTurn, attacks);
    this.experience = experience;
    this.setStatus(UnitStatus.Slowed, slowed && !this.hasStatus('unslowable'));
    this.setStatus(UnitStatus.Poisoned, poisoned && !this.hasStatus('unpoisonable'));
    if (this.hasStatus('unpetrifiable')) this.setStatus(UnitStatus.Petrified, false);
  }

  /** `unit::upkeep()`: what this unit costs its side each turn -- nothing for a leader or a loyal unit. */
  get upkeepCost(): number {
    if (this.canRecruit || this.upkeep === 'loyal') return 0;
    if (this.upkeep === 'full' || this.upkeep === '') return this.level;
    const n = Number.parseInt(this.upkeep, 10);
    return Number.isNaN(n) ? this.level : n;
  }

  /** The vision range in movement points (`unit::vision()`: movement when not set separately). */
  get visionRange(): number {
    return this.vision < 0 ? this.maxMoves : this.vision;
  }

  // --- terrain-dependent stats (delegates to the unit_type's MoveType; no trait/effect modifiers applied) ---

  movementCost(terrain: TerrainCode): number {
    return this.moveType.movementCost(terrain, this.slowed);
  }
  defenseModifier(terrain: TerrainCode): number {
    return this.moveType.defenseModifier(terrain);
  }
  resistanceAgainst(damageType: string): number {
    return this.moveType.resistanceAgainst(damageType);
  }
  isFlying(): boolean {
    return this.moveType.flying;
  }

  /** Mirrors `unit::take_hit`: applies damage, returns true if this kills the unit. */
  takeHit(damage: number): boolean {
    this.hitpoints -= damage;
    return this.hitpoints <= 0;
  }

  healToFull(): void {
    this.hitpoints = this.maxHitpoints;
  }

  /**
   * Mirrors `unit::is_visible_to_team` in simplified form: allies (and the
   * viewer's own side) always see it; `seeAll` (an observer/debug view)
   * bypasses all checks; otherwise hidden units are invisible to
   * non-allies. Fog/shroud (per-team, per-hex) and `hides`-type ability
   * evaluation are NOT implemented here -- both need machinery (a
   * `Team`-owned shroud bitmap; WFL/ability evaluation) out of scope for
   * this port. Callers needing full fog-of-war visibility must layer that
   * on top.
   */
  isVisibleToTeam(viewingSide: number, isAlly: (a: number, b: number) => boolean, seeAll = false): boolean {
    if (seeAll) return true;
    if (viewingSide === this.side || isAlly(viewingSide, this.side)) return true;
    return !this.hidden;
  }
}
