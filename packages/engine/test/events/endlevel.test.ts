import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { UnitType } from '../../src/model/UnitType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';

/** `[endlevel]` (data/lua/wml/endlevel.lua) on a tiny synthetic board with two human sides. */
function run(...eventBodies: string[]): EventPump {
  const map = GameMap.fromMapString('Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg', TerrainTypeData.fromConfigs([]));
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { teamName: 'a' }));
  board.addTeam(new Team(2, { teamName: 'b' }));
  const manager = new EventManager();
  const pump = new EventPump(manager, {
    board,
    variables: new VariableStore(),
    resolveType: (id: string): UnitType => {
      throw new Error(`no unit types in this test (${id})`);
    },
  });
  eventBodies.forEach((body, i) => {
    manager.addFromWml(parseWml(`[event]\nname=end${i}\n${body}\n[/event]`).child('event')!);
  });
  eventBodies.forEach((_, i) => pump.fire(`end${i}`));
  return pump;
}

describe('[endlevel]', () => {
  it('defaults to victory and ignores later firings', () => {
    const pump = run('[endlevel]\n[/endlevel]', '[endlevel]\nresult=defeat\n[/endlevel]');
    expect(pump.ctx.endLevel?.result).toBe('victory');
  });

  it('result=defeat ends in defeat', () => {
    expect(run('[endlevel]\nresult=defeat\n[/endlevel]').ctx.endLevel?.result).toBe('defeat');
  });

  it('a human side winning via [result] overrides a defeat default', () => {
    const pump = run('[endlevel]\nresult=defeat\n[result]\nside=1\nresult=victory\n[/result]\n[/endlevel]');
    expect(pump.ctx.endLevel?.result).toBe('victory');
  });

  it('records next_scenario and per-side carryover overrides', () => {
    const pump = run(
      '[endlevel]\nnext_scenario=02_Next\ncarryover_percentage=40\n[result]\nside=2\ncarryover_percentage=0\nbonus=no\n[/result]\n[/endlevel]',
    );
    const end = pump.ctx.endLevel!;
    expect(end.nextScenario).toBe('02_Next');
    expect(end.carryover.get(1)).toEqual({ carryoverPercentage: 40 });
    expect(end.carryover.get(2)).toEqual({ bonus: false, carryoverPercentage: 0 });
  });

  it('records the outro fields, clamping end_text_duration to 0-5000 ms like game_classification', () => {
    const end = run('[endlevel]\nend_text="The merfolk were saved."\nend_text_duration=9000\nend_credits=no\n[/endlevel]').ctx.endLevel!;
    expect([end.endText, end.endTextDuration, end.endCredits]).toEqual(['The merfolk were saved.', 5000, false]);
    const plain = run('[endlevel]\n[/endlevel]').ctx.endLevel!;
    expect([plain.endText, plain.endTextDuration, plain.endCredits]).toEqual([undefined, undefined, undefined]);
  });
});
