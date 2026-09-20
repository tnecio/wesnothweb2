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
import { runFlow, type Interaction } from '../../src/events/interaction.js';

/**
 * Phase 17 E3: the cutscene and camera tags. What matters is the
 * *sequence*: a `[move_unit_fake]`, a spawn and a line of dialogue in one
 * event body must reach the display in the order the WML wrote them,
 * which is the whole point of the suspendable pump.
 *
 * The shape these tests follow is Dead Water 5's own `start` event (a
 * ghost flies in, is spawned for real, speaks, and the undead wave
 * follows); the real scenario is driven end to end from `packages/ui`.
 */

function makeBoard(): GameBoard {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const rows = Array.from({ length: 6 }, () => 'Gg, Gg, Gg, Gg, Gg, Gg').join('\n');
  const map = GameMap.fromMapString(rows, terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100, controller: 'human' }));
  board.addTeam(new Team(2, { gold: 100, controller: 'ai' }));
  return board;
}

function makeResolveType(): (id: string) => UnitType {
  const terrainData = TerrainTypeData.fromConfigs([]);
  // With no registered terrain types every code aliases to itself, so the
  // map's own `Gg` is the movement-cost key (see test/ai/helpers.ts's
  // `flatMoveType` for the same trick): units here can actually walk.
  const moveType = MoveType.fromConfig(parseWml('[movement_costs]\nGg=1\n[/movement_costs]\n[defense]\nGg=50\n[/defense]'), terrainData);
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

/** Everything the event handed to the display, in order, as short labels. */
function play(pump: EventPump, name: string): { labels: string[]; interactions: Interaction[] } {
  const interactions: Interaction[] = [];
  runFlow(pump.fireFlow(name), (interaction) => {
    interactions.push(interaction);
    return {};
  });
  return {
    labels: interactions.map((i) => (i.kind === 'message' ? `message:${i.message.message}` : `beat:${i.beat.kind}`)),
    interactions,
  };
}

function addEvent(manager: EventManager, wml: string): void {
  manager.addFromWml(parseWml(wml).child('event')!);
}

describe('cutscene ordering (Phase 17 E3)', () => {
  it('a fake move, a spawn and a line of dialogue arrive in source order -- the Dead Water 5 shape', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=start
        [move_unit_fake]
          type=Ghost
          side=3
          x=1,4
          y=5,3
        [/move_unit_fake]
        [unit]
          type=Ghost
          id=ghost scout
          x=4
          y=3
          side=2
          animate=yes
        [/unit]
        [message]
          speaker=ghost scout
          message="Found. Them."
        [/message]
      [/event]
    `,
    );

    const { labels, interactions } = play(pump, 'start');

    expect(labels).toEqual(['beat:moveFakeUnits', 'beat:unitAppear', 'message:Found. Them.']);

    // The fake walk is routed between the waypoints, not teleported.
    const walkBeat = interactions[0]!;
    if (walkBeat.kind !== 'beat' || walkBeat.beat.kind !== 'moveFakeUnits') throw new Error('expected a fake-move beat');
    const walk = walkBeat.beat.walks[0]!;
    expect(walk.spec).toMatchObject({ typeId: 'Ghost', side: 3 });
    expect(walk.path[0]).toEqual(Location.fromWml(1, 5));
    expect(walk.path[walk.path.length - 1]).toEqual(Location.fromWml(4, 3));
    expect(walk.path.length).toBeGreaterThan(2);

    // And the spawned unit really is on the board by the time it speaks.
    expect(board.allUnits().map((u) => u.id)).toEqual(['ghost scout']);
  });

  it('[move_unit] walks its route before the event continues, then relocates the unit', () => {
    const board = makeBoard();
    const resolve = makeResolveType();
    const hero = Unit.create(resolve('Hero'), 1, Location.fromWml(1, 1), { id: 'Hero' });
    board.addUnit(hero);
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=go
        [move_unit]
          id=Hero
          to_x=4
          to_y=4
        [/move_unit]
        [message]
          speaker=Hero
          message="Made it."
        [/message]
      [/event]
    `,
    );

    const seen: Array<{ label: string; heroAt: string }> = [];
    runFlow(pump.fireFlow('go'), (interaction) => {
      seen.push({
        label: interaction.kind === 'message' ? 'message' : interaction.beat.kind,
        heroAt: hero.location.key(),
      });
      return {};
    });

    expect(seen.map((s) => s.label)).toEqual(['moveUnit', 'message']);
    // The walk is played from where the unit still stands; only then is
    // the board updated (upstream's move_unit.lua order).
    expect(seen[0]!.heroAt).toBe(Location.fromWml(1, 1).key());
    expect(seen[1]!.heroAt).toBe(Location.fromWml(4, 4).key());
  });

  it('[kill] animate=yes plays the death before the die event and before the unit is removed', () => {
    const board = makeBoard();
    const resolve = makeResolveType();
    board.addUnit(Unit.create(resolve('Villain'), 2, Location.fromWml(3, 3), { id: 'Villain' }));
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=die
        [message]
          speaker=narrator
          message="It falls."
        [/message]
      [/event]
    `,
    );
    addEvent(
      manager,
      `
      [event]
        name=slay
        [kill]
          id=Villain
          animate=yes
          fire_event=yes
        [/kill]
      [/event]
    `,
    );

    const { labels } = play(pump, 'slay');

    expect(labels).toEqual(['beat:unitDeath', 'message:It falls.']);
    expect(board.allUnits()).toEqual([]);
  });

  it('[delay] does nothing before the scenario has started, and blocks once it has', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=prestart
        first_time_only=no
        [delay]
          time=500
        [/delay]
      [/event]
    `,
    );

    pump.ctx.gameStarted = false;
    expect(play(pump, 'prestart').labels).toEqual([]);

    pump.ctx.gameStarted = true;
    expect(play(pump, 'prestart').labels).toEqual(['beat:delay']);
  });

  it('[scroll_to], [lock_view]/[unlock_view] and [screen_fade] carry their real arguments', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=pan
        [lock_view]
        [/lock_view]
        [scroll_to]
          x=3
          y=2
          immediate=yes
        [/scroll_to]
        [screen_fade]
          red,green,blue=0,0,0
          alpha=255
          duration=500
        [/screen_fade]
        [unlock_view]
        [/unlock_view]
      [/event]
    `,
    );

    const { labels, interactions } = play(pump, 'pan');

    expect(labels).toEqual(['beat:lockView', 'beat:scrollTo', 'beat:screenFade', 'beat:lockView']);
    const scroll = interactions[1]!;
    if (scroll.kind !== 'beat' || scroll.beat.kind !== 'scrollTo') throw new Error('expected a scroll beat');
    expect(scroll.beat.location).toEqual(Location.fromWml(3, 2));
    expect(scroll.beat.immediate).toBe(true);
    const fade = interactions[2]!;
    if (fade.kind !== 'beat' || fade.beat.kind !== 'screenFade') throw new Error('expected a fade beat');
    expect(fade.beat).toMatchObject({ alpha: 255, durationMs: 500 });
  });

  it('[animate_unit] names the unit and the animation to play', () => {
    const board = makeBoard();
    const resolve = makeResolveType();
    board.addUnit(Unit.create(resolve('Hero'), 1, Location.fromWml(2, 2), { id: 'Hero' }));
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=go
        [animate_unit]
          flag=levelout
          text="Farewell"
          [filter]
            id=Hero
          [/filter]
        [/animate_unit]
      [/event]
    `,
    );

    const { interactions } = play(pump, 'go');

    const beat = interactions[0]!;
    if (beat.kind !== 'beat' || beat.beat.kind !== 'animateUnit') throw new Error('expected an animate beat');
    expect(beat.beat.unit.id).toBe('Hero');
    expect(beat.beat.flag).toBe('levelout');
    expect(beat.beat.text).toBe('Farewell');
  });

  it('pump() still runs a whole cutscene without a display, as headless callers expect', () => {
    const board = makeBoard();
    const { manager, pump } = makePump(board);
    addEvent(
      manager,
      `
      [event]
        name=start
        [move_unit_fake]
          type=Ghost
          x=1,4
          y=5,3
        [/move_unit_fake]
        [delay]
          time=2000
        [/delay]
        [unit]
          type=Ghost
          id=ghost scout
          x=4
          y=3
          side=2
          animate=yes
        [/unit]
      [/event]
    `,
    );

    pump.fire('start');

    expect(board.allUnits().map((u) => u.id)).toEqual(['ghost scout']);
  });
});
