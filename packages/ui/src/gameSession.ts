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
  type AttackBlowResult,
  buildBattleContext,
  chooseDefenderWeaponIndex,
  simulateCombat,
  RngDeterministic,
  MtRng,
  gameBoardFromSnapshot,
  createTypeResolver,
  runScenarioStartupEvents,
  connectedCastleTiles,
  recruitUnit,
  recallUnit,
  checkVictory,
  applySideHealing,
  computeGoldCarryover,
  findVictoryEndlevelGoldConfig,
  computeCarryoverRecruits,
  scheduleFromScenarioConfigJson,
  type Schedule,
  type TimeOfDayEntry,
  type GameBoardSnapshot,
  type SnapshotUnit,
  type RecordedMessage,
  type UnitType,
  type GoldCarryoverResult,
  type WmlAttributeValue,
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
}

export interface CombatPreview {
  attacker: CombatantPreview;
  defender: CombatantPreview;
}

/** A view-model of the selected unit, for the side panel -- deliberately plain data, not a live `Unit` reference. */
export interface SelectedUnitInfo {
  name: string;
  typeId: string;
  side: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  movesLeft: number;
  maxMoves: number;
  attacksLeft: number;
  /** Real `[terrain_type] name=` at the unit's own hex (e.g. "Castle", "Village"). */
  terrainName: string;
  /** Real terrain defense on the unit's own hex, as the player-facing percentage (`100 - defenseModifier`, since `defenseModifier` is upstream's "chance to be hit" convention -- lower is better). */
  defensePercent: number;
}

/** An attack the player has targeted but not yet committed -- shown in the side panel with Confirm/Cancel. */
export interface PendingAttack {
  attacker: Unit;
  defender: Unit;
  attackerWeaponIndex: number;
  defenderWeaponIndex: number;
  preview: CombatPreview;
}

