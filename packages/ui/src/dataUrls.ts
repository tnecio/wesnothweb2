/**
 * URLs of the app's own data files (Phase 28 S3): scenario snapshots and their databases, image bundles,
 * story assets, derived images, translations and the small JSON files under `apps/web/public/`.
 *
 * A production build serves each of them from a content-hashed path, `/h/<hash>/<path>`, cached for a year
 * (`apps/web/scripts/stage-dist.mjs`), and lists them in one manifest (itself hashed) that `index.html`
 * names in `window.__WESNOTH_DATA_MANIFEST__`. `loadDataManifest` reads it before the app starts, so
 * `dataUrl` can stay synchronous. In development there is no manifest and every path is served as it is.
 */
let manifest: Readonly<Record<string, string>> | null = null;

/** Fetches the build's data manifest, if the page names one. Call once before anything asks for data. */
export async function loadDataManifest(): Promise<void> {
  const url = (globalThis as { __WESNOTH_DATA_MANIFEST__?: string }).__WESNOTH_DATA_MANIFEST__;
  if (!url) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`data manifest ${url}: HTTP ${res.status}`);
  manifest = (await res.json()) as Record<string, string>;
}

/** The URL to fetch `path` (relative to the site root, e.g. `scenarios/_core.json`) from. */
export function dataUrl(path: string): string {
  const key = path.replace(/^\/+/, '');
  return manifest?.[key] ?? `/${key}`;
}
