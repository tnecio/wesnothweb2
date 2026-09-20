import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';
import { runFlow, type MessageInteraction } from '../../src/events/interaction.js';

/**
 * Phase 17 E2: the loop and flow-control tags (`flowWml.ts`, a port of
 * `data/lua/wml-flow.lua`). Real content needs them -- Under the Burning
 * Suns 1's prestart totals its rescue pool with `[foreach]` -- and they
 * have to be suspendable, so a `[message]` inside a loop body blocks the
 * loop rather than being collected up.
 */

function makeBoard(): GameBoard {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const map = GameMap.fromMapString('Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100, controller: 'human' }));
  return board;
}

function makeResolveType(): (id: string) => UnitType {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveType = MoveType.fromConfig(parseWml(''), terrainData);
  const attack = AttackType.fromConfig(parseWml(''));
  return (id: string) =>
    new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 1, -1, 500, [], '', true, false, false, moveType, [attack], []);
}

function makePump() {
  const manager = new EventManager();
  const pump = new EventPump(manager, { board: makeBoard(), variables: new VariableStore(), resolveType: makeResolveType() });
  return { manager, pump };
}

function fire(wml: string): EventPump {
  const { manager, pump } = makePump();
  manager.addFromWml(parseWml(wml).child('event')!);
  pump.fire('go');
  return pump;
}

describe('[while] / [repeat] / [break] / [continue] (Phase 17 E2)', () => {
  it('[while] loops until its condition stops holding', () => {
    const pump = fire(`
      [event]
        name=go
        [set_variable]
          name=n
          value=0
        [/set_variable]
        [while]
          [variable]
            name=n
            less_than=4
          [/variable]
          [do]
            [set_variable]
              name=n
              add=1
            [/set_variable]
          [/do]
        [/while]
      [/event]
    `);

    expect(pump.ctx.variables.getNumber('n')).toBe(4);
  });

  it('[break] leaves the loop, and execution continues after it', () => {
    const pump = fire(`
      [event]
        name=go
        [set_variable]
          name=n
          value=0
        [/set_variable]
        [while]
          [variable]
            name=n
            less_than=100
          [/variable]
          [do]
            [set_variable]
              name=n
              add=1
            [/set_variable]
            [if]
              [variable]
                name=n
                numerical_equals=3
              [/variable]
              [then]
                [break]
                [/break]
              [/then]
            [/if]
          [/do]
        [/while]
        [set_variable]
          name=after
          value=reached
        [/set_variable]
      [/event]
    `);

    expect(pump.ctx.variables.getNumber('n')).toBe(3);
    expect(pump.ctx.variables.getString('after')).toBe('reached');
  });

  it('[continue] skips the rest of the body but keeps looping', () => {
    const pump = fire(`
      [event]
        name=go
        [set_variable]
          name=evens
          value=""
        [/set_variable]
        [for]
          start=1
          end=5
          variable=n
          [do]
            [if]
              [variable]
                name=n
                numerical_equals=3
              [/variable]
              [then]
                [continue]
                [/continue]
              [/then]
            [/if]
            [set_variable]
              name=evens
              suffix=$n
            [/set_variable]
          [/do]
        [/for]
      [/event]
    `);

    expect(pump.ctx.variables.getString('evens')).toBe('1245');
  });

  it('[return] unwinds out of the loop and the rest of the event', () => {
    const pump = fire(`
      [event]
        name=go
        [repeat]
          times=5
          [do]
            [set_variable]
              name=n
              add=1
            [/set_variable]
            [return]
            [/return]
          [/do]
        [/repeat]
        [set_variable]
          name=after
          value=reached
        [/set_variable]
      [/event]
    `);

    expect(pump.ctx.variables.getNumber('n')).toBe(1);
    expect(pump.ctx.variables.getString('after')).toBe('');
  });

  it('[repeat] times= runs the body that many times', () => {
    const pump = fire(`
      [event]
        name=go
        [repeat]
          times=3
          [do]
            [set_variable]
              name=n
              add=2
            [/set_variable]
          [/do]
        [/repeat]
      [/event]
    `);

    expect(pump.ctx.variables.getNumber('n')).toBe(6);
  });
});

describe('[for] (Phase 17 E2)', () => {
  it('counts start..end by step, and restores whatever the counter variable shadowed', () => {
    const { manager, pump } = makePump();
    pump.ctx.variables.set('i', 'untouched');
    manager.addFromWml(
      parseWml(`
      [event]
        name=go
        [for]
          start=0
          end=10
          step=5
          [do]
            [set_variable]
              name=seen
              suffix="$i|,"
            [/set_variable]
          [/do]
        [/for]
      [/event]
    `).child('event')!,
    );

    pump.fire('go');

    expect(pump.ctx.variables.getString('seen')).toBe('0,5,10,');
    expect(pump.ctx.variables.getString('i')).toBe('untouched');
  });

  it('a step that can never reach the end does nothing, rather than looping forever', () => {
    const pump = fire(`
      [event]
        name=go
        [for]
          start=1
          end=4
          step=-1
          [do]
            [set_variable]
              name=ran
              value=yes
            [/set_variable]
          [/do]
        [/for]
      [/event]
    `);

    expect(pump.ctx.variables.getString('ran')).toBe('');
  });
});

