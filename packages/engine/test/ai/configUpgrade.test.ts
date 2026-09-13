import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWml, parseWmlFile, preloadDefines, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { expandSimplifiedAspects, buildAspects, parseSideAiConfig } from '../../src/ai/config/upgrade.js';
import { DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON } from '../../src/ai/config/builtinAiConfigs.generated.js';

/**
 * `expandSimplifiedAspects`/`buildAspects`/`parseSideAiConfig` -- mirrors
 * `configuration.cpp:196-390`'s WML upgrade + merge pass. Real-content
 * check at the bottom against Dead Water scenario 1 side 2's actual
 * `[side][ai]` block.
 */

describe('expandSimplifiedAspects', () => {
  it('turns a bare key=value attribute into an [aspect]/[facet] pair', () => {
    const raw = parseWml('[ai]\naggression=0.8\n[/ai]').child('ai')!;
    const expanded = expandSimplifiedAspects(raw);
    const aspects = expanded.children('aspect');
    expect(aspects).toHaveLength(1);
    expect(aspects[0]!.getString('id')).toBe('aggression');
    const facet = aspects[0]!.child('facet')!;
    expect(facet.getString('value')).toBe('0.8');
  });

  it('propagates the [ai]-level turns=/time_of_day= onto every simplified facet it creates', () => {
    const raw = parseWml('[ai]\naggression=0.8\ncaution=0.1\nturns=3-5\n[/ai]').child('ai')!;
    const expanded = expandSimplifiedAspects(raw);
    for (const aspect of expanded.children('aspect')) {
      expect(aspect.child('facet')!.getString('turns')).toBe('3-5');
    }
  });

  it('known non-aspect attributes (ai_algorithm, id, turns, time_of_day, description, hidden, mp_rank) are copied as plain attributes, not aspects', () => {
    const raw = parseWml('[ai]\nai_algorithm=idle_ai\nid=x\n[/ai]').child('ai')!;
    const expanded = expandSimplifiedAspects(raw);
    expect(expanded.getString('ai_algorithm')).toBe('idle_ai');
    expect(expanded.getString('id')).toBe('x');
    expect(expanded.children('aspect')).toHaveLength(0);
  });

  it('a bare top-level [avoid] child becomes the avoid aspect, with its config as the facet\'s [value]', () => {
    const raw = parseWml('[ai]\n[avoid]\nx=1-3\ny=1-3\n[/avoid]\n[/ai]').child('ai')!;
    const expanded = expandSimplifiedAspects(raw);
    const avoidAspects = expanded.children('aspect').filter((a) => a.getString('id') === 'avoid');
    expect(avoidAspects).toHaveLength(1);
    const value = avoidAspects[0]!.child('facet')!.child('value')!;
    expect(value.getString('x')).toBe('1-3');
  });

  it('[stage]/[aspect]/[goal]/[modify_ai]/[micro_ai] children are copied through verbatim', () => {
    const raw = parseWml('[ai]\n[stage]\nid=main_loop\n[/stage]\n[/ai]').child('ai')!;
    const expanded = expandSimplifiedAspects(raw);
    expect(expanded.children('stage')).toHaveLength(1);
    expect(expanded.child('stage')!.getString('id')).toBe('main_loop');
  });
});

describe('buildAspects: merging by id across multiple [ai] blocks', () => {
  it("merges a scenario's own facet onto default_config.cfg's [default] under the same aspect id", () => {
    const defaultBlock = parseWml('[ai]\n[aspect]\nid=aggression\n[default]\nvalue=0.4\n[/default]\n[/aspect]\n[/ai]').child('ai')!;
    const sceneBlock = expandSimplifiedAspects(parseWml('[ai]\naggression=0.8\n[/ai]').child('ai')!);
    const aspects = buildAspects([defaultBlock, sceneBlock]);
    const aggression = aspects.get('aggression')!;
    expect(aggression.resolve(1, '').getString('value')).toBe('0.8'); // scenario facet outranks the default
  });
});

