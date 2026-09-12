import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Location } from '../../src/model/Location.js';
import { Unit, UnitStatus } from '../../src/model/Unit.js';
import { UnitType, type RegistryEntry } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { Schedule } from '../../src/model/Schedule.js';
import { illuminatedLawfulBonus, effectiveTimeOfDayAt } from '../../src/actions/illumination.js';
import { parseWml } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';

/** `[illuminates]` (`tod_manager::get_illuminated_time_of_day`) on a flat 5x5 raw grid (logical 0..2). */
const flatMoveType = MoveType.fromConfig(parseWml(''), TerrainTypeData.fromConfigs([]));

function makeBoard(): GameBoard {
  const map = GameMap.fromMapString(Array.from({ length: 5 }, () => 'Gg, Gg, Gg, Gg, Gg').join('\n'), TerrainTypeData.fromConfigs([]));
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { teamName: 'a' }));
  board.addTeam(new Team(2, { teamName: 'b' }));
  return board;
}

function illuminatesAbility(body = ''): RegistryEntry {
  const cfg = parseWml(`[illuminates]\nid=illumination\nvalue=25\nmax_value=25\ncumulative=no\naffect_self=yes\n${body}\n[/illuminates]`);
  return { tag: 'illuminates', config: cfg.child('illuminates')! };
}

function makeType(id: string, abilities: RegistryEntry[] = []): UnitType {
  return new UnitType(id, id, '', 'neutral', 1, 20, 5, 5, 0, 1, 1, -1, 32, [], '', false, false, false, flatMoveType, [], abilities);
}

function place(board: GameBoard, type: UnitType, side: number, loc: Location): Unit {
  const unit = Unit.create(type, side, loc);
  board.addUnit(unit);
  return unit;
}

describe('illuminatedLawfulBonus (real ABILITY_ILLUMINATES: value=25, max_value=25, no radius=)', () => {
  it('is a no-op with no illuminating unit nearby', () => {
    const board = makeBoard();
    expect(illuminatedLawfulBonus(board, new Location(0, 0), -50)).toBe(-50);
  });

  it('shifts a hex adjacent to the illuminator toward +25, clamped there (never past it)', () => {
    const board = makeBoard();
    place(board, makeType('lantern-bearer', [illuminatesAbility()]), 1, new Location(1, 1));
    // (1,0) is adjacent to (1,1).
    expect(illuminatedLawfulBonus(board, new Location(1, 0), -50)).toBe(-25); // -50 shifted by +25.
  });

  it('never darkens a hex that is already brighter than the bonus would push it', () => {
    const board = makeBoard();
    place(board, makeType('lantern-bearer', [illuminatesAbility()]), 1, new Location(1, 1));
    expect(illuminatedLawfulBonus(board, new Location(1, 0), 40)).toBe(40); // already above the +25 target -- bounded_add never pulls it down.
  });

  it('defaults radius to 1 (adjacent only) when radius= is absent, matching every real definition', () => {
    const board = makeBoard();
    place(board, makeType('lantern-bearer', [illuminatesAbility()]), 1, new Location(0, 0));
    expect(illuminatedLawfulBonus(board, new Location(2, 0), -50)).toBe(-50); // distance 2, out of range.
  });

  it('radius=all_map reaches anywhere on the board', () => {
    const board = makeBoard();
    place(board, makeType('sun', [illuminatesAbility('radius=all_map')]), 1, new Location(0, 0));
    expect(illuminatedLawfulBonus(board, new Location(4, 4), -50)).toBe(-25);
  });

  it('affect_self=no is not part of any real definition, but is honoured if authored', () => {
    const board = makeBoard();
    place(board, makeType('dark-lantern', [illuminatesAbility('affect_self=no')]), 1, new Location(0, 0));
    expect(illuminatedLawfulBonus(board, new Location(0, 1), -50)).toBe(-50);
  });

  it('an incapacitated (petrified) illuminator contributes nothing', () => {
    const board = makeBoard();
    const u = place(board, makeType('lantern-bearer', [illuminatesAbility()]), 1, new Location(1, 1));
    u.setStatus(UnitStatus.Petrified, true);
    expect(illuminatedLawfulBonus(board, new Location(1, 0), -50)).toBe(-50);
  });

  it('two illuminators in range both shift the result toward the brighter of their bounds', () => {
    const board = makeBoard();
    place(board, makeType('a', [illuminatesAbility()]), 1, new Location(1, 0));
    place(board, makeType('b', [illuminatesAbility()]), 2, new Location(1, 2));
    // (1,1) is adjacent to both.
    expect(illuminatedLawfulBonus(board, new Location(1, 1), -50)).toBe(-25);
  });
});

describe('effectiveTimeOfDayAt (Schedule.timeOfDayAt + illumination combined)', () => {
  it('applies the schedule value first, then illumination on top', () => {
    const scenario = new WmlConfig();
    const t = new WmlConfig();
    t.setAttribute('id', 'night');
    t.setAttribute('name', 'Night');
    t.setAttribute('image', '');
    t.setAttribute('lawful_bonus', -50);
    scenario.addChild('time', t);
    const schedule = Schedule.fromScenarioConfig(scenario);

    const board = makeBoard();
    const loc = new Location(1, 0);
    place(board, makeType('lantern-bearer', [illuminatesAbility()]), 1, new Location(1, 1));

    const tod = effectiveTimeOfDayAt(board, schedule, 1, loc);
    expect(tod.id).toBe('night');
    expect(tod.lawfulBonus).toBe(-25);

    const farLoc = new Location(4, 4);
    expect(effectiveTimeOfDayAt(board, schedule, 1, farLoc).lawfulBonus).toBe(-50);
  });
});
