/**
 * Undo and redo (Phase 18b), after upstream's `actions/undo.cpp` family:
 * each undoable action is an `UndoContainer` of *steps* recorded while it
 * ran (`undo_action_container`) -- the move itself, the village it took
 * (`take_village_step`), the recruit or recall, a dismissal, and any
 * `[on_undo]` WML an event attached (`undo_event`). Undoing runs the steps
 * backwards. Redo does not invert anything: it re-runs the command the
 * undone action was recorded as, with its recorded dependents (seeds,
 * choices), through the normal command executor (`undo_list::redo` ->
 * `synced_context::run`) -- which is why the redo stack holds
 * `RecordedCommand`s rather than steps.
 *
 * What makes an action *not* undoable is decided by the executor, as
 * upstream's `synced_context::block_undo` calls are: an attack, any random
 * draw, a fog or shroud reveal, an ambush or a failed teleport, any event
 * that ran without `[allow_undo]`, a turn change. A non-undoable action
 * clears the whole stack (`undo_list::finish_action(false)` -> `clear()`),
 * and every new action clears the redo stack (`init_action`).
 *
 * Not ported: delayed shroud updates (`auto_shroud_updates=no`,
 * `shroud_clearing_action`, `commit_vision`) -- this port always updates
 * fog and shroud as a unit moves, so the moves that reveal something are
 * simply not undoable, which is the same rule upstream applies with
 * automatic updates on.
 */

import type { Location, Direction } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';
import type { WmlConfig } from '../wml/config.js';
import type { RecordedCommand } from './synced.js';

/** `undo::move_action`: the route actually walked, and the unit's state before it. */
export interface MoveUndoStep {
  readonly kind: 'move';
  readonly unit: Unit;
  /** The hexes entered, starting hex first. */
  readonly route: readonly Location[];
  readonly startingMoves: number;
  readonly startingFacing: Direction;
}

/** `take_village_step`: the village's owner before the move took it (0 = nobody). */
export interface TakeVillageUndoStep {
  readonly kind: 'take_village';
  readonly loc: Location;
  readonly previousOwner: number;
}

/** `undo::recruit_action`: removes the recruit and refunds its cost. */
export interface RecruitUndoStep {
  readonly kind: 'recruit';
  readonly unit: Unit;
  readonly side: number;
  readonly loc: Location;
  readonly cost: number;
}

/** `undo::recall_action`: returns the unit to the recall-list slot it came from and refunds the cost. */
export interface RecallUndoStep {
  readonly kind: 'recall';
  readonly unit: Unit;
  readonly side: number;
  readonly loc: Location;
  readonly cost: number;
  readonly index: number;
}

/** `undo::dismiss_action`: puts a dismissed unit back on the recall list. */
export interface DismissUndoStep {
  readonly kind: 'dismiss';
  readonly unit: Unit;
  readonly side: number;
  readonly index: number;
}

/** `undo_event`: `[on_undo]` WML, run with the firing event's locations as `$x1,$y1`/`$x2,$y2`. */
export interface EventUndoStep {
  readonly kind: 'event';
  readonly commands: WmlConfig;
  readonly loc1: Location;
  readonly loc2: Location;
}

export type UndoStep = MoveUndoStep | TakeVillageUndoStep | RecruitUndoStep | RecallUndoStep | DismissUndoStep | EventUndoStep;

/** One undoable action: its steps, and the command it was recorded as (for redo). */
export interface UndoContainer {
  readonly steps: UndoStep[];
  readonly command: RecordedCommand;
}

/** Runs an `[on_undo]` body; supplied by whoever owns the event pump. */
export type UndoEventRunner = (step: EventUndoStep) => void;

/**
 * Inverts one step against `board`. Returns false when the board no longer
 * matches what the step expects (upstream: "Illegal 'undo' found. Possible
 * abuse of [allow_undo]?"), in which case the undo is abandoned.
 */
