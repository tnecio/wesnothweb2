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
  plainJsonValue,
  TString,
  type TStringJson,
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
  advanceUnitAmla,
  type AttackBlowResult,
  type AttackResult,
  buildBattleContext,
  chooseDefenderWeaponIndex,
  simulateCombat,
  hasSpecialId,
  combatModifier,
  RngDeterministic,
  MtRng,
  SyncedRng,
  entropySeedStr,
  type RandomMode,
  Recorder,
  UndoList,
  type UndoStep,
  type SyncedCommand,
  type MoveCommand,
  type AttackCommand,
  type RecruitCommand,
  type RecallCommand,
  type DisbandCommand,
  type FireEventCommand,
  type StopUnitCommand,
  type RecordedCommand,
  type Dependent,
  stateDigest,
  stateDescription,
  fnv1a,
  hexOf,
  locOf,
  resolveDefenderWeaponIndex,
  chooseAdvancementRandomly,
  type PerformMoveResult,
  type PlaceRecruitResult,
  type AiCommandHost,
  type Team,
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
  recruitUnitFlow,
  recallUnitFlow,
  type PlaceRecruitHooks,
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
  effectEnvFor,
  runFlow,
  autoRespond,
  type ChoiceRecord,
  type Flow,
  type Interaction,
  type InteractionResult,
  type Responder,
  setLuaConditionalEvaluator,
  performMoveFlow,
  readPersistentItem,
  labelFromConfig,
  MusicList,
  GAME_SOUNDS,
  soundSourceFromConfig,
  type SoundSourceSpec,
  type SoundRequest,
  startScenarioMusic,
  selectEndMusic,
  playEndMusic,
  labelToConfig,
  LABEL_COLOR,
  type MapLabel,
  type LabelCommand,
  type ClearLabelsCommand,
  itemToConfig,
  standardizeEventName,
} from '@wesnothweb2/engine';
// Deep import: lua-bridge's index also exports Node-only data loaders.
import type { MinimapInput } from '@wesnothweb2/renderer';
import { createLuaConditionalEvaluator } from '@wesnothweb2/lua-bridge/src/conditionals.js';
import { raceName, statusName } from './i18n/gameText.js';
import { fmt, t, tx } from './i18n/locale.js';

// `[lua]` conditions run in a real Lua VM (Fengari); see lua-bridge's conditionals.ts.
setLuaConditionalEvaluator(createLuaConditionalEvaluator());

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

/** One map label as the board draws it -- see `GameSession.mapLabels`. */
export interface MapLabelInfo extends HexPoint {
  text: string;
  /** `r,g,b`. */
  color: string;
  tooltip: string;
}

/** One map item as the board draws it -- see `GameSession.mapItems`. */
export interface MapItemInfo extends HexPoint {
  image: string;
  halo: string;
  submerge: number;
  zOrder: number;
}

/** One hex's terrain code, for redrawing a map WML changed -- see `GameSession.terrainHexes`. */
export interface TerrainHexInfo extends HexPoint {
  code: string;
}

/** One currently-owned village, for the board's live ownership-flag rendering -- see `GameSession.villageOwnership`. */
export interface VillageOwnerInfo extends HexPoint {
  side: number;
}

/** Mirrors `Team.shrouded`/`fogged`'s three-state result for one hex, from `playerSide`'s perspective -- see `GameSession.hexVisibility`. */
/**
 * `unit_orb_status` for one of the viewing side's units, as `SnapshotBoard`
 * draws its orb (the renderer's `movesOrbStatus`, restated here so this
 * module keeps no renderer dependency): untouched, spent, or in between.
 */
function orbStatusOf(u: SnapshotUnit): 'unmoved' | 'partial' | 'moved' | undefined {
  if (u.movesLeft === undefined || u.maxMoves === undefined || u.attacksLeft === undefined || u.maxAttacksPerTurn === undefined) return undefined;
  if (u.movesLeft === u.maxMoves && u.attacksLeft === u.maxAttacksPerTurn) return 'unmoved';
  if (!(u.canMove ?? u.movesLeft > 0) && !(u.canAttackHere ?? u.attacksLeft > 0)) return 'moved';
  return 'partial';
}

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
  /** The type's display name, in the language it had when this preview was built. */
  typeName: string;
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
  /** Already slowed going into this exchange: halves this combatant's damage (upstream's `is_slowed`, shown as the damage dialog's "/ 2" `slowed_modifier` row). */
  slowed: boolean;
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
 * scopes race data to just the id string), so `i18n/gameText.ts` maps each
 * race id to upstream's own `race^...` msgid, falling back to capitalizing
 * the raw id for anything else, rather than failing or showing nothing.
 */
