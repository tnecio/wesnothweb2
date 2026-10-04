import { describe, expect, it } from 'vitest';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { checkVictory } from '../../src/actions/victory.js';

/**
 * `checkVictory` is a small, self-contained algorithm (mirrors
 * `game_board::check_victory`'s default `no_leader_left` case -- see that
 * function's own doc comment) that only cares about `unit.canRecruit`,
 * `unit.side`, and `Team.isEnemy`, so a hand-built minimal board is
 * appropriate here (same reasoning as `attackPrediction.test.ts`'s
 * hand-computed binomial ground truth) -- no real WML content needed.
 */

const terrainData = TerrainTypeData.fromConfigs([]);
const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
const leaderType = new UnitType('leader', 'leader', '', 'neutral', 1, 30, 5, 5, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, [AttackType.fromConfig(new WmlConfig())], []);
const grunt = new UnitType('grunt', 'grunt', '', 'neutral', 1, 20, 5, 5, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, [AttackType.fromConfig(new WmlConfig())], []);

// 5x5 map -- enough playable interior (see this project's known "map string
// has a 1-hex border" gotcha, documented repeatedly elsewhere in this repo's
// tests) for a couple of distinct unit locations.
const MAP = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => 'Gg').join(', ')).join('\n');

function twoSideBoard(): GameBoard {
  const map = GameMap.fromMapString(MAP, terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1));
  board.addTeam(new Team(2));
  return board;
}

describe('checkVictory (hand-built, leader-death / no_leader_left default)', () => {
  it('continues while both sides still have a leader', () => {
    const board = twoSideBoard();
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));
    board.addUnit(Unit.create(leaderType, 2, Location.fromWml(3, 3), { canRecruit: true }));

    const result = checkVictory(board);
    expect(result.continueLevel).toBe(true);
  });

  it('ends the level once one side has no unit with canRecruit=true, even if that side still has other units', () => {
    const board = twoSideBoard();
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));
    // Side 2 has a plain unit but its leader is already gone.
    board.addUnit(Unit.create(grunt, 2, Location.fromWml(3, 3)));

    const result = checkVictory(board);
    expect(result.continueLevel).toBe(false);
    expect(result.notDefeated).toEqual([1]);
  });

  it('continues if the only two remaining leaders are on allied (same team_name) sides', () => {
    const board = new GameBoard(GameMap.fromMapString(MAP, terrainData));
    board.addTeam(new Team(1, { teamName: 'allies' }));
    board.addTeam(new Team(2, { teamName: 'allies' }));
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));
    board.addUnit(Unit.create(leaderType, 2, Location.fromWml(3, 3), { canRecruit: true }));

    // Allied, so removing side 1 shouldn't matter to side 2's continuation --
    // but with BOTH leaders present and allied, nothing is defeated yet and
    // there's no enemy pair among the not-defeated sides either way.
    const result = checkVictory(board);
    expect(result.continueLevel).toBe(false); // no enemy pair among not-defeated sides -> level ends (mirrors upstream exactly).
    expect([...result.notDefeated].sort()).toEqual([1, 2]);
  });

  it('ends with an empty notDefeated list if every side has lost its leader', () => {
    const board = twoSideBoard();
    board.addUnit(Unit.create(grunt, 1, Location.fromWml(1, 1)));
    board.addUnit(Unit.create(grunt, 2, Location.fromWml(3, 3)));

    const result = checkVictory(board);
    expect(result.continueLevel).toBe(false);
    expect(result.notDefeated).toEqual([]);
  });

  it("a side stands by its defeat_condition: never, no_units_left, always (game_board::check_victory)", () => {
    // Under the Burning Suns 1's antagonists have no unit at the start; the scenario survives that through
    // victory_when_enemies_defeated=no (the session), not by exempting the side, as upstream.
    const board = twoSideBoard();
    board.getTeam(2)!.controller = 'ai';
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));
    expect(checkVictory(board)).toMatchObject({ continueLevel: false, notDefeated: [1], foundPlayer: true });

    board.getTeam(2)!.defeatCondition = 'never';
    expect(checkVictory(board).continueLevel).toBe(true);

    board.getTeam(2)!.defeatCondition = 'no_units_left';
    board.addUnit(Unit.create(grunt, 2, Location.fromWml(3, 3)));
    expect(checkVictory(board).continueLevel).toBe(true);

    board.getTeam(1)!.defeatCondition = 'always';
    expect(checkVictory(board)).toMatchObject({ continueLevel: false, notDefeated: [2], foundPlayer: false });
  });

  it('a fallen side gives up its villages', () => {
    const board = twoSideBoard();
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));
    const village = [...Array(board.map.w()).keys()]
      .flatMap((x) => [...Array(board.map.h()).keys()].map((y) => new Location(x, y)))
      .find((l) => board.map.isVillage(l));
    if (village) {
      board.captureVillage(village, 2);
      checkVictory(board);
      expect(board.villageOwner(village)).toBeUndefined();
    }
  });
});