function undoStep(board: GameBoard, step: UndoStep, runEvent: UndoEventRunner): boolean {
  switch (step.kind) {
    case 'move': {
      const start = step.route[0];
      const end = step.route[step.route.length - 1];
      if (!start || !end) return false;
      if (board.unitAt(end) !== step.unit || (board.hasUnitAt(start) && !start.equals(end))) return false;
      board.moveUnit(end, start);
      step.unit.movesLeft = step.startingMoves;
      step.unit.facing = step.startingFacing;
      step.unit.goto = undefined;
      return true;
    }
    case 'take_village':
      board.captureVillage(step.loc, step.previousOwner);
      return true;
    case 'recruit': {
      if (board.unitAt(step.loc) !== step.unit) return false;
      board.removeUnitAt(step.loc);
      board.getTeam(step.side)?.spendGold(-step.cost);
      return true;
    }
    case 'recall': {
      if (board.unitAt(step.loc) !== step.unit) return false;
      board.removeUnitAt(step.loc);
      board.getTeam(step.side)?.spendGold(-step.cost);
      board.insertIntoRecallList(step.side, step.unit, step.index);
      return true;
    }
    case 'dismiss':
      board.insertIntoRecallList(step.side, step.unit, step.index);
      return true;
    case 'event':
      runEvent(step);
      return true;
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}

/** `actions::undo_list`: the undo and redo stacks of the side whose turn it is. */
export class UndoList {
  private readonly undos: UndoContainer[] = [];
  private readonly redos: RecordedCommand[] = [];
  /** `committed_actions_`: the side did something this turn that can no longer be undone. */
  private committedActions = false;

  /** `undo_list::player_acted`: the side has done something this turn (undoable or not). */
  get playerActed(): boolean {
    return this.committedActions || this.undos.length > 0;
  }

  get committed(): boolean {
    return this.committedActions;
  }

  /** `new_side_turn`: a side's turn starts with nothing done yet. */
  newSideTurn(): void {
    this.undos.length = 0;
    this.redos.length = 0;
    this.committedActions = false;
  }

  get canUndo(): boolean {
    return this.undos.length > 0;
  }

  get canRedo(): boolean {
    return this.redos.length > 0;
  }

  get undoEntries(): readonly UndoContainer[] {
    return this.undos;
  }

  get redoEntries(): readonly RecordedCommand[] {
    return this.redos;
  }

  /** `finish_action(true)`: an undoable action completed. Steps-less actions (a menu item that did nothing) are dropped, as `cleanup_action`. */
  push(container: UndoContainer): void {
    if (container.steps.length === 0) return;
    this.undos.push(container);
  }

  /** `init_action`: a new action invalidates what could be redone. */
  clearRedo(): void {
    this.redos.length = 0;
  }

  /**
   * `undo_list::clear`: after an action that cannot be undone, nothing before it can be either. `commit`
   * records that the side acted (upstream: "the fact that this function was called indicates that something
   * was done"); the engine's own turn bookkeeping (`[init_side]`, end of turn) passes false.
   */
  clear(commit = true): void {
    if (commit) this.committedActions = true;
    this.undos.length = 0;
    this.redos.length = 0;
  }

  /**
   * Undoes the newest action (`undo_list::undo`), returning it -- the caller
   * cuts its command from the log. `null` when there is nothing to undo or
   * the board no longer allows it.
   */
  undo(board: GameBoard, runEvent: UndoEventRunner): UndoContainer | null {
    const container = this.undos[this.undos.length - 1];
    if (!container) return null;
    for (let i = container.steps.length - 1; i >= 0; i--) {
      if (!undoStep(board, container.steps[i]!, runEvent)) return null;
    }
    this.undos.pop();
    this.redos.push(container.command);
    return container;
  }

  /** Takes the newest undone command off the redo stack for the caller to re-run (`undo_list::redo`). */
  takeRedo(): RecordedCommand | null {
    return this.redos.pop() ?? null;
  }

  /** Re-populates both stacks (a loaded save's `[undo_stack]`). */
  restore(undos: readonly UndoContainer[], redos: readonly RecordedCommand[], committed = false): void {
    this.committedActions = committed;
    this.undos.splice(0, this.undos.length, ...undos);
    this.redos.splice(0, this.redos.length, ...redos);
  }
}
