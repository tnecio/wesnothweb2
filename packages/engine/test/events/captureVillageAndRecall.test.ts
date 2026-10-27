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
import { WmlConfig } from '../../src/wml/config.js';

/**
 * Real-shaped fixture for the two new action tags this file covers:
 * `[capture_village]` (mirrors `wml_actions.capture_village` in
 * `data/lua/wml-tags.lua`) and `[recall]` (mirrors
 * `WML_HANDLER_FUNCTION(recall, ...)` in `src/game_events/action_wml.cpp`).
 * `borderSize=0` (unlike `pumpAndActions.test.ts`'s default-bordered
 * fixture) so the raw map text's row/column indices are exactly the
 * engine's own (x, y) -- see docs/PROGRESS.md's note on the off-map-border
 * off-by-one this avoided finding the hard way earlier this project.
 */
function makeTerrainData(): TerrainTypeData {
  const grass = new WmlConfig();
  grass.setAttribute('id', 'grass');
  grass.setAttribute('string', 'Gg');

  const castle = new WmlConfig();
  castle.setAttribute('id', 'castle');
  castle.setAttribute('string', 'Ch');
  castle.setAttribute('recruit_onto', true);

  const keep = new WmlConfig();
  keep.setAttribute('id', 'keep');
  keep.setAttribute('string', 'Kh');
  keep.setAttribute('recruit_onto', true);
  keep.setAttribute('recruit_from', true);

  const village = new WmlConfig();
  village.setAttribute('id', 'village');
  village.setAttribute('string', 'Gg^Vh');
  village.setAttribute('gives_income', true);

  return TerrainTypeData.fromConfigs([grass, castle, keep, village]);
}

/**
 * 5x5 board (engine coords 0..4): keep at (1,1), two castle tiles at
 * (2,1)/(1,2) connected to it, one village at (4,4), rest grass.
 */
function makeBoard(): { board: GameBoard; villageLoc: Location; keepLoc: Location; castleLoc: Location } {
  const terrainData = makeTerrainData();
  const rows = ['Gg,Gg,Gg,Gg,Gg', 'Gg,Kh,Ch,Gg,Gg', 'Gg,Ch,Gg,Gg,Gg', 'Gg,Gg,Gg,Gg,Gg', 'Gg,Gg,Gg,Gg,Gg^Vh'];
  const map = GameMap.fromMapString(rows.join('\n'), terrainData, 0);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100, recallCost: 20 }));
  board.addTeam(new Team(2, { gold: 100 }));
  const villageLoc = new Location(4, 4);
  const keepLoc = new Location(1, 1);
  const castleLoc = new Location(2, 1);
  expect(map.isVillage(villageLoc)).toBe(true);
  expect(map.isKeep(keepLoc)).toBe(true);
  expect(map.isCastle(castleLoc)).toBe(true);
  return { board, villageLoc, keepLoc, castleLoc };
}

function makeUnitType(id: string, recallCost = -1): UnitType {
  const terrainData = makeTerrainData();
  const moveType = MoveType.fromConfig(parseWml(''), terrainData);
  const attack = AttackType.fromConfig(parseWml(''));
  return new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 14, recallCost, 500, [], '', true, false, false, moveType, [attack], []);
}

function makePump(board: GameBoard, log?: (level: string, msg: string) => void) {
  const manager = new EventManager();
  const variables = new VariableStore();
  const moverType = makeUnitType('mover');
  const pump = new EventPump(manager, {
    board,
    variables,
    resolveType: () => moverType,
    log: log as EventPump['ctx']['log'] | undefined,
  });
  return { manager, pump };
}

