import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWml, parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location, getAdjacentTiles } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, type RegistryEntry } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { executeMove } from '../../src/actions/move.js';
import { recruitUnit } from '../../src/actions/recruit.js';
import { clearShroud } from '../../src/actions/vision.js';
import { MtRng, RngDeterministic } from '../../src/rng/index.js';

/**
 * `unit_mover` fog behaviour. Maps are 9x9 raw grids (logical 0..6 after the
 * 1-hex border); every move walks column x=4 northwards from (4,6).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const defines: DefineMap = new Map();
preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
const terrainData = TerrainTypeData.fromConfigs(
  parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines }).children('terrain_type'),
);
const smallfoot = (() => {
  const cfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines });
  function walk({ tag, config }: { tag: string; config: WmlConfig }): WmlConfig[] {
    if (tag === 'movetype' && config.getString('name') === 'smallfoot') return [config];
    return config.allChildren().flatMap(walk);
  }
  return MoveType.fromConfig(cfg.allChildren().flatMap(walk)[0]!, terrainData);
})();

const COLUMN = [6, 5, 4, 3, 2, 1, 0].map((y) => new Location(4, y));

function mapText(forest: Location[] = []): string {
  const rows: string[] = [];
  for (let y = 0; y < 9; y++) {
    const cells: string[] = [];
    for (let x = 0; x < 9; x++) {
      cells.push(forest.some((f) => f.x + 1 === x && f.y + 1 === y) ? 'Gs^Fp' : 'Gg');
    }
    rows.push(cells.join(', '));
  }
  return rows.join('\n');
}

function makeType(id: string, options: { movement?: number; vision?: number; abilities?: RegistryEntry[] } = {}): UnitType {
  const movement = options.movement ?? 6;
  return new UnitType(
    id, id, '', 'neutral', 1, 20, movement, options.vision ?? movement, 0, 1, 14, -1, 32, [], '', false, false, false,
    smallfoot, [], options.abilities ?? [], undefined, undefined, options.vision !== undefined,
  );
}

function setup(options: { fog?: boolean; forest?: Location[] } = {}): { board: GameBoard; t1: Team } {
  const board = new GameBoard(GameMap.fromMapString(mapText(options.forest), terrainData));
  const t1 = new Team(1, { teamName: 'north' });
  t1.fog.enabled = options.fog ?? false;
  board.addTeam(t1);
  board.addTeam(new Team(2, { teamName: 'south' }));
  return { board, t1 };
}

function place(board: GameBoard, type: UnitType, side: number, loc: Location): Unit {
  const unit = Unit.create(type, side, loc);
  board.addUnit(unit);
  return unit;
}

const ambush: RegistryEntry = {
  tag: 'hides',
  config: parseWml('[hides]\nid=ambush\naffect_self=yes\n[filter]\n[filter_location]\nterrain=*^F*\n[/filter_location]\n[/filter]\n[/hides]').child('hides')!,
};

describe('executeMove under fog (unit_mover)', () => {
  it('stops at a reasonable hex once an enemy comes into view, and raises sighted', () => {
    const { board } = setup({ fog: true });
    const mover = place(board, makeType('scout', { vision: 1 }), 1, COLUMN[0]!);
    place(board, makeType('enemy'), 2, COLUMN[6]!);
    clearShroud(board, 1);

    const raised: string[] = [];
    const result = executeMove(board, mover, COLUMN, { raise: (name, l1, l2) => raised.push(`${name} ${l1} ${l2}`) });

    expect(result.sightedStop).toBe(true);
    expect(result.enemiesSighted).toBe(1);
    expect(mover.location.equals(COLUMN[4]!)).toBe(true);
    expect(result.path.map(String)).toEqual(COLUMN.slice(0, 5).map(String));
    expect(result.movesLeft).toBe(2);
    expect(result.fogChanged).toBe(true);
    expect(result.undoBlocked).toBe(true);
    expect(raised).toEqual([`sighted ${COLUMN[6]} ${COLUMN[4]}`]);
  });

  it('a move that reveals nothing new does not block undo', () => {
    const { board } = setup();
    const mover = place(board, makeType('scout'), 1, COLUMN[0]!);
    const result = executeMove(board, mover, COLUMN.slice(0, 3));
    expect(result.undoBlocked).toBe(false);
    expect(mover.location.equals(COLUMN[2]!)).toBe(true);
  });

  it('is ambushed by a hidden unit next to the route, losing its movement', () => {
    const stop = COLUMN[4]!;
    const earlier = COLUMN.slice(0, 4);
    const ambushLoc = getAdjacentTiles(stop).find(
      (l) => !COLUMN.some((c) => c.equals(l)) && !earlier.some((e) => getAdjacentTiles(e).some((a) => a.equals(l))),
    )!;
    const { board } = setup({ forest: [ambushLoc] });
    const mover = place(board, makeType('scout'), 1, COLUMN[0]!);
    const ambusher = place(board, makeType('ranger', { abilities: [ambush] }), 2, ambushLoc);

    const result = executeMove(board, mover, COLUMN);

    expect(result.ambushed).toBe(true);
    expect(result.ambusherLocations.map(String)).toEqual([String(ambushLoc)]);
    expect(mover.location.equals(stop)).toBe(true);
    expect(result.movesLeft).toBe(0);
    expect(ambusher.hasStatus('uncovered')).toBe(true);
    expect(result.undoBlocked).toBe(true);
  });

  it('stops in front of an unseen (fogged, not invisible) enemy standing on the route', () => {
    // Delayed shroud updates: no clearing while moving, so the enemy is never sighted first.
    // (An invisible enemy there would ambush from the previous hex instead, as upstream.)
    const { board, t1 } = setup({ fog: true });
    t1.autoShroudUpdates = false;
    const mover = place(board, makeType('scout'), 1, COLUMN[0]!);
    const blocker = place(board, makeType('enemy'), 2, COLUMN[3]!);

    const result = executeMove(board, mover, COLUMN);

    expect(result.blocked).toBe(true);
    expect(mover.location.equals(COLUMN[2]!)).toBe(true);
    expect(blocker.hasStatus('uncovered')).toBe(true);
  });

  it('never ends a planned move on a visible friendly unit', () => {
    const { board } = setup();
    const mover = place(board, makeType('scout'), 1, COLUMN[0]!);
    place(board, makeType('friend'), 1, COLUMN[2]!);
    const result = executeMove(board, mover, COLUMN.slice(0, 3));
    expect(mover.location.equals(COLUMN[1]!)).toBe(true);
    expect(result.path).toHaveLength(2);
  });
});

describe('recruiting under fog (place_recruit)', () => {
  it('clears fog around the new unit', () => {
    const { board, t1 } = setup({ fog: true });
    const leader = place(board, makeType('leader'), 1, COLUMN[0]!);
    const loc = COLUMN[3]!;
    expect(t1.fogged(COLUMN[2]!)).toBe(true);
    recruitUnit(board, t1, makeType('recruit', { movement: 1 }), loc, leader.location, new RngDeterministic(new MtRng(1)));
    expect(t1.fogged(loc)).toBe(false);
    expect(t1.fogged(COLUMN[2]!)).toBe(false);
  });
});
