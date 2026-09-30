import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLuaDataDir } from '../../src/dataLua.js';
import { LuaKernel } from '../../src/kernel/kernel.js';
import { BASE_GAME_CONFIG, installBase, installPackage, installStrictMode, loadCore } from '../../src/kernel/base.js';
import { installMathx, installStringx } from '../../src/kernel/stringx.js';
import { MtRng } from '@wesnothweb2/engine/src/rng/MtRng.js';
import { RngDeterministic } from '@wesnothweb2/engine/src/rng/RngDeterministic.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../wesnoth/data');
const files = loadLuaDataDir(dataDir);

export function bootBase(log: string[] = []) {
  const k = new LuaKernel(files, (level, m) => log.push(`${level}: ${m}`));
  const rng = new RngDeterministic(new MtRng(42));
  installStringx(k);
  installMathx(k, () => rng);
  installBase(k, () => BASE_GAME_CONFIG);
  installPackage(k);
  return k;
}

describe('base kernel', () => {
  it('loads package.lua and requires by upstream resolution', () => {
    const k = bootBase();
    k.run(`
      local ls = wesnoth.require "location_set"
      assert(type(ls.create) == "function")
      assert(wesnoth.require("lua/location_set.lua") == ls)
    `, '=t');
  });
  it('stringx and mathx C++ halves', () => {
    const k = bootBase();
    k.run(`
      local t = stringx.split(" a, b ,,c ")
      assert(#t == 3 and t[1] == "a" and t[3] == "c", table.concat(t, "|"))
      assert(("x,y"):split()[2] == "y")
      local lo, hi = stringx.parse_range("3-7")
      assert(lo == 3 and hi == 7)
      assert(stringx.vformat("hi $who", {who = "there"}) == "hi there")
      assert(stringx.join({1,2,3}, "+") == "1+2+3")
      local r = mathx.random(1, 6)
      assert(r >= 1 and r <= 6 and math.type(r) == "integer")
      assert(mathx.round(2.5) == 3 and mathx.round(-2.5) == -3)
      assert(mathx.floor(2.5) == 2)
    `, '=t');
  });
});