/** One of the attacker's usable weapons against the current target -- see `GameSession.attackerWeaponOptions`. */
export interface AttackerWeaponOption {
  index: number;
  name: string;
  damage: number;
  numAttacks: number;
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
  teams: readonly { side: number; gold: number }[];
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
  /** Hexes `selectedUnit` can move to this turn (excludes its own hex). */
  reachable: HexPoint[] = [];
  /** Adjacent enemy units `selectedUnit` could attack (empty if it has no attacks left). */
  attackCandidates: Unit[] = [];
  /** Vacant castle tiles `selectedUnit` (a leader on its keep) could recruit onto -- empty otherwise. */
  recruitTiles: HexPoint[] = [];
  pendingAttack: PendingAttack | null = null;

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
      return {
        index,
        name: weapon.name,
        damage: weapon.damage,
        numAttacks: weapon.numAttacks,
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
  private startupEventsRun = false;
  /** The real `[time]` schedule this scenario's own (already macro-expanded) `scenarioConfigJson` declares -- see `Schedule`'s own doc comment. Built once at construction since the schedule itself never changes mid-scenario (no `[replace_schedule]` support yet). */
  private readonly schedule: Schedule;

  constructor(snapshot: GameBoardSnapshot, options: GameSessionOptions = {}) {
    this.snapshot = snapshot;
    this.playerSide = options.playerSide ?? 1;
    this.activeSide = this.playerSide;
    this.board = gameBoardFromSnapshot(snapshot).board;
    this.resolveType = createTypeResolver(snapshot);
    this.rng = new RngDeterministic(new MtRng(options.seed ?? 0xc0ffee));
    this.goldCarryover = options.goldCarryover ?? null;
    this.schedule = scheduleFromScenarioConfigJson(snapshot.scenarioConfigJson);
  }

  /**
   * The real `[time]` entry active on the current game turn (`turnNumber`)
   * -- mirrors `tod_manager::get_time_of_day()`. Advances by real turn
   * number, not side turn (matches upstream: the whole schedule steps once
   * per game turn, not once per side). See `Schedule`'s own doc comment
   * for what's deliberately simplified (no `[time_area]`/
   * `[replace_schedule]`/`random_start_time=`).
   */
  get currentTimeOfDay(): TimeOfDayEntry {
    return this.schedule.timeOfDayForTurn(this.turnNumber);
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
    const { messages } = runScenarioStartupEvents(this.board, this.snapshot.scenarioConfigJson, ['prestart', 'start'], {
      resolveType: this.resolveType,
    });
    return messages;
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
    return this.board.allUnits().map((u) => ({
      id: u.id || null,
      name: u.name || null,
      typeId: u.type.id,
      image: this.snapshot.unitTypes[u.type.id]?.image ?? null,
      side: u.side,
      x: u.location.x,
      y: u.location.y,
      canRecruit: u.canRecruit,
      hitpoints: u.hitpoints,
      maxHitpoints: u.maxHitpoints,
    }));
  }

  unitDisplayName(u: Unit): string {
    return u.name || u.type.name || u.type.id;
  }

  private computeAttackCandidates(unit: Unit): Unit[] {
    if (unit.attacksLeft <= 0) return [];
    const team = this.board.getTeam(unit.side);
    if (!team) return [];
    const targets: Unit[] = [];
    for (const adj of getAdjacentTiles(unit.location)) {
      const other = this.board.unitAt(adj);
      if (!other) continue;
      const otherTeam = this.board.getTeam(other.side);
      if (otherTeam && team.isEnemy(otherTeam)) targets.push(other);
    }
    return targets;
  }

  /** Selects `unit` and (re)computes its move/attack/recruit options. Clears any pending attack/recruit. */
  selectUnit(unit: Unit): void {
    this.pendingAttack = null;
    this.pendingRecruitTypeId = null;
    this.pendingRecallIndex = null;
    this.selectedUnit = unit;
    if (unit.movesLeft > 0) {
      const { destinations } = reachableHexes(this.board, unit, { seeAll: true });
      const ownLoc = unit.location;
      this.reachable = destinations
        .values()
        .map((step) => ({ x: step.curr.x, y: step.curr.y }))
        .filter((h) => !(h.x === ownLoc.x && h.y === ownLoc.y));
    } else {
      this.reachable = [];
    }
    this.attackCandidates = this.computeAttackCandidates(unit);
    this.recruitTiles = this.computeRecruitTiles(unit);
  }

  clearSelection(): void {
    this.selectedUnit = null;
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
    const result = recruitUnit(this.board, team, type, loc, leader.location);
    const message = `Recruited ${name} for ${result.cost} gold.`;
    this.log.unshift(message);
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
    const result = recallUnit(this.board, team, unit, loc, leader.location);
    const message = `Recalled ${name} for ${result.cost} gold.`;
    this.log.unshift(message);
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
   * ## Hotseat, not single-side-forever (judgment call)
   *
   * There is no AI in this project yet (Phase 7). The two readings of
   * "end turn" without one are: (a) only `playerSide` is ever actually
   * playable, and every other side's turn is skipped/no-op'd, or (b) any
   * side can be controlled once it's their turn (hotseat). This picks (b):
   * the user's explicit goal was "test scenario progression and combat",
   * which needs the OTHER side (Mal-Kevek's undead) to actually do
   * something across turns -- with no AI, hotseat is the only way that
   * happens at all. `activeSide` (not `playerSide`) now gates who can be
   * selected/moved/attacked/recruited with in `handleHexClick`.
   */
  endTurn(): string {
    if (this.scenarioResult) return '';
    this.clearSelection();
    const sides = this.board
      .teams()
      .map((t) => t.side)
      .sort((a, b) => a - b);
    const idx = sides.indexOf(this.activeSide);
    const wrapped = idx === -1 || idx === sides.length - 1;
    const nextSide = wrapped ? sides[0] : sides[idx + 1];
    if (nextSide === undefined) return '';
    if (wrapped) this.turnNumber += 1;
    this.activeSide = nextSide;
    for (const unit of this.board.unitsForSide(nextSide)) {
      unit.movesLeft = unit.maxMoves;
      unit.attacksLeft = unit.maxAttacksPerTurn;
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

  /** Every real village currently owned by a side, for the board's live ownership-flag markers -- unowned villages are omitted (nothing to mark; the terrain colour alone already shows "this is a village," see `SnapshotBoard`'s own doc comment). */
  get villageOwnership(): VillageOwnerInfo[] {
    const result: VillageOwnerInfo[] = [];
    for (const loc of this.board.map.villages) {
      const side = this.board.villageOwner(loc);
      if (side !== undefined) result.push({ x: loc.x, y: loc.y, side });
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
        lawfulBonus: this.currentTimeOfDay.lawfulBonus,
        maxLiminalBonus: this.schedule.maxLiminalBonus,
        backstabActive: isBackstabActive(this.board, attacker.location, defender.location),
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
      },
    };

    return { attacker, defender, attackerWeaponIndex, defenderWeaponIndex, preview };
  }

  private moveSelectedTo(dest: Location): string | null {
    const unit = this.selectedUnit;
    if (!unit) return null;
    const route = findPath(this.board, unit, dest, { seeAll: true });
    if (route.steps.length === 0) return null;
    const result = executeMove(this.board, unit, route.steps, { seeAll: true });
    const name = this.unitDisplayName(unit);
    let message = result.ambushed ? `${name} was ambushed!` : `${name} moved.`;
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
    const clickedUnit = this.board.unitAt(loc);

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
        return null;
      }

      if (this.reachable.some((h) => h.x === x && h.y === y)) {
        return this.moveSelectedTo(loc);
      }

      this.clearSelection();
      return null;
    }

    if (clickedUnit && clickedUnit.side === this.activeSide) {
      this.selectUnit(clickedUnit);
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

    const result = executeAttack(
      this.board,
      this.rng,
      pending.attacker.location,
      pending.attackerWeaponIndex,
      pending.defender.location,
      pending.defenderWeaponIndex,
      { lawfulBonus: this.currentTimeOfDay.lawfulBonus, maxLiminalBonus: this.schedule.maxLiminalBonus },
    );

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
    if (result.defenderDied || result.attackerDied) this.checkForGameEnd();
    return this.scenarioResult ? this.log[0]! : message;
  }

  cancelAttack(): void {
    this.pendingAttack = null;
  }

  /** Captures every mutable bit of live state -- see `SaveGameData`'s own doc comment. */
  toSaveData(): SaveGameData {
    return {
      version: 1,
      turnNumber: this.turnNumber,
      activeSide: this.activeSide,
      scenarioResult: this.scenarioResult,
      startupEventsRun: this.startupEventsRun,
      teams: this.board.teams().map((t) => ({ side: t.side, gold: t.gold })),
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
      if (team) team.gold = t.gold;
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
    this.clearSelection();
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
    const { continueLevel, notDefeated } = checkVictory(this.board);
    if (continueLevel) return;
    this.scenarioResult = notDefeated.includes(this.playerSide) ? 'victory' : 'defeat';
    this.clearSelection();
    this.log.unshift(
      this.scenarioResult === 'victory' ? 'Victory! The enemy has been defeated.' : 'Defeat... your side has fallen.',
    );
  }
}