describe('[foreach] (Phase 17 E2)', () => {
  /** The shape Under the Burning Suns 1's prestart uses: walk an array of containers, totalling a field. */
  it('walks an array, exposing each element as $this_item and its position as $i', () => {
    const { manager, pump } = makePump();
    pump.ctx.variables.set('pool[0].cost', 12);
    pump.ctx.variables.set('pool[0].name', 'Nym');
    pump.ctx.variables.set('pool[1].cost', 20);
    pump.ctx.variables.set('pool[1].name', 'Zhul');
    pump.ctx.variables.set('pool[2].cost', 8);
    pump.ctx.variables.set('pool[2].name', 'Garak');

    manager.addFromWml(
      parseWml(`
      [event]
        name=go
        [set_variable]
          name=total
          value=0
        [/set_variable]
        [foreach]
          array=pool
          [do]
            [set_variable]
              name=total
              add=$this_item.cost
            [/set_variable]
            [set_variable]
              name=roll_call
              suffix="$i|:$this_item.name| "
            [/set_variable]
          [/do]
        [/foreach]
      [/event]
    `).child('event')!,
    );

    pump.fire('go');

    expect(pump.ctx.variables.getNumber('total')).toBe(40);
    expect(pump.ctx.variables.getString('roll_call')).toBe('0:Nym 1:Zhul 2:Garak ');
  });

  it('edits to $this_item are written back to the array unless readonly=yes', () => {
    const { manager, pump } = makePump();
    pump.ctx.variables.set('pool[0].hp', 10);
    pump.ctx.variables.set('pool[1].hp', 20);

    const body = (readonly: string) => `
      [event]
        name=go
        [foreach]
          array=pool
          ${readonly}
          [do]
            [set_variable]
              name=this_item.hp
              add=5
            [/set_variable]
          [/do]
        [/foreach]
      [/event]
    `;
    manager.addFromWml(parseWml(body('')).child('event')!);
    pump.fire('go');

    expect(pump.ctx.variables.getNumber('pool[0].hp')).toBe(15);
    expect(pump.ctx.variables.getNumber('pool[1].hp')).toBe(25);

    const readonlyRun = makePump();
    readonlyRun.pump.ctx.variables.set('pool[0].hp', 10);
    readonlyRun.manager.addFromWml(parseWml(body('readonly=yes')).child('event')!);
    readonlyRun.pump.fire('go');

    expect(readonlyRun.pump.ctx.variables.getNumber('pool[0].hp')).toBe(10);
  });

  it('an empty or missing array runs the body zero times', () => {
    const pump = fire(`
      [event]
        name=go
        [foreach]
          array=nothing_here
          [do]
            [set_variable]
              name=ran
              value=yes
            [/set_variable]
          [/do]
        [/foreach]
      [/event]
    `);

    expect(pump.ctx.variables.getString('ran')).toBe('');
  });
});

describe('[switch] (Phase 17 E2)', () => {
  it('runs the matching [case], including one that lists several values', () => {
    for (const [weather, expected] of [
      ['rain', 'wet'],
      ['snow', 'wet'],
      ['sun', 'dry'],
    ] as const) {
      const { manager, pump } = makePump();
      pump.ctx.variables.set('weather', weather);
      manager.addFromWml(
        parseWml(`
        [event]
          name=go
          [switch]
            variable=weather
            [case]
              value=rain,snow
              [set_variable]
                name=ground
                value=wet
              [/set_variable]
            [/case]
            [else]
              [set_variable]
                name=ground
                value=dry
              [/set_variable]
            [/else]
          [/switch]
        [/event]
      `).child('event')!,
      );

      pump.fire('go');
      expect(pump.ctx.variables.getString('ground')).toBe(expected);
    }
  });
});

describe('loops are suspendable (Phase 17 E2)', () => {
  it('a [message] inside a [foreach] blocks each iteration in turn', () => {
    const { manager, pump } = makePump();
    pump.ctx.variables.set('roll[0].name', 'Nym');
    pump.ctx.variables.set('roll[1].name', 'Zhul');
    manager.addFromWml(
      parseWml(`
      [event]
        name=go
        [foreach]
          array=roll
          [do]
            [message]
              speaker=narrator
              message="$this_item.name reporting."
            [/message]
          [/do]
        [/foreach]
        [message]
          speaker=narrator
          message="All present."
        [/message]
      [/event]
    `).child('event')!,
    );

    const shown: MessageInteraction[] = [];
    runFlow(pump.fireFlow('go'), (interaction) => {
      if (interaction.kind === 'message') shown.push(interaction);
      return {};
    });

    expect(shown.map((i) => i.message.message)).toEqual(['Nym reporting.', 'Zhul reporting.', 'All present.']);
  });
});
