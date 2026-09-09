/**
 * A minimal hand-rolled client-side router -- this app is small enough
 * (two pages: a campaign-picker menu and a play page) that pulling in a
 * routing library would be more ceremony than the problem needs. Real
 * `history.pushState`/`popstate`-backed navigation, so the browser's
 * Back/Forward buttons work exactly as the user expects between the menu
 * and a campaign, and each page has its own real, bookmarkable/shareable
 * URL (`/` for the menu, `/play/<campaignId>` for a campaign) -- both
 * explicit user requirements, not just nice-to-haves.
 *
 * `.svelte.ts` (runes outside a `.svelte` file) is fine here -- unlike
 * `packages/ui`'s `gameSession.ts`, which deliberately avoids runes so
 * plain `tsc --noEmit` stays meaningful (no ambient `$state` types without
 * the Svelte compiler), `apps/web` already depends on Vite's Svelte
 * plugin for everything, so there's no equivalent verification gap here.
 */

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

class Router {
  path = $state(normalize(window.location.pathname));

  constructor() {
    window.addEventListener('popstate', () => {
      this.path = normalize(window.location.pathname);
    });
  }

  /** Pushes a new history entry and updates `path` -- use for an actual user-initiated navigation (e.g. picking a campaign). */
  navigate(path: string): void {
    const next = normalize(path);
    if (next === this.path) return;
    window.history.pushState({}, '', next);
    this.path = next;
  }
}

/** Module-level singleton -- one router for the whole app, matching there being exactly one browser URL bar. */
export const router = new Router();
