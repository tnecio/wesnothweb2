import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefines, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import {
  computeGoldCarryover,
  findVictoryEndlevelGoldConfig,
  computeCarryoverRecruits,
  findSideConfig,
  BASE_INCOME,
  DEFAULT_CARRYOVER_PERCENTAGE,
} from '../../src/actions/carryover.js';

/**
 * `computeGoldCarryover` is hand-verified against real Dead Water scenario 1
 * numbers below (see that `it()`'s own comment for the hand computation).
 * `findVictoryEndlevelGoldConfig`/`computeCarryoverRecruits` are checked
 * both against hand-built configs (documenting exactly what shape they
 * expect) and against the real, unmodified `01_Invasion.cfg`/`02_Flight.cfg`
 * content (same real-content-over-hand-rolled-stand-ins discipline as
 * `deadWaterPrestartEvent.test.ts`).
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

describe('computeGoldCarryover (exact formula, see carryover.ts module doc comment)', () => {
  it('matches a hand computation using Dead Water scenario 1\'s real numbers', () => {
    // Real numbers, checked directly against the actual submodule content:
    //  - Home_1.map (Dead Water scenario 1's real map) has 31 real village
    //    hexes total (counted via a real GameMap.villages load -- every
    //    hex whose terrain_type has gives_income=true, unfiltered by
    //    ownership, exactly matching upstream's `wesnoth.map.find{gives_income=true}`).
    //  - 01_Invasion.cfg's [side side=1] sets no income= (Team default 0)
    //    and no village_gold= (Team default 1, matching game_config::village_income's
    //    real default of 1 in wesnoth/src/game_config.cpp).
    //  - {TURNS4 32 30 28 26} -> NORMAL difficulty's turns=30 (wesnoth/data/core/macros/utils.cfg's QUANTITY4).
    //  - 02_Flight.cfg's [side side=1] sets {GOLD4 150 140 130 120} -> NORMAL's declared starting gold = 140.
    //  - 01_Invasion.cfg's real [event name="enemies defeated"][endlevel] sets
    //    result=victory bonus=yes {NEW_GOLD_CARRYOVER 40}, which expands
    //    (carryover-utils.cfg) to carryover_add=yes carryover_percentage=40.
    //
    // Hand computation for a hypothetical victory at turn 5 with 150 gold on hand:
    //   finishingBonusPerTurn = 31 * 1 + (0 + 2) = 33
    //   turnsLeft             = max(0, 30 - 5) = 25
    //   finishingBonus        = ceil(1 * 33 * 25) = ceil(825) = 825
    //   carryoverGoldValue    = ceil((150 + 825) * 40 / 100) = ceil(390) = 390
    //   nextScenarioGold      = carryoverAdd=true -> 140 + 390 = 530
    const result = computeGoldCarryover({
      teamGold: 150,
      teamIncome: 0,
      incomePerVillage: 1,
      totalVillages: 31,
      scenarioTurnsLimit: 30,
      turnNumberAtVictory: 5,
      endlevel: { bonus: true, carryoverAdd: true, carryoverPercentage: 40 },
      nextScenarioDeclaredGold: 140,
    });
    expect(result.finishingBonusPerTurn).toBe(33);
    expect(result.turnsLeft).toBe(25);
    expect(result.finishingBonus).toBe(825);
    expect(result.carryoverGoldValue).toBe(390);
    expect(result.nextScenarioGold).toBe(530);
  });

  it('uses max(carryoverGoldValue, declaredGold), not addition, when carryover_add is false', () => {
    // Same inputs as above but carryover_add=false: carryoverGoldValue is
    // still 390 (the percentage-of-total math doesn't change), but the next
    // scenario's gold is now max(390, 140) = 390, not 140 + 390.
    const result = computeGoldCarryover({
      teamGold: 150,
      teamIncome: 0,
      incomePerVillage: 1,
      totalVillages: 31,
      scenarioTurnsLimit: 30,
      turnNumberAtVictory: 5,
      endlevel: { bonus: true, carryoverAdd: false, carryoverPercentage: 40 },
      nextScenarioDeclaredGold: 140,
    });
    expect(result.carryoverGoldValue).toBe(390);
    expect(result.nextScenarioGold).toBe(390);

    // And when the computed value is smaller than the declared minimum, the
    // declared minimum wins.
    const result2 = computeGoldCarryover({
      teamGold: 0,
      teamIncome: 0,
      incomePerVillage: 1,
      totalVillages: 31,
      scenarioTurnsLimit: 30,
      turnNumberAtVictory: 5,
      endlevel: { bonus: false, carryoverAdd: false, carryoverPercentage: 40 },
      nextScenarioDeclaredGold: 140,
    });
    expect(result2.finishingBonus).toBe(0); // bonus=no zeroes the finishing bonus regardless of turnsLeft.
    expect(result2.carryoverGoldValue).toBe(0); // ceil((0 + 0) * 40 / 100)
    expect(result2.nextScenarioGold).toBe(140); // max(0, 140)
  });

  it('treats an unlimited scenario (scenarioTurnsLimit null) as turnsLeft=0, mirroring carryover_gold.lua\'s turns_left()', () => {
    const result = computeGoldCarryover({
      teamGold: 100,
      teamIncome: 0,
      incomePerVillage: 1,
      totalVillages: 10,
      scenarioTurnsLimit: null,
      turnNumberAtVictory: 3,
      endlevel: { bonus: true, carryoverAdd: true, carryoverPercentage: 100 },
      nextScenarioDeclaredGold: 0,
    });
    expect(result.turnsLeft).toBe(0);
    expect(result.finishingBonus).toBe(0);
    expect(result.carryoverGoldValue).toBe(100);
  });

  it('BASE_INCOME/DEFAULT_CARRYOVER_PERCENTAGE match the real game_config.cpp defaults', () => {
    expect(BASE_INCOME).toBe(2);
    expect(DEFAULT_CARRYOVER_PERCENTAGE).toBe(80);
  });
});

describe('findVictoryEndlevelGoldConfig', () => {
  it('reads bonus=/carryover_add=/carryover_percentage= from a hand-built [event name="enemies defeated"][endlevel]', () => {
    const scenarioCfg = new WmlConfig();
    const eventCfg = scenarioCfg.addChild('event');
    eventCfg.setAttribute('name', 'enemies defeated'); // real WML source spells it with a space, standardized to enemies_defeated.
    const endlevel = eventCfg.addChild('endlevel');
    endlevel.setAttribute('result', 'victory');
    endlevel.setAttribute('bonus', true);
    endlevel.setAttribute('carryover_add', true);
    endlevel.setAttribute('carryover_percentage', 40);

    const config = findVictoryEndlevelGoldConfig(scenarioCfg.toJSON());
    expect(config).toEqual({ bonus: true, carryoverAdd: true, carryoverPercentage: 40 });
  });

  it('degrades to real upstream defaults when there is no matching event/endlevel, rather than crashing', () => {
    const emptyScenario = new WmlConfig();
    expect(findVictoryEndlevelGoldConfig(emptyScenario.toJSON())).toEqual({
      bonus: false,
      carryoverAdd: false,
      carryoverPercentage: DEFAULT_CARRYOVER_PERCENTAGE,
    });

    const noEndlevel = new WmlConfig();
    const ev = noEndlevel.addChild('event');
    ev.setAttribute('name', 'enemies_defeated');
    expect(findVictoryEndlevelGoldConfig(noEndlevel.toJSON()).carryoverPercentage).toBe(DEFAULT_CARRYOVER_PERCENTAGE);
  });

  it('matches the real, unmodified 01_Invasion.cfg', () => {
    const defines = loadDefines();
    const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), { dataRoot, defines: new Map(defines) });
    const scenario = scenarioCfg.child('scenario')!;
    const config = findVictoryEndlevelGoldConfig(scenario.toJSON());
    expect(config).toEqual({ bonus: true, carryoverAdd: true, carryoverPercentage: 40 });
  });
});

describe('computeGoldCarryover against real 01_Invasion.cfg/Home_1.map/02_Flight.cfg content end-to-end', () => {
  it('recomputes the same 31 real villages and 30-turn/140-gold real scenario numbers used in the hand-verified case above', () => {
    const defines = loadDefines();
    const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(defines) });
    const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));

    const scenario1Cfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), { dataRoot, defines: new Map(defines) });
    const scenario1 = scenario1Cfg.child('scenario')!;
    const mapText = fs.readFileSync(path.join(campaignDir, 'maps', scenario1.getString('map_file')), 'utf8');
    const map = GameMap.fromMapString(mapText, terrainData);
    expect(map.villages.length).toBe(31);
    expect(scenario1.getNumber('turns')).toBe(30);

    const side1Cfg = scenario1.children('side').find((s) => s.getNumber('side', 1) === 1)!;
    expect(side1Cfg.getNumber('income', 0)).toBe(0);
    expect(side1Cfg.hasAttribute('village_gold')).toBe(false); // real content: side 1 never overrides the default of 1.
    expect(side1Cfg.getNumber('gold')).toBe(120); // {GOLD4 110 120 120 130} -> NORMAL's 120.

    const scenario2Cfg = parseWmlFile(path.join(campaignDir, 'scenarios/02_Flight.cfg'), { dataRoot, defines: new Map(defines) });
    const scenario2 = scenario2Cfg.child('scenario')!;
    const scenario2Side1 = scenario2.children('side').find((s) => s.getNumber('side', 1) === 1)!;
    expect(scenario2Side1.getNumber('gold')).toBe(140); // {GOLD4 150 140 130 120} -> NORMAL's 140.
    expect(scenario2.getString('id')).toBe('02_Flight');
    expect(scenario1.getString('next_scenario')).toBe('02_Flight');

    const endlevel = findVictoryEndlevelGoldConfig(scenario1.toJSON());
    const result = computeGoldCarryover({
      teamGold: 150,
      teamIncome: side1Cfg.getNumber('income', 0),
      incomePerVillage: side1Cfg.getNumber('village_gold', 1),
      totalVillages: map.villages.length,
      scenarioTurnsLimit: scenario1.getNumber('turns'),
      turnNumberAtVictory: 5,
      endlevel,
      nextScenarioDeclaredGold: scenario2Side1.getNumber('gold'),
    });
    // Same hand-verified result as the pure-math test above, now derived
    // entirely from real, unmodified WML content instead of hand-typed inputs.
    expect(result.nextScenarioGold).toBe(530);
  });
});

describe('computeCarryoverRecruits', () => {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
  const attack = AttackType.fromConfig(new WmlConfig());
  const leaderType = new UnitType('Merman Child King', 'Kai Krellis', '', 'neutral', 1, 30, 6, 5, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, [attack], []);
  const citizenType = new UnitType('Merman Citizen', 'Merman Citizen', '', 'neutral', 1, 20, 5, 5, 0, 1, 0, -1, 500, [], '', false, false, false, moveType, [attack], []);

  function makeBoard(): GameBoard {
    const map = GameMap.fromMapString('Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg', terrainData);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));
    board.addUnit(Unit.create(leaderType, 1, new Location(0, 0), { id: 'Kai Krellis', canRecruit: true }));
    board.addUnit(Unit.create(citizenType, 1, new Location(1, 0), { id: 'Cylanna' }));
    board.addUnit(Unit.create(citizenType, 1, new Location(2, 0))); // no id at all, like a real citizen -- still carries over.
    return board;
  }

  it('excludes the unit whose id matches the next scenario\'s own inline [side] declaration, keeps every other survivor', () => {
    const nextScenario = new WmlConfig();
    const side = nextScenario.addChild('side');
    side.setAttribute('side', 1);
    side.setAttribute('id', 'Kai Krellis'); // {SIDE_1} always re-declares Kai Krellis fresh.

    const board = makeBoard();
    const survivors = computeCarryoverRecruits(board, 1, nextScenario.toJSON());
    expect(survivors.map((u) => u.id).sort()).toEqual(['', 'Cylanna']);
    expect(survivors.some((u) => u.id === 'Kai Krellis')).toBe(false);
  });

  it('matches real 01_Invasion.cfg -> 02_Flight.cfg: Kai Krellis excluded, everyone else carried', () => {
    const defines = loadDefines();
    const scenario2Cfg = parseWmlFile(path.join(campaignDir, 'scenarios/02_Flight.cfg'), { dataRoot, defines: new Map(defines) });
    const scenario2 = scenario2Cfg.child('scenario')!;
    const nextSide1 = findSideConfig(scenario2.toJSON(), 1)!;
    expect(nextSide1.getString('id')).toBe('Kai Krellis');

    const board = makeBoard();
    const survivors = computeCarryoverRecruits(board, 1, scenario2.toJSON());
    expect(survivors.some((u) => u.id === 'Kai Krellis')).toBe(false);
    expect(survivors).toHaveLength(2);
  });

  it('also carries units already sitting in the recall list (not just ones still on the map) -- regression for a real dropped-hero bug', () => {
    // Real bug: a survivor from an EARLIER scenario (e.g. Cylanna carried
    // into scenario 2's recall list) that the player never got around to
    // recalling onto scenario 2's own board used to vanish the moment
    // scenario 2 finished, because this function only ever looked at
    // `board.unitsForSide` -- never `board.recallList`. Real Wesnoth's
    // recall list is unconditionally persistent; it should carry straight
    // through into scenario 3 regardless of whether it was ever recalled.
    const board = makeBoard();
    const benched = Unit.create(citizenType, 1, new Location(-1000, -1000), { id: 'Gwabbo' });
    board.addToRecallList(1, benched);

    const nextScenario = new WmlConfig();
    const side = nextScenario.addChild('side');
    side.setAttribute('side', 1);
    side.setAttribute('id', 'Kai Krellis');

    const survivors = computeCarryoverRecruits(board, 1, nextScenario.toJSON());
    expect(survivors.map((u) => u.id).sort()).toEqual(['', 'Cylanna', 'Gwabbo']);
  });
});
