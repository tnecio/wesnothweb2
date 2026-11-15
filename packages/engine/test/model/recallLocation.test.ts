import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { Location } from '../../src/model/Location.js';
import { MoveType } from '../../src/model/MoveType.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { Unit } from '../../src/model/Unit.js';
import { Team } from '../../src/model/Team.js';
import { findUnits } from '../../src/events/filter.js';
import { parseWml } from '../../src/wml/index.js';

const terrain = TerrainTypeData.fromConfigs([]);
const type = new UnitType('Spearman', 'Spearman', 'human', 'lawful', 1, 30, 5, 5, 0, 1, 14, -1, 42, [], '', true, false, false, MoveType.fromConfig(new WmlConfig(), terrain), [AttackType.fromConfig(new WmlConfig())], []);

// Liberty 3 stores the side's units with `[not] x,y=recall,recall` and looks each up on the map: a unit carried
// onto the recall list kept its last hex, so it was stored too, and `[unit_worth]` did not find it.
describe('recall lists', () => {
  it('a unit put on a recall list has no location, so x,y=recall sees it as recalled', () => {
    const board = new GameBoard(GameMap.fromMapString('Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg', terrain));
    board.addTeam(new Team(1, { gold: 0, controller: 'human' }));
    const novus = Unit.create(type, 1, new Location(1, 1), { id: 'Novus' });
    board.addToRecallList(1, novus);
    expect(novus.location.valid()).toBe(false);
    const notRecalled = findUnits(board, parseWml('[not]\nx,y=recall,recall\n[/not]'), true);
    expect(notRecalled).not.toContain(novus);
    expect(findUnits(board, parseWml('x,y=recall,recall'), true)).toContain(novus);

    const back = Unit.create(type, 1, new Location(0, 0), { id: 'Back' });
    board.insertIntoRecallList(1, back, 0);
    expect(back.location.valid()).toBe(false);
  });
});
