import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { performMove } from '../../src/actions/moveSequence.js';

/**
 * `performMove` (Phase 29's shared move/attack choreography extraction --
 * see its own module doc comment) event-order tests, mirroring
 * `attackSequence.test.ts`'s rationale: this is the piece `GameSession.
 * moveSelectedTo` (human) and the real AI's move actions (Phase 29, later)
 * both go through, closing a real gap (the Phase 7 heuristic AI's
 * `executeMove` calls never raised `capture`/`moveto` at all).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadTerrainData(): TerrainTypeData {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines });
  return TerrainTypeData.fromConfigs(cfg.children('terrain_type'));
}

/** Real terrain ids (see simpleAi.test.ts's own note on why this keys by id, not by the map's raw code). */
function flatMoveType(terrainData: TerrainTypeData): MoveType {
  const cfg = new WmlConfig();
  const defense = cfg.addChild('defense');
  defense.setAttribute('flat', 50);
  const movementCosts = cfg.addChild('movement_costs');
  movementCosts.setAttribute('flat', 1);
  return MoveType.fromConfig(cfg, terrainData);
}

function makeUnitType(terrainData: TerrainTypeData): UnitType {
  return new UnitType('walker', 'walker', '', 'neutral', 1, 20, 5, 5, 0, 1, 10, -1, 500, [], '', false, false, false, flatMoveType(terrainData), [], []);
}

/** A 5x5 raw grassland grid (3x3 playable) with a real village overlay at logical (1,1) -- see makeBoard's own doc. */
function makeBoard(terrainData: TerrainTypeData): GameBoard {
  const rows = ['Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg^Vh, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg'];
  const board = new GameBoard(GameMap.fromMapString(rows.join('\n'), terrainData));
  board.addTeam(new Team(1));
  board.addTeam(new Team(2));
  return board;
}

describe('performMove event ordering', () => {
  it('raises capture then moveto (in that order) when the final hex is a real, not-already-owned village', () => {
    const terrainData = loadTerrainData();
    const board = makeBoard(terrainData);
    expect(board.map.isVillage(new Location(1, 1))).toBe(true); // sanity: the real terrain data does classify ^Vh as a village
    const unit = Unit.create(makeUnitType(terrainData), 1, new Location(0, 1));
    board.addUnit(unit);

    const events: Array<{ name: string; loc1: Location; loc2: Location }> = [];
    const { result, captured, moved } = performMove(board, unit, [new Location(0, 1), new Location(1, 1)], {
      raise: (name, loc1, loc2) => events.push({ name, loc1, loc2 }),
    });

    expect(result.enteredVillage).toBe(true);
    expect(moved).toBe(true);
    expect(captured).toBe(true);
    expect(events.map((e) => e.name)).toEqual(['capture', 'moveto']);
    expect(board.villageOwner(new Location(1, 1))).toBe(1);
  });

  it('raises only moveto (no capture) when the final hex is not a village', () => {
    const terrainData = loadTerrainData();
    const board = makeBoard(terrainData);
    const unit = Unit.create(makeUnitType(terrainData), 1, new Location(0, 0));
    board.addUnit(unit);

    const events: string[] = [];
    const { captured, moved } = performMove(board, unit, [new Location(0, 0), new Location(1, 0)], {
      raise: (name) => events.push(name),
    });

    expect(moved).toBe(true);
    expect(captured).toBe(false);
    expect(events).toEqual(['moveto']);
  });

  it('raises nothing when the unit already owns the village it moves onto', () => {
    const terrainData = loadTerrainData();
    const board = makeBoard(terrainData);
    const unit = Unit.create(makeUnitType(terrainData), 1, new Location(0, 1));
    board.addUnit(unit);
    board.captureVillage(new Location(1, 1), 1); // already ours

    const events: string[] = [];
    const { captured } = performMove(board, unit, [new Location(0, 1), new Location(1, 1)], {
      raise: (name) => events.push(name),
    });

    expect(captured).toBe(false);
    expect(events).toEqual(['moveto']);
  });

  it('raises nothing for a zero-length move (already at the requested hex / no movement points)', () => {
    const terrainData = loadTerrainData();
    const board = makeBoard(terrainData);
    const unit = Unit.create(makeUnitType(terrainData), 1, new Location(0, 0));
    unit.movesLeft = 0;
    board.addUnit(unit);

    const events: string[] = [];
    const { moved, result } = performMove(board, unit, [new Location(0, 0), new Location(1, 0)], {
      raise: (name) => events.push(name),
    });

    expect(result.path).toHaveLength(1);
    expect(moved).toBe(false);
    expect(events).toEqual([]);
  });

  it('with no raise callback given, still resolves the move correctly (raise is optional)', () => {
    const terrainData = loadTerrainData();
    const board = makeBoard(terrainData);
    const unit = Unit.create(makeUnitType(terrainData), 1, new Location(0, 0));
    board.addUnit(unit);
    expect(() => performMove(board, unit, [new Location(0, 0), new Location(1, 0)])).not.toThrow();
    expect(unit.location.equals(new Location(1, 0))).toBe(true);
  });
});
