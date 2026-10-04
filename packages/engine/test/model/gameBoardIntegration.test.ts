import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWml,
  parseWmlFile,
  preloadDefines,
  preloadDefinesFromDir,
  type DefineMap,
} from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData, GRASS_LAND, SHALLOW_WATER } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { distanceBetween } from '../../src/model/Location.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';

/**
 * Real-content integration test: load Dead_Water scenario 1's actual map
 * file and [side] data into a GameBoard. Mirrors the WML pipeline's own
 * Dead_Water integration test (see test/wml/deadWaterIntegration.test.ts)
 * for the macro-flag setup, since both need the same preprocessed content.
 *
 * Deliberately out of scope here: loading the REAL unit-type database.
 * (This IS now implemented -- see `model/UnitTypeDatabase.ts` and its own
 * real-content tests in `test/model/UnitTypeDatabase.test.ts` -- but this
 * test's own scope is narrower: proving `GameBoard`'s wiring, not unit-type
 * stats.) So `resolveType` below is a permissive stub returning a
 * minimal-but-real-shaped UnitType for any id, which is enough to prove
 * GameBoard's own wiring (map + sides + every [unit] in the tree, including
 * ones nested in [event] blocks) is correct, independent of what stats any
 * particular type has.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const campaignDir = path.join(dataRoot, 'campaigns/Dead_Water');

function loadDefines(): DefineMap {
  const defines: DefineMap = new Map();
  const flag = (name: string) =>
    defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<test>' });
  flag('CAMPAIGN_DEAD_WATER');
  flag('NORMAL');
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot });
  return defines;
}

function loadTerrainData(defines: DefineMap): TerrainTypeData {
  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), {
    dataRoot,
    defines: new Map(defines),
  });
  return TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));
}

function makeStubResolveType(terrainData: TerrainTypeData): (id: string) => UnitType {
  const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
  const attack = AttackType.fromConfig(new WmlConfig());
  const cache = new Map<string, UnitType>();
  return (id: string) => {
    let type = cache.get(id);
    if (!type) {
      type = new UnitType(
        id,
        id,
        '',
        'neutral',
        1,
        30,
        5,
        5,
        0,
        1,
        0,
        -1,
        500,
        [],
        '',
        true,
        false,
        false,
        moveType,
        [attack],
        [],
      );
      cache.set(id, type);
    }
    return type;
  };
}

describe('GameBoard (real Dead_Water scenario 1 content)', () => {
  const defines = loadDefines();

  it('loads the real terrain database from data/core/terrain.cfg', () => {
    const terrainData = loadTerrainData(defines);
    expect(terrainData.isKnown(GRASS_LAND)).toBe(true);
    expect(terrainData.isKnown(SHALLOW_WATER)).toBe(true);
  });

  it('loads the real map file and real [side]/[unit] scenario data into one GameBoard', () => {
    const terrainData = loadTerrainData(defines);
    const resolveType = makeStubResolveType(terrainData);

    const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), {
      dataRoot,
      defines: new Map(defines),
    });
    const scenario = scenarioCfg.child('scenario')!;

    // map_file= resolution is a resource-loading concern, not the data
    // model's (see Map.ts's module doc comment) -- read it here and splice
    // it in as map_data ourselves, the way a real scenario loader would.
    const mapText = fs.readFileSync(path.join(campaignDir, 'maps', scenario.getString('map_file')), 'utf8');
    scenario.setAttribute('map_data', mapText);

    const board = GameBoard.fromConfig(scenario, terrainData, resolveType);

    // Home_1.map's raw text is 45 comma-separated columns x 29 lines --
    // that's totalWidth()/totalHeight() (includes the map file's own
    // embedded 1-tile border). w()/h() are the playable area excluding it.
    expect(board.map.totalWidth()).toBe(45);
    expect(board.map.totalHeight()).toBe(29);
    expect(board.map.w()).toBe(43);
    expect(board.map.h()).toBe(27);

    // Two real sides, matching the WML-level test.
    const teams = board.teams();
    expect(teams.map((t) => t.side)).toEqual([1, 2]);
    expect(teams[0]!.controller).toBe('human');
    expect(teams[0]!.gold).toBeGreaterThan(0);

    // 13 raw [unit] tags in the tree (matching the WML pipeline's own
    // count) + 2 inline [side] leaders (Kai Krellis, Mal-Kevek -- neither
    // has x=/y=, both rely on the map's marked starting position, see
    // GameBoard.fromConfig) = 15 candidates, minus two GameBoard correctly
    // can't resolve without Phase 2 (the rules engine/event pump):
    //  - one [unit] uses runtime WML variables for its location
    //    (x="$x1" y="$y1", a scripted "raise the last kill as a zombie"
    //    effect) that only get real values when its [event] actually fires;
    //  - two other [unit]s from DIFFERENT [event]s (a turn-N reinforcement
    //    and a scripted spawn) happen to name the same hex, since nothing
    //    here knows those events fire at different times -- without an
    //    event pump, "load every [unit] found anywhere in the tree" can't
    //    distinguish "present at scenario start" from "spawned later," so
    //    two static units collide in Map-keyed board storage and only one
    //    survives. Both gaps are inherent to not having Phase 2 yet, not
    //    bugs in this loader -- revisit once the event pump exists.
    expect(board.allUnits().length).toBe(13);
    const leader = board.allUnits().find((u) => u.id === 'Kai Krellis');
    expect(leader).toBeDefined();
    expect(leader!.canRecruit).toBe(true);
    expect(leader!.side).toBe(1);
    expect(leader!.location.valid()).toBe(true);

    const enemyLeader = board.allUnits().find((u) => u.id === 'Mal-Kevek');
    expect(enemyLeader).toBeDefined();
    expect(enemyLeader!.side).toBe(2);
    expect(enemyLeader!.location.valid()).toBe(true);
    expect(enemyLeader!.location.equals(leader!.location)).toBe(false);

    // Every placed unit should sit on a valid board hex.
    for (const unit of board.allUnits()) {
      expect(unit.location.valid(board.map.w(), board.map.h(), GameMap.DEFAULT_BORDER)).toBe(true);
    }

    // Real village count on Home_1.map -- matches
    // `carryover.test.ts`'s independently-confirmed "31 real villages".
    expect(board.map.villages.length).toBe(31);
    // Some of side 1's real starting [unit]s happen to be placed on
    // villages in this scenario (merfolk scattered near their home reef);
    // `GameBoard.fromConfig` captures those on initial placement, mirroring
    // real `unit_creator`'s default `allow_get_village=true` -- so this
    // should be some, but not all, of the 31 real villages, and none for
    // side 2 (Mal-Kevek's undead start away from any village here).
    const capturedByOne = board.villageCount(1);
    expect(capturedByOne).toBeGreaterThan(0);
    expect(capturedByOne).toBeLessThan(board.map.villages.length);
    expect(board.villageCount(2)).toBe(0);
    const unownedVillages = board.map.villages.filter((v) => board.villageOwner(v) === undefined);
    expect(unownedVillages.length).toBe(board.map.villages.length - capturedByOne);

    // `terrainName` (for the UI's "current terrain" display, see
    // packages/ui) resolves real `[terrain_type] name=` text, and is
    // village-aware (a village hex's overlay name wins over the base
    // grassland/sand it sits on) -- both spot-checked against real
    // Home_1.map content.
    expect(board.map.terrainName(leader!.location).length).toBeGreaterThan(0);
    expect(board.map.terrainName(board.map.villages[0]!)).toMatch(/[Vv]illage/);
  });
});

describe('GameBoard.fromConfig: [side][leader] (team_builder::handle_leader)', () => {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const resolveType = makeStubResolveType(terrainData);
  const scenario = parseWml(`
[scenario]
    map_data="Gg, Gg, Gg, Gg, Gg, Gg
Gg, 1 Gg, Gg, Gg, Gg, Gg
Gg, Gg, Gg, Gg, Gg, Gg
Gg, Gg, Gg, 2 Gg, Gg, Gg
Gg, Gg, Gg, Gg, Gg, Gg
Gg, Gg, Gg, Gg, Gg, Gg"
    [side]
        side=1
        type=Elvish Captain
        id=Glildur
        [leader]
            type=Elvish Fighter
            id=leader2
            x,y=4,1
        [/leader]
    [/side]
    [side]
        side=2
        [leader]
            type=Orcish Warrior
            id=Gorlack
        [/leader]
        [leader]
            type=Orcish Grunt
            id=second
            canrecruit=no
        [/leader]
    [/side]
[/scenario]`).child('scenario')!;
  const board = GameBoard.fromConfig(scenario, terrainData, resolveType);
  const byId = (id: string) => board.allUnits().find((u) => u.id === id);

  it('creates each [leader] as a recruiting unit of its side, at its x,y', () => {
    expect(byId('leader2')).toMatchObject({ side: 1, canRecruit: true });
    expect([byId('leader2')!.location.wmlX, byId('leader2')!.location.wmlY]).toEqual([4, 1]);
    expect(byId('Glildur')?.canRecruit).toBe(true);
  });

  it("puts one with no x,y on the side's starting position, the next on the nearest free hex", () => {
    expect(byId('Gorlack')!.location.equals(board.map.startingPosition(2))).toBe(true);
    expect(byId('Gorlack')?.side).toBe(2);
    const second = byId('second')!;
    expect(second.canRecruit).toBe(false);
    expect(distanceBetween(second.location, byId('Gorlack')!.location)).toBe(1);
  });

  it('puts a leader with no hex for it (no x,y, no starting position) on the recall list', () => {
    const noStart = parseWml(`
[scenario]
    map_data="Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg"
    [side]
        side=1
        type=Fighter
        id=Konrad
        canrecruit=yes
    [/side]
[/scenario]`).child('scenario')!;
    const b = GameBoard.fromConfig(noStart, terrainData, resolveType);
    expect(b.allUnits()).toHaveLength(0);
    expect(b.recallList(1).map((u) => u.id)).toEqual(['Konrad']);
  });
});