describe('[capture_village] action (mirrors wml_actions.capture_village)', () => {
  it('assigns a village matching x=/y= to the given side= and leaves other villages untouched', () => {
    const { board, villageLoc } = makeBoard();
    const { manager, pump } = makePump(board);
    expect(board.villageOwner(villageLoc)).toBeUndefined();

    manager.addFromWml(parseWml(`
[event]
name=go
[capture_village]
side=1
x=${villageLoc.wmlX}
y=${villageLoc.wmlY}
[/capture_village]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.villageOwner(villageLoc)).toBe(1);
    expect(board.villageCount(1)).toBe(1);
  });

  it('reassigns an already-owned village to a new side, and side=0 neutralises it', () => {
    const { board, villageLoc } = makeBoard();
    board.captureVillage(villageLoc, 2);
    const { manager, pump } = makePump(board);

    manager.addFromWml(parseWml(`
[event]
name=go
[capture_village]
side=1
x=${villageLoc.wmlX}
y=${villageLoc.wmlY}
[/capture_village]
[/event]
`).child('event')!);
    pump.fire('go');
    expect(board.villageOwner(villageLoc)).toBe(1);

    manager.addFromWml(parseWml(`
[event]
name=neutralize
[capture_village]
side=0
x=${villageLoc.wmlX}
y=${villageLoc.wmlY}
[/capture_village]
[/event]
`).child('event')!);
    pump.fire('neutralize');
    expect(board.villageOwner(villageLoc)).toBeUndefined();
  });

  it('without x=/y= matches every real village on the map', () => {
    const terrainData = makeTerrainData();
    const map = GameMap.fromMapString('Gg,Gg^Vh,Gg\nGg,Gg,Gg^Vh', terrainData, 0);
    const board = new GameBoard(map);
    board.addTeam(new Team(1));
    const { manager, pump } = makePump(board);

    manager.addFromWml(parseWml(`
[event]
name=go
[capture_village]
side=1
[/capture_village]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.villageCount(1)).toBe(2);
  });

  it('without side= or [filter_side], the matching villages belong to no side (`set_owner(loc, nil)`)', () => {
    const { board, villageLoc } = makeBoard();
    board.captureVillage(villageLoc, 2);
    const { manager, pump } = makePump(board);

    manager.addFromWml(parseWml(`
[event]
name=go
[capture_village]
x=${villageLoc.wmlX}
y=${villageLoc.wmlY}
[/capture_village]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.villageOwner(villageLoc)).toBeUndefined();
  });

  it('[filter_side] names the side: the first one it matches', () => {
    const { board, villageLoc } = makeBoard();
    const { manager, pump } = makePump(board);

    manager.addFromWml(parseWml(`
[event]
name=go
[capture_village]
x=${villageLoc.wmlX}
y=${villageLoc.wmlY}
[filter_side]
side=2
[/filter_side]
[/capture_village]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.villageOwner(villageLoc)).toBe(2);
  });

  it("{STARTING_VILLAGES}: variables inside [and] are substituted, so only the villages in the radius are taken", () => {
    // Real, reported bug: read without its variables, the radius filter matched every village (Son of the
    // Black Eye 1 began with all of them Alber's). A village at (0,4) and one at (4,4); the side starts at (0,0).
    const terrainData = makeTerrainData();
    const rows = ['Gg,Gg,Gg,Gg,Gg', 'Gg,Gg,Gg,Gg,Gg', 'Gg,Gg,Gg,Gg,Gg', 'Gg,Gg,Gg,Gg,Gg', 'Gg^Vh,Gg,Gg,Gg,Gg^Vh'];
    const board = new GameBoard(GameMap.fromMapString(rows.join('\n'), terrainData, 0));
    board.addTeam(new Team(1));
    const { manager, pump } = makePump(board);
    pump.ctx.variables.set('start.x', 1);
    pump.ctx.variables.set('start.y', 1);

    manager.addFromWml(parseWml(`
[event]
name=go
[capture_village]
side=1
terrain=*^V*
[and]
x,y=$start.x,$start.y
radius=4
[/and]
[/capture_village]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.villageOwner(new Location(0, 4))).toBe(1);
    expect(board.villageOwner(new Location(4, 4))).toBeUndefined();
  });
});

describe('[recall] action (mirrors WML_HANDLER_FUNCTION(recall, ...))', () => {
  // The test unit types have no movement costs (every hex is unreachable to them), so these tags skip the
  // passability check, as `check_passability=no` does upstream.
  it("recalls the first recall-list unit matching id= next to its side's leader when no x=/y= is given: free, with full moves", () => {
    const { board, keepLoc } = makeBoard();
    const leader = Unit.create(makeUnitType('Leader'), 1, keepLoc, { canRecruit: true });
    board.addUnit(leader);
    const hero = Unit.create(makeUnitType('Hero', 12), 1, Location.NULL, { id: 'Hero' });
    board.addToRecallList(1, hero);
    const { manager, pump } = makePump(board);
    const team = board.getTeam(1)!;
    const goldBefore = team.gold;

    manager.addFromWml(parseWml(`
[event]
name=go
[recall]
id=Hero
check_passability=no
[/recall]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.recallList(1)).toHaveLength(0);
    const placed = board.allUnits().find((u) => u.id === 'Hero');
    expect(placed).toBeDefined();
    // find_vacant_tile from the leader's (occupied) hex: the lowest x, then y, of the first ring (0-based 0,1).
    expect(placed!.location.toString()).toBe('1,2');
    expect(placed!.hitpoints).toBe(placed!.maxHitpoints);
    // `place_recruit(..., cost 0, ..., full_movement=true)`, unlike a player's recall.
    expect(team.gold).toBe(goldBefore);
    expect(placed!.movesLeft).toBe(placed!.maxMoves);
  });

  it('recalls to an explicit x=/y= castle tile when given and legal', () => {
    const { board, keepLoc, castleLoc } = makeBoard();
    const leader = Unit.create(makeUnitType('Leader'), 1, keepLoc, { canRecruit: true });
    board.addUnit(leader);
    const hero = Unit.create(makeUnitType('Hero'), 1, Location.NULL, { id: 'Hero' });
    board.addToRecallList(1, hero);
    const { manager, pump } = makePump(board);

    manager.addFromWml(parseWml(`
[event]
name=go
[recall]
id=Hero
x=${castleLoc.wmlX}
y=${castleLoc.wmlY}
check_passability=no
[/recall]
[/event]
`).child('event')!);
    pump.fire('go');

    const placed = board.unitAt(castleLoc);
    expect(placed?.id).toBe('Hero');
  });

  it('is a no-op (logged) when no recall-list unit on any side matches the filter', () => {
    const { board } = makeBoard();
    const logs: string[] = [];
    const { manager, pump } = makePump(board, (level, msg) => logs.push(`${level}: ${msg}`));

    manager.addFromWml(parseWml(`
[event]
name=go
[recall]
id=Nobody
[/recall]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.allUnits()).toHaveLength(0);
    expect(logs.some((l) => l.includes('[recall]'))).toBe(true);
  });

  it('is a no-op (logged, unit stays on the recall list) when the matching side has no leader and no x=/y= is given', () => {
    const { board } = makeBoard();
    // No leader placed at all for side 1 this time.
    const hero = Unit.create(makeUnitType('Hero'), 1, Location.NULL, { id: 'Hero' });
    board.addToRecallList(1, hero);
    const logs: string[] = [];
    const { manager, pump } = makePump(board, (level, msg) => logs.push(`${level}: ${msg}`));

    manager.addFromWml(parseWml(`
[event]
name=go
[recall]
id=Hero
[/recall]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.recallList(1)).toHaveLength(1);
    expect(board.allUnits()).toHaveLength(0);
    expect(logs.some((l) => l.includes('[recall]'))).toBe(true);
  });

  it("recalls to x=/y= with no leader on the side (TDG 00's {RECALL_XY Delfador 1 6})", () => {
    const { board } = makeBoard();
    const hero = Unit.create(makeUnitType('Delfador'), 1, Location.NULL, { id: 'Delfador' });
    board.addToRecallList(1, hero);
    board.addUnit(Unit.create(makeUnitType('Blocker'), 2, new Location(0, 2)));
    const { manager, pump } = makePump(board);

    manager.addFromWml(parseWml(`
[event]
name=go
[recall]
id=Delfador
x,y=1,3
check_passability=no
[/recall]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.recallList(1)).toHaveLength(0);
    // 1,3 is taken: the nearest vacant tile instead, 1,2.
    expect(board.allUnits().find((u) => u.id === 'Delfador')?.location.toString()).toBe('1,2');
  });
});

describe('[unit] to_variable= (WML_HANDLER_FUNCTION(unit))', () => {
  it('writes the new unit to the variable, with the x,y given, and places nothing', () => {
    const { board } = makeBoard();
    const { manager, pump } = makePump(board);
    manager.addFromWml(parseWml(`
[event]
name=go
[unit]
type=mover
id=Ardonna
side=1
x=3
y=4
hitpoints=7
to_variable=new_lich
[/unit]
[/event]`).child('event')!);
    pump.fire('go');
    expect(board.allUnits()).toHaveLength(0);
    const stored = pump.ctx.variables.getConfig('new_lich');
    expect(stored?.getString('id')).toBe('Ardonna');
    expect(stored?.getString('type')).toBe('mover');
    expect([stored?.getNumber('x'), stored?.getNumber('y'), stored?.getNumber('hitpoints')]).toEqual([3, 4, 7]);
  });
});

describe('[unit] with the id of a recall-list unit (unit_creator::add_unit)', () => {
  it('puts that unit on the map, as it is, instead of making a second one', () => {
    const { board, castleLoc } = makeBoard();
    const hero = Unit.create(makeUnitType('Hero', 12), 1, Location.NULL, { id: 'Hero' });
    hero.experience = 7;
    board.addToRecallList(1, hero);
    const { manager, pump } = makePump(board);

    manager.addFromWml(parseWml(`
[event]
name=go
[unit]
type=mover
id=Hero
side=1
x=${castleLoc.wmlX}
y=${castleLoc.wmlY}
[/unit]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.unitAt(castleLoc)).toBe(hero);
    expect(hero.experience).toBe(7);
    expect(board.recallList(1)).toEqual([]);
    expect(board.allUnits().filter((u) => u.id === 'Hero')).toHaveLength(1);
  });
});

