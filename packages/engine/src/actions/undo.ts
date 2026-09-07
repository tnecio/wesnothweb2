/**
 * Undo stack for the actions in this directory. Loosely mirrors upstream's
 * `actions/undo.cpp`/`undo_action.hpp` family (`undo_action_container` plus
 * one `undo_action` subclass per action type: `move_action`,
 * `recruit_action`, `recall_action`, `dismiss_action`), but takes a
 * deliberately simpler shape rather than replicating the C++ inheritance
 * hierarchy 1:1 -- see "Design choice" below.
 *
 * ## Design choice
 *
 * Upstream's `undo_action` is a polymorphic base class (`virtual bool
 * undo(int side)`, `virtual void write(config&)`) with one subclass per
 * action, each subclass a `.hpp`/`.cpp` pair, plus a `t_factory_map`
 * self-registration mechanism (`subaction_factory<T>`) so `undo_action_
 * container::read` can reconstruct the right subclass from a saved
 * `config`. That machinery exists because C++ needs virtual dispatch and
 * upstream also uses these same objects for save-game serialization
 * (`write`/the `config`-based constructor) and multiplayer's shroud-
 * clearing bookkeeping (`shroud_clearing_action`, not ported here -- see
 * `move.ts`/`recruit.ts`'s module doc comments on fog/shroud being out of
 * scope throughout this port).
 *
 * None of that is needed here: a plain discriminated union
 * (`UndoAction`) plus a `switch` in `UndoStack.undo()` gives the same
 * "each action type knows how to invert itself" property with far less
 * ceremony, is trivially serializable as plain data (JSON-friendly, no
 * factory registration needed) if a future save-game format wants it, and
 * needs no forward-declared base class for a family of exactly four
 * variants. If this grows a fifth/sixth undo-able action type later,
 * adding a union member is strictly additive.
 *
 * **Attacks are not undoable** (there is no `undo_attack_action` upstream
 * either, for the same reason: combat consumes real randomness, so
 * "undoing" it would mean un-observing an RNG draw, which upstream instead
 * handles by clearing the whole undo stack the moment an action that
 * consumes randomness or otherwise can't be cleanly inverted occurs --
 * mirrored here by `UndoStack.blockFurtherUndo()`, which callers should
 * invoke after `combat.ts`'s `executeAttack`, matching `synced_context::
 * block_undo`'s real-world effect of preventing undo past that point).
 */

import type { Location, Direction } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';

export interface MoveUndoAction {
  readonly kind: 'move';
  readonly unit: Unit;
  readonly from: Location;
  readonly to: Location;
  readonly startingMoves: number;
  readonly startingFacing: Direction;
}

export interface RecruitUndoAction {
  readonly kind: 'recruit';
  readonly unit: Unit;
  readonly side: number;
  readonly at: Location;
  readonly cost: number;
}

export interface RecallUndoAction {
  readonly kind: 'recall';
  readonly unit: Unit;
  readonly side: number;
  readonly at: Location;
  readonly cost: number;
}

export interface DismissUndoAction {
  readonly kind: 'dismiss';
  readonly unit: Unit;
  readonly side: number;
}

export type UndoAction = MoveUndoAction | RecruitUndoAction | RecallUndoAction | DismissUndoAction;

/**
 * A per-side undo stack. Callers are responsible for pushing an
 * `UndoAction` after each undoable action they perform (`move.ts`/
 * `recruit.ts` return everything an undo record needs, but don't push one
 * themselves -- constructing the record is the caller's job, matching how
 * upstream's own call sites, not `move_unit`/`place_recruit` themselves,
 * call `resources::undo_stack->add_move`/`add_recruit`/`add_recall`).
 */
export class UndoStack {
  private readonly stack: UndoAction[] = [];
  private blocked = false;

  push(action: UndoAction): void {
    this.stack.push(action);
  }

  canUndo(): boolean {
    return !this.blocked && this.stack.length > 0;
  }

  peek(): UndoAction | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Mirrors `synced_context::block_undo`'s effect: call after any non-undoable action (chiefly `combat.ts`'s `executeAttack`). */
  blockFurtherUndo(): void {
    this.blocked = true;
    this.stack.length = 0;
  }

  clear(): void {
    this.blocked = false;
    this.stack.length = 0;
  }

  /**
   * Pops and inverts the most recent action against `board`, mirroring
   * `undo_action_container::undo`. Returns `false` (leaving the stack
   * unchanged) if there is nothing to undo.
   */
  undo(board: GameBoard): boolean {
    if (!this.canUndo()) return false;
    const action = this.stack.pop()!;
    switch (action.kind) {
      case 'move': {
        board.moveUnit(action.to, action.from);
        action.unit.movesLeft = action.startingMoves;
        action.unit.facing = action.startingFacing;
        return true;
      }
      case 'recruit': {
        board.removeUnitAt(action.at);
        const team = board.getTeam(action.side);
        if (team) team.gold += action.cost;
        return true;
      }
      case 'recall': {
        board.removeUnitAt(action.at);
        const team = board.getTeam(action.side);
        if (team) team.gold += action.cost;
        board.addToRecallList(action.side, action.unit);
        return true;
      }
      case 'dismiss': {
        // `GameBoard` only exposes appending to a recall list, not inserting
        // at an index, so undo restores the unit but not necessarily its
        // original position in the list (a minor, honestly-documented gap
        // rather than a `model/`-layer change this task is out of bounds to make).
        board.addToRecallList(action.side, action.unit);
        return true;
      }
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }
}
