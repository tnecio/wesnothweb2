import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { Location } from '../../src/model/Location.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';
import { runFlow, type Flow, type Interaction } from '../../src/events/interaction.js';

/**
 * Phase 17 E0: the pump can stop mid-event and be resumed.
 *
 * The blocking tags themselves (`[message]` with options, cutscene beats)
 * arrive in later stages, so the suspension mechanism is exercised here
 * with a synthetic `[test_block]` handler -- the point under test is the
 * plumbing: that a yield travels out through `[if]` bodies and nested
 * event fires, that nothing runs past it until it is answered, and that
 * the old synchronous `pump()` still drains everything by itself.
 */

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

function makePump(board: GameBoard) {
  const manager = new EventManager();
  const pump = new EventPump(manager, { board, variables: new VariableStore(), resolveType: makeResolveType() });
  return { manager, pump };
}

/**
 * A stand-in blocking tag: records that it ran, suspends, and records
 * what it was answered with. `label=` names the yielded interaction so a
 * test can tell several of them apart.
 */
function registerTestBlock(pump: EventPump, trace: string[]): void {
  pump.ctx.registry.register('test_block', function* (cfg): Flow {
    const label = cfg.getString('label', 'block');
    trace.push(`yield:${label}`);
    const answer = yield { kind: 'message', message: { message: label } as never, options: [] };
    trace.push(`resumed:${label}:${String(answer.value ?? '')}`);
  });
  pump.ctx.registry.register('trace', function (cfg) {
    trace.push(cfg.getString('note', ''));
  });
}

function addUnit(board: GameBoard, resolve: (id: string) => UnitType, id: string, side: number, x: number, y: number): Unit {
  const unit = Unit.create(resolve('Test'), side, new Location(x, y), { id });
  board.addUnit(unit);
  return unit;
}

