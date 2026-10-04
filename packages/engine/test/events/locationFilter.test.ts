import { afterEach, describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Location } from '../../src/model/Location.js';
import { Team } from '../../src/model/Team.js';
import { findLocations, setFilterEnvironment, unitMatchesFilter } from '../../src/events/filter.js';
import { Unit } from '../../src/model/Unit.js';
import { parseWml } from '../../src/wml/index.js';
import { loadRealContent } from '../helpers/realContent.js';

/**
 * Phase 28c B4: the rest of `terrain_filter::match_internal` -- `[filter_adjacent_location]`, `[filter_owner]`,
 * `find_in=`, `area=`, `time_of_day=`/`time_of_day_id=`, `location_id=`. Heir to the Throne Classic 7 places its
 * ambushers on hills surrounded by hills, mountains or forest; without `[filter_adjacent_location]` none matched.
 */

// Playable 1..5 (WML): a hill in the middle of hills, others at the edge of grass, a village at 5,5.
const ROWS = [
  'Gg, Gg, Gg, Gg, Gg',
  'Gg, Hh, Hh, Hh, Gg',
  'Gg, Hh, Hh, Mm, Gg',
  'Gg, Hh, Hh^Fp, Hh, Gg',
  'Gg, Gg, Gg, Gg, Gg^Vh',
];

function makeBoard(): GameBoard {
  // Real terrain types, so the village is one (`gives_income`).
  const board = new GameBoard(loadRealContent().map(ROWS));
  board.addTeam(new Team(1));
  board.addTeam(new Team(2, { teamName: 'enemy' }));
  return board;
}

const keys = (locs: Location[]) => locs.map((l) => `${l.wmlX},${l.wmlY}`).sort();

afterEach(() => setFilterEnvironment(undefined));

describe('location filter: the rest of terrain_filter::match_internal', () => {
  it('[filter_adjacent_location]: hills with no neighbour outside hills, mountains or forest', () => {
    const board = makeBoard();
    const cfg = parseWml(`terrain=Hh
[not]
  [filter_adjacent_location]
    [not]
      terrain=Hh*,Mm*,*^F*
    [/not]
  [/filter_adjacent_location]
[/not]`);
    expect(keys(findLocations(board, cfg))).toEqual(['3,3']);
    // count= and adjacent=: hexes with exactly two grass neighbours to the north-west or north.
    const two = parseWml(`[filter_adjacent_location]
  terrain=Gg
  adjacent=n,nw,ne
  count=3
[/filter_adjacent_location]`);
    expect(keys(findLocations(board, two))).toContain('3,2');
  });

  it('[filter_owner] and owner_side=: villages by their owner', () => {
    const board = makeBoard();
    board.captureVillage(Location.fromWml(5, 5), 2);
    expect(keys(findLocations(board, parseWml('[filter_owner]\nteam_name=enemy\n[/filter_owner]')))).toEqual(['5,5']);
    expect(keys(findLocations(board, parseWml('[filter_owner]\nside=1\n[/filter_owner]')))).toEqual([]);
    expect(keys(findLocations(board, parseWml('owner_side=2')))).toEqual(['5,5']);
  });

  it('find_in=, area= and time_of_day= read the installed game state', () => {
    const board = makeBoard();
    setFilterEnvironment({
      locationsIn: (v) => (v === 'spots' ? [{ x: 1, y: 1 }, { x: 2, y: 3 }] : []),
      areaHexes: (id) => (id === 'camp' ? new Set([Location.fromWml(4, 4).key()]) : undefined),
      timeOfDayAt: (loc) => (loc.wmlX === 1 ? { id: 'dusk', lawfulBonus: 0 } : { id: 'second_watch', lawfulBonus: -25 }),
      idsIn: () => [],
    });
    expect(keys(findLocations(board, parseWml('find_in=spots')))).toEqual(['1,1', '2,3']);
    expect(keys(findLocations(board, parseWml('area=camp')))).toEqual(['4,4']);
    expect(keys(findLocations(board, parseWml('x=1-2\ny=1\ntime_of_day=chaotic')))).toEqual(['2,1']);
    expect(keys(findLocations(board, parseWml('x=1-2\ny=1\ntime_of_day_id=dusk,dawn')))).toEqual(['1,1']);
  });

  it("unit filter: type_adv_tree=, has_variation=, find_in= (The Deceiver's Gambit kills only its summons by type_adv_tree)", () => {
    const content = loadRealContent();
    const board = makeBoard();
    const mud = Unit.create(content.unitType('Mudcrawler'), 1, Location.fromWml(1, 1));
    const giant = Unit.create(content.unitType('Giant Mudcrawler'), 1, Location.fromWml(2, 1));
    const mage = Unit.create(content.unitType('Mage'), 1, Location.fromWml(3, 1));
    mage.id = 'Delfador';
    for (const u of [mud, giant, mage]) board.addUnit(u);
    const tree = parseWml('side=1\ntype_adv_tree=Mudcrawler');
    // Without the unit types installed: the listed type only.
    expect([mud, giant, mage].map((u) => unitMatchesFilter(u, tree, board))).toEqual([true, false, false]);
    setFilterEnvironment({
      locationsIn: () => [],
      areaHexes: () => undefined,
      timeOfDayAt: () => ({ id: 'dawn', lawfulBonus: 0 }),
      idsIn: (v) => (v === 'heroes' ? ['Delfador'] : []),
      unitType: (id) => content.unitType(id),
    });
    expect([mud, giant, mage].map((u) => unitMatchesFilter(u, tree, board))).toEqual([true, true, false]);
    expect(unitMatchesFilter(mage, parseWml('find_in=heroes'), board)).toBe(true);
    expect(unitMatchesFilter(mud, parseWml('find_in=heroes'), board)).toBe(false);
  });
});
