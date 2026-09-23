import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import type { UnitType } from '../../src/model/UnitType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { getTeleportLocations } from '../../src/pathfind/teleport.js';
import { parseWml } from '../../src/wml/index.js';
import { loadRealContent } from '../helpers/realContent.js';

/** Phase 18a: the `[teleport]` and `[tunnel]` ActionWML tags. */
const content = loadRealContent();
const L = (x: number, y: number) => new Location(x, y);

function setup() {
  const row = 'Gg, Gg, Gg, Gg, Gg^Vh, Gg';
  const board = new GameBoard(content.map([row, 'Gg, Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg, Gg']));
  board.addTeam(new Team(1, { teamName: 'a' }));
  board.addTeam(new Team(2, { teamName: 'b' }));
  const hero = Unit.create(content.unitType('Spearman'), 1, L(0, 0), { id: 'Hero' });
  board.addUnit(hero);
  return { board, hero };
}

function run(board: GameBoard, body: string): void {
  const manager = new EventManager();
  manager.addFromWml(parseWml(`[event]\nname=go\n${body}\n[/event]`).child('event')!);
  const pump = new EventPump(manager, {
    board,
    variables: new VariableStore(),
    resolveType: (id: string): UnitType => content.unitType(id),
  });
  pump.fire('go');
}

describe('[teleport]', () => {
  it('moves the filtered unit, captures a village there', () => {
    const { board, hero } = setup();
    run(board, '[teleport]\n[filter]\nid=Hero\n[/filter]\nx,y=5,1\n[/teleport]');
    expect(hero.location.equals(L(4, 0))).toBe(true);
    expect(board.villageOwner(L(4, 0))).toBe(1);
  });

  it('lands on the nearest vacant hex when the target is taken', () => {
    const { board, hero } = setup();
    board.addUnit(Unit.create(content.unitType('Spearman'), 2, L(3, 2)));
    run(board, '[teleport]\n[filter]\nid=Hero\n[/filter]\nx,y=4,3\n[/teleport]');
    expect(hero.location.equals(L(3, 2))).toBe(false);
    expect(Math.abs(hero.location.x - 3) + Math.abs(hero.location.y - 2)).toBeLessThanOrEqual(2);
  });

  it('does nothing when no unit matches', () => {
    const { board, hero } = setup();
    run(board, '[teleport]\n[filter]\nid=Nobody\n[/filter]\nx,y=5,1\n[/teleport]');
    expect(hero.location.equals(L(0, 0))).toBe(true);
  });
});

describe('[tunnel]', () => {
  const tunnel = '[tunnel]\nid=gate\n[source]\nx,y=1,1\n[/source]\n[target]\nx,y=6,3\n[/target]\n[filter]\nside=1\n[/filter]\n[/tunnel]';

  it('adds a two-way tunnel the filtered units can use', () => {
    const { board, hero } = setup();
    run(board, tunnel);
    expect(getTeleportLocations(board, hero).adjacents(L(0, 0)).map((l) => l.key())).toEqual(['5,2']);
    expect(getTeleportLocations(board, hero).adjacents(L(5, 2)).map((l) => l.key())).toEqual(['0,0']);
  });

  it('remove=yes takes it away again', () => {
    const { board, hero } = setup();
    run(board, tunnel);
    run(board, '[tunnel]\nremove=yes\nid=gate\n[/tunnel]');
    expect(getTeleportLocations(board, hero).isEmpty).toBe(true);
  });

  it('a tunnel missing [filter] is rejected', () => {
    const { board, hero } = setup();
    run(board, '[tunnel]\n[source]\nx,y=1,1\n[/source]\n[target]\nx,y=6,3\n[/target]\n[/tunnel]');
    expect(getTeleportLocations(board, hero).isEmpty).toBe(true);
  });
});
