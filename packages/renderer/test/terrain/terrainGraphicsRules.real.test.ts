import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  preprocess,
  preloadDefinesFromDir,
  parseConfig,
  type DefineMap,
} from '@wesnothweb2/engine/src/wml/index.js';
import { parseTerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import {
  parseTerrainGraphicsRules,
  constraintMatches,
  type BuildingRule,
} from '../../src/terrain/terrainGraphicsRules.js';

/**
 * Real-content verification (this project's established standard, see
 * docs/PROGRESS.md): parses the ACTUAL `data/core/terrain-graphics/` WML
 * tree through the real preprocessor/parser (same macro-expansion path
 * `_main.cfg`'s `{core/terrain-graphics/}` directory-include uses), then
 * checks properties of the resulting rule set that must hold for the real
 * game to render correctly -- not invented fixtures.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function imageExists(relPath: string): boolean {
  // relPath already carries the "terrain/" prefix load_images adds.
  return fs.existsSync(path.join(dataRoot, 'core/images', relPath));
}

let rules: BuildingRule[];

/**
 * Mirrors `data/_main.cfg`'s real load order for this content: `{core/}`
 * resolves to `core/_main.cfg`, whose OWN early line is
 * `{core/terrain-graphics/}` -- a directory of near-entirely `#define`s
 * (macro bodies aren't expanded until invoked, so file order within it
 * doesn't matter). The actual per-terrain rule *invocations* live in a
 * sibling FILE, `core/terrain-graphics.cfg` (singular, not the directory),
 * included separately and later, from the outer `data/_main.cfg` (its own
 * comment: "This file needs to be processed *after* all others in this
 * directory"). Both passes share one macro table, concatenated into one
 * preprocessed stream before parsing -- exactly how the real engine's
 * single continuous pass would see it.
 */
beforeAll(() => {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });

  const coreDir = path.join(dataRoot, 'core');
  const defsPass = preprocess('{core/terrain-graphics/}', {
    currentFile: path.join(coreDir, 'synthetic.cfg'),
    dir: coreDir,
    dataRoot,
    defines,
  });
  const invocationsPass = preprocess('{core/terrain-graphics.cfg}', {
    currentFile: path.join(coreDir, 'synthetic.cfg'),
    dir: coreDir,
    dataRoot,
    defines: defsPass.defines,
  });

  const root = parseConfig(defsPass.text + invocationsPass.text);
  rules = parseTerrainGraphicsRules(root, { imageExists, includeOffMapRule: true });
}, 30_000);

describe('real data/core/terrain-graphics/ content', () => {
  it('parses a large, non-trivial rule set', () => {
    // attempt #1 measured 10,063 built rules against the same real content (see
    // ~/wesnothweb/doc/Refactor_display_layer.md section 3) -- a loose sanity
    // bound, not an exact-match assertion (our existence-filtering source data
    // differs slightly: the apt-installed 1.16.9 tree vs whatever commit that
    // measurement used).
    expect(rules.length).toBeGreaterThan(3000);
  });

  it('includes the hardcoded off-map rule for _off^_usr', () => {
    const found = rules.some((r) =>
      r.constraints.some(
        (c) =>
          c.terrainTypesMatch.length === 1 &&
          c.terrainTypesMatch[0]!.equals(parseTerrainCode('_off^_usr')) &&
          c.images.some((img) => img.variants.some((v) => v.imageString.includes('off-map'))),
      ),
    );
    expect(found).toBe(true);
  });

  it('a plain grassland hex matches at least one real rule with a grass image', () => {
    const grass = parseTerrainCode('Gg');
    const matching = rules.filter((r) =>
      r.constraints.some((c) => c.loc.x === 0 && c.loc.y === 0 && constraintMatches(grass, c.terrainTypesMatch)),
    );
    expect(matching.length).toBeGreaterThan(0);
    const hasGrassImage = matching.some((r) =>
      r.constraints.some((c) =>
        c.loc.x === 0 &&
        c.loc.y === 0 &&
        c.images.some((img) => img.variants.some((v) => v.imageString.toLowerCase().includes('grass'))),
      ),
    );
    expect(hasGrassImage).toBe(true);
  });

  it('rotated multi-hex rules exist (e.g. mountains.cfg edge transitions) with more than one constraint', () => {
    const multiHex = rules.filter((r) => r.constraints.length > 1);
    expect(multiHex.length).toBeGreaterThan(0);
  });

  it('every image variant on every surviving rule resolved to at least one real frame', () => {
    // A rule may legitimately have zero [image]s anywhere (e.g. a flag-only rule like
    // `NEW:SET_FLAG`, "places a flag on a hex, no graphics") -- loadRuleImages accepts
    // those vacuously, matching upstream's load_images. What must never happen is a
    // variant that DOES exist ending up with an empty resolved-images list; that's
    // exactly what loadRuleImages is supposed to reject the whole rule for.
    for (const rule of rules) {
      for (const c of rule.constraints) {
        for (const img of c.images) {
          for (const v of img.variants) {
            expect(v.images.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
