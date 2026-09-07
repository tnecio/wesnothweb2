import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newLuaState, compileOnly } from '../src/luaEnv.js';
import { PATCHED_RELATIVE_PATHS, readDataLuaFile } from '../src/dataLua.js';

/**
 * Task 1 verification: Fengari (Lua 5.3) must be able to *parse* (compile,
 * not necessarily run standalone -- most of these files reference globals
 * only a full engine bootstrap provides) each of the 8 patched files.
 *
 * As a control -- proving this test would actually catch a regression, not
 * just pass vacuously -- it also confirms the *unpatched* originals
 * straight from the `wesnoth` submodule fail to compile under Fengari with
 * exactly a `<const>`/`<close>`-shaped syntax error.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataLuaRoot = path.join(repoRoot, 'wesnoth/data/lua');

describe('the 8 Lua 5.4 files patched for Fengari (Lua 5.3) compatibility', () => {
  it.each(PATCHED_RELATIVE_PATHS)('patched %s compiles under Fengari with no syntax errors', (relPath) => {
    const L = newLuaState();
    const source = readDataLuaFile(dataLuaRoot, relPath);
    const result = compileOnly(L, source, relPath);
    expect(result.ok, result.error).toBe(true);
  });

  it.each(PATCHED_RELATIVE_PATHS)(
    'control: the UNPATCHED original %s fails to compile under Fengari (proves the patch is load-bearing)',
    (relPath) => {
      const L = newLuaState();
      const originalSource = fs.readFileSync(path.join(dataLuaRoot, relPath), 'utf8');
      const result = compileOnly(L, originalSource, relPath);
      expect(result.ok).toBe(false);
      // Fengari's parser has no notion of Lua 5.4 attribute syntax at all,
      // so it reports this as a generic "unexpected symbol near '<'" at the
      // `<const>`/`<close>` token, not a specific "5.4 attribute" message.
      // Still, checking for that exact shape confirms *this* is why it
      // failed, not some unrelated file corruption.
      expect(result.error).toMatch(/unexpected symbol near '<'/);
    },
  );

  it('every other file under data/lua/ is read completely unmodified from the submodule', () => {
    // Spot-check a handful of real, non-patched files across the tree
    // (top-level, core/, and wml/) to confirm the loader is a pure
    // pass-through for anything not in the 8-file patch list.
    const untouchedSamples = [
      'wml-utils.lua',
      'wml-conditionals.lua',
      'core/units.lua',
      'wml/message.lua',
      'wml/kill.lua',
    ];
    for (const relPath of untouchedSamples) {
      expect(PATCHED_RELATIVE_PATHS).not.toContain(relPath);
      const viaLoader = readDataLuaFile(dataLuaRoot, relPath);
      const direct = fs.readFileSync(path.join(dataLuaRoot, relPath), 'utf8');
      expect(viaLoader).toBe(direct);
    }
  });
});
