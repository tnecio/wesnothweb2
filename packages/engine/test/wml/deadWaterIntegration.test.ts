import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWmlFile,
  preloadDefines,
  preloadDefinesFromDir,
  type DefineMap,
} from '../../src/wml/index.js';

/**
 * End-to-end check against real content: parse Dead_Water's first scenario
 * (this project's chosen MVP target, see docs/IMPLEMENTATION_PLAN.md) through
 * the full tokenizer -> preprocessor -> parser pipeline.
 *
 * Two macros must be injected before preprocessing, matching what upstream's
 * game_config_manager does at the application level (NOT the preprocessor's
 * job, so not something parseWml does automatically):
 *  - CAMPAIGN_DEAD_WATER: the `define=` attribute on Dead_Water's [campaign]
 *    tag in _main.cfg. Upstream scans every campaign's [campaign] tag once,
 *    then injects the chosen campaign's `define=` value as a #define before
 *    loading that campaign's own content -- it's how a campaign's
 *    {campaigns/<name>/utils}-style directory includes end up gated behind
 *    `#ifdef CAMPAIGN_<NAME>` without every campaign's content always
 *    loading. Confirmed by reading _main.cfg directly.
 *  - NORMAL: the player's chosen difficulty. core/macros/utils.cfg defines
 *    ON_DIFFICULTY/ON_DIFFICULTY4 (used throughout campaign scenarios for
 *    difficulty-scaled values) only inside `#ifdef EASY|NORMAL|HARD|
 *    NIGHTMARE` blocks -- there is no default, matching upstream (the
 *    engine always has a difficulty selected by the time it preprocesses
 *    scenario content).
 *
 * Any future scenario-loading code in this project needs to inject both
 * kinds of flag the same way before calling into the WML pipeline.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadCoreAndCampaignDefines(campaignDir: string, campaignFlag: string, difficulty = 'NORMAL'): DefineMap {
  const defines: DefineMap = new Map();
  const flag = (name: string) =>
    defines.set(name, {
      name,
      params: [],
      optionalParams: new Map(),
      body: '',
      dir: dataRoot,
      location: '<test-harness>',
    });
  flag(campaignFlag);
  flag(difficulty);
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot });
  return defines;
}

describe('Dead_Water scenario 1 (real content, end-to-end)', () => {
  const campaignDir = path.join(dataRoot, 'campaigns/Dead_Water');
  const defines = loadCoreAndCampaignDefines(campaignDir, 'CAMPAIGN_DEAD_WATER');

  it('preloads the campaign-local macro that a bare directory scan would miss', () => {
    // DW_BIGMAP lives in campaigns/Dead_Water/utils/bigmap.cfg, only reachable
    // via _main.cfg's `{campaigns/Dead_Water/utils}` include -- this is the
    // difference between preloadDefinesFromDir (flat, one directory) and
    // preloadDefines on _main.cfg itself (follows its own {dir} includes).
    expect(defines.has('DW_BIGMAP')).toBe(true);
    // Difficulty-gated macro, proves the NORMAL flag was honored.
    expect(defines.has('ON_DIFFICULTY4')).toBe(true);
  });

  it('parses the real scenario file into a populated tree', () => {
    const scenarioPath = path.join(campaignDir, 'scenarios/01_Invasion.cfg');
    const cfg = parseWmlFile(scenarioPath, { dataRoot, defines: new Map(defines) });

    const scenario = cfg.child('scenario');
    expect(scenario).toBeDefined();
    expect(scenario!.getString('id')).toBe('01_Invasion');
    expect(scenario!.getString('name')).toBe('Invasion!');
    expect(scenario!.getString('map_file')).toBe('Home_1.map');

    const sides = scenario!.children('side');
    expect(sides).toHaveLength(2);
    expect(sides[0]!.getString('controller')).toBe('human');
    // The player's leader is specified inline on [side] (type=/id=/name=),
    // not as a nested [unit] -- also real, valid WML.
    expect(sides[0]!.getString('type')).toBe('Merman Child King');
    expect(sides[0]!.getString('id')).toBe('Kai Krellis');

    // Units placed via {PUT_CITIZEN x y trait1 trait2} macro calls (6 of
    // them) plus named heroes are nested inside [event] blocks (WML's
    // normal "spawn on scenario start" idiom), not direct [scenario]
    // children -- walk the tree to find them all regardless of depth.
    function countTag(node: typeof scenario extends infer T ? NonNullable<T> : never, tag: string): number {
      let count = node.childCount(tag);
      for (const { config } of node.allChildren()) count += countTag(config, tag);
      return count;
    }
    const totalUnits = countTag(scenario!, 'unit');
    expect(totalUnits).toBeGreaterThanOrEqual(13); // 6 citizens + named heroes/enemies
  });
});
