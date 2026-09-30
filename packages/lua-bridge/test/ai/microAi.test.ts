import { describe, expect, it } from 'vitest';
import { parseWml } from '@wesnothweb2/engine/src/wml/index.js';
import { runActionSequence } from '@wesnothweb2/engine/src/events/actionWml.js';
import { makeAiGame } from './harness.js';

/** Phase 29 S9: `[micro_ai]` from `data/lua/wml/micro_ai.lua` and `data/ai/micro_ais`, unchanged. */

const rows = (n: number) => Array.from({ length: n }, () => Array(n).fill('Gg').join(', '));

const zoneGuardian = (extra = '') => `[micro_ai]
  ai_type=zone_guardian
  side=1
  action=add
  id=guard
  ${extra}
  [filter_location]
    x=2-6
    y=2-6
  [/filter_location]
[/micro_ai]`;

describe('[micro_ai] zone_guardian', () => {
  it("from the side's [ai]: attacks an enemy inside its zone", () => {
    const ai = parseWml(`[ai]\n${zoneGuardian()}\n[/ai]`).child('ai')!;
    const game = makeAiGame(rows(12), [
      { type: 'Spearman', side: 1, x: 4, y: 4 },
      { type: 'Orcish Grunt', side: 2, x: 6, y: 4 },
    ], { aiBlocks: (s) => (s === 1 ? [ai] : []) });
    game.board.unitAt(game.board.unitsForSide(1)[0]!.location)!.id = 'guard';
    const actions = game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    expect(actions.some((a) => a.kind === 'attack')).toBe(true);
  });

  it('from the [micro_ai] tag: stays inside its zone when the enemy is outside', () => {
    const game = makeAiGame(rows(14), [
      { type: 'Spearman', side: 1, x: 4, y: 4 },
      { type: 'Orcish Grunt', side: 2, x: 12, y: 12 },
    ]);
    game.board.unitsForSide(1)[0]!.id = 'guard';
    runActionSequence(parseWml(zoneGuardian()), game.pump.ctx);
    expect(game.logs.join('\n')).toBe('');
    // The candidate action is on side 1's AI, under the id micro_ai_helper gave it.
    const stage = game.manager.toConfig(1).children('stage').find((s) => s.getString('id') === 'main_loop')!;
    expect(stage.children('candidate_action').map((c) => c.getString('id'))).toContain('mai_zone_guardian_move');
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    const guard = game.board.unitsForSide(1)[0]!;
    expect(guard.location.wmlX).toBeGreaterThanOrEqual(2);
    expect(guard.location.wmlX).toBeLessThanOrEqual(6);
    expect(guard.location.wmlY).toBeGreaterThanOrEqual(2);
    expect(guard.location.wmlY).toBeLessThanOrEqual(6);
  });

  it('two zone guardians on one side get unique ids', () => {
    const game = makeAiGame(rows(12), [{ type: 'Spearman', side: 1, x: 4, y: 4 }]);
    runActionSequence(parseWml(zoneGuardian()), game.pump.ctx);
    runActionSequence(parseWml(zoneGuardian().replace('id=guard', 'id=other')), game.pump.ctx);
    expect(game.logs.join('\n')).toBe('');
    const ids = game.manager.toConfig(1).children('stage')[0]!.children('candidate_action').map((c) => c.getString('id'));
    expect(ids.filter((id) => id.startsWith('mai_zone_guardian'))).toEqual(['mai_zone_guardian_move', 'mai_zone_guardian1_move']);
  });
});

describe('[micro_ai] assassin', () => {
  // Used by Under the Burning Suns 5 (not shipped yet), and by no upstream test scenario.
  it('moves the assassin toward its target', () => {
    const game = makeAiGame(rows(16), [
      { type: 'Thief', side: 1, x: 2, y: 2 },
      { type: 'Spearman', side: 2, x: 14, y: 14 },
      { type: 'Spearman', side: 2, x: 8, y: 2 },
    ]);
    const [assassin] = game.board.unitsForSide(1);
    assassin!.id = 'assassin';
    game.board.unitsForSide(2)[0]!.id = 'target';
    runActionSequence(
      parseWml(`[micro_ai]
  ai_type=assassin
  side=1
  action=add
  [filter]
    id=assassin
  [/filter]
  [filter_second]
    id=target
  [/filter_second]
[/micro_ai]`),
      game.pump.ctx,
    );
    const before = assassin!.location;
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    const target = game.board.unitsForSide(2)[0]!.location;
    const dist = (a: { wmlX: number; wmlY: number }) => Math.max(Math.abs(a.wmlX - target.wmlX), Math.abs(a.wmlY - target.wmlY));
    expect(dist(assassin!.location)).toBeLessThan(dist(before));
  });
});
