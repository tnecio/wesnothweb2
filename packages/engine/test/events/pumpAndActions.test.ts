import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';
import { runActionSequence } from '../../src/events/actionWml.js';

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

  it('[store_unit] kill=yes then [unstore_unit] round-trips a unit off and back onto the board at its original position -- real, reported bug: Liberty scenario 1\'s Baldras was permanently removed because [unstore_unit] wasn\'t implemented at all (silently skipped as an unregistered tag)', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    const leader = Unit.fromConfig(
      parseWml(`[unit]\n  type=Merman Fighter\n  side=1\n  x=1\n  y=2\n  id=Baldras\n  name=Baldras\n  canrecruit=yes\n  experience=25\n[/unit]`).child('unit')!,
      makeResolveType(),
    );
    leader.hitpoints = 30; // damage it, so the restore-with-original-hp path is actually exercised
    board.addUnit(leader);

    const eventCfg = parseWml(`
      [event]
        name=go
        [store_unit]
          variable=goodguys
          kill=yes
          [filter]
            side=1
          [/filter]
        [/store_unit]
        [unstore_unit]
          variable=goodguys
        [/unstore_unit]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);

    pump.fire('go');

    const restored = board.allUnits().find((u) => u.id === 'Baldras');
    expect(restored).toBeDefined();
    expect(restored!.id).toBe('Baldras');
    expect(restored!.name).toBe('Baldras');
    expect(restored!.canRecruit).toBe(true);
    expect(restored!.hitpoints).toBe(30);
    expect(restored!.location.x).toBe(0); // wml x=1,y=2 -> onboard (0,1)
    expect(restored!.location.y).toBe(1);
  });

  it('[unstore_unit] logs an error rather than throwing when the variable is empty/missing', () => {
    const board = makeBoard();
    const warnings: string[] = [];
    const { manager, pump } = makePump(board, (level, msg) => {
      if (level === 'error') warnings.push(msg);
    });
    const eventCfg = parseWml(`
      [event]
        name=go
        [unstore_unit]
          variable=nothing_stored_here
        [/unstore_unit]
      [/event]
    `).child('event')!;
    manager.addFromWml(eventCfg);
    expect(() => pump.fire('go')).not.toThrow();
    expect(warnings.some((w) => w.includes('unstore_unit'))).toBe(true);
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

  describe('[heal_unit] (Phase 14: powers the synthetic Combat campaign\'s "Reset HP" context-menu command)', () => {
    it('with an explicit [filter], heals that unit to full and clears poisoned/slowed', () => {
      const board = makeBoard();
      const { manager, pump } = makePump(board);
      const hero = Unit.fromConfig(parseWml(`[unit]\n  type=Merman Fighter\n  side=1\n  x=1\n  y=1\n  id=hero\n[/unit]`).child('unit')!, makeResolveType());
      hero.hitpoints = 1;
      hero.setStatus('poisoned', true);
      hero.setStatus('slowed', true);
      board.addUnit(hero);

      const eventCfg = parseWml(`
        [event]
          name=go
          [heal_unit]
            [filter]
              id=hero
            [/filter]
          [/heal_unit]
        [/event]
      `).child('event')!;
      manager.addFromWml(eventCfg);

      pump.fire('go');

      expect(hero.hitpoints).toBe(hero.maxHitpoints);
      expect(hero.hasStatus('poisoned')).toBe(false);
      expect(hero.hasStatus('slowed')).toBe(false);
    });

    it('with no [filter], heals whichever unit is at $x1,$y1 -- the real upstream default', () => {
      const board = makeBoard();
      const { manager, pump } = makePump(board);
      const hero = Unit.fromConfig(parseWml(`[unit]\n  type=Merman Fighter\n  side=1\n  x=1\n  y=1\n  id=hero\n[/unit]`).child('unit')!, makeResolveType());
      hero.hitpoints = 3;
      board.addUnit(hero);

      const eventCfg = parseWml(`
        [event]
          name=go
          [heal_unit]
          [/heal_unit]
        [/event]
      `).child('event')!;
      manager.addFromWml(eventCfg);

      pump.fire('go', hero.location);

      expect(hero.hitpoints).toBe(hero.maxHitpoints);
    });

    it('amount= a specific number adds only that much, clamped to max_hitpoints', () => {
      const board = makeBoard();
      const { manager, pump } = makePump(board);
      const hero = Unit.fromConfig(parseWml(`[unit]\n  type=Merman Fighter\n  side=1\n  x=1\n  y=1\n  id=hero\n[/unit]`).child('unit')!, makeResolveType());
      hero.hitpoints = 1;
      board.addUnit(hero);

      const eventCfg = parseWml(`
        [event]
          name=go
          [heal_unit]
            amount=2
            [filter]
              id=hero
            [/filter]
          [/heal_unit]
        [/event]
      `).child('event')!;
      manager.addFromWml(eventCfg);

      pump.fire('go');

      expect(hero.hitpoints).toBe(3);
    });
  });

  describe('[set_menu_item] / [clear_menu_item] (Phase 14: real right-click context-menu entries)', () => {
    it('[set_menu_item] stores an id/description/command triple in ctx.menuItems, and does NOT run the command itself', () => {
      const board = makeBoard();
      const { manager, pump } = makePump(board);

      const eventCfg = parseWml(`
        [event]
          name=prestart
          [set_menu_item]
            id=reset_hp
            description="Reset HP"
            [command]
              [set_variable]
                name=ran
                value=yes
              [/set_variable]
            [/command]
          [/set_menu_item]
        [/event]
      `).child('event')!;
      manager.addFromWml(eventCfg);

      pump.fire('prestart');

      expect(pump.ctx.menuItems.has('reset_hp')).toBe(true);
      expect(pump.ctx.menuItems.get('reset_hp')).toMatchObject({ id: 'reset_hp', description: 'Reset HP' });
      expect(pump.ctx.variables.get('ran')).toBeUndefined();
    });

    it('a stored [command] body can be run later via runActionSequence -- the exact mechanism GameSession.runMenuItem uses', () => {
      const board = makeBoard();
      const { manager, pump } = makePump(board);
      const eventCfg = parseWml(`
        [event]
          name=prestart
          [set_menu_item]
            id=reset_hp
            [command]
              [set_variable]
                name=ran
                value=yes
              [/set_variable]
            [/command]
          [/set_menu_item]
        [/event]
      `).child('event')!;
      manager.addFromWml(eventCfg);
      pump.fire('prestart');

      const def = pump.ctx.menuItems.get('reset_hp')!;
      runActionSequence(def.command, pump.ctx);

      expect(pump.ctx.variables.getBoolean('ran')).toBe(true);
    });

    it('description= defaults to id when omitted', () => {
      const board = makeBoard();
      const { manager, pump } = makePump(board);
      const eventCfg = parseWml(`
        [event]
          name=go
          [set_menu_item]
            id=bare
          [/set_menu_item]
        [/event]
      `).child('event')!;
      manager.addFromWml(eventCfg);
      pump.fire('go');

      expect(pump.ctx.menuItems.get('bare')?.description).toBe('bare');
    });

    it('[clear_menu_item] id= removes just that one entry', () => {
      const board = makeBoard();
      const { manager, pump } = makePump(board);
      const eventCfg = parseWml(`
        [event]
          name=go
          [set_menu_item]
            id=a
          [/set_menu_item]
          [set_menu_item]
            id=b
          [/set_menu_item]
          [clear_menu_item]
            id=a
          [/clear_menu_item]
        [/event]
      `).child('event')!;
      manager.addFromWml(eventCfg);
      pump.fire('go');

      expect(pump.ctx.menuItems.has('a')).toBe(false);
      expect(pump.ctx.menuItems.has('b')).toBe(true);
    });

    it('[clear_menu_item] with no id= clears every menu item', () => {
      const board = makeBoard();
      const { manager, pump } = makePump(board);
      const eventCfg = parseWml(`
        [event]
          name=go
          [set_menu_item]
            id=a
          [/set_menu_item]
          [set_menu_item]
            id=b
          [/set_menu_item]
          [clear_menu_item]
          [/clear_menu_item]
        [/event]
      `).child('event')!;
      manager.addFromWml(eventCfg);
      pump.fire('go');

      expect(pump.ctx.menuItems.size).toBe(0);
    });
  });
});

describe('undo tracking ([allow_undo]/[disallow_undo]/[on_undo], pump.cpp context::state)', () => {
  function withEvents(wml: string) {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    for (const ev of parseWml(wml).children('event')) manager.addFromWml(ev);
    return pump;
  }

  it('an event handler that runs disables undo; one that filters out or does not exist does not', () => {
    const pump = withEvents(`
      [event]
        name=ran
        [set_variable]
          name=x
          value=1
        [/set_variable]
      [/event]
      [event]
        name=filtered
        [filter_condition]
          [variable]
            name=never
            equals=yes
          [/variable]
        [/filter_condition]
      [/event]
    `);
    pump.fire('nobody_listens');
    expect(pump.takeUndoDisabled()).toBe(false);
    pump.fire('filtered');
    expect(pump.takeUndoDisabled()).toBe(false);
    pump.fire('ran');
    expect(pump.takeUndoDisabled()).toBe(true);
    expect(pump.takeUndoDisabled()).toBe(false); // reset by the read
  });

  it('[allow_undo] keeps its handler undoable, [disallow_undo] takes that back, and nested events still count', () => {
    const pump = withEvents(`
      [event]
        name=allowed
        [allow_undo][/allow_undo]
      [/event]
      [event]
        name=allowed_then_not
        [allow_undo][/allow_undo]
        [disallow_undo][/disallow_undo]
      [/event]
      [event]
        name=allowed_but_nested
        [allow_undo][/allow_undo]
        [fire_event]
          name=inner
        [/fire_event]
      [/event]
      [event]
        name=inner
        first_time_only=no
      [/event]
    `);
    pump.fire('allowed');
    expect(pump.takeUndoDisabled()).toBe(false);
    pump.fire('allowed_then_not');
    expect(pump.takeUndoDisabled()).toBe(true);
    pump.fire('allowed_but_nested');
    expect(pump.takeUndoDisabled()).toBe(true);
  });

  it('[on_undo] hands its body to the host, variables substituted unless delayed', () => {
    const pump = withEvents(`
      [event]
        name=go
        [on_undo]
          [set_variable]
            name=a
            value=$who
          [/set_variable]
        [/on_undo]
        [on_undo]
          delayed_variable_substitution=yes
          [set_variable]
            name=b
            value=$who
          [/set_variable]
        [/on_undo]
      [/event]
    `);
    const bodies: string[] = [];
    pump.ctx.addUndoCommands = (cfg) => bodies.push(cfg.child('set_variable')!.getString('value'));
    pump.ctx.variables.set('who', 'Kai');
    pump.fire('go');
    expect(bodies).toEqual(['Kai', '$who']);
  });
});

describe('$unit/$second_unit (scoped_xy_unit) and [disallow_recruit]', () => {
  it('binds $unit and $second_unit to the units at the event locations, for the filter and body, then restores them', () => {
    const board = makeBoard();
    const resolve = makeResolveType();
    board.addUnit(Unit.create(resolve('Spearman'), 1, Location.fromWml(1, 1), { id: 'a' }));
    board.addUnit(Unit.create(resolve('Grunt'), 2, Location.fromWml(2, 2), { id: 'b' }));
    const { manager, pump } = makePump(board);
    for (const ev of parseWml(`
      [event]
        name=probe
        [filter_condition]
          [variable]
            name=unit.type
            equals=Spearman
          [/variable]
        [/filter_condition]
        [set_variable]
          name=seen
          value="$unit.id|/$second_unit.type|"
        [/set_variable]
      [/event]
    `).children('event')) manager.addFromWml(ev);
    pump.ctx.variables.set('unit.type', 'before');
    pump.fire('probe', Location.fromWml(1, 1), Location.fromWml(2, 2));
    expect(pump.ctx.variables.get('seen')).toBe('a/Grunt');
    expect(pump.ctx.variables.get('unit.type')).toBe('before');
    expect(pump.ctx.variables.get('second_unit.type')).toBeUndefined();
  });

  it('LIMIT_RECRUITS-style counting: [disallow_recruit] takes a type off the recruit list, or all of them', () => {
    const board = makeBoard();
    board.getTeam(1)!.canRecruit = new Set(['Spearman', 'Bowman', 'Mage']);
    const { pump } = makePump(board);
    runActionSequence(parseWml('[disallow_recruit]\nside=1\ntype=Bowman\n[/disallow_recruit]'), pump.ctx);
    expect([...board.getTeam(1)!.canRecruit]).toEqual(['Spearman', 'Mage']);
    runActionSequence(parseWml('[disallow_recruit]\nside=1\n[/disallow_recruit]'), pump.ctx);
    expect([...board.getTeam(1)!.canRecruit]).toEqual([]);
  });
});
