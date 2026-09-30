import { describe, expect, it } from 'vitest';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { AI_ALGORITHM_CONFIGS_JSON } from '@wesnothweb2/engine/src/ai/config/builtinAiConfigs.generated.js';
import { makeAiGame } from './harness.js';

/** Phase 29 S7: the default RCA AI's five Lua candidate actions, run from `data/ai/lua` unchanged. */

const rows = (n: number, fill = 'Gg') => Array.from({ length: n }, () => Array(n).fill(fill).join(', '));

/** An `[ai]` whose main loop is only the real default config's candidate action `id`. */
function onlyCa(id: string): WmlConfig {
  const rca = WmlConfig.fromJSON(AI_ALGORITHM_CONFIGS_JSON['ai_default_rca']!);
  const stage = rca.children('ai')[0]?.child('stage') ?? rca.child('stage')!;
  const ca = stage.children('candidate_action').find((c) => c.getString('id') === id);
  if (!ca) throw new Error(`no candidate action ${id}`);
  const ai = new WmlConfig();
  const s = ai.addChild('stage');
  s.setAttribute('id', 'main_loop');
  s.setAttribute('name', 'ai_default_rca::candidate_action_evaluation_loop');
  s.addChild('candidate_action', ca.clone());
  return ai;
}

describe('the default RCA AI with its Lua candidate actions', () => {
  it('builds all five Lua candidate actions and plays a turn with a clean log', () => {
    const game = makeAiGame(rows(10), [
      { type: 'Spearman', side: 1, x: 2, y: 2 },
      { type: 'Orcish Grunt', side: 2, x: 9, y: 9 },
    ]);
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    expect(game.unitAt(2, 2)).toBeUndefined();
  });

  it('move_to_any_enemy walks toward an enemy when there is nothing else to do', () => {
    const game = makeAiGame(rows(12), [
      { type: 'Spearman', side: 1, x: 2, y: 2 },
      { type: 'Orcish Grunt', side: 2, x: 11, y: 11 },
    ], { aiBlocks: (s) => (s === 1 ? [onlyCa('move_to_any_enemy')] : []) });
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    const spearman = game.board.unitsForSide(1)[0]!;
    expect(Math.max(Math.abs(spearman.location.wmlX - 11), Math.abs(spearman.location.wmlY - 11))).toBeLessThan(9);
  });

  it('retreat_injured takes a badly hurt unit to a village away from the enemy', () => {
    const map = rows(10);
    map[1] = 'Gg, Gg^Vh, Gg, Gg, Gg, Gg, Gg, Gg, Gg, Gg';
    const game = makeAiGame(map, [
      { type: 'Spearman', side: 1, x: 5, y: 3, hp: 5 },
      { type: 'Orcish Grunt', side: 2, x: 8, y: 3 },
    ], { aiBlocks: (s) => (s === 1 ? [onlyCa('retreat_injured')] : []) });
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    expect(game.unitAt(2, 2)?.type.id).toBe('Spearman');
  });

  it('spread_poison attacks an unpoisoned enemy with the poison weapon', () => {
    const game = makeAiGame(rows(10), [
      { type: 'Orcish Assassin', side: 1, x: 3, y: 3 },
      { type: 'Spearman', side: 2, x: 6, y: 3 },
    ], { aiBlocks: (s) => (s === 1 ? [onlyCa('spread_poison')] : []) });
    const actions = game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    const attack = actions.find((a) => a.kind === 'attack');
    expect(attack?.animation?.kind).toBe('attack');
    if (attack?.animation?.kind === 'attack') {
      expect(attack.animation.attacker.type.id).toBe('Orcish Assassin');
      expect(attack.animation.attacker.attacks[attack.animation.attackerWeaponIndex]!.specials.some((s) => s.getString('id') === 'poison')).toBe(true);
    }
  });

  it('high_xp_attack attacks an enemy about to level up', () => {
    const game = makeAiGame(rows(10), [
      { type: 'Orcish Grunt', side: 1, x: 3, y: 3 },
      { type: 'Orcish Grunt', side: 1, x: 3, y: 5 },
      { type: 'Spearman', side: 2, x: 5, y: 4, hp: 6, experience: 41 },
    ], { aiBlocks: (s) => (s === 1 ? [onlyCa('high_xp_attack')] : []) });
    const actions = game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    expect(actions.some((a) => a.kind === 'attack')).toBe(true);
  });

  it('place_healers moves a healer next to a hurt unit that has already moved', () => {
    const game = makeAiGame(rows(10), [
      { type: 'Elvish Shaman', side: 1, x: 2, y: 5 },
      { type: 'Spearman', side: 1, x: 6, y: 5, hp: 20 },
      { type: 'Orcish Grunt', side: 2, x: 9, y: 5 },
    ], { aiBlocks: (s) => (s === 1 ? [onlyCa('place_healers')] : []) });
    game.unitAt(6, 5)!.movesLeft = 0;
    game.playTurn(1);
    expect(game.logs.join('\n')).toBe('');
    const shaman = game.board.unitsForSide(1).find((u) => u.type.id === 'Elvish Shaman')!;
    const dist = Math.max(Math.abs(shaman.location.wmlX - 6), Math.abs(shaman.location.wmlY - 5));
    expect(dist).toBe(1);
  });
});
