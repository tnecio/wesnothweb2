/**
 * Phase 29 S8: the data directory's own Lua (`data/lua/**`, `data/ai/**`), which the Lua kernel runs: the core
 * files and the AI's candidate actions. The browser fetches one bundle (`public/lua/data-lua.json`, built by
 * `apps/web/scripts/build-lua-bundle.mjs`) before a scenario starts; Node tests register the files straight
 * from disk (`packages/ui/test-setup.ts`). A `GameSession` built with none has no Lua: its AI plays without
 * the Lua candidate actions, and a scenario's own Lua cannot run.
 */
import { dataUrl } from './dataUrls.js';

export type LuaDataFiles = Readonly<Record<string, string>>;

let files: LuaDataFiles | undefined;
let loading: Promise<LuaDataFiles> | undefined;

/** The registered files, if any. */
export function luaDataFiles(): LuaDataFiles | undefined {
  return files;
}

export function setLuaDataFiles(value: LuaDataFiles | undefined): void {
  files = value;
}

/** Fetches the bundle once per page. */
export function fetchLuaData(): Promise<LuaDataFiles> {
  if (files) return Promise.resolve(files);
  loading ??= (async () => {
    const res = await fetch(dataUrl('lua/data-lua.json'));
    if (!res.ok) throw new Error(`fetch lua/data-lua.json: ${res.status}`);
    files = (await res.json()) as LuaDataFiles;
    return files;
  })();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
