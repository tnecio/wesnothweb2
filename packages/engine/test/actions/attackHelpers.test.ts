/**
 * Phase 27c S4: `unit_attack`'s helpers -- the leader leading the striker, the neighbour resisting for the
 * struck one -- worked out as the fight starts, for both striking directions.
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../helpers/realContent.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { attackHelpers } from '../../src/actions/attackHelpers.js';

const real = loadRealContent();

function board(): GameBoard {
  const b = new GameBoard(real.map(['Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg']));
  b.addTeam(new Team(1, { teamName: 'one' }));
  b.addTeam(new Team(2, { teamName: 'two' }));
  return b;
}

function place(b: GameBoard, type: string, side: number, x: number, y: number): Unit {
  const u = Unit.create(real.unitType(type), side, new Location(x, y));
  b.addUnit(u);
  b.assignUnitId(u);
  return u;
}

describe('attackHelpers', () => {
  it("a Lieutenant beside the attacking Spearman leads its blows, facing it; nobody helps the Grunt's", () => {
    const b = board();
    const spear = place(b, 'Spearman', 1, 1, 1);
    const lieutenant = place(b, 'Lieutenant', 1, 1, 0);
    const grunt = place(b, 'Orcish Grunt', 2, 2, 1);
    const helpers = attackHelpers(b, spear, spear.attacks[0], grunt, grunt.attacks[0]);
    expect(helpers.attackerStrikes.map((h) => [h.unit, h.event, h.towards.x, h.towards.y])).toEqual([[lieutenant, 'leading', 1, 1]]);
    expect(helpers.attackerStrikes[0]!.typeId).toBe('Lieutenant');
    expect(helpers.defenderStrikes).toEqual([]);
  });

  it('a defender that does not strike back has no helpers of its own', () => {
    const b = board();
    const spear = place(b, 'Spearman', 1, 1, 1);
    place(b, 'Lieutenant', 1, 1, 0);
    const grunt = place(b, 'Orcish Grunt', 2, 2, 1);
    expect(attackHelpers(b, grunt, grunt.attacks[0], spear, undefined).defenderStrikes).toEqual([]);
  });
});
