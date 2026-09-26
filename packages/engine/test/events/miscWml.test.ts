/**
 * Phase 18d: the store/utility tags upstream defines in Lua (wml-tags.lua)
 * or action_wml.cpp, through the real event pump with real unit types.
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../helpers/realContent.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit, UnitStatus } from '../../src/model/Unit.js';
import { Location, distanceBetween } from '../../src/model/Location.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { findSides } from '../../src/events/sideFilter.js';
import { parseWml } from '../../src/wml/index.js';

const content = loadRealContent();

function setup(body: string, fire = true) {
  // Side 2 starts on the village at wml (3,2).
  const board = new GameBoard(content.map(['1 Gg, Gg, Gg^Vh, Gg', 'Gg, Gg, 2 Gg^Vh, Gg', 'Gg, Gg, Gg, Gg']));
  board.addTeam(new Team(1, { gold: 100, teamName: 'good' }));
  board.addTeam(new Team(2, { gold: 75, teamName: 'bad', income: 3 }));
  const spearman = Unit.create(content.unitType('Spearman'), 1, Location.fromWml(1, 1), { id: 'spear' });
  const corpse = Unit.create(content.unitType('Walking Corpse'), 2, Location.fromWml(4, 3), { id: 'corpse' });
  board.addUnit(spearman);
  board.addUnit(corpse);
  board.captureVillage(Location.fromWml(3, 1), 2);
  const manager = new EventManager();
  manager.addFromWml(parseWml(`[event]\nname=probe\n${body}\n[/event]`).child('event')!);
  const pump = new EventPump(manager, { board, variables: new VariableStore(), resolveType: (id) => content.unitType(id) });
  if (fire) pump.fire('probe');
  return { board, pump, vars: pump.ctx.variables, spearman, corpse };
}

describe('side filter (side_filter.cpp)', () => {
  it('side=, team_name=, [has_unit], [enemy_of] and [not]', () => {
    const { board } = setup('');
    const f = (wml: string) => findSides(board, parseWml(`[f]\n${wml}\n[/f]`).child('f')!);
    expect(f('')).toEqual([1, 2]);
    expect(f('side=2-5')).toEqual([2]);
    expect(f('team_name=good')).toEqual([1]);
    expect(f('[has_unit]\ntype=Walking Corpse\n[/has_unit]')).toEqual([2]);
    expect(f('[enemy_of]\nside=1\n[/enemy_of]')).toEqual([2]);
    expect(f('[not]\nside=1\n[/not]')).toEqual([2]);
  });
});

describe('[store_*]', () => {
  it('[store_starting_location]: the side start, with owner_side on a village', () => {
    const { vars } = setup('[store_starting_location]\nside=2\nvariable=start\n[/store_starting_location]');
    expect(vars.get('start.x')).toBe(3);
    expect(vars.get('start.y')).toBe(2);
    expect(vars.get('start.terrain')).toBe('Gg^Vh');
    expect(vars.get('start.owner_side')).toBe(0);
  });

  it('[store_locations] sorts by (x, y); [store_villages] always writes owner_side; mode=append adds', () => {
    const { vars } = setup(`
      [store_locations]
        terrain=Gg^Vh
        variable=locs
      [/store_locations]
      [store_villages]
        variable=vils
      [/store_villages]
      [store_villages]
        owner_side=2
        variable=vils
        mode=append
      [/store_villages]`);
    expect(vars.arrayLength('locs')).toBe(2);
    expect([vars.get('locs[0].x'), vars.get('locs[0].y'), vars.get('locs[0].owner_side')]).toEqual([3, 1, 2]);
    expect([vars.get('locs[1].x'), vars.get('locs[1].y')]).toEqual([3, 2]);
    expect(vars.arrayLength('vils')).toBe(3);
    expect(vars.get('vils[1].owner_side')).toBe(0);
    expect(vars.get('vils[2].owner_side')).toBe(2);
  });

  it('[store_side]: gold and the economy fields __cfg lacks', () => {
    const { vars } = setup('[store_side]\nside=2\nvariable=s\n[/store_side]');
    expect(vars.get('s.gold')).toBe(75);
    expect(vars.get('s.team_name')).toBe('bad');
    expect(vars.get('s.base_income')).toBe(5); // income=3 + base 2
    expect(vars.get('s.num_villages')).toBe(1);
    expect(vars.get('s.num_units')).toBe(1);
  });

  it('[store_unit_type] needs the type config; an unknown type is an error', () => {
    const { vars } = setup('[store_unit_type]\ntype=Nope\n[/store_unit_type]');
    expect(vars.arrayLength('unit_type')).toBe(0);
  });
});

describe('unit tags', () => {
  it('[hide_unit]/[unhide_unit], [set_recruit]', () => {
    const { spearman, corpse, board } = setup(`
      [hide_unit]
        side=1
      [/hide_unit]
      [hide_unit]
        id=corpse
      [/hide_unit]
      [unhide_unit]
        id=corpse
      [/unhide_unit]
      [set_recruit]
        side=2
        recruit=Skeleton,Ghoul
      [/set_recruit]`);
    expect(spearman.hidden).toBe(true);
    expect(corpse.hidden).toBe(false);
    expect([...board.getTeam(2)!.canRecruit]).toEqual(['Skeleton', 'Ghoul']);
  });

  it('[put_to_recall_list] heal=yes refreshes the unit and moves it to the recall list', () => {
    const { board, pump, spearman } = setup('[put_to_recall_list]\nid=spear\nheal=yes\n[/put_to_recall_list]', false);
    spearman.hitpoints = 3;
    spearman.setStatus(UnitStatus.Poisoned, true);
    pump.fire('probe');
    expect(board.unitAt(Location.fromWml(1, 1))).toBeUndefined();
    expect(board.recallList(1)).toContain(spearman);
    expect(spearman.hitpoints).toBe(spearman.maxHitpoints);
    expect(spearman.statuses.has(UnitStatus.Poisoned)).toBe(false);
  });

  it('[unit_worth]: cost, best advancement cost, health and experience percentages', () => {
    const { vars } = setup('[unit_worth]\nid=spear\n[/unit_worth]');
    const spear = content.unitType('Spearman');
    const best = Math.max(spear.cost, ...spear.advancesTo.map((id) => content.unitType(id).cost));
    expect(vars.get('cost')).toBe(spear.cost);
    expect(vars.get('next_cost')).toBe(best);
    expect(vars.get('health')).toBe(100);
    expect(vars.get('experience')).toBe(0);
    expect(vars.get('unit_worth')).toBe(spear.cost);
  });
});

describe('[modify_turns] / [store_turns]', () => {
  const withTurns = (body: string, limit: number, start: number) => {
    const { pump, vars } = setup(body, false);
    let turn = start;
    pump.ctx.turnLimit = limit;
    pump.ctx.turnNumber = () => turn;
    pump.ctx.setTurnNumber = (t) => (turn = t);
    pump.fire('probe');
    return { limit: pump.ctx.turnLimit, turn, vars };
  };

  it('add= changes the limit and [store_turns] reads it', () => {
    const r = withTurns('[modify_turns]\nadd=5\n[/modify_turns]\n[store_turns]\n[/store_turns]', 10, 2);
    expect(r.limit).toBe(15);
    expect(r.vars.get('turns')).toBe(15);
  });

  it('value= never goes below -1 (no limit), and current= then moves the turn', () => {
    const r = withTurns('[modify_turns]\nvalue=-7\ncurrent=4\n[/modify_turns]', 10, 2);
    expect(r.limit).toBe(-1);
    expect(r.turn).toBe(4);
  });

  it('current= past the (new) limit is refused', () => {
    const r = withTurns('[modify_turns]\nvalue=3\ncurrent=5\n[/modify_turns]', 10, 2);
    expect(r.limit).toBe(3);
    expect(r.turn).toBe(2);
  });
});

describe('[role] (role.lua)', () => {
  it('tries type= in order on the map; reassign=no keeps an existing holder', () => {
    const { corpse, spearman } = setup(`
      [role]
        role=hero
        type=Walking Corpse,Spearman
      [/role]
      [role]
        role=hero
        type=Spearman
        reassign=no
      [/role]`);
    expect(corpse.role).toBe('hero');
    expect(spearman.role).not.toBe('hero');
  });

  it('falls back to the recall list, and runs [else] when nothing matches', () => {
    const { board, pump, vars } = setup(
      `
      [role]
        role=scout
        type=Cavalryman
      [/role]
      [role]
        role=king
        type=Lich
        [else]
          [set_variable]
            name=no_king
            value=yes
          [/set_variable]
        [/else]
      [/role]`,
      false,
    );
    const cav = Unit.create(content.unitType('Cavalryman'), 1, Location.NULL, { id: 'cav' });
    board.addToRecallList(1, cav);
    pump.fire('probe');
    expect(cav.role).toBe('scout');
    expect(vars.get('no_king')).toBe(true);
  });
});

describe('[terrain] (game_board::change_terrain)', () => {
  it('replaces the matching hexes; a village that stops being one is lost by its owner', () => {
    const { board } = setup(`
      [terrain]
        x=3
        y=1
        terrain=Gg
      [/terrain]
      [terrain]
        x=1
        y=3
        terrain=^Vh
        layer=overlay
      [/terrain]`);
    expect(board.map.getTerrain(Location.fromWml(3, 1)).toString()).toBe('Gg');
    expect(board.villageOwner(Location.fromWml(3, 1))).toBeUndefined();
    expect(board.map.getTerrain(Location.fromWml(1, 3)).toString()).toBe('Gg^Vh');
    expect(board.map.villages.some((v) => v.equals(Location.fromWml(1, 3)))).toBe(true);
    expect(board.terrainVersion).toBe(2);
  });

  it('an unknown terrain is an error and changes nothing', () => {
    const { board } = setup('[terrain]\nx=1\ny=1\nterrain=Zz\n[/terrain]');
    expect(board.terrainVersion).toBe(0);
  });

  it('GameMap.write round-trips real map data, starting positions included', () => {
    const { board } = setup('');
    const again = board.map.parseSibling(board.map.write());
    expect(again.write()).toBe(board.map.write());
    expect(again.startingPosition(2).equals(Location.fromWml(3, 2))).toBe(true);
  });
});

describe('[insert_tag] (vconfig)', () => {
  it('inserts a tag built by an earlier action in the same body -- the UtBS 3 camp events', () => {
    const { pump, vars } = setup(`
      [set_variables]
        name=camp_event
        [value]
          name=camp_reached
          [set_variable]
            name=reached
            value=yes
          [/set_variable]
        [/value]
      [/set_variables]
      [insert_tag]
        name=event
        variable=camp_event
      [/insert_tag]
      [insert_tag]
        name=set_variable
        variable=nothing_here
      [/insert_tag]`);
    pump.fire('camp_reached');
    expect(vars.get('reached')).toBe(true);
  });
});

describe('[random_placement] (random_placement.lua)', () => {
  const run = (body: string) => {
    const board = new GameBoard(content.map(['Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg']));
    const manager = new EventManager();
    manager.addFromWml(parseWml(`[event]\nname=probe\n${body}\n[/event]`).child('event')!);
    const pump = new EventPump(manager, {
      board,
      variables: new VariableStore(),
      resolveType: (id) => content.unitType(id),
      rng: new RngDeterministic(new MtRng(7)),
    });
    pump.ctx.variables.set('spot', 'kept');
    pump.fire('probe');
    return pump.ctx.variables;
  };
  const body = (numItems: string, distance: number) => `
    [random_placement]
      num_items=${numItems}
      variable=spot
      min_distance=${distance}
      allow_less=yes
      [command]
        [set_variables]
          name=placed
          mode=append
          [value]
            x=$spot.x
            y=$spot.y
            n=$spot.n
          [/value]
        [/set_variables]
      [/command]
    [/random_placement]`;
  const placed = (vars: VariableStore) =>
    Array.from({ length: vars.arrayLength('placed') }, (_, i) => [vars.getNumber(`placed[${i}].x`), vars.getNumber(`placed[${i}].y`)]);

  it('places distinct hexes, numbers them, and restores the variable', () => {
    const vars = run(body('4', 0));
    const spots = placed(vars);
    expect(spots).toHaveLength(4);
    expect(new Set(spots.map((s) => s.join(','))).size).toBe(4);
    expect(vars.getNumber('placed[3].n')).toBe(4);
    expect(vars.get('spot')).toBe('kept');
  });

  it('min_distance keeps items apart; allow_less stops quietly when space runs out', () => {
    const spots = placed(run(body('(size)', 2)));
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.length).toBeLessThan(20);
    for (const [ax, ay] of spots) {
      for (const [bx, by] of spots) {
        if (ax === bx && ay === by) continue;
        expect(distanceBetween(Location.fromWml(ax!, ay!), Location.fromWml(bx!, by!))).toBeGreaterThan(2);
      }
    }
  });
});
