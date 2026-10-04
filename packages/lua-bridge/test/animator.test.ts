import { describe, expect, it } from 'vitest';
import { parseWml } from '@wesnothweb2/engine/src/wml/index.js';
import { runActionSequence } from '@wesnothweb2/engine/src/events/actionWml.js';
import type { AnimatorEntry, Interaction } from '@wesnothweb2/engine/src/events/interaction.js';
import { makeAiGame } from './ai/harness.js';

/** Phase 28c B4: `wesnoth.units.create_animator` (`intf_create_animator`), as Heir to the Throne's smite uses it. */

const rows = (n: number) => Array.from({ length: n }, () => Array(n).fill('Gg').join(', '));

describe('wesnoth.units.create_animator', () => {
  it('collects add() calls and run() plays them together as one beat, then is empty', () => {
    const game = makeAiGame(rows(6), [
      { type: 'White Mage', side: 1, x: 3, y: 3 },
      { type: 'Skeleton', side: 2, x: 4, y: 3 },
    ]);
    const beats: AnimatorEntry[][] = [];
    runActionSequence(parseWml(`[lua]
      code=<<
        local mage = wesnoth.units.find_on_map({ side = 1 })[1]
        local skeleton = wesnoth.units.find_on_map({ side = 2 })[1]
        local animator = wesnoth.units.create_animator()
        animator:add(mage, "attack", "hit", { with_bars = true, target = skeleton.loc })
        animator:add(skeleton, "defend", "hit", { text = "30", color = {255, 0, 0} })
        animator:run()
        animator:run() -- emptied by the first run: nothing more to play
        animator:add(skeleton, "death", "kill")
        animator:clear()
        animator:run()
      >>
    [/lua]`), game.pump.ctx, (i: Interaction) => {
      if (i.kind === 'beat' && i.beat.kind === 'animateUnits') beats.push([...i.beat.entries]);
      return {};
    });
    expect(game.logs.join('\n')).toBe('');
    expect(beats).toHaveLength(1);
    expect(beats[0]!.map((e) => [e.unit.type.id, e.flag, e.hits, e.withBars, e.text, e.color.r])).toEqual([
      ['White Mage', 'attack', 'hit', true, '', 255],
      ['Skeleton', 'defend', 'hit', false, '30', 255],
    ]);
    expect(beats[0]![0]!.target?.wmlX).toBe(4);
  });

  it('refuses a target that is not adjacent', () => {
    const game = makeAiGame(rows(6), [{ type: 'White Mage', side: 1, x: 1, y: 1 }]);
    runActionSequence(parseWml(`[lua]
      code=<< local u = wesnoth.units.find_on_map({ side = 1 })[1] ; wesnoth.units.create_animator():add(u, "attack", "hit", { target = {5, 5} }) >>
    [/lua]`), game.pump.ctx);
    expect(game.logs.join('\n')).toContain('target location must be adjacent');
  });
});
