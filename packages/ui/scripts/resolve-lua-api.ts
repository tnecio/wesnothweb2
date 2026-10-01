/**
 * Which Lua API names the port's Lua runtime has (Phase 28c, for `survey-campaigns.mjs`):
 *
 *   npx tsx packages/ui/scripts/resolve-lua-api.ts <names.json> <out.json>
 *
 * Builds a `LuaRuntime` as a game does -- the kernel, upstream's `data/lua/core` and the runtime's own
 * functions -- and looks each dotted name (`wesnoth.units.find_on_map`) up in it. Writes, per name:
 * `bridged` (it resolves to something real), `unported` (an `unported` stub that raises when called) or
 * `missing` (nothing there). A name `require:<module>` is a core module (`ai/lua/ai_helper.lua`, `wml-utils`):
 * `bridged` if `wesnoth.require` loads it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameBoard } from '@wesnothweb2/engine/src/model/GameBoard.js';
import { GameMap } from '@wesnothweb2/engine/src/model/Map.js';
import { TerrainTypeData } from '@wesnothweb2/engine/src/model/Terrain.js';
import { Team } from '@wesnothweb2/engine/src/model/Team.js';
import { EventManager, EventPump } from '@wesnothweb2/engine/src/events/pump.js';
import { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { LuaRuntime } from '@wesnothweb2/lua-bridge/src/runtime.js';
import { loadLuaDataDir } from '@wesnothweb2/lua-bridge/src/dataLua.js';
import { lua, to_luastring } from '@wesnothweb2/lua-bridge/src/kernel/kernel.js';

const [namesFile, outFile] = process.argv.slice(2);
if (!namesFile || !outFile) throw new Error('usage: resolve-lua-api.ts <names.json> <out.json>');
const names = JSON.parse(fs.readFileSync(namesFile, 'utf8')) as string[];

const dataFiles = loadLuaDataDir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../wesnoth/data'));
const board = new GameBoard(GameMap.fromMapString('Gg, Gg\nGg, Gg', TerrainTypeData.fromConfigs([])));
board.addTeam(new Team(1, { gold: 100 }));
const pump = new EventPump(new EventManager(), {
  board,
  variables: new VariableStore(),
  resolveType: () => {
    throw new Error('no unit types here');
  },
  log: () => {},
});
const runtime = new LuaRuntime({ modules: {}, wml: {} }, () => pump.ctx, { dataFiles });
const { kernel } = runtime;

// Each lookup in its own pcall: strict mode raises on unknown globals, and indexing a userdata can raise.
kernel.run(
  `local function resolves(name)
     local ok, v = pcall(function()
       local root = name:match("^[^.]+")
       -- A core module campaigns keep in a local (\`local helper = wesnoth.require "helper"\`).
       local v = rawget(_G, root) and _G or { [root] = wesnoth.require(root) }
       for part in name:gmatch("[^.]+") do
         if type(v) ~= "table" and type(v) ~= "userdata" then return nil end
         v = v[part]
       end
       return v
     end)
     if ok then return v end
   end
   rawset(_G, "__survey_resolves", resolves)
   rawset(_G, "__survey_loads", function(module) return (pcall(wesnoth.require, module)) end)`,
  '=survey',
);

const result: Record<string, 'bridged' | 'unported' | 'missing'> = {};
const L = kernel.L;
for (const name of names) {
  if (name.startsWith('require:')) {
    lua.lua_getglobal(L, to_luastring('__survey_loads'));
    lua.lua_pushstring(L, to_luastring(name.slice('require:'.length)));
    lua.lua_call(L, 1, 1);
    result[name] = lua.lua_toboolean(L, -1) ? 'bridged' : 'missing';
    lua.lua_pop(L, 1);
    continue;
  }
  lua.lua_getglobal(L, to_luastring('__survey_resolves'));
  lua.lua_pushstring(L, to_luastring(name));
  lua.lua_call(L, 1, 1);
  const found = !lua.lua_isnil(L, -1);
  const stub = lua.lua_iscfunction(L, -1) && kernel.unportedStubs.has(lua.lua_tocfunction(L, -1) as never);
  lua.lua_pop(L, 1);
  result[name] = !found ? 'missing' : stub ? 'unported' : 'bridged';
}
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
