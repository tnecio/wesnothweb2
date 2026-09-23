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
import { UndoList, type UndoStep } from '../../src/actions/undo.js';
import type { RecordedCommand } from '../../src/actions/synced.js';

function makeBoard() {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
  const map = GameMap.fromMapString('Gg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100 }));
  const type = new UnitType('grunt', 'grunt', '', 'neutral', 1, 30, 5, 5, 0, 1, 15, -1, 32, [], '', false, false, false, moveType, [AttackType.fromConfig(new WmlConfig())], []);
  return { board, type, team: board.getTeam(1)! };
}

const noEvents = () => {
  throw new Error('no [on_undo] expected');
};

function container(steps: UndoStep[], side = 1): { steps: UndoStep[]; command: RecordedCommand } {
  return { steps, command: { command: { kind: 'disband', id: 'x' }, side, dependents: [] } };
}

describe('UndoList', () => {
  it('inverts a move: restores location, moves-left, facing, and the village it took', () => {
    const { board, type } = makeBoard();
    const from = Location.fromWml(1, 1);
    const to = Location.fromWml(2, 1);
    const unit = Unit.create(type, 1, from);
    unit.movesLeft = 3;
    unit.facing = Direction.North;
    board.addUnit(unit);

    const list = new UndoList();
    board.moveUnit(from, to);
    unit.movesLeft = 1;
    unit.facing = Direction.South;
    list.push(container([{ kind: 'move', unit, route: [from, to], startingMoves: 3, startingFacing: Direction.North }]));

    expect(list.canUndo).toBe(true);
    const undone = list.undo(board, noEvents);
    expect(undone).not.toBeNull();
    expect(board.unitAt(from)).toBe(unit);
    expect(board.unitAt(to)).toBeUndefined();
    expect(unit.movesLeft).toBe(3);
    expect(unit.facing).toBe(Direction.North);
    expect(list.canUndo).toBe(false);
    expect(list.canRedo).toBe(true);
    expect(list.takeRedo()).toBe(undone!.command);
  });

  it('inverts a recruit: removes the unit and refunds gold', () => {
    const { board, type, team } = makeBoard();
    const loc = Location.fromWml(1, 1);
    const unit = Unit.create(type, 1, loc);
    board.addUnit(unit);
    team.spendGold(15);

    const list = new UndoList();
    list.push(container([{ kind: 'recruit', unit, side: 1, loc, cost: 15 }]));

    expect(list.undo(board, noEvents)).not.toBeNull();
    expect(board.unitAt(loc)).toBeUndefined();
    expect(team.gold).toBe(100);
  });

  it('inverts a recall and a dismissal back into their original recall-list slots', () => {
    const { board, type, team } = makeBoard();
    const a = Unit.create(type, 1, Location.NULL, { id: 'a' });
    const b = Unit.create(type, 1, Location.NULL, { id: 'b' });
    const c = Unit.create(type, 1, Location.NULL, { id: 'c' });
    board.addToRecallList(1, a);
    board.addToRecallList(1, c);
    const loc = Location.fromWml(3, 3);
    b.location = loc;
    board.addUnit(b);
    team.spendGold(20);

    const list = new UndoList();
    list.push(container([{ kind: 'recall', unit: b, side: 1, loc, cost: 20, index: 1 }]));
    expect(list.undo(board, noEvents)).not.toBeNull();
    expect(board.recallList(1).map((u) => u.id)).toEqual(['a', 'b', 'c']);
    expect(team.gold).toBe(100);

    board.removeFromRecallListAt(1, 0);
    list.push(container([{ kind: 'dismiss', unit: a, side: 1, index: 0 }]));
    expect(list.undo(board, noEvents)).not.toBeNull();
    expect(board.recallList(1).map((u) => u.id)).toEqual(['a', 'b', 'c']);
  });

  it('runs [on_undo] steps last-to-first with the rest of the action', () => {
    const { board } = makeBoard();
    const seen: string[] = [];
    const list = new UndoList();
    const cfg = (n: string) => {
      const c = new WmlConfig();
      c.setAttribute('n', n);
      return c;
    };
    list.push(
      container([
        { kind: 'event', commands: cfg('first'), loc1: Location.NULL, loc2: Location.NULL },
        { kind: 'event', commands: cfg('second'), loc1: Location.NULL, loc2: Location.NULL },
      ]),
    );
    list.undo(board, (step) => seen.push(step.commands.getString('n')));
    expect(seen).toEqual(['second', 'first']);
  });

  it('refuses an undo the board no longer matches, leaving the stack alone', () => {
    const { board, type } = makeBoard();
    const from = Location.fromWml(1, 1);
    const to = Location.fromWml(2, 1);
    const unit = Unit.create(type, 1, to);
    board.addUnit(unit);
    board.addUnit(Unit.create(type, 1, from));
    const list = new UndoList();
    list.push(container([{ kind: 'move', unit, route: [from, to], startingMoves: 5, startingFacing: Direction.North }]));
    expect(list.undo(board, noEvents)).toBeNull();
    expect(list.canUndo).toBe(true);
  });

  it('drops step-less actions, and clear() empties both stacks', () => {
    const { board, type } = makeBoard();
    const list = new UndoList();
    list.push(container([]));
    expect(list.canUndo).toBe(false);

    const loc = Location.fromWml(1, 1);
    const unit = Unit.create(type, 1, loc);
    board.addUnit(unit);
    list.push(container([{ kind: 'recruit', unit, side: 1, loc, cost: 0 }]));
    list.undo(board, noEvents);
    list.push(container([{ kind: 'recruit', unit, side: 1, loc, cost: 0 }]));
    expect(list.canUndo && list.canRedo).toBe(true);
    list.clear();
    expect(list.canUndo || list.canRedo).toBe(false);
  });
});
