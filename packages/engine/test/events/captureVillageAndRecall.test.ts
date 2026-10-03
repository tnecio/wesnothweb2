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

  it('without side= (and no [filter_side] support) is a no-op, logged rather than silently ignored', () => {
    const { board, villageLoc } = makeBoard();
    const logs: string[] = [];
    const { manager, pump } = makePump(board, (level, msg) => logs.push(`${level}: ${msg}`));

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
    expect(logs.some((l) => l.includes('[capture_village]'))).toBe(true);
  });
});

describe('[recall] action (mirrors WML_HANDLER_FUNCTION(recall, ...))', () => {
  it('recalls the first recall-list unit matching id= onto a vacant castle tile connected to the leader\'s keep when no x=/y= is given', () => {
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
[/recall]
[/event]
`).child('event')!);
    pump.fire('go');

    expect(board.recallList(1)).toHaveLength(0);
    const placed = board.allUnits().find((u) => u.id === 'Hero');
    expect(placed).toBeDefined();
    expect(board.map.isCastle(placed!.location) || board.map.isKeep(placed!.location)).toBe(true);
    expect(placed!.hitpoints).toBe(placed!.maxHitpoints); // recall keeps saved hp -- fresh unit is already full, but exercises the "isRecall" no-heal path for real
    // Unit-instance recallCost (12) overrides the team default (20) -- mirrors recallUnit's own real-content-verified rule.
    expect(team.gold).toBe(goldBefore - 12);
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

  it('is a no-op (logged, unit stays on the recall list) when the matching side has no leader on a keep', () => {
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
