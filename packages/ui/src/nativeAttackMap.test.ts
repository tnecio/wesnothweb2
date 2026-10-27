/**
 * The native `battle_calcs.get_attack_map` (`lua-bridge`'s `wesnoth.paths.__port_attack_map`) against upstream's
 * own Lua body, on a real big board (Heir to the Throne 1, 43 units): the same location sets, in the same
 * iteration order, and the board left in the same state (the current side's units are lifted off and put back
 * for each unit of another side, which moves them to the end of the board's list).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoRespond, runFlow, type Flow } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession, type SaveGameData } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = path.join(repoRoot, 'apps/web/scripts/fixtures/perf-httt1-battle.json.gz');

function session(): GameSession {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(fixture)).toString('utf8')) as SaveGameData;
  const suffix = data.difficulty && fs.existsSync(path.join(repoRoot, 'apps/web/public/scenarios/Heir_To_The_Throne', `${data.scenarioId}@${data.difficulty}.json`)) ? `@${data.difficulty}` : '';
  const snapshot = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Heir_To_The_Throne', `${data.scenarioId}${suffix}.json`));
  return GameSession.fromSaveData(snapshot, data);
}

/** Runs the attack maps for the enemies and allies of the side to move, with `native` or upstream's body. */
function attackMaps(native: boolean): string {
  const s = session();
  const runtime = (s as unknown as { luaRuntime: { runChunk(code: string, name: string): Flow } }).luaRuntime;
  runFlow(runtime.runChunk(
    `local BC = wesnoth.require "ai/lua/battle_calcs.lua"
local LS = wesnoth.require "location_set"
-- upstream's get_attack_map, as battle_calcs.lua has it
local function original(units, cfg)
  local attack_map1 = {}
  attack_map1.units = LS.create()
  attack_map1.hitpoints = LS.create()
  for _,unit in ipairs(units) do
    local attack_map2 = BC.get_attack_map_unit(unit, cfg)
    attack_map1.units:union_merge(attack_map2.units, function(x, y, v1, v2) return (v1 or 0) + v2 end)
    attack_map1.hitpoints:union_merge(attack_map2.hitpoints, function(x, y, v1, v2) return (v1 or 0) + v2 end)
  end
  return attack_map1
end
local calls = 0
local native = wesnoth.paths.__port_attack_map
wesnoth.paths.__port_attack_map = function(...)
  calls = calls + 1
  return native(...)
end
local get = ${native ? 'BC.get_attack_map' : 'original'}
local function dump(m)
  local a, b = {}, {}
  for p, v in pairs(m.units.values) do a[#a + 1] = p .. '=' .. v end
  for p, v in pairs(m.hitpoints.values) do b[#b + 1] = p .. '=' .. v end
  return table.concat(a, ' ') .. ' | ' .. table.concat(b, ' ')
end
local side = wesnoth.current.side
local enemies = wesnoth.units.find_on_map { { "filter_side", { { "enemy_of", { side = side } } } } }
local allies = wesnoth.units.find_on_map { { "filter_side", { { "allied_with", { side = side } } } } }
local parts = { dump(get(enemies)), dump(get(allies)), dump(get(allies, { max_moves = true })) }
local order = {}
for _, u in ipairs(wesnoth.units.find_on_map {}) do order[#order + 1] = u.id .. '@' .. u.x .. ',' .. u.y .. ':' .. u.moves end
parts[#parts + 1] = table.concat(order, ' ')
parts[#parts + 1] = tostring(calls)
wml.variables.attack_maps = table.concat(parts, ' # ')`,
    '=attack_map_test',
  ), autoRespond);
  return s.eventPump.ctx.variables.get('attack_maps') as unknown as string;
}

describe('the native attack map (battle_calcs.get_attack_map)', () => {
  it("is upstream's Lua map exactly: contents, iteration order, and the board it leaves", () => {
    const native = attackMaps(true);
    const lua = attackMaps(false);
    expect(native.length).toBeGreaterThan(1000);
    const [nEnemies, nAllies, nAlliesMax, nOrder, nCalls] = native.split(' # ');
    const [lEnemies, lAllies, lAlliesMax, lOrder, lCalls] = lua.split(' # ');
    // The patched module really is the native one, and upstream's body really is Lua.
    expect([nCalls, lCalls]).toEqual(['3', '0']);
    expect(nEnemies).toBe(lEnemies);
    expect(nAllies).toBe(lAllies);
    expect(nAlliesMax).toBe(lAlliesMax);
    expect(nOrder).toBe(lOrder);
  }, 120_000);
});
