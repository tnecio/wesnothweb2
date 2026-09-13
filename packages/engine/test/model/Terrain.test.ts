import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { TerrainTypeData, parseTerrainCode } from '../../src/model/Terrain.js';
import { MoveType, UNREACHABLE } from '../../src/model/MoveType.js';

/**
 * Real, reported bug: every forest-on-grassland (etc.) hex on any real map
 * was impassable to every unit -- `Gll^Fp` (pine forest), among many other
 * "overlay declares aliasof=_bas,<group>" terrains, resolved to
 * `UNREACHABLE` regardless of a unit's actual forest movement cost. Root
 * cause was `mergeAliasList` (Terrain.ts) splicing base/overlay alias lists
 * in the wrong direction relative to upstream's `merge_alias_lists`
 * (src/terrain/terrain.cpp) -- see that function's own doc comment for the
 * full trace. This test loads the REAL `data/core/terrain.cfg` (the exact
 * WML this bug lived in) so a regression of the merge direction is caught
 * against real content, not a synthetic terrain table.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadRealTerrainData(): TerrainTypeData {
  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map() });
  return TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));
}

function moveTypeWithCosts(terrainData: TerrainTypeData, costs: Record<string, number>): MoveType {
  const cfg = new WmlConfig();
  const costsCfg = new WmlConfig();
  for (const [id, cost] of Object.entries(costs)) costsCfg.setAttribute(id, cost);
  cfg.addChild('movement_costs', costsCfg);
  return MoveType.fromConfig(cfg, terrainData);
}

describe('TerrainType.combine / mergeAliasList (real data/core/terrain.cfg)', () => {
  const terrainData = loadRealTerrainData();

  it('resolves a forest-on-grassland overlay (Gll^Fp, pine forest) to the real forest cost, not UNREACHABLE', () => {
    const moveType = moveTypeWithCosts(terrainData, { flat: 1, forest: 2 });
    const code = parseTerrainCode('Gll^Fp');
    expect(terrainData.isKnown(code)).toBe(true);
    expect(moveType.movementCost(code)).toBe(2);
  });

  it('resolves a plain grassland base to its own cost (sanity check, unaffected by the overlay merge)', () => {
    const moveType = moveTypeWithCosts(terrainData, { flat: 1, forest: 2 });
    expect(moveType.movementCost(parseTerrainCode('Gll'))).toBe(1);
  });

  it('a unit with no forest entry at all (defaults to UNREACHABLE) is still blocked from forest -- the fix must not make forest universally passable', () => {
    const moveType = moveTypeWithCosts(terrainData, { flat: 1 });
    expect(moveType.movementCost(parseTerrainCode('Gll^Fp'))).toBe(UNREACHABLE);
  });

  it('resolves a snow forest overlay (Aa^Fpa) via its own multi-alias chain (_bas, At, Ft)', () => {
    const moveType = moveTypeWithCosts(terrainData, { frozen: 3, forest: 2 });
    // aliasof=_bas,At,Ft: real semantics take the worst (highest) of {base (frozen=3), At (frozen=3), Ft (forest=2)} => 3.
    expect(moveType.movementCost(parseTerrainCode('Aa^Fpa'))).toBe(3);
  });
});
