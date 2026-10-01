import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, runActionSequence } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

/**
 * Phase 28c C1: the mainline tags several unported campaigns share, where the session takes part
 * (`[end_turn]`'s forced end of turn), on real Dead Water scenario 1.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

async function start(events: string[] = []): Promise<GameSession> {
  const session = new GameSession(readScenarioSnapshot(snapshotPath));
  for (const wml of events) session['eventPump'].manager.addFromWml(parseConfig(wml).child('event')!);
  await session.runStartupEvents();
  return session;
}

describe('[end_turn]', () => {
  it('in a moveto event: the turn is to end, the move cannot be undone, and the flag clears with the next side', async () => {
    const session = await start([`[event]
      name=moveto
      [end_turn]
      [/end_turn]
    [/event]`]);
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kai);
    const dest = session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y)!;
    await session.handleHexClick(dest.x, dest.y);
    expect(session.endTurnForced).toBe(true);
    expect(session.canUndo).toBe(false);
    expect(session.toSaveData().endTurnForced).toBe(true);
    await session.endTurn();
    expect(session.endTurnForced).toBe(false);
    expect(session.activeSide).toBe(1);
    expect(session.turnNumber).toBe(2);
  });

  it("in the side's own turn events: that turn is skipped", async () => {
    const session = await start([`[event]
      name=side 1 turn 2
      [end_turn]
      [/end_turn]
    [/event]`]);
    await session.endTurn();
    expect(session.activeSide).toBe(1);
    expect(session.turnNumber).toBe(3);
    expect(session.endTurnForced).toBe(false);
  });

  it('survives a save and load', async () => {
    const session = await start(['[event]\nname=moveto\n[end_turn]\n[/end_turn]\n[/event]']);
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kai);
    const dest = session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y)!;
    await session.handleHexClick(dest.x, dest.y);
    const loaded = GameSession.fromSaveData(readScenarioSnapshot(snapshotPath), session.toSaveData());
    expect(loaded.endTurnForced).toBe(true);
  });
});

describe('[find_path]', () => {
  /**
   * The port (`flowWml.ts`) against upstream's own `lua/wml/find_path.lua`, run by the game's Lua runtime:
   * the same WML must store the same variables.
   */
  async function both(body: string): Promise<{ port: unknown; upstream: unknown; session: GameSession }> {
    const session = await start();
    const ctx = session['eventPump'].ctx;
    runActionSequence(parseConfig(`[find_path]\nvariable=port\n${body}\n[/find_path]`), ctx);
    session['luaRuntime']!.kernel.run('wesnoth.require "lua/wml/find_path.lua"', '=test');
    runActionSequence(parseConfig(`[find_path]\nvariable=upstream\n${body}\n[/find_path]`), ctx);
    return { port: ctx.variables.getConfig('port')?.toJSON(), upstream: ctx.variables.getConfig('upstream')?.toJSON(), session };
  }

  const cases: Record<string, string> = {
    'the cheapest of several hexes, this turn': '[traveler]\nid=Kai Krellis\n[/traveler]\n[destination]\nterrain=Wwf\n[/destination]',
    'a far hex, over several turns': '[traveler]\nid=Kai Krellis\n[/traveler]\n[destination]\nx=2\ny=2\n[/destination]\nallow_multiple_turns=yes',
    'too far for this turn': '[traveler]\nid=Kai Krellis\n[/traveler]\n[destination]\nx=2\ny=2\n[/destination]',
    'the nearest by hexes, ignoring zones of control': '[traveler]\nid=Kai Krellis\n[/traveler]\n[destination]\nterrain=Ww\n[/destination]\nnearest_by=hexes\ncheck_zoc=no\nallow_multiple_turns=yes',
    '$this_unit in [destination]': '[traveler]\nid=Kai Krellis\n[/traveler]\n[destination]\nx=$this_unit.x\ny="$($this_unit.y + 2)"\n[/destination]',
    'no hex matches': '[traveler]\nid=Kai Krellis\n[/traveler]\n[destination]\nx=999\ny=999\n[/destination]',
  };
  for (const [name, body] of Object.entries(cases)) {
    it(`matches upstream: ${name}`, async () => {
      const { port, upstream } = await both(body);
      expect(port).toEqual(upstream);
    });
  }

  it('stores a route with its steps', async () => {
    const { port } = await both(cases['a far hex, over several turns']!);
    const path = port as { attributes: Record<string, unknown>; children: unknown[] };
    expect(JSON.stringify(path)).toContain('required_turns');
    expect(JSON.stringify(path)).toContain('step');
  });
});

