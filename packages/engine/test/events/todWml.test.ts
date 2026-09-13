import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Location } from '../../src/model/Location.js';
import type { UnitType } from '../../src/model/UnitType.js';
import { Schedule } from '../../src/model/Schedule.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { WmlConfig } from '../../src/wml/config.js';
import { parseWml } from '../../src/wml/index.js';

/** ToD WML tags on a flat 9x9 raw grid (logical 0..6). Tag coordinates are WML (1-based). */

function makeBoard(): GameBoard {
  const rows = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 'Gg').join(', '));
  const board = new GameBoard(GameMap.fromMapString(rows.join('\n'), TerrainTypeData.fromConfigs([])));
  board.addTeam(new Team(1, { teamName: 'a' }));
  return board;
}

function makeTimeCfg(id: string, lawfulBonus: number): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', id);
  cfg.setAttribute('name', id);
  cfg.setAttribute('image', `misc/${id}.png`);
  cfg.setAttribute('lawful_bonus', lawfulBonus);
  return cfg;
}

function globalSchedule(): Schedule {
  const cfg = new WmlConfig();
  cfg.addChild('time', makeTimeCfg('a', 0));
  cfg.addChild('time', makeTimeCfg('b', 10));
  cfg.addChild('time', makeTimeCfg('c', 20));
  return Schedule.fromScenarioConfig(cfg);
}

function runTag(board: GameBoard, schedule: Schedule, tagWml: string, turnNumber = 1): EventPump {
  const manager = new EventManager();
  manager.addFromWml(parseWml(`[event]\nname=go\n${tagWml}\n[/event]`).child('event')!);
  const variables = new VariableStore();
  variables.set('turn_number', turnNumber);
  const pump = new EventPump(manager, {
    board,
    schedule,
    variables,
    resolveType: (id: string): UnitType => {
      throw new Error(`unexpected unit type ${id}`);
    },
  });
  pump.fire('go');
  return pump;
}

const wml = (x: number, y: number): Location => Location.fromWml(x, y);

describe('[time_area] / [remove_time_area]', () => {
  it('adds an area covering the matched hexes, following its own [time] schedule', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    runTag(board, schedule, '[time_area]\nid=campfire\nx,y=4,4\nradius=1\n[time]\nid=firelight\nname=Firelight\nimage=\nlawful_bonus=25\n[/time]\n[/time_area]');

    expect(schedule.timeOfDayAt(wml(4, 4), 1).id).toBe('firelight');
    expect(schedule.timeOfDayAt(wml(4, 3), 1).id).toBe('firelight'); // within radius=1.
    expect(schedule.timeOfDayAt(wml(1, 1), 1).id).toBe('a'); // outside the area -- global schedule.
    expect(schedule.areaIds).toEqual(['campfire']);
  });

  it('remove=yes on [time_area] itself delegates to [remove_time_area]', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    schedule.addTimeArea('campfire', new Set([wml(4, 4).key()]), [{ id: 'firelight', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
    runTag(board, schedule, '[time_area]\nid=campfire\nremove=yes\n[/time_area]');
    expect(schedule.areaIds).toEqual([]);
  });

  it('[remove_time_area] accepts a comma-separated list of ids', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    schedule.addTimeArea('one', new Set(['0,0']), [{ id: 't', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
    schedule.addTimeArea('two', new Set(['1,1']), [{ id: 't', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
    schedule.addTimeArea('three', new Set(['2,2']), [{ id: 't', name: '', image: '', lawfulBonus: 0, red: 0, green: 0, blue: 0 }], 0, 1);
    runTag(board, schedule, '[remove_time_area]\nid=one,three\n[/remove_time_area]');
    expect(schedule.areaIds).toEqual(['two']);
  });

  it('an area created mid-scenario anchors its current_time= to the turn it was created on', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    runTag(
      board,
      schedule,
      '[time_area]\nid=cave\nx,y=1,1\n[time]\nid=x\nname=\nimage=\n[/time]\n[time]\nid=y\nname=\nimage=\n[/time]\n[/time_area]',
      5,
    );
    expect(schedule.timeOfDayAt(wml(1, 1), 5).id).toBe('x');
    expect(schedule.timeOfDayAt(wml(1, 1), 6).id).toBe('y');
  });
});

describe('[replace_schedule]', () => {
  it('replaces the global schedule outright, anchored at the current turn', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    runTag(board, schedule, '[replace_schedule]\n[time]\nid=new1\nname=\nimage=\n[/time]\n[time]\nid=new2\nname=\nimage=\n[/time]\n[/replace_schedule]', 3);
    expect(schedule.timeOfDayForTurn(3).id).toBe('new1');
    expect(schedule.timeOfDayForTurn(4).id).toBe('new2');
  });

  it('an empty schedule (no [time] children) is rejected, leaving the old schedule in place', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    runTag(board, schedule, '[replace_schedule]\n[/replace_schedule]');
    expect(schedule.timeOfDayForTurn(1).id).toBe('a');
  });
});

describe('[store_time_of_day]', () => {
  it('stores the global schedule ToD (no location given) into variable[0].*', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    const pump = runTag(board, schedule, '[store_time_of_day]\n[/store_time_of_day]', 2);
    expect(pump.ctx.variables.getString('time_of_day[0].id')).toBe('b');
    expect(pump.ctx.variables.getNumber('time_of_day[0].lawful_bonus')).toBe(10);
  });

  it('stores the location-specific ToD (inside a [time_area]) when x=/y= are given', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    schedule.addTimeArea('campfire', new Set([wml(4, 4).key()]), [{ id: 'firelight', name: 'Firelight', image: '', lawfulBonus: 25, red: 1, green: 2, blue: 3 }], 0, 1);
    const pump = runTag(board, schedule, '[store_time_of_day]\nx,y=4,4\nvariable=my_tod\n[/store_time_of_day]');
    expect(pump.ctx.variables.getString('my_tod[0].id')).toBe('firelight');
    expect(pump.ctx.variables.getNumber('my_tod[0].lawful_bonus')).toBe(25);
    expect(pump.ctx.variables.getNumber('my_tod[0].red')).toBe(1);
  });

  it('an explicit turn= overrides the current turn', () => {
    const board = makeBoard();
    const schedule = globalSchedule();
    const pump = runTag(board, schedule, '[store_time_of_day]\nturn=3\n[/store_time_of_day]', 1);
    expect(pump.ctx.variables.getString('time_of_day[0].id')).toBe('c'); // turn 3 -> index 2 -> "c".
  });
});
