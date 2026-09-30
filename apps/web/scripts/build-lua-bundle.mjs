#!/usr/bin/env node
/**
 * Phase 29 S8: the data directory's own Lua -- `data/lua/**` (the core the Lua kernel runs, the WML-helper
 * libraries) and `data/ai/**` (the AI's candidate actions and micro AIs) -- as one JSON file,
 * `public/lua/data-lua.json` (`{ "lua/core/mathx.lua": "<source>", ... }`). The browser has no data
 * directory; the game fetches this before a scenario starts (`packages/ui/src/luaData.ts`). The Lua 5.4 files
 * fengari cannot parse are replaced by their patched copies, as in Node (`lua-bridge/src/dataLua.ts`).
 *
 * Run: npx tsx apps/web/scripts/build-lua-bundle.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLuaDataDir } from '../../../packages/lua-bridge/src/dataLua.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outFile = path.join(repoRoot, 'apps/web/public/lua/data-lua.json');
const files = loadLuaDataDir(path.join(repoRoot, 'wesnoth/data'));
const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(sorted));
console.log(`wrote ${path.relative(repoRoot, outFile)}: ${Object.keys(sorted).length} files, ${Math.round(fs.statSync(outFile).size / 1024)} KB`);
