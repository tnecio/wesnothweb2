import { describe, expect, it } from 'vitest';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { findPath, markRoute } from '../../src/pathfind/pathfind.js';

/** Phase 28b: `markRoute`, upstream's `mark_route` -- where a route ends each turn (the footsteps' turn numbers). */

function buildFlatMap(size: number, terrainData: TerrainTypeData): GameMap {
  const row = Array.from({ length: size }, () => 'Gg').join(',');
  const text = Array.from({ length: size }, () => row).join('\n');
  return GameMap.fromMapString(text, terrainData, 1);
}

function buildMoveType(costs: Record<string, number>, terrainData: TerrainTypeData): MoveType {
  const cfg = new WmlConfig();
  const costsCfg = new WmlConfig();
  for (const [k, v] of Object.entries(costs)) costsCfg.setAttribute(k, v);
  cfg.addChild('movement_costs', costsCfg);
  return MoveType.fromConfig(cfg, terrainData);
}

function makeUnitType(
  id: string,
  moveType: MoveType,
  options: { movement?: number; zoc?: boolean; skirmisher?: boolean } = {},
): UnitType {
  const abilities: { tag: string; config: WmlConfig }[] = [];
  if (options.skirmisher) {
    const a = new WmlConfig();
    a.setAttribute('id', 'skirmisher');
    abilities.push({ tag: 'skirmisher', config: a });
  }
  return new UnitType(
    id,
    id,
    '',
    'neutral',
    1,
    30,
    options.movement ?? 3,
    options.movement ?? 3,
    0,
    1,
    0,
    -1,
    500,
    [],
    '',
    options.zoc ?? false,
    false,
    false,
    moveType,
    [],
    abilities,
  );
}

describe('markRoute', () => {
  const terrainData = new TerrainTypeData();
  const flat = buildMoveType({ Gg: 1 }, terrainData);

  function setup(movement: number): { board: GameBoard; unit: Unit } {
    const board = new GameBoard(buildFlatMap(12, terrainData));
    board.addTeam(new Team(1));
    board.addTeam(new Team(2));
    const unit = Unit.create(makeUnitType('walker', flat, { movement }), 1, new Location(4, 1));
    board.addUnit(unit);
    return { board, unit };
  }

  const at = (marks: ReturnType<typeof markRoute>['marks']) => marks.map((m) => `${m.loc.x},${m.loc.y}:${m.turns}${m.zoc ? 'z' : ''}`);

  it('marks only the last hex of a route the unit finishes this turn', () => {
    const { board, unit } = setup(5);
    const route = findPath(board, unit, new Location(4, 4));
    const marked = markRoute(board, unit, route.steps);
    expect(at(marked.marks)).toEqual(['4,4:1']);
    expect(marked.moveCost).toBe(3);
  });

  it('marks where each turn ends on a longer route, with the turn it is reached', () => {
    const { board, unit } = setup(3);
    const route = findPath(board, unit, new Location(4, 8));
    expect(route.steps).toHaveLength(8);
    const marked = markRoute(board, unit, route.steps);
    expect(at(marked.marks)).toEqual(['4,4:1', '4,7:2', '4,8:3']);
    // Two whole turns plus one hex of the third.
    expect(marked.moveCost).toBe(7);
  });

  it('counts only the movement the unit has left for the first turn', () => {
    const { board, unit } = setup(3);
    unit.movesLeft = 1;
    const marked = markRoute(board, unit, findPath(board, unit, new Location(4, 5)).steps);
    expect(at(marked.marks)).toEqual(['4,2:1', '4,5:2']);
  });

  it('ends a turn on entering an enemy zone of control, and marks it', () => {
    const { board, unit } = setup(5);
    const enemy = Unit.create(makeUnitType('guard', flat, { movement: 3, zoc: true }), 2, new Location(5, 4));
    board.addUnit(enemy);
    // Straight down the x=4 column: (4,4) and (4,5) are next to the guard at (5,4).
    const steps = [1, 2, 3, 4, 5, 6].map((y) => new Location(4, y));
    const marked = markRoute(board, unit, steps);
    expect(at(marked.marks)).toEqual(['4,4:1z', '4,5:2z', '4,6:3']);
  });

  it('stops marking where the unit could never enter the next hex', () => {
    // (4,3) is mountains; the map text has a one-hex border, hence the +1s.
    const rows = Array.from({ length: 12 }, (_, y) => Array.from({ length: 12 }, (_, x) => (x === 4 + 1 && y === 3 + 1 ? 'Mm' : 'Gg')).join(','));
    const board = new GameBoard(GameMap.fromMapString(rows.join('\n'), terrainData, 1));
    board.addTeam(new Team(1));
    const unit = Unit.create(makeUnitType('walker', buildMoveType({ Gg: 1, Mm: 5 }, terrainData), { movement: 3 }), 1, new Location(4, 1));
    board.addUnit(unit);
    expect(unit.movementCost(board.map.getTerrain(new Location(4, 3)))).toBe(5);
    const steps = [1, 2, 3, 4].map((y) => new Location(4, y));
    const marked = markRoute(board, unit, steps);
    // Mountains cost more than a whole turn: the route ends at the turn's first stop.
    expect(at(marked.marks)).toEqual(['4,2:1']);
  });
});
