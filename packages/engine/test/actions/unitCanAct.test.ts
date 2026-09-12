import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { unitCanAct } from '../../src/actions/unitCanAct.js';

/**
 * Real, reported bug (bugs3.md #5): a unit boxed in with nowhere left to
 * move, and no attack possible, showed the "partial" (yellow) moves-orb
 * instead of "moved" (red), because the orb logic only ever checked the
 * raw `movesLeft <= 0` counter. `unitCanAct` mirrors `display_context::
 * unit_can_move` -- see that module's own doc comment.
 *
 * Every map here is a 9x9 raw grid of plain grassland (except the
 * deep-water test) with units placed at/near the raw-coordinate center
 * (4,4) -- `GameMap.fromMapString`'s default 1-hex border shrinks a raw
 * NxN grid to an (N-2)x(N-2) *usable* area (`GameMap.w()`/`h()`), a lesson
 * already hit once before in this project (synthetic-campaigns map
 * fixes): a map with no real margin silently makes every outer ring
 * `onBoard() === false`, which would make several of these assertions
 * pass for the wrong reason (an off-board "enemy" is invisible/unreachable
 * regardless of the logic under test). 9x9 leaves a good 3-hex margin on
 * every side of the center, enough even for the ranged-weapon test below.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadTerrainData(): TerrainTypeData {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines });
  return TerrainTypeData.fromConfigs(cfg.children('terrain_type'));
}

/** Real `smallfoot` movetype (same real-content pattern as test/actions/move.test.ts) -- unlike a flat/empty MoveType, this actually resolves passable terrain costs, needed to exercise `canMove`'s real terrain-cost check. */
function loadRealMoveType(id: string, terrainData: TerrainTypeData): MoveType {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines });
  function walk({ tag, config }: { tag: string; config: WmlConfig }): WmlConfig[] {
    if (tag === 'movetype' && config.getString('name') === id) return [config];
    return config.allChildren().flatMap(walk);
  }
  const found = cfg.allChildren().flatMap(walk);
  if (!found[0]) throw new Error(`movetype ${id} not found`);
  return MoveType.fromConfig(found[0], terrainData);
}

function meleeAttack(): AttackType {
  const cfg = new WmlConfig().setAttribute('name', 'fist').setAttribute('range', 'melee').setAttribute('damage', 5).setAttribute('number', 2);
  return AttackType.fromConfig(cfg);
}

function makeUnitType(id: string, moveType: MoveType, movement = 5, attacks: AttackType[] = [meleeAttack()]): UnitType {
  return new UnitType(id, id, '', 'neutral', 1, 20, movement, movement, 0, 1, 0, -1, 32, [], '', false, false, false, moveType, attacks, []);
}

/**
 * A 9x9 raw grid (see module doc comment), every cell `fillCode` except any
 * `x,y` keys in `overrides` -- NOTE: `overrides` keys are raw TEXT
 * coordinates, which `GameMap.fromMapString`'s default 1-hex border shifts
 * by (1,1) relative to the *logical* (`onBoard`/`getTerrain`) coordinates
 * used everywhere else in this file (e.g. `CENTER_WML`, once converted via
 * `Location.fromWml`) -- so an override meant to land under the unit at
 * logical (x,y) needs the key `(x+1),(y+1)`.
 */
function gridMapText(fillCode: string, overrides: Map<string, string> = new Map()): string {
  const rows: string[] = [];
  for (let y = 0; y < 9; y++) {
    const cells: string[] = [];
    for (let x = 0; x < 9; x++) {
      cells.push(overrides.get(`${x},${y}`) ?? fillCode);
    }
    rows.push(cells.join(', '));
  }
  return rows.join('\n');
}

function makeBoard(mapText: string, terrainData: TerrainTypeData): GameBoard {
  const board = new GameBoard(GameMap.fromMapString(mapText, terrainData));
  board.addTeam(new Team(1, { teamName: 'side1' }));
  board.addTeam(new Team(2, { teamName: 'side2' })); // distinct teamName -- Team.isEnemy compares teamName, see that method's own doc comment.
  return board;
}

/** Raw-coordinate center of the 9x9 test grid, as WML (1-based) coordinates. */
const CENTER_WML = { x: 5, y: 5 };

