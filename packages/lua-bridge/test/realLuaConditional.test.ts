import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { newLuaState, doString } from '../src/luaEnv.js';
import { installVariablesBridge } from '../src/bridges/variables.js';

/**
 * Verification target from the task brief: "find a REAL, reasonably simple
 * use of `[lua]` ... in mainline content ... and write a test that actually
 * runs it through your Fengari + host API bridge, asserting on real
 * resulting state."
 *
 * `wesnoth/data/campaigns/Heir_To_The_Throne/utils/side_ai.cfg` (part of
 * the `RETREAT_WHEN_WEAK` AI macro) contains:
 *
 *     [lua]
 *         # don't open up with retreating; allow at least 1 round of recruitment
 *         code=<< return wml.variables.turn_number>1 >>
 *     [/lua]
 *
 * used as a `[lua]` conditional (its return value gates an `{IF}`/`[then]`
 * inside an AI aspect). It's about as small and self-contained as a real
 * `[lua]` block gets: its entire dependency on the host API is a single
 * `wml.variables` scalar read. This test extracts the real `code=<<...>>`
 * string straight out of the real `.cfg` file (rather than retyping it) and
 * runs it through this package's `wml.variables` <-> `VariableStore` bridge
 * (Task 2a), asserting the real boolean result for varying `turn_number`.
 *
 * Not exercised here (out of scope for this package, which stops at the
 * Lua host-API bridge): the surrounding WML macro-expansion/AI-aspect
 * machinery that would actually invoke this snippet as a live condition --
 * see `packages/engine/src/events/actionWml.ts`'s `[lua]` extension-point
 * placeholder for where that would eventually plug in.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sideAiCfgPath = path.join(
  repoRoot,
  'wesnoth/data/campaigns/Heir_To_The_Throne/utils/side_ai.cfg',
);

let extractedLuaCode: string;

beforeAll(() => {
  const fileText = fs.readFileSync(sideAiCfgPath, 'utf8');
  // Pull the exact code=<< ... >> body out of the real file via its own
  // literal syntax (WML's "double-angle-bracket" multiline string), rather
  // than hand-copying the snippet -- if upstream ever changes this file,
  // this test starts exercising whatever the new real content says.
  const match = fileText.match(/code\s*=\s*<<([^]*?)>>/);
  if (!match) {
    throw new Error(
      `couldn't find a code=<<...>> [lua] block in ${sideAiCfgPath} -- has upstream changed this file?`,
    );
  }
  extractedLuaCode = match[1]!;
  // Sanity-check we actually found the intended snippet, not some other
  // [lua] block that might get added to this file later.
  expect(extractedLuaCode).toContain('wml.variables.turn_number');
});

describe('real [lua] conditional from Heir_To_The_Throne/utils/side_ai.cfg', () => {
  it('returns false before turn 2 (turn_number = 1)', () => {
    const store = new VariableStore();
    store.set('turn_number', 1);
    const L = newLuaState();
    // installVariablesBridge only needs the `wml` global table to exist;
    // provide it directly here since this test deliberately does NOT load
    // bootstrap.ts's wider stub surface -- this real [lua] snippet needs
    // nothing but `wml.variables`.
    doString(L, 'wml = wml or {}', '=wml-global');
    installVariablesBridge(L, store);
    const result = doString(L, extractedLuaCode, '=side_ai.cfg [lua]');
    expect(result).toBe(false);
  });

  it('returns true from turn 2 onward (turn_number = 2)', () => {
    const store = new VariableStore();
    store.set('turn_number', 2);
    const L = newLuaState();
    doString(L, 'wml = wml or {}', '=wml-global');
    installVariablesBridge(L, store);
    const result = doString(L, extractedLuaCode, '=side_ai.cfg [lua]');
    expect(result).toBe(true);
  });

  it('returns true well past turn 2 (turn_number = 10)', () => {
    const store = new VariableStore();
    store.set('turn_number', 10);
    const L = newLuaState();
    doString(L, 'wml = wml or {}', '=wml-global');
    installVariablesBridge(L, store);
    const result = doString(L, extractedLuaCode, '=side_ai.cfg [lua]');
    expect(result).toBe(true);
  });
});
