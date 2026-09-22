/**
 * Plain (rune-free) TypeScript domain layer wrapping a live `GameBoard` for
 * one browser play session: select a unit, see where it can move/attack,
 * commit a move, preview then commit an attack, recruit, end the turn.
 * Deliberately NOT a `.svelte.ts` runes file -- see this package's Svelte
 * components (`GameShell.svelte` etc.) for the reactive wrapper around it.
 *
 * Why not runes here: `$state`/`$derived` are Svelte-compiler magic, only
 * understood by the Svelte compiler/svelte-check's language tools, not by
 * plain `tsc` (there is no ambient global .d.ts for them shipped by the
 * `svelte` package). This project's own verification requires a clean
 * `npx tsc --noEmit -p packages/ui` in addition to `svelte-check` -- see
 * docs/PROGRESS.md's note that plain `tsc` silently skips `.svelte` files
 * (it does NOT skip `.svelte.ts`, which is compiled as ordinary TS and
 * would fail on `$state` as an undefined identifier). Keeping this class
 * plain and letting the thin `.svelte` layer own the reactive glue avoids
 * that trap entirely while keeping this file's logic independently
 * testable without a Svelte runtime.
 *
 * ## Post-Phase-5 revision (playability feedback)
 *
 * This now goes beyond the original Phase 5 brief's select/move/attack
 * scope: `runStartupEvents` runs the scenario's real `prestart`/`start`
 * `[event]`s (see `runScenarioStartupEvents`), and there is a real,
 * hotseat-style turn cycle (`endTurn`) plus recruiting (`selectRecruitType`/
 * the recruit branch of `handleHexClick`). See `endTurn`'s own doc comment
 * for the hotseat-vs-single-side judgment call: with no AI (Phase 7, not
 * built), the alternative to hotseat would be a side that can never be
 * played once it's not `playerSide`'s turn, which defeats the user's
 * stated goal of testing scenario progression across turns.
 */

import {
  GameBoard,
  Location,
  Unit,
  Direction,
  parseDirection,
  writeDirection,
  getAdjacentTiles,
  reachableHexes,
  findPath,
  performMove,
  performAttack,
  isBackstabActive,
  computeLeadershipBonus,
  computeResistanceModifier,
  AiManager,
  registerAiWmlActions,
  findSideConfig,
  type AiWmlHooks,
  type AiHost,
  type AiAction,
  type AiAnimationEvent,
  type ScenarioObjectives,
  advanceUnitTo,
  type AttackBlowResult,
  type AttackResult,
  buildBattleContext,
  chooseDefenderWeaponIndex,
  simulateCombat,
  hasSpecialId,
  combatModifier,
  RngDeterministic,
  MtRng,
  gameBoardFromSnapshot,
  createTypeResolver,
  EventManager,
  EventPump,
  VariableStore,
  WmlConfig,
  resolveStory,
  type ResolvedStoryPart,
  clearShroud,
  recalculateFog,
  getVisibleUnit,
  isUnitVisibleToTeam,
  type RaiseEvent,
  connectedCastleTiles,
  recruitUnit,
  recallUnit,
  dismissUnitAt,
  unitCanAct,
  checkVictory,
  applySideHealing,
  type HealOutcome,
  computeGoldCarryover,
  findVictoryEndlevelGoldConfig,
  computeCarryoverRecruits,
  scheduleFromScenarioConfigJson,
  effectiveTimeOfDayAt,
  type Schedule,
  type ScheduleState,
  type TimeOfDayEntry,
  type GameBoardSnapshot,
  type SnapshotUnit,
  type RecordedMessage,
  type UnitType,
  type Alignment,
  type GoldCarryoverResult,
  type WmlAttributeValue,
  type WmlConfigJson,
  type AttackType,
  type RegistryEntry,
  UnitStatus,
  runActionFlow,
  runFlow,
  autoRespond,
  type ChoiceRecord,
  type Flow,
  type Interaction,
  type InteractionResult,
  type Responder,
} from '@wesnothweb2/engine';

/**
 * Phase 17: whoever can actually show a `[message]` or play a cutscene
 * beat. `GameShell` supplies one; a headless caller leaves it unset and
 * every interaction is answered by the engine's own `autoRespond`.
 *
 * The contract is deliberately one method: the session hands over one
 * `Interaction` at a time and does nothing at all until the promise
 * settles -- which is what "the event is blocked on this dialog" means
 * here, in place of the nested SDL event loop upstream runs.
 */
export interface InteractionHost {
  handle(interaction: Interaction): Promise<InteractionResult>;
}

/**
 * The scenario's real `turns=` attribute (from `scenarioConfigJson`), if it
 * set one. `WmlConfig` stores WML attribute values as string|number|boolean
 * depending on how the parser read them, so this normalizes either
 * representation. Exported so `GameShell.svelte` (the turn-banner display)
 * and `GameSession` (the gold-carryover computation, which needs the
 * *finishing* scenario's turn limit) share one implementation.
 */
