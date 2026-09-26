import { afterEach, describe, expect, it } from 'vitest';
import { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { conditionalPassed, setLuaConditionalEvaluator } from '@wesnothweb2/engine/src/events/conditionalWml.js';
import type { EventContext } from '@wesnothweb2/engine/src/events/context.js';
import { parseWml } from '@wesnothweb2/engine/src/wml/index.js';
import { createLuaConditionalEvaluator } from '../src/conditionals.js';

/** Just what a `[lua]`-only condition touches. */
function ctxWith(vars: Record<string, number>): { ctx: EventContext; logs: string[] } {
  const variables = new VariableStore();
  for (const [k, v] of Object.entries(vars)) variables.set(k, v);
  const logs: string[] = [];
  const ctx = { variables, log: (_level: string, msg: string) => logs.push(msg) } as unknown as EventContext;
  return { ctx, logs };
}
const cond = (body: string) => parseWml(`[if]\n${body}\n[/if]`).child('if')!;
// The one [lua] condition the shipped scenarios use (Two Brothers / Liberty).
const SHIPPED = cond('[lua]\ncode=<< return wml.variables.turn_number>1 >>\n[/lua]');

describe('[lua] as a condition (wml_conditionals.lua)', () => {
  afterEach(() => setLuaConditionalEvaluator(null));

  it('runs the code against the game variables', () => {
    setLuaConditionalEvaluator(createLuaConditionalEvaluator());
    expect(conditionalPassed(SHIPPED, ctxWith({ turn_number: 1 }).ctx)).toBe(false);
    expect(conditionalPassed(SHIPPED, ctxWith({ turn_number: 2 }).ctx)).toBe(true);
  });

  it('Lua truthiness: 0 passes, nil fails; a runtime error fails with an error logged', () => {
    setLuaConditionalEvaluator(createLuaConditionalEvaluator());
    expect(conditionalPassed(cond('[lua]\ncode="return 0"\n[/lua]'), ctxWith({}).ctx)).toBe(true);
    expect(conditionalPassed(cond('[lua]\ncode="return nil"\n[/lua]'), ctxWith({}).ctx)).toBe(false);
    const { ctx, logs } = ctxWith({});
    expect(conditionalPassed(cond('[lua]\ncode="error(\'boom\')"\n[/lua]'), ctx)).toBe(false);
    expect(logs.join()).toContain('boom');
  });

  it('with no Lua VM installed it is an unknown conditional: passes, with an error (upstream)', () => {
    const { ctx, logs } = ctxWith({ turn_number: 1 });
    expect(conditionalPassed(SHIPPED, ctx)).toBe(true);
    expect(logs).toContain('unknown conditional wml: [lua]');
  });
});