export function raceDisplayName(raceId: string): string {
  return raceName(raceId);
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

const STATUS_IDS: readonly string[] = [UnitStatus.Slowed, UnitStatus.Poisoned, UnitStatus.Petrified];

/** A view-model of a unit, for the side panel -- deliberately plain data, not a live `Unit` reference. Used for both the currently-*selected* (your own, actionable) unit and any *inspected* unit (see `GameSession.inspectedUnit`) -- addresses "no way to see information about enemy units". */
export interface SelectedUnitInfo {
  name: string;
  typeId: string;
  /** The type's display name (`typeId` is the WML id, which is not language). */
  typeName: string;
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
    typeName: unit.type.name,
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
    abilities: unit.abilities.map(buildAbilityInfo),
    traits: unit.traitNames,
    image,
    level: unit.type.level,
    alignment: unit.alignment,
    raceId: unit.type.raceId,
    raceName: raceDisplayName(unit.type.raceId),
    resistances: DAMAGE_TYPES.map((damageType) => ({ damageType, resistance: unit.resistanceAgainst(damageType) })),
    statuses: STATUS_IDS.filter((status) => unit.hasStatus(status)).map(statusName),
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

/** `AdvancementOption.typeId` of an AMLA row: this prefix plus its index among `amlaOptions`. */
export const AMLA_OPTION_PREFIX = 'amla:';

export interface PendingAdvancement {
  readonly unit: Unit;
  readonly options: readonly UnitType[];
  /** The AMLAs offered after `options` (`get_modification_advances`); `optionInfos` lists both, types first. */
  readonly amlaOptions: readonly WmlConfig[];
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
  /** The type's display name (`typeId` is the WML id, which is not language). */
  typeName: string;
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
  /**
   * Phase 18b: upstream's `random_mode`. `per_action` (the default, as
   * upstream's) seeds a fresh RNG for every action and records the seed;
   * `deterministic` draws every action from one whole-game stream.
   */
  randomMode?: RandomMode;
  /**
   * Where `per_action` seeds come from. Omitted: derived from `seed`, so a
   * headless run (a test, the AI benchmark) repeats exactly. `'entropy'`:
   * real randomness, as upstream's `seed_rng::next_seed()` -- what the game
   * in the browser uses, so reloading before an attack gives a new roll.
   */
  actionSeeds?: 'entropy';
  /**
   * Phase 19: the music playlist, handed on from the previous scenario (or
   * the app's own). Upstream's list is global and outlives scenarios; a
   * session given none makes its own.
   */
  music?: MusicList;
  /** Phase 19: where sound effects go to be heard (the app's audio); without it they are only recorded on the context. */
  onSound?: (request: SoundRequest) => void;
  /** Phase 19: `[volume]`, the scenario's percentages of the player's own music and sound volumes. */
  onVolume?: (scale: { music?: number; sound?: number }) => void;
  /** Set by `fromSaveData`: the save's own playlist is applied by `loadSaveData`, not the scenario's. */
  deferMusic?: boolean;
}

/**
 * The action a synced command is running as (upstream's `synced_context`
 * state plus the `undo_action_container` being filled): the log entry being
 * written, the undo steps collected so far, whether anything has made it
 * impossible to undo, and -- while replaying or redoing -- the recorded
 * dependents still to be consumed, in order.
 */
interface ActionState {
  readonly rec: RecordedCommand;
  readonly steps: UndoStep[];
  undoBlocked: boolean;
  /** Set by an executor that refused the command; the log entry is then dropped (`run_and_store`'s `recorder->undo()`). */
  rejected: string | null;
  readonly source: Dependent[] | null;
  /** Whether cutscene beats (the walk, the recruit appearing) are yielded to the display. */
  readonly present: boolean;
}

/** One undo step as a save stores it: units by where they stand, since `UndoStep` holds live `Unit`s. */
export type SavedUndoStep =
  | { kind: 'move'; route: { x: number; y: number }[]; startingMoves: number; startingFacing: string }
  | { kind: 'take_village'; loc: { x: number; y: number }; previousOwner: number }
  | { kind: 'recruit'; loc: { x: number; y: number }; side: number; cost: number }
  | { kind: 'recall'; loc: { x: number; y: number }; side: number; cost: number; index: number }
  | { kind: 'dismiss'; unit: SavedUnit; side: number; index: number }
  | { kind: 'event'; commands: WmlConfigJson; loc1: { x: number; y: number }; loc2: { x: number; y: number } };

/** Upstream's `[undo_stack]`: what the side whose turn it is can still undo or redo. */
export interface SavedUndoStack {
  undo: { steps: SavedUndoStep[]; command: RecordedCommand }[];
  redo: RecordedCommand[];
}

/** What a replay or redo found that did not match the recorded game. */
export interface SyncIssue {
  /** Index of the command in the log. */
  readonly index: number;
  readonly command: SyncedCommand['kind'];
  readonly message: string;
}

/** A deep copy of a log entry, so saved and live logs never share mutable dependents. */
function cloneRecordedCommand(rec: RecordedCommand): RecordedCommand {
  return JSON.parse(JSON.stringify(rec)) as RecordedCommand;
}

/** A short human description of a command, for the log after an undo or redo. */
export function describeCommand(command: SyncedCommand): string {
  switch (command.kind) {
    case 'move':
      return tx('move');
    case 'recruit':
      return fmt(tx('recruit of $type'), { type: command.type });
    case 'recall':
      return fmt(tx('recall of $unit'), { unit: command.id || tx('a unit') });
    case 'disband':
      return fmt(tx('dismissal of $unit'), { unit: command.id || tx('a unit') });
    case 'fire_event':
      return command.raise;
    default:
      return command.kind.replace('_', ' ');
  }
}

const EVENT_LOCATION_VARIABLES = new Set(['x1', 'y1', 'x2', 'y2']);

function needsInput(interaction: Interaction): boolean {
  return interaction.kind === 'message' && (interaction.options.length > 0 || interaction.textInput !== undefined);
}

/**
 * Everything `SavedUnit` records about a live unit except where it stands
 * (`toSaveData` adds x/y for board units and leaves it off for recall-list
 * ones, which have no position -- upstream's own distinction).
 */
function savedUnitFields(u: Unit): SavedUnit {
  return {
    id: u.id || null,
    name: u.translatableName ? u.translatableName.toJSON() : u.name || null,
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
    gender: u.gender,
    variation: u.variation || undefined,
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
  /** Plain text, or the translatable `{"t": ...}` form while the unit still carries its WML name (so a load keeps it translatable). */
  name: string | TStringJson | null;
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
  /** `gender=` (Phase 18b: recruits draw it, as upstream, so it has to survive). */
  gender?: string;
  /** `variation=` (Phase 18c: an `[object]` can give one, e.g. Dead Water's swimmer corpses). */
  variation?: string;
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
  /**
   * The campaign difficulty define this game is played at (`EASY`, `HARD`, ...; Phase 21). The preprocessor
   * resolved the scenario's `#ifdef <difficulty>` with it, so loading has to fetch that build. Absent in a
   * save made before difficulties (and for a debug scenario): the campaign's default.
   */
  difficulty?: string;
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
  /**
   * The scenario's `[tunnel]`s (Phase 18a), in the form upstream saves them
   * (`saved`/`reversed`/`id` set), plus its tunnel id counter. Optional on
   * read, like every field added after version 1.
   */
  tunnels?: WmlConfigJson[];
  nextTeleportGroupId?: number;
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
  /** Phase 18c: `[object] id=`s already taken (upstream's `[used_items]`). */
  usedItems?: string[];
  /**
   * Phase 18c: the live `[event]` handlers, in order -- spent
   * `first_time_only` ones gone, ones added at run time present, as
   * upstream writes them into `[snapshot]`. Real bug fixed with it: a
   * reloaded game rebuilt its handlers from the scenario, so every
   * one-time event (a first `moveto` dialogue, a turn-limited trigger)
   * could fire again, and handlers added by events were lost. Absent on
   * older saves, which keep the old behaviour.
   */
  events?: WmlConfigJson[];
  /** Phase 18c: the unit id counter (upstream's `next_underlying_unit_id`). Absent: derived from the highest id in the save. */
  nextUnitId?: number;
  /** Phase 18: the items on the map, as upstream saves them (`[item]` tags), and its `next_item_name`. Absent: the scenario's own. */
  items?: WmlConfigJson[];
  nextItemName?: number;
  /** Phase 18: the map labels (`[label]`s). Absent: the scenario's own. */
  labels?: WmlConfigJson[];
  /** Phase 19: the music playlist as `[music]` tags (`write_music_play_list`): the first replaces, the rest append. Absent: the scenario's own. */
  music?: WmlConfigJson[];
  /** Phase 19: the sound sources (`[sound_source]` tags, `write_sourcespecs`). Absent: the scenario's own. */
  soundSources?: WmlConfigJson[];
  /** Phase 18d: the map as WML left it (`[terrain]`, `[terrain_mask]`), as `map_data=` text. Absent: the scenario's own map. */
  mapData?: string;
  /** Phase 18d: the turn limit as `[modify_turns]` left it (`-1`: none). Absent: the scenario's `turns=`. */
  turnLimit?: number;
  /** Phase 18c: `[set_menu_item]`s in effect (lost on reload before). */
  menuItems?: { id: string; description: string; command: WmlConfigJson }[];
  /** Phase 18c: each side's current `[objectives]` (lost on reload before). */
  objectives?: { side: number; objectives: ScenarioObjectives }[];
  /** Phase 18d: the raw `[objectives]` per side (0: every side), for `[show_objectives]` (upstream's persistent `[objectives]` tags). */
  objectiveConfigs?: { side: number; cfg: WmlConfigJson }[];
  /** Phase 18b: upstream's `random_mode`; absent means `per_action`. */
  randomMode?: RandomMode;
  /** Upstream's `do_healing`: false only until the scenario's first side turn has started. Absent: true once startup events ran. */
  doHealing?: boolean;
  /**
   * Phase 18b: the game so far as a replay -- the state the scenario started
   * from (before its `start` command) and every command since, with its
   * dependents and state digest. Absent on saves from before Phase 18b and
   * on imported Wesnoth saves (whose own `[replay]` travels in
   * `wesnothExtras`).
   */
  replay?: {
    /** The state before the `start` command (a game recorded here). */
    start?: SaveGameData;
    /**
     * A game recorded by the real Wesnoth instead: no starting state of this
     * port's own, only what its `[replay_start]` says the scenario was
     * entered with -- each side's gold and recall list -- to lay over this
     * port's own setup of the same scenario (see `GameSession.forReplay`).
     */
    wesnothStart?: { gold: { side: number; gold: number }[]; recall: SavedUnit[] };
    commands: RecordedCommand[];
    /** What reading a real `[replay]` skipped (commands this port does not run, such as `[speak]` or `[label]`). */
    readIssues?: string[];
  };
  /** Phase 18b: the active side's undo and redo stacks (upstream's `[undo_stack]`). */
  undoStack?: SavedUndoStack;
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

  /**
   * Whose eyes the board is drawn through: fog, shroud, hidden units,
   * village flags, moves orbs (Phase 18a). Upstream switches the viewing
   * team to each human side as its turn starts (`play_controller::
   * update_gui_to_player`) and keeps it through AI turns -- so in hotseat,
   * side 2's turn no longer shows side 1's knowledge (an ambusher side 2
   * cannot see stays hidden). `playerSide` still decides the campaign's
   * outcome and carryover.
   */
  get viewingSide(): number {
    return this.viewingSideValue;
  }
  private viewingSideValue: number;

  /** Makes `side` the acting side, and the viewing side too if a human plays it. */
  private setActiveSide(side: number): void {
    this.activeSide = side;
    const controller = this.board.getTeam(side)?.controller;
    if (controller !== 'ai' && controller !== 'network_ai') this.viewingSideValue = side;
  }

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
  get scenarioObjectives(): ScenarioObjectives | null {
    return this.eventPump.ctx.objectivesBySide.get(this.playerSide) ?? null;
  }

  /**
   * `team.objectives_changed` for the player's side, cleared as it is read:
   * upstream shows the objectives dialog at the start of the side's turn
   * when `[objectives]` (not `silent=`) or `[show_objectives]` changed them.
   */
  takeObjectivesChanged(): boolean {
    const changed = this.eventPump.ctx.objectivesChanged.delete(this.playerSide);
    return changed && this.scenarioObjectives !== null;
  }
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
   * A sentence describing a hex, for a screen reader (Phase 20): its terrain and the selected unit's defense
   * there, any unit the player can see on it (name, type, side, hit points, moves) and whether Enter would
   * move there or attack it. Keyboard play is usable without the canvas because the cursor announces this
   * as it moves.
   */
  describeHex(x: number, y: number): string {
    const loc = new Location(x, y);
    if (!this.board.map.onBoard(loc)) return '';
    const terrain = this.board.map.terrainName(loc);
    const defense = this.defensePercentAt(x, y);
    const parts = [defense === null ? terrain : fmt(tx('$terrain, $defense|% defense'), { terrain, defense })];
    const unit = this.board.unitAt(loc);
    const playerTeam = this.board.getTeam(this.viewingSide);
    if (unit && (!playerTeam || isUnitVisibleToTeam(this.board, unit, playerTeam, false))) {
      parts.push(
        fmt(tx('$name, $type, side $side, $hp of $maxhp HP, $moves of $maxmoves moves'), {
          name: this.unitDisplayName(unit),
          type: unit.type.name,
          side: unit.side,
          hp: unit.hitpoints,
          maxhp: unit.maxHitpoints,
          moves: unit.movesLeft,
          maxmoves: unit.maxMoves,
        }),
      );
    }
    if (this.reachable.some((h) => h.x === x && h.y === y)) parts.push(tx('you can move here'));
    if (this.attackCandidates.some((u) => u.location.x === x && u.location.y === y)) parts.push(tx('you can attack it'));
    return parts.join('. ') + '.';
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
    const cmd: FireEventCommand = { kind: 'fire_event', raise: `menu item ${id}`, source: hexOf(new Location(x, y)) };
    const done = await this.drive(this.runSynced(cmd, (action) => this.execFireEvent(cmd, action), { present: true }));
    if (done === null) return null;
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
  /**
   * Every game rule's RNG (Phase 18b): a fresh, recorded stream per synced
   * action in `per_action` mode, the whole-game stream in `deterministic`
   * mode, and an unsynced stream outside actions (AI decisions) -- see
   * `SyncedRng`.
   */
  private readonly rng: SyncedRng;
  /**
   * The whole-game stream, held separately because only `MtRng` exposes the
   * seed and draw count a save has to record and restore (`random_seed`/
   * `random_calls` -- see `SaveGameData.rng`).
   */
  private readonly mtRng: MtRng;
  /** A new per-action seed: from real entropy in the browser game, from `seed` headless. */
  private readonly nextFreshSeed: () => string;

  // --- Phase 18b: synced actions, the command log, undo/redo ---

  /** Every command so far, with its dependents (upstream's `[replay]`). */
  private readonly recorder = new Recorder();
  /** The active side's undo and redo stacks. */
  private readonly undoList = new UndoList();
  /** The synced action running now, if any. */
  private action: ActionState | null = null;
  /** The state the scenario started from, before its `start` command -- a replay's starting point. */
  private replayStartData: SaveGameData | null = null;
  /** Upstream's `do_healing`: healing starts with the second side turn of the scenario. */
  private doHealing = false;
  /** Set while `redo` re-runs a command, which must not clear the rest of the redo stack. */
  private redoing = false;
  /** Where the attack that is waiting on the player's advancement choice was recorded. */
  private advancementRec: RecordedCommand | null = null;
  /** Divergences found while replaying or redoing (see `replayCommands`). */
  readonly syncIssues: SyncIssue[] = [];
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
    this.viewingSideValue = this.playerSide;
    this.board = gameBoardFromSnapshot(snapshot).board;
    this.resolveType = createTypeResolver(snapshot);
    const seed = (options.seed ?? 0xc0ffee) >>> 0;
    this.mtRng = new MtRng(seed);
    if (options.actionSeeds === 'entropy') {
      this.nextFreshSeed = entropySeedStr;
    } else {
      const seeder = new MtRng((seed + 0x9e3779b9) >>> 0);
      this.nextFreshSeed = () => seeder.getNextRandom().toString(16).padStart(8, '0');
    }
    this.rng = new SyncedRng(this.mtRng, new MtRng((seed ^ 0x5eed5eed) >>> 0), options.randomMode ?? 'per_action', () =>
      this.provideSeed(),
    );
    // Any random number an action draws makes it impossible to undo, in
    // both modes (`ask_server_choice`/`get_rng_for_action` block undo).
    this.rng.onSyncedDraw = () => {
      if (this.action) this.action.undoBlocked = true;
    };
    this.goldCarryover = options.goldCarryover ?? null;
    // random_start_time= is resolved once here, before any events run --
    // matches upstream's own timing (tod_manager::resolve_random, called
    // from the play_controller constructor sequence before fire_prestart).
    this.schedule = scheduleFromScenarioConfigJson(snapshot.scenarioConfigJson, new RngDeterministic(this.mtRng));
    const manager = new EventManager();
    manager.loadScenarioEvents(WmlConfig.fromJSON(snapshot.scenarioConfigJson));
    this.eventPump = new EventPump(manager, {
      board: this.board,
      variables: new VariableStore(),
      resolveType: this.resolveType,
      schedule: this.schedule,
      rng: this.rng,
      log: options.onLog,
      music: options.music,
    });
    this.eventPump.ctx.onSound = options.onSound;
    this.eventPump.ctx.onVolume = options.onVolume;
    if (!options.deferMusic) startScenarioMusic(this.music, WmlConfig.fromJSON(snapshot.scenarioConfigJson));
    this.board.lawfulBonusAt = (loc) => this.timeOfDayAt(loc).lawfulBonus;
    this.eventPump.ctx.turnLimit = parseScenarioTurnsLimit(plainJsonValue(snapshot.scenarioConfigJson.attrs['turns'])) ?? -1;
    this.eventPump.ctx.turnNumber = () => this.turnNumber;
    // The scenario's own `[item]`s and `[label]`s, read as upstream does at scenario start.
    for (const { tag, config } of WmlConfig.fromJSON(snapshot.scenarioConfigJson).allChildren()) {
      if (tag === 'item') readPersistentItem(this.eventPump.ctx, config);
      // map_labels::read(level): the scenario's own labels.
      if (tag === 'label') this.eventPump.ctx.labels.set(labelFromConfig(config, this.eventPump.ctx));
      // play_controller::init: the scenario's own `[sound_source]`s.
      if (tag === 'sound_source') this.eventPump.ctx.soundSources.add(soundSourceFromConfig(config));
    }
    this.eventPump.ctx.unitTypeConfig = (id) => {
      const json = this.snapshot.unitTypeConfigs?.[id];
      return json ? WmlConfig.fromJSON(json) : undefined;
    };
    this.eventPump.ctx.setTurnNumber = (turn) => {
      this.turnNumber = turn;
      this.eventPump.ctx.variables.set('turn_number', turn);
    };
    this.eventPump.ctx.addUndoCommands = (commands) => {
      this.action?.steps.push({ kind: 'event', commands, loc1: this.eventPump.ctx.loc1, loc2: this.eventPump.ctx.loc2 });
    };

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
      commands: this.aiCommands(),
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

  /** Phase 19: the sound sources in effect, in id order; a replaced source is a new object (the app restarts it). */
  get soundSources(): readonly SoundSourceSpec[] {
    return this.eventPump.ctx.soundSources.all();
  }

  /** Phase 19: the music playlist (see `GameSessionOptions.music`). */
  get music(): MusicList {
    return this.eventPump.ctx.music;
  }

  /**
   * `play_scenario` for a loaded game: the saved playlist replaces the
   * current one, as its `[music]` tags are read like a scenario's own. A save
   * without one starts the scenario's music.
   */
  private applySavedMusic(saved: WmlConfigJson[] | undefined): void {
    if (saved === undefined) {
      startScenarioMusic(this.music, WmlConfig.fromJSON(this.snapshot.scenarioConfigJson));
      return;
    }
    const level = new WmlConfig();
    for (const m of saved) level.addChild('music', WmlConfig.fromJSON(m));
    startScenarioMusic(this.music, level);
  }

  /** The victory/defeat stinger (`playsingle_controller::play_scenario_end`), once the scenario is over. */
  private playScenarioEndMusic(): void {
    const endLevel = this.eventPump.ctx.endLevel;
    const victory = this.scenarioResult === 'victory';
    if (victory && endLevel?.carryoverReport === false) return;
    const scenario = WmlConfig.fromJSON(this.snapshot.scenarioConfigJson);
    playEndMusic(this.music, selectEndMusic(scenario, victory, endLevel?.music, (max) => this.music.randomInt(max)));
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
    const raw = this.eventPump.ctx.endLevel?.nextScenario ?? plainJsonValue(this.snapshot.scenarioConfigJson.attrs['next_scenario']);
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
    return resolveStory(WmlConfig.fromJSON(this.snapshot.scenarioConfigJson), this.scenarioNameT, this.eventPump.ctx);
  }

  private scenarioNameCache: TString | undefined;

  /** The scenario's `name=` as a translatable string (read straight from the JSON: building a `WmlConfig` of the whole scenario for one attribute would be far too much). */
  get scenarioNameT(): TString {
    if (!this.scenarioNameCache) {
      const raw = this.snapshot.scenarioConfigJson.attrs['name'];
      this.scenarioNameCache = raw !== undefined && typeof raw === 'object' ? TString.fromJSON(raw) : TString.literal(this.snapshot.scenario.name);
    }
    return this.scenarioNameCache;
  }

  /** The scenario's name in the current language. */
  get scenarioName(): string {
    return this.scenarioNameT.str();
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
    // Phase 18b: the replay starts from here -- the scenario as set up,
    // carryover included, before its `start` command runs.
    this.replayStartData = this.toSaveData();
    this.startupEventsRun = true;
    return this.drive(this.startupEventsFlow());
  }

  /** `[start]` then the first side's `[init_side]`, each its own synced command as upstream records them. */
  private *startupEventsFlow(): Flow<RecordedMessage[]> {
    const shownFrom = this.eventPump.ctx.messages.length;
    yield* this.runSynced({ kind: 'start' }, () => this.execStart(), { present: true });
    const side = this.activeSide;
    if (!this.scenarioResult) yield* this.runSynced({ kind: 'init_side', side }, (action) => this.execInitSide(side, action), { present: true });
    this.checkForGameEnd();
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
    const replayed = this.replayedAnswer(interaction);
    if (replayed) return replayed;
    const answer = autoRespond(interaction);
    this.recordAnswer(interaction, answer);
    return answer;
  };

  /**
   * Runs a flow to completion, handing each interaction to
   * `interactionHost` and waiting for its answer. With no host (a
   * headless caller, or a test), the engine's own deterministic
   * `autoRespond` answers instead and nothing ever waits. A choice the
   * log already holds (a replay, a redo) is answered from the log without
   * asking anyone; any other choice made inside an action is recorded.
   */
  private async drive<T>(flow: Flow<T>): Promise<T> {
    let step = flow.next({});
    while (!step.done) {
      const interaction = step.value;
      let answer = this.replayedAnswer(interaction);
      if (!answer) {
        const host = this.interactionHost;
        answer = host ? await host.handle(interaction) : autoRespond(interaction);
        this.recordAnswer(interaction, answer);
      }
      step = flow.next(answer);
    }
    return step.value;
  }

  // ---------------------------------------------------------------------------
  // Phase 18b: synced actions (synced_context.cpp / synced_commands.cpp)
  // ---------------------------------------------------------------------------

  /** A `[message]` answer taken from the log, when the running action is a replay or redo. */
  private replayedAnswer(interaction: Interaction): InteractionResult | undefined {
    const action = this.action;
    if (!action?.source || !needsInput(interaction)) return undefined;
    const dep = this.takeDependent(action, 'input');
    if (!dep) return undefined;
    action.rec.dependents.push(dep);
    return { value: dep.value, text: dep.text };
  }

  /** Records a `[message]` answer as a dependent `[input]` of the running action (`synced_user_choice`). */
  private recordAnswer(interaction: Interaction, answer: InteractionResult): void {
    const action = this.action;
    if (!action || !needsInput(interaction) || interaction.kind !== 'message') return;
    action.rec.dependents.push({
      kind: 'input',
      ...(interaction.options.length > 0 ? { value: answer.value ?? 1 } : {}),
      ...(interaction.textInput ? { text: answer.text ?? interaction.textInput.text } : {}),
      side: this.activeSide,
    });
  }

  /** A new action's seed: the recorded one when replaying or redoing, otherwise a fresh one, recorded as `[random_seed]`. */
  private provideSeed(): string {
    const action = this.action;
    if (action?.source) {
      const dep = this.takeDependent(action, 'random_seed');
      if (dep) {
        action.rec.dependents.push(dep);
        return dep.seed;
      }
    }
    const seed = this.nextFreshSeed();
    action?.rec.dependents.push({ kind: 'random_seed', seed });
    return seed;
  }

  /** The next recorded dependent, if it is the kind asked for (upstream: "[x] expected but none found"). */
  private takeDependent<K extends Dependent['kind']>(action: ActionState, kind: K): Extract<Dependent, { kind: K }> | null {
    const source = action.source;
    if (!source) return null;
    const next = source[0];
    if (!next) {
      this.reportSync(action, `expected a recorded [${kind}], found none`);
      return null;
    }
    if (next.kind !== kind) {
      this.reportSync(action, `expected a recorded [${kind}], found [${next.kind}]`);
      return null;
    }
    source.shift();
    return next as Extract<Dependent, { kind: K }>;
  }

  private reportSync(action: ActionState, message: string): void {
    const index = this.recorder.commands.indexOf(action.rec);
    this.syncIssues.push({ index, command: action.rec.command.kind, message });
    this.eventPump.ctx.log('warn', `out of sync at command ${index} [${action.rec.command.kind}]: ${message}`);
  }

  /**
   * Turn, side, result and a hash of the WML variables: the non-board state
   * a digest covers. `$x1`/`$y1`/`$x2`/`$y2` are left out: the pump rewrites
   * them for every event it processes, so they are scratch values an undo
   * cannot and need not restore. The hash is order-insensitive where WML
   * order carries no meaning -- attributes (upstream keeps them in a sorted
   * map) and which array was created first -- so a state imported from a
   * real save hashes the same as the one this port reached.
   */
  private digestExtra(): Record<string, string | number | boolean | null> {
    const vars = this.eventPump.ctx.variables.toConfig().toJSON();
    const canonical = (cfg: WmlConfigJson, top: boolean): unknown => {
      const attrs = Object.entries(cfg.attrs)
        .filter(([k]) => !top || !EVENT_LOCATION_VARIABLES.has(k))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const tags = [...new Set(cfg.children.map((c) => c.tag))].sort();
      return [attrs, tags.map((tag) => [tag, cfg.children.filter((c) => c.tag === tag).map((c) => canonical(c.config, false))])];
    };
    return {
      turn: this.turnNumber,
      side: this.activeSide,
      result: this.scenarioResult,
      variables: fnv1a(JSON.stringify(canonical(vars, true))),
    };
  }

  /** The state digest each recorded command carries (see `stateDigest`). */
  stateDigest(): string {
    return stateDigest(this.board, this.digestExtra());
  }

  /** The text `stateDigest` hashes -- for diffing two states when a replay diverges. */
  describeState(): string {
    return stateDescription(this.board, this.digestExtra());
  }

  /**
   * Runs `command` as one synced action (`synced_context::run_and_store`):
   * records it, gives it its own RNG stream, collects its undo steps, and
   * afterwards either files it on the undo stack or -- if anything made it
   * irreversible -- clears the stack (`undo_list::finish_action`). `source`
   * is the recorded dependents when replaying or redoing. Returns `null` if
   * the executor refused the command, which then leaves no trace in the log.
   */
  private *runSynced<T>(
    command: SyncedCommand,
    exec: (action: ActionState) => Flow<T>,
    opts: { source?: readonly Dependent[] | null; present?: boolean } = {},
  ): Flow<T | null> {
    if (this.action) {
      // Already synced (synced_context::SYNCED): part of the running action.
      return yield* exec(this.action);
    }
    if (!this.redoing) this.undoList.clearRedo();
    const rec = this.recorder.add(command, this.activeSide);
    const action: ActionState = {
      rec,
      steps: [],
      undoBlocked: false,
      rejected: null,
      source: opts.source ? opts.source.map((d) => ({ ...d })) : null,
      present: opts.present ?? false,
    };
    this.action = action;
    this.eventPump.takeUndoDisabled();
    this.rng.beginAction();
    let result: T;
    try {
      result = yield* exec(action);
    } finally {
      this.rng.endAction();
      this.action = null;
    }
    if (action.rejected !== null) {
      if (action.source) this.reportSync(action, action.rejected);
      this.recorder.cutLast();
      return null;
    }
    if (action.source && action.source.length > 0) {
      this.reportSync(action, `${action.source.length} recorded dependent(s) left unused`);
    }
    const eventsDisabledUndo = this.eventPump.takeUndoDisabled();
    if (action.undoBlocked || eventsDisabledUndo || this.scenarioResult) this.undoList.clear();
    else this.undoList.push({ steps: action.steps, command: rec });
    rec.digest = this.stateDigest();
    return result;
  }

  /** Marks the running action as refused (`spectator.error`); returns `null` for the executor to pass on. */
  private reject(action: ActionState, message: string): null {
    action.rejected = message;
    return null;
  }

  /** Runs any command through its executor -- a replay's and a redo's entry point. */
  private *execCommand(command: SyncedCommand, action: ActionState): Flow<unknown> {
    switch (command.kind) {
      case 'move':
        return yield* this.execMove(command, action);
      case 'attack':
        return yield* this.execAttack(command, action);
      case 'recruit':
        return yield* this.execRecruit(command, action);
      case 'recall':
        return yield* this.execRecall(command, action);
      case 'disband':
        return this.execDisband(command, action);
      case 'init_side':
        return yield* this.execInitSide(command.side, action);
      case 'end_turn':
        return yield* this.execEndTurn(action);
      case 'fire_event':
        return yield* this.execFireEvent(command, action);
      case 'start':
        return yield* this.execStart();
      case 'stop_unit':
        return this.execStopUnit(command, action);
      case 'label':
      case 'clear_labels':
        this.applyLabelCommand(command);
        return true;
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  /** `[move]` (`execute_move_unit`): walks the steps, recording the move and any village taken for undo. */
  private *execMove(cmd: MoveCommand, action: ActionState): Flow<{ unit: Unit; outcome: PerformMoveResult } | null> {
    const steps = cmd.steps.map(locOf);
    const start = steps[0];
    const unit = start ? this.board.unitAt(start) : undefined;
    if (!start || !unit || steps.length < 2) return this.reject(action, `no unit to move at ${start ?? '?'}`);
    const startingMoves = unit.movesLeft;
    const startingFacing = unit.facing;
    const ownersBefore = steps.map((loc) => this.board.villageOwner(loc) ?? 0);
    // Phase 18d: `exit hex`/`enter hex` fire mid-move, as upstream's mover
    // does. Before one that has handlers, the walk so far is shown, so its
    // dialogue finds the unit where it is.
    let shownUpTo = 0;
    const showWalk = function* (this: GameSession, upTo: Location): Flow {
      const index = steps.findIndex((s, i) => i >= shownUpTo && s.equals(upTo));
      if (!action.present || index <= shownUpTo) return;
      yield { kind: 'beat', beat: { kind: 'moveUnit', unit, path: steps.slice(shownUpTo, index + 1) } };
      shownUpTo = index;
    }.bind(this);
    const hexEvent = (name: 'exit hex' | 'enter hex', current: Location, other: Location): Flow<boolean> =>
      this.hexEventFlow(name, current, other, showWalk);
    const outcome = yield* performMoveFlow(this.board, unit, steps, {
      raise: this.raiseEvent,
      viewingTeam: this.board.getTeam(unit.side),
      hexEvent,
    });
    const path = outcome.result.path;
    // A move that could not take a single step changed nothing, and the
    // real game rejects a recorded route the unit cannot walk ("found
    // corrupt movement in replay"), so it leaves no trace in the log.
    if (!outcome.moved) return this.reject(action, `the unit at ${start} could not move`);
    // Record the route actually walked, not the one asked for: upstream only
    // ever records a route that fits this turn's movement.
    if (!action.source && path.length !== steps.length) action.rec.command = { ...cmd, steps: path.map(hexOf) };
    {
      action.steps.push({ kind: 'move', unit, route: path, startingMoves, startingFacing });
      if (outcome.captured) action.steps.push({ kind: 'take_village', loc: unit.location, previousOwner: ownersBefore[path.length - 1] ?? 0 });
    }
    // unit_mover::undo_blocked: an ambush, a blocked or failed teleport, a fog/shroud reveal.
    if (outcome.result.undoBlocked) action.undoBlocked = true;
    // Phase 17: the walk is a cutscene beat like any other, so it plays
    // *before* whatever the `moveto`/`sighted` events it triggers have to
    // say -- the pump below would otherwise reach their dialogue while the
    // unit was still standing at its old hex on screen.
    if (action.present && path.length > shownUpTo + 1) yield { kind: 'beat', beat: { kind: 'moveUnit', unit, path: path.slice(shownUpTo) } };
    yield* this.pumpEventsFlow();
    return { unit, outcome };
  }

  /**
   * One `exit hex`/`enter hex` for a moving unit, fired now
   * (`unit_mover::fire_hex_event`); true if its WML ran `[cancel_action]`.
   * Nothing happens when no handler has that name.
   */
  private *hexEventFlow(name: 'exit hex' | 'enter hex', current: Location, other: Location, showWalk: (upTo: Location) => Flow): Flow<boolean> {
    if (this.eventPump.manager.handlersForName(standardizeEventName(name)).length === 0) return false;
    // The mover stands at `current` for both events.
    yield* showWalk(current);
    const ctx = this.eventPump.ctx;
    const outer = ctx.actionCanceled;
    ctx.actionCanceled = false;
    yield* this.fireFlow(name, current, other);
    const canceled = ctx.actionCanceled;
    ctx.actionCanceled = outer;
    return canceled;
  }

  /** Terrain/ToD inputs every attack between these two hexes is computed with. */
  private attackOptions(attackerLoc: Location, defenderLoc: Location) {
    return {
      attackerLawfulBonus: this.timeOfDayAt(attackerLoc).lawfulBonus,
      defenderLawfulBonus: this.timeOfDayAt(defenderLoc).lawfulBonus,
      maxLiminalBonus: this.schedule.maxLiminalBonus,
      resolveType: this.resolveType,
    };
  }

  /** The `[attack]` command for a chosen exchange, with upstream's informational fields filled in. */
  private attackCommand(attackerLoc: Location, weapon: number, defenderLoc: Location, defenderWeapon: number): AttackCommand {
    const attacker = this.board.unitAt(attackerLoc);
    const defender = this.board.unitAt(defenderLoc);
    return {
      kind: 'attack',
      source: hexOf(attackerLoc),
      destination: hexOf(defenderLoc),
      weapon,
      defenderWeapon,
      ...(attacker ? { attackerType: attacker.type.id, attackerLevel: attacker.level } : {}),
      ...(defender ? { defenderType: defender.type.id, defenderLevel: defender.level } : {}),
      turn: this.turnNumber,
      tod: this.currentTimeOfDay.id,
    };
  }

  /**
   * `[attack]` (`attack_unit_and_advance`): the `attack` event, the exchange,
   * then both survivors' advancement. Never undoable. Returns what the
   * display needs to animate it, or `null` when the `attack` event aborted it.
   */
  private *execAttack(cmd: AttackCommand, action: ActionState): Flow<LastAttackAnimation | null> {
    action.undoBlocked = true;
    const attackerLoc = locOf(cmd.source);
    const defenderLoc = locOf(cmd.destination);
    const attacker = this.board.unitAt(attackerLoc);
    const defender = this.board.unitAt(defenderLoc);
    if (!attacker || !defender) return this.reject(action, `no attacker at ${attackerLoc} or no defender at ${defenderLoc}`);
    if (!attacker.attacks[cmd.weapon]) return this.reject(action, `illegal weapon ${cmd.weapon}`);
    if (cmd.defenderWeapon >= defender.attacks.length) return this.reject(action, `illegal defender weapon ${cmd.defenderWeapon}`);

    yield* this.fireFlow('attack', attackerLoc, defenderLoc);
    this.checkForGameEnd();
    if (this.scenarioResult || this.board.unitAt(attackerLoc) !== attacker || this.board.unitAt(defenderLoc) !== defender) {
      // The attack event ended the scenario or moved/removed a combatant: upstream aborts the attack.
      return null;
    }

    // Captured before the exchange, for the per-blow HP bars (see LastAttackAnimation).
    const attackerHitpointsBefore = attacker.hitpoints;
    const defenderHitpointsBefore = defender.hitpoints;
    const attackerTypeId = attacker.type.id;
    const defenderTypeId = defender.type.id;
    const result = performAttack(this.board, this.rng, attackerLoc, cmd.weapon, defenderLoc, cmd.defenderWeapon, {
      ...this.attackOptions(attackerLoc, defenderLoc),
      raise: this.raiseEvent,
      // `last breath`/`die`, fired from inside `performAttack`'s own
      // callback: a plain function, so these cannot suspend -- their
      // messages are collected and shown after the attack animation
      // (`takeDeferredInteractions`).
      fire: (name, loc1, loc2) => this.eventPump.fire(name, loc1, loc2, undefined, this.collectResponder),
    });
    yield* this.eventPump.pumpFlow();

    // A unit that has fought is done moving (`attack::perform` spends the
    // weapon's `movement_used`, which defaults to all of it).
    if (!result.attackerDied) attacker.movesLeft = 0;

    // Advancement comes right after the exchange, before any victory check
    // (`attack_unit_and_advance`) -- the unit landing the winning kill still levels.
    if (!result.attackerDied) this.queueAdvancement(attacker);
    if (!result.defenderDied) this.queueAdvancement(defender);
    this.processAdvancementQueue(action.rec, action.source ? action : null);

    if (result.defenderDied || result.attackerDied) this.checkForGameEnd();
    return {
      attacker,
      attackerWeaponIndex: cmd.weapon,
      defender,
      defenderWeaponIndex: cmd.defenderWeapon,
      result,
      attackerHitpointsBefore,
      defenderHitpointsBefore,
      attackerTypeId,
      defenderTypeId,
      attackerLocation: attackerLoc,
      defenderLocation: defenderLoc,
    };
  }

  /** `[recruit]` (`recruit_unit`): a new unit of `type` at `loc`, called by the leader at `from`. */
  private *execRecruit(cmd: RecruitCommand, action: ActionState): Flow<{ result: PlaceRecruitResult; leader: Unit } | null> {
    const team = this.board.getTeam(this.activeSide);
    const from = locOf(cmd.from);
    const loc = locOf(cmd.loc);
    const leader = this.board.unitAt(from);
    if (!team || !leader) return this.reject(action, `recruiting leader not found at ${from}`);
    if (this.board.hasUnitAt(loc)) return this.reject(action, `cannot recruit onto ${loc}: occupied`);
    // `find_recruit_location`: the type has to be on the side's recruit list.
    if (!team.canRecruit.has(cmd.type)) return this.reject(action, `cannot recruit ${cmd.type}: none of the side's leaders can recruit it`);
    let type: UnitType;
    try {
      type = this.resolveType(cmd.type);
    } catch {
      return this.reject(action, `recruiting illegal unit '${cmd.type}'`);
    }
    const ownerBefore = this.board.villageOwner(loc) ?? 0;
    const result = yield* recruitUnitFlow(this.board, team, type, loc, from, this.rng, this.placeHooks(action));
    yield* this.pumpEventsFlow();
    if (!result) return null; // an event took the unit away again: nothing left to undo, and the undo stack was already cleared by it
    action.steps.push({ kind: 'recruit', unit: result.unit, side: team.side, loc, cost: result.cost });
    if (this.board.villageOwner(loc) !== (ownerBefore || undefined)) action.steps.push({ kind: 'take_village', loc, previousOwner: ownerBefore });
    return { result, leader };
  }

  /**
   * `placeRecruitFlow`'s hooks: its events fire through this session's pump
   * (suspending for dialogue), and -- when the action is being watched --
   * the new unit's arrival plays after `prerecruit`, as upstream animates it.
   */
  private placeHooks(action: ActionState): PlaceRecruitHooks {
    return {
      fire: (name, loc1, loc2) => this.fireFlow(name, loc1, loc2),
      raise: this.raiseEvent,
      ...(action.present
        ? {
            appear: function* (unit: Unit, leader: Unit | undefined): Flow {
              yield { kind: 'beat', beat: { kind: 'unitAppear', unit, ...(leader ? { by: leader } : {}) } };
            },
          }
        : {}),
    };
  }

  /** Finds a recall-list unit by the command's index (when the unit there still matches) or else by id. */
  private recallIndexFor(side: number, id: string, index: number | undefined): number {
    const list = this.board.recallList(side);
    if (index !== undefined && list[index] && (id === '' || list[index]!.id === id)) return index;
    return id === '' ? -1 : list.findIndex((u) => u.id === id);
  }

  /** `[recall]` (`recall_unit`): brings a recall-list unit back onto `loc`. */
  private *execRecall(cmd: RecallCommand, action: ActionState): Flow<{ result: PlaceRecruitResult; leader: Unit } | null> {
    const team = this.board.getTeam(this.activeSide);
    const from = locOf(cmd.from);
    const loc = locOf(cmd.loc);
    const leader = this.board.unitAt(from);
    if (!team || !leader) return this.reject(action, `recalling leader not found at ${from}`);
    const index = this.recallIndexFor(team.side, cmd.id, cmd.index);
    const unit = this.board.recallList(team.side)[index];
    if (!unit) return this.reject(action, `illegal recall: unit '${cmd.id}' not on the recall list`);
    if (this.board.hasUnitAt(loc)) return this.reject(action, `cannot recall onto ${loc}: occupied`);
    this.board.removeFromRecallListAt(team.side, index);
    const ownerBefore = this.board.villageOwner(loc) ?? 0;
    const result = yield* recallUnitFlow(this.board, team, unit, loc, from, this.placeHooks(action));
    yield* this.pumpEventsFlow();
    if (!result) return null;
    action.steps.push({ kind: 'recall', unit, side: team.side, loc, cost: result.cost, index });
    if (this.board.villageOwner(loc) !== (ownerBefore || undefined)) action.steps.push({ kind: 'take_village', loc, previousOwner: ownerBefore });
    return { result, leader };
  }

  /** `[disband]`: dismisses a recall-list unit for good (undoable, `undo::dismiss_action`). */
  private execDisband(cmd: DisbandCommand, action: ActionState): Unit | null {
    const side = this.activeSide;
    const index = this.recallIndexFor(side, cmd.id, cmd.index);
    const unit = index >= 0 ? dismissUnitAt(this.board, side, index) : undefined;
    if (!unit) return this.reject(action, `illegal disband of '${cmd.id}'`);
    action.steps.push({ kind: 'dismiss', unit, side, index });
    return unit;
  }

  /** This port's `[stop_unit]`: the AI giving up a unit's remaining moves and/or attacks. */
  private execStopUnit(cmd: StopUnitCommand, action: ActionState): boolean | null {
    const unit = this.board.unitAt(locOf(cmd.loc));
    if (!unit) return this.reject(action, `no unit to stop at ${locOf(cmd.loc)}`);
    if (cmd.movement) unit.movesLeft = 0;
    if (cmd.attacks) unit.attacksLeft = 0;
    return true;
  }

  /**
   * `[fire_event] raise="menu item <id>"`: runs a `[set_menu_item]`'s
   * `[command]` at the clicked hex, as the event upstream fires for it --
   * so, like any event, it makes the action non-undoable unless it says
   * `[allow_undo]`.
   */
  private *execFireEvent(cmd: FireEventCommand, action: ActionState): Flow<string | null> {
    const prefix = 'menu item ';
    const id = cmd.raise.startsWith(prefix) ? cmd.raise.slice(prefix.length) : null;
    const def = id !== null ? this.eventPump.ctx.menuItems.get(id) : undefined;
    if (!def) return this.reject(action, `no menu item for event '${cmd.raise}'`);
    const loc = cmd.source ? locOf(cmd.source) : Location.NULL;
    yield* this.eventPump.runAsHandlerFlow(def.command, loc, Location.NULL);
    this.checkForGameEnd();
    return def.description;
  }

  /** `[start]`: `prestart`, every side's initial shroud clearing, then `start` (`play_controller::start_game`). */
  private *execStart(): Flow<void> {
    // `[delay]` does nothing before the scenario starts, as upstream --
    // an opening cutscene's scripted pauses must not stall startup.
    this.eventPump.ctx.gameStarted = false;
    yield* this.fireFlow('prestart');
    // play_controller::init: every side's shroud is cleared from its starting units, without sighted events.
    for (const team of this.board.teams()) clearShroud(this.board, team.side);
    this.eventPump.ctx.gameStarted = true;
    yield* this.fireFlow('start');
    this.checkForGameEnd();
  }

  /** The side after `side` in turn order, and whether reaching it starts a new turn. */
  private sideAfter(side: number): { next: number; wrapped: boolean } | null {
    const sides = this.board
      .teams()
      .map((t) => t.side)
      .sort((a, b) => a - b);
    const idx = sides.indexOf(side);
    const wrapped = idx === -1 || idx === sides.length - 1;
    const next = wrapped ? sides[0] : sides[idx + 1];
    return next === undefined ? null : { next, wrapped };
  }

  /**
   * `[end_turn]`: the ending side's turn-end events (`finish_side_turn_events`),
   * the turn-end ones when the turn wraps (`finish_turn`), then the next
   * side becomes active. Never undoable.
   */
  private *execEndTurn(action: ActionState): Flow<void> {
    action.undoBlocked = true;
    // game_board::end_turn: the ending side's units lose `duration=turn end`
    // modifications and their slow, before the side-turn-end events.
    for (const unit of this.board.unitsForSide(this.activeSide)) unit.endTurn(effectEnvFor(this.eventPump.ctx, unit));
    yield* this.fireSideTurnEndEvents(this.activeSide);
    if (this.scenarioResult) return;
    const order = this.sideAfter(this.activeSide);
    if (!order) return;
    if (order.wrapped) {
      yield* this.fireFlow('turn end');
      yield* this.fireFlow(`turn ${this.turnNumber} end`);
      this.checkForGameEnd();
      if (this.scenarioResult) return;
      this.turnNumber += 1;
      yield* this.checkTimeOver();
      if (this.scenarioResult) return;
    }
    this.setActiveSide(order.next);
  }

  private mapItemsCache: { key: string; items: MapItemInfo[] } | null = null;

  /**
   * The items the viewing side sees, in drawing order (`display::
   * draw_overlays_at`): not in fog unless `visible_in_fog=`, and only for
   * the teams an item names. A new array only when that changes.
   */
  get mapItems(): MapItemInfo[] {
    const viewing = this.board.getTeam(this.viewingSide);
    const myTeams = (viewing?.teamName ?? '').split(',').map((n) => n.trim());
    const items: MapItemInfo[] = [];
    for (const item of this.eventPump.ctx.items.all()) {
      if (!item.visibleInFog && this.board.isFogged(this.viewingSide, item.loc)) continue;
      if (item.overlayTeamName !== '' && !item.overlayTeamName.split(',').some((n) => myTeams.includes(n.trim()))) continue;
      items.push({ x: item.loc.x, y: item.loc.y, image: item.image, halo: item.halo, submerge: item.submerge, zOrder: item.zOrder });
    }
    // Per hex by z_order, stable (`display::add_overlay` inserts before the first higher one).
    items.sort((a, b) => a.x - b.x || a.y - b.y || a.zOrder - b.zOrder);
    const key = JSON.stringify(items);
    if (this.mapItemsCache?.key !== key) this.mapItemsCache = { key, items };
    return this.mapItemsCache.items;
  }

  /**
   * The label a player would edit on `hex` (`map_labels::get_label`): the
   * viewing team's own, else the global one; `null` for none.
   */
  labelAt(hex: HexPoint): { text: string; teamOnly: boolean } | null {
    const loc = new Location(hex.x, hex.y);
    const myTeam = this.board.getTeam(this.viewingSide)?.teamName ?? '';
    const own = this.eventPump.ctx.labels.get(loc, myTeam);
    if (own) return { text: own.text, teamOnly: true };
    const global = this.eventPump.ctx.labels.get(loc, '');
    return global ? { text: global.text, teamOnly: false } : null;
  }

  /**
   * `menu_handler::label_terrain`: the viewing side's player labels `hex`
   * -- for its team only (white), or for everyone in the side's colour
   * (`sideColor`, `r,g,b`). Empty text removes it. A label placed is
   * recorded (`replay::add_label`); neither is undoable nor undoes anything.
   */
  placeLabel(hex: HexPoint, text: string, teamOnly: boolean, sideColor: string): void {
    if (!this.board.map.onBoard(new Location(hex.x, hex.y))) return;
    const label: MapLabel = {
      loc: new Location(hex.x, hex.y),
      text,
      tooltip: '',
      teamName: teamOnly ? (this.board.getTeam(this.viewingSide)?.teamName ?? '') : '',
      color: teamOnly ? LABEL_COLOR : sideColor,
      visibleInFog: true,
      visibleInShroud: false,
      immutable: false,
      category: '',
      creator: this.viewingSide,
    };
    this.eventPump.ctx.labels.set(label);
    if (text !== '') this.recorder.add({ kind: 'label', label: labelToConfig(label).toJSON() }, this.viewingSide).digest = this.stateDigest();
  }

  /** `menu_handler::clear_labels`: the viewing team's and the global labels that players may clear. Recorded. */
  clearLabels(): void {
    const teamName = this.board.getTeam(this.viewingSide)?.teamName ?? '';
    this.eventPump.ctx.labels.clearTeam(teamName, false);
    this.recorder.add({ kind: 'clear_labels', teamName, force: false }, this.viewingSide).digest = this.stateDigest();
  }

  /** A recorded `[label]`/`[clear_labels]`, as `replay.cpp` applies it: `set_label` takes only place, text, creator, team and colour. */
  private applyLabelCommand(command: LabelCommand | ClearLabelsCommand): void {
    const labels = this.eventPump.ctx.labels;
    if (command.kind === 'clear_labels') {
      labels.clearTeam(command.teamName, command.force);
      return;
    }
    const read = labelFromConfig(WmlConfig.fromJSON(command.label), this.eventPump.ctx);
    labels.set({ ...read, tooltip: '', visibleInFog: true, visibleInShroud: false, immutable: false, category: '' });
  }

  /** `display_context::hidden_label_categories` -- the label settings' choice; not saved with the game. */
  hiddenLabelCategories: string[] = [];

  /**
   * The label settings' rows (`label_settings`, over `map_labels::
   * all_categories`), sorted by key as upstream's map is: each category in
   * use (`cat:`), each side (`side:N`, not hidden sides), and team labels.
   */
  get labelCategories(): { id: string; name: string; visible: boolean; side?: number }[] {
    const ids = new Set<string>(['team', ...this.board.teams().map((t) => `side:${t.side}`)]);
    for (const label of this.eventPump.ctx.labels.all()) if (label.category !== '') ids.add(`cat:${label.category}`);
    const rows: { id: string; name: string; visible: boolean; side?: number }[] = [];
    for (const id of [...ids].sort()) {
      const visible = !this.hiddenLabelCategories.includes(id);
      if (id === 'team') rows.push({ id, name: t('Team Labels'), visible });
      else if (id.startsWith('cat:')) rows.push({ id, name: id.slice(4), visible });
      else {
        const team = this.board.getTeam(Number(id.slice(5)));
        if (!team || team.hidden) continue;
        const name = team.sideName || team.userTeamName || t('Unknown');
        rows.push({ id, name: fmt(tx('Side $side ($name)'), { side: team.side, name }), visible, side: team.side });
      }
    }
    return rows;
  }

  private mapLabelsCache: { key: string; labels: MapLabelInfo[] } | null = null;

  /**
   * The labels the viewing side sees (`terrain_label::viewable`/`hidden`):
   * its own team's labels, and global ones its team has not covered on the
   * same hex; not in fog unless `visible_in_fog=`, not under shroud unless
   * `visible_in_shroud=`. A new array only when that changes.
   */
  get mapLabels(): MapLabelInfo[] {
    const ctx = this.eventPump.ctx;
    const myTeam = this.board.getTeam(this.viewingSide)?.teamName ?? '';
    const labels: MapLabelInfo[] = [];
    for (const label of ctx.labels.all()) {
      if (label.teamName === '' ? ctx.labels.get(label.loc, myTeam) !== undefined && myTeam !== '' : label.teamName !== myTeam) continue;
      // terrain_label::hidden: the label settings, then fog and shroud.
      const hidden = this.hiddenLabelCategories;
      if (hidden.includes(`cat:${label.category}`)) continue;
      if (label.creator > 0 && hidden.includes(`side:${label.creator}`)) continue;
      if (label.teamName !== '' && hidden.includes('team')) continue;
      if (!label.visibleInFog && this.board.isFogged(this.viewingSide, label.loc)) continue;
      if (!label.visibleInShroud && this.board.isShrouded(this.viewingSide, label.loc)) continue;
      labels.push({ x: label.loc.x, y: label.loc.y, text: label.text, color: label.color, tooltip: label.tooltip });
    }
    labels.sort((a, b) => a.x - b.x || a.y - b.y);
    const key = JSON.stringify(labels);
    if (this.mapLabelsCache?.key !== key) this.mapLabelsCache = { key, labels };
    return this.mapLabelsCache.labels;
  }

  private terrainHexesCache: { version: number; hexes: TerrainHexInfo[] } | null = null;

  /**
   * The on-board terrain for the board view once WML has changed the map
   * (`[terrain]`, `[terrain_mask]`, a save that carried a changed map);
   * `null` while it is still the scenario's. A new array only after a change.
   */
  get terrainHexes(): TerrainHexInfo[] | null {
    const version = this.board.terrainVersion;
    if (version === 0) return null;
    if (this.terrainHexesCache?.version !== version) {
      const hexes: TerrainHexInfo[] = [];
      for (let x = 0; x < this.board.map.w(); x++) {
        for (let y = 0; y < this.board.map.h(); y++) hexes.push({ x, y, code: this.board.map.getTerrain(new Location(x, y)).toString() });
      }
      this.terrainHexesCache = { version, hexes };
    }
    return this.terrainHexesCache.hexes;
  }

  /** The scenario's turn limit (`turns=`, changed by `[modify_turns]`); `null` for none. */
  get turnLimit(): number | null {
    const limit = this.eventPump.ctx.turnLimit;
    return limit < 0 ? null : limit;
  }

  /**
   * `play_controller::check_time_over`, after the turn number moved on:
   * past the limit, `time over` fires; unless it added turns, the game
   * ends -- a victory if `check_victory` finds one, else a defeat.
   */
  private *checkTimeOver(): Flow<void> {
    const timeLeft = () => this.eventPump.ctx.turnLimit < 0 || this.turnNumber <= this.eventPump.ctx.turnLimit;
    if (timeLeft()) return;
    yield* this.fireFlow('time over');
    if (timeLeft() || this.scenarioResult) return;
    this.checkForGameEnd();
    if (this.scenarioResult) return;
    this.scenarioResult = 'defeat';
    this.clearSelection();
    this.log.unshift(tx('Defeat... time has run out.'));
  }

  /** Heal outcomes collected across one `endTurn()` call, for `lastHealAnimations`. */
  private healOutcomeSink: HealOutcome[] | null = null;

  /**
   * `[init_side]` (`play_controller::do_init_side`): the side-turn events,
   * then -- from turn 2 -- refreshed units, income and upkeep, then healing
   * (every side turn but the scenario's first), then the `turn refresh`
   * events. Never undoable.
   */
  private *execInitSide(side: number, action: ActionState): Flow<void> {
    action.undoBlocked = true;
    if (side !== this.activeSide) {
      if (action.source) this.reportSync(action, `[init_side] for side ${side}, but side ${this.activeSide} is playing`);
      this.setActiveSide(side);
    }
    yield* this.fireSideTurnEvents(side);
    this.checkForGameEnd();
    if (this.scenarioResult) return;
    if (this.turnNumber > 1) {
      // unit::new_turn: `duration=turn` modifications expire, full moves and
      // attacks, and ambushers revealed last turn can hide again.
      for (const unit of this.board.unitsForSide(side)) unit.newTurn(effectEnvFor(this.eventPump.ctx, unit));
      // team::new_turn: income = income= + the hardcoded base + villages *
      // village_gold; then upkeep (a unit's level, 0 for leaders) beyond
      // what villages support (`play_controller.cpp`).
      const team = this.board.getTeam(side);
      if (team) {
        team.applyIncome(this.totalIncomeFor(side));
        const expense = this.upkeepExpenseFor(side);
        if (expense > 0) team.spendGold(expense);
      }
    }
    if (this.doHealing) {
      // Rest/village healing, poison, and [heals]/[regenerate] (`calculate_healing`).
      const healOutcomes = applySideHealing(this.board, side).filter((o) => o.amount !== 0 || o.curePoison);
      for (const outcome of healOutcomes) {
        const name = this.unitDisplayName(outcome.unit);
        if (outcome.amount > 0) {
          const healerNote = outcome.healers.length > 0 ? ` (${outcome.healers.map((h) => this.unitDisplayName(h)).join(', ')})` : '';
          this.log.unshift(fmt(tx('$unit heals $amount HP$healers.'), { unit: name, amount: outcome.amount, healers: healerNote }));
        } else if (outcome.amount < 0) {
          this.log.unshift(fmt(tx('$unit takes $amount poison damage.'), { unit: name, amount: -outcome.amount }));
        }
        if (outcome.curePoison) this.log.unshift(fmt(tx("$unit's poison is cured."), { unit: name }));
      }
      this.healOutcomeSink?.push(...healOutcomes);
    }
    // "Do healing on every side turn except the very first side turn."
    this.doHealing = true;
    // "Set resting now after the healing has been done": a unit that rests
    // this turn earns the rest-heal at the start of its next one.
    for (const unit of this.board.unitsForSide(side)) unit.resting = true;
    yield* this.fireTurnRefreshEvents(side);
    this.playTurnSounds(side);
  }

  /** The turn the time of day's ambient sound last played on (`did_tod_sound_this_turn_`). */
  private todSoundTurn = -1;

  /**
   * `play_controller::init_side_end` and `playsingle_controller::
   * before_human_turn`: the time of day's own sound once per turn (in the
   * sound-source group), and the turn bell when a human side's turn begins.
   */
  private playTurnSounds(side: number): void {
    if (this.todSoundTurn !== this.turnNumber) {
      this.todSoundTurn = this.turnNumber;
      const sounds = this.currentTimeOfDay.sounds ?? '';
      if (sounds !== '') this.eventPump.ctx.playSound({ files: sounds, repeats: 0, group: 'sources' });
    }
    if (this.board.getTeam(side)?.controller === 'human') {
      this.eventPump.ctx.playSound({ files: GAME_SOUNDS.turnBell, repeats: 0, group: 'bell' });
    }
  }

  /** The AI's actions as synced commands (see `AiCommandHost`), run synchronously through the same executors. */
  private aiCommands(): AiCommandHost {
    const run = <T>(command: SyncedCommand, exec: (action: ActionState) => Flow<T>): T | null =>
      runFlow(this.runSynced(command, exec), this.collectResponder);
    return {
      move: (unit, path) => {
        if (path.length < 2) return performMove(this.board, unit, path, { raise: this.raiseEvent, viewingTeam: this.board.getTeam(unit.side) });
        const cmd: MoveCommand = { kind: 'move', steps: path.map(hexOf) };
        const done = run(cmd, (action) => this.execMove(cmd, action));
        // Refused (the unit could not take a step): nothing happened, and
        // the engine's own no-move outcome says so to the AI.
        return done?.outcome ?? performMove(this.board, unit, path, { raise: this.raiseEvent, viewingTeam: this.board.getTeam(unit.side) });
      },
      attack: (attackerLoc, weapon, defenderLoc, defenderWeapon) => {
        const def = defenderWeapon ?? resolveDefenderWeaponIndex(this.board, attackerLoc, weapon, defenderLoc, this.attackOptions(attackerLoc, defenderLoc));
        const cmd = this.attackCommand(attackerLoc, weapon, defenderLoc, def);
        return run(cmd, (action) => this.execAttack(cmd, action))?.result ?? null;
      },
      recruit: (team, type, loc, from) => {
        const cmd: RecruitCommand = { kind: 'recruit', type: type.id, loc: hexOf(loc), from: hexOf(from) };
        return run(cmd, (action) => this.execRecruit(cmd, action))?.result ?? null;
      },
      recall: (team, unit, loc, from) => {
        const index = this.board.recallList(team.side).indexOf(unit);
        const cmd: RecallCommand = { kind: 'recall', id: unit.id, index, loc: hexOf(loc), from: hexOf(from) };
        return run(cmd, (action) => this.execRecall(cmd, action))?.result ?? null;
      },
      stopUnit: (unit, movement, attacks) => {
        const cmd: StopUnitCommand = { kind: 'stop_unit', loc: hexOf(unit.location), movement, attacks };
        run(cmd, (action) => this.syncFlow(() => this.execStopUnit(cmd, action)));
      },
    };
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
    const playerTeam = this.board.getTeam(this.viewingSide);
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
    const isOwnUnit = unit.side === this.viewingSide;
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
      canAdvance: unit.advancesTo.length > 0,
      movesLeft: isOwnUnit ? unit.movesLeft : undefined,
      maxMoves: isOwnUnit ? unit.maxMoves : undefined,
      attacksLeft: isOwnUnit ? unit.attacksLeft : undefined,
      maxAttacksPerTurn: isOwnUnit ? unit.maxAttacksPerTurn : undefined,
      canMove,
      canAttackHere,
      statuses: [...unit.statuses],
      loyal: unit.loyal,
      ellipse: unit.ellipse,
      emitsZoc: unit.emitZoc,
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

  /**
   * Phase 22: upstream's "Show Enemy Moves" (`ignoreUnits` false) and "Best
   * Possible Enemy Moves" (true), `menu_handler::show_enemy_moves`: every
   * hex some enemy of the viewing side could reach this turn with full
   * movement. Only enemies the viewing side can see (not fogged, not hidden
   * by an ability) and that can act count; each is pathfound with the
   * viewing side's knowledge, its movement reset only for the calculation
   * (`unit_movement_resetter`).
   */
  enemyReach(ignoreUnits: boolean): { x: number; y: number }[] {
    const viewer = this.board.getTeam(this.viewingSide);
    if (!viewer) return [];
    const hexes = new Map<string, { x: number; y: number }>();
    for (const unit of this.board.allUnits()) {
      const team = this.board.getTeam(unit.side);
      if (!team || !viewer.isEnemy(team) || unit.incapacitated) continue;
      if (!isUnitVisibleToTeam(this.board, unit, viewer, false)) continue;
      const saved = unit.movesLeft;
      unit.movesLeft = unit.maxMoves;
      try {
        for (const step of reachableHexes(this.board, unit, { viewingTeam: viewer, ignoreUnits }).destinations.values()) {
          hexes.set(step.curr.key(), { x: step.curr.x, y: step.curr.y });
        }
      } finally {
        unit.movesLeft = saved;
      }
    }
    return [...hexes.values()];
  }

  /**
   * Phase 22: the live board as the minimap needs it (`buildMinimap`'s
   * input). Everything is included; the minimap itself filters out what the
   * viewing side may not know, as upstream's does. `visibility` is omitted
   * when the viewing side uses neither fog nor shroud.
   */
  minimapInput(reach?: ReadonlySet<string>): MinimapInput {
    const board = this.board;
    const map = board.map;
    const viewer = board.getTeam(this.viewingSide);
    const side = this.viewingSide;
    return {
      width: map.w(),
      height: map.h(),
      terrainAt: (x, y) => map.getTerrain(new Location(x, y)).toString(),
      visibility:
        viewer && viewer.fogOrShroud()
          ? (x, y) => {
              const loc = new Location(x, y);
              return board.isShrouded(side, loc) ? 'shrouded' : board.isFogged(side, loc) ? 'fogged' : 'clear';
            }
          : undefined,
      viewingSide: viewer ? side : null,
      isEnemy: (other) => {
        const team = board.getTeam(other);
        return !!viewer && !!team && viewer.isEnemy(team);
      },
      villages: map.villages.map((loc) => ({ x: loc.x, y: loc.y, owner: board.villageOwner(loc) ?? 0 })),
      units: board.allUnits().map((u) => {
        const snap = u.side === side ? this.toSnapshotUnit(u, u.location.x, u.location.y, u.hitpoints) : null;
        return {
          x: u.location.x,
          y: u.location.y,
          side: u.side,
          hidden: u.hidden,
          // Fog is the minimap's own check; this is only the hides-ability half.
          invisible: !!viewer && !isUnitVisibleToTeam(board, u, viewer, false),
          orb: snap ? orbStatusOf(snap) : undefined,
        };
      }),
      reach,
    };
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

  /** Vacant castle tiles the active side's recruiting leader (see `recruitingLeader`) could recruit/recall onto -- empty if there's no such leader right now. Deliberately NOT tied to `selectedUnit` -- see `recruitingLeader`'s own doc comment. Feeds the context menu's "is this hex a valid recruit/recall target" check and `tryRecruitAt`/`tryRecallAt`'s own validation (the board does not highlight them, as in real Wesnoth). */
  get recruitTiles(): HexPoint[] {
    const leader = this.recruitingLeader;
    return leader ? this.computeRecruitTiles(leader) : [];
  }

  /**
   * Where a recruit/recall chosen from the Ctrl+R/Alt+R dialog lands when
   * no hex was picked (bugs6.md): the first vacant recruit tile by x, then
   * y -- deterministic, and no extra click. `null` if the castle is full.
   */
  get autoRecruitTile(): HexPoint | null {
    const tiles = [...this.recruitTiles].sort((a, b) => a.x - b.x || a.y - b.y);
    return tiles[0] ?? null;
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
      const cost = u.recallCost >= 0 ? u.recallCost : team.recallCost;
      const snap = this.snapshot.unitTypes[u.type.id];
      return {
        index,
        name: this.unitDisplayName(u),
        typeId: u.type.id,
        typeName: u.type.name,
        image: snap?.image ?? null,
        hp: u.hitpoints,
        maxHp: u.maxHitpoints,
        level: u.level,
        cost,
        affordable: team.gold >= cost,
        xp: u.experience,
        maxXp: u.maxExperience,
        traits: u.traitNames,
        alignment: u.alignment,
        raceId: u.type.raceId,
        movesLeft: u.movesLeft,
        maxMoves: u.maxMoves,
        attacks: u.attacks.map(buildWeaponInfo),
        abilities: u.abilities.map(buildAbilityInfo),
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
    const unit = this.board.recallList(leader.side)[index];
    if (!unit) return;
    const cmd: DisbandCommand = { kind: 'disband', id: unit.id, index };
    const removed = runFlow(
      this.runSynced(cmd, (action) => this.syncFlow(() => this.execDisband(cmd, action))),
      this.collectResponder,
    );
    if (removed && this.pendingRecallIndex === index) this.pendingRecallIndex = null;
  }

  /** A plain function as a (never-suspending) flow, for commands whose executor has nothing to wait for. */
  private *syncFlow<T>(f: () => T): Flow<T> {
    return f();
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
    const name = this.resolveType(typeId).name || typeSnap?.name || typeId;
    const cost = typeSnap?.cost ?? 0;

    if (!this.recruitTiles.some((t) => t.x === loc.x && t.y === loc.y)) {
      return fmt(tx('Cannot recruit $unit there.'), { unit: name });
    }
    if (team.gold < cost) {
      return fmt(tx('Not enough gold to recruit $unit (needs $cost, have $gold).'), { unit: name, cost, gold: team.gold });
    }
    const cmd: RecruitCommand = { kind: 'recruit', type: typeId, loc: hexOf(loc), from: hexOf(leader.location) };
    const done = yield* this.runSynced(cmd, (action) => this.execRecruit(cmd, action), { present: true });
    if (!done) return fmt(tx('Cannot recruit $unit there.'), { unit: name });
    const message = fmt(tx('Recruited $unit for $cost gold.'), { unit: name, cost: done.result.cost });
    this.log.unshift(message);
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
    const cost = unit.recallCost >= 0 ? unit.recallCost : team.recallCost;

    if (!this.recruitTiles.some((t) => t.x === loc.x && t.y === loc.y)) {
      return fmt(tx('Cannot recall $unit there.'), { unit: name });
    }
    if (team.gold < cost) {
      return fmt(tx('Not enough gold to recall $unit (needs $cost, have $gold).'), { unit: name, cost, gold: team.gold });
    }
    // The recall-list position is recorded alongside the id: most of this
    // port's recall-list units share `underlyingId=0` and may lack an id,
    // so the index is what reliably names the unit the player picked.
    const cmd: RecallCommand = { kind: 'recall', id: unit.id, index, loc: hexOf(loc), from: hexOf(leader.location) };
    const done = yield* this.runSynced(cmd, (action) => this.execRecall(cmd, action), { present: true });
    if (!done) return fmt(tx('Cannot recall $unit there.'), { unit: name });
    const message = fmt(tx('Recalled $unit for $cost gold.'), { unit: name, cost: done.result.cost });
    this.log.unshift(message);
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
    this.healOutcomeSink = healOutcomes;
    try {
      return yield* this.endTurnLoop(maxAiSideTurns, aiAnimations, healOutcomes);
    } finally {
      this.healOutcomeSink = null;
    }
  }

  private *endTurnLoop(maxAiSideTurns: number, aiAnimations: AiAnimationEvent[], healOutcomes: HealOutcome[]): Flow<string> {
    let message = yield* this.advanceOneTurn();
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
      const next = yield* this.advanceOneTurn();
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
   * Ends the active side's turn and starts the next side's, as the two
   * synced commands upstream records for it -- `[end_turn]` (turn-end
   * events, and the turn counter when it wraps) then `[init_side]` (turn
   * events, refresh, income, healing -- see `execInitSide`). Returns the new
   * turn's banner message, or `null` if the scenario ended on the way.
   * Heal outcomes go to `healOutcomeSink` (see `lastHealAnimations`).
   */
  private *advanceOneTurn(): Flow<string | null> {
    if (this.scenarioResult) return null;
    this.clearSelection();
    yield* this.runSynced({ kind: 'end_turn', nextSide: this.activeSide + 1 }, (action) => this.execEndTurn(action));
    if (this.scenarioResult) return null;
    const side = this.activeSide;
    yield* this.runSynced({ kind: 'init_side', side }, (action) => this.execInitSide(side, action));
    if (this.scenarioResult) return null;
    const teamName = this.board.getTeam(side)?.teamName ?? String(side);
    const message = fmt(tx("Turn $turn -- side $side ($team)'s turn."), { turn: this.turnNumber, side, team: teamName });
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
    const upkeep = this.board.unitsForSide(side).reduce((sum, unit) => sum + unit.upkeepCost, 0);
    const support = this.board.villageCount(side) * team.supportPerVillage;
    return upkeep - support;
  }

  /** The active side's economy figures for the side panel -- see `EconomyInfo`'s own doc comment on each field. */
  get economyInfo(): EconomyInfo {
    const team = this.board.getTeam(this.activeSide);
    const expense = this.upkeepExpenseFor(this.activeSide);
    const upkeepTotal = this.board.unitsForSide(this.activeSide).reduce((sum, unit) => sum + unit.upkeepCost, 0);
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
  private readonly lastKnownVillageOwnerBySide = new Map<number, Map<string, number>>();

  /** The viewing side's memory of village owners (each side remembers its own). */
  private get lastKnownVillageOwner(): Map<string, number> {
    let memory = this.lastKnownVillageOwnerBySide.get(this.viewingSide);
    if (!memory) {
      memory = new Map();
      this.lastKnownVillageOwnerBySide.set(this.viewingSide, memory);
    }
    return memory;
  }

  private syncVillageMemory(): void {
    const memory = this.lastKnownVillageOwner;
    for (const loc of this.board.map.villages) {
      if (this.board.isFogged(this.viewingSide, loc)) continue;
      const side = this.board.villageOwner(loc);
      if (side !== undefined) memory.set(loc.key(), side);
      else memory.delete(loc.key());
    }
  }

  /** Every village whose owner is known to `playerSide` (current if visible, else last-known under fog), for the board's live ownership-flag markers -- unowned villages are omitted (nothing to mark; the terrain colour alone already shows "this is a village," see `SnapshotBoard`'s own doc comment). */
  get villageOwnership(): VillageOwnerInfo[] {
    const result: VillageOwnerInfo[] = [];
    for (const loc of this.board.map.villages) {
      const side = this.board.isFogged(this.viewingSide, loc) ? this.lastKnownVillageOwner.get(loc.key()) : this.board.villageOwner(loc);
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
    const team = this.board.getTeam(this.viewingSide);
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
        const visibility: HexVisibility = this.board.isShrouded(this.viewingSide, loc) ? 'shrouded' : this.board.isFogged(this.viewingSide, loc) ? 'fogged' : 'clear';
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
    // unit.alignment` and the unit's own fearless flag mirror
    // `computeUnitStats`'s own call exactly, so this is always the same
    // number that's actually folded into `damagePerBlow` above.
    const attackerToDModifier = combatModifier(
      attackerLawfulBonus,
      attackerWeapon.alignment ?? attacker.alignment,
      attacker.fearless,
      this.schedule.maxLiminalBonus,
    );
    const defenderToDModifier = defenderWeapon
      ? combatModifier(defenderLawfulBonus, defenderWeapon.alignment ?? defender.alignment, defender.fearless, this.schedule.maxLiminalBonus)
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
        typeName: attacker.type.name,
        image: this.snapshot.unitTypes[attacker.type.id]?.image ?? null,
        level: attacker.level,
        alignment: attacker.alignment,
        raceId: attacker.type.raceId,
        traits: attacker.traitNames,
        resistanceModifier: computeResistanceModifier(this.board, defender, attackerWeapon.type, false, defender.location),
        baseDamage: attackerWeapon.damage,
        hpDist: aCombatant.hpDist,
        lawfulBonus: attackerToDModifier,
        leadershipBonus: attackerLeadershipBonus,
        chargeActive,
        backstabActive: attackerBackstabActive,
        slowed: attacker.slowed,
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
        typeName: defender.type.name,
        image: this.snapshot.unitTypes[defender.type.id]?.image ?? null,
        level: defender.level,
        alignment: defender.alignment,
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
        slowed: defender.slowed,
        chanceToHitSource: chanceToHitSourceFor(defenderWeapon),
      },
    };

    return { attacker, defender, attackerWeaponIndex, defenderWeaponIndex, preview };
  }

  private *moveSelectedTo(dest: Location): Flow<string | null> {
    const unit = this.selectedUnit;
    if (!unit) return null;
    const route = findPath(this.board, unit, dest);
    if (route.steps.length < 2) return null;
    // Deselect before the walk, not after it. Upstream does exactly this
    // (`mouse_handler::move_unit_along_current_route`: "do not show
    // footsteps during movement" / "do not keep the hex highlighted that
    // we started from" -- it clears the route, the reach highlight and
    // the selected hex, then animates). Real, reported bug (bugs6.md):
    // the unit stayed selected throughout, so its reachable-hex overlay
    // sat on the map, anchored to the hex it had left, for the whole
    // walk. Re-selected below only when the move was cut short.
    this.clearSelection();
    // Phase 18b: the move runs as a synced `[move]` command -- recorded,
    // undoable when nothing was revealed, and the same executor the AI, a
    // replay and a redo use. It yields the walk beat and pumps the
    // `moveto`/`sighted` events itself.
    const cmd: MoveCommand = { kind: 'move', steps: route.steps.map(hexOf) };
    const done = yield* this.runSynced(cmd, (action) => this.execMove(cmd, action), { present: true });
    if (!done) return null;
    const result = done.outcome.result;
    const name = this.unitDisplayName(unit);
    const message = result.ambushed
      ? fmt(tx('$unit was ambushed!'), { unit: name })
      : result.sightedStop
        ? fmt(tx('$unit stopped: units sighted.'), { unit: name })
        : fmt(tx('$unit moved.'), { unit: name });
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
    const playerTeam = this.board.getTeam(this.viewingSide);
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
          return fmt(tx('$attacker could attack $defender -- review the prediction and confirm.'), { attacker: this.unitDisplayName(sel), defender: this.unitDisplayName(clickedUnit) });
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
        return fmt(tx('Viewing $unit.'), { unit: this.unitDisplayName(clickedUnit) });
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
        return fmt(tx('Viewing $unit.'), { unit: this.unitDisplayName(clickedUnit) });
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
    const vars = { striker: strikerName, target: targetName, damage: blow.damage, chance: blow.chanceToHit, amount: Math.abs(blow.drainAmount) };
    let msg = blow.hit
      ? fmt(tx('$striker hits $target for $damage damage ($chance|% chance to hit).'), vars)
      : fmt(tx('$striker misses $target ($chance|% chance to hit).'), vars);
    if (blow.drainAmount > 0) {
      msg += ' ' + fmt(tx('$striker drains $amount HP.'), vars);
    } else if (blow.drainAmount < 0) {
      msg += ' ' + (blow.strikerDiedFromDrain ? fmt(tx('$striker is destroyed by the drain!'), vars) : fmt(tx('$striker loses $amount HP to drain.'), vars));
    }
    if (blow.poisoned) msg += ' ' + fmt(tx('$target is poisoned.'), vars);
    if (blow.slowed) msg += ' ' + fmt(tx('$target is slowed.'), vars);
    if (blow.petrified) msg += ' ' + fmt(tx('$target is petrified!'), vars);
    if (blow.targetDied) msg += ' ' + fmt(tx('$target dies!'), vars);
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

    // Phase 18b: one synced `[attack]` command -- the `attack` event, the
    // exchange, advancement and the victory check all happen inside it
    // (`execAttack`), exactly as for the AI, a replay and a redo.
    const cmd = this.attackCommand(pending.attacker.location, pending.attackerWeaponIndex, pending.defender.location, pending.defenderWeaponIndex);
    const logBefore = this.log.length;
    const animation = yield* this.runSynced(cmd, (action) => this.execAttack(cmd, action), { present: true });
    if (!animation) {
      // The attack event ended the scenario or moved/removed a combatant: upstream aborts the attack.
      this.clearSelection();
      return null;
    }
    this.lastAttackAnimation = animation;
    const { result } = animation;

    const attackerName = pending.preview.attacker.name;
    const defenderName = pending.preview.defender.name;
    const hits = result.blows.filter((b) => b.hit).length;
    let message = fmt(tx('$attacker attacked $defender: $hits/$blows blows landed.'), { attacker: attackerName, defender: defenderName, hits, blows: result.blows.length });
    if (result.defenderDied) message += ' ' + fmt(tx('$unit was slain!'), { unit: defenderName });
    if (result.attackerDied) message += ' ' + fmt(tx('$unit was slain!'), { unit: attackerName });

    // One log line per blow, in the order they happened, under the summary
    // -- and both under anything the command logged itself (an advancement,
    // the victory line), which happened after the exchange. `log` is
    // most-recent-first, so the first blow ends up lowest.
    const loggedByCommand = this.log.length - logBefore;
    const lines = [message, ...result.blows.map((blow) => this.formatBlowMessage(blow, attackerName, defenderName)).reverse()];
    this.log.splice(loggedByCommand, 0, ...lines);
    this.clearSelection();
    return this.scenarioResult ? this.log[0]! : message;
  }

  cancelAttack(): void {
    this.pendingAttack = null;
  }

  /** Pushes `unit` onto the advancement queue if it's real, reported bug (bugs2.md "unit advancement"): a unit reaching full XP never actually advanced anywhere in this project -- `actions/advancement.ts` existed but nothing called it. No-op if `unit` doesn't currently have enough XP to advance. */
  private queueAdvancement(unit: Unit): void {
    if (unit.advances()) this.advancementQueue.push(unit);
  }

  /** Whether an AI plays `side` (its units' advancement choices are the AI's, not the player's). */
  private isAiSide(side: number): boolean {
    const controller = this.board.getTeam(side)?.controller;
    return controller === 'ai' || controller === 'network_ai';
  }

  /**
   * Drains `advancementQueue`: a unit with exactly one real
   * `advances_to=` option advances immediately (no choice to make,
   * matching upstream -- the dialog only ever appears for an actual
   * choice), and -- since overflow XP can cascade straight into ANOTHER
   * advancement (`Unit.advanceTo` carries it over) -- is re-queued if it
   * still qualifies afterward.
   *
   * A real choice is recorded as a dependent `[choose] value=` of the
   * attack that caused it (`rec`), as upstream's `get_user_choice("choose")`.
   * Replaying (`replay` set), it is read back from the log instead. An AI
   * side's unit chooses at random from the unsynced stream (upstream's AI
   * advancement choice is not synced randomness either). A player's unit
   * sets `pendingAdvancement` and stops draining; `chooseAdvancement`
   * records the answer and resumes.
   */
  private processAdvancementQueue(rec: RecordedCommand | null, replay: ActionState | null): void {
    while (this.advancementQueue.length > 0) {
      const unit = this.advancementQueue.shift()!;
      if (!unit.advances()) continue; // healed/demoted by something else in between -- no longer eligible.
      // Upstream's option list: `advances_to` types, then the AMLAs
      // (`get_modification_advances`); `[choose] value=` indexes both.
      const optionIds = unit.advancesTo;
      const amlas = unit.modificationAdvances();
      const count = optionIds.length + amlas.length;
      let index = 0;
      if (count > 1) {
        if (replay) {
          const dep = this.takeDependent(replay, 'choose');
          if (dep) replay.rec.dependents.push(dep);
          index = dep && dep.value >= 0 && dep.value < count ? dep.value : 0;
        } else if (this.isAiSide(unit.side)) {
          index = this.rng.unsynced.getNextRandom() % count;
          rec?.dependents.push({ kind: 'choose', value: index, side: unit.side });
        } else {
          const options = optionIds.map((id) => this.resolveType(id));
          this.advancementRec = rec;
          this.pendingAdvancement = {
            unit,
            options,
            amlaOptions: amlas,
            unitInfo: this.unitInfo(unit),
            optionInfos: [
              ...options.map((type) => ({
                typeId: type.id,
                name: type.name,
                level: type.level,
                hitpoints: type.hitpoints,
                image: this.snapshot.unitTypes[type.id]?.image ?? null,
                attacks: type.attacks.map(buildWeaponInfo),
              })),
              // An AMLA row, as upstream's dialog shows it: the [advancement]'s
              // own description and image, over the unit as it stands.
              ...amlas.map((amla, i) => ({
                typeId: `${AMLA_OPTION_PREFIX}${i}`,
                name: amla.getString('description', '') || amla.getString('id', 'AMLA'),
                level: unit.level,
                hitpoints: unit.maxHitpoints,
                image: amla.getString('image', '') || (this.snapshot.unitTypes[unit.type.id]?.image ?? null),
                attacks: unit.attacks.map(buildWeaponInfo),
              })),
            ],
          };
          return;
        }
      }
      this.applyAdvancementOption(unit, index, optionIds, amlas);
    }
    // Choices made after the action ended change what it left behind.
    if (!this.action && rec) rec.digest = this.stateDigest();
  }

  /**
   * Resolves the current `pendingAdvancement` to `typeId` (must be one of
   * its own `options`), records it as the attack's `[choose]`, logs it, and
   * resumes draining the advancement queue (the same unit re-queues itself
   * if overflow XP lets it advance again immediately).
   */
  chooseAdvancement(typeId: string): void {
    const pending = this.pendingAdvancement;
    if (!pending) return;
    const index = pending.optionInfos.findIndex((o) => o.typeId === typeId);
    if (index < 0) return;
    const rec = this.advancementRec;
    rec?.dependents.push({ kind: 'choose', value: index, side: pending.unit.side });
    this.advancementRec = null;
    this.pendingAdvancement = null;
    this.applyAdvancementOption(
      pending.unit,
      index,
      pending.options.map((t) => t.id),
      pending.amlaOptions,
    );
    this.processAdvancementQueue(rec, null);
  }

  /** `animate_unit_advancement`'s choice: index < types is a type, the rest are AMLAs. Re-queues the unit if it can go again. */
  private applyAdvancementOption(unit: Unit, index: number, typeIds: readonly string[], amlas: readonly WmlConfig[]): void {
    const before = unit.type.name;
    const env = effectEnvFor(this.eventPump.ctx, unit);
    if (index < typeIds.length) {
      const result = advanceUnitTo(unit, this.resolveType(typeIds[index]!), 100, env);
      this.log.unshift(fmt(tx('$unit advances to $type!'), { unit: before, type: result.unit.type.name }));
      if (result.canAdvanceAgain) this.advancementQueue.unshift(unit);
    } else {
      const amla = amlas[index - typeIds.length];
      if (!amla) return;
      const result = advanceUnitAmla(unit, amla, env);
      this.log.unshift(fmt(tx('$unit gains $advancement!'), { unit: before, advancement: amla.getString('description', '') || tx('an advancement') }));
      if (result.canAdvanceAgain) this.advancementQueue.unshift(unit);
    }
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
      scenarioName: this.scenarioName,
      ...(this.snapshot.difficulty ? { difficulty: this.snapshot.difficulty } : {}),
      schedule: this.schedule.exportState(),
      variables,
      choices: this.eventPump.ctx.choices.map((c) => ({ ...c })),
      startupEventsRun: this.startupEventsRun,
      rng: { seed: this.mtRng.getRandomSeedStr(), calls: this.mtRng.getRandomCalls() },
      goldCarryover: this.goldCarryover,
      tunnels: this.board.tunnels.toConfigs().map((c) => c.toJSON()),
      nextTeleportGroupId: this.board.tunnels.nextTeleportGroupId,
      usedItems: [...this.eventPump.ctx.usedItems],
      nextUnitId: this.board.nextUnitId,
      turnLimit: this.eventPump.ctx.turnLimit,
      items: this.eventPump.ctx.items.all().map((item) => itemToConfig(item).toJSON()),
      nextItemName: this.eventPump.ctx.items.nextItemName,
      labels: this.eventPump.ctx.labels.all().map((label) => labelToConfig(label).toJSON()),
      music: this.music.write().map((m) => m.toJSON()),
      soundSources: this.eventPump.ctx.soundSources.write().map((c) => c.toJSON()),
      mapData: this.board.terrainVersion > 0 ? this.board.map.write() : undefined,
      events: this.eventPump.manager.activeConfigs().map((c) => c.toJSON()),
      menuItems: [...this.eventPump.ctx.menuItems.values()].map((m) => ({ id: m.id, description: m.description, command: m.command.toJSON() })),
      objectives: [...this.eventPump.ctx.objectivesBySide].map(([side, objectives]) => ({ side, objectives })),
      objectiveConfigs: [...this.eventPump.ctx.objectivesConfigBySide].map(([side, cfg]) => ({ side, cfg: cfg.toJSON() })),
      randomMode: this.rng.mode,
      doHealing: this.doHealing,
      ...(this.replayStartData ? { replay: { start: this.replayStartData, commands: this.recorder.toJSON() } } : {}),
      undoStack: this.saveUndoStack(),
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
    // Before units and village ownership: a changed map decides where the villages are.
    if (data.mapData !== undefined && !this.board.applyMapData(data.mapData)) {
      this.log.unshift(tx("This save's map does not fit the scenario's; the scenario map is kept."));
    }
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
    this.board.tunnels.loadConfigs((data.tunnels ?? []).map((c) => WmlConfig.fromJSON(c)), data.nextTeleportGroupId ?? 0);
    this.rng.mode = data.randomMode ?? 'per_action';
    this.eventPump.ctx.usedItems = new Set(data.usedItems ?? []);
    if (data.turnLimit !== undefined) this.eventPump.ctx.turnLimit = data.turnLimit;
    if (data.items !== undefined) {
      this.eventPump.ctx.items.clear();
      for (const item of data.items) readPersistentItem(this.eventPump.ctx, WmlConfig.fromJSON(item));
    }
    if (data.nextItemName !== undefined) this.eventPump.ctx.items.nextItemName = data.nextItemName;
    if (data.labels !== undefined) {
      this.eventPump.ctx.labels.clear();
      for (const label of data.labels) this.eventPump.ctx.labels.set(labelFromConfig(WmlConfig.fromJSON(label), this.eventPump.ctx));
    }
    this.applySavedMusic(data.music);
    if (data.soundSources !== undefined) {
      this.eventPump.ctx.soundSources.clear();
      for (const source of data.soundSources) this.eventPump.ctx.soundSources.add(soundSourceFromConfig(WmlConfig.fromJSON(source)));
    }
    this.board.nextUnitId =
      data.nextUnitId ?? Math.max(0, ...[...data.units, ...(data.recall ?? [])].map((u) => u.underlyingId ?? 0));
    if (data.events) this.eventPump.manager.replaceAll(data.events.map((e) => WmlConfig.fromJSON(e)));
    if (data.menuItems) {
      this.eventPump.ctx.menuItems = new Map(
        data.menuItems.map((m) => [m.id, { id: m.id, description: m.description, command: WmlConfig.fromJSON(m.command) }]),
      );
    }
    if (data.objectives) {
      this.eventPump.ctx.objectivesBySide = new Map(data.objectives.map((o) => [o.side, o.objectives]));
    }
    if (data.objectiveConfigs) {
      this.eventPump.ctx.objectivesConfigBySide = new Map(data.objectiveConfigs.map((o) => [o.side, WmlConfig.fromJSON(o.cfg)]));
    }
    this.doHealing = data.doHealing ?? data.startupEventsRun;
    this.replayStartData = data.replay?.start ?? null;
    this.recorder.replaceAll(data.replay?.commands ?? []);
    this.syncIssues.length = 0;
    this.pendingAdvancement = null;
    this.advancementQueue.length = 0;
    this.advancementRec = null;
    this.turnNumber = data.turnNumber;
    this.setActiveSide(data.activeSide);
    this.scenarioResult = data.scenarioResult;
    this.startupEventsRun = data.startupEventsRun;
    // Optional-on-read (see `SaveGameData.schedule`'s own doc comment): an
    // older save simply leaves the schedule as freshly built from the
    // scenario's own static config.
    if (data.schedule) this.schedule.importState(data.schedule);
    this.clearSelection();
    this.lastKnownVillageOwnerBySide.clear();
    this.syncVillageMemory();
    this.restoreUndoStack(data.undoStack);
  }

  /** `[undo_stack]` as a save stores it -- units named by where they stand now. */
  private saveUndoStack(): SavedUndoStack {
    const hex = (loc: Location) => ({ x: loc.x, y: loc.y });
    const saveStep = (step: UndoStep): SavedUndoStep => {
      switch (step.kind) {
        case 'move':
          return { kind: 'move', route: step.route.map(hex), startingMoves: step.startingMoves, startingFacing: writeDirection(step.startingFacing) };
        case 'take_village':
          return { kind: 'take_village', loc: hex(step.loc), previousOwner: step.previousOwner };
        case 'recruit':
          return { kind: 'recruit', loc: hex(step.loc), side: step.side, cost: step.cost };
        case 'recall':
          return { kind: 'recall', loc: hex(step.loc), side: step.side, cost: step.cost, index: step.index };
        case 'dismiss':
          return { kind: 'dismiss', unit: savedUnitFields(step.unit), side: step.side, index: step.index };
        case 'event':
          return { kind: 'event', commands: step.commands.toJSON(), loc1: hex(step.loc1), loc2: hex(step.loc2) };
        default: {
          const exhaustive: never = step;
          return exhaustive;
        }
      }
    };
    return {
      undo: this.undoList.undoEntries.map((c) => ({ steps: c.steps.map(saveStep), command: cloneRecordedCommand(c.command) })),
      redo: this.undoList.redoEntries.map(cloneRecordedCommand),
    };
  }

  /**
   * Rebuilds the undo stack from a save. A step whose unit is no longer
   * where the save says makes the whole stack unusable, so it is dropped
   * rather than risk undoing the wrong unit (upstream discards a stack it
   * cannot read the same way).
   */
  private restoreUndoStack(saved: SavedUndoStack | undefined): void {
    this.undoList.clear();
    if (!saved) return;
    const loc = (h: { x: number; y: number }) => new Location(h.x, h.y);
    const unitAt = (h: { x: number; y: number }): Unit => {
      const unit = this.board.unitAt(loc(h));
      if (!unit) throw new Error(`no unit at ${loc(h)}`);
      return unit;
    };
    try {
      const undos = saved.undo.map((entry) => ({
        command: cloneRecordedCommand(entry.command),
        steps: entry.steps.map((step): UndoStep => {
          switch (step.kind) {
            case 'move':
              return {
                kind: 'move',
                unit: unitAt(step.route[step.route.length - 1]!),
                route: step.route.map(loc),
                startingMoves: step.startingMoves,
                startingFacing: parseDirection(step.startingFacing),
              };
            case 'take_village':
              return { kind: 'take_village', loc: loc(step.loc), previousOwner: step.previousOwner };
            case 'recruit':
              return { kind: 'recruit', unit: unitAt(step.loc), loc: loc(step.loc), side: step.side, cost: step.cost };
            case 'recall':
              return { kind: 'recall', unit: unitAt(step.loc), loc: loc(step.loc), side: step.side, cost: step.cost, index: step.index };
            case 'dismiss':
              return { kind: 'dismiss', unit: this.unitFromSave(step.unit, Location.NULL), side: step.side, index: step.index };
            case 'event':
              return { kind: 'event', commands: WmlConfig.fromJSON(step.commands), loc1: loc(step.loc1), loc2: loc(step.loc2) };
            default: {
              const exhaustive: never = step;
              return exhaustive;
            }
          }
        }),
      }));
      this.undoList.restore(undos, saved.redo.map(cloneRecordedCommand));
    } catch (e) {
      this.eventPump.ctx.log('warn', `discarding the saved undo stack: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 18b: undo, redo, replay
  // ---------------------------------------------------------------------------

  /**
   * Set by `undo` when the undone action was a move: the unit and the route
   * back, for the display to animate (the board is already updated). Read
   * it once and clear it, like `lastAttackAnimation`.
   */
  lastUndoneWalk: { unit: Unit; path: Location[] } | null = null;

  /** Whether the player can undo now: something on the stack, it is a human side's turn, nothing is running. */
  get canUndo(): boolean {
    return this.undoList.canUndo && this.canUseUndoStack();
  }

  get canRedo(): boolean {
    return this.undoList.canRedo && this.canUseUndoStack();
  }

  private canUseUndoStack(): boolean {
    return !this.scenarioResult && !this.action && !this.pendingAdvancement && !this.isAiSide(this.activeSide);
  }

  /**
   * Undoes the newest undoable action (`undo_list::undo`): its steps run
   * backwards, and its command leaves the log (`replay::undo_cut`) to wait
   * on the redo stack. Returns a log line, or `null` if there was nothing
   * to undo.
   */
  undo(): string | null {
    if (!this.canUndo) return null;
    const container = this.undoList.undo(this.board, (step) => {
      runFlow(this.eventPump.runAsHandlerFlow(step.commands, step.loc1, step.loc2), this.collectResponder);
    });
    if (!container) return null;
    // Upstream walks the unit back (`move_action::undo` -> `unit_display::move_unit`).
    const moveStep = container.steps.find((st) => st.kind === 'move');
    this.lastUndoneWalk = moveStep && moveStep.kind === 'move' ? { unit: moveStep.unit, path: [...moveStep.route].reverse() } : null;
    const log = this.recorder.commands;
    if (log[log.length - 1] === container.command) this.recorder.cutLast();
    else this.recorder.replaceAll(log.filter((c) => c !== container.command));
    this.clearSelection();
    this.syncVillageMemory();
    const message = fmt(tx('Undid $action.'), { action: describeCommand(container.command.command) });
    this.log.unshift(message);
    return message;
  }

  /**
   * Redoes the newest undone action (`undo_list::redo`): its recorded
   * command runs again through the normal executor, with its recorded
   * dependents -- the same seeds, so a redone recruit gets the same traits.
   */
  async redo(): Promise<string | null> {
    if (!this.canRedo) return null;
    const rec = this.undoList.takeRedo();
    if (!rec) return null;
    this.clearSelection();
    this.redoing = true;
    try {
      await this.drive(this.runSynced(rec.command, (action) => this.execCommand(rec.command, action), { source: rec.dependents, present: true }));
    } finally {
      this.redoing = false;
    }
    const message = fmt(tx('Redid $action.'), { action: describeCommand(rec.command) });
    this.log.unshift(message);
    return message;
  }

  /** The command log so far (upstream's `[replay]`). */
  get replayLog(): readonly RecordedCommand[] {
    return this.recorder.commands;
  }

  /** Where the log starts from: the scenario before its `start` command. `null` until startup has run (or for an older save). */
  get replayStart(): SaveGameData | null {
    return this.replayStartData;
  }

  /**
   * Replays one recorded command on this session (which must be at the
   * state the log reached just before it): runs it with its recorded
   * dependents and, when the record carries a digest, checks the state it
   * leaves behind. Anything that does not match lands in `syncIssues`.
   * Returns whether the command ran.
   */
  *replayCommandFlow(rec: RecordedCommand, present = false): Flow<boolean> {
    if (rec.command.kind === 'label' || rec.command.kind === 'clear_labels') {
      // Not synced: applied as recorded, never on the undo stack.
      this.applyLabelCommand(rec.command);
      this.recorder.add(rec.command, rec.side);
      return true;
    }
    if (rec.command.kind === 'start') this.startupEventsRun = true;
    const before = this.syncIssues.length;
    // Shown replays animate like live play: the attack's blows
    // (`lastAttackAnimation`) and a side turn's healing (`lastHealAnimations`).
    const heals: HealOutcome[] = [];
    if (present) this.healOutcomeSink = heals;
    let done: unknown;
    try {
      done = yield* this.runSynced(rec.command, (action) => this.execCommand(rec.command, action), { source: rec.dependents, present });
    } finally {
      if (present) this.healOutcomeSink = null;
    }
    if (present) {
      if (rec.command.kind === 'attack' && done) this.lastAttackAnimation = done as LastAttackAnimation;
      if (heals.length > 0) this.lastHealAnimations = heals;
    }
    const mine = this.recorder.last();
    if (done !== null && rec.digest !== undefined && mine && mine.digest !== rec.digest && this.syncIssues.length === before) {
      this.syncIssues.push({
        index: this.recorder.length - 1,
        command: rec.command.kind,
        message: tx('the state after this command differs from the recorded game'),
      });
    }
    return done !== null;
  }

  /** `replayCommandFlow` headless: interactions answered from the log or automatically, nothing shown. */
  replayCommand(rec: RecordedCommand): boolean {
    return runFlow(this.replayCommandFlow(rec, false), this.collectResponder);
  }

  /** `replayCommandFlow` driven through `interactionHost`, so the replay viewer shows walks, attacks and dialogue. */
  async replayCommandShown(rec: RecordedCommand): Promise<boolean> {
    return this.drive(this.replayCommandFlow(rec, true));
  }

  /**
   * A session at the start of `data`'s replay, ready for `replayCommand`
   * (`null` if the save has no replay). Runs with the save's random mode and
   * never draws a fresh seed unless the log runs out, which is itself
   * reported as a divergence.
   */
  static forReplay(snapshot: GameBoardSnapshot, data: SaveGameData, options: GameSessionOptions = {}): GameSession | null {
    const replay = data.replay;
    if (!replay) return null;
    const mode = { ...options, randomMode: data.randomMode ?? 'per_action' } as const;
    if (replay.start) {
      const session = GameSession.fromSaveData(snapshot, replay.start, mode);
      session.replayStartData = replay.start;
      return session;
    }
    if (!replay.wesnothStart) return null;
    // A real game's replay: this port's own setup of the scenario, with the
    // gold and recall lists the real one was entered with.
    const session = new GameSession(snapshot, mode);
    for (const { side, gold } of replay.wesnothStart.gold) {
      const team = session.board.getTeam(side);
      if (team) team.gold = gold;
    }
    for (const u of replay.wesnothStart.recall) session.board.addToRecallList(u.side, session.unitFromSave(u, Location.NULL));
    session.replayStartData = session.toSaveData();
    return session;
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
      name: u.name === null ? undefined : typeof u.name === 'string' ? u.name : TString.fromJSON(u.name),
      canRecruit: u.canRecruit,
      role: u.role,
      hidden: u.hidden,
      underlyingId: u.underlyingId,
      facing: u.facing !== undefined ? parseDirection(u.facing) : undefined,
      profile: u.profile,
      gender: u.gender,
      variation: u.variation,
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
    const session = new GameSession(snapshot, { ...options, deferMusic: true });
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
      scenarioTurnsLimit: this.turnLimit,
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

    const session = new GameSession(nextSnapshot, { music: finished.music, ...options, goldCarryover });
    const team = session.board.getTeam(session.playerSide);
    if (team) team.gold = goldCarryover.nextScenarioGold;
    for (const unit of carriedOverUnits) {
      // game_board::new_scenario: a carried-over unit starts the next
      // scenario healed, unafflicted, with temporary modifications gone.
      const env = effectEnvFor(session.eventPump.ctx, unit);
      unit.newScenario(env);
      unit.newTurn(env);
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
      this.log.unshift(endLevel.result === 'victory' ? tx('Victory!') : tx('Defeat.'));
      this.playScenarioEndMusic();
      return;
    }
    const { continueLevel, notDefeated } = checkVictory(this.board);
    if (continueLevel) return;
    this.scenarioResult = notDefeated.includes(this.playerSide) ? 'victory' : 'defeat';
    this.clearSelection();
    this.log.unshift(
      this.scenarioResult === 'victory' ? tx('Victory! The enemy has been defeated.') : tx('Defeat... your side has fallen.'),
    );
    this.playScenarioEndMusic();
  }
}
