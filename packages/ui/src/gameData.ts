/**
 * Where the upstream game media is served from (Phase 28 S3): images, music and sounds from the wesnoth
 * submodule's `data/`, `images/` and `sounds/`.
 *
 * In development these are the Vite server's `public/game-images*` symlinks into the submodule. A production
 * build sets `VITE_GAME_DATA_URL` to the versioned bucket prefix (`https://<data host>/<submodule commit>`),
 * which mirrors the same three directories, so every path below keeps its shape and only the origin and
 * prefix change. Everything the app itself builds (scenarios, atlases, story, i18n) stays on the app's own
 * origin.
 */
const base = ((import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_GAME_DATA_URL'] ?? '').replace(/\/+$/, '');

/** Upstream `data/` (core and campaign images, music, sounds). */
export const GAME_IMAGES = `${base}/game-images`;
/** Upstream `images/` (engine UI images: buttons, dialogs, cursors, `misc/`). */
export const ENGINE_IMAGES = `${base}/game-images-engine`;
/** Upstream `sounds/` (engine UI sounds). */
export const ENGINE_SOUNDS = `${base}/game-sounds-engine`;
