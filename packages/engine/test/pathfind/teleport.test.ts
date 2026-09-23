import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { getTeleportLocations } from '../../src/pathfind/teleport.js';
import { parseWml } from '../../src/wml/index.js';
import { loadRealContent } from '../helpers/realContent.js';

/** Phase 18a: `teleport.cpp` -- tunnels from the real Silver Mage's `abilities_list=teleport`, and from `[tunnel]`. */
const content = loadRealContent();
const L = (x: number, y: number) => new Location(x, y);
const keys = (locs: readonly Location[]) => locs.map((l) => `${l.x},${l.y}`).sort();

function setup() {
  // Villages at (0,0), (2,0), (4,0) and (0,2); grass elsewhere.
  const board = new GameBoard(content.map(['Gg^Vh, Gg, Gg^Vh, Gg, Gg^Vh', 'Gg, Gg, Gg, Gg, Gg', 'Gg^Vh, Gg, Gg, Gg, Gg']));
  const t1 = new Team(1, { teamName: 'a' });
  const t2 = new Team(2, { teamName: 'b' });
  board.addTeam(t1);
  board.addTeam(t2);
  for (const loc of [L(0, 0), L(2, 0), L(0, 2)]) board.captureVillage(loc, 1);
  board.captureVillage(L(4, 0), 2);
  const mage = Unit.create(content.unitType('Silver Mage'), 1, L(0, 0));
  board.addUnit(mage);
  return { board, t1, t2, mage };
}

describe('getTeleportLocations', () => {
  it("the Silver Mage's teleport joins its side's villages -- from the one it stands on to the empty ones", () => {
    const { board, mage } = setup();
    const map = getTeleportLocations(board, mage);
    expect(keys(map.adjacents(L(0, 0)))).toEqual(['0,2', '2,0']);
    expect(keys(map.sources)).toEqual(['0,0', '0,2', '2,0']);
    expect(map.adjacents(L(4, 0))).toEqual([]); // the enemy's village is not in the network
  });

  it('an occupied own village is not a destination', () => {
    const { board, mage } = setup();
    board.addUnit(Unit.create(content.unitType('Spearman'), 1, L(2, 0)));
    expect(keys(getTeleportLocations(board, mage).adjacents(L(0, 0)))).toEqual(['0,2']);
  });

  it('a unit without the ability gets nothing', () => {
    const { board } = setup();
    const spearman = Unit.create(content.unitType('Spearman'), 1, L(1, 1));
    board.addUnit(spearman);
    expect(getTeleportLocations(board, spearman).isEmpty).toBe(true);
  });

  it('[tunnel] works both ways unless bidirectional=no, and remove= takes out both directions', () => {
    const { board } = setup();
    const spearman = Unit.create(content.unitType('Spearman'), 1, L(1, 1));
    board.addUnit(spearman);
    const tunnel = parseWml(`[tunnel]
id=gate
[source]
x,y=2,2
[/source]
[target]
x,y=5,3
[/target]
[filter]
side=1
[/filter]
[/tunnel]`).child('tunnel')!;
    board.tunnels.addFromWml(tunnel);
    let map = getTeleportLocations(board, spearman);
    expect(keys(map.adjacents(L(1, 1)))).toEqual(['4,2']);
    expect(keys(map.adjacents(L(4, 2)))).toEqual(['1,1']);

    board.tunnels.remove('gate');
    expect(getTeleportLocations(board, spearman).isEmpty).toBe(true);

    const oneWay = tunnel.clone();
    oneWay.setAttribute('bidirectional', false);
    board.tunnels.addFromWml(oneWay);
    map = getTeleportLocations(board, spearman);
    expect(keys(map.adjacents(L(1, 1)))).toEqual(['4,2']);
    expect(map.adjacents(L(4, 2))).toEqual([]);
  });

  it("an enemy's teleport network is limited to what the viewing side can see", () => {
    const { board, t2, mage } = setup();
    t2.fog.enabled = true; // all fogged
    expect(getTeleportLocations(board, mage, { viewingTeam: t2 }).isEmpty).toBe(true);
    expect(getTeleportLocations(board, mage, { viewingTeam: t2, seeAll: true }).isEmpty).toBe(false);
  });
});