describe('unitCanAct (display_context::unit_can_move)', () => {
  const terrainData = loadTerrainData();
  const moveType = loadRealMoveType('smallfoot', terrainData);
  const grassland = gridMapText('Gg');

  it('both false: no attacks and no moves left', () => {
    const board = makeBoard(grassland, terrainData);
    const type = makeUnitType('grunt', moveType);
    const unit = Unit.create(type, 1, Location.fromWml(CENTER_WML.x, CENTER_WML.y));
    unit.movesLeft = 0;
    unit.attacksLeft = 0;
    board.addUnit(unit);

    expect(unitCanAct(board, unit)).toEqual({ canMove: false, canAttackHere: false });
  });

  it('real, reported bug: an unspent attack does not make canAttackHere true when no enemy is in range -- movesLeft=0 too, so the unit is genuinely stuck', () => {
    const board = makeBoard(grassland, terrainData);
    const type = makeUnitType('grunt', moveType);
    const unit = Unit.create(type, 1, Location.fromWml(CENTER_WML.x, CENTER_WML.y));
    unit.movesLeft = 0;
    unit.attacksLeft = 1; // nominally available, but nothing to use it on
    board.addUnit(unit);

    expect(unitCanAct(board, unit)).toEqual({ canMove: false, canAttackHere: false });
  });

  it('canMove true: an adjacent hex is within movement range, even with 0 attacks left', () => {
    const board = makeBoard(grassland, terrainData);
    const type = makeUnitType('grunt', moveType);
    const unit = Unit.create(type, 1, Location.fromWml(CENTER_WML.x, CENTER_WML.y));
    unit.movesLeft = 1;
    unit.attacksLeft = 0;
    board.addUnit(unit);

    expect(unitCanAct(board, unit)).toEqual({ canMove: true, canAttackHere: false });
  });

  it('canMove false: every adjacent hex is deep water, unreachable for a land movetype', () => {
    const board = makeBoard(gridMapText('Wo', new Map([['5,5', 'Gg']])), terrainData); // "Wo" = real deep water code; text (5,5) == logical CENTER_WML once border-shifted
    const type = makeUnitType('grunt', moveType); // smallfoot: deep water is UNREACHABLE (99)
    const unit = Unit.create(type, 1, Location.fromWml(CENTER_WML.x, CENTER_WML.y));
    unit.movesLeft = 5;
    unit.attacksLeft = 0;
    board.addUnit(unit);

    expect(unitCanAct(board, unit).canMove).toBe(false);
  });

  it('canAttackHere true: a living, visible enemy is adjacent and attacksLeft > 0', () => {
    const board = makeBoard(grassland, terrainData);
    const type = makeUnitType('grunt', moveType);
    const unit = Unit.create(type, 1, Location.fromWml(CENTER_WML.x, CENTER_WML.y));
    unit.movesLeft = 0;
    unit.attacksLeft = 1;
    board.addUnit(unit);
    const enemy = Unit.create(type, 2, Location.fromWml(CENTER_WML.x + 1, CENTER_WML.y));
    board.addUnit(enemy);

    expect(unitCanAct(board, unit)).toEqual({ canMove: false, canAttackHere: true });
  });

  it('canAttackHere false: the adjacent enemy is incapacitated (petrified)', () => {
    const board = makeBoard(grassland, terrainData);
    const type = makeUnitType('grunt', moveType);
    const unit = Unit.create(type, 1, Location.fromWml(CENTER_WML.x, CENTER_WML.y));
    unit.movesLeft = 0;
    unit.attacksLeft = 1;
    board.addUnit(unit);
    const enemy = Unit.create(type, 2, Location.fromWml(CENTER_WML.x + 1, CENTER_WML.y));
    enemy.setStatus('petrified', true);
    board.addUnit(enemy);

    expect(unitCanAct(board, unit).canAttackHere).toBe(false);
  });

  it('canAttackHere false: attacksLeft is 0, even with an adjacent enemy', () => {
    const board = makeBoard(grassland, terrainData);
    const type = makeUnitType('grunt', moveType);
    const unit = Unit.create(type, 1, Location.fromWml(CENTER_WML.x, CENTER_WML.y));
    unit.movesLeft = 1; // still has moves, so the early "both exhausted" shortcut doesn't trigger
    unit.attacksLeft = 0;
    board.addUnit(unit);
    const enemy = Unit.create(type, 2, Location.fromWml(CENTER_WML.x + 1, CENTER_WML.y));
    board.addUnit(enemy);

    expect(unitCanAct(board, unit)).toEqual({ canMove: true, canAttackHere: false });
  });

  it("canAttackHere respects a ranged weapon's real min_range/max_range: an enemy 2 hexes away is in range for a 2-3 range weapon, not for melee", () => {
    const board = makeBoard(grassland, terrainData);
    const rangedCfg = new WmlConfig()
      .setAttribute('name', 'catapult')
      .setAttribute('range', 'ranged')
      .setAttribute('min_range', 2)
      .setAttribute('max_range', 3)
      .setAttribute('damage', 5)
      .setAttribute('number', 1);
    const type = makeUnitType('siege', moveType, 5, [AttackType.fromConfig(rangedCfg)]);
    const unit = Unit.create(type, 1, Location.fromWml(CENTER_WML.x, CENTER_WML.y));
    unit.movesLeft = 0;
    unit.attacksLeft = 1;
    board.addUnit(unit);
    const enemy = Unit.create(type, 2, Location.fromWml(CENTER_WML.x + 2, CENTER_WML.y)); // distance 2
    board.addUnit(enemy);

    expect(unitCanAct(board, unit).canAttackHere).toBe(true);
  });
});
