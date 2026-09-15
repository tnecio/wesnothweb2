/**
 * Fetches `/team-colors.json` (built once by `apps/web/scripts/build-team-
 * colors.mjs`, see that script's own doc comment) exactly once per page
 * load, cached at module scope: this is core content, identical across
 * every scenario/campaign a `GameBoardView` might mount for.
 */
import type { ColorData } from '@wesnothweb2/renderer';

let cached: Promise<ColorData | null> | null = null;

/**
 * Resolves to `null` (not a thrown error) if the asset is missing/
 * unreachable -- `ImageCache.setColorData(null)` is exactly upstream's own
 * "no color data available" state, which just skips the `~RC`/`~TC`
 * recolor (units render in their raw reference palette), the same
 * graceful degradation the terrain rules loader uses for its own asset
 * (`terrain/terrainLayoutClient.ts` in the renderer).
 */
export function fetchTeamColors(): Promise<ColorData | null> {
  cached ??= (async () => {
    try {
      const res = await fetch('/team-colors.json');
      if (!res.ok) {
        console.warn(`[teamColorsCache] ${res.status} fetching team-colors.json -- units will render unrecolored`);
        return null;
      }
      return (await res.json()) as ColorData;
    } catch (err) {
      console.warn('[teamColorsCache] failed to load team-colors.json -- units will render unrecolored', err);
      return null;
    }
  })();
  return cached;
}
