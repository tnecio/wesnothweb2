/**
 * Plain (rune-free) TypeScript domain layer wrapping a live `GameBoard` for
 * one browser play session: select a unit, see where it can move/attack,
 * commit a move, preview then commit an attack. Deliberately NOT a
 * `.svelte.ts` runes file -- see this package's Svelte components
 * (`GameShell.svelte` etc.) for the reactive wrapper around it.
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
 * Scope: this deliberately implements only what Phase 5's brief asks for
 * (docs/IMPLEMENTATION_PLAN.md) -- select/move/attack against the current
 * player's own side. Recruit/recall and end-turn/AI-turn are out of scope
 * (see the brief); there is no "end turn" here, so `playerSide`'s units
 * simply keep whatever moves/attacks they have left for the (single,
 * implicit) turn this demo covers.
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
  type GameBoardSnapshot,
  type SnapshotUnit,
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
  readonly playerSide: number;

  selectedUnit: Unit | null = null;
  /** Hexes `selectedUnit` can move to this turn (excludes its own hex). */
  reachable: HexPoint[] = [];
  /** Adjacent enemy units `selectedUnit` could attack (empty if it has no attacks left). */
  attackCandidates: Unit[] = [];
  pendingAttack: PendingAttack | null = null;
  /** Most-recent-first log of human-readable move/attack outcomes. */
  log: string[] = [];

  private readonly imageByTypeId = new Map<string, string | null>();
  private readonly rng: RngDeterministic;

  constructor(snapshot: GameBoardSnapshot, options: GameSessionOptions = {}) {
    this.snapshot = snapshot;
    this.playerSide = options.playerSide ?? 1;
    this.board = gameBoardFromSnapshot(snapshot).board;
    for (const u of snapshot.units) {
      if (!this.imageByTypeId.has(u.typeId)) this.imageByTypeId.set(u.typeId, u.image);
    }
    this.rng = new RngDeterministic(new MtRng(options.seed ?? 0xc0ffee));
  }

  /** The live board's units, in `SnapshotUnit` shape, for re-rendering via `SnapshotBoard.updateUnits`. */
  get renderUnits(): SnapshotUnit[] {
    return this.board.allUnits().map((u) => ({
      id: u.id || null,
      name: u.name || null,
      typeId: u.type.id,
      image: this.imageByTypeId.get(u.type.id) ?? null,
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

  /** Selects `unit` and (re)computes its move/attack options. Clears any pending attack. */
  selectUnit(unit: Unit): void {
    this.pendingAttack = null;
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
  }

  clearSelection(): void {
    this.selectedUnit = null;
    this.reachable = [];
    this.attackCandidates = [];
    this.pendingAttack = null;
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
    const loc = new Location(x, y);
    const clickedUnit = this.board.unitAt(loc);

    if (this.pendingAttack) {
      // Any board click while an attack is pending confirmation cancels it
      // rather than doing something else with the click; Confirm/Cancel
      // buttons in the side panel are the only way to resolve it.
      this.pendingAttack = null;
      return null;
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
        if (clickedUnit.side === this.playerSide) {
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

    if (clickedUnit && clickedUnit.side === this.playerSide) {
      this.selectUnit(clickedUnit);
    }
    return null;
  }

  /** Commits the currently-pending attack via the real `executeAttack`, updating the board. */
  confirmAttack(): string | null {
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
    // A unit that has fought is done for this demo's (single, implicit)
    // turn -- see module doc comment on why there is no move-after-attack
    // or end-turn flow here.
    this.clearSelection();
    return message;
  }

  cancelAttack(): void {
    this.pendingAttack = null;
  }
}
