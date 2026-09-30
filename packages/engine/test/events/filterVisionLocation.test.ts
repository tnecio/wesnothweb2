import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { Location } from '../../src/model/Location.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, type RegistryEntry } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { unitMatchesFilter } from '../../src/events/filter.js';
import { parseWml } from '../../src/wml/index.js';

/** `[filter_location]`/`[filter_vision]` inside a Standard Unit Filter, on a flat 5x5 raw grid (logical 0..2). */
function makeBoard(water: string[] = []): { board: GameBoard; t1: Team; t2: Team } {
  const rows: string[] = [];
  for (let y = 0; y < 5; y++) {
    const cells: string[] = [];
    for (let x = 0; x < 5; x++) cells.push(water.includes(`${x},${y}`) ? 'Wo' : 'Gg');
    rows.push(cells.join(', '));
  }
  const board = new GameBoard(GameMap.fromMapString(rows.join('\n'), TerrainTypeData.fromConfigs([])));
  const t1 = new Team(1, { teamName: 'a' });
  const t2 = new Team(2, { teamName: 'b' });
  for (const t of [t1, t2]) {
    t.fog.enabled = true;
    board.addTeam(t);
  }
  return { board, t1, t2 };
}

const flatMoveType = MoveType.fromConfig(parseWml(''), TerrainTypeData.fromConfigs([]));

function makeType(id: string, abilities: RegistryEntry[] = []): UnitType {
  return new UnitType(id, id, '', 'neutral', 1, 20, 5, 5, 0, 1, 1, -1, 32, [], '', false, false, false, flatMoveType, [], abilities);
}

describe('SUF [filter_location]', () => {
  it('matches units on a terrain matching the location filter', () => {
    // Water override key is in raw (pre-border) text coordinates: '2,2' lands on logical (1,1).
    const { board } = makeBoard(['2,2']);
    const onWater = Unit.create(makeType('merman'), 1, new Location(0, 0));
    board.addUnit(onWater);
    const cfg = parseWml('[u]\n[filter_location]\nterrain=Wo\n[/filter_location]\n[/u]').child('u')!;
    expect(unitMatchesFilter(onWater, cfg, board)).toBe(false);
    onWater.location = new Location(1, 1);
    expect(unitMatchesFilter(onWater, cfg, board)).toBe(true);
  });
});

describe('SUF [filter_vision]', () => {
  it('visible=no matches a unit fogged from the given side', () => {
    const { board, t1 } = makeBoard();
    const enemy = Unit.create(makeType('enemy'), 2, new Location(2, 2));
    board.addUnit(enemy);
    const cfg = parseWml('[u]\n[filter_vision]\nside=1\nvisible=no\n[/filter_vision]\n[/u]').child('u')!;
    expect(unitMatchesFilter(enemy, cfg, board)).toBe(true);
    t1.clearFog(new Location(2, 2));
    expect(unitMatchesFilter(enemy, cfg, board)).toBe(false);
  });

  it('defaults to visible=yes and checks every side when side= is omitted', () => {
    const { board, t1, t2 } = makeBoard();
    const enemy = Unit.create(makeType('enemy'), 2, new Location(2, 2));
    board.addUnit(enemy);
    const cfg = parseWml('[u]\n[filter_vision]\n[/filter_vision]\n[/u]').child('u')!;
    // Upstream asks each side's fog map for the unit's hex; nothing has cleared any fog on this board yet.
    expect(unitMatchesFilter(enemy, cfg, board)).toBe(false);
    t2.fog.enabled = false;
    t1.fog.enabled = false;
    expect(unitMatchesFilter(enemy, cfg, board)).toBe(true);
  });
});
