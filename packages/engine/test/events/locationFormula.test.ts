import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { findLocations, locationMatchesFilterOnBoard } from '../../src/events/filter.js';
import { parseWml } from '../../src/wml/index.js';
import { loadRealContent } from '../helpers/realContent.js';

/**
 * Phase 18a: the location-filter keys `ABILITY_TELEPORT`'s tunnel needs --
 * `gives_income=`, `owner_side=` and `formula=` with `teleport_unit` and
 * `unit_at` -- checked with the tunnel's own real formulas.
 */
const content = loadRealContent();

function setup() {
  // Three villages in a row of grass; (0,0) and (2,0) owned by side 1, (4,0) by side 2.
  const board = new GameBoard(content.map(['Gg^Vh, Gg, Gg^Vh, Gg, Gg^Vh', 'Gg, Gg, Gg, Gg, Gg']));
  board.addTeam(new Team(1, { teamName: 'a' }));
  board.addTeam(new Team(2, { teamName: 'b' }));
  board.captureVillage(new Location(0, 0), 1);
  board.captureVillage(new Location(2, 0), 1);
  board.captureVillage(new Location(4, 0), 2);
  const mage = Unit.create(content.unitType('Silver Mage'), 1, new Location(0, 0));
  board.addUnit(mage);
  return { board, mage };
}

const filter = (wml: string) => parseWml(`[f]\n${wml}\n[/f]`).child('f')!;
const keys = (locs: Location[]) => locs.map((l) => `${l.x},${l.y}`).sort();

describe('location filter: gives_income / owner_side / formula', () => {
  it('gives_income=yes matches villages only', () => {
    const { board } = setup();
    expect(keys(findLocations(board, filter('gives_income=yes')))).toEqual(['0,0', '2,0', '4,0']);
  });

  it('owner_side= matches the owning side', () => {
    const { board } = setup();
    expect(keys(findLocations(board, filter('owner_side=2')))).toEqual(['4,0']);
  });

  it("the teleport tunnel's [source]: own villages that are empty or hold the teleporting unit itself", () => {
    const { board, mage } = setup();
    const source = filter(`gives_income=true
formula="
    owner_side = teleport_unit.side_number and (unit = teleport_unit or not unit)
where
    unit = unit_at(loc)
"`);
    expect(keys(findLocations(board, source, mage))).toEqual(['0,0', '2,0']);
  });

  it("the teleport tunnel's [target]: own villages with no unit on them", () => {
    const { board, mage } = setup();
    const target = filter(`gives_income=true
formula="owner_side = teleport_unit.side_number and not unit_at(loc)"`);
    expect(keys(findLocations(board, target, mage))).toEqual(['2,0']);
  });

  it('a formula that fails to parse matches nothing', () => {
    const { board } = setup();
    expect(locationMatchesFilterOnBoard(board, new Location(0, 0), filter('formula="x ==="'))).toBe(false);
  });
});
