import { describe, expect, it } from 'vitest';
import { Location, Direction } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { UndoStack } from '../../src/actions/undo.js';

function makeBoard() {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
  const map = GameMap.fromMapString('Gg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100 }));
  const type = new UnitType('grunt', 'grunt', '', 'neutral', 1, 30, 5, 5, 0, 1, 15, -1, 32, [], '', false, false, false, moveType, [AttackType.fromConfig(new WmlConfig())], []);
  return { board, type, team: board.getTeam(1)! };
}

describe('UndoStack', () => {
  it('inverts a move: restores location, moves-left, and facing', () => {
    const { board, type } = makeBoard();
    const from = Location.fromWml(1, 1);
    const to = Location.fromWml(2, 1);
    const unit = Unit.create(type, 1, from);
    unit.movesLeft = 3;
    unit.facing = Direction.North;
    board.addUnit(unit);

    const stack = new UndoStack();
    // Simulate the caller's side of a move: mutate, then push the inverse record.
    board.moveUnit(from, to);
    unit.movesLeft = 1;
    unit.facing = Direction.South;
    stack.push({ kind: 'move', unit, from, to, startingMoves: 3, startingFacing: Direction.North });

    expect(stack.canUndo()).toBe(true);
    const undone = stack.undo(board);
    expect(undone).toBe(true);
    expect(board.unitAt(from)).toBe(unit);
    expect(board.unitAt(to)).toBeUndefined();
    expect(unit.movesLeft).toBe(3);
    expect(unit.facing).toBe(Direction.North);
    expect(stack.canUndo()).toBe(false);
  });

  it('inverts a recruit: removes the unit and refunds gold', () => {
    const { board, type, team } = makeBoard();
    const loc = Location.fromWml(1, 1);
    const unit = Unit.create(type, 1, loc);
    board.addUnit(unit);
    team.spendGold(15);

    const stack = new UndoStack();
    stack.push({ kind: 'recruit', unit, side: 1, at: loc, cost: 15 });

    expect(stack.undo(board)).toBe(true);
    expect(board.unitAt(loc)).toBeUndefined();
    expect(team.gold).toBe(100); // refunded
  });

  it('returns false and changes nothing when the stack is empty', () => {
    const { board } = makeBoard();
    const stack = new UndoStack();
    expect(stack.undo(board)).toBe(false);
  });

  it('blockFurtherUndo clears the stack and prevents any further undo (mirrors combat consuming randomness)', () => {
    const { board, type } = makeBoard();
    const from = Location.fromWml(1, 1);
    const to = Location.fromWml(2, 1);
    const unit = Unit.create(type, 1, from);
    board.addUnit(unit);

    const stack = new UndoStack();
    board.moveUnit(from, to);
    stack.push({ kind: 'move', unit, from, to, startingMoves: unit.movesLeft, startingFacing: unit.facing });
    expect(stack.canUndo()).toBe(true);

    stack.blockFurtherUndo();
    expect(stack.canUndo()).toBe(false);
    expect(stack.undo(board)).toBe(false);
    // The move from before the block must NOT be reverted.
    expect(board.unitAt(to)).toBe(unit);
  });
});
