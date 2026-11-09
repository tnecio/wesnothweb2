/**
 * Which uncaught errors are the game's own, and so worth the error screen (`errorReporting.svelte.ts`).
 *
 * Real, reported: Safari players on iPhones saw "Something went wrong -- Script error." on the title screen.
 * "Script error." is what a browser reports for an error in a script from another origin, with every detail
 * hidden: content blockers, translators and other Safari extensions put such scripts into pages. The game's
 * own scripts are all served from the page's origin, so their errors always come with a message and a file.
 * And iOS cancels a page's requests when it goes to the background; a fetch nobody waited for then rejects
 * ("Load failed"), which is no reason to stop the game either.
 */

/** The parts of an `ErrorEvent` that tell where the error came from. */
export interface ErrorEventLike {
  readonly message: string;
  readonly error?: unknown;
  readonly filename?: string;
}

/**
 * Not the game's: the opaque cross-origin "Script error." (no error object), or an error raised in a script
 * from another origin or a browser extension (`safari-web-extension:`, `chrome-extension:`, ...).
 */
export function isForeignError(e: ErrorEventLike, pageOrigin: string): boolean {
  if (!e.error && /^Script error\.?$/.test(e.message.trim())) return true;
  if (!e.filename) return false;
  let url: URL;
  try {
    url = new URL(e.filename, pageOrigin);
  } catch {
    return false;
  }
  if (url.protocol === 'blob:') return url.origin !== pageOrigin;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return url.origin !== pageOrigin;
}

/**
 * A request that failed on the network (`fetch` rejecting with a TypeError: Safari's "Load failed", Chrome's
 * "Failed to fetch", Firefox's "NetworkError when attempting to fetch resource."). A module that failed to
 * load ("Importing a module script failed.") is not one of these: the game cannot go on without it.
 */
export function isNetworkFailure(reason: unknown): boolean {
  if (!(reason instanceof TypeError)) return false;
  return /^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|Network request failed|The network connection was lost\.?)$/i.test(reason.message.trim());
}
