import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefines, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { Schedule } from '../../src/model/Schedule.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';

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
    expect(schedule.globalTimes.map((t) => t.id)).toEqual(['dawn', 'morning', 'afternoon', 'dusk', 'first_watch', 'second_watch']);
    expect(schedule.globalTimes.map((t) => t.name)).toEqual(['Dawn', 'Morning', 'Afternoon', 'Dusk', 'First Watch', 'Second Watch']);
    // Real values from wesnoth/data/core/macros/schedules.cfg: morning/afternoon are lawful-favoring (+25), first/second watch chaotic-favoring (-25), dawn/dusk neutral (0).
    expect(schedule.globalTimes.map((t) => t.lawfulBonus)).toEqual([0, 25, 25, 0, -25, -25]);
    for (const t of schedule.globalTimes) expect(t.image.length).toBeGreaterThan(0);
  });

  it('defaults current_time to 0 (dawn) and maxLiminalBonus to the real 25 floor when the scenario sets neither', () => {
    expect(schedule.timeOfDayForTurn(1).id).toBe('dawn');
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

  function threeTimeSchedule(): Schedule {
    const scenario = new WmlConfig();
    scenario.addChild('time', makeTimeCfg('a', 0));
    scenario.addChild('time', makeTimeCfg('b', 10));
    scenario.addChild('time', makeTimeCfg('c', 20));
    return Schedule.fromScenarioConfig(scenario);
  }

  describe('random_start_time=', () => {
    function cfgWithRandom(random: string): WmlConfig {
      const scenario = new WmlConfig();
      scenario.addChild('time', makeTimeCfg('a', 0));
      scenario.addChild('time', makeTimeCfg('b', 10));
      scenario.addChild('time', makeTimeCfg('c', 20));
      scenario.setAttribute('random_start_time', random);
      return scenario;
    }

    it('is ignored (defaults to index 0) when no rng is supplied', () => {
      expect(Schedule.fromScenarioConfig(cfgWithRandom('yes')).timeOfDayForTurn(1).id).toBe('a');
    });

    it('yes/true picks a fully random index via the rng', () => {
      const rng = { nextRandom: () => 7 }; // 7 % 3 = 1 -> "b"
      expect(Schedule.fromScenarioConfig(cfgWithRandom('yes'), rng).timeOfDayForTurn(1).id).toBe('b');
    });

    it('a comma-separated list of 1-based indices picks (and wraps) one of them, consuming a second draw', () => {
      let calls = 0;
      const draws = [1, 999]; // first draw picks which list entry (1 % 2 -> index 1 -> "3"); second draw is consumed and discarded.
      const rng = { nextRandom: () => draws[calls++]! };
      // "1,3": candidates are literal indices 1 and 3; 3 wraps mod 3 -> 0 -> "a".
      const schedule = Schedule.fromScenarioConfig(cfgWithRandom('1,3'), rng);
      expect(schedule.timeOfDayForTurn(1).id).toBe('a');
      expect(calls).toBe(2); // both next_random() calls upstream makes were consumed.
    });

    it('no/false/absent leaves the schedule at index 0 even with an rng available', () => {
      const rng = { nextRandom: () => 7 };
      expect(Schedule.fromScenarioConfig(cfgWithRandom('no'), rng).timeOfDayForTurn(1).id).toBe('a');
    });

    it('an explicit current_time= always wins, regardless of random_start_time=', () => {
      const scenario = cfgWithRandom('yes');
      scenario.setAttribute('current_time', 2);
      const rng = { nextRandom: () => 7 };
      expect(Schedule.fromScenarioConfig(scenario, rng).timeOfDayForTurn(1).id).toBe('c');
    });
  });

  describe('[time_area] / [remove_time_area]', () => {
    it('a hex inside the area uses the area schedule; outside, the global one', () => {
      const schedule = threeTimeSchedule();
      const inside = new Location(2, 2);
      const outside = new Location(5, 5);
      schedule.addTimeArea('campfire', new Set([inside.key()]), [{ id: 'firelight', name: 'Firelight', image: '', lawfulBonus: 25, red: 0, green: 0, blue: 0 }], 0, 1);

      expect(schedule.timeOfDayAt(inside, 1).id).toBe('firelight');
      expect(schedule.timeOfDayAt(outside, 1).id).toBe('a');
      expect(schedule.areaIdAt(inside)).toBe('campfire');
      expect(schedule.areaIdAt(outside)).toBeUndefined();
    });

    it('anchors the area\'s own current_time= to the turn it was created on, not turn 1', () => {
      const schedule = threeTimeSchedule();
      const loc = new Location(0, 0);
      const areaTimes = [
        { id: 'x', name: 'x', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 },
        { id: 'y', name: 'y', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 },
      ];
      schedule.addTimeArea('a1', new Set([loc.key()]), areaTimes, 0, 5); // created on turn 5, starting at index 0 ("x").
      expect(schedule.timeOfDayAt(loc, 5).id).toBe('x');
      expect(schedule.timeOfDayAt(loc, 6).id).toBe('y');
      expect(schedule.timeOfDayAt(loc, 7).id).toBe('x'); // wraps.
    });

    it('a later area with the same overlapping hex wins (most-recently-added priority)', () => {
      const schedule = threeTimeSchedule();
      const loc = new Location(1, 1);
      schedule.addTimeArea('first', new Set([loc.key()]), [{ id: 'old', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
      schedule.addTimeArea('second', new Set([loc.key()]), [{ id: 'new', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
      expect(schedule.timeOfDayAt(loc, 1).id).toBe('new');
    });

    it('remove_time_area with a matching id removes just that area, restoring the global schedule there', () => {
      const schedule = threeTimeSchedule();
      const loc = new Location(3, 3);
      schedule.addTimeArea('campfire', new Set([loc.key()]), [{ id: 'firelight', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
      schedule.removeTimeArea('campfire');
      expect(schedule.timeOfDayAt(loc, 1).id).toBe('a');
      expect(schedule.areaIds).toEqual([]);
    });

    it('remove_time_area with an empty id clears every area', () => {
      const schedule = threeTimeSchedule();
      schedule.addTimeArea('one', new Set(['0,0']), [{ id: 't', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
      schedule.addTimeArea('two', new Set(['1,1']), [{ id: 't', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
      schedule.removeTimeArea('');
      expect(schedule.areaIds).toEqual([]);
    });
  });

  describe('replaceSchedule ([replace_schedule])', () => {
    it('replaces the global schedule outright, re-anchored at the turn it happens on', () => {
      const schedule = threeTimeSchedule();
      expect(schedule.timeOfDayForTurn(10).id).toBe('a'); // turn 10 -> index (10-1)%3 = 0 -> "a", before replacing.
      schedule.replaceSchedule([{ id: 'new1', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }, { id: 'new2', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 10);
      expect(schedule.timeOfDayForTurn(10).id).toBe('new1');
      expect(schedule.timeOfDayForTurn(11).id).toBe('new2');
    });

    it('does not affect existing [time_area]s', () => {
      const schedule = threeTimeSchedule();
      const loc = new Location(0, 0);
      schedule.addTimeArea('campfire', new Set([loc.key()]), [{ id: 'firelight', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
      schedule.replaceSchedule([{ id: 'new', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
      expect(schedule.timeOfDayAt(loc, 1).id).toBe('firelight');
    });
  });

  describe('exportState / importState (save/load round-trip)', () => {
    it('round-trips a replaced global schedule and an active [time_area] through a plain-JSON snapshot', () => {
      const schedule = threeTimeSchedule();
      const loc = new Location(2, 2);
      schedule.replaceSchedule([{ id: 'night', name: '', image: '', lawfulBonus: -25, red: 0, green: 0, blue: 0 }], 0, 5);
      schedule.addTimeArea('campfire', new Set([loc.key()]), [{ id: 'firelight', name: '', image: '', lawfulBonus: 25, red: 0, green: 0, blue: 0 }], 0, 5);

      const json = JSON.parse(JSON.stringify(schedule.exportState()));
      const restored = threeTimeSchedule(); // starts with a completely different schedule/no areas.
      restored.importState(json);

      expect(restored.timeOfDayForTurn(5).id).toBe('night');
      expect(restored.timeOfDayAt(loc, 5).id).toBe('firelight');
      expect(restored.areaIds).toEqual(['campfire']);
    });

    it('round-trips a schedule with no areas and no replacement (the common case)', () => {
      const schedule = threeTimeSchedule();
      const restored = new Schedule([], 0, 25);
      restored.importState(schedule.exportState());
      expect(restored.timeOfDayForTurn(1).id).toBe('a');
      expect(restored.areaIds).toEqual([]);
    });
  });
});
