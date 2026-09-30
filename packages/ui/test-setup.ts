import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLuaDataDir } from '@wesnothweb2/lua-bridge/src/dataLua.js';
import { setLuaDataFiles } from './src/luaData.js';

setLuaDataFiles(loadLuaDataDir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../wesnoth/data')));
