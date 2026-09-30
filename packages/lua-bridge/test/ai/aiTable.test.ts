import { describe, expect, it } from 'vitest';
import { parseWml } from '@wesnothweb2/engine/src/wml/index.js';
import { makeAiGame } from './harness.js';

/** Phase 29 S7: the `ai` table Lua candidate actions see (`src/ai/lua/core.cpp`), and how errors are handled. */

const rows = (n: number) => Array.from({ length: n }, () => Array(n).fill('Gg').join(', '));

function aiWith(evaluation: string, execution: string) {
  return parseWml(`[ai]
  [stage]
    id=main_loop
    name=ai_default_rca::candidate_action_evaluation_loop
    [candidate_action]
      engine=lua
      id=test
      name=test
      max_score=100000
      evaluation=<<${evaluation}>>
      execution=<<${execution}>>
    [/candidate_action]
  [/stage]
[/ai]`).child('ai')!;
}

describe('the Lua ai table', () => {
  it('is read-only while evaluating and has the mutating functions while executing', () => {
    const game = makeAiGame(rows(6), [{ type: 'Spearman', side: 1, x: 2, y: 2 }], {
      aiBlocks: () => [
        aiWith(
          `wml.variables.eval_move = type(ai.move); wml.variables.eval_side = ai.side
           if wml.variables.done then return 0 end
           return 1000`,
          `wml.variables.exec_move = type(ai.move_full); wml.variables.done = true
           local r = ai.move_full(2, 2, 2, 3)
           wml.variables.ok = r.ok; wml.variables.changed = r.gamestate_changed`,
        ),
      ],
    });
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    const v = (name: string) => game.variables.getRaw(name);
    expect(v('eval_move')).toBe('nil');
    expect(v('eval_side')).toBe(1);
    expect(v('exec_move')).toBe('function');
    expect(v('ok')).toBe(true);
    expect(v('changed')).toBe(true);
    expect(game.unitAt(2, 3)?.type.id).toBe('Spearman');
  });

  it('reports upstream status codes from ai.check_*', () => {
    const game = makeAiGame(rows(6), [
      { type: 'Spearman', side: 1, x: 2, y: 2 },
      { type: 'Spearman', side: 2, x: 5, y: 5 },
    ], {
      aiBlocks: () => [
        aiWith(
          `local r = ai.check_move(4, 4, 4, 5); wml.variables.no_unit = r.status; wml.variables.result = r.result
           wml.variables.not_own = ai.check_move(5, 5, 5, 4).status
           wml.variables.not_adjacent = ai.check_attack(2, 2, 5, 5).status
           wml.variables.ok_move = ai.check_move(2, 2, 3, 3).ok
           return 0`,
          '',
        ),
      ],
    });
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    const v = (name: string) => game.variables.getRaw(name);
    expect(v('no_unit')).toBe(2002);
    expect(v('result')).toBe('move_result::E_NO_UNIT');
    expect(v('not_own')).toBe(2003);
    expect(v('not_adjacent')).toBe(1010);
    expect(v('ok_move')).toBe(true);
  });

  it('logs a Lua error in a candidate action and lets the turn end', () => {
    const game = makeAiGame(rows(6), [{ type: 'Spearman', side: 1, x: 2, y: 2 }], {
      aiBlocks: () => [aiWith('return 1000', 'error("boom")')],
    });
    game.playTurn(1);
    expect(game.logs.some((l) => l.startsWith('error:') && l.includes('boom'))).toBe(true);
  });

  it('draws mathx.random from the game RNG', () => {
    const a = makeAiGame(rows(4), [], { aiBlocks: () => [aiWith('wml.variables.r = mathx.random(1, 1000000); return 0', '')] });
    const b = makeAiGame(rows(4), [], { aiBlocks: () => [aiWith('wml.variables.r = mathx.random(1, 1000000); return 0', '')] });
    a.playTurn(1);
    b.playTurn(1);
    expect(a.variables.getRaw('r')).toBe(b.variables.getRaw('r'));
  });
});
