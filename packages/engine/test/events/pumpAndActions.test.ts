import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';

/** A tiny, fully synthetic (no real content) board -- enough to exercise the pump/action-tag machinery in isolation. */
function makeBoard(): GameBoard {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const map = GameMap.fromMapString('Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100 }));
  board.addTeam(new Team(2, { gold: 100 }));
  return board;
}

function makeResolveType(): (id: string) => UnitType {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveType = MoveType.fromConfig(parseWml(''), terrainData);
  const attack = AttackType.fromConfig(parseWml(''));
  const cache = new Map<string, UnitType>();
  return (id: string) => {
    let t = cache.get(id);
    if (!t) {
      t = new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 1, -1, 500, [], '', true, false, false, moveType, [attack], []);
      cache.set(id, t);
    }
    return t;
  };
}

function makePump(board: GameBoard, log?: (level: string, msg: string) => void) {
  const manager = new EventManager();
  const variables = new VariableStore();
  const pump = new EventPump(manager, {
    board,
    variables,
    resolveType: makeResolveType(),
    log: log as EventPump['ctx']['log'] | undefined,
  });
  return { manager, pump };
}

describe('EventPump + action WML (synthetic content)', () => {
  it('dispatches [event] by name= and runs [set_variable]/[message] in its body', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);

    const eventCfg = parseWml(`
      [event]
        name=my_event
        [set_variable]
          name=greeting
          value=hello
        [/set_variable]
        [message]
          speaker=narrator
          message="$greeting, world"
        [/message]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    pump.fire('my_event');

    expect(pump.ctx.variables.getString('greeting')).toBe('hello');
    expect(pump.ctx.messages).toHaveLength(1);
    expect(pump.ctx.messages[0]).toMatchObject({ speaker: 'narrator', message: 'hello, world' });
  });

  it('honors first_time_only (default yes): a second fire() does not re-run the handler', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const eventCfg = parseWml(`
      [event]
        name=once
        [set_variable]
          name=counter
          add=1
        [/set_variable]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    pump.fire('once');
    pump.fire('once');

    expect(pump.ctx.variables.getNumber('counter')).toBe(1);
  });

  it('repeats when first_time_only=no', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const eventCfg = parseWml(`
      [event]
        name=repeatable
        first_time_only=no
        [set_variable]
          name=counter
          add=1
        [/set_variable]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    pump.fire('repeatable');
    pump.fire('repeatable');

    expect(pump.ctx.variables.getNumber('counter')).toBe(2);
  });

  it('[if]/[elseif]/[else] picks exactly one matching branch, evaluated in order', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    pump.ctx.variables.set('score', 5);
    const eventCfg = parseWml(`
      [event]
        name=grade
        [if]
          [variable]
            name=score
            greater_than_equal_to=10
          [/variable]
          [then]
            [set_variable]
              name=grade
              value=high
            [/set_variable]
          [/then]
          [elseif]
            [variable]
              name=score
              greater_than_equal_to=1
            [/variable]
            [then]
              [set_variable]
                name=grade
                value=mid
              [/set_variable]
            [/then]
          [/elseif]
          [else]
            [set_variable]
              name=grade
              value=low
            [/set_variable]
          [/else]
        [/if]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    pump.fire('grade');

    expect(pump.ctx.variables.getString('grade')).toBe('mid');
  });

  it('[event][filter] only matches the handler when loc1 has a matching unit', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const realUnit = Unit.fromConfig(parseWml(`[unit]\n  type=Merman Fighter\n  side=1\n  x=1\n  y=1\n  id=hero\n[/unit]`).child('unit')!, makeResolveType());
    board.addUnit(realUnit);

    const eventCfg = parseWml(`
      [event]
        name=moveto
        [filter]
          id=hero
        [/filter]
        [set_variable]
          name=matched
          value=yes
        [/set_variable]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    // loc2 has no unit -> should not match a *different* handler filtering on filter_second.
    pump.fire('moveto', realUnit.location);
    expect(pump.ctx.variables.getBoolean('matched')).toBe(true);
  });

  it('[event][filter] rejects the handler when loc1 has no matching unit', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const realUnit = Unit.fromConfig(
      parseWml(`[unit]\n  type=Merman Fighter\n  side=1\n  x=1\n  y=1\n  id=someoneelse\n[/unit]`).child('unit')!,
      makeResolveType(),
    );
    board.addUnit(realUnit);

    const eventCfg = parseWml(`
      [event]
        name=moveto
        [filter]
          id=hero
        [/filter]
        [set_variable]
          name=matched
          value=yes
        [/set_variable]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    pump.fire('moveto', realUnit.location);
    expect(pump.ctx.variables.get('matched')).toBeUndefined();
  });

  it('[store_unit] writes matching units as an indexed array variable', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    board.addUnit(Unit.fromConfig(parseWml(`[unit]\n  type=Merman Fighter\n  side=1\n  x=1\n  y=1\n  id=a\n[/unit]`).child('unit')!, makeResolveType()));
    board.addUnit(Unit.fromConfig(parseWml(`[unit]\n  type=Merman Fighter\n  side=1\n  x=2\n  y=1\n  id=b\n[/unit]`).child('unit')!, makeResolveType()));
    board.addUnit(Unit.fromConfig(parseWml(`[unit]\n  type=Merman Fighter\n  side=2\n  x=3\n  y=1\n  id=c\n[/unit]`).child('unit')!, makeResolveType()));

    const eventCfg = parseWml(`
      [event]
        name=go
        [store_unit]
          variable=mine
          [filter]
            side=1
          [/filter]
        [/store_unit]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    pump.fire('go');

    expect(pump.ctx.variables.arrayLength('mine')).toBe(2);
    const ids = [pump.ctx.variables.getString('mine[0].id'), pump.ctx.variables.getString('mine[1].id')];
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('an unregistered tag logs a warning and does not throw, and an extension-point tag (e.g. [attack]) is a documented no-op', () => {
    const board = makeBoard();
    const warnings: string[] = [];
    const { manager, pump } = makePump(board, (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    });
    const eventCfg = parseWml(`
      [event]
        name=go
        [totally_made_up_tag]
        [/totally_made_up_tag]
        [attack]
        [/attack]
        [set_variable]
          name=reached_end
          value=yes
        [/set_variable]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    expect(() => pump.fire('go')).not.toThrow();
    expect(pump.ctx.variables.getBoolean('reached_end')).toBe(true);
    expect(warnings.some((w) => w.includes('totally_made_up_tag'))).toBe(true);
    expect(warnings.some((w) => w.includes('attack'))).toBe(true);
  });
});
