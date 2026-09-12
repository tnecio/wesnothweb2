/**
 * Fetches + revives `/terrain-graphics-rules.json` (built once by
 * `apps/web/scripts/build-terrain-graphics-rules.mjs`, see that script's own
 * doc comment) exactly once per page load, cached at module scope -- this
 * data is core content, identical across every scenario/campaign a
 * `GameBoardView` might mount for, so re-fetching/re-reviving it on every
 * mount (e.g. switching scenarios) would be pure waste.
 */
import { reviveBuildingRules, type BuildingRule } from '@wesnothweb2/renderer';

let cached: Promise<BuildingRule[]> | null = null;

/**
 * Resolves to `[]` (not a thrown error) if the asset is missing/unreachable
 * -- `SnapshotBoard` treats an empty rule list as "fall back to the flat-
 * coloured placeholder", which is the right behavior for e.g. a dev
 * checkout that hasn't run the build script yet, rather than breaking the
 * whole board.
 */
export function fetchTerrainGraphicsRules(): Promise<BuildingRule[]> {
  cached ??= (async () => {
    try {
      const res = await fetch('/terrain-graphics-rules.json');
      if (!res.ok) {
        console.warn(`[terrainGraphicsRulesCache] ${res.status} fetching terrain-graphics-rules.json -- falling back to flat-coloured terrain`);
        return [];
      }
      const json = (await res.json()) as BuildingRule[];
      return reviveBuildingRules(json);
    } catch (err) {
      console.warn('[terrainGraphicsRulesCache] failed to load terrain-graphics-rules.json -- falling back to flat-coloured terrain', err);
      return [];
    }
  })();
  return cached;
}
