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
  getAdjacentTiles,
  reachableHexes,
  findPath,
  executeMove,
  executeAttack,
  isBackstabActive,
  computeLeadershipBonus,
  computeResistanceModifier,
  playAiTurn,
  type AiAnimationEvent,
  type ScenarioObjectives,
  advanceUnitTo,
  type AttackBlowResult,
  type AttackResult,
  buildBattleContext,
  chooseDefenderWeaponIndex,
  simulateCombat,
  RngDeterministic,
  MtRng,
  gameBoardFromSnapshot,
  createTypeResolver,
  EventManager,
  EventPump,
  VariableStore,
  WmlConfig,
  clearShroud,
  recalculateFog,
  getVisibleUnit,
  isUnitVisibleToTeam,
  type RaiseEvent,
  connectedCastleTiles,
  recruitUnit,
  recallUnit,
  unitCanAct,
  checkVictory,
  applySideHealing,
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
  type GoldCarryoverResult,
  type WmlAttributeValue,
  type WmlConfigJson,
  type AttackType,
  type RegistryEntry,
} from '@wesnothweb2/engine';

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
}

/** Builds a `SelectedUnitInfo` view-model for any live `Unit` -- shared by `GameSession.selectedUnitInfo`/`inspectedUnitInfo` (`GameShell.svelte` used to build this itself, inline, only for `selectedUnit`; centralised here so both selection and inspection stay in sync with each other and with `WeaponInfo`/`AbilityInfo`). */
export function buildUnitInfo(board: GameBoard, unit: Unit, displayName: string): SelectedUnitInfo {
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
export interface PendingAdvancement {
  readonly unit: Unit;
  readonly options: readonly UnitType[];
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
}

/** One recruitable unit type, ready for the side panel's recruit list. */
export interface RecruitOption {
  typeId: string;
  name: string;
  cost: number;
  image: string | null;
  /** Whether the recruiting side currently has enough gold -- the UI should grey this option out, not hide it. */
  affordable: boolean;
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
}

/**
 * `GameSession`'s own live-state save shape -- NOT a Wesnoth-compatible
 * save file (see `persistence.ts`'s doc comment for what's deliberately
 * left out: WML variables, replay/undo history). Plain JSON, versioned so
 * a future shape change can detect and reject an old save cleanly instead
 * of silently misreading it.
 */
export interface SaveGameData {
  version: 1;
  turnNumber: number;
  activeSide: number;
  scenarioResult: 'victory' | 'defeat' | null;
  startupEventsRun: boolean;
  teams: readonly { side: number; gold: number; shroudData?: string; fogData?: string }[];
  units: readonly {
    id: string | null;
    name: string | null;
    typeId: string;
    side: number;
    x: number;
    y: number;
    canRecruit: boolean;
    hitpoints: number;
    maxHitpoints: number;
    movesLeft: number;
    maxMoves: number;
    attacksLeft: number;
    maxAttacksPerTurn: number;
  }[];
  /**
   * Every side's recall-list units (off-board, so no x/y) -- added
   * alongside the Recall UI/carryover work; optional on read so a save
   * written before this field existed still loads (as an empty recall
   * list for every side, via `loadSaveData`'s `data.recall ?? []`).
   */
  recall?: readonly {
    side: number;
    id: string | null;
    name: string | null;
    typeId: string;
    hitpoints: number;
    maxHitpoints: number;
    level: number;
  }[];
  /**
   * The live ToD schedule's mutated state (`[replace_schedule]`'s new
   * global schedule, every active `[time_area]`) -- optional on read so a
   * save written before Phase 12 still loads (the schedule then just
   * stays as freshly rebuilt from the scenario's own static `[time]`
   * config, matching this field's absence).
   */
  schedule?: ScheduleState;
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
  /** Vacant castle tiles `selectedUnit` (a leader on its keep) could recruit onto -- empty otherwise. */
  recruitTiles: HexPoint[] = [];
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
   * Set by `handleHexClick`'s move branch every time a HUMAN move
   * actually enters at least one new hex -- see `LastMoveAnimation`'s own
   * doc comment. Same read-once-then-clear contract as
   * `lastAttackAnimation`. Not set for a move that resolves to zero
   * actual steps (e.g. clicking a unit's own hex), and not set for
   * AI-played moves (`playAiSide` calls `executeMove` directly) for the
   * same reasoning as attacks.
   */
  lastMoveAnimation: LastMoveAnimation | null = null;
  /**
   * Set by `tryRecruitAt`/`tryRecallAt` every time a HUMAN recruit/recall
   * actually places a unit -- see `LastRecruitAnimation`'s own doc
   * comment. Same read-once-then-clear contract as `lastAttackAnimation`.
   * Not set for AI-played recruits (`playAiTurn` places units directly)
   * for the same reasoning as attacks/moves.
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
   */
  readonly goldCarryover: GoldCarryoverResult | null;

  /** Resolves any of the ~332 real unit types the snapshot ships (board units, event-spawned units, recruit lists) -- see `createTypeResolver`. */
  private readonly resolveType: (id: string) => UnitType;
  private readonly rng: RngDeterministic;
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

  constructor(snapshot: GameBoardSnapshot, options: GameSessionOptions = {}) {
    this.snapshot = snapshot;
    this.playerSide = options.playerSide ?? 1;
    this.activeSide = this.playerSide;
    this.board = gameBoardFromSnapshot(snapshot).board;
    this.resolveType = createTypeResolver(snapshot);
    this.rng = new RngDeterministic(new MtRng(options.seed ?? 0xc0ffee));
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
    });
    this.board.lawfulBonusAt = (loc) => this.timeOfDayAt(loc).lawfulBonus;
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
    const raw = this.snapshot.scenarioConfigJson.attrs['next_scenario'];
    if (raw === undefined || raw === null) return null;
    const id = String(raw).trim();
    return id.length > 0 ? id : null;
  }

  /**
   * Runs the scenario's real `prestart`/`start` events once (spawning the
   * event-placed units, recording `[message]` dialogue -- see
   * `runScenarioStartupEvents`). Safe to call more than once; only the
   * first call has any effect. Returns the recorded messages (empty on a
   * repeat call).
   */
  runStartupEvents(): RecordedMessage[] {
    if (this.startupEventsRun) return [];
    this.startupEventsRun = true;
    this.fire('prestart');
    // play_controller::init: every side's shroud is cleared from its starting units, without sighted events.
    for (const team of this.board.teams()) clearShroud(this.board, team.side);
    this.fire('start');
    this.fireSideTurnEvents(this.activeSide);
    this.fireTurnRefreshEvents(this.activeSide);
    this.checkForGameEnd();
    const messages = this.takeEventMessages();
    const objectives = this.eventPump.ctx.objectivesBySide.get(this.playerSide);
    // Real `team.objectives_changed = not silent` -- a silent firing updates
    // the side's objectives without popping the dialog (matches upstream's
    // own gate on whether `show_objectives` should auto-trigger).
    if (objectives && !objectives.silent) this.scenarioObjectives = objectives;
    return messages;
  }

  /** `[message]`s recorded by events since the last call (startup or in-play), oldest first. */
  takeEventMessages(): RecordedMessage[] {
    return this.eventPump.ctx.messages.splice(0);
  }

  private fire(name: string, loc1?: Location, loc2?: Location): void {
    if (this.scenarioResult) return;
    this.eventPump.fire(name, loc1, loc2);
  }

  /** Pumps anything raised by the last action (sighted, moveto, ...), then applies `[endlevel]`/leader loss. */
  private pumpEvents(): void {
    if (!this.scenarioResult) this.eventPump.pump();
    this.checkForGameEnd();
    this.syncVillageMemory();
  }

  /** `play_controller::do_init_side`'s events that come before income and healing. */
  private fireSideTurnEvents(side: number): void {
    const turn = this.turnNumber;
    this.eventPump.ctx.variables.set('side_number', side);
    this.eventPump.ctx.variables.set('turn_number', turn);
    if (this.turnEventsFiredFor !== turn) {
      this.turnEventsFiredFor = turn;
      this.fire(`turn ${turn}`);
      this.fire('new turn');
    }
    this.fire('side turn');
    this.fire(`side ${side} turn`);
    this.fire(`side turn ${turn}`);
    this.fire(`side ${side} turn ${turn}`);
  }

  /** `do_init_side`'s `turn refresh` events, then `clear_shroud(side, true)` so vision is accurate. */
  private fireTurnRefreshEvents(side: number): void {
    const turn = this.turnNumber;
    this.fire('turn refresh');
    this.fire(`side ${side} turn refresh`);
    this.fire(`turn ${turn} refresh`);
    this.fire(`side ${side} turn ${turn} refresh`);
    clearShroud(this.board, side, { resetFog: true, raise: this.raiseEvent });
    this.pumpEvents();
  }

  /** `play_controller::finish_side_turn_events`. */
  private fireSideTurnEndEvents(side: number): void {
    const turn = this.turnNumber;
    clearShroud(this.board, side, { raise: this.raiseEvent });
    this.fire('side turn end');
    this.fire(`side ${side} turn end`);
    this.fire(`side turn ${turn} end`);
    this.fire(`side ${side} turn ${turn} end`);
    // Refog only after all of the side's own events are done.
    recalculateFog(this.board, side, this.raiseEvent);
    this.pumpEvents();
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
   * The board as it looked exactly at `message`'s own `[message]` boundary
   * -- see `RecordedMessage.unitsBefore`'s own doc comment. Real, reported
   * bug (bugs2.md "Lua events/narration ... not synced with the
   * narrative messages"): `GameShell.svelte` used to show every startup
   * message against the board's FINAL, fully-resolved state (every
   * startup event already having run to completion beforehand), so e.g.
   * Dead_Water's Gwabbo was already standing at the keep by the time his
   * very first line ("Back, you fiend!...") displayed, even though his
   * scripted retreat there is written to happen only AFTER that line.
   * Stepping `units` through this per-message instead keeps the board in
   * sync with the story as it's actually being told.
   */
  messageUnitSnapshot(message: RecordedMessage): SnapshotUnit[] {
    return message.unitsBefore.map((c) => this.toSnapshotUnit(c.unit, c.x, c.y, c.hitpoints));
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
    return buildUnitInfo(this.board, u, this.unitDisplayName(u));
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
    this.recruitTiles = this.computeRecruitTiles(unit);
  }

  clearSelection(): void {
    this.selectedUnit = null;
    this.inspectedUnit = null;
    this.reachable = [];
    this.attackCandidates = [];
    this.recruitTiles = [];
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

  /** The selected leader's side's real recruitable types (cost/name/image from `snapshot.unitTypes`), if it's currently able to recruit. Empty otherwise. */
  get recruitOptions(): RecruitOption[] {
    const leader = this.selectedUnit;
    if (!leader || this.recruitTiles.length === 0) return [];
    const team = this.board.getTeam(leader.side);
    if (!team) return [];
    return [...team.canRecruit].map((typeId) => {
      const snap = this.snapshot.unitTypes[typeId];
      const cost = snap?.cost ?? 0;
      return {
        typeId,
        name: snap?.name ?? typeId,
        cost,
        image: snap?.image ?? null,
        affordable: team.gold >= cost,
      };
    });
  }

  /** Arms (or, called again with the same id, disarms) a pending recruit -- the next click on one of `recruitTiles` places it. Clears any pending recall (mutually exclusive, see `pendingRecallIndex`). */
  selectRecruitType(typeId: string | null): void {
    this.pendingRecruitTypeId = this.pendingRecruitTypeId === typeId ? null : typeId;
    this.pendingRecallIndex = null;
  }

  /**
   * The selected leader's side's current recall list, if it's currently
   * able to recruit/recall (same gating as `recruitOptions` -- a leader on
   * its keep with at least one vacant, keep-connected castle tile). See
   * `RecallOption`'s own doc comment for why `index` (not `underlyingId`)
   * is the selection key.
   */
  get recallOptions(): RecallOption[] {
    const leader = this.selectedUnit;
    if (!leader || this.recruitTiles.length === 0) return [];
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
      };
    });
  }

  /** Arms (or, called again with the same index, disarms) a pending recall -- the next click on one of `recruitTiles` places it. Clears any pending recruit (mutually exclusive, see `pendingRecruitTypeId`). */
  selectRecallUnit(index: number | null): void {
    this.pendingRecallIndex = this.pendingRecallIndex === index ? null : index;
    this.pendingRecruitTypeId = null;
  }

  /**
   * Places `typeId` at `loc` for the selected leader's side, mirroring
   * `actions::recruit_unit` (`recruitUnit`) after validating the click.
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
  private tryRecruitAt(typeId: string, loc: Location): string | null {
    const leader = this.selectedUnit;
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
    const result = recruitUnit(this.board, team, type, loc, leader.location, this.rng, this.raiseEvent);
    this.lastRecruitAnimation = { unit: result.unit, leader };
    const message = `Recruited ${name} for ${result.cost} gold.`;
    this.log.unshift(message);
    this.eventPump.raise('recruit', loc, leader.location);
    this.pumpEvents();
    // Re-select the leader so recruitTiles/attackCandidates refresh (the
    // just-filled tile is no longer vacant) -- the leader's own moves/
    // attacks are untouched by recruiting.
    this.selectUnit(leader);
    return message;
  }

  /**
   * Places recall-list entry `index` (see `RecallOption.index`) at `loc`
   * for the selected leader's side, mirroring `tryRecruitAt` but for an
   * already-existing `Unit` pulled off `board.recallList` (via the real
   * `recallUnit`, which keeps its saved hp/level rather than healing it to
   * full -- see `recruit.ts`'s `placeRecruit`'s own doc comment). Same
   * deliberate "no `checkRecruitLocation` alternate-location fallback" call
   * as `tryRecruitAt` -- see that method's own doc comment.
   */
  private tryRecallAt(index: number, loc: Location): string | null {
    const leader = this.selectedUnit;
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
    const result = recallUnit(this.board, team, unit, loc, leader.location, undefined, this.raiseEvent);
    this.lastRecruitAnimation = { unit: result.unit, leader };
    const message = `Recalled ${name} for ${result.cost} gold.`;
    this.log.unshift(message);
    this.eventPump.raise('recall', loc, leader.location);
    this.pumpEvents();
    this.selectUnit(leader);
    return message;
  }

  /**
   * Cycles to the next side in ascending side-number order (wrapping past
   * the highest side back to the lowest, which is also when `turnNumber`
   * increments), refreshing that side's units' moves/attacks to full --
   * mirroring a real "start of turn" refresh (see this project's own
   * `Unit.create`/`Unit.fromConfig` defaults for what "full" means).
   *
   * ## Hotseat, plus a real AI for `controller=ai` sides (2026-09-11)
   *
   * Until this session, there was no AI (Phase 7), so EVERY side --
   * including `controller=ai` ones -- was actually played by whichever
   * human sat at the keyboard (hotseat). `packages/engine/src/ai/
   * simpleAi.ts`'s `playAiTurn` now exists (a real, if deliberately
   * simple, heuristic AI reusing this project's own real combat-
   * prediction/pathfinding/recruit code), so `endTurn` now auto-plays any
   * `ai`/`network_ai`-controlled side immediately upon reaching it,
   * looping through any further consecutive AI sides, and only returns
   * once a human-controlled side is reached (or the scenario ends).
   * `activeSide` (not `playerSide`) still gates who can be selected/
   * moved/attacked/recruited with in `handleHexClick`, for any side a
   * human ends up controlling (including a `human`-controlled side that
   * isn't `playerSide` -- true hotseat, unchanged from before).
   */
  endTurn(): string {
    const aiAnimations: AiAnimationEvent[] = [];
    let message = this.advanceOneTurn();
    if (!message) return '';
    // Auto-play consecutive AI-controlled sides. Bounded by `sides.length`
    // guard-multiples rather than true unbounded recursion, so a
    // fully-AI-vs-AI scenario can't blow the call stack turn-by-turn --
    // capped generously (1000) since a real game is turns=<=100ish and
    // this only loops once per side-turn, not per AI action.
    for (let guard = 0; guard < 1000 && !this.scenarioResult; guard++) {
      const team = this.board.getTeam(this.activeSide);
      if (!team || (team.controller !== 'ai' && team.controller !== 'network_ai')) break;
      this.playAiSide(this.activeSide, aiAnimations);
      if (this.scenarioResult) break;
      const next = this.advanceOneTurn();
      if (!next) break;
      message = next;
    }
    this.lastAiAnimations = aiAnimations.length > 0 ? aiAnimations : null;
    return message;
  }

  /** Runs `playAiTurn` for `side`, logs what it did, and appends every real animation event it produced to `outAnimations` (see `endTurn`'s own doc comment on why these accumulate across possibly several consecutive AI sides). */
  private playAiSide(side: number, outAnimations: AiAnimationEvent[]): void {
    const actions = playAiTurn(this.board, side, this.rng, {
      resolveType: this.resolveType,
      lawfulBonusAt: (loc) => this.timeOfDayAt(loc).lawfulBonus,
      maxLiminalBonus: this.schedule.maxLiminalBonus,
    });
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
   * through -- see `endTurn`'s own doc comment.
   */
  private advanceOneTurn(): string | null {
    if (this.scenarioResult) return null;
    this.clearSelection();
    this.fireSideTurnEndEvents(this.activeSide);
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
      this.fire('turn end');
      this.fire(`turn ${this.turnNumber} end`);
      this.checkForGameEnd();
      if (this.scenarioResult) return null;
      this.turnNumber += 1;
    }
    this.activeSide = nextSide;
    this.fireSideTurnEvents(nextSide);
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
    this.fireTurnRefreshEvents(nextSide);
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
    return {
      startGold: team?.startGold ?? 0,
      incomePerVillage: team?.incomePerVillage ?? 0,
      villagesOwned: this.board.villageCount(this.activeSide),
      netIncome: this.turnNumber > 1 ? this.totalIncomeFor(this.activeSide) - Math.max(0, expense) : 0,
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

    const { attacker: aStats, defender: dStats } = buildBattleContext({
      attacker,
      attackerWeapon,
      defender,
      defenderWeapon,
      distance,
      attackerTerrainDefense,
      defenderTerrainDefense,
      options: {
        attackerLawfulBonus: this.timeOfDayAt(attacker.location).lawfulBonus,
        defenderLawfulBonus: this.timeOfDayAt(defender.location).lawfulBonus,
        maxLiminalBonus: this.schedule.maxLiminalBonus,
        backstabActive: isBackstabActive(this.board, attacker.location, defender.location),
        attackerLeadershipBonus: computeLeadershipBonus(this.board, attacker),
        defenderLeadershipBonus: computeLeadershipBonus(this.board, defender),
        attackerResistanceModifier: computeResistanceModifier(this.board, defender, attackerWeapon.type, false, defender.location),
        defenderResistanceModifier: defenderWeapon
          ? computeResistanceModifier(this.board, attacker, defenderWeapon.type, true, attacker.location)
          : undefined,
      },
    });
    const { attacker: aCombatant, defender: dCombatant } = simulateCombat(aStats, dStats);

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
      },
    };

    return { attacker, defender, attackerWeaponIndex, defenderWeaponIndex, preview };
  }

  private moveSelectedTo(dest: Location): string | null {
    const unit = this.selectedUnit;
    if (!unit) return null;
    const start = unit.location;
    const route = findPath(this.board, unit, dest);
    if (route.steps.length === 0) return null;
    const ownersBefore = route.steps.map((step) => this.board.villageOwner(step));
    const result = executeMove(this.board, unit, route.steps, { raise: this.raiseEvent });
    if (result.path.length > 1) this.lastMoveAnimation = { unit, path: result.path };
    const name = this.unitDisplayName(unit);
    const message = result.ambushed
      ? `${name} was ambushed!`
      : result.sightedStop
        ? `${name} stopped: units sighted.`
        : `${name} moved.`;
    if (result.path.length > 1) {
      // unit_mover::post_move: capture (via get_village), then moveto.
      if (result.enteredVillage && ownersBefore[result.path.length - 1] !== unit.side) {
        this.eventPump.raise('capture', unit.location, start);
      }
      this.eventPump.raise('moveto', unit.location, start);
    }
    this.pumpEvents();
    if (this.scenarioResult || this.board.unitAt(unit.location) !== unit) {
      this.clearSelection();
      this.log.unshift(message);
      return message;
    }
    // Re-select from the unit's new position so move/attack options refresh
    // (mirrors real Wesnoth: a unit stays selected after moving so it can
    // still attack an adjacent enemy this turn).
    this.selectUnit(unit);
    if (this.reachable.length === 0 && this.attackCandidates.length === 0) {
      // Nothing left to do with this unit -- deselect so its highlight doesn't linger.
      this.clearSelection();
    }
    this.log.unshift(message);
    return message;
  }

  /**
   * Handles a click on hex (x,y), applying whatever the current selection
   * state says that means (select / move / target an attack / deselect).
   * Returns a short human-readable message describing what happened (for a
   * toast/log), or `null` if the click had no visible effect.
   */
  handleHexClick(x: number, y: number): string | null {
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
      return this.tryRecruitAt(typeId, loc);
    }

    if (this.pendingRecallIndex !== null) {
      const index = this.pendingRecallIndex;
      this.pendingRecallIndex = null;
      return this.tryRecallAt(index, loc);
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
        return this.moveSelectedTo(loc);
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
  confirmAttack(): string | null {
    if (this.scenarioResult) return null;
    const pending = this.pendingAttack;
    if (!pending) return null;

    const attackerLoc = pending.attacker.location;
    const defenderLoc = pending.defender.location;
    this.fire('attack', attackerLoc, defenderLoc);
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

    const result = executeAttack(
      this.board,
      this.rng,
      attackerLoc,
      pending.attackerWeaponIndex,
      defenderLoc,
      pending.defenderWeaponIndex,
      {
        attackerLawfulBonus: this.timeOfDayAt(attackerLoc).lawfulBonus,
        defenderLawfulBonus: this.timeOfDayAt(defenderLoc).lawfulBonus,
        maxLiminalBonus: this.schedule.maxLiminalBonus,
        resolveType: this.resolveType,
        raise: this.raiseEvent,
        onUnitDying: (dead, killer) => {
          this.eventPump.fire('last breath', dead.location, killer.location);
          this.eventPump.fire('die', dead.location, killer.location);
        },
      },
    );
    this.eventPump.raise('attack end', attackerLoc, defenderLoc);
    this.eventPump.pump();

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
      this.pendingAdvancement = { unit, options: optionIds.map((id) => this.resolveType(id)) };
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

  /** Captures every mutable bit of live state -- see `SaveGameData`'s own doc comment. */
  toSaveData(): SaveGameData {
    return {
      version: 1,
      turnNumber: this.turnNumber,
      activeSide: this.activeSide,
      scenarioResult: this.scenarioResult,
      schedule: this.schedule.exportState(),
      startupEventsRun: this.startupEventsRun,
      teams: this.board.teams().map((t) => ({ side: t.side, gold: t.gold, shroudData: t.shroud.write(), fogData: t.fog.write() })),
      units: this.board.allUnits().map((u) => ({
        id: u.id || null,
        name: u.name || null,
        typeId: u.type.id,
        side: u.side,
        x: u.location.x,
        y: u.location.y,
        canRecruit: u.canRecruit,
        hitpoints: u.hitpoints,
        maxHitpoints: u.maxHitpoints,
        movesLeft: u.movesLeft,
        maxMoves: u.maxMoves,
        attacksLeft: u.attacksLeft,
        maxAttacksPerTurn: u.maxAttacksPerTurn,
      })),
      recall: this.board.teams().flatMap((t) =>
        this.board.recallList(t.side).map((u) => ({
          side: t.side,
          id: u.id || null,
          name: u.name || null,
          typeId: u.type.id,
          hitpoints: u.hitpoints,
          maxHitpoints: u.maxHitpoints,
          level: u.level,
        })),
      ),
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
    for (const unit of [...this.board.allUnits()]) {
      this.board.removeUnitAt(unit.location);
    }
    for (const t of this.board.teams()) {
      this.board.clearRecallList(t.side);
    }
    for (const u of data.units) {
      const type = this.resolveType(u.typeId);
      const unit = Unit.create(type, u.side, new Location(u.x, u.y), {
        id: u.id ?? undefined,
        name: u.name ?? undefined,
        canRecruit: u.canRecruit,
      });
      unit.hitpoints = u.hitpoints;
      unit.maxHitpoints = u.maxHitpoints;
      unit.movesLeft = u.movesLeft;
      unit.maxMoves = u.maxMoves;
      unit.attacksLeft = u.attacksLeft;
      unit.maxAttacksPerTurn = u.maxAttacksPerTurn;
      this.board.addUnit(unit);
    }
    for (const t of data.teams) {
      const team = this.board.getTeam(t.side);
      if (!team) continue;
      team.gold = t.gold;
      if (t.shroudData !== undefined) team.shroud.read(t.shroudData);
      if (t.fogData !== undefined) team.fog.read(t.fogData);
    }
    // Optional-on-read (see `SaveGameData.recall`'s own doc comment): a save
    // written before this field existed simply had no recall-list units.
    for (const r of data.recall ?? []) {
      const type = this.resolveType(r.typeId);
      const unit = Unit.create(type, r.side, Location.NULL, {
        id: r.id ?? undefined,
        name: r.name ?? undefined,
        canRecruit: false,
      });
      unit.hitpoints = r.hitpoints;
      unit.maxHitpoints = r.maxHitpoints;
      unit.level = r.level;
      this.board.addToRecallList(r.side, unit);
    }
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
