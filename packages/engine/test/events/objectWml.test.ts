/**
 * Phase 18c: [object] and friends through the real event pump, with real
 * unit types -- object.lua's rules (take_only_once, [filter] or the event's
 * unit, [then]/[else], [found_item]) and the modification tags around it.
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../helpers/realContent.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';

const content = loadRealContent();

function setup(eventsWml: string) {
  const board = new GameBoard(content.map(['Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg']));
  board.addTeam(new Team(1, { gold: 100 }));
  board.addTeam(new Team(2, { gold: 100 }));
  const spearman = Unit.create(content.unitType('Spearman'), 1, new Location(0, 0), { id: 'spear' });
  const corpse = Unit.create(content.unitType('Walking Corpse'), 2, new Location(2, 2), { id: 'corpse' });
  board.addUnit(spearman);
  board.addUnit(corpse);
  const manager = new EventManager();
  for (const ev of parseWml(eventsWml).children('event')) manager.addFromWml(ev);
  const pump = new EventPump(manager, { board, variables: new VariableStore(), resolveType: (id) => content.unitType(id) });
  return { board, pump, spearman, corpse };
}

describe('[object]', () => {
  it("gives the event's unit the object once (take_only_once), runs [then]/[else], and [found_item] knows", () => {
    const { pump, spearman } = setup(`
      [event]
        name=moveto
        first_time_only=no
        [object]
          id=boots
          silent=yes
          [effect]
            apply_to=movement
            increase=1
          [/effect]
          [then]
            [set_variable]
              name=taken
              add=1
            [/set_variable]
          [/then]
        [/object]
        [if]
          [found_item]
            id=boots
          [/found_item]
          [then]
            [set_variable]
              name=found
              value=yes
            [/set_variable]
          [/then]
        [/if]
      [/event]
    `);
    const moves = spearman.maxMoves;
    pump.fire('moveto', spearman.location);
    pump.fire('moveto', spearman.location);
    expect(spearman.maxMoves).toBe(moves + 1);
    expect(pump.ctx.variables.get('taken')).toBe(1);
    expect(pump.ctx.variables.get('found')).toBe(true);
    expect(spearman.modifications.filter((m) => m.kind === 'object')).toHaveLength(1);
  });

  it('with a [filter] matching nobody it runs [else]; the popup shows cannot_use_message', () => {
    const { pump } = setup(`
      [event]
        name=probe
        [object]
          id=crown
          name="Crown"
          cannot_use_message="Only a king may wear it."
          [filter]
            id=nobody
          [/filter]
          [effect]
            apply_to=hitpoints
            increase_total=10
          [/effect]
          [else]
            [set_variable]
              name=refused
              value=yes
            [/set_variable]
          [/else]
        [/object]
      [/event]
    `);
    pump.fire('probe');
    expect(pump.ctx.variables.get('refused')).toBe(true);
    expect(pump.ctx.messages.at(-1)?.message).toBe('Only a king may wear it.');
  });

  it("Dead Water 1's RECRUIT_UNIT_VARIATIONS shape: an [object] with apply_to=variation makes the corpse a swimmer", () => {
    const { pump, corpse } = setup(`
      [event]
        name=probe
        [object]
          duration=forever
          silent=yes
          [filter]
            x=3
            y=3
          [/filter]
          [effect]
            apply_to=variation
            name=swimmer
          [/effect]
          [effect]
            apply_to=hitpoints
            heal_full=yes
          [/effect]
        [/object]
      [/event]
    `);
    pump.fire('probe');
    expect(corpse.variation).toBe('swimmer');
    expect(corpse.hitpoints).toBe(corpse.maxHitpoints);
  });
});

describe('[remove_object], [remove_trait], [transform_unit], [modify_unit] modifications', () => {
  it('removes an object by id and a trait by id, rebuilding the unit', () => {
    const { pump, spearman } = setup(`
      [event]
        name=give
        [modify_unit]
          [filter]
            id=spear
          [/filter]
          [object]
            id=shield
            [effect]
              apply_to=hitpoints
              increase_total=7
            [/effect]
          [/object]
          [trait]
            id=strong
            [effect]
              apply_to=attack
              range=melee
              increase_damage=1
            [/effect]
          [/trait]
        [/modify_unit]
      [/event]
      [event]
        name=take
        [remove_object]
          id=spear
          object_id=shield
        [/remove_object]
        [remove_trait]
          id=spear
          trait_id=strong
        [/remove_trait]
      [/event]
    `);
    const hp = spearman.maxHitpoints;
    const damage = spearman.attacks[0]!.damage;
    pump.fire('give');
    expect(spearman.maxHitpoints).toBe(hp + 7);
    expect(spearman.attacks[0]!.damage).toBe(damage + 1);
    pump.fire('take');
    expect(spearman.maxHitpoints).toBe(hp);
    expect(spearman.attacks[0]!.damage).toBe(damage);
    expect(spearman.modifications).toEqual([]);
  });

  it('[transform_unit] transform_to= changes the type, keeping modifications', () => {
    const { pump, spearman } = setup(`
      [event]
        name=probe
        [modify_unit]
          [filter]
            id=spear
          [/filter]
          [object]
            [effect]
              apply_to=hitpoints
              increase_total=2
            [/effect]
          [/object]
        [/modify_unit]
        [transform_unit]
          id=spear
          transform_to=Swordsman
        [/transform_unit]
      [/event]
    `);
    pump.fire('probe');
    expect(spearman.type.id).toBe('Swordsman');
    expect(spearman.maxHitpoints).toBe(content.unitType('Swordsman').hitpoints + 2);
  });

  it('[modify_unit] [effect] applies without recording a modification', () => {
    const { pump, spearman } = setup(`
      [event]
        name=probe
        [modify_unit]
          [filter]
            id=spear
          [/filter]
          [effect]
            apply_to=movement
            set=9
          [/effect]
        [/modify_unit]
      [/event]
    `);
    pump.fire('probe');
    expect(spearman.maxMoves).toBe(9);
    expect(spearman.modifications).toEqual([]);
  });
});

describe('runtime [event] and [remove_event]', () => {
  it('an [event] in an event body registers a handler, stored as written unless delayed_variable_substitution=no', () => {
    const { pump } = setup(`
      [event]
        name=setup
        [set_variable]
          name=who
          value=first
        [/set_variable]
        [event]
          name=later
          id=later_literal
          [set_variable]
            name=literal
            value=$who
          [/set_variable]
        [/event]
        [event]
          name=later
          id=later_now
          delayed_variable_substitution=no
          [set_variable]
            name=substituted
            value=$who
          [/set_variable]
        [/event]
        [set_variable]
          name=who
          value=second
        [/set_variable]
      [/event]
    `);
    pump.fire('later');
    expect(pump.ctx.variables.get('literal')).toBeUndefined();
    pump.fire('setup');
    pump.fire('later');
    expect(pump.ctx.variables.get('literal')).toBe('second');
    expect(pump.ctx.variables.get('substituted')).toBe('first');
  });

  it('[remove_event] id= removes handlers; a duplicate id is not added twice', () => {
    const { pump } = setup(`
      [event]
        name=tick
        id=counter
        first_time_only=no
        [set_variable]
          name=ticks
          add=1
        [/set_variable]
      [/event]
      [event]
        name=stop
        [remove_event]
          id=counter
        [/remove_event]
      [/event]
      [event]
        name=again
        [event]
          name=tick
          id=counter
          first_time_only=no
          [set_variable]
            name=ticks
            add=100
          [/set_variable]
        [/event]
      [/event]
    `);
    pump.fire('again'); // duplicate id while the original is live: ignored
    pump.fire('tick');
    expect(pump.ctx.variables.get('ticks')).toBe(1);
    pump.fire('stop');
    pump.fire('tick');
    expect(pump.ctx.variables.get('ticks')).toBe(1);
    expect(pump.manager.activeConfigs().some((c) => c.getString('id') === 'counter')).toBe(false);
  });
});
