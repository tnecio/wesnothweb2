/**
 * Phase 27b: WFL's location functions (formula/function.cpp), the board's (function_gamestate.cpp), and
 * `self` as `formula_callable::query_value` resolves it -- what backstab's `[filter_opponent]` formula needs.
 */
import { describe, expect, it } from 'vitest';
import { parseFormula, MapFormulaCallable, Variant } from '../../src/formula/index.js';
import { gameStateSymbols, unitFormulaContext, unitMatchesFilter } from '../../src/events/filter.js';
import { Location, Direction } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { parseConfig } from '../../src/index.js';
import { flatMoveType, loadTerrainData, makeBoard, makeUnitType, makeWeapon } from '../ai/helpers.js';

const evalCore = (src: string) => parseFormula(src).evaluate(new MapFormulaCallable());

describe('core location functions', () => {
  it('loc, distance_between, are_adjacent and direction_from', () => {
    expect(evalCore('distance_between(loc(5,5), loc(5,8))').asInt()).toBe(3);
    expect(evalCore('are_adjacent(loc(5,5), loc(6,5))').asInt()).toBe(1);
    expect(evalCore('are_adjacent(loc(5,5), loc(7,5))').asInt()).toBe(0);
    const d = evalCore('direction_from(loc(5,5), \'n\', 2)');
    expect([d.getMember('x').asInt(), d.getMember('y').asInt()]).toEqual([5, 3]);
  });

  it('adjacent_locs, locations_in_radius, relative_dir, rotate_loc_around, nearest_loc', () => {
    expect(evalCore('size(adjacent_locs(loc(5,5)))').asInt()).toBe(6);
    expect(evalCore('size(locations_in_radius(loc(5,5), 2))').asInt()).toBe(19);
    expect(evalCore('relative_dir(loc(5,5), loc(5,2))').asString()).toBe('n');
    const r = evalCore('rotate_loc_around(loc(5,5), loc(5,4), 3)');
    expect([r.getMember('x').asInt(), r.getMember('y').asInt()]).toEqual([5, 6]);
    const n = evalCore('nearest_loc(loc(1,1), [loc(9,9), loc(2,2), loc(5,5)])');
    expect([n.getMember('x').asInt(), n.getMember('y').asInt()]).toEqual([2, 2]);
  });
});

describe('self, and the board functions', () => {
  const terrainData = loadTerrainData();
  const moveType = flatMoveType(terrainData, 40);
  const setup = () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('fighter', 30, moveType, makeWeapon(5, 2));
    const thief = Unit.create(type, 1, Location.fromWml(3, 3));
    const target = Unit.create(type, 2, Location.fromWml(4, 3));
    const flanker = Unit.create(type, 1, Location.fromWml(5, 4));
    for (const u of [thief, target, flanker]) board.addUnit(u);
    return { board, thief, target, flanker };
  };

  it('self in a unit formula is the unit', () => {
    const { board, thief } = setup();
    const v = parseFormula('self.side', gameStateSymbols(board)).evaluate(unitFormulaContext(thief));
    expect(v.asInt()).toBe(1);
  });

  it('enemy_of compares sides, by unit or number', () => {
    const { board, thief, target } = setup();
    const symbols = gameStateSymbols(board);
    const ctx = unitFormulaContext(target, target.location, thief);
    expect(parseFormula('enemy_of(self, other)', symbols).evaluate(ctx).asInt()).toBe(1);
    expect(parseFormula('enemy_of(1, 1)', symbols).evaluate(ctx).asInt()).toBe(0);
    expect(parseFormula('enemy_of(1, 7)', symbols).evaluate(ctx).asInt()).toBe(0);
  });

  it("backstab's formula: an enemy of the target behind it, facing the attacker", () => {
    const { board, thief, target, flanker } = setup();
    const backstab = parseConfig(
      'formula="enemy_of(self, flanker) and not flanker.petrified where flanker = unit_at(direction_from(loc, other.facing))"',
    );
    // The attacker faces the target (south-east from 3,3 to 4,3), so the hex behind the target is 5,4.
    thief.facing = Direction.SouthEast;
    expect(unitMatchesFilter(target, backstab, board, { other: thief })).toBe(true);
    board.removeUnitAt(flanker.location);
    expect(unitMatchesFilter(target, backstab, board, { other: thief })).toBe(false);
  });

  it('defense_on and chance_to_hit read the unit on that hex\'s terrain', () => {
    const { board, thief } = setup();
    const symbols = gameStateSymbols(board);
    const ctx = new MapFormulaCallable().add('u', Variant.callable(unitFormulaContext(thief).getValue('self').asCallable()));
    expect(parseFormula('defense_on(u, loc(3,3))', symbols).evaluate(ctx).asInt()).toBe(60);
    expect(parseFormula('chance_to_hit(u, loc(3,3))', symbols).evaluate(ctx).asInt()).toBe(40);
  });
});
