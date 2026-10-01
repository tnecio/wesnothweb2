import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { layoutTerrain } from '@wesnothweb2/renderer/src/terrain/terrainLayout.js';
import { mergeBuildingRules, ownTerrainGraphicsRules, reviveBuildingRules } from '@wesnothweb2/renderer/src/terrain/terrainGraphicsRules.js';

/**
 * Phase 28c C1: a campaign's own terrain types and `[terrain_graphics]`, and a scenario's, reach the board.
 * Under the Burning Suns adds both, and its first scenario draws a smashed great tree with a rule of its own.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const coreRules = reviveBuildingRules(JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/terrain-graphics-rules.json'), 'utf8')));
const utbs1 = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Under_the_Burning_Suns/01_The_Morning_After.json'));

describe('campaign and scenario terrain (Under the Burning Suns 1)', () => {
  it("carries the campaign's terrain types and rules, and the scenario's own rule", () => {
    const strings = (utbs1.terrainTypeConfigs ?? []).map((t) => t.attrs['string']);
    expect(strings.length).toBeGreaterThan(280);
    expect(utbs1.campaignTerrainGraphicsRules?.length).toBeGreaterThan(0);
    expect(utbs1.scenarioTerrainGraphicsRules?.length).toBe(1);
  });

  it('lays the scenario out with them: the smashed great tree appears, as it does nowhere in core', () => {
    const own = reviveBuildingRules(structuredClone(ownTerrainGraphicsRules(utbs1)));
    const withOwn = layoutTerrain(mergeBuildingRules(coreRules, own), utbs1.terrain, utbs1.map.width, utbs1.map.height);
    const coreOnly = layoutTerrain(coreRules, utbs1.terrain, utbs1.map.width, utbs1.map.height);
    expect(withOwn.refs.some((r) => r.includes('terrain/great-tree-smashed.png'))).toBe(true);
    expect(coreOnly.refs.some((r) => r.includes('great-tree-smashed'))).toBe(false);
  });
});
