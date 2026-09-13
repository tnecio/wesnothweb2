import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON } from '../../src/ai/config/builtinAiConfigs.generated.js';

/**
 * Guards against `src/ai/config/builtinAiConfigs.generated.ts` drifting
 * from its real source (`wesnoth/data/ai/utils/default_config.cfg` and
 * `wesnoth/data/ai/ais/*.cfg`) -- re-parses those files with the exact
 * same logic `scripts/gen-ai-configs.mjs` uses and asserts a deep-equal
 * match against the checked-in module. A failure here means the
 * submodule was rebased (or the generator script changed) without
 * re-running `npx tsx packages/engine/scripts/gen-ai-configs.mjs`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadDefines(): DefineMap {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  preloadDefinesFromDir(path.join(dataRoot, 'ai'), defines, { dataRoot });
  return defines;
}

describe('builtinAiConfigs.generated.ts stays in sync with wesnoth/data/ai', () => {
  it('DEFAULT_AI_CONFIG_JSON matches a fresh parse of default_config.cfg', () => {
    const defines = loadDefines();
    const cfg = parseWmlFile(path.join(dataRoot, 'ai/utils/default_config.cfg'), { dataRoot, defines });
    const aspects = cfg.allChildren().filter((c) => c.tag === 'aspect');
    const fresh = { attrs: {}, children: aspects.map((c) => ({ tag: c.tag, config: c.config.toJSON() })) };
    expect(DEFAULT_AI_CONFIG_JSON).toEqual(fresh);
  });

  it.each(['ai_default_rca', 'ai_default_rca_1_14', 'ai_experimental', 'idle_ai'] as const)(
    'AI_ALGORITHM_CONFIGS_JSON.%s matches a fresh parse of ai/ais/%s.cfg',
    (id) => {
      const defines = loadDefines();
      const cfg = parseWmlFile(path.join(dataRoot, `ai/ais/${id}.cfg`), { dataRoot, defines });
      const aiChildren = cfg.allChildren().filter((c) => c.tag === 'ai');
      expect(aiChildren).toHaveLength(1);
      expect(AI_ALGORITHM_CONFIGS_JSON[id]).toEqual(aiChildren[0]!.config.toJSON());
    },
  );

  it('the default AI config declares exactly the 14 candidate actions of the real main_loop stage, in score order', () => {
    const mainLoop = AI_ALGORITHM_CONFIGS_JSON['ai_default_rca']!.children.find((c) => c.tag === 'stage');
    expect(mainLoop).toBeDefined();
    const ids = mainLoop!.config.children.filter((c) => c.tag === 'candidate_action').map((c) => c.config.attrs['id']);
    expect(ids).toEqual([
      'goto',
      'retreat_injured',
      'spread_poison',
      'recruitment',
      'move_leader_to_goals',
      'move_leader_to_keep',
      'high_xp_attack',
      'combat',
      'place_healers',
      'healing',
      'villages',
      'move_to_targets',
      'leader_shares_keep',
      'move_to_any_enemy',
    ]);
  });

  it('idle_ai has a single empty stage and no candidate actions', () => {
    const cfg = AI_ALGORITHM_CONFIGS_JSON['idle_ai']!;
    const stages = cfg.children.filter((c) => c.tag === 'stage');
    expect(stages).toHaveLength(1);
    expect(stages[0]!.config.attrs['name']).toBe('empty');
    expect(stages[0]!.config.children.filter((c) => c.tag === 'candidate_action')).toHaveLength(0);
  });
});
