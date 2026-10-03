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
import type { FloatingLabelRequest } from '@wesnothweb2/engine/src/events/floatingLabels.js';

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

  it('filesystem.have_asset finds the map files the snapshot carries; image_size the measured images', () => {
    const { kernel, pump } = makeGame();
    pump.ctx.mapFile = (name) => (name === '02_Flight_of_the_Elves-winter.map' ? 'Gg' : undefined);
    pump.ctx.imageSize = (p) => (p === 'units/elves-wood/marksman-die-5.png' ? [144, 120] : undefined);
    kernel.run(`
      assert(filesystem.have_asset(filesystem.asset_type.MAP, '02_Flight_of_the_Elves-winter.map'))
      assert(not filesystem.have_asset(filesystem.asset_type.MAP, '02_Flight_of_the_Elves-summer.map'))
      local w, h = filesystem.image_size('units/elves-wood/marksman-die-5.png')
      assert(w == 144 and h == 120)
    `, '=t');
    expect(() => kernel.run("filesystem.image_size('nope.png')", '=t')).toThrow(/not recorded/);
  });

  it('add_known_unit accepts a unit type and rejects an unknown one (intf_add_known_unit)', () => {
    const { kernel, pump } = makeGame();
    pump.ctx.resolveType = (id: string) => {
      if (id !== 'Orcish Grunt') throw new Error(`unknown type ${id}`);
      return { id } as never;
    };
    kernel.run('wesnoth.add_known_unit("Orcish Grunt")', '=t');
    expect(() => kernel.run('wesnoth.add_known_unit("No Such Unit")', '=t')).toThrow(/unknown unit type: 'No Such Unit'/);
  });
});

describe('floating labels (wesnoth.interface.float_label, add_overlay_text)', () => {
  function withLabels() {
    const game = makeGame();
    const seen: FloatingLabelRequest[] = [];
    game.pump.ctx.floatLabel = (r) => seen.push(r);
    return { ...game, seen };
  }

  it('float_label takes a location or two numbers, then the text and an r,g,b colour', () => {
    const { kernel, seen } = withLabels();
    kernel.run('wesnoth.interface.float_label(2, 1, "Hello")\nwesnoth.interface.float_label({x = 1, y = 2}, "Red", "255,0,0")', '=t');
    expect(seen.map((r) => (r.kind === 'hex' ? [r.loc.wmlX, r.loc.wmlY, String(r.text), r.color] : r.kind))).toEqual([
      [2, 1, 'Hello', { r: 107, g: 140, b: 255 }],
      [1, 2, 'Red', { r: 255, g: 0, b: 0 }],
    ]);
  });

  it('add_overlay_text reads its options and gives a handle to replace and remove it', () => {
    const { kernel, seen } = withLabels();
    kernel.run(`
      local label = wesnoth.interface.add_overlay_text("Countdown", {
        size = 30, color = "#ff8000", bgcolor = {0, 0, 0}, bgalpha = 128, duration = "unlimited", fade_time = 0,
        location = {x = 10, y = 20}, halign = "left", valign = "top", max_width = "50%",
      })
      assert(label.valid)
      label:replace("Again", {size = 12})
      label:remove()
      assert(not label.valid)
    `, '=t');
    expect(seen).toMatchObject([
      {
        kind: 'overlay', id: 1, size: 30, color: { r: 255, g: 128, b: 0 }, bgcolor: { r: 0, g: 0, b: 0, a: 128 }, duration: -1, fadeTime: 0,
        x: 10, y: 20, halign: 'left', valign: 'top', maxWidth: { ratio: 0.5 },
      },
      { kind: 'removeOverlay', id: 1 },
      { kind: 'overlay', id: 2, size: 12, duration: 2000, fadeTime: 100, halign: 'center' },
      { kind: 'removeOverlay', id: 2 },
    ]);
  });
});
