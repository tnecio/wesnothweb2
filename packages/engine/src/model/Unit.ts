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

import type { WmlConfig } from '../wml/config.js';
import { Location, Direction, parseDirection } from './Location.js';
import type { TerrainCode } from './Terrain.js';
import { AttackType, UnitType } from './UnitType.js';

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
  name?: string;
  facing?: Direction;
  canRecruit?: boolean;
  role?: string;
  hidden?: boolean;
  underlyingId?: number;
  modifications?: readonly UnitModification[];
  variables?: WmlConfig;
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
  name: string;
  role: string;
  underlyingId: number;
  /** Weapons currently in effect (defaults to `type.attacks`; an override list may replace them). */
  attacks: readonly AttackType[];
  modifications: readonly UnitModification[];
  /** Free-form WML status flags (`slowed`, `poisoned`, ..., plus any ability/scenario-defined string). */
  readonly statuses: Set<string>;
  /** Arbitrary WML variable bag (`[variables]` child), opaque to the core model. */
  variables: WmlConfig | undefined;

  private constructor(type: UnitType, side: number, location: Location, options: UnitOptions) {
    this.type = type;
    this.side = side;
    this.location = location;
    this.hitpoints = type.hitpoints;
    this.maxHitpoints = type.hitpoints;
    this.experience = 0;
    this.maxExperience = type.experienceNeeded();
    this.movesLeft = type.movement;
    this.maxMoves = type.movement;
    this.attacksLeft = type.maxAttacksPerTurn;
    this.maxAttacksPerTurn = type.maxAttacksPerTurn;
    this.level = type.level;
    this.facing = options.facing ?? Direction.Indeterminate;
    this.canRecruit = options.canRecruit ?? false;
    this.resting = false;
    this.hidden = options.hidden ?? false;
    this.id = options.id ?? '';
    this.name = options.name ?? '';
    this.role = options.role ?? '';
    this.underlyingId = options.underlyingId ?? 0;
    this.attacks = type.attacks;
    this.modifications = options.modifications ?? [];
    this.statuses = new Set();
    this.variables = options.variables;
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
      name: cfg.getString('name', ''),
      role: cfg.getString('role', ''),
      canRecruit: cfg.getBoolean('canrecruit', false),
      hidden: cfg.getBoolean('hidden', false),
      underlyingId: cfg.getNumber('underlying_id', 0),
      modifications,
      variables: cfg.child('variables'),
    });

    // Overrides applied on top of the base type, mirroring unit::init/unit's constructor tail.
    if (cfg.hasAttribute('max_hitpoints')) unit.maxHitpoints = Math.max(1, cfg.getNumber('max_hitpoints'));
    if (cfg.hasAttribute('max_moves')) unit.maxMoves = Math.max(0, cfg.getNumber('max_moves'));
    if (cfg.hasAttribute('max_experience')) unit.maxExperience = Math.max(1, cfg.getNumber('max_experience'));
    else unit.maxExperience = type.experienceNeeded(experienceModifierPercent);
    if (cfg.hasAttribute('level')) unit.level = cfg.getNumber('level');
    if (cfg.hasAttribute('max_attacks')) unit.maxAttacksPerTurn = Math.max(0, cfg.getNumber('max_attacks'));
    if (cfg.hasChild('attack')) unit.attacks = cfg.children('attack').map((a) => AttackType.fromConfig(a));

    unit.attacksLeft = Math.max(0, cfg.getNumber('attacks_left', unit.maxAttacksPerTurn));
    unit.movesLeft = Math.max(0, cfg.getNumber('moves', unit.maxMoves));
    unit.hitpoints = cfg.getNumber('hitpoints', unit.maxHitpoints);
    unit.experience = cfg.getNumber('experience', 0);
    unit.resting = cfg.getBoolean('resting', false);

    const facing = parseDirection(cfg.getString('facing', ''));
    unit.facing = facing; // upstream falls back to a *random* facing; left Indeterminate here (a rendering concern -- see module doc comment on what's display-only).

    const statusCfg = cfg.child('status');
    if (statusCfg) {
      for (const key of statusCfg.attributeNames()) {
        if (statusCfg.getBoolean(key)) unit.statuses.add(key);
      }
    }
    if (cfg.getString('ai_special', '') === 'guardian') unit.statuses.add(UnitStatus.Guardian);
    if (cfg.hasAttribute('invulnerable') && cfg.getBoolean('invulnerable')) {
      unit.statuses.add(UnitStatus.Invulnerable);
    }

    return unit;
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

  /**
   * Mirrors `unit::loyal()` (`upkeep_ == upkeep_loyal`): true when a real
   * `[trait] id=loyal` (e.g. the `{TRAIT_LOYAL}` macro, `wesnoth/data/core/
   * macros/traits.cfg`) is among this unit's `modifications`. This project
   * doesn't apply `[effect]`s generically (see this file's module doc
   * comment), so unlike upstream this doesn't actually zero the unit's
   * upkeep anywhere -- it's read only for the real loyal-icon overlay
   * (`GameSession.renderUnits` -> `SnapshotUnit.loyal` ->
   * `SnapshotBoard`'s `misc/loyal-icon.png`).
   */
  get loyal(): boolean {
    return this.modifications.some((m) => m.kind === 'trait' && m.cfg.getString('id') === 'loyal');
  }

  // --- XP / leveling (mirrors unit::experience_to_advance/advances/advance_to) ---

  experienceToAdvance(): number {
    return Math.max(0, this.maxExperience - this.experience);
  }

  experienceOverflow(): number {
    return Math.max(0, this.experience - this.maxExperience);
  }

  /** True if this unit has enough XP AND has somewhere to advance to (plain leveling only; AMLA not ported). */
  advances(): boolean {
    return this.experience >= this.maxExperience && this.type.advancesTo.length > 0;
  }

  /**
   * Advances this unit to `newType` in place: resets HP/moves/attacks to
   * the new type's full values (matching the "advancing heals fully"
   * gameplay rule) and carries over overflow XP into the new threshold.
   * Does not apply `[effect]` modifications from traits/items -- see
   * module doc comment.
   */
  advanceTo(newType: UnitType, experienceModifierPercent = 100): void {
    const overflow = this.experienceOverflow();
    this.type = newType;
    this.level = newType.level;
    this.hitpoints = newType.hitpoints;
    this.maxHitpoints = newType.hitpoints;
    this.maxExperience = newType.experienceNeeded(experienceModifierPercent);
    this.experience = Math.min(overflow, this.maxExperience);
    this.movesLeft = newType.movement;
    this.maxMoves = newType.movement;
    this.attacksLeft = newType.maxAttacksPerTurn;
    this.maxAttacksPerTurn = newType.maxAttacksPerTurn;
    this.attacks = newType.attacks;
  }

  // --- terrain-dependent stats (delegates to the unit_type's MoveType; no trait/effect modifiers applied) ---

  movementCost(terrain: TerrainCode): number {
    return this.type.moveType.movementCost(terrain, this.slowed);
  }
  defenseModifier(terrain: TerrainCode): number {
    return this.type.moveType.defenseModifier(terrain);
  }
  resistanceAgainst(damageType: string): number {
    return this.type.moveType.resistanceAgainst(damageType);
  }
  isFlying(): boolean {
    return this.type.moveType.flying;
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
