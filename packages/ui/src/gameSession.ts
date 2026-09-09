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
  checkVictory,
  type GameBoardSnapshot,
  type SnapshotUnit,
  type RecordedMessage,
  type UnitType,
} from '@wesnothweb2/engine';

export interface HexPoint {
  x: number;
  y: number;
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
  hp: number;
  maxHp: number;
  movesLeft: number;
  maxMoves: number;
  attacksLeft: number;
}

/** An attack the player has targeted but not yet committed -- shown in the side panel with Confirm/Cancel. */
export interface PendingAttack {
  attacker: Unit;
  defender: Unit;
  attackerWeaponIndex: number;
  defenderWeaponIndex: number;
  preview: CombatPreview;
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

export interface GameSessionOptions {
  /** Which side the human player controls. Default 1 (Dead_Water scenario 1's Kai Krellis side). */
  playerSide?: number;
  /** Seed for the session's `RngDeterministic` -- see `RngDeterministic`'s own doc comment; no need for cryptographic randomness here. */
  seed?: number;
}

/**
 * Owns one live `GameBoard` (reconstructed from a `GameBoardSnapshot`) plus
 * the UI-facing selection/targeting state a board view and side panel need.
 * All mutation goes through real `packages/engine` actions
 * (`executeMove`/`executeAttack`) -- this class never hand-rolls movement or
 * combat math itself.
 */
export class GameSession {
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
  /** Unit type id the player has picked from the recruit list, awaiting a click on one of `recruitTiles`. */
  pendingRecruitTypeId: string | null = null;
  /** Most-recent-first log of human-readable move/attack/recruit/turn outcomes. */
  log: string[] = [];
  /**
   * Set once the scenario has ended (`checkVictory`, run after every
   * combat) -- `'victory'` if `playerSide` is among the survivors,
   * `'defeat'` otherwise. `null` while play continues. Every mutating
   * method below early-returns once this is set; the scenario is over.
   */
  scenarioResult: 'victory' | 'defeat' | null = null;

  /** Resolves any of the ~332 real unit types the snapshot ships (board units, event-spawned units, recruit lists) -- see `createTypeResolver`. */
  private readonly resolveType: (id: string) => UnitType;
  private readonly rng: RngDeterministic;
  private startupEventsRun = false;

  constructor(snapshot: GameBoardSnapshot, options: GameSessionOptions = {}) {
    this.snapshot = snapshot;
    this.playerSide = options.playerSide ?? 1;
    this.activeSide = this.playerSide;
    this.board = gameBoardFromSnapshot(snapshot).board;
    this.resolveType = createTypeResolver(snapshot);
    this.rng = new RngDeterministic(new MtRng(options.seed ?? 0xc0ffee));
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

  /** Arms (or, called again with the same id, disarms) a pending recruit -- the next click on one of `recruitTiles` places it. */
  selectRecruitType(typeId: string | null): void {
    this.pendingRecruitTypeId = this.pendingRecruitTypeId === typeId ? null : typeId;
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
    const teamName = this.board.getTeam(nextSide)?.teamName ?? String(nextSide);
    const message = `Turn ${this.turnNumber} -- side ${nextSide} (${teamName})'s turn.`;
    this.log.unshift(message);
    return message;
  }

  private buildPreview(attacker: Unit, defender: Unit): PendingAttack {
    const attackerWeaponIndex = 0;
    const attackerWeapon = attacker.attacks[attackerWeaponIndex];
    if (!attackerWeapon) {
      throw new Error('buildPreview: attacker has no weapon at index 0');
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

    const sel = this.selectedUnit;
    if (sel) {
      if (clickedUnit) {
        if (clickedUnit === sel) {
          this.clearSelection();
          return null;
        }
        if (this.attackCandidates.includes(clickedUnit)) {
          this.pendingAttack = this.buildPreview(sel, clickedUnit);
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
    );

    const attackerName = pending.preview.attacker.name;
    const defenderName = pending.preview.defender.name;
    const hits = result.blows.filter((b) => b.hit).length;
    let message = `${attackerName} attacked ${defenderName}: ${hits}/${result.blows.length} blows landed.`;
    if (result.defenderDied) message += ` ${defenderName} was slain!`;
    if (result.attackerDied) message += ` ${attackerName} was slain!`;

    this.log.unshift(message);
    // A unit that has fought is done acting for this turn (real Wesnoth:
    // attacking always consumes the unit's remaining attacks/moves) --
    // deselect so its highlight doesn't linger; `endTurn` will refresh it
    // for its side's next turn.
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
