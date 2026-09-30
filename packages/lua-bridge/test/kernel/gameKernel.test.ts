import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameBoard } from '@wesnothweb2/engine/src/model/GameBoard.js';
import { GameMap } from '@wesnothweb2/engine/src/model/Map.js';
import { TerrainTypeData } from '@wesnothweb2/engine/src/model/Terrain.js';
import { Team } from '@wesnothweb2/engine/src/model/Team.js';
import { EventManager, EventPump } from '@wesnothweb2/engine/src/events/pump.js';
import { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { runFlow, type Flow } from '@wesnothweb2/engine/src/events/interaction.js';
import { MtRng } from '@wesnothweb2/engine/src/rng/MtRng.js';
import { RngDeterministic } from '@wesnothweb2/engine/src/rng/RngDeterministic.js';
import { loadLuaDataDir } from '../../src/dataLua.js';
import { createGameKernel } from '../../src/kernel/index.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../wesnoth/data');
const files = loadLuaDataDir(dataDir);

export function makeGame() {
  const map = GameMap.fromMapString('Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg', TerrainTypeData.fromConfigs([]));
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100 }));
  board.addTeam(new Team(2, { gold: 50 }));
  const logs: string[] = [];
  const pump = new EventPump(new EventManager(), {
    board,
    variables: new VariableStore(),
    resolveType: () => {
      throw new Error('no unit types here');
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  const rng = new RngDeterministic(new MtRng(7));
  const host = {
    ctx: () => pump.ctx,
    yieldFlow: (_T: unknown, flow: Flow<unknown>) => {
      runFlow(flow);
      return 0;
    },
    currentSide: () => 1,
  };
  const game = createGameKernel(host, { files, log: (l, m) => logs.push(`${l}: ${m}`), rng: () => rng });
  return { ...game, board, logs, pump };
}

describe('game kernel', () => {
  it('loads data/lua/core with no errors or warnings', () => {
    const { logs } = makeGame();
    expect(logs.filter((l) => !l.startsWith('debug:')).join('\n')).toBe('');
  });

  it('exposes the core Lua halves and the game API', () => {
    const { kernel } = makeGame();
    kernel.run(`
      assert(wesnoth.current.side == 1)
      assert(wesnoth.current.map.playable_width == 2)
      assert(#wesnoth.sides == 2 and wesnoth.sides[2].gold == 50)
      assert(wesnoth.sides.is_enemy(1, 2))
      assert(type(mathx.random_choice) == "function")
      assert(stringx.starts_with("abc", "ab"))
      local t = wml.tag.foo { a = 1 }
      assert(t[1] == "foo" and t.tag == "foo" and t[2].a == 1)
      assert(wesnoth.map.distance_between(1, 1, 3, 1) == 2)
      local locs = wesnoth.map.find { x = "1-2", y = 1 }
      assert(#locs == 2 and locs[1].x == 1)
      wml.variables.foo = 5
      assert(wml.variables.foo == 5)
    `, '=t');
  });

  it('is strict about undefined globals, as upstream', () => {
    const { kernel } = makeGame();
    expect(() => kernel.run('local x = undefined_global_name', '=t')).toThrow(/undefined_global_name/);
  });
});
