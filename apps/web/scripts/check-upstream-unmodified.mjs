#!/usr/bin/env node
/**
 * Phase 28 S9: the game content is upstream Wesnoth's, unmodified (docs/PHASE28_PLAN.md). Fails if:
 *
 * - the `wesnoth` submodule is checked out at a commit other than the one this repository pins, or has local
 *   changes to tracked files -- everything the build reads (WML, maps, Lua, images, sounds) comes from it;
 * - `packages/lua-bridge/vendor-lua-patches/` holds any Lua file other than the 8 listed in
 *   `PATCHED_RELATIVE_PATHS` (`dataLua.ts`): the only upstream files this port replaces, rewritten from
 *   Lua 5.4 syntax that Fengari (Lua 5.3) cannot parse.
 *
 * A `wesnoth` directory that is not its own repository (a worktree pointing at another checkout's data
 * through symlinks) cannot be checked here and is reported as skipped; CI's checkout always is one.
 *
 * Run: node --import tsx apps/web/scripts/check-upstream-unmodified.mjs
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATCHED_RELATIVE_PATHS } from '../../../packages/lua-bridge/src/dataLua.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const wesnoth = path.join(repoRoot, 'wesnoth');
const problems = [];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

if (fs.existsSync(path.join(wesnoth, '.git'))) {
  const pinned = git(repoRoot, 'rev-parse', 'HEAD:wesnoth');
  const actual = git(wesnoth, 'rev-parse', 'HEAD');
  if (actual !== pinned) problems.push(`wesnoth is at ${actual}, but this repository pins ${pinned}`);
  const changed = git(wesnoth, 'status', '--porcelain', '--untracked-files=no');
  if (changed) problems.push(`wesnoth has local changes:\n${changed.split('\n').slice(0, 20).join('\n')}`);
  console.log(`wesnoth submodule at the pinned commit ${pinned.slice(0, 12)}${changed ? '' : ', no local changes'}`);
} else {
  console.log('wesnoth is not a git checkout here (symlinked data): submodule check skipped');
}

const patchesDir = path.join(repoRoot, 'packages/lua-bridge/vendor-lua-patches');
const found = [];
const walk = (dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (e.name.endsWith('.lua')) found.push(r);
  }
};
walk(patchesDir, '');
const expected = new Set(PATCHED_RELATIVE_PATHS);
const extra = found.filter((f) => !expected.has(f));
const missing = [...expected].filter((f) => !found.includes(f));
if (extra.length) problems.push(`vendor-lua-patches has files beyond the known 8: ${extra.join(', ')}`);
if (missing.length) problems.push(`vendor-lua-patches is missing: ${missing.join(', ')}`);
console.log(`Lua patches: ${found.length} files, all among the ${expected.size} known`);

if (problems.length) {
  console.error(`\nUpstream content is not unmodified:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('upstream content unmodified');
