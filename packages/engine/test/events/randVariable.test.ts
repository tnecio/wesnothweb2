import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import { parseWml } from '../../src/wml/index.js';

/**
 * Phase 17 E6: `[set_variable] rand=`, a port of `mathx.random_choice`.
 * Two Brothers 2 picks the castle passwords with
 * `{VARIABLE_OP first_password rand "1..4"}` and scenario 3 asks the
 * player to guess one, so the puzzle is only a real puzzle once this
 * works -- and it draws from the session's synced RNG, so the same seed
 * always picks the same password.
 */

function makePump(seed = 1) {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const map = GameMap.fromMapString('Gg, Gg\nGg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100 }));
  const moveType = MoveType.fromConfig(parseWml(''), terrainData);
  const attack = AttackType.fromConfig(parseWml(''));
  const manager = new EventManager();
  const pump = new EventPump(manager, {
    board,
    variables: new VariableStore(),
    resolveType: (id) => new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 1, -1, 500, [], '', true, false, false, moveType, [attack], []),
    rng: new RngDeterministic(new MtRng(seed)),
  });
  return { manager, pump };
}

function fire(manager: EventManager, pump: EventPump, body: string): void {
  manager.addFromWml(parseWml(`[event]\n  name=go\n  first_time_only=no\n${body}\n[/event]`).child('event')!);
  pump.fire('go');
}

describe('[set_variable] rand= (Phase 17 E6)', () => {
  it('picks a number from a range, and only from that range', () => {
    const { manager, pump } = makePump();
    manager.addFromWml(
      parseWml(`
      [event]
        name=go
        first_time_only=no
        [set_variable]
          name=password
          rand=1..4
        [/set_variable]
      [/event]
    `).child('event')!,
    );

    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      pump.fire('go');
      seen.add(pump.ctx.variables.getNumber('password'));
    }

    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('picks from a list of literal values', () => {
    const { manager, pump } = makePump();
    fire(
      manager,
      pump,
      `        [set_variable]
          name=road
          rand=north,south,east,west
        [/set_variable]`,
    );

    expect(['north', 'south', 'east', 'west']).toContain(pump.ctx.variables.getString('road'));
  });

  it('is reproducible: the same seed draws the same value', () => {
    const values = [0, 1].map(() => {
      const { manager, pump } = makePump(7);
      fire(
        manager,
        pump,
        `        [set_variable]
          name=password
          rand=1..100
        [/set_variable]`,
      );
      return pump.ctx.variables.getNumber('password');
    });

    expect(values[0]).toBe(values[1]);
  });

  it('without a game RNG it warns rather than inventing an unsynced number', () => {
    const terrainData = TerrainTypeData.fromConfigs([]);
    const board = new GameBoard(GameMap.fromMapString('Gg, Gg\nGg, Gg', terrainData));
    const moveType = MoveType.fromConfig(parseWml(''), terrainData);
    const attack = AttackType.fromConfig(parseWml(''));
    const manager = new EventManager();
    const logged: string[] = [];
    const pump = new EventPump(manager, {
      board,
      variables: new VariableStore(),
      resolveType: (id) =>
        new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 1, -1, 500, [], '', true, false, false, moveType, [attack], []),
      log: (_level, msg) => logged.push(msg),
    });

    fire(
      manager,
      pump,
      `        [set_variable]
          name=password
          rand=1..4
        [/set_variable]`,
    );

    expect(pump.ctx.variables.getString('password')).toBe('');
    expect(logged.some((m) => m.includes('rand='))).toBe(true);
  });
});

describe('[set_variable] rand= with empty entries', () => {
  it('never picks an empty entry (utils::split drops them)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { manager, pump } = makePump(seed);
      fire(manager, pump, '[set_variable]\nname=random\nrand=Goblin Spearman,Wolf Rider,\n[/set_variable]');
      expect(['Goblin Spearman', 'Wolf Rider']).toContain(pump.ctx.variables.getString('random'));
    }
  });
});