describe('parseSideAiConfig', () => {
  it('falls back to ai_default_rca when the side gives no ai_algorithm and no [stage]', () => {
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, []);
    const stages = parsed.configs.flatMap((c) => c.children('stage'));
    expect(stages).toHaveLength(1);
    expect(stages[0]!.getString('name')).toBe('ai_default_rca::candidate_action_evaluation_loop');
  });

  it('honours an explicit ai_algorithm=idle_ai', () => {
    const sideBlock = parseWml('[ai]\nai_algorithm=idle_ai\n[/ai]').child('ai')!;
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, [sideBlock]);
    const stages = parsed.configs.flatMap((c) => c.children('stage'));
    expect(stages).toHaveLength(1);
    expect(stages[0]!.getString('name')).toBe('empty');
  });

  it('every default_config.cfg aspect id is present, so an unconfigured aspect still resolves to its real upstream default', () => {
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, []);
    expect(parsed.aspects.get('aggression')!.resolve(1, '').getNumber('value')).toBe(0.4);
    expect(parsed.aspects.get('caution')!.resolve(1, '').getNumber('value')).toBe(0.25);
    expect(parsed.aspects.get('village_value')!.resolve(1, '').getNumber('value')).toBe(1.0);
    expect(parsed.aspects.get('villages_per_scout')!.resolve(1, '').getNumber('value')).toBe(4);
    expect(parsed.aspects.get('grouping')!.resolve(1, '').getString('value')).toBe('offensive');
  });

  it("a side's own aggression=0.8 overrides the real 0.4 default", () => {
    const sideBlock = parseWml('[ai]\naggression=0.8\n[/ai]').child('ai')!;
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, [sideBlock]);
    expect(parsed.aspects.get('aggression')!.resolve(1, '').getNumber('value')).toBe(0.8);
  });

  it('multiple [side][ai] blocks (default_config prepended automatically, no explicit algorithm) all merge in', () => {
    const block1 = parseWml('[ai]\naggression=0.9\n[/ai]').child('ai')!;
    const block2 = parseWml('[ai]\ncaution=0.05\n[/ai]').child('ai')!;
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, [block1, block2]);
    expect(parsed.aspects.get('aggression')!.resolve(1, '').getNumber('value')).toBe(0.9);
    expect(parsed.aspects.get('caution')!.resolve(1, '').getNumber('value')).toBe(0.05);
  });
});

describe('real content: Dead Water scenario 1 side 2', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const dataRoot = path.join(repoRoot, 'wesnoth/data');

  function loadDeadWater1(): WmlConfig {
    // Campaign-flag injection matches deadWaterIntegration.test.ts's own established pattern exactly (see that
    // file's module doc comment for why both CAMPAIGN_DEAD_WATER and a difficulty flag are needed).
    const defines: DefineMap = new Map();
    const flag = (name: string) => defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<test-harness>' });
    flag('CAMPAIGN_DEAD_WATER');
    flag('NORMAL');
    preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
    preloadDefines(path.join(dataRoot, 'campaigns/Dead_Water/_main.cfg'), defines, { dataRoot });
    return parseWmlFile(path.join(dataRoot, 'campaigns/Dead_Water/scenarios/01_Invasion.cfg'), { dataRoot, defines });
  }

  it("upgrades side 2's real recruitment_pattern=/[avoid] into working aspects, defaulting to the real ai_default_rca algorithm", () => {
    const root = loadDeadWater1();
    const scenario = root.child('scenario')!;
    const side2 = scenario.children('side').find((s) => s.getNumber('side') === 2)!;
    expect(side2).toBeDefined();
    const aiBlocks = side2.children('ai');
    expect(aiBlocks.length).toBeGreaterThan(0);

    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, aiBlocks);
    const pattern = parsed.aspects.get('recruitment_pattern');
    expect(pattern).toBeDefined();
    const resolved = pattern!.resolve(1, '');
    const patternValue = resolved.hasAttribute('value') ? resolved.getString('value') : (resolved.child('value')?.getString('value') ?? '');
    expect(patternValue.length).toBeGreaterThan(0);

    const stages = parsed.configs.flatMap((c) => c.children('stage'));
    expect(stages).toHaveLength(1);
    expect(stages[0]!.getString('name')).toBe('ai_default_rca::candidate_action_evaluation_loop');
  });
});