import { ALL_DIRECTIONS, directionBetween, getAdjacentTiles, relativeDirection, Direction } from '../../src/model/Location.js';
import { findPath, reachableHexes } from '../../src/pathfind/pathfind.js';
import { executeMove } from '../../src/actions/move.js';

describe('relativeDirection', () => {
  it('agrees with the adjacency directions on both column parities', () => {
    for (const center of [L(4, 4), L(5, 4)]) {
      const adj = getAdjacentTiles(center);
      adj.forEach((loc, i) => expect(relativeDirection(center, loc)).toBe(ALL_DIRECTIONS[i]));
      adj.forEach((loc) => expect(relativeDirection(center, loc)).toBe(directionBetween(center, loc)));
    }
  });
  it('gives a general direction far away, and Indeterminate for the same hex', () => {
    expect(relativeDirection(L(0, 0), L(0, 5))).toBe(Direction.South);
    expect(relativeDirection(L(0, 5), L(6, 1))).toBe(Direction.NorthEast);
    expect(relativeDirection(L(3, 3), L(3, 3))).toBe(Direction.Indeterminate);
  });
});

describe('moving through a teleport', () => {
  /** A wide strip: side 1's villages at the far ends, far beyond one turn's walk. */
  function strip() {
    const row = Array(16).fill('Gg');
    row[0] = 'Gg^Vh';
    row[15] = 'Gg^Vh';
    const board = new GameBoard(content.map([row.join(', '), Array(16).fill('Gg').join(', ')]));
    const t1 = new Team(1, { teamName: 'a' });
    const t2 = new Team(2, { teamName: 'b' });
    board.addTeam(t1);
    board.addTeam(t2);
    board.captureVillage(L(0, 0), 1);
    board.captureVillage(L(15, 0), 1);
    const mage = Unit.create(content.unitType('Silver Mage'), 1, L(0, 0));
    board.addUnit(mage);
    return { board, mage };
  }

  it('the reach includes the far village and the hexes around it, unless allowTeleport=false', () => {
    const { board, mage } = strip();
    const withTeleport = reachableHexes(board, mage, { allowTeleport: true });
    expect(withTeleport.destinations.contains(L(15, 0))).toBe(true);
    expect(withTeleport.destinations.contains(L(14, 0))).toBe(true);
    expect(reachableHexes(board, mage, { allowTeleport: false }).destinations.contains(L(15, 0))).toBe(false);
  });

  it('findPath jumps: one step from village to village', () => {
    const { board, mage } = strip();
    const route = findPath(board, mage, L(14, 1), { allowTeleport: true });
    expect(route.steps.slice(0, 2).map((l) => `${l.x},${l.y}`)).toEqual(['0,0', '15,0']);
    expect(route.steps.at(-1)!.equals(L(14, 1))).toBe(true);
  });

  it('executeMove teleports, paying only the exit terrain, and faces the way it went', () => {
    const { board, mage } = strip();
    const before = mage.movesLeft;
    const result = executeMove(board, mage, findPath(board, mage, L(15, 0), { allowTeleport: true }).steps);
    expect(mage.location.equals(L(15, 0))).toBe(true);
    expect(result.teleportFailed).toBe(false);
    expect(before - mage.movesLeft).toBe(1); // entering the village hex
  });

  it('an enemy the mover could not see on the exit fails the teleport', () => {
    const { board, mage } = strip();
    const path = findPath(board, mage, L(15, 0), { allowTeleport: true }).steps;
    board.addUnit(Unit.create(content.unitType('Spearman'), 2, L(15, 0)));
    board.getTeam(1)!.fog.enabled = true; // the exit is fogged: side 1 cannot see the Spearman
    const result = executeMove(board, mage, path);
    expect(result.teleportFailed).toBe(true);
    expect(mage.location.equals(L(0, 0))).toBe(true);
  });
});
