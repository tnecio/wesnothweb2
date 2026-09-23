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