describe('suspendable event pump (Phase 17 E0)', () => {
  it('stops at the yield: later actions in the same event body have not run yet', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const trace: string[] = [];
    registerTestBlock(pump, trace);

    manager.addFromWml(
      parseWml(`
      [event]
        name=cutscene
        [trace]
          note=before
        [/trace]
        [test_block]
          label=one
        [/test_block]
        [trace]
          note=after
        [/trace]
      [/event]
    `).child('event')!,
    );

    const flow = pump.fireFlow('cutscene');
    const first = flow.next({});

    expect(first.done).toBe(false);
    expect(trace).toEqual(['before', 'yield:one']);

    flow.next({ value: 7 });
    expect(trace).toEqual(['before', 'yield:one', 'resumed:one:7', 'after']);
  });

  it('a yield inside an [if] branch travels out to the pump driver', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const trace: string[] = [];
    registerTestBlock(pump, trace);
    pump.ctx.variables.set('open_the_gate', 'open');

    manager.addFromWml(
      parseWml(`
      [event]
        name=gate
        [if]
          [variable]
            name=open_the_gate
            equals=open
          [/variable]
          [then]
            [test_block]
              label=inside_if
            [/test_block]
          [/then]
        [/if]
      [/event]
    `).child('event')!,
    );

    const interactions: Interaction[] = [];
    const flow = pump.fireFlow('gate');
    let step = flow.next({});
    while (!step.done) {
      interactions.push(step.value);
      step = flow.next({ value: 1 });
    }

    expect(interactions).toHaveLength(1);
    expect(trace).toEqual(['yield:inside_if', 'resumed:inside_if:1']);
  });

  it('a yield inside an event fired by [fire_event] travels out too, and the nested event finishes first', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const trace: string[] = [];
    registerTestBlock(pump, trace);

    manager.addFromWml(
      parseWml(`
      [event]
        name=outer
        [fire_event]
          name=inner
        [/fire_event]
        [trace]
          note=outer_after
        [/trace]
      [/event]
    `).child('event')!,
    );
    manager.addFromWml(
      parseWml(`
      [event]
        name=inner
        [test_block]
          label=nested
        [/test_block]
        [trace]
          note=inner_after
        [/trace]
      [/event]
    `).child('event')!,
    );

    runFlow(pump.fireFlow('outer'), () => ({ value: 3 }));

    expect(trace).toEqual(['yield:nested', 'resumed:nested:3', 'inner_after', 'outer_after']);
  });

  it('pump() still drains everything by itself, answering inline -- the pre-Phase-17 contract', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const trace: string[] = [];
    registerTestBlock(pump, trace);

    manager.addFromWml(
      parseWml(`
      [event]
        name=cutscene
        [test_block]
          label=auto
        [/test_block]
        [trace]
          note=done
        [/trace]
      [/event]
    `).child('event')!,
    );

    pump.fire('cutscene');

    // autoRespond answers an option-less message with no value at all.
    expect(trace).toEqual(['yield:auto', 'resumed:auto:', 'done']);
  });

  it('[kill] fire_event=yes: the dying unit is still on the board in its own last breath/die handlers', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const resolve = makeResolveType();
    addUnit(board, resolve, 'Doomed', 2, 1, 1);

    manager.addFromWml(
      parseWml(`
      [event]
        name=last breath
        [store_unit]
          [filter]
            id=Doomed
          [/filter]
          variable=seen_in_last_breath
        [/store_unit]
      [/event]
    `).child('event')!,
    );
    manager.addFromWml(
      parseWml(`
      [event]
        name=die
        [store_unit]
          [filter]
            id=Doomed
          [/filter]
          variable=seen_in_die
        [/store_unit]
      [/event]
    `).child('event')!,
    );
    manager.addFromWml(
      parseWml(`
      [event]
        name=slay
        [kill]
          id=Doomed
          fire_event=yes
        [/kill]
        [store_unit]
          [filter]
            id=Doomed
          [/filter]
          variable=seen_after_kill
        [/store_unit]
      [/event]
    `).child('event')!,
    );

    pump.fire('slay');

    // Before the pump could nest, both events were queued to run after the
    // whole [kill] body, so neither could see the unit.
    expect(pump.ctx.variables.getString('seen_in_last_breath.id')).toBe('Doomed');
    expect(pump.ctx.variables.getString('seen_in_die.id')).toBe('Doomed');
    expect(pump.ctx.variables.getString('seen_after_kill.id')).toBe('');
    expect(board.allUnits()).toHaveLength(0);
  });

  it('[fire_event] passes [primary_unit]/[secondary_unit] as $x1|$y1 / $x2|$y2', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const resolve = makeResolveType();
    addUnit(board, resolve, 'Speaker', 1, 1, 1);
    addUnit(board, resolve, 'Listener', 2, 2, 2);

    manager.addFromWml(
      parseWml(`
      [event]
        name=chat
        [set_variable]
          name=where
          value="$x1|,$y1| -> $x2|,$y2"
        [/set_variable]
      [/event]
    `).child('event')!,
    );
    manager.addFromWml(
      parseWml(`
      [event]
        name=trigger
        [fire_event]
          name=chat
          [primary_unit]
            id=Speaker
          [/primary_unit]
          [secondary_unit]
            id=Listener
          [/secondary_unit]
        [/fire_event]
      [/event]
    `).child('event')!,
    );

    pump.fire('trigger');

    // WML coordinates are 1-based, the engine's are 0-based.
    expect(pump.ctx.variables.getString('where')).toBe('2,2 -> 3,3');
  });

  it('skipMessages is reset for a new top-level event but inherited by a nested one', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const seen: Array<{ where: string; skipping: boolean }> = [];
    pump.ctx.registry.register('note_skip', (cfg, ctx) => {
      seen.push({ where: cfg.getString('where', ''), skipping: ctx.skipMessages });
    });
    pump.ctx.registry.register('start_skipping', (_cfg, ctx) => {
      ctx.skipMessages = true;
    });

    manager.addFromWml(
      parseWml(`
      [event]
        name=outer
        [start_skipping]
        [/start_skipping]
        [note_skip]
          where=outer
        [/note_skip]
        [fire_event]
          name=inner
        [/fire_event]
      [/event]
    `).child('event')!,
    );
    manager.addFromWml(
      parseWml(`
      [event]
        name=inner
        [note_skip]
          where=inner
        [/note_skip]
      [/event]
    `).child('event')!,
    );
    manager.addFromWml(
      parseWml(`
      [event]
        name=later
        [note_skip]
          where=later
        [/note_skip]
      [/event]
    `).child('event')!,
    );

    pump.fire('outer');
    pump.fire('later');

    expect(seen).toEqual([
      { where: 'outer', skipping: true },
      { where: 'inner', skipping: true },
      { where: 'later', skipping: false },
    ]);
  });
});
