import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefines, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { Schedule } from '../../src/model/Schedule.js';
import { WmlConfig } from '../../src/wml/config.js';

/**
 * Real-content test: Dead Water scenario 1's real `{DEFAULT_SCHEDULE}`
 * expansion (dawn/morning/afternoon/dusk/first_watch/second_watch), same
 * real-macro-expansion pattern as `deadWaterPrestartEvent.test.ts`.
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

describe('Schedule.fromScenarioConfig (real Dead_Water scenario 1 {DEFAULT_SCHEDULE})', () => {
  const defines = loadDefines();
  const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), { dataRoot, defines: new Map(defines) });
  const scenario = scenarioCfg.child('scenario')!;
  const schedule = Schedule.fromScenarioConfig(scenario);

  it('parses the real 6-phase default schedule with real names/ids/lawful_bonus values', () => {
    expect(schedule.hasSchedule).toBe(true);
    expect(schedule.times.map((t) => t.id)).toEqual(['dawn', 'morning', 'afternoon', 'dusk', 'first_watch', 'second_watch']);
    expect(schedule.times.map((t) => t.name)).toEqual(['Dawn', 'Morning', 'Afternoon', 'Dusk', 'First Watch', 'Second Watch']);
    // Real values from wesnoth/data/core/macros/schedules.cfg: morning/afternoon are lawful-favoring (+25), first/second watch chaotic-favoring (-25), dawn/dusk neutral (0).
    expect(schedule.times.map((t) => t.lawfulBonus)).toEqual([0, 25, 25, 0, -25, -25]);
    for (const t of schedule.times) expect(t.image.length).toBeGreaterThan(0);
  });

  it('defaults current_time to 0 (dawn) and maxLiminalBonus to the real 25 floor when the scenario sets neither', () => {
    expect(schedule.currentTimeStart).toBe(0);
    expect(schedule.maxLiminalBonus).toBe(25);
  });

  it('timeOfDayForTurn cycles through the real 6-phase schedule and wraps around', () => {
    expect(schedule.timeOfDayForTurn(1).id).toBe('dawn');
    expect(schedule.timeOfDayForTurn(2).id).toBe('morning');
    expect(schedule.timeOfDayForTurn(3).id).toBe('afternoon');
    expect(schedule.timeOfDayForTurn(4).id).toBe('dusk');
    expect(schedule.timeOfDayForTurn(5).id).toBe('first_watch');
    expect(schedule.timeOfDayForTurn(6).id).toBe('second_watch');
    expect(schedule.timeOfDayForTurn(7).id).toBe('dawn'); // wraps.
    expect(schedule.timeOfDayForTurn(13).id).toBe('dawn'); // wraps twice.
  });
});

describe('Schedule (synthetic edge cases)', () => {
  function makeTimeCfg(id: string, lawfulBonus: number): WmlConfig {
    const cfg = new WmlConfig();
    cfg.setAttribute('id', id);
    cfg.setAttribute('name', id);
    cfg.setAttribute('image', `misc/${id}.png`);
    cfg.setAttribute('lawful_bonus', lawfulBonus);
    return cfg;
  }

  it('honors an explicit current_time= as the schedule index active on turn 1', () => {
    const scenario = new WmlConfig();
    scenario.addChild('time', makeTimeCfg('a', 0));
    scenario.addChild('time', makeTimeCfg('b', 10));
    scenario.addChild('time', makeTimeCfg('c', 20));
    scenario.setAttribute('current_time', 2); // starts at "c".
    const schedule = Schedule.fromScenarioConfig(scenario);
    expect(schedule.timeOfDayForTurn(1).id).toBe('c');
    expect(schedule.timeOfDayForTurn(2).id).toBe('a'); // wraps past the end of the 3-entry schedule.
  });

  it('honors an explicit liminal_bonus= override instead of the default 25 floor', () => {
    const scenario = new WmlConfig();
    scenario.addChild('time', makeTimeCfg('a', 0));
    scenario.setAttribute('liminal_bonus', 40);
    expect(Schedule.fromScenarioConfig(scenario).maxLiminalBonus).toBe(40);
  });

  it('a scenario with no [time] entries at all reads as permanently neutral, not a crash', () => {
    const schedule = Schedule.fromScenarioConfig(new WmlConfig());
    expect(schedule.hasSchedule).toBe(false);
    expect(schedule.timeOfDayForTurn(1)).toEqual({ id: '', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 });
    expect(schedule.timeOfDayForTurn(50).lawfulBonus).toBe(0);
  });
});
