/**
 * Virtual filesystem for `wesnoth/data/lua/`: serves every file straight off
 * disk from the `wesnoth` git submodule, EXCEPT the 8 files that use Lua
 * 5.4's `<const>`/`<close>` syntax (which Fengari, a Lua 5.3 VM, can't even
 * parse -- see `docs/OPEN_QUESTIONS.md` decision 2), which are served from
 * `vendor-lua-patches/` instead. See `vendor-lua-patches/README.md` for the
 * exact patch strategy applied to each of the 8.
 *
 * Paths are relative to `data/lua/` (e.g. `"wml-flow.lua"`,
 * `"wml/find_path.lua"`, `"core/wml.lua"`) -- the same relative-path shape
 * `wesnoth.require`/`wesnoth.dofile` use in real WML/Lua content.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_PATCHES_DIR = path.join(thisDir, '..', 'vendor-lua-patches');

/** The exact 8 `data/lua/` files that use Lua 5.4-only syntax -- see module doc comment. */
export const PATCHED_RELATIVE_PATHS: readonly string[] = [
  'core/wml.lua',
  'wml-flow.lua',
  'wml-tags.lua',
  'wml/find_path.lua',
  'wml/harm_unit.lua',
  'wml/modify_unit.lua',
  'wml/random_placement.lua',
  'functional.lua',
];

export function isPatchedFile(relPath: string): boolean {
  return PATCHED_RELATIVE_PATHS.includes(relPath);
}

/**
 * Reads one `data/lua/`-relative file, transparently substituting the
 * patched copy for the 8 files listed above. `dataRoot` is the real
 * submodule's `data/lua` directory (e.g. `<repo>/wesnoth/data/lua`).
 */
export function readDataLuaFile(dataRoot: string, relPath: string): string {
  if (isPatchedFile(relPath)) {
    return fs.readFileSync(path.join(VENDOR_PATCHES_DIR, relPath), 'utf8');
  }
  return fs.readFileSync(path.join(dataRoot, relPath), 'utf8');
}
