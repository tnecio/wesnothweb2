import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Location } from '../../src/model/Location.js';
import type { UnitType } from '../../src/model/UnitType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { findLocations } from '../../src/events/filter.js';
import { parseWml } from '../../src/wml/index.js';

/**
 * Shroud/fog WML tags on a synthetic 9x9 raw grid (logical 0..6). Tag
 * coordinates are WML (1-based), so WML (4,4) is logical (3,3).
 */

function makeBoard(water: string[] = []): { board: GameBoard; t1: Team; t2: Team } {
  const rows: string[] = [];
  for (let y = 0; y < 9; y++) {
    const cells: string[] = [];
    for (let x = 0; x < 9; x++) cells.push(water.includes(`${x},${y}`) ? 'Wo' : 'Gg');
    rows.push(cells.join(', '));
  }
  const board = new GameBoard(GameMap.fromMapString(rows.join('\n'), TerrainTypeData.fromConfigs([])));
  const t1 = new Team(1, { teamName: 'a' });
  const t2 = new Team(2, { teamName: 'b' });
  for (const t of [t1, t2]) {
    t.shroud.enabled = true;
    t.fog.enabled = true;
    board.addTeam(t);
  }
  return { board, t1, t2 };
}

function runTag(board: GameBoard, tagWml: string): void {
  const manager = new EventManager();
  manager.addFromWml(parseWml(`[event]\nname=go\n${tagWml}\n[/event]`).child('event')!);
  const pump = new EventPump(manager, {
    board,
    variables: new VariableStore(),
    resolveType: (id: string): UnitType => {
      throw new Error(`unexpected unit type ${id}`);
    },
  });
  pump.fire('go');
}

const wml = (x: number, y: number): Location => Location.fromWml(x, y);

describe('[remove_shroud] / [place_shroud]', () => {
  it('clears a radius around a hex for the named side only', () => {
    const { board, t1, t2 } = makeBoard();
    runTag(board, '[remove_shroud]\nside=1\nx,y=4,4\nradius=1\n[/remove_shroud]');
    expect(t1.shrouded(wml(4, 4))).toBe(false);
    expect(t1.shrouded(wml(4, 3))).toBe(false);
    expect(t1.shrouded(wml(4, 2))).toBe(true);
    expect(t2.shrouded(wml(4, 4))).toBe(true);
  });

  it('without side= affects every side, and place_shroud re-covers x/y ranges', () => {
    const { board, t1, t2 } = makeBoard();
    runTag(board, '[remove_shroud]\nx=1-7\ny=1-7\n[/remove_shroud]');
    expect(t2.shrouded(wml(7, 7))).toBe(false);
    runTag(board, '[place_shroud]\nside=1\nx=3-4\ny=3\n[/place_shroud]');
    expect(t1.shrouded(wml(3, 3))).toBe(true);
    expect(t1.shrouded(wml(4, 3))).toBe(true);
    expect(t1.shrouded(wml(5, 3))).toBe(false);
    expect(t2.shrouded(wml(3, 3))).toBe(false);
  });
});

describe('[lift_fog] / [reset_fog]', () => {
  it('lifts fog immediately; the next refog brings it back', () => {
    const { board, t1 } = makeBoard();
    t1.clearShroud(wml(2, 2));
    runTag(board, '[lift_fog]\nx,y=2,2\n[/lift_fog]');
    expect(t1.fogged(wml(2, 2))).toBe(false);
    t1.refog();
    expect(t1.fogged(wml(2, 2))).toBe(true);
  });

  it('multiturn=yes keeps hexes clear through refogs until [reset_fog]', () => {
    const { board, t1, t2 } = makeBoard();
    t1.clearShroud(wml(2, 2));
    runTag(board, '[lift_fog]\nx,y=2,2\nmultiturn=yes\n[filter_side]\nside=1\n[/filter_side]\n[/lift_fog]');
    t1.refog();
    expect(t1.fogged(wml(2, 2))).toBe(false);
    expect(t2.fogClearer.size).toBe(0);
    runTag(board, '[reset_fog]\nx,y=2,2\n[/reset_fog]');
    expect(t1.fogged(wml(2, 2))).toBe(true);
  });

  it('reset_fog reset_view=yes re-fogs everything the side had cleared', () => {
    const { board, t1 } = makeBoard();
    t1.clearShroud(wml(5, 5));
    t1.clearFog(wml(5, 5));
    runTag(board, '[reset_fog]\nx,y=1,1\nreset_view=yes\n[/reset_fog]');
    expect(t1.fogged(wml(5, 5))).toBe(true);
  });
});

describe('findLocations (terrain_filter::get_locations)', () => {
  it('matches terrain= and applies [not]', () => {
    const { board } = makeBoard(['2,2', '3,2']);
    const locs = findLocations(board, parseWml('[f]\nterrain=Wo\n[not]\nx=3\n[/not]\n[/f]').child('f')!);
    expect(locs.map(String)).toEqual(['2,2']);
  });

  it('radius= expands only through hexes matching [filter_radius]', () => {
    const { board } = makeBoard(['4,4', '4,3']);
    const cfg = parseWml('[f]\nx,y=4,4\nradius=3\n[filter_radius]\nterrain=Wo\n[/filter_radius]\n[/f]').child('f')!;
    expect(findLocations(board, cfg).map(String).sort()).toEqual(['4,3', '4,4']);
  });
});