describe('[do_command]', () => {
  async function kaiMoves(session: GameSession): Promise<void> {
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kai);
    const dest = session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y)!;
    await session.handleHexClick(dest.x, dest.y);
  }

  it('[fire_event] inside an event fires the named event as part of the running action', async () => {
    const session = await start([
      '[event]\nname=moveto\nfirst_time_only=yes\n[do_command]\n[fire_event]\nraise=buy_elixir\n[/fire_event]\n[/do_command]\n[/event]',
      '[event]\nname=buy_elixir\n[set_variable]\nname=bought\nvalue=yes\n[/set_variable]\n[/event]',
    ]);
    const before = session['recorder'].length;
    await kaiMoves(session);
    expect(session['eventPump'].ctx.variables.getBoolean('bought', false)).toBe(true);
    // One command (the move); the fired event was part of it, not a command of its own.
    expect(session['recorder'].commands.slice(before).map((r) => r.command.kind)).toEqual(['move']);
  });

  it('outside any action, a command of its own, written to the replay as [fire_event]', async () => {
    const session = await start(['[event]\nname=buy_elixir\n[set_variable]\nname=bought\nvalue=yes\n[/set_variable]\n[/event]']);
    const before = session['recorder'].length;
    await session['drive'](session['eventPump'].ctx.doCommand!('fire_event', parseConfig('raise=buy_elixir')));
    expect(session['eventPump'].ctx.variables.getBoolean('bought', false)).toBe(true);
    const added = session['recorder'].commands.slice(before);
    expect(added.map((r) => r.command)).toEqual([{ kind: 'fire_event', raise: 'buy_elixir' }]);
  });

  it('[move] walks a unit as a move order would, firing its moveto', async () => {
    const session = await start(['[event]\nname=moveto\n[set_variable]\nname=moved_to\nvalue=$x1,$y1\n[/set_variable]\n[/event]']);
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kai);
    const dest = session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y)!;
    const steps = session.routePreview(dest.x, dest.y)!.steps;
    session.clearSelection();
    const wml = `x=${steps.map((s) => s.x + 1).join(',')}\ny=${steps.map((s) => s.y + 1).join(',')}`;
    await session['drive'](session['eventPump'].ctx.doCommand!('move', parseConfig(wml)));
    expect(kai.location.x).toBe(dest.x);
    expect(kai.location.y).toBe(dest.y);
    expect(session['eventPump'].ctx.variables.getString('moved_to')).toBe(`${dest.x + 1},${dest.y + 1}`);
  });

  it('refuses tags other than the commands, saying which are allowed', async () => {
    const logs: string[] = [];
    const session = new GameSession(readScenarioSnapshot(snapshotPath), { onLog: (level, message) => logs.push(`${level}: ${message}`) });
    session['eventPump'].manager.addFromWml(parseConfig('[event]\nname=start\n[do_command]\n[kill]\nid=Kai Krellis\n[/kill]\n[/do_command]\n[/event]').child('event')!);
    await session.runStartupEvents();
    expect(logs).toContain('error: unsupported tag [kill] in [do_command]; allowed tags: attack custom_command disband fire_event move recall recruit');
    expect(session.board.allUnits().some((u) => u.id === 'Kai Krellis')).toBe(true);
  });
});

describe('the end of the scenario (play_scenario_end)', () => {
  const recordOrder = (name: string) => `[event]\nname=${name}\n[set_variable]\nname=order\nvalue="$order,${name}"\n[/set_variable]\n[/event]`;
  const endOnMove = (result: string) => `[event]\nname=moveto\n[endlevel]\nresult=${result}\n[/endlevel]\n[/event]`;
  const proceeds = '[event]\nname=scenario_end\n[filter_condition]\n[proceed_to_next_scenario]\n[/proceed_to_next_scenario]\n[/filter_condition]\n[set_variable]\nname=proceeds\nvalue=yes\n[/set_variable]\n[/event]';

  async function endBy(result: string): Promise<GameSession> {
    const session = await start([endOnMove(result), ...['local_victory', 'local_defeat', 'victory', 'defeat', 'scenario_end'].map(recordOrder), proceeds]);
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kai);
    const dest = session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y)!;
    await session.handleHexClick(dest.x, dest.y);
    return session;
  }

  it('a victory fires local_victory, victory, then scenario_end, where [proceed_to_next_scenario] holds', async () => {
    const session = await endBy('victory');
    expect(session.scenarioResult).toBe('victory');
    const vars = session['eventPump'].ctx.variables;
    expect(vars.getString('order')).toBe(',local_victory,victory,scenario_end');
    expect(vars.getBoolean('proceeds', false)).toBe(true);
  });

  it('a defeat fires local_defeat, defeat, then scenario_end, where it does not', async () => {
    const session = await endBy('defeat');
    expect(session.scenarioResult).toBe('defeat');
    const vars = session['eventPump'].ctx.variables;
    expect(vars.getString('order')).toBe(',local_defeat,defeat,scenario_end');
    expect(vars.getBoolean('proceeds', false)).toBe(false);
  });

  it('[proceed_to_next_scenario] is false while the scenario goes on', async () => {
    const session = await start(['[event]\nname=moveto\n[if]\n[proceed_to_next_scenario]\n[/proceed_to_next_scenario]\n[then]\n[set_variable]\nname=early\nvalue=yes\n[/set_variable]\n[/then]\n[/if]\n[/event]']);
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kai);
    const dest = session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y)!;
    await session.handleHexClick(dest.x, dest.y);
    expect(session['eventPump'].ctx.variables.getBoolean('early', false)).toBe(false);
  });

  it('runs once: a loaded finished game does not fire them again', async () => {
    const session = await endBy('victory');
    const loaded = GameSession.fromSaveData(readScenarioSnapshot(snapshotPath), session.toSaveData());
    expect(loaded['scenarioEndEventsFired']).toBe(true);
    expect(loaded['eventPump'].ctx.variables.getString('order')).toBe(',local_victory,victory,scenario_end');
  });
});
