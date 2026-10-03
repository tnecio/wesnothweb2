import { describe, expect, it } from 'vitest';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { makeAiGame } from './harness.js';

/** Phase 28c B2: `[stage] engine=lua` (`lua_stage_wrapper`), as Legend of Wesmere 3 retreats its leader with. */

const rows = (n: number) => Array.from({ length: n }, () => Array(n).fill('Gg').join(', '));

/** Legend of Wesmere 3's side 5 `[ai]`: an `[engine]` whose table has `retreat`, a stage calling it, then nothing. */
function retreatAi(): WmlConfig {
  const ai = new WmlConfig();
  const engine = ai.addChild('engine');
  engine.setAttribute('name', 'lua');
  engine.setAttribute('code', `
    local my_ai = { }
    function my_ai:retreat()
      local leader = wesnoth.units.find_on_map({id="Urudin"})[1]
      if leader and leader.valid and leader.hitpoints < leader.max_hitpoints / 2 then
        ai.move_full(leader, 2, 2)
      end
    end
    return my_ai
  `);
  const stage = ai.addChild('stage');
  stage.setAttribute('id', 'leader_retreat');
  stage.setAttribute('engine', 'lua');
  stage.setAttribute('name', 'leader_retreat');
  stage.setAttribute('code', '(...):retreat()');
  const idle = ai.addChild('stage');
  idle.setAttribute('id', 'main_loop');
  idle.setAttribute('name', 'empty');
  return ai;
}

describe('a Lua AI stage', () => {
  it("runs its code with the engine's table as self, and the AI may move", () => {
    const game = makeAiGame(rows(8), [
      { type: 'Orcish Warrior', side: 1, x: 5, y: 5, hp: 10, canrecruit: true },
      { type: 'Spearman', side: 2, x: 8, y: 8 },
    ], { aiBlocks: (s) => (s === 1 ? [retreatAi()] : []) });
    game.board.unitsForSide(1)[0]!.id = 'Urudin';
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    expect(game.unitAt(2, 2)?.id).toBe('Urudin');
  });

  it('leaves a healthy leader where it is', () => {
    const game = makeAiGame(rows(8), [
      { type: 'Orcish Warrior', side: 1, x: 5, y: 5, canrecruit: true },
      { type: 'Spearman', side: 2, x: 8, y: 8 },
    ], { aiBlocks: (s) => (s === 1 ? [retreatAi()] : []) });
    game.board.unitsForSide(1)[0]!.id = 'Urudin';
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    expect(game.unitAt(5, 5)?.id).toBe('Urudin');
  });
});
