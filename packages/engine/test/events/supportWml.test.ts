import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Unit, UnitStatus } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';
import { runActionFlow, runActionSequence } from '../../src/events/actionWml.js';
import { autoRespond, runFlow, type Interaction } from '../../src/events/interaction.js';
import { TString } from '../../src/i18n/tstring.js';
import type { FloatingLabelRequest } from '../../src/events/floatingLabels.js';
import { memoryPersistentVariables } from '../../src/events/supportWml.js';

/** Phase 28c: the mainline tags The South Guard needed (`supportWml.ts`, `harmUnitWml.ts`). */

const terrainData = TerrainTypeData.fromConfigs([]);

function makeType(id: string, resistances: Record<string, number> = {}): UnitType {
  const resistance = Object.entries(resistances).map(([k, v]) => `${k}=${v}`).join('\n');
  const moveType = MoveType.fromConfig(parseWml(`[resistance]\n${resistance}\n[/resistance]`), terrainData);
  return new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 1, -1, 500, [], '', true, false, false, moveType, [AttackType.fromConfig(parseWml(''))], []);
}

function setup(mapRows = 3) {
  const row = Array.from({ length: 3 }, () => 'Gg').join(', ');
  const map = GameMap.fromMapString(Array.from({ length: mapRows }, () => row).join('\n'), terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100, teamName: 'a' }));
  board.addTeam(new Team(2, { gold: 100, teamName: 'b' }));
  const types = new Map<string, UnitType>([['Spearman', makeType('Spearman', { blade: 80 })]]);
  const logs: string[] = [];
  const pump = new EventPump(new EventManager(), {
    board,
    variables: new VariableStore(),
    resolveType: (id) => types.get(id) ?? makeType(id),
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  const run = (wml: string) => runActionSequence(parseWml(wml), pump.ctx);
  return { board, ctx: pump.ctx, run, logs };
}

describe('global variables ([set/get/clear_global_variable])', () => {
  it('keep a value across games, per namespace', () => {
    const persistent = memoryPersistentVariables();
    const first = setup();
    first.ctx.persistent = persistent;
    first.run(`[set_variable]
      name=deaths
      value=3
    [/set_variable]
    [set_global_variable]
      namespace=TSG
      from_local=deaths
      to_global=deaths
    [/set_global_variable]`);
    const second = setup();
    second.ctx.persistent = persistent;
    second.run(`[get_global_variable]
      namespace=TSG
      from_global=deaths
      to_local=previous
    [/get_global_variable]
    [get_global_variable]
      namespace=Other
      from_global=deaths
      to_local=elsewhere
    [/get_global_variable]`);
    expect(second.ctx.variables.getNumber('previous')).toBe(3);
    expect(second.ctx.variables.getString('elsewhere')).toBe('');
    second.run(`[clear_global_variable]
      namespace=TSG
      global=deaths
    [/clear_global_variable]
    [get_global_variable]
      namespace=TSG
      from_global=deaths
      to_local=previous
    [/get_global_variable]`);
    expect(second.ctx.variables.getString('previous')).toBe('');
  });

  it('keep arrays as arrays', () => {
    const { ctx, run } = setup();
    ctx.persistent = memoryPersistentVariables();
    run(`[set_variables]
      name=list
      [value]
        n=1
      [/value]
      [value]
        n=2
      [/value]
    [/set_variables]
    [set_global_variable]
      namespace=X
      from_local=list
      to_global=list
    [/set_global_variable]
    [get_global_variable]
      namespace=X
      from_global=list
      to_local=copy
    [/get_global_variable]`);
    expect(ctx.variables.arrayLength('copy')).toBe(2);
    expect(ctx.variables.getNumber('copy[1].n')).toBe(2);
  });
});

describe('small tags', () => {
  it('[disallow_end_turn]/[allow_end_turn] set whether the turn may end, with the reason', () => {
    const { ctx, run } = setup();
    expect(ctx.endTurn.allowed).toBe(true);
    run(`[disallow_end_turn]
      reason=Move your leader first
    [/disallow_end_turn]`);
    expect(ctx.endTurn.allowed).toBe(false);
    expect(ctx.endTurn.reason?.str()).toBe('Move your leader first');
    run('[allow_end_turn]\n[/allow_end_turn]');
    expect(ctx.endTurn).toEqual({ allowed: true });
  });

  it('[unsynced] runs its body', () => {
    const { ctx, run } = setup();
    run(`[unsynced]
      [set_variable]
        name=ran
        value=1
      [/set_variable]
    [/unsynced]`);
    expect(ctx.variables.getNumber('ran')).toBe(1);
  });

  it('[allow_extra_recruit]/[disallow_extra_recruit] change a unit\'s own extra_recruit=', () => {
    const { board, ctx, run } = setup();
    const leader = Unit.create(makeType('Lieutenant'), 1, new Location(1, 1));
    leader.id = 'Deoran';
    board.addUnit(leader);
    run(`[allow_extra_recruit]
      id=Deoran
      extra_recruit=Spearman,Bowman
    [/allow_extra_recruit]`);
    expect(leader.extraRecruit).toEqual(['Spearman', 'Bowman']);
    run(`[disallow_extra_recruit]
      id=Deoran
      extra_recruit=Spearman
    [/disallow_extra_recruit]`);
    expect(leader.extraRecruit).toEqual(['Bowman']);
    expect(leader.toConfig().getString('extra_recruit')).toBe('Bowman');
    void ctx;
  });

  it('[set_extra_recruit] replaces a unit\'s extra_recruit=', () => {
    const { board, run, logs } = setup();
    const leader = Unit.create(makeType('Lieutenant'), 1, new Location(1, 1));
    leader.id = 'Konrad';
    leader.extraRecruit = ['Spearman'];
    board.addUnit(leader);
    run(`[set_extra_recruit]
      id=Konrad
      extra_recruit=Elvish Fighter, Elvish Archer
    [/set_extra_recruit]`);
    expect(leader.extraRecruit).toEqual(['Elvish Fighter', 'Elvish Archer']);
    run('[set_extra_recruit]\nid=Konrad\n[/set_extra_recruit]');
    expect(logs).toContain('error: [set_extra_recruit] missing required extra_recruit= attribute');
    expect(leader.extraRecruit).toEqual(['Elvish Fighter', 'Elvish Archer']);
  });

  it('[petrify]/[unpetrify] change the petrified status on the map and on recall lists', () => {
    const { board, run } = setup();
    const statue = Unit.create(makeType('Spearman'), 2, new Location(1, 1));
    const recalled = Unit.create(makeType('Spearman'), 2, Location.NULL);
    const other = Unit.create(makeType('Bowman'), 2, new Location(2, 2));
    board.addUnit(statue);
    board.addUnit(other);
    board.addToRecallList(2, recalled);
    run('[petrify]\ntype=Spearman\n[/petrify]');
    expect([statue.petrified, recalled.petrified, other.petrified]).toEqual([true, true, false]);
    expect(statue.incapacitated).toBe(true);
    run('[unpetrify]\nside=2\n[/unpetrify]');
    expect([statue.petrified, recalled.petrified, other.petrified]).toEqual([false, false, false]);
  });

  it('[end_turn] forces the end of the turn', () => {
    const { ctx, run } = setup();
    expect(ctx.endTurnForced).toBe(false);
    run('[end_turn]\n[/end_turn]');
    expect(ctx.endTurnForced).toBe(true);
  });

  it('[set_achievement] reports to the achievement sink', () => {
    const { ctx, run } = setup();
    const got: string[] = [];
    ctx.achievements = { set: (c, id) => got.push(`${c}:${id}`), setSub: () => {}, progress: () => {} };
    run(`[set_achievement]
      content_for=tsg
      id=tsg_s1
    [/set_achievement]`);
    expect(got).toEqual(['tsg:tsg_s1']);
  });
});

describe('[open_help]', () => {
  it('shows the help at its topic, and the event waits for it (an openHelp beat)', () => {
    const { ctx } = setup();
    const seen: Interaction[] = [];
    runFlow(runActionFlow(parseWml('[open_help]\n  topic=unit_Fencer\n[/open_help]'), ctx), (i) => (seen.push(i), autoRespond(i)));
    expect(seen).toEqual([{ kind: 'beat', beat: { kind: 'openHelp', topic: 'unit_Fencer' } }]);
  });
});

describe('[story] in an event', () => {
  it('shows its parts on the story screen (a story beat); title= or the scenario name titles show_title parts', () => {
    const { ctx } = setup();
    ctx.scenarioName = () => TString.literal('Squidville');
    ctx.variables.set('ending', 'bad');
    const seen: Interaction[] = [];
    runFlow(
      runActionFlow(
        parseWml(`[story]
          [part]
            show_title=yes
            story=The end.
            background=story/end.webp
          [/part]
          [if]
            [variable]
              name=ending
              equals=bad
            [/variable]
            [then]
              [part]
                story=A bad one.
              [/part]
            [/then]
          [/if]
        [/story]
        [story]
          title=Bad Ending
          [part]
            show_title=yes
            story=Overrun.
          [/part]
          [part]
            story=No title here.
          [/part]
        [/story]`),
        ctx,
      ),
      (i) => (seen.push(i), autoRespond(i)),
    );
    const stories = seen.map((i) => (i.kind === 'beat' && i.beat.kind === 'story' ? i.beat.parts.map((p) => [p.title, p.text]) : null));
    expect(stories).toEqual([
      [
        ['Squidville', 'The end.'],
        ['', 'A bad one.'],
      ],
      [
        ['Bad Ending', 'Overrun.'],
        ['', 'No title here.'],
      ],
    ]);
  });
});

describe('floating labels ([floating_text], [print])', () => {
  function capture(ctx: ReturnType<typeof setup>['ctx']): FloatingLabelRequest[] {
    const seen: FloatingLabelRequest[] = [];
    ctx.floatLabel = (r) => seen.push(r);
    return seen;
  }

  it('[floating_text] floats its text on every matching hex, in LABEL_COLOR or color= (r,g,b)', () => {
    const { ctx, run } = setup(5);
    const seen = capture(ctx);
    run('[floating_text]\nx=1\ny=1-2\ntext="+50 gold"\n[/floating_text]');
    run('[floating_text]\nx=1\ny=3\ntext=Ouch\ncolor=255,0,0\n[/floating_text]');
    expect(seen.map((r) => (r.kind === 'hex' ? [r.loc.wmlX, r.loc.wmlY, String(r.text), r.color] : null))).toEqual([
      [1, 1, '+50 gold', { r: 107, g: 140, b: 255 }],
      [1, 2, '+50 gold', { r: 107, g: 140, b: 255 }],
      [1, 3, 'Ouch', { r: 255, g: 0, b: 0 }],
    ]);
  });

  it('[print] shows one label over the map, replacing the last [print]\'s', () => {
    const { ctx, run } = setup();
    const seen = capture(ctx);
    run('[print]\ntext=First\n[/print]');
    run('[print]\ntext=Second\nsize=24\nduration=5000\nred=255\n[/print]');
    expect(seen).toMatchObject([
      { kind: 'overlay', id: 1, size: 15, duration: 2000, fadeTime: 100, color: { r: 107, g: 140, b: 255 }, halign: 'center', valign: 'center' },
      { kind: 'removeOverlay', id: 1 },
      { kind: 'overlay', id: 2, size: 24, duration: 5000, color: { r: 255, g: 0, b: 0 } },
    ]);
  });
});

describe('[replace_map]', () => {
  it('replaces the map, growing it only with expand=yes, and loses villages that are gone', () => {
    const { board, ctx, run, logs } = setup(3);
    const bigger = 'Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg';
    run(`[replace_map]
      map_data="${bigger}"
    [/replace_map]`);
    expect(logs.some((l) => l.includes('expand is not set'))).toBe(true);
    expect(board.map.h()).toBe(1);
    run(`[replace_map]
      map_data="${bigger}"
      expand=yes
    [/replace_map]`);
    expect(board.map.h()).toBe(3);
    void ctx;
  });

  it('puts a unit that would be off the map on its recall list', () => {
    const { board, run } = setup(5);
    const unit = Unit.create(makeType('Spearman'), 1, new Location(1, 2));
    board.addUnit(unit);
    run(`[replace_map]
      map_data="Gg, Gg, Gg\nGg, Gg, Gg\nGg, Gg, Gg"
      shrink=yes
    [/replace_map]`);
    expect(board.unitAt(new Location(1, 2))).toBeUndefined();
    expect(board.recallList(1)).toContain(unit);
  });
});

describe('[harm_unit]', () => {
  function withUnits() {
    const s = setup();
    const victim = Unit.create(makeType('Spearman', { blade: 80 }), 2, new Location(1, 0));
    victim.id = 'victim';
    s.board.addUnit(victim);
    const harmer = Unit.create(makeType('Lieutenant'), 1, new Location(0, 0));
    harmer.id = 'harmer';
    s.board.addUnit(harmer);
    return { ...s, victim, harmer };
  }

  it('deals amount= adjusted by resistance, applies statuses, and records variable=', () => {
    const { victim, run, ctx } = withUnits();
    const hp = victim.hitpoints;
    run(`[harm_unit]
      [filter]
        id=victim
      [/filter]
      amount=10
      damage_type=blade
      poisoned=yes
      variable=harmed
    [/harm_unit]`);
    // 80% multiplier on 10.
    expect(victim.hitpoints).toBe(hp - 8);
    expect(victim.hasStatus(UnitStatus.Poisoned)).toBe(true);
    expect(ctx.variables.getNumber('harmed[0].harm_amount')).toBe(8);
    expect(ctx.variables.getString('harmed[0].id')).toBe('victim');
  });

  it('floats the damage and the statuses given, in red, over the victim', () => {
    const { victim, run, ctx } = withUnits();
    const seen: FloatingLabelRequest[] = [];
    ctx.floatLabel = (r) => seen.push(r);
    run('[harm_unit]\n[filter]\nid=victim\n[/filter]\namount=10\ndamage_type=blade\npoisoned=yes\nslowed=yes\n[/harm_unit]');
    expect(seen).toHaveLength(1);
    const label = seen[0]!;
    expect(label.kind === 'hex' && [label.loc.equals(victim.location), String(label.text), label.color]).toEqual([true, '\t8\npoisoned\nslowed\n', { r: 255, g: 0, b: 0 }]);
  });

  it('reads $this_unit per unit, and kill=no leaves 1 HP', () => {
    const { victim, run, ctx } = withUnits();
    ctx.variables.set('this_unit', 'untouched');
    run(`[harm_unit]
      [filter]
        id=victim
      [/filter]
      amount=$this_unit.hitpoints
      kill=no
    [/harm_unit]`);
    expect(victim.hitpoints).toBe(1);
    expect(ctx.variables.getString('this_unit')).toBe('untouched');
  });

  it('kills, and gives the harmer kill experience when enemies', () => {
    const { board, victim, harmer, run } = withUnits();
    run(`[harm_unit]
      [filter]
        id=victim
      [/filter]
      [filter_second]
        id=harmer
      [/filter_second]
      amount=100
    [/harm_unit]`);
    expect(board.unitAt(victim.location)).toBeUndefined();
    expect(harmer.experience).toBe(8);
  });
});