export function parseScenarioTurnsLimit(raw: WmlAttributeValue | undefined): number | null {
  if (raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface HexPoint {
  x: number;
  y: number;
}

/** One currently-owned village, for the board's live ownership-flag rendering -- see `GameSession.villageOwnership`. */
export interface VillageOwnerInfo extends HexPoint {
  side: number;
}

/** Mirrors `Team.shrouded`/`fogged`'s three-state result for one hex, from `playerSide`'s perspective -- see `GameSession.hexVisibility`. */
export type HexVisibility = 'shrouded' | 'fogged' | 'clear';

export interface HexVisibilityPoint extends HexPoint {
  visibility: HexVisibility;
}

/** One hex the selected unit could move to this turn, with the real terrain defense (`100 - defenseModifier`, see `SelectedUnitInfo.defensePercent`'s own doc comment) it would have there -- real, reported bug (bugs3.md #2): the map only ever showed a hex's defense on hover, never all of a selected unit's real options at a glance. */
export interface ReachableHexPoint extends HexPoint {
  defensePercent: number;
}

/** One combatant's side of a `CombatPreview` -- feeds the side panel's combat-prediction display. */
export interface CombatantPreview {
  name: string;
  side: number;
  hp: number;
  maxHp: number;
  /** 0-100. */
  chanceToHit: number;
  damagePerBlow: number;
  numBlows: number;
  /** 0-1 probability of ending this exchange at 0 hp, from the real `simulateCombat` probability matrix. */
  deathChance: number;
  /**
   * The weapon actually in use this exchange, or `undefined` for "fights
   * back with nothing" (a defender with no range-compatible counter-weapon
   * -- see `chooseDefenderWeaponIndex`). Addresses "UI is missing
   * information about the weapon type" -- the prediction popup previously
   * showed damage/hit-chance with no indication of melee vs. ranged,
   * damage type, or specials (e.g. a player couldn't tell from the UI
   * alone why a javelin throw drew no counter-attack).
   */
  weapon?: WeaponInfo;
  /** For the attack/damage-calculation dialogs' detail pane (`AttackDialog.svelte`/`CombatSimulationDialog.svelte`) -- real Wesnoth's `unit_attack.cpp` shows all of this alongside the combat odds. */
  typeId: string;
  image: string | null;
  level: number;
  alignment: Alignment;
  raceId: string;
  traits: readonly string[];
  /**
   * `computeResistanceModifier`'s result against `weapon`'s damage type,
   * as upstream's own percentage convention (100 = normal, >100 = weak
   * to it, <100 = resistant) -- e.g. 120 means "takes 20% MORE damage",
   * matching real Wesnoth's "Wrażliwość/Odporność ×1.2"-style breakdown
   * line. `undefined` when there's no weapon in play (`weapon` above is
   * also `undefined` in that case).
   */
  resistanceModifier?: number;
  /** The weapon's raw, pre-resistance/charge/ability `damage=` value -- paired with `resistanceModifier` and `damagePerBlow` (the final, fully-modified per-blow damage) so a caller can show the same "base -> total" breakdown real Wesnoth's damage-calculation dialog does. */
  baseDamage?: number;
  /**
   * The full post-exchange HP probability distribution (`Combatant.hpDist`,
   * index = ending HP, value = probability 0-1) -- for the damage-
   * calculation dialog's "expected result" bar chart. `hpDist[hp]` (this
   * combatant's CURRENT hp, i.e. `hp` above) is the probability of ending
   * the exchange having taken no damage at all ("chance to come out
   * unscathed").
   */
  hpDist: readonly number[];
  /**
   * Real, reported bug (bugs4.md #10): the attack/damage-calculation
   * dialogs already computed a fully correct final `chanceToHit`/
   * `damagePerBlow`, but never showed WHY -- no indication of a time-of-day
   * bonus/penalty, a leadership bonus, an active charge, or WHICH weapon
   * special (`magical`/`marksman`) set the flat chance-to-hit override.
   * These mirror the exact same inputs `buildPreview` already computes and
   * feeds to `buildBattleContext` -- a display-only breakdown, no new
   * combat math.
   *
   * `lawfulBonus` is THIS COMBATANT's own actual damage modifier from the
   * current time of day -- i.e. already run through `combatModifier`
   * (alignment-aware: a chaotic unit's sign is FLIPPED from the
   * schedule's raw `lawful_bonus`, neutral is always 0, liminal is a
   * different figure entirely), NOT the schedule's raw value. Real,
   * reported bug: this used to display the raw schedule value directly,
   * so a chaotic unit in daylight showed "+25%" even though it was
   * actually taking a real 25% damage PENALTY that turn (the damage
   * number itself was always correct; only this label had the wrong
   * sign/magnitude).
   */
  lawfulBonus: number;
  /** This combatant's own active leadership-ability damage bonus (percentage points added to the multiplier), 0 if none. */
  leadershipBonus: number;
  /** Whether this exchange's `[damage] id=charge` special is active for this weapon (doubles both combatants' damage this exchange). `undefined` when there's no weapon. */
  chargeActive?: boolean;
  /**
   * Whether this blow ACTUALLY gets a real backstab bonus -- requires
   * BOTH the real geometric condition (a flanking ally-of-attacker on the
   * defender's far side) AND the attacker's own weapon having the
   * `backstab` special (real, reported bug bugs5.md #2: this used to be
   * just the geometric condition, so the badge showed even for a weapon
   * with no backstab special at all, whenever a friendly unit merely
   * happened to stand on the opposite side of the target). Always
   * `false` for a defender's retaliation -- backstab only ever applies to
   * the one currently attacking.
   */
  backstabActive: boolean;
  /** Which weapon special set `chanceToHit` to a flat override, if any (`magical` always wins over `marksman` when both are present -- mirrors `computeUnitStats`'s own precedence). `null` for an ordinary terrain-defense-based chance to hit. */
  chanceToHitSource: 'magical' | 'marksman' | null;
}

export interface CombatPreview {
  attacker: CombatantPreview;
  defender: CombatantPreview;
}

/** One real `[specials]` child (e.g. `[damage] id=backstab`) reduced to its player-facing `name=`/`description=`, for a unit-info/weapon display. Not context-evaluated (e.g. "backstab" is listed whether or not a flanker is actually present right now) -- matches real Wesnoth's own weapon-description tooltip, which lists what a weapon HAS, not what's active this instant. */
export interface WeaponSpecialInfo {
  name: string;
  description: string;
}

/** One real `[abilities]` child (e.g. `[heals]`), reduced the same way as `WeaponSpecialInfo`. */
export interface AbilityInfo {
  name: string;
  description: string;
}

/** A view-model of one of a unit's `[attack]` weapons, for the side panel/combat prediction -- addresses "UI is missing information about weapon type" (real, reported: melee/ranged and damage type were shown nowhere). */
export interface WeaponInfo {
  name: string;
  /** Damage type (e.g. "blade", "pierce", "impact", "fire", "cold", "arcane"). */
  type: string;
  /** "melee" or "ranged" (or a custom `range=` value real content occasionally defines) -- see `combatStats.ts`'s `chooseDefenderWeaponIndex` doc comment for why this label, not a hex distance, governs what can counter it. */
  range: string;
  damage: number;
  numAttacks: number;
  specials: readonly WeaponSpecialInfo[];
}

export function buildWeaponInfo(weapon: AttackType): WeaponInfo {
  return {
    name: weapon.name,
    type: weapon.type,
    range: weapon.range,
    damage: weapon.damage,
    numAttacks: weapon.numAttacks,
    specials: weapon.specials.map((cfg) => ({
      name: cfg.getString('name') || cfg.getString('id'),
      description: cfg.getString('description'),
    })),
  };
}

export function buildAbilityInfo(entry: RegistryEntry): AbilityInfo {
  return {
    name: entry.config.getString('name') || entry.tag,
    description: entry.config.getString('description'),
  };
}

/**
 * A unit type's `raceId` (e.g. `human`, `undead`) as a player-facing name,
 * for the recruit/recall dialogs' detail pane (real Wesnoth shows
 * `[race] name=`/`plural_name=`, not the raw id). Real `[race]` WML isn't
 * parsed anywhere in this port (`UnitType.ts`'s own module doc comment
 * scopes race data to just the id string), so this is a small static map
 * covering every race real mainline campaigns in this project use --
 * falling back to capitalizing the raw id for anything else, rather than
 * failing or showing nothing.
 */
const RACE_NAMES: Readonly<Record<string, string>> = {
  human: 'Human',
  elf: 'Elf',
  orc: 'Orc',
  orcish: 'Orc',
  undead: 'Undead',
  dwarf: 'Dwarf',
  merman: 'Merfolk',
  drake: 'Drake',
  troll: 'Troll',
  goblin: 'Goblin',
  naga: 'Naga',
  monster: 'Monster',
  wose: 'Wose',
  bats: 'Bat',
  wolf: 'Wolf',
  gryphon: 'Gryphon',
  mechanical: 'Mechanical',
  ogre: 'Ogre',
  raven: 'Raven',
  khalifate: 'Khalifate',
  falcon: 'Falcon',
  horse: 'Horse',
};

export function raceDisplayName(raceId: string): string {
  return RACE_NAMES[raceId] ?? (raceId.length > 0 ? raceId[0]!.toUpperCase() + raceId.slice(1) : raceId);
}

/** The standard six real damage types (`data/core/macros/*.cfg` conventionally lists resistances in this order) -- shown as a fixed-column resistances table in the infobox, per `MoveType.resistanceAgainst`'s own doc comment: unlisted types simply default to 100 (normal), so every unit has a real (if often "normal") value for all six. */
export const DAMAGE_TYPES: readonly string[] = ['blade', 'pierce', 'impact', 'fire', 'cold', 'arcane'];

/** One row of a unit's resistances table. `resistance` is upstream's own convention (>100 = weak to it, <100 = resistant) -- see `Resistances.resistanceAgainst`'s doc comment. */
export interface ResistanceInfo {
  damageType: string;
  resistance: number;
}

/**
 * Phase 14: one real `[set_menu_item]` a scenario's WML declared -- see
 * `GameSession.menuItems`/`runMenuItem`. Deliberately just `id`/`label`
 * (no raw `WmlConfig`): the UI layer (`GameShell.svelte`'s
 * `contextMenuCommands`) only ever needs enough to build a `Command`, and
 * running the actual command body stays entirely inside `GameSession`.
 */
export interface MenuItemOption {
  readonly id: string;
  readonly label: string;
}

/** Phase 14: the infobox's "terrain info for the hovered hex" view-model -- see `GameSession.hoveredHexInfo`. */
export interface HoveredHexInfo {
  x: number;
  y: number;
  terrainName: string;
  /** The selected unit's real defense here, or `null` if nothing is selected -- see `GameSession.defensePercentAt`. */
  defensePercent: number | null;
}

const STATUS_NAMES: Readonly<Record<string, string>> = {
  [UnitStatus.Slowed]: 'Slowed',
  [UnitStatus.Poisoned]: 'Poisoned',
  [UnitStatus.Petrified]: 'Petrified',
};

/** A view-model of a unit, for the side panel -- deliberately plain data, not a live `Unit` reference. Used for both the currently-*selected* (your own, actionable) unit and any *inspected* unit (see `GameSession.inspectedUnit`) -- addresses "no way to see information about enemy units". */
export interface SelectedUnitInfo {
  name: string;
  typeId: string;
  side: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  xp: number;
  maxXp: number;
  movesLeft: number;
  maxMoves: number;
  attacksLeft: number;
  /** Real `[terrain_type] name=` at the unit's own hex (e.g. "Castle", "Village"). */
  terrainName: string;
  /** Real terrain defense on the unit's own hex, as the player-facing percentage (`100 - defenseModifier`, since `defenseModifier` is upstream's "chance to be hit" convention -- lower is better). */
  defensePercent: number;
  /** This unit type's real weapons, each with its damage type/range/specials -- addresses "UI is missing information about weapon type/specials". */
  attacks: readonly WeaponInfo[];
  /** This unit type's real abilities (e.g. heals, skirmisher) -- addresses "UI is missing information about abilities and specials". */
  abilities: readonly AbilityInfo[];
  /** This unit's real `[trait]` modifications (e.g. "strong", "intelligent") -- real, reported bug: there was no way to see whether a unit had any traits, or what they were. See `Unit.traitNames`/`actions/recruit.ts`'s `generateTraits`. */
  traits: readonly string[];
  /** This unit type's real portrait/map sprite path (`snapshot.unitTypes[typeId].image`), or `null` if the snapshot never recorded one -- same source `RecruitOption`/`RecallOption`/`CombatantPreview` already use for their own portraits. */
  image: string | null;
  /** This unit type's real `[unit_type] level=`. */
  level: number;
  /** This unit type's real `alignment=` (lawful/neutral/chaotic/liminal), `undefined` if the type never set one. */
  alignment: Alignment | undefined;
  raceId: string;
  raceName: string;
  /** Fixed six-row table (`DAMAGE_TYPES`), per real Wesnoth's own resistances tooltip. */
  resistances: readonly ResistanceInfo[];
  /** Display names for whichever of `UnitStatus`'s poisoned/slowed/petrified this unit currently has -- the plan's explicitly called-out status icons. */
  statuses: readonly string[];
}

/** Builds a `SelectedUnitInfo` view-model for any live `Unit` -- shared by `GameSession.selectedUnitInfo`/`inspectedUnitInfo` (`GameShell.svelte` used to build this itself, inline, only for `selectedUnit`; centralised here so both selection and inspection stay in sync with each other and with `WeaponInfo`/`AbilityInfo`). `image` is passed in separately since it comes from the scenario snapshot's `unitTypes` table, which this module-level function (deliberately just `GameBoard`/`Unit`) has no access to -- see call sites. */
export function buildUnitInfo(board: GameBoard, unit: Unit, displayName: string, image: string | null = null): SelectedUnitInfo {
  return {
    name: displayName,
    typeId: unit.type.id,
    side: unit.side,
    x: unit.location.x,
    y: unit.location.y,
    hp: unit.hitpoints,
    maxHp: unit.maxHitpoints,
    xp: unit.experience,
    maxXp: unit.maxExperience,
    movesLeft: unit.movesLeft,
    maxMoves: unit.maxMoves,
    attacksLeft: unit.attacksLeft,
    terrainName: board.map.terrainName(unit.location),
    defensePercent: 100 - unit.defenseModifier(board.map.getTerrain(unit.location)),
    attacks: unit.attacks.map(buildWeaponInfo),
    abilities: unit.type.abilities.map(buildAbilityInfo),
    traits: unit.traitNames,
    image,
    level: unit.type.level,
    alignment: unit.type.alignment,
    raceId: unit.type.raceId,
    raceName: raceDisplayName(unit.type.raceId),
    resistances: DAMAGE_TYPES.map((damageType) => ({ damageType, resistance: unit.resistanceAgainst(damageType) })),
    statuses: (Object.keys(STATUS_NAMES) as string[]).filter((status) => unit.hasStatus(status)).map((status) => STATUS_NAMES[status]!),
  };
}

/** An attack the player has targeted but not yet committed -- shown in the side panel with Confirm/Cancel. */
export interface PendingAttack {
  attacker: Unit;
  defender: Unit;
  attackerWeaponIndex: number;
  defenderWeaponIndex: number;
  preview: CombatPreview;
}

/**
 * Everything a caller needs to animate the attack `confirmAttack` just
 * resolved (see `GameSession.lastAttackAnimation`), one real blow at a
 * time -- deliberately just the raw engine data (`Unit`/`AttackResult`),
 * not `UnitAnimationDef`s or pixel positions: this module has no
 * `@wesnothweb2/renderer` dependency, so a caller with one (`GameShell.
 * svelte`) builds `AnimationContext`s from this via that package's own
 * `buildAttackAnimationContexts` and drives `SnapshotBoard` itself.
 * `attacker`/`defender` remain valid `Unit` object references even if one
 * died (`executeAttack` only removes a dead unit from the BOARD's index,
 * never clears the `Unit` instance's own fields) -- their `.location` is
 * exactly where the blow happened.
 */
export interface LastAttackAnimation {
  readonly attacker: Unit;
  readonly attackerWeaponIndex: number;
  readonly defender: Unit;
  readonly defenderWeaponIndex: number;
  readonly result: AttackResult;
  /**
   * `attacker`/`defender`'s real `type.id` AS OF THE MOMENT THIS EXCHANGE
   * RESOLVED -- i.e. before `confirmAttack` processes any post-combat
   * advancement. `attacker`/`defender` above are live `Unit` references
   * that `confirmAttack` mutates in place (`Unit.advanceTo` swaps `.type`)
   * the instant a combatant has enough XP to level up, which happens
   * synchronously, before any caller gets a chance to actually play this
   * animation. Real, reported bug: without capturing the type id here, the
   * combat animation showed the unit's ALREADY-ADVANCED sprite for the
   * whole fight (e.g. an Archer already drawn as a Longbowman mid-swing)
   * instead of only after the fight visually finishes -- a caller building
   * animation cues should resolve sprite/animation-set by THESE ids, not
   * by re-reading `attacker.type.id`/`defender.type.id` live.
   */
  readonly attackerTypeId: string;
  readonly defenderTypeId: string;
  /**
   * `attacker`/`defender`'s real hitpoints BEFORE this exchange resolved --
   * same rationale as `attackerTypeId`/`defenderTypeId` above, but for HP:
   * `executeAttack` already applied every blow's damage/drain by the time
   * `confirmAttack` returns, so a caller stepping through `result.blows` to
   * preview the HP bar per blow (real, reported bug: it only ever updated
   * once, at the very end of the whole exchange) needs these starting
   * totals to run its own per-blow arithmetic forward from.
   */
  readonly attackerHitpointsBefore: number;
  readonly defenderHitpointsBefore: number;
  /**
   * `attacker`/`defender`'s real location AS OF THIS EXCHANGE -- see
   * `AiAnimationEvent`'s attack variant (`packages/engine/src/ai/
   * simpleAi.ts`) for the full rationale (bugs4.md #2/#3): this project's
   * human-confirmed-attack path always builds/plays its animation cue
   * immediately (no interleaving risk), but carries the same frozen
   * fields for consistency with the AI path, so `buildBlowAnimationCues`
   * (GameShell.svelte) can read ONE shape regardless of which side threw
   * the punch.
   */
  readonly attackerLocation: Location;
  readonly defenderLocation: Location;
}

/** Everything a caller needs to animate the move `handleHexClick`'s move branch just resolved -- see `GameSession.lastMoveAnimation`. Same rationale as `LastAttackAnimation`: raw engine data only, no renderer dependency here. */
export interface LastMoveAnimation {
  readonly unit: Unit;
  /** The hexes actually entered, in order (including the starting hex) -- `MoveResult.path`. */
  readonly path: readonly Location[];
}

/**
 * Everything a caller needs to animate a just-committed recruit/recall --
 * see `GameSession.lastRecruitAnimation`. Mirrors real Wesnoth's
 * `unit_recruited` (`units/udisplay.cpp`): the new unit plays "recruited"
 * at its own hex, and the leader (if any) plays "recruiting" facing it --
 * same two-context shape as `LastAttackAnimation`'s per-blow pair, just a
 * single fixed pair rather than one per blow.
 */
export interface LastRecruitAnimation {
  readonly unit: Unit;
  readonly leader: Unit;
  /** Same rationale as `LastAttackAnimation.attackerLocation`/`defenderLocation` above (bugs4.md #2/#3). */
  readonly unitLocation: Location;
  readonly leaderLocation: Location;
}

/**
 * A unit that's currently blocked on the player choosing which real
 * `advances_to=` type to become -- mirrors `unit_advancement_choice::
 * query_user`'s human-dialog branch (`actions/advancement.ts`'s own doc
 * comment explicitly scoped that out as "a UI concern", which this
 * fills in). Set by `GameSession`'s internal advancement queue
 * (`queueAdvancement`/`processAdvancementQueue`) whenever a unit that
 * just gained enough XP has 2+ real advancement options -- a single-
 * option unit advances immediately with no prompt (matching upstream:
 * the dialog only appears when there's an actual choice to make).
 */
/** One type a unit can advance into, as the advancement dialog shows it. */
export interface AdvancementOption {
  readonly typeId: string;
  readonly name: string;
  readonly level: number;
  readonly hitpoints: number;
  /** Map sprite, for the row's own icon -- same source every other dialog's portraits use. */
  readonly image: string | null;
  readonly attacks: readonly WeaponInfo[];
}

export interface PendingAdvancement {
  readonly unit: Unit;
  readonly options: readonly UnitType[];
  /**
   * The advancing unit as the dialog displays it (portrait, level,
   * alignment, race, HP/XP, traits, weapons) -- upstream's own advancement
   * dialog shows the full unit beside the choice, not just its name.
   */
  readonly unitInfo: SelectedUnitInfo;
  /** `options`, resolved for display. */
  readonly optionInfos: readonly AdvancementOption[];
}

/** One of the attacker's usable weapons against the current target -- see `GameSession.attackerWeaponOptions`. */
export interface AttackerWeaponOption {
  index: number;
  name: string;
  /** Damage type (e.g. "blade", "pierce") -- addresses "UI is missing information about the weapon type". */
  type: string;
  /** "melee" or "ranged" (or a custom `range=` value). */
  range: string;
  damage: number;
  numAttacks: number;
  specials: readonly WeaponSpecialInfo[];
  /** Whether this is the weapon `pendingAttack.preview` currently reflects. */
  selected: boolean;
}

/** The active side's economy figures, for a "how is my gold changing" side-panel display -- see `GameSession.economyInfo`. */
export interface EconomyInfo {
  /** The side's `gold=` at scenario start (`Team.startGold`), before any spending/income. */
  startGold: number;
  /** Gold granted per turn for each village this side owns (`village_gold=`, `Team.incomePerVillage`). */
  incomePerVillage: number;
  /** Villages this side currently owns (`GameBoard.villageCount`). */
  villagesOwned: number;
  /** What this side's gold will change by at the start of its *next* turn: total income (base + per-village) minus any unsupported unit upkeep. Zero on turn 1, when no side has had income/upkeep applied yet -- see `endTurn`'s doc comment. */
  netIncome: number;
  /** This side's raw total upkeep (sum of `unit.level` for every non-leader unit) -- for the status bar's real `upkeep (total)` display, mirrors `side_upkeep`. */
  upkeepTotal: number;
  /** The portion of `upkeepTotal` actually charged against gold each turn (`upkeepTotal - villages*support_per_village`, floored at 0) -- what `endTurn` actually deducts. */
  upkeepCharged: number;
  /** This side's current unit count -- for the status bar's real unit-count display. */
  unitCount: number;
}

/** One recruitable unit type, ready for the side panel's recruit list. */
export interface RecruitOption {
  typeId: string;
  name: string;
  cost: number;
  image: string | null;
  /** Whether the recruiting side currently has enough gold -- the UI should grey this option out, not hide it. */
  affordable: boolean;
  /** This unit type's own real stats, for the recruit dialog's detail pane (`RecruitDialog.svelte`) -- matches real Wesnoth's `units_dialog`. */
  level: number;
  alignment: Alignment;
  raceId: string;
  hitpoints: number;
  moves: number;
  attacks: readonly WeaponInfo[];
  abilities: readonly AbilityInfo[];
}

/**
 * One recall-list entry, ready for the side panel's Recall section --
 * mirrors `RecruitOption` but for an already-existing `Unit` (with its own
 * saved hp/level) rather than a fresh type.
 */
export interface RecallOption {
  /**
   * This unit's position in `board.recallList(side)` at the moment this
   * list was computed -- used (not `Unit.underlyingId`) as the selection
   * key passed to `selectRecallUnit`/`handleHexClick`'s recall branch,
   * since this project doesn't auto-assign a unique `underlying_id` to
   * every unit (see `Unit.ts`) -- several recall-list units (e.g. several
   * carried-over citizens) commonly all share the default `underlyingId=0`,
   * which would make that an unsafe selection key.
   */
  index: number;
  name: string;
  typeId: string;
  image: string | null;
  hp: number;
  maxHp: number;
  level: number;
  cost: number;
  /** Whether the recalling side currently has enough gold -- the UI should grey this option out, not hide it. */
  affordable: boolean;
  /** This unit's own real stats/traits, for the recall dialog's detail pane (`RecallDialog.svelte`) -- matches real Wesnoth's `units_dialog`. */
  xp: number;
  maxXp: number;
  traits: readonly string[];
  alignment: Alignment;
  raceId: string;
  movesLeft: number;
  maxMoves: number;
  attacks: readonly WeaponInfo[];
  abilities: readonly AbilityInfo[];
}

export interface GameSessionOptions {
  /** Which side the human player controls. Default 1 (Dead_Water scenario 1's Kai Krellis side). */
  playerSide?: number;
  /** Seed for the session's `RngDeterministic` -- see `RngDeterministic`'s own doc comment; no need for cryptographic randomness here. */
  seed?: number;
  /**
   * Set by `GameSession.startNextScenario` -- the real gold-carryover
   * computation that produced this session's starting gold, exposed via
   * `GameSession.goldCarryover` for the UI (e.g. a "carried over 390 gold"
   * message). `null`/omitted for a scenario started fresh, not continued
   * from a previous one.
   */
  goldCarryover?: GoldCarryoverResult | null;
  /**
   * Receives the event pump's own diagnostics -- notably the
   * "[tag] not supported (skipped)" warnings real content produces where
   * this port is still incomplete. Unset by default (the pump's own
   * no-op), so nothing in the browser console depends on it.
   */
  onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Everything `SavedUnit` records about a live unit except where it stands
 * (`toSaveData` adds x/y for board units and leaves it off for recall-list
 * ones, which have no position -- upstream's own distinction).
 */
function savedUnitFields(u: Unit): SavedUnit {
  return {
    id: u.id || null,
    name: u.name || null,
    typeId: u.type.id,
    side: u.side,
    canRecruit: u.canRecruit,
    hitpoints: u.hitpoints,
    maxHitpoints: u.maxHitpoints,
    movesLeft: u.movesLeft,
    maxMoves: u.maxMoves,
    attacksLeft: u.attacksLeft,
    maxAttacksPerTurn: u.maxAttacksPerTurn,
    experience: u.experience,
    maxExperience: u.maxExperience,
    level: u.level,
    // Indeterminate is "no facing recorded", not a direction: writing it
    // as the empty string would come back as a facing of its own.
    facing: u.facing === Direction.Indeterminate ? undefined : writeDirection(u.facing),
    resting: u.resting,
    hidden: u.hidden,
    role: u.role,
    underlyingId: u.underlyingId,
    profile: u.profile,
    statuses: [...u.statuses],
    modifications: u.modifications.map((m) => ({ kind: m.kind, cfg: m.cfg.toJSON() })),
    variables: u.variables?.toJSON(),
    goto: u.goto ? { x: u.goto.x, y: u.goto.y } : undefined,
  };
}

/**
 * One unit as a save carries it: every *mutable* thing `Unit` owns, since
 * anything omitted here is silently reset to its unit type's default when
 * the save is loaded.
 *
 * Real, reported class of bug (fixed in save version 2): version 1 stored
 * only id/name/type/side/position/hp/moves/attacks, so a reloaded game
 * handed every veteran back at 0 XP, base level, no traits and no status
 * effects -- a poisoned, slowed, level-3 unit came back a healthy level-1
 * one. `loadSaveData` applies each field only when present, which is also
 * how a version-1 save upgrades cleanly: its missing fields simply keep
 * the freshly-created unit's type defaults, exactly as before.
 *
 * Field names mirror `Unit`'s own, not WML's -- the Wesnoth-format
 * converter (`save/wesnothSave.ts`) is the single place that translates
 * between the two, so nothing else in the app has to know WML spelling.
 */
export interface SavedUnit {
  id: string | null;
  name: string | null;
  typeId: string;
  side: number;
  canRecruit: boolean;
  /**
   * All optional for the same reason the version-2 fields below are: each
   * is applied only if present, so whatever is missing keeps the unit
   * type's own default. `toSaveData` always writes them; a save *imported*
   * from real Wesnoth may not, because upstream omits any unit attribute
   * that still matches its type (`unit::write`'s `write_all=false` path).
   */
  hitpoints?: number;
  maxHitpoints?: number;
  movesLeft?: number;
  maxMoves?: number;
  attacksLeft?: number;
  maxAttacksPerTurn?: number;
  /** Board position. Omitted for a recall-list unit, which has none (upstream's own rule: a `[unit]` with no x/y is a recall unit). */
  x?: number;
  y?: number;
  // --- everything below is version 2; optional on read (see above) ---
  experience?: number;
  maxExperience?: number;
  level?: number;
  /** WML's own direction spelling (`"nw"`), not the numeric `Direction` enum, so the JSON survives an enum reorder. */
  facing?: string;
  resting?: boolean;
  hidden?: boolean;
  role?: string;
  underlyingId?: number;
  profile?: string;
  /** `[status]`: `poisoned`, `slowed`, `guardian`, and any scenario-defined flag. */
  statuses?: readonly string[];
  /** `[modifications]`: traits, objects and advancements -- opaque WML this session only carries. */
  modifications?: readonly { kind: string; cfg: WmlConfigJson }[];
  /** The unit's own `[variables]` bag. */
  variables?: WmlConfigJson;
  goto?: { x: number; y: number };
  /**
   * Present only on a unit read out of a real Wesnoth save: that `[unit]`
   * block as the game wrote it. A real save records far more per unit than
   * this port models -- `gender`, `race`, `upkeep`, `usage`, `variation`,
   * `image`, `[filter_recall]`, the unit's whole movement-type block --
   * none of which this port needs, but all of which would be lost on the
   * way back out to a file. Export overlays the modelled fields onto this
   * and leaves the rest alone. See `save/wesnothSave.ts`.
   */
  wesnothExtras?: WmlConfigJson;
}

/**
 * `GameSession`'s own live-state save shape -- NOT itself a Wesnoth save
 * file, but complete enough to be converted into one losslessly (see
 * `save/wesnothSave.ts`, which is the only module that knows the WML
 * spelling of any of this). Plain JSON, versioned so a shape change can
 * be detected rather than silently misread.
 *
 * Version 2 (Phase 26) made the capture actually complete: full units (see
 * `SavedUnit`), village ownership, RNG position, and which campaign/
 * scenario the save belongs to. Every version-2 addition is optional on
 * read, so a version-1 save still loads -- just without the state it never
 * recorded.
 */
export interface SaveGameData {
  version: 1 | 2;
  turnNumber: number;
  activeSide: number;
  scenarioResult: 'victory' | 'defeat' | null;
  startupEventsRun: boolean;
  /**
   * Which scenario and campaign this save belongs to. Version 1 stored the
   * scenario id only outside the save (in the IndexedDB record), and the
   * campaign nowhere at all -- so a save could not be found, filtered or
   * resumed from anywhere but the scenario it was taken in.
   */
  scenarioId?: string;
  scenarioName?: string;
  campaignId?: string;
  teams: readonly {
    side: number;
    gold: number;
    shroudData?: string;
    fogData?: string;
    /**
     * Villages this side owns (`team::villages()`). Real, reported bug:
     * without these a reloaded game re-derived ownership from the
     * scenario's *initial* unit placement, so every village captured
     * during play reverted to unowned and the side's income with it.
     */
    villages?: readonly { x: number; y: number }[];
  }[];
  units: readonly SavedUnit[];
  /**
   * Every side's recall-list units (off-board, so no x/y) -- added
   * alongside the Recall UI/carryover work; optional on read so a save
   * written before this field existed still loads (as an empty recall
   * list for every side, via `loadSaveData`'s `data.recall ?? []`).
   */
  recall?: readonly SavedUnit[];
  /**
   * The live ToD schedule's mutated state (`[replace_schedule]`'s new
   * global schedule, every active `[time_area]`) -- optional on read so a
   * save written before Phase 12 still loads (the schedule then just
   * stays as freshly rebuilt from the scenario's own static `[time]`
   * config, matching this field's absence).
   */
  schedule?: ScheduleState;
  /**
   * The scenario's WML variables (`[set_variable]` and friends), as the
   * `[variables]` config upstream writes into its own saves. Phase 17:
   * without these a reloaded game forgot everything its events had
   * decided -- including choices the player had already made. Optional
   * on read, like every field added after version 1.
   */
  variables?: WmlConfigJson;
  /** Every `[option]`/`[text_input]` answer taken so far, for Phase 25's replay log. */
  choices?: readonly { value?: number; text?: string; side: number }[];
  /**
   * Where the synced RNG stream had got to (`random_seed`/`random_calls`,
   * upstream's own two fields -- `MtRng` already models both). Real bug:
   * without them a reload restarted the stream from the session's initial
   * seed, so combat after a load diverged from the game that was saved --
   * and a replay built from that save could never line up.
   */
  rng?: { seed: string; calls: number };
  /** The "carried over N gold" result this scenario was entered with, for the UI banner (it is derived from the *previous* scenario, so it cannot be recomputed here). */
  goldCarryover?: GoldCarryoverResult | null;
  /**
   * Present only on a save *imported* from a real Wesnoth `.gz`: that
   * file's own tree, minus the `[side]` blocks this session regenerates
   * from the state above. Carrying it means the parts this port does not
   * model -- `[statistics]`, `[multiplayer]`, `[replay]`, `[undo_stack]`,
   * `[display]`, the scenario's `[event]`s as that Wesnoth version wrote
   * them -- survive the round trip back out to a file instead of being
   * silently dropped. Nothing but `save/wesnothSave.ts` ever reads it.
   */
  wesnothExtras?: WmlConfigJson;
}

/**
 * Owns one live `GameBoard` (reconstructed from a `GameBoardSnapshot`) plus
 * the UI-facing selection/targeting state a board view and side panel need.
 * All mutation goes through real `packages/engine` actions
 * (`executeMove`/`executeAttack`) -- this class never hand-rolls movement or
 * combat math itself.
 */
export class GameSession {
  /** `game_config::base_income` upstream (wesnoth/src/game_config.cpp) -- a hardcoded constant added to every side's `income=` WML attribute, NOT itself WML-configurable. */
  private static readonly BASE_INCOME = 2;

  readonly board: GameBoard;
  readonly snapshot: GameBoardSnapshot;
  /** Initial active side (Dead_Water scenario 1's Kai Krellis side by default) -- see `activeSide` for who can actually act now. */
  readonly playerSide: number;

  /** The side currently allowed to act -- see `endTurn`'s doc comment on the hotseat model this demo uses in place of an AI. */
  activeSide: number;
  /** 1-based turn counter, incremented by `endTurn` whenever it wraps back past the highest side number. */
  turnNumber = 1;

  selectedUnit: Unit | null = null;
  /**
   * A unit the player clicked purely to VIEW its info -- any unit, friend
   * or enemy, that `handleHexClick` didn't otherwise act on (move/attack/
   * reselect). Addresses "no way to see information about enemy units":
   * independent of `selectedUnit` (which drives move/attack highlighting
   * for the player's OWN unit), so inspecting an enemy doesn't disturb an
   * in-progress selection. Cleared whenever the clicked hex is empty, or
   * a hex click does something else (move/attack/recruit/reselect) --
   * see `handleHexClick`'s branches. `null` if nothing has been inspected
   * (or the inspected unit is the same one already shown via `selectedUnit`,
   * to avoid a caller rendering the same unit's info twice).
   */
  inspectedUnit: Unit | null = null;
  /** Hexes `selectedUnit` can move to this turn (excludes its own hex). */
  reachable: ReachableHexPoint[] = [];
  /** Adjacent enemy units `selectedUnit` could attack (empty if it has no attacks left). */
  attackCandidates: Unit[] = [];
  pendingAttack: PendingAttack | null = null;
  /**
   * Set by `confirmAttack` every time a HUMAN-confirmed attack resolves --
   * see `LastAttackAnimation`'s own doc comment. A caller that wants to
   * animate it should read this right after calling `confirmAttack` and
   * reset it to `null` once done (not cleared automatically, unlike
   * `pendingAttack`). Deliberately NOT set for AI-played attacks
   * (`playAiSide` calls `executeAttack` directly, bypassing this) --
   * animating every blow of every AI unit's attack would make `endTurn`'s
   * auto-play noticeably slower for no real benefit (nothing's watching a
   * fully-automated AI turn play out blow by blow the way a human watches
   * their own confirmed attack).
   */
  lastAttackAnimation: LastAttackAnimation | null = null;
  /**
   * Phase 17 retired this: a human move's walk is now a `moveUnit`
   * cutscene beat yielded by the move itself (see `moveSelectedTo`), so
   * it plays before the `moveto`/`sighted` dialogue it triggers rather
   * than after the whole click had already resolved. Kept as an always-
   * null field only so an external caller reading it doesn't silently
   * break; AI moves still animate from `AiAnimationEvent` as before.
   *
   * @deprecated Read the `moveUnit` beat instead.
   */
  lastMoveAnimation: LastMoveAnimation | null = null;
  /**
   * Retired by Phase 17 alongside `lastMoveAnimation`: a human
   * recruit/recall now yields a `unitAppear` beat carrying the new unit
   * and the leader who called it, so it plays before the `recruit`
   * event's dialogue. Always null.
   *
   * @deprecated Read the `unitAppear` beat instead.
   */
  lastRecruitAnimation: LastRecruitAnimation | null = null;
  /**
   * The unit currently blocked on the player's advancement choice, if any
   * -- see `PendingAdvancement`'s own doc comment. While set, callers
   * should block other play (matching real Wesnoth's modal advance
   * dialog) until `chooseAdvancement` resolves it. `null` the rest of
   * the time, including immediately after `chooseAdvancement` -- unlike
   * the `lastXAnimation` fields, this ISN'T read-once-then-clear by the
   * caller; `GameSession` itself owns clearing it.
   */
  pendingAdvancement: PendingAdvancement | null = null;
  /** Units still waiting for an advancement check -- see `queueAdvancement`/`processAdvancementQueue`. Drained (auto-advancing single-option units, cascading on overflow XP) until either empty or a multi-option unit sets `pendingAdvancement` and pauses the drain. */
  private readonly advancementQueue: Unit[] = [];
  /**
   * Real, reported bug (bugs3.md "objectives dialog"): the scenario's own
   * real `[objectives]` (fired by `runStartupEvents`, for `playerSide`)
   * used to have nowhere to go -- set once, here, the first time a
   * non-`silent=` firing occurs. `GameShell.svelte` shows this once at
   * scenario start (see its own phase-sequencing doc comment); unlike
   * `pendingAdvancement`, nothing clears this afterward -- a caller that
   * wants to let the player reopen it later (real Wesnoth's own
   * "Objectives" menu item) can just keep reading this field.
   */
  scenarioObjectives: ScenarioObjectives | null = null;
  /**
   * Set by `endTurn` every time it auto-plays one or more consecutive
   * `ai`/`network_ai`-controlled sides, to every real `AiAnimationEvent`
   * those sides' actions produced, IN ORDER (across however many
   * consecutive AI sides `endTurn` looped through -- see its own doc
   * comment) -- real, reported bug (bugs2.md "animations during AI
   * turn"): previously nothing at all played for an AI turn, a
   * deliberate simplification at the time (see `lastAttackAnimation`'s
   * own doc comment) this reverses. `board` is already at its final
   * state for the whole span by the time `endTurn` returns (see
   * `AiAction.animation`'s own doc comment on why that's fine to
   * animate against anyway); same read-once-then-clear contract as the
   * other `lastXAnimation` fields. `null` (not `[]`) when no AI side
   * played this call.
   */
  lastAiAnimations: readonly AiAnimationEvent[] | null = null;

  /**
   * Real, reported bug (bugs4.md #7): turn-start rest/village healing,
   * poison damage, and real `[heals]`/`[regenerate]` ability healing
   * (`applySideHealing`, called from `advanceOneTurn` below) already
   * applied the real HP change to every affected unit, but nothing ever
   * showed it happening -- no floating HP-change numeral (unlike a
   * combat blow, see `makeBlowPreview`'s doc comment) and no `healed`/
   * `poisoned`/`healing` unit animation (despite `parseUnitAnimations`
   * already fully supporting those three real WML animation tags -- they
   * were simply never invoked). Accumulates every `HealOutcome` across
   * however many side-transitions one `endTurn()` call makes (human and
   * AI sides alike), in chronological order; `null` (not `[]`) when
   * nothing changed. Known simplification: played back as one batch
   * BEFORE any AI-turn animations from the same `endTurn()` call (see
   * `GameShell.handleEndTurn`), not fully interleaved turn-by-turn with
   * them -- an acceptable rough edge shared with `lastAiAnimations`'s own
   * "no incremental sync() between events" simplification.
   */
  lastHealAnimations: readonly HealOutcome[] | null = null;

  /**
   * The real terrain defense `selectedUnit` would have at `(x, y)` (the
   * player-facing "Defense: N%" percentage -- see `SelectedUnitInfo.
   * defensePercent`'s own doc comment on the `100 - defenseModifier` flip),
   * or `null` if there's no selected unit or the hex is off-board. Used for
   * a hover preview (catalogue: "Hovering a reachable hex shows the
   * defense percentage the unit would have there") -- deliberately not
   * restricted to `reachable` hexes specifically, since the underlying
   * defense value is well-defined for any on-board hex regardless of
   * whether this turn's movement can actually reach it.
   */
  defensePercentAt(x: number, y: number): number | null {
    const unit = this.selectedUnit;
    if (!unit) return null;
    const loc = new Location(x, y);
    if (!this.board.map.onBoard(loc)) return null;
    return 100 - unit.defenseModifier(this.board.map.getTerrain(loc));
  }

  /**
   * Phase 14: the infobox's "terrain info for the hovered hex" -- real
   * `[terrain_type] name=` plus (when a unit is selected) the defense
   * percentage that unit would have there, same value `defensePercentAt`
   * already computes. `null` for an off-board hex; the whole thing is
   * deliberately independent of `reachable`, matching `defensePercentAt`'s
   * own reasoning (terrain info is well-defined for any on-board hex).
   */
  hoveredHexInfo(x: number, y: number): HoveredHexInfo | null {
    const loc = new Location(x, y);
    if (!this.board.map.onBoard(loc)) return null;
    return {
      x,
      y,
      terrainName: this.board.map.terrainName(loc),
      defensePercent: this.defensePercentAt(x, y),
    };
  }

  /**
   * Phase 14: every real `[set_menu_item]` the scenario's WML has declared
   * (via `[event]`s already run by `runStartupEvents`, or any later event
   * -- `actionWml.ts`'s `actionSetMenuItem` mutates `eventPump.ctx.
   * menuItems` in place, so this always reflects the current set).
   * `GameShell.svelte`'s `contextMenuCommands` appends one `Command` per
   * entry here, offered unconditionally on every hex -- this port doesn't
   * implement `[show_if]`/`[filter_location]` per-hex gating (see
   * `actionSetMenuItem`'s own doc comment), so a scenario author wanting a
   * command to only make sense on certain hexes has to make its own
   * `[command]` body a no-op elsewhere (e.g. check `$x1`/`$y1` itself).
   */
  get menuItems(): MenuItemOption[] {
    return [...this.eventPump.ctx.menuItems.values()].map((item) => ({ id: item.id, label: item.description }));
  }

  /**
   * Runs the real `[command]` body of the `[set_menu_item]` `id` names,
   * at the right-clicked hex `(x, y)` -- sets `$x1`/`$y1`/`ctx.loc1` first
   * (mirrors `EventPump.pump`'s own convention, see its doc comment) so a
   * command's `[heal_unit]`/`[filter]`-less action tags default to that
   * hex exactly the way a real `[set_menu_item]`'s `[command]` would via
   * `wesnoth.current.event_context.x1/y1`. No-op if `id` isn't a currently
   * registered menu item (e.g. a stale command from a menu opened before
   * a `[clear_menu_item]` ran). Returns a log message for the caller's
   * `sync()`, matching every other mutating method here.
   */
  async runMenuItem(id: string, x: number, y: number): Promise<string | null> {
    const def = this.eventPump.ctx.menuItems.get(id);
    if (!def) return null;
    const loc = new Location(x, y);
    this.eventPump.ctx.loc1 = loc;
    this.eventPump.ctx.loc2 = Location.NULL;
    this.eventPump.ctx.variables.set('x1', loc.wmlX);
    this.eventPump.ctx.variables.set('y1', loc.wmlY);
    await this.drive(runActionFlow(def.command, this.eventPump.ctx));
    this.checkForGameEnd();
    const message = `${def.description}.`;
    this.log.unshift(message);
    return message;
  }

  /** The attacker's usable weapons against the current `pendingAttack.defender`, for a weapon-choice UI. Empty when there's no pending attack, or a single entry for the common one-usable-weapon case. */
  get attackerWeaponOptions(): AttackerWeaponOption[] {
    const pending = this.pendingAttack;
    if (!pending) return [];
    return this.viableAttackerWeaponIndices(pending.attacker).map((index) => {
      const weapon = pending.attacker.attacks[index]!;
      const info = buildWeaponInfo(weapon);
      return {
        index,
        name: info.name,
        type: info.type,
        range: info.range,
        damage: info.damage,
        numAttacks: info.numAttacks,
        specials: info.specials,
        selected: index === pending.attackerWeaponIndex,
      };
    });
  }

  /** Rebuilds `pendingAttack` (preview + defender's real counter-weapon choice) for a different attacker weapon, keeping the same target. No-op if there's no pending attack or `index` isn't one of the attacker's own weapons. */
  selectAttackerWeapon(index: number): void {
    const pending = this.pendingAttack;
    if (!pending || !pending.attacker.attacks[index]) return;
    this.pendingAttack = this.buildPreview(pending.attacker, pending.defender, index);
  }
  /** Unit type id the player has picked from the recruit list, awaiting a click on one of `recruitTiles`. */
  pendingRecruitTypeId: string | null = null;
  /** Recall-list index (see `RecallOption.index`) the player has picked from the recall list, awaiting a click on one of `recruitTiles`. Mutually exclusive with `pendingRecruitTypeId` -- see `selectRecruitType`/`selectRecallUnit`. */
  pendingRecallIndex: number | null = null;
  /** Most-recent-first log of human-readable move/attack/recruit/turn outcomes. */
  log: string[] = [];
  /**
   * Set once the scenario has ended (`checkVictory`, run after every
   * combat) -- `'victory'` if `playerSide` is among the survivors,
   * `'defeat'` otherwise. `null` while play continues. Every mutating
   * method below early-returns once this is set; the scenario is over.
   */
  scenarioResult: 'victory' | 'defeat' | null = null;

  /**
   * The real gold-carryover computation that produced this session's
   * starting gold, if it was built via `startNextScenario` -- `null` for a
   * scenario started fresh. See `computeGoldCarryover`'s own doc comment
   * for what each field means; the UI can show `goldCarryover.carryoverGoldValue`
   * as a "Carried over N gold" message.
   *
   * Not `readonly`: a save records it and `loadSaveData` restores it, since
   * it is derived from the *previous* scenario and so cannot be recomputed
   * by a session that was started from a save file.
   */
  goldCarryover: GoldCarryoverResult | null;

  /** Resolves any of the ~332 real unit types the snapshot ships (board units, event-spawned units, recruit lists) -- see `createTypeResolver`. */
  private readonly resolveType: (id: string) => UnitType;
  private readonly rng: RngDeterministic;
  /**
   * The generator `rng` draws from, held separately because only `MtRng`
   * exposes the seed and draw count a save has to record and restore
   * (`random_seed`/`random_calls` -- see `SaveGameData.rng`).
   */
  private readonly mtRng: MtRng;
  /**
   * Assigns each live `Unit` object a stable, session-local render key
   * (`renderUnits`' `SnapshotUnit.underlyingId`) the first time it's seen,
   * keyed by object identity rather than `Unit.underlyingId` itself --
   * that engine field defaults to 0 and is NOT reliably unique (see
   * `RecallOption.index`'s own doc comment on the same issue for
   * recall-list units), so it can't be used to give a `SnapshotBoard`
   * sprite a stable identity across `renderUnits` snapshots. A `Unit`
   * object reference persists for its whole lifetime on the board
   * (including through `advanceUnitTo`, which mutates in place rather
   * than replacing the object), so this key stays correctly stable for
   * exactly as long as the sprite it identifies should. Public (not just
   * used internally by `renderUnits`) so a caller building animation cues
   * from `lastAttackAnimation`'s raw `Unit` objects (`GameShell.svelte`)
   * can compute the SAME key `SnapshotBoard`'s sprite map already has
   * them stored under.
   */
  private readonly renderKeys = new WeakMap<Unit, number>();
  private nextRenderKey = 1;
  renderKeyFor(unit: Unit): number {
    let key = this.renderKeys.get(unit);
    if (key === undefined) {
      key = this.nextRenderKey++;
      this.renderKeys.set(unit, key);
    }
    return key;
  }
  private startupEventsRun = false;
  /**
   * Phase 17: who shows a `[message]` or plays a cutscene beat, set once
   * by `GameShell`. While it is handling one, the event that raised it is
   * genuinely suspended -- nothing else on the board moves. Left unset by
   * headless callers, whose interactions are answered by `autoRespond`.
   */
  interactionHost: InteractionHost | null = null;
  /** See `takeDeferredInteractions`. */
  private readonly deferred: Interaction[] = [];
  /**
   * One event pump for the whole scenario, so in-play events (moveto,
   * sighted, die, turn N, ...) fire during play the way upstream's do, and
   * `first_time_only` handlers stay spent.
   */
  private readonly eventPump: EventPump;
  /** Game turn whose `turn N`/`new turn` events have fired (`tod_manager::turn_event_fired`). */
  private turnEventsFiredFor = 0;
  private readonly raiseEvent: RaiseEvent = (name, loc1, loc2) => this.eventPump.raise(name, loc1, loc2);
  /**
   * The real `[time]` schedule this scenario's own (already macro-expanded)
   * `scenarioConfigJson` declares -- see `Schedule`'s own doc comment. The
   * reference is fixed at construction, but `Schedule` is itself mutable
   * state (`[time_area]`/`[remove_time_area]`/`[replace_schedule]` all
   * change it in place, see `todWml.ts`).
   */
  private readonly schedule: Schedule;
  /**
   * The real RCA candidate-action AI (Phase 29), one composite per side,
   * built lazily from that side's own `[side][ai]` blocks. Replaces the
   * Phase 7 heuristic (`playAiTurn`/`simpleAi.ts`, deleted) -- `playAiSide`
   * below is the only caller.
   */
  private readonly aiManager: AiManager;

  constructor(snapshot: GameBoardSnapshot, options: GameSessionOptions = {}) {
    this.snapshot = snapshot;
    this.playerSide = options.playerSide ?? 1;
    this.activeSide = this.playerSide;
    this.board = gameBoardFromSnapshot(snapshot).board;
    this.resolveType = createTypeResolver(snapshot);
    this.mtRng = new MtRng(options.seed ?? 0xc0ffee);
    this.rng = new RngDeterministic(this.mtRng);
    this.goldCarryover = options.goldCarryover ?? null;
    // random_start_time= is resolved once here, before any events run --
    // matches upstream's own timing (tod_manager::resolve_random, called
    // from the play_controller constructor sequence before fire_prestart).
    this.schedule = scheduleFromScenarioConfigJson(snapshot.scenarioConfigJson, this.rng);
    const manager = new EventManager();
    manager.loadScenarioEvents(WmlConfig.fromJSON(snapshot.scenarioConfigJson));
    this.eventPump = new EventPump(manager, {
      board: this.board,
      variables: new VariableStore(),
      resolveType: this.resolveType,
      schedule: this.schedule,
      rng: this.rng,
      log: options.onLog,
    });
    this.board.lawfulBonusAt = (loc) => this.timeOfDayAt(loc).lawfulBonus;

    const aiHost: AiHost = {
      board: this.board,
      rng: this.rng,
      resolveType: this.resolveType,
      lawfulBonusAt: (loc) => this.timeOfDayAt(loc).lawfulBonus,
      maxLiminalBonus: this.schedule.maxLiminalBonus,
      turnNumber: () => this.turnNumber,
      timeOfDayId: () => this.currentTimeOfDay.id,
      raise: (name, loc1, loc2, data) => this.eventPump.raise(name, loc1, loc2, data),
      fire: (name, loc1, loc2) => this.eventPump.fire(name, loc1, loc2),
      pump: () => this.pumpEvents(),
      log: () => {
        /* no dedicated AI debug log sink yet -- warnings from a misconfigured [modify_ai]/aspect surface via the
           browser console being the intended audience for now, not this session's own player-facing `log`. */
      },
      scenarioEnded: () => !!this.scenarioResult,
    };
    this.aiManager = new AiManager(aiHost, (side) => findSideConfig(snapshot.scenarioConfigJson, side)?.children('ai') ?? []);
    const aiWmlHooks: AiWmlHooks = {
      modifyAi: (side, action, path, cfg) => this.aiManager.modifyAi(side, action, path, cfg),
      appendSideAi: (side, cfg) => this.aiManager.appendSideAi(side, cfg),
      microAi: () => aiHost.log('warn', '[micro_ai]: Lua AI engine not loaded yet (Phase 29 S9+)'),
    };
    registerAiWmlActions(this.eventPump.ctx.registry);
    this.eventPump.ctx.ai = aiWmlHooks;
  }

  /**
   * The real `[time]` entry active on the current game turn (`turnNumber`),
   * IGNORING `[time_area]`/`[illuminates]` -- mirrors `tod_manager::
   * get_time_of_day()` (its no-location overload). This is what a global
   * status-bar indicator should show; per-hex/per-combatant code should
   * use `timeOfDayAt` instead.
   */
  get currentTimeOfDay(): TimeOfDayEntry {
    return this.schedule.timeOfDayForTurn(this.turnNumber);
  }

  /**
   * The real, fully location-aware ToD at `loc` -- schedule, any covering
   * `[time_area]`, and `[illuminates]`, all layered the way upstream's own
   * `get_illuminated_time_of_day` does. This is what combat/event filters
   * should use, never `currentTimeOfDay` (which is deliberately global-
   * only, for the status bar).
   */
  timeOfDayAt(loc: Location): TimeOfDayEntry {
    return effectiveTimeOfDayAt(this.board, this.schedule, this.turnNumber, loc);
  }

  /**
   * The real `[scenario] next_scenario=` this scenario declares, or `null`
   * if it has none (the scenario chain ends here). Drives whether
   * `ScenarioEndOverlay` offers a "Continue" button on victory -- see
   * `startNextScenario`.
   */
  get nextScenarioId(): string | null {
    // An [endlevel] next_scenario= overrides the scenario's own (endlevel.lua sets wesnoth.scenario.next).
    const raw = this.eventPump.ctx.endLevel?.nextScenario ?? this.snapshot.scenarioConfigJson.attrs['next_scenario'];
    if (raw === undefined || raw === null) return null;
    const id = String(raw).trim();
    // `next_scenario=null` is how campaigns mark their last scenario (game_state::has_next_scenario).
    return id.length > 0 && id !== 'null' ? id : null;
  }

  /**
   * Phase 16: the `[endlevel]` fields that shape the campaign outro
   * (`end_text=`, `end_text_duration=`, `end_credits=`) once the scenario
   * ended through `[endlevel]`; null otherwise (e.g. a leader kill), which
   * means upstream's defaults.
   */
  get endLevelPresentation(): { endText?: string; endTextDuration?: number; endCredits?: boolean } | null {
    const endLevel = this.eventPump.ctx.endLevel;
    return endLevel ? { endText: endLevel.endText, endTextDuration: endLevel.endTextDuration, endCredits: endLevel.endCredits } : null;
  }

  /**
   * Phase 16: the scenario's story screen parts, resolved from every
   * `[story]` against this session's live event context. Call it before
   * `runStartupEvents`: upstream shows the story before `prestart`, so its
   * `[if]`/`[switch]` must only see state carried into the scenario.
   */
  storyParts(): ResolvedStoryPart[] {
    return resolveStory(WmlConfig.fromJSON(this.snapshot.scenarioConfigJson), this.snapshot.scenario.name, this.eventPump.ctx);
  }

  /**
   * Runs the scenario's real `prestart`/`start` events once (spawning the
   * event-placed units, recording `[message]` dialogue -- see
   * `runScenarioStartupEvents`). Safe to call more than once; only the
   * first call has any effect. Returns the recorded messages (empty on a
   * repeat call).
   */
  async runStartupEvents(): Promise<RecordedMessage[]> {
    if (this.startupEventsRun) return [];
    this.startupEventsRun = true;
    return this.drive(this.startupEventsFlow());
  }

  private *startupEventsFlow(): Flow<RecordedMessage[]> {
    const shownFrom = this.eventPump.ctx.messages.length;
    // `[delay]` does nothing before the scenario starts, as upstream --
    // an opening cutscene's scripted pauses must not stall startup.
    this.eventPump.ctx.gameStarted = false;
    yield* this.fireFlow('prestart');
    // play_controller::init: every side's shroud is cleared from its starting units, without sighted events.
    for (const team of this.board.teams()) clearShroud(this.board, team.side);
    this.eventPump.ctx.gameStarted = true;
    yield* this.fireFlow('start');
    yield* this.fireSideTurnEvents(this.activeSide);
    yield* this.fireTurnRefreshEvents(this.activeSide);
    this.checkForGameEnd();
    const objectives = this.eventPump.ctx.objectivesBySide.get(this.playerSide);
    // Real `team.objectives_changed = not silent` -- a silent firing updates
    // the side's objectives without popping the dialog (matches upstream's
    // own gate on whether `show_objectives` should auto-trigger).
    if (objectives && !objectives.silent) this.scenarioObjectives = objectives;
    return this.eventPump.ctx.messages.slice(shownFrom);
  }

  /**
   * Every `[message]` the scenario has shown so far, oldest first. Before
   * Phase 17 the UI drained this array and replayed it after the fact;
   * now each message is shown as its event reaches it, so this is a
   * transcript, kept for tests and for a future chat log.
   */
  get shownMessages(): readonly RecordedMessage[] {
    return this.eventPump.ctx.messages;
  }

  /** Every `[option]`/`[text_input]` answer this scenario has taken, oldest first (Phase 25's replay log consumes these). */
  get choices(): readonly ChoiceRecord[] {
    return this.eventPump.ctx.choices;
  }

  /** Reads one WML variable by its dotted path (`rescued[0].name`), as `$var` would. */
  getVariable(path: string): WmlAttributeValue | undefined {
    return this.eventPump.ctx.variables.get(path);
  }

  /** Sets one WML variable -- for a caller standing in for an event (a test, a debug tool). */
  setVariable(path: string, value: WmlAttributeValue): void {
    this.eventPump.ctx.variables.set(path, value);
  }

  /**
   * Interactions raised where the flow could not suspend and wait for the
   * player -- an AI side's own events, and the `last breath`/`die` events
   * fired from inside `performAttack`'s choreography callback. They are
   * answered immediately (`autoRespond`) and collected here so the caller
   * can still show them once its animations finish, which is exactly what
   * the pre-Phase-17 UI did with every message. See `endTurn`.
   */
  takeDeferredInteractions(): Interaction[] {
    return this.deferred.splice(0);
  }

  private readonly collectResponder: Responder = (interaction) => {
    this.deferred.push(interaction);
    return autoRespond(interaction);
  };

  /**
   * Runs a flow to completion, handing each interaction to
   * `interactionHost` and waiting for its answer. With no host (a
   * headless caller, or a test), the engine's own deterministic
   * `autoRespond` answers instead and nothing ever waits.
   */
  private async drive<T>(flow: Flow<T>): Promise<T> {
    let step = flow.next({});
    while (!step.done) {
      const host = this.interactionHost;
      const answer = host ? await host.handle(step.value) : autoRespond(step.value);
      step = flow.next(answer);
    }
    return step.value;
  }

  private *fireFlow(name: string, loc1?: Location, loc2?: Location): Flow {
    if (this.scenarioResult) return;
    yield* this.eventPump.fireFlow(name, loc1, loc2);
  }

  /** Pumps anything raised by the last action (sighted, moveto, ...), then applies `[endlevel]`/leader loss. */
  private *pumpEventsFlow(): Flow {
    if (!this.scenarioResult) yield* this.eventPump.pumpFlow();
    this.checkForGameEnd();
    this.syncVillageMemory();
  }

  /**
   * The synchronous form, for the two paths that cannot suspend: the AI
   * host's own `pump()` callback and anything else running inside a
   * non-generator callback. Interactions are collected rather than
   * silently dropped -- see `takeDeferredInteractions`.
   */
  private pumpEvents(): void {
    runFlow(this.pumpEventsFlow(), this.collectResponder);
  }

  /** `play_controller::do_init_side`'s events that come before income and healing. */
  private *fireSideTurnEvents(side: number): Flow {
    const turn = this.turnNumber;
    this.eventPump.ctx.variables.set('side_number', side);
    this.eventPump.ctx.variables.set('turn_number', turn);
    if (this.turnEventsFiredFor !== turn) {
      this.turnEventsFiredFor = turn;
      yield* this.fireFlow(`turn ${turn}`);
      yield* this.fireFlow('new turn');
    }
    yield* this.fireFlow('side turn');
    yield* this.fireFlow(`side ${side} turn`);
    yield* this.fireFlow(`side turn ${turn}`);
    yield* this.fireFlow(`side ${side} turn ${turn}`);
  }

  /** `do_init_side`'s `turn refresh` events, then `clear_shroud(side, true)` so vision is accurate. */
  private *fireTurnRefreshEvents(side: number): Flow {
    const turn = this.turnNumber;
    yield* this.fireFlow('turn refresh');
    yield* this.fireFlow(`side ${side} turn refresh`);
    yield* this.fireFlow(`turn ${turn} refresh`);
    yield* this.fireFlow(`side ${side} turn ${turn} refresh`);
    clearShroud(this.board, side, { resetFog: true, raise: this.raiseEvent });
    yield* this.pumpEventsFlow();
  }

  /** `play_controller::finish_side_turn_events`. */
  private *fireSideTurnEndEvents(side: number): Flow {
    const turn = this.turnNumber;
    clearShroud(this.board, side, { raise: this.raiseEvent });
    yield* this.fireFlow('side turn end');
    yield* this.fireFlow(`side ${side} turn end`);
    yield* this.fireFlow(`side turn ${turn} end`);
    yield* this.fireFlow(`side ${side} turn ${turn} end`);
    // Refog only after all of the side's own events are done.
    recalculateFog(this.board, side, this.raiseEvent);
    yield* this.pumpEventsFlow();
  }

  /**
   * The live board's units, in `SnapshotUnit` shape, for re-rendering via
   * `SnapshotBoard.updateUnits`. Looks the sprite path up straight from
   * `snapshot.unitTypes` (covers every real type the snapshot ships, not
   * just the ones pre-placed at t=0) rather than a t=0-only cache, since
   * `runStartupEvents` can put units of types never listed in the
   * snapshot's original `units` array onto the board.
   */
  get renderUnits(): SnapshotUnit[] {
    const playerTeam = this.board.getTeam(this.playerSide);
    return this.board
      .allUnits()
      .filter((u) => !playerTeam || isUnitVisibleToTeam(this.board, u, playerTeam, false))
      .map((u) => this.toSnapshotUnit(u, u.location.x, u.location.y, u.hitpoints));
  }

  /**
   * `toSnapshotUnit` for exactly one live unit -- for
   * `GameBoardView.ensureUnitVisual` (bugs5.md #3): creating a
   * just-recruited/recalled unit's visual on demand, ahead of the next
   * full `renderUnits`-driven sync, needs the same real `SnapshotUnit`
   * shape `renderUnits` itself builds for every unit.
   *
   * `at` overrides where the visual is created. A caller replaying an AI
   * turn's animations needs it: the whole turn has already resolved, so
   * the unit's live hex is where it *ended up*, not where the action
   * being animated happened (see `AiAnimationEvent`'s own doc comment on
   * the same rule for cue locations).
   */
  snapshotUnitFor(unit: Unit, at?: Location): SnapshotUnit {
    const where = at ?? unit.location;
    return this.toSnapshotUnit(unit, where.x, where.y, unit.hitpoints);
  }

  /**
   * Shared by `renderUnits` (live position/hp) and `messageUnitSnapshot` (a
   * checkpoint's captured position/hp) -- every OTHER field (type, side,
   * abilities, etc.) is read straight off `unit` since none of them change
   * mid-startup-event.
   *
   * Real, reported bug: the moves-left orb (`SnapshotBoard.updateIcons`)
   * shows whenever `movesLeft`/`maxMoves`/`attacksLeft`/`maxAttacksPerTurn`
   * are present on the `SnapshotUnit`, which used to be true for EVERY
   * unit regardless of side -- so enemy (and any other non-viewing-player)
   * units showed the same green/yellow/red orb as the player's own, even
   * though that orb is meaningless information about a side that isn't
   * even the player's to command. Real Wesnoth only shows it for the
   * viewing player's own units by default. Left `undefined` for anyone
   * else, matching how `SnapshotUnit`'s own fields already document this
   * convention (`updateIcons`'s "present = draw it" contract).
   */
  private toSnapshotUnit(unit: Unit, x: number, y: number, hitpoints: number): SnapshotUnit {
    const isOwnUnit = unit.side === this.playerSide;
    const { canMove, canAttackHere } = isOwnUnit ? unitCanAct(this.board, unit) : { canMove: undefined, canAttackHere: undefined };
    return {
      id: unit.id || null,
      name: unit.name || null,
      typeId: unit.type.id,
      image: this.snapshot.unitTypes[unit.type.id]?.image ?? null,
      flagRgb: this.snapshot.unitTypes[unit.type.id]?.flagRgb,
      facing: unit.facing,
      side: unit.side,
      x,
      y,
      canRecruit: unit.canRecruit,
      hitpoints,
      maxHitpoints: unit.maxHitpoints,
      experience: unit.experience,
      maxExperience: unit.maxExperience,
      level: unit.type.level,
      canAdvance: unit.type.advancesTo.length > 0,
      movesLeft: isOwnUnit ? unit.movesLeft : undefined,
      maxMoves: isOwnUnit ? unit.maxMoves : undefined,
      attacksLeft: isOwnUnit ? unit.attacksLeft : undefined,
      maxAttacksPerTurn: isOwnUnit ? unit.maxAttacksPerTurn : undefined,
      canMove,
      canAttackHere,
      statuses: [...unit.statuses],
      loyal: unit.loyal,
      underlyingId: this.renderKeyFor(unit),
    };
  }

  /**
   * The raw (fully-flattened, real) `[unit_type]` config for `typeId`, as
   * JSON -- for callers that need something `UnitType.ts` deliberately
   * doesn't parse (currently just animation: `UnitType.ts`'s own module
   * doc comment excludes `[*_anim]`/`[defend]`/`[death]` blocks from what
   * it extracts). Renderer-agnostic on purpose (this module has no
   * `@wesnothweb2/renderer` dependency) -- callers reconstruct a
   * `WmlConfig` via `WmlConfig.fromJSON` and feed it to that package's
   * `parseUnitAnimations` themselves (see `GameShell.svelte`).
   */
  rawUnitTypeConfig(typeId: string): WmlConfigJson | undefined {
    return this.snapshot.unitTypeConfigs?.[typeId];
  }

  unitDisplayName(u: Unit): string {
    return u.name || u.type.name || u.type.id;
  }

  /** Builds a `SelectedUnitInfo` view-model for any live unit currently on the board -- see `buildUnitInfo`. */
  unitInfo(u: Unit): SelectedUnitInfo {
    return buildUnitInfo(this.board, u, this.unitDisplayName(u), this.snapshot.unitTypes[u.type.id]?.image ?? null);
  }

  private computeAttackCandidates(unit: Unit): Unit[] {
    if (unit.attacksLeft <= 0) return [];
    const team = this.board.getTeam(unit.side);
    if (!team) return [];
    const targets: Unit[] = [];
    for (const adj of getAdjacentTiles(unit.location)) {
      const other = getVisibleUnit(this.board, adj, team, false);
      if (!other) continue;
      const otherTeam = this.board.getTeam(other.side);
      if (otherTeam && team.isEnemy(otherTeam)) targets.push(other);
    }
    return targets;
  }

  /** Selects `unit` and (re)computes its move/attack/recruit options. Clears any pending attack/recruit, and any unrelated unit inspection. */
  selectUnit(unit: Unit): void {
    this.pendingAttack = null;
    this.pendingRecruitTypeId = null;
    this.pendingRecallIndex = null;
    this.inspectedUnit = null;
    this.selectedUnit = unit;
    if (unit.movesLeft > 0) {
      const { destinations } = reachableHexes(this.board, unit, { viewingTeam: this.board.getTeam(unit.side) });
      const ownLoc = unit.location;
      this.reachable = destinations
        .values()
        .map((step) => ({
          x: step.curr.x,
          y: step.curr.y,
          defensePercent: 100 - unit.defenseModifier(this.board.map.getTerrain(step.curr)),
        }))
        .filter((h) => !(h.x === ownLoc.x && h.y === ownLoc.y));
    } else {
      this.reachable = [];
    }
    this.attackCandidates = this.computeAttackCandidates(unit);
  }

  clearSelection(): void {
    this.selectedUnit = null;
    this.inspectedUnit = null;
    this.reachable = [];
    this.attackCandidates = [];
    this.pendingAttack = null;
    this.pendingRecruitTypeId = null;
    this.pendingRecallIndex = null;
  }

  /** Mirrors `game_state::can_recruit_on`-adjacent logic: vacant castle tiles connected to `unit`'s keep, if it's a leader standing on one. See `recruit.ts`'s `connectedCastleTiles`/`findVacantCastleTile`. */
  private computeRecruitTiles(unit: Unit): HexPoint[] {
    if (!unit.canRecruit || !this.board.map.isKeep(unit.location)) return [];
    return connectedCastleTiles(this.board, unit.location)
      .filter((loc) => !this.board.hasUnitAt(loc))
      .map((loc) => ({ x: loc.x, y: loc.y }));
  }

  /**
   * The active side's own recruiting leader -- on a keep, with at least
   * one vacant connected castle tile -- independent of `selectedUnit`.
   * Real, reported bug (bugs4.md #4/#5/#6/#8): recruiting/recalling (and
   * even the "Recruit"/"Recall" UI showing up at all) used to require the
   * leader to be the CURRENTLY SELECTED unit, which doesn't match real
   * Wesnoth -- recruiting is a side-level action available any time it's
   * your turn and your leader is correctly positioned, regardless of
   * what's selected on screen right now. If more than one of the side's
   * units can recruit, the first one found wins (real content this
   * project targets has exactly one leader per side per scenario).
   */
  private get recruitingLeader(): Unit | null {
    return (
      this.board
        .allUnits()
        .find((u) => u.side === this.activeSide && u.canRecruit && this.computeRecruitTiles(u).length > 0) ?? null
    );
  }

  /** Vacant castle tiles the active side's recruiting leader (see `recruitingLeader`) could recruit/recall onto -- empty if there's no such leader right now. Deliberately NOT tied to `selectedUnit` -- see `recruitingLeader`'s own doc comment. Feeds the context menu's "is this hex a valid recruit/recall target" check and `tryRecruitAt`/`tryRecallAt`'s own validation -- NOT the board's visual highlight, see `boardRecruitTiles` below. */
  get recruitTiles(): HexPoint[] {
    const leader = this.recruitingLeader;
    return leader ? this.computeRecruitTiles(leader) : [];
  }

  /**
   * Vacant castle tiles to highlight green on the BOARD -- unlike
   * `recruitTiles` above, this IS tied to `selectedUnit`: real, reported
   * bug (bugs5.md #4): after `recruitTiles` itself stopped depending on
   * selection (bugs4.md #4, so the Recruit context-menu entry/dialog work
   * without the leader being selected), the board's green highlight
   * started showing constantly too, any time the active side merely HAD a
   * recruiting leader somewhere -- distracting clutter real Wesnoth
   * doesn't have (it only highlights recruit tiles once you've actually
   * selected your leader). Empty unless `selectedUnit` itself is a valid
   * recruiting leader.
   */
  get boardRecruitTiles(): HexPoint[] {
    const sel = this.selectedUnit;
    if (!sel || sel.side !== this.activeSide || !sel.canRecruit) return [];
    return this.computeRecruitTiles(sel);
  }

  /** The active side's real recruitable types (cost/name/image from `snapshot.unitTypes`), if it currently has a leader able to recruit. Empty otherwise. */
  get recruitOptions(): RecruitOption[] {
    const leader = this.recruitingLeader;
    if (!leader) return [];
    const team = this.board.getTeam(leader.side);
    if (!team) return [];
    return [...team.canRecruit].map((typeId) => {
      const snap = this.snapshot.unitTypes[typeId];
      const cost = snap?.cost ?? 0;
      const type = this.resolveType(typeId);
      return {
        typeId,
        // The engine-parsed name, not the snapshot's scalar copy: only
        // the former has the translation context stripped (see
        // `stripTranslationContext`), and the snapshots committed under
        // apps/web/public/scenarios/ were built before that existed.
        name: type.name || snap?.name || typeId,
        cost,
        image: snap?.image ?? null,
        affordable: team.gold >= cost,
        level: type.level,
        alignment: type.alignment,
        raceId: type.raceId,
        hitpoints: type.hitpoints,
        moves: type.movement,
        attacks: type.attacks.map(buildWeaponInfo),
        abilities: type.abilities.map(buildAbilityInfo),
      };
    });
  }

  /** Arms (or, called again with the same id, disarms) a pending recruit -- the next click on one of `recruitTiles` places it. Clears any pending recall (mutually exclusive, see `pendingRecallIndex`). */
  selectRecruitType(typeId: string | null): void {
    this.pendingRecruitTypeId = this.pendingRecruitTypeId === typeId ? null : typeId;
    this.pendingRecallIndex = null;
  }

  /**
   * The active side's current recall list, if it currently has a leader
   * able to recruit/recall (same gating as `recruitOptions` -- see
   * `recruitingLeader`'s own doc comment on why this is independent of
   * `selectedUnit`). See `RecallOption`'s own doc comment for why `index`
   * (not `underlyingId`) is the selection key.
   */
  get recallOptions(): RecallOption[] {
    const leader = this.recruitingLeader;
    if (!leader) return [];
    const team = this.board.getTeam(leader.side);
    if (!team) return [];
    return this.board.recallList(leader.side).map((u, index) => {
      const cost = u.type.recallCost >= 0 ? u.type.recallCost : team.recallCost;
      const snap = this.snapshot.unitTypes[u.type.id];
      return {
        index,
        name: this.unitDisplayName(u),
        typeId: u.type.id,
        image: snap?.image ?? null,
        hp: u.hitpoints,
        maxHp: u.maxHitpoints,
        level: u.level,
        cost,
        affordable: team.gold >= cost,
        xp: u.experience,
        maxXp: u.maxExperience,
        traits: u.traitNames,
        alignment: u.type.alignment,
        raceId: u.type.raceId,
        movesLeft: u.movesLeft,
        maxMoves: u.maxMoves,
        attacks: u.attacks.map(buildWeaponInfo),
        abilities: u.type.abilities.map(buildAbilityInfo),
      };
    });
  }

  /** Arms (or, called again with the same index, disarms) a pending recall -- the next click on one of `recruitTiles` places it. Clears any pending recruit (mutually exclusive, see `pendingRecruitTypeId`). */
  selectRecallUnit(index: number | null): void {
    this.pendingRecallIndex = this.pendingRecallIndex === index ? null : index;
    this.pendingRecruitTypeId = null;
  }

  /**
   * Permanently removes the recall-list entry at `index` (the real
   * dialog's "Dismiss unit" button) -- see `dismissUnitAt`'s own doc
   * comment for why `index`, not `underlyingId`, is the safe key here.
   * Clears any pending recall armed for that same index (dismissing the
   * unit you were about to place makes that armed state meaningless).
   */
  dismissRecallUnit(index: number): void {
    const leader = this.recruitingLeader;
    if (!leader) return;
    const removed = dismissUnitAt(this.board, leader.side, index);
    if (removed && this.pendingRecallIndex === index) this.pendingRecallIndex = null;
  }

  /** Real Wesnoth's recall-dialog "Rename" action: sets a recall-list unit's display name directly (`Unit.name` is plain mutable data -- no engine action needed). No-op if `name` is empty (a blank name isn't a real rename, just noise). */
  renameRecallUnit(index: number, name: string): void {
    const leader = this.recruitingLeader;
    if (!leader) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const unit = this.board.recallList(leader.side)[index];
    if (unit) unit.name = trimmed;
  }

  /**
   * Places `typeId` at `loc` for the active side's recruiting leader (see
   * `recruitingLeader`), mirroring `actions::recruit_unit` (`recruitUnit`)
   * after validating the click. Deliberately does NOT change
   * `selectedUnit` (real, reported bug bugs5.md #1: this used to
   * re-select the leader afterward "to refresh recruitTiles/
   * attackCandidates", a rationale that stopped applying once those
   * became selection-independent getters -- see `recruitingLeader`'s own
   * doc comment -- so it was just an unwanted, un-asked-for selection
   * change, most noticeable recruiting via the context menu with nothing
   * selected beforehand).
   *
   * Deliberately does NOT use `checkRecruitLocation` here, despite it
   * being the closer upstream analogue (`check_recruit_location`) --
   * that function's `'alternate_location'` result *silently substitutes a
   * different vacant castle tile* when the requested one isn't valid
   * (upstream uses it for recruit flows with no specific target, e.g. an
   * AI or a keyboard-shortcut "recruit" command with no clicked hex). This
   * UI's recruit flow always has a specific, player-clicked hex -- the one
   * they clicked, highlighted because it was already a real member of
   * `recruitTiles` (built from the real `connectedCastleTiles`) -- so
   * silently teleporting the new unit to some OTHER tile if the click
   * misses would be a surprising, un-asked-for placement. Validating
   * against `recruitTiles` directly instead means the placement always
   * matches exactly what the player clicked, or is rejected outright.
   */
  private *tryRecruitAt(typeId: string, loc: Location): Flow<string | null> {
    const leader = this.recruitingLeader;
    if (!leader) return null;
    const team = this.board.getTeam(leader.side);
    if (!team) return null;
    const typeSnap = this.snapshot.unitTypes[typeId];
    const name = typeSnap?.name ?? typeId;
    const cost = typeSnap?.cost ?? 0;

    if (!this.recruitTiles.some((t) => t.x === loc.x && t.y === loc.y)) {
      return `Cannot recruit ${name} there.`;
    }
    if (team.gold < cost) {
      return `Not enough gold to recruit ${name} (needs ${cost}, have ${team.gold}).`;
    }
    const type = this.resolveType(typeId);
    const leaderLocation = leader.location;
    const result = recruitUnit(this.board, team, type, loc, leaderLocation, this.rng, this.raiseEvent);
    const message = `Recruited ${name} for ${result.cost} gold.`;
    this.log.unshift(message);
    // The new unit appears before the `recruit` event's own dialogue --
    // same reasoning as the walk in `moveSelectedTo`.
    yield { kind: 'beat', beat: { kind: 'unitAppear', unit: result.unit, by: leader } };
    this.eventPump.raise('recruit', loc, leader.location);
    yield* this.pumpEventsFlow();
    return message;
  }

  /**
   * Places recall-list entry `index` (see `RecallOption.index`) at `loc`
   * for the active side's recruiting leader, mirroring `tryRecruitAt` but for an
   * already-existing `Unit` pulled off `board.recallList` (via the real
   * `recallUnit`, which keeps its saved hp/level rather than healing it to
   * full -- see `recruit.ts`'s `placeRecruit`'s own doc comment). Same
   * deliberate "no `checkRecruitLocation` alternate-location fallback" call
   * as `tryRecruitAt` -- see that method's own doc comment.
   */
  private *tryRecallAt(index: number, loc: Location): Flow<string | null> {
    const leader = this.recruitingLeader;
    if (!leader) return null;
    const team = this.board.getTeam(leader.side);
    if (!team) return null;
    const list = this.board.recallList(leader.side);
    const unit = list[index];
    if (!unit) return null;
    const name = this.unitDisplayName(unit);
    const cost = unit.type.recallCost >= 0 ? unit.type.recallCost : team.recallCost;

    if (!this.recruitTiles.some((t) => t.x === loc.x && t.y === loc.y)) {
      return `Cannot recall ${name} there.`;
    }
    if (team.gold < cost) {
      return `Not enough gold to recall ${name} (needs ${cost}, have ${team.gold}).`;
    }
    // `list` is the board's own live recall-list array (see `GameBoard.recallList`'s
    // doc comment), so splicing it directly removes exactly the entry the
    // player selected -- deliberately not `removeFromRecallList`'s
    // `underlyingId` lookup, which is unsafe here (see `RecallOption.index`'s
    // own doc comment on why: most recall-list units share `underlyingId=0`).
    list.splice(index, 1);
    const leaderLocation = leader.location;
    const result = recallUnit(this.board, team, unit, loc, leaderLocation, undefined, this.raiseEvent);
    const message = `Recalled ${name} for ${result.cost} gold.`;
    this.log.unshift(message);
    yield { kind: 'beat', beat: { kind: 'unitAppear', unit: result.unit, by: leader } };
    this.eventPump.raise('recall', loc, leader.location);
    yield* this.pumpEventsFlow();
    return message;
  }

  /**
   * Cycles to the next side in ascending side-number order (wrapping past
   * the highest side back to the lowest, which is also when `turnNumber`
   * increments), refreshing that side's units' moves/attacks to full --
   * mirroring a real "start of turn" refresh (see this project's own
   * `Unit.create`/`Unit.fromConfig` defaults for what "full" means).
   *
   * ## Hotseat, plus a real AI for `controller=ai` sides
   *
   * Phase 7 shipped a heuristic AI (`simpleAi.ts`); Phase 29 replaced it
   * with `this.aiManager` (`packages/engine/src/ai/manager.ts`), the real
   * upstream candidate-action/aspect framework. `endTurn` auto-plays any
   * `ai`/`network_ai`-controlled side immediately upon reaching it,
   * looping through any further consecutive AI sides, and only returns
   * once a human-controlled side is reached (or the scenario ends).
   * `activeSide` (not `playerSide`) still gates who can be selected/
   * moved/attacked/recruited with in `handleHexClick`, for any side a
   * human ends up controlling (including a `human`-controlled side that
   * isn't `playerSide` -- true hotseat, unchanged from before).
   */
  async endTurn(maxAiSideTurns = 1000): Promise<string> {
    return this.drive(this.endTurnFlow(maxAiSideTurns));
  }

  private *endTurnFlow(maxAiSideTurns: number): Flow<string> {
    const aiAnimations: AiAnimationEvent[] = [];
    const healOutcomes: HealOutcome[] = [];
    let message = yield* this.advanceOneTurn(healOutcomes);
    if (!message) return '';
    // Auto-play consecutive AI-controlled sides. Bounded by `sides.length`
    // guard-multiples rather than true unbounded recursion, so a
    // fully-AI-vs-AI scenario can't blow the call stack turn-by-turn --
    // capped generously (1000, `maxAiSideTurns`'s default) since a real
    // game is turns=<=100ish and this only loops once per side-turn, not
    // per AI action. A caller driving an all-AI scenario with its own
    // turn budget (`packages/ui/scripts/ai-benchmark.ts`) can pass a
    // smaller cap to get control back before that -- this does NOT mean
    // the scenario ended (`scenarioResult` stays `null`); the caller
    // decides what an un-ended, capped-out game counts as.
    for (let guard = 0; guard < maxAiSideTurns && !this.scenarioResult; guard++) {
      const team = this.board.getTeam(this.activeSide);
      if (!team || (team.controller !== 'ai' && team.controller !== 'network_ai')) break;
      this.playAiSide(this.activeSide, aiAnimations);
      if (this.scenarioResult) break;
      const next = yield* this.advanceOneTurn(healOutcomes);
      if (!next) break;
      message = next;
    }
    this.lastAiAnimations = aiAnimations.length > 0 ? aiAnimations : null;
    this.lastHealAnimations = healOutcomes.length > 0 ? healOutcomes : null;
    return message;
  }

  /**
   * Runs `aiManager.playTurn` for `side`, logs what it did, and appends
   * every real animation event it produced to `outAnimations` (see
   * `endTurn`'s own doc comment on why these accumulate across possibly
   * several consecutive AI sides). Public (not just `endTurn`'s own
   * internal use) so a caller driving an all-AI scenario from the very
   * start (e.g. `packages/ui/scripts/ai-benchmark.ts`) can play side 1's
   * own first turn before ever calling `endTurn()` -- `endTurn()` itself
   * only ever plays the side it advances TO, never the one it starts on,
   * so a from-scratch session's side 1 needs one explicit call here if it
   * too is AI-controlled.
   */
  playAiSide(side: number, outAnimations: AiAnimationEvent[]): void {
    // An AI side resolves its whole turn before any of it is animated
    // (see `AiAnimationEvent`), so its events cannot block on the player
    // the way a human's can: anything they raise is answered inline and
    // collected for the caller to show afterwards. See
    // `takeDeferredInteractions`.
    runFlow(this.fireFlow('ai turn'), this.collectResponder); // mirrors manager::play_turn's own pre-turn event, real content hooks WML on it.
    const actions: AiAction[] = this.aiManager.playTurn(side);
    for (const action of actions) {
      if (action.message) this.log.unshift(action.message);
      if (action.animation) outAnimations.push(action.animation);
    }
    this.pumpEvents();
  }

  /**
   * Advances `activeSide` to the next side in turn order (wrapping back to
   * the lowest side, which is also when `turnNumber` increments),
   * refreshing that side's units' moves/attacks to full, applying income/
   * upkeep and the real healing pass, and logging/returning the new
   * turn's banner message. Pulled out of `endTurn` so it can be called
   * once per side-turn, including once per AI side `endTurn` auto-plays
   * through -- see `endTurn`'s own doc comment. Any real heal/poison
   * outcomes this side-transition's turn-start healing pass produced are
   * appended to `outHealOutcomes` (see `lastHealAnimations`'s own doc
   * comment), mirroring `playAiSide`'s identical `outAnimations` pattern.
   */
  private *advanceOneTurn(outHealOutcomes: HealOutcome[]): Flow<string | null> {
    if (this.scenarioResult) return null;
    this.clearSelection();
    yield* this.fireSideTurnEndEvents(this.activeSide);
    if (this.scenarioResult) return null;
    const sides = this.board
      .teams()
      .map((t) => t.side)
      .sort((a, b) => a - b);
    const idx = sides.indexOf(this.activeSide);
    const wrapped = idx === -1 || idx === sides.length - 1;
    const nextSide = wrapped ? sides[0] : sides[idx + 1];
    if (nextSide === undefined) return null;
    if (wrapped) {
      yield* this.fireFlow('turn end');
      yield* this.fireFlow(`turn ${this.turnNumber} end`);
      this.checkForGameEnd();
      if (this.scenarioResult) return null;
      this.turnNumber += 1;
    }
    this.activeSide = nextSide;
    yield* this.fireSideTurnEvents(nextSide);
    this.checkForGameEnd();
    if (this.scenarioResult) return null;
    for (const unit of this.board.unitsForSide(nextSide)) {
      unit.movesLeft = unit.maxMoves;
      unit.attacksLeft = unit.maxAttacksPerTurn;
      // unit::new_turn: ambushers revealed last turn can hide again.
      unit.setStatus('uncovered', false);
    }
    // Income/upkeep: mirrors `play_controller::play_side`'s
    // `if (turn() > 1) { current_team().new_turn(); ... }` -- the very
    // first turn of the whole game (turn 1, every side's first go) grants
    // no income and charges no upkeep; from turn 2 onward, a side's gold
    // is adjusted the moment its turn begins. `team::new_turn` itself is
    // `gold += total_income()` where `total_income() = base_income() +
    // villages*village_gold`, and `base_income() = income= (raw WML,
    // default 0) + game_config::base_income` (a hardcoded 2, NOT
    // WML-configurable upstream -- see wesnoth/src/game_config.cpp).
    // Upkeep separately mirrors `play_controller.cpp`'s
    // `expense = side_upkeep - support(); if (expense > 0) spend_gold(expense)`:
    // `side_upkeep` sums `unit::upkeep()` (a unit's level, or 0 for a
    // leader -- `can_recruit()` -- per `unit.cpp`), and `support()` is
    // `villages * village_support`.
    if (this.turnNumber > 1) {
      const team = this.board.getTeam(nextSide);
      if (team) {
        team.applyIncome(this.totalIncomeFor(nextSide));
        const expense = this.upkeepExpenseFor(nextSide);
        if (expense > 0) team.spendGold(expense);
      }
    }
    // Rest/village healing, poison damage, and real heals=/regenerate=
    // ability healing: mirrors `play_controller.cpp`'s
    // `if (do_healing()) { calculate_healing(current_side(), ...); }`.
    // Unlike income above, this is NOT gated on `turnNumber > 1` --
    // upstream's own `do_healing()` flag starts false and is set true
    // right after the very first check, so only the whole game's very
    // first side-turn (side 1, turn 1 -- the state this session starts in
    // BEFORE any endTurn() call) is exempt; every side reached via an
    // actual endTurn() call, including side 2's own first turn, gets a
    // real healing pass. `applySideHealing` (`actions/heal.ts`) covers
    // rest heal, village heal, poison damage/curing, and real `[heals]`/
    // `[regenerate]` ability healing in one real-content-driven pass.
    const healOutcomes = applySideHealing(this.board, nextSide).filter((o) => o.amount !== 0 || o.curePoison);
    for (const outcome of healOutcomes) {
      const name = this.unitDisplayName(outcome.unit);
      if (outcome.amount > 0) {
        const healerNote = outcome.healers.length > 0 ? ` (${outcome.healers.map((h) => this.unitDisplayName(h)).join(', ')})` : '';
        this.log.unshift(`${name} heals ${outcome.amount} HP${healerNote}.`);
      } else if (outcome.amount < 0) {
        this.log.unshift(`${name} takes ${-outcome.amount} poison damage.`);
      }
      if (outcome.curePoison) this.log.unshift(`${name}'s poison is cured.`);
    }
    outHealOutcomes.push(...healOutcomes);
    // "Set resting now after the healing has been done" (play_controller.cpp):
    // each unit's `resting` flag reflects whether it moved/attacked during
    // its OWN just-finished turn (moving sets it false in executeMove,
    // attacking sets it false in executeAttack), and the healing pass just
    // above already consumed that value. Reset it true for every one of
    // this side's units now, so a unit that rests THIS turn earns the
    // heal at the START OF ITS NEXT turn -- real, reported bug: units that
    // neither moved nor attacked never got the rest-heal, because nothing
    // in this engine ever set `resting` true in the first place (it starts
    // false and combat.ts only ever clears it further).
    for (const unit of this.board.unitsForSide(nextSide)) {
      unit.resting = true;
    }
    yield* this.fireTurnRefreshEvents(nextSide);
    if (this.scenarioResult) return null;
    const teamName = this.board.getTeam(nextSide)?.teamName ?? String(nextSide);
    const message = `Turn ${this.turnNumber} -- side ${nextSide} (${teamName})'s turn.`;
    this.log.unshift(message);
    return message;
  }

  /** `team::total_income()`: `income=` (raw WML) + the hardcoded base + villages*village_gold. Shared by `endTurn` (which applies it) and `economyInfo` (which previews it). */
  private totalIncomeFor(side: number): number {
    const team = this.board.getTeam(side);
    if (!team) return 0;
    return team.income + GameSession.BASE_INCOME + this.board.villageCount(side) * team.incomePerVillage;
  }

  /** `side_upkeep - team::support()`, mirroring `play_controller.cpp`'s expense calculation -- NOT clamped to zero here, since `endTurn` needs to know whether it's actually positive before spending. */
  private upkeepExpenseFor(side: number): number {
    const team = this.board.getTeam(side);
    if (!team) return 0;
    const upkeep = this.board.unitsForSide(side).reduce((sum, unit) => sum + (unit.canRecruit ? 0 : unit.level), 0);
    const support = this.board.villageCount(side) * team.supportPerVillage;
    return upkeep - support;
  }

  /** The active side's economy figures for the side panel -- see `EconomyInfo`'s own doc comment on each field. */
  get economyInfo(): EconomyInfo {
    const team = this.board.getTeam(this.activeSide);
    const expense = this.upkeepExpenseFor(this.activeSide);
    const upkeepTotal = this.board.unitsForSide(this.activeSide).reduce((sum, unit) => sum + (unit.canRecruit ? 0 : unit.level), 0);
    return {
      startGold: team?.startGold ?? 0,
      incomePerVillage: team?.incomePerVillage ?? 0,
      villagesOwned: this.board.villageCount(this.activeSide),
      netIncome: this.turnNumber > 1 ? this.totalIncomeFor(this.activeSide) - Math.max(0, expense) : 0,
      upkeepTotal,
      upkeepCharged: Math.max(0, expense),
      unitCount: this.board.unitsForSide(this.activeSide).length,
    };
  }

  /**
   * Remembers, per village, the last owner seen while that hex was NOT
   * fogged for `playerSide` -- mirrors upstream's own "under fog you see
   * the last-known owner, not the current one" rule (`display.cpp`'s
   * `draw_villages`/`draw_flag`, both gated on `!fogged(loc) ||
   * !viewing_team().is_enemy(...)`). Updated by `syncVillageMemory`,
   * called after every action that can move the game forward.
   */
  private readonly lastKnownVillageOwner = new Map<string, number>();

  private syncVillageMemory(): void {
    for (const loc of this.board.map.villages) {
      if (this.board.isFogged(this.playerSide, loc)) continue;
      const side = this.board.villageOwner(loc);
      if (side !== undefined) this.lastKnownVillageOwner.set(loc.key(), side);
      else this.lastKnownVillageOwner.delete(loc.key());
    }
  }

  /** Every village whose owner is known to `playerSide` (current if visible, else last-known under fog), for the board's live ownership-flag markers -- unowned villages are omitted (nothing to mark; the terrain colour alone already shows "this is a village," see `SnapshotBoard`'s own doc comment). */
  get villageOwnership(): VillageOwnerInfo[] {
    const result: VillageOwnerInfo[] = [];
    for (const loc of this.board.map.villages) {
      const side = this.board.isFogged(this.playerSide, loc) ? this.lastKnownVillageOwner.get(loc.key()) : this.board.villageOwner(loc);
      if (side !== undefined) result.push({ x: loc.x, y: loc.y, side });
    }
    return result;
  }

  /**
   * Per-hex shroud/fog state for `playerSide`, feeding the board's fog
   * overlay (`SnapshotBoard.updateFogShroud`). Empty when the player's
   * side uses neither -- the overwhelmingly common case -- so a scenario
   * without `shroud=`/`fog=` pays nothing extra to render.
   */
  get hexVisibility(): HexVisibilityPoint[] {
    const team = this.board.getTeam(this.playerSide);
    if (!team || !team.fogOrShroud()) return [];
    const result: HexVisibilityPoint[] = [];
    // Includes the one-hex border ring beyond the playable area (same
    // -1..w()/-1..h() range `SnapshotBoard.renderTerrain` builds terrain
    // containers for) -- real, reported bug: without this, a border hex
    // just past a shrouded map edge always rendered fully revealed (no
    // overlay computed for it at all), breaking the illusion right at the
    // map's own boundary. `ShroudClearer.clearLoc` already extends real
    // vision-clearing into this same ring (`map.onBoardWithBorder`), so
    // `isShrouded`/`isFogged` already track it correctly -- this was a
    // pure rendering gap, not a missing engine feature.
    for (let x = -1; x <= this.board.map.w(); x++) {
      for (let y = -1; y <= this.board.map.h(); y++) {
        const loc = new Location(x, y);
        const visibility: HexVisibility = this.board.isShrouded(this.playerSide, loc) ? 'shrouded' : this.board.isFogged(this.playerSide, loc) ? 'fogged' : 'clear';
        result.push({ x, y, visibility });
      }
    }
    return result;
  }

  /**
   * Every weapon index `attacker` could actually use against a target 1 hex
   * away -- mirrors upstream's own attack-weapon-choice dialog, which only
   * offers weapons whose `range=`/min_range=/max_range= cover the real
   * distance to the target (this project's combat is adjacency-only, so
   * distance is always 1 -- see `buildPreview`'s own comment). A unit with
   * only one usable weapon (the common case) gets a list of exactly one,
   * so callers don't need a separate "does this unit even have a choice"
   * branch.
   */
  private viableAttackerWeaponIndices(attacker: Unit): number[] {
    const distance = 1;
    return attacker.attacks
      .map((weapon, index) => ({ weapon, index }))
      .filter(({ weapon }) => weapon.numAttacks > 0 && weapon.minRange <= distance && distance <= weapon.maxRange)
      .map(({ index }) => index);
  }

  private buildPreview(attacker: Unit, defender: Unit, attackerWeaponIndex: number): PendingAttack {
    const attackerWeapon = attacker.attacks[attackerWeaponIndex];
    if (!attackerWeapon) {
      throw new Error(`buildPreview: attacker has no weapon at index ${attackerWeaponIndex}`);
    }
    const distance = 1; // caller guarantees adjacency (attackCandidates is adjacency-filtered).
    const attackerTerrainDefense = attacker.defenseModifier(this.board.map.getTerrain(attacker.location));
    const defenderTerrainDefense = defender.defenseModifier(this.board.map.getTerrain(defender.location));

    const defenderWeaponIndex = chooseDefenderWeaponIndex(
      attacker,
      attackerWeaponIndex,
      defender,
      distance,
      attackerTerrainDefense,
      defenderTerrainDefense,
    );
    const defenderWeapon = defenderWeaponIndex >= 0 ? defender.attacks[defenderWeaponIndex] : undefined;

    const attackerLawfulBonus = this.timeOfDayAt(attacker.location).lawfulBonus;
    const defenderLawfulBonus = this.timeOfDayAt(defender.location).lawfulBonus;
    // Real, reported bug: the schedule's raw `lawful_bonus` (e.g. +25% by
    // day) is NOT what a chaotic unit actually gets -- `combatModifier`
    // (the same real per-unit computation `computeUnitStats` itself
    // applies to `damageMultiplier`) flips its sign for chaotic units,
    // zeroes it for neutral, and derives a different figure entirely for
    // liminal. Displaying the raw schedule value unconditionally (as if
    // it were the applied bonus) showed "+25%" for a chaotic unit in
    // daylight even though it was actually taking a REAL 25% damage
    // PENALTY that turn -- the damage number itself was always correct;
    // only this label read the wrong sign/magnitude. `weapon.alignment ??
    // unit.type.alignment` and the hardcoded `false` (isFearless) mirror
    // `computeUnitStats`'s own call exactly, so this is always the same
    // number that's actually folded into `damagePerBlow` above.
    const attackerToDModifier = combatModifier(
      attackerLawfulBonus,
      attackerWeapon.alignment ?? attacker.type.alignment,
      false,
      this.schedule.maxLiminalBonus,
    );
    const defenderToDModifier = defenderWeapon
      ? combatModifier(defenderLawfulBonus, defenderWeapon.alignment ?? defender.type.alignment, false, this.schedule.maxLiminalBonus)
      : 0;
    // The real GEOMETRIC condition (a flanking ally-of-attacker on the far
    // side of the defender) -- feeds `buildBattleContext`'s own
    // `hasSpecialId(weapon, 'backstab')`-gated damage doubling below, same
    // as before. Real, reported bug (bugs5.md #2): this alone is NOT
    // "backstab is happening" -- the geometric condition can hold with any
    // weapon, backstab-capable or not (upstream's own combat math only
    // ever doubles damage when BOTH this AND the weapon's own special are
    // present) -- so the DISPLAYED badge (`attackerBackstabActive` below)
    // additionally requires the attacker's actual weapon to have the
    // special, matching what real Wesnoth actually applies rather than
    // just this geometric precondition for it.
    const backstabGeometry = isBackstabActive(this.board, attacker.location, defender.location);
    const attackerBackstabActive = backstabGeometry && hasSpecialId(attackerWeapon, 'backstab');
    const attackerLeadershipBonus = computeLeadershipBonus(this.board, attacker);
    const defenderLeadershipBonus = computeLeadershipBonus(this.board, defender);
    // Charge is only ever active "when used offensively" -- upstream's `active_on=offense` -- so it's
    // the ATTACKER's weapon specifically that gates it for this whole exchange (see combatStats.ts's
    // own `hasCharge` doc comment); both combatants' damage doubles when it is.
    const chargeActive = hasSpecialId(attackerWeapon, 'charge');

    const { attacker: aStats, defender: dStats } = buildBattleContext({
      attacker,
      attackerWeapon,
      defender,
      defenderWeapon,
      distance,
      attackerTerrainDefense,
      defenderTerrainDefense,
      options: {
        attackerLawfulBonus,
        defenderLawfulBonus,
        maxLiminalBonus: this.schedule.maxLiminalBonus,
        backstabActive: backstabGeometry,
        attackerLeadershipBonus,
        defenderLeadershipBonus,
        attackerResistanceModifier: computeResistanceModifier(this.board, defender, attackerWeapon.type, false, defender.location),
        defenderResistanceModifier: defenderWeapon
          ? computeResistanceModifier(this.board, attacker, defenderWeapon.type, true, attacker.location)
          : undefined,
      },
    });
    const { attacker: aCombatant, defender: dCombatant } = simulateCombat(aStats, dStats);

    /** Mirrors `computeUnitStats`'s own cth-override precedence (magical wins over marksman). */
    const chanceToHitSourceFor = (weapon: AttackType | undefined): 'magical' | 'marksman' | null => {
      if (!weapon) return null;
      if (hasSpecialId(weapon, 'magical')) return 'magical';
      if (hasSpecialId(weapon, 'marksman')) return 'marksman';
      return null;
    };

    const preview: CombatPreview = {
      attacker: {
        name: this.unitDisplayName(attacker),
        side: attacker.side,
        hp: attacker.hitpoints,
        maxHp: attacker.maxHitpoints,
        chanceToHit: aStats.chanceToHit,
        damagePerBlow: aStats.damage,
        numBlows: aStats.numBlows,
        deathChance: aCombatant.hpDist[0] ?? 0,
        weapon: buildWeaponInfo(attackerWeapon),
        typeId: attacker.type.id,
        image: this.snapshot.unitTypes[attacker.type.id]?.image ?? null,
        level: attacker.level,
        alignment: attacker.type.alignment,
        raceId: attacker.type.raceId,
        traits: attacker.traitNames,
        resistanceModifier: computeResistanceModifier(this.board, defender, attackerWeapon.type, false, defender.location),
        baseDamage: attackerWeapon.damage,
        hpDist: aCombatant.hpDist,
        lawfulBonus: attackerToDModifier,
        leadershipBonus: attackerLeadershipBonus,
        chargeActive,
        backstabActive: attackerBackstabActive,
        chanceToHitSource: chanceToHitSourceFor(attackerWeapon),
      },
      defender: {
        name: this.unitDisplayName(defender),
        side: defender.side,
        hp: defender.hitpoints,
        maxHp: defender.maxHitpoints,
        chanceToHit: dStats.chanceToHit,
        damagePerBlow: dStats.damage,
        numBlows: dStats.numBlows,
        deathChance: dCombatant.hpDist[0] ?? 0,
        weapon: defenderWeapon ? buildWeaponInfo(defenderWeapon) : undefined,
        typeId: defender.type.id,
        image: this.snapshot.unitTypes[defender.type.id]?.image ?? null,
        level: defender.level,
        alignment: defender.type.alignment,
        raceId: defender.type.raceId,
        traits: defender.traitNames,
        resistanceModifier: defenderWeapon ? computeResistanceModifier(this.board, attacker, defenderWeapon.type, true, attacker.location) : undefined,
        baseDamage: defenderWeapon?.damage,
        hpDist: dCombatant.hpDist,
        lawfulBonus: defenderToDModifier,
        leadershipBonus: defenderLeadershipBonus,
        // Charge only ever applies "when used offensively" -- the ATTACKER's own weapon gates it for
        // the whole exchange (see the comment above `chargeActive`'s computation), so the defender's
        // retaliation shares the exact same flag, not one keyed off its own weapon.
        chargeActive: defenderWeapon ? chargeActive : undefined,
        backstabActive: false, // never applies to a defender's own retaliation blow
        chanceToHitSource: chanceToHitSourceFor(defenderWeapon),
      },
    };

    return { attacker, defender, attackerWeaponIndex, defenderWeaponIndex, preview };
  }

  private *moveSelectedTo(dest: Location): Flow<string | null> {
    const unit = this.selectedUnit;
    if (!unit) return null;
    const route = findPath(this.board, unit, dest);
    if (route.steps.length === 0) return null;
    // performMove owns the executeMove + capture/moveto choreography (see
    // its own doc comment -- extracted for Phase 29 so the AI's own moves
    // get the same events).
    const { result } = performMove(this.board, unit, route.steps, { raise: this.raiseEvent });
    // Deselect before the walk, not after it. Upstream does exactly this
    // (`mouse_handler::move_unit_along_current_route`: "do not show
    // footsteps during movement" / "do not keep the hex highlighted that
    // we started from" -- it clears the route, the reach highlight and
    // the selected hex, then animates). Real, reported bug (bugs6.md):
    // the unit stayed selected throughout, so its reachable-hex overlay
    // sat on the map, anchored to the hex it had left, for the whole
    // walk. Re-selected below only when the move was cut short.
    this.clearSelection();
    // Phase 17: the walk is a cutscene beat like any other, so it plays
    // *before* whatever the `moveto`/`sighted` events it triggers have to
    // say -- the pump below would otherwise reach their dialogue while
    // the unit was still standing at its old hex on screen.
    if (result.path.length > 1) yield { kind: 'beat', beat: { kind: 'moveUnit', unit, path: result.path } };
    const name = this.unitDisplayName(unit);
    const message = result.ambushed
      ? `${name} was ambushed!`
      : result.sightedStop
        ? `${name} stopped: units sighted.`
        : `${name} moved.`;
    yield* this.pumpEventsFlow();
    if (this.scenarioResult || this.board.unitAt(unit.location) !== unit) {
      this.clearSelection();
      this.log.unshift(message);
      return message;
    }
    // A move cut short by something the player needs to react to leaves
    // the unit selected where it stopped, so its remaining options are
    // right there -- upstream re-selects the stopping hex for exactly
    // this case, and it is the one exception to the deselect above.
    if (result.ambushed || result.sightedStop) this.selectUnit(unit);
    this.log.unshift(message);
    return message;
  }

  /**
   * Handles a click on hex (x,y), applying whatever the current selection
   * state says that means (select / move / target an attack / deselect).
   * Returns a short human-readable message describing what happened (for a
   * toast/log), or `null` if the click had no visible effect.
   */
  async handleHexClick(x: number, y: number): Promise<string | null> {
    return this.drive(this.handleHexClickFlow(x, y));
  }

  private *handleHexClickFlow(x: number, y: number): Flow<string | null> {
    if (this.scenarioResult) return null;
    const loc = new Location(x, y);
    // Real, reported bug: this used to read `board.unitAt(loc)` directly,
    // which ignores fog/shroud entirely -- a player could click any hex
    // (e.g. one under shroud they've never seen) and get full info on
    // whatever unit secretly stood there. `getVisibleUnit` mirrors the same
    // fog-aware lookup `renderUnits`/AI targeting already use elsewhere in
    // this file; it always returns the player's own units regardless of
    // fog (see `isUnitVisibleToTeam`'s `team.side === unit.side` case).
    const playerTeam = this.board.getTeam(this.playerSide);
    const clickedUnit = getVisibleUnit(this.board, loc, playerTeam, false);

    if (this.pendingAttack) {
      // Any board click while an attack is pending confirmation cancels it
      // rather than doing something else with the click; Confirm/Cancel
      // buttons in the side panel are the only way to resolve it.
      this.pendingAttack = null;
      return null;
    }

    if (this.pendingRecruitTypeId) {
      const typeId = this.pendingRecruitTypeId;
      this.pendingRecruitTypeId = null;
      return yield* this.tryRecruitAt(typeId, loc);
    }

    if (this.pendingRecallIndex !== null) {
      const index = this.pendingRecallIndex;
      this.pendingRecallIndex = null;
      return yield* this.tryRecallAt(index, loc);
    }

    const sel = this.selectedUnit;
    if (sel) {
      if (clickedUnit) {
        if (clickedUnit === sel) {
          this.clearSelection();
          return null;
        }
        if (this.attackCandidates.includes(clickedUnit)) {
          const firstWeapon = this.viableAttackerWeaponIndices(sel)[0];
          if (firstWeapon === undefined) return null; // no usable weapon at this range -- shouldn't happen (computeAttackCandidates implies at least one), but don't throw on it.
          this.pendingAttack = this.buildPreview(sel, clickedUnit, firstWeapon);
          return `${this.unitDisplayName(sel)} could attack ${this.unitDisplayName(clickedUnit)} -- review the prediction and confirm.`;
        }
        if (clickedUnit.side === this.activeSide) {
          this.selectUnit(clickedUnit);
          return null;
        }
        // An enemy (or an inactive side's unit) that isn't a valid attack
        // target right now -- not actionable, but still worth showing its
        // info (addresses "no way to see information about enemy units").
        // Deliberately does NOT touch `sel`/`reachable`/`attackCandidates`:
        // the player's own selection and move/attack highlights stay put.
        this.inspectedUnit = clickedUnit;
        return `Viewing ${this.unitDisplayName(clickedUnit)}.`;
      }

      if (this.reachable.some((h) => h.x === x && h.y === y)) {
        return yield* this.moveSelectedTo(loc);
      }

      this.clearSelection();
      return null;
    }

    if (clickedUnit) {
      if (clickedUnit.side === this.activeSide) {
        this.selectUnit(clickedUnit);
      } else {
        this.inspectedUnit = clickedUnit;
        return `Viewing ${this.unitDisplayName(clickedUnit)}.`;
      }
    } else {
      this.inspectedUnit = null;
    }
    return null;
  }

  /**
   * One human-readable line per real `AttackBlowResult` -- mirrors what
   * real Wesnoth's floating combat text conveys per strike (damage number,
   * miss, poison/slow/petrify icons, a death), condensed into text since
   * this project has no animation yet (see `confirmAttack`'s own comment
   * on why this is also groundwork for Phase 10's future per-blow
   * animation playback).
   */
  private formatBlowMessage(blow: AttackBlowResult, attackerName: string, defenderName: string): string {
    const strikerName = blow.attackerTurn ? attackerName : defenderName;
    const targetName = blow.attackerTurn ? defenderName : attackerName;
    let msg = blow.hit
      ? `${strikerName} hits ${targetName} for ${blow.damage} damage (${blow.chanceToHit}% chance to hit).`
      : `${strikerName} misses ${targetName} (${blow.chanceToHit}% chance to hit).`;
    if (blow.drainAmount > 0) {
      msg += ` ${strikerName} drains ${blow.drainAmount} HP.`;
    } else if (blow.drainAmount < 0) {
      msg += blow.strikerDiedFromDrain ? ` ${strikerName} is destroyed by the drain!` : ` ${strikerName} loses ${-blow.drainAmount} HP to drain.`;
    }
    if (blow.poisoned) msg += ` ${targetName} is poisoned.`;
    if (blow.slowed) msg += ` ${targetName} is slowed.`;
    if (blow.petrified) msg += ` ${targetName} is petrified!`;
    if (blow.targetDied) msg += ` ${targetName} dies!`;
    return msg;
  }

  /** Commits the currently-pending attack via the real `executeAttack`, updating the board. */
  async confirmAttack(): Promise<string | null> {
    return this.drive(this.confirmAttackFlow());
  }

  private *confirmAttackFlow(): Flow<string | null> {
    if (this.scenarioResult) return null;
    const pending = this.pendingAttack;
    if (!pending) return null;

    const attackerLoc = pending.attacker.location;
    const defenderLoc = pending.defender.location;
    yield* this.fireFlow('attack', attackerLoc, defenderLoc);
    this.checkForGameEnd();
    if (this.scenarioResult || this.board.unitAt(attackerLoc) !== pending.attacker || this.board.unitAt(defenderLoc) !== pending.defender) {
      // The attack event ended the scenario or moved/removed a combatant: upstream aborts the attack.
      this.clearSelection();
      return null;
    }

    // Captured now, before executeAttack (below) mutates either unit's
    // hitpoints -- a caller stepping through result.blows to preview the
    // HP bar per blow (real, reported bug: it only ever updated once, at
    // the very end) needs the PRE-combat totals to run its own per-blow
    // arithmetic forward from, the same way attackerTypeId/defenderTypeId
    // below need the pre-advancement type ids.
    const attackerHitpointsBefore = pending.attacker.hitpoints;
    const defenderHitpointsBefore = pending.defender.hitpoints;

    // performAttack owns the executeAttack + last breath/die/attack end
    // choreography (see its own doc comment -- extracted for Phase 29 so
    // the AI's own attacks get the same events); firing 'attack' itself,
    // the abort check above, and pumping afterward stay here since they
    // need this session's own scenarioResult/event-pump state.
    const result = performAttack(this.board, this.rng, attackerLoc, pending.attackerWeaponIndex, defenderLoc, pending.defenderWeaponIndex, {
      attackerLawfulBonus: this.timeOfDayAt(attackerLoc).lawfulBonus,
      defenderLawfulBonus: this.timeOfDayAt(defenderLoc).lawfulBonus,
      maxLiminalBonus: this.schedule.maxLiminalBonus,
      resolveType: this.resolveType,
      raise: this.raiseEvent,
      // `last breath`/`die`, fired from inside `performAttack`'s own
      // callback: a plain function, so these cannot suspend -- their
      // messages are collected and shown after the attack animation
      // (`takeDeferredInteractions`).
      fire: (name, loc1, loc2) => this.eventPump.fire(name, loc1, loc2, undefined, this.collectResponder),
    });
    yield* this.eventPump.pumpFlow();

    this.lastAttackAnimation = {
      attacker: pending.attacker,
      attackerWeaponIndex: pending.attackerWeaponIndex,
      defender: pending.defender,
      defenderWeaponIndex: pending.defenderWeaponIndex,
      result,
      attackerHitpointsBefore,
      defenderHitpointsBefore,
      // Captured now, before advancement (below) can mutate either unit's
      // `.type` -- see LastAttackAnimation.attackerTypeId's own doc comment.
      attackerTypeId: pending.attacker.type.id,
      defenderTypeId: pending.defender.type.id,
      attackerLocation: attackerLoc,
      defenderLocation: defenderLoc,
    };

    const attackerName = pending.preview.attacker.name;
    const defenderName = pending.preview.defender.name;
    const hits = result.blows.filter((b) => b.hit).length;
    let message = `${attackerName} attacked ${defenderName}: ${hits}/${result.blows.length} blows landed.`;
    if (result.defenderDied) message += ` ${defenderName} was slain!`;
    if (result.attackerDied) message += ` ${attackerName} was slain!`;

    // One log line per blow, in the order they actually happened -- not
    // just a "N/M landed" summary. `log` is most-recent-first (see its own
    // doc comment), so blows are unshifted in chronological order: the
    // LAST blow to happen ends up closest to the top, the FIRST blow ends
    // up at the bottom of this group, and the overall summary (unshifted
    // last, below) sits above all of them as the most-recent entry. This
    // is also groundwork for animation (Phase 10): once real per-blow
    // animation playback exists, this is the same ordered sequence it'll
    // need to step through.
    for (const blow of result.blows) {
      this.log.unshift(this.formatBlowMessage(blow, attackerName, defenderName));
    }
    this.log.unshift(message);
    // A unit that has fought is done acting for this turn: real Wesnoth
    // zeroes an attacker's remaining movement after any attack (`attack.
    // cpp`'s `attack::execute` calls `set_movement(movement_left() -
    // movement_used())`, and `[attack] movement_used=` defaults to 100000
    // -- effectively "all of it," clamped to 0 by `unit::set_movement` --
    // for every weapon that doesn't explicitly override it, which none of
    // this project's real content does). This was previously only
    // *simulated* by deselecting the unit (see the comment that used to be
    // here, which claimed this without actually doing it) -- the unit's
    // own `movesLeft` was untouched, so re-selecting it after an attack
    // still showed (and allowed using) its real leftover movement. Real,
    // reported bug.
    if (!result.attackerDied) pending.attacker.movesLeft = 0;
    this.clearSelection();
    // Only combat can kill a unit in this project today (recruiting/moving
    // cannot), so this is the one place a victory/defeat check is needed --
    // checkForGameEnd() overwrites the log's top entry with the outcome
    // message if the scenario just ended, on top of the combat message
    // above (both stay in `log`, most-recent-first).
    // Real Wesnoth checks both combatants for advancement right after the
    // exchange (`attack_unit_and_advance`, actions/attack.cpp), before any
    // victory check -- a unit that just landed the kill needed to end the
    // scenario still gets to level up first.
    if (!result.attackerDied) this.queueAdvancement(pending.attacker);
    if (!result.defenderDied) this.queueAdvancement(pending.defender);
    this.processAdvancementQueue();

    if (result.defenderDied || result.attackerDied) this.checkForGameEnd();
    return this.scenarioResult ? this.log[0]! : message;
  }

  cancelAttack(): void {
    this.pendingAttack = null;
  }

  /** Pushes `unit` onto the advancement queue if it's real, reported bug (bugs2.md "unit advancement"): a unit reaching full XP never actually advanced anywhere in this project -- `actions/advancement.ts` existed but nothing called it. No-op if `unit` doesn't currently have enough XP to advance. */
  private queueAdvancement(unit: Unit): void {
    if (unit.advances()) this.advancementQueue.push(unit);
  }

  /**
   * Drains `advancementQueue`: a unit with exactly one real
   * `advances_to=` option advances immediately (no choice to make,
   * matching upstream -- the dialog only ever appears for an actual
   * choice), and -- since overflow XP can cascade straight into ANOTHER
   * advancement (`Unit.advanceTo` carries it over) -- is re-queued if it
   * still qualifies afterward. A unit with 2+ options instead sets
   * `pendingAdvancement` and stops draining; `chooseAdvancement` resumes
   * the drain once the player picks.
   */
  private processAdvancementQueue(): void {
    while (this.advancementQueue.length > 0) {
      const unit = this.advancementQueue.shift()!;
      if (!unit.advances()) continue; // healed/demoted by something else in between -- no longer eligible.
      const optionIds = unit.type.advancesTo;
      if (optionIds.length === 1) {
        const before = unit.type.name;
        const result = advanceUnitTo(unit, this.resolveType(optionIds[0]!));
        this.log.unshift(`${before} advances to ${result.unit.type.name}!`);
        if (result.canAdvanceAgain) this.advancementQueue.unshift(unit);
        continue;
      }
      const options = optionIds.map((id) => this.resolveType(id));
      this.pendingAdvancement = {
        unit,
        options,
        unitInfo: this.unitInfo(unit),
        optionInfos: options.map((type) => ({
          typeId: type.id,
          name: type.name,
          level: type.level,
          hitpoints: type.hitpoints,
          image: this.snapshot.unitTypes[type.id]?.image ?? null,
          attacks: type.attacks.map(buildWeaponInfo),
        })),
      };
      return;
    }
  }

  /**
   * Resolves the current `pendingAdvancement` to `typeId` (must be one of
   * its own `options`), logs it, and resumes draining the advancement
   * queue (the same unit re-queues itself if overflow XP lets it advance
   * again immediately).
   */
  chooseAdvancement(typeId: string): void {
    const pending = this.pendingAdvancement;
    if (!pending) return;
    const chosen = pending.options.find((t) => t.id === typeId);
    if (!chosen) return;
    const before = pending.unit.type.name;
    const result = advanceUnitTo(pending.unit, chosen);
    this.log.unshift(`${before} advances to ${result.unit.type.name}!`);
    this.pendingAdvancement = null;
    if (result.canAdvanceAgain) this.advancementQueue.unshift(pending.unit);
    this.processAdvancementQueue();
  }

  /**
   * Captures every mutable bit of live state -- see `SaveGameData`'s own
   * doc comment, and `SavedUnit`'s for why "every" is load-bearing here
   * (anything omitted silently reverts to a unit type's defaults on load).
   */
  toSaveData(): SaveGameData {
    const variables = this.eventPump.ctx.variables.toConfig().toJSON();
    return {
      version: 2,
      turnNumber: this.turnNumber,
      activeSide: this.activeSide,
      scenarioResult: this.scenarioResult,
      scenarioId: this.snapshot.scenario.id,
      scenarioName: this.snapshot.scenario.name,
      schedule: this.schedule.exportState(),
      variables,
      choices: this.eventPump.ctx.choices.map((c) => ({ ...c })),
      startupEventsRun: this.startupEventsRun,
      rng: { seed: this.mtRng.getRandomSeedStr(), calls: this.mtRng.getRandomCalls() },
      goldCarryover: this.goldCarryover,
      teams: this.board.teams().map((t) => ({
        side: t.side,
        gold: t.gold,
        shroudData: t.shroud.write(),
        fogData: t.fog.write(),
        villages: this.board.villagesOwnedBy(t.side).map((loc) => ({ x: loc.x, y: loc.y })),
      })),
      units: this.board.allUnits().map((u) => ({
        ...savedUnitFields(u),
        x: u.location.x,
        y: u.location.y,
      })),
      // Recall-list units carry no x/y, exactly as upstream writes them.
      recall: this.board.teams().flatMap((t) => this.board.recallList(t.side).map((u) => savedUnitFields(u))),
    };
  }

  /**
   * Replaces the board's current units/team gold and this session's turn/
   * side/result state with `data`'s -- everything `toSaveData()` captured.
   * Public: a UI can call this directly on an existing, already-playing
   * `GameSession` (a "Load" button) as well as via the `fromSaveData`
   * static factory below (a fresh session, pre-loaded).
   */
  loadSaveData(data: SaveGameData): void {
    if (data.variables) this.eventPump.ctx.variables.replaceAll(WmlConfig.fromJSON(data.variables));
    this.eventPump.ctx.choices.splice(0, this.eventPump.ctx.choices.length, ...(data.choices ?? []).map((c) => ({ ...c })));
    for (const unit of [...this.board.allUnits()]) {
      this.board.removeUnitAt(unit.location);
    }
    for (const t of this.board.teams()) {
      this.board.clearRecallList(t.side);
    }
    for (const u of data.units) {
      this.board.addUnit(this.unitFromSave(u, new Location(u.x ?? 0, u.y ?? 0)));
    }
    for (const t of data.teams) {
      const team = this.board.getTeam(t.side);
      if (!team) continue;
      team.gold = t.gold;
      if (t.shroudData !== undefined) team.shroud.read(t.shroudData);
      if (t.fogData !== undefined) team.fog.read(t.fogData);
      // Optional-on-read: a version-1 save recorded no village ownership at
      // all, and re-derived it (wrongly) from initial unit placement.
      if (t.villages) {
        for (const v of t.villages) this.board.captureVillage(new Location(v.x, v.y), t.side);
      }
    }
    // Optional-on-read (see `SaveGameData.recall`'s own doc comment): a save
    // written before this field existed simply had no recall-list units.
    for (const r of data.recall ?? []) {
      this.board.addToRecallList(r.side, this.unitFromSave(r, Location.NULL));
    }
    if (data.rng) this.mtRng.seedRandom(data.rng.seed, data.rng.calls);
    if (data.goldCarryover !== undefined) this.goldCarryover = data.goldCarryover;
    this.turnNumber = data.turnNumber;
    this.activeSide = data.activeSide;
    this.scenarioResult = data.scenarioResult;
    this.startupEventsRun = data.startupEventsRun;
    // Optional-on-read (see `SaveGameData.schedule`'s own doc comment): an
    // older save simply leaves the schedule as freshly built from the
    // scenario's own static config.
    if (data.schedule) this.schedule.importState(data.schedule);
    this.clearSelection();
    this.lastKnownVillageOwner.clear();
    this.syncVillageMemory();
  }

  /**
   * Rebuilds one unit from its saved form at `location`. Every version-2
   * field is applied only when present, so a version-1 save (which carried
   * almost none of them) simply keeps the unit type's own defaults for the
   * rest -- exactly the behaviour it had before version 2 existed.
   */
  private unitFromSave(u: SavedUnit, location: Location): Unit {
    const unit = Unit.create(this.resolveType(u.typeId), u.side, location, {
      id: u.id ?? undefined,
      name: u.name ?? undefined,
      canRecruit: u.canRecruit,
      role: u.role,
      hidden: u.hidden,
      underlyingId: u.underlyingId,
      facing: u.facing !== undefined ? parseDirection(u.facing) : undefined,
      profile: u.profile,
      modifications: u.modifications?.map((m) => ({ kind: m.kind, cfg: WmlConfig.fromJSON(m.cfg) })),
      variables: u.variables !== undefined ? WmlConfig.fromJSON(u.variables) : undefined,
    });
    if (u.hitpoints !== undefined) unit.hitpoints = u.hitpoints;
    if (u.maxHitpoints !== undefined) unit.maxHitpoints = u.maxHitpoints;
    if (u.movesLeft !== undefined) unit.movesLeft = u.movesLeft;
    if (u.maxMoves !== undefined) unit.maxMoves = u.maxMoves;
    if (u.attacksLeft !== undefined) unit.attacksLeft = u.attacksLeft;
    if (u.maxAttacksPerTurn !== undefined) unit.maxAttacksPerTurn = u.maxAttacksPerTurn;
    if (u.experience !== undefined) unit.experience = u.experience;
    if (u.maxExperience !== undefined) unit.maxExperience = u.maxExperience;
    if (u.level !== undefined) unit.level = u.level;
    if (u.resting !== undefined) unit.resting = u.resting;
    if (u.statuses) {
      unit.statuses.clear();
      for (const s of u.statuses) unit.statuses.add(s);
    }
    if (u.goto) unit.goto = new Location(u.goto.x, u.goto.y);
    return unit;
  }

  /** Builds a fresh session from `snapshot`, then overwrites its live state from a save. */
  static fromSaveData(snapshot: GameBoardSnapshot, data: SaveGameData, options: GameSessionOptions = {}): GameSession {
    const session = new GameSession(snapshot, options);
    session.loadSaveData(data);
    return session;
  }

  /**
   * Computes this (finished, winning) session's real gold-carryover result
   * for continuing into `nextSnapshot` -- see `computeGoldCarryover`'s own
   * doc comment for the formula and `findVictoryEndlevelGoldConfig`'s for
   * how its bonus=/carryover_add=/carryover_percentage= inputs are located
   * (a static config walk over THIS session's own finished scenario config,
   * not a real fired `enemies_defeated` event -- see this project's
   * documented simplification, `victory.ts`'s own doc comment on the same
   * gap). `totalVillages`/`teamIncome`/`incomePerVillage` are read from this
   * (finishing) session's own board/team, matching upstream (the bonus is
   * computed from the scenario just won, not the one being entered).
   */
  private computeGoldCarryoverResult(nextSnapshot: GameBoardSnapshot): GoldCarryoverResult {
    const team = this.board.getTeam(this.playerSide);
    const endlevel = findVictoryEndlevelGoldConfig(this.snapshot.scenarioConfigJson);
    const nextTeamCfg = nextSnapshot.teams.find((t) => t.side === this.playerSide);
    return computeGoldCarryover({
      teamGold: team?.gold ?? 0,
      teamIncome: team?.income ?? 0,
      incomePerVillage: team?.incomePerVillage ?? 1,
      totalVillages: this.board.map.villages.length,
      scenarioTurnsLimit: parseScenarioTurnsLimit(this.snapshot.scenarioConfigJson.attrs['turns']),
      turnNumberAtVictory: this.turnNumber,
      endlevel,
      nextScenarioDeclaredGold: nextTeamCfg?.gold ?? 100,
    });
  }

  /**
   * Builds the next scenario's session, continuing from `finished` (a
   * session that just ended in victory) -- the generic `next_scenario=`
   * mechanism this class's own module doc comment describes. Computes real
   * gold carryover (`computeGoldCarryover`, exposed afterward via
   * `goldCarryover`) and populates the new session's recall list with every
   * surviving player-side unit not inline-re-declared in `nextSnapshot`'s
   * own `[side]` (`computeCarryoverRecruits`) -- see both functions' own
   * doc comments for the exact, documented simplifications (locating the
   * `[endlevel]` via a static config walk rather than a real fired event;
   * a persistent hero like Kai Krellis excluded by id, so his level/XP does
   * not persist across the transition).
   *
   * `finished`'s board is left untouched (nothing here mutates it) -- the
   * carried-over `Unit` instances are the same live objects, simply added
   * to the new board's recall list, mirroring `fromSaveData`'s "build a
   * fresh session rather than mutate one in place" pattern. Callers should
   * just stop using `finished` once this returns.
   */
  static startNextScenario(finished: GameSession, nextSnapshot: GameBoardSnapshot, options: GameSessionOptions = {}): GameSession {
    if (finished.scenarioResult !== 'victory') {
      throw new Error('GameSession.startNextScenario: can only continue from a session that ended in victory.');
    }
    const goldCarryover = finished.computeGoldCarryoverResult(nextSnapshot);
    const carriedOverUnits = computeCarryoverRecruits(finished.board, finished.playerSide, nextSnapshot.scenarioConfigJson);

    const session = new GameSession(nextSnapshot, { ...options, goldCarryover });
    const team = session.board.getTeam(session.playerSide);
    if (team) team.gold = goldCarryover.nextScenarioGold;
    for (const unit of carriedOverUnits) {
      session.board.addToRecallList(session.playerSide, unit);
    }
    // Phase 17: WML variables cross the scenario boundary, as upstream's
    // carryover does -- Two Brothers 2 picks the castle passwords and
    // scenario 3 asks the player for them, and until now that variable
    // simply vanished in between (so the puzzle could only ever take its
    // "wrong password" branch).
    session.eventPump.ctx.variables.replaceAll(finished.eventPump.ctx.variables.toConfig());
    return session;
  }

  /**
   * Runs the real (leader-death-based) victory check after anything that
   * could have killed a unit, and latches `scenarioResult` the first time
   * the scenario is actually over -- see `checkVictory`'s own doc comment
   * for exactly what this does and doesn't model.
   */
  private checkForGameEnd(): void {
    if (this.scenarioResult) return;
    const endLevel = this.eventPump.ctx.endLevel;
    if (endLevel) {
      this.scenarioResult = endLevel.result;
      this.clearSelection();
      this.log.unshift(endLevel.result === 'victory' ? 'Victory!' : 'Defeat.');
      return;
    }
    const { continueLevel, notDefeated } = checkVictory(this.board);
    if (continueLevel) return;
    this.scenarioResult = notDefeated.includes(this.playerSide) ? 'victory' : 'defeat';
    this.clearSelection();
    this.log.unshift(
      this.scenarioResult === 'victory' ? 'Victory! The enemy has been defeated.' : 'Defeat... your side has fallen.',
    );
  }
}
