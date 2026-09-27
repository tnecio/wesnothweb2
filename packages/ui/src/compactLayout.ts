/**
 * Phase 23: the phone layout. "Compact" is a phone in either orientation -- narrow (portrait) or
 * short (landscape); tablets and desktops keep the full layout. The same query is repeated in the
 * components' CSS (`@media (max-width: 720px), (max-height: 500px)`); this store is for the few things
 * CSS alone can't decide, such as the infobox showing a unit card in place of the minimap.
 *
 * `coarsePointer` says whether the primary pointer is a finger, for input that differs by device
 * rather than by screen size.
 */
import { createSubscriber } from 'svelte/reactivity';

export const COMPACT_QUERY = '(max-width: 720px), (max-height: 500px)';

class MediaFlag {
  #query: MediaQueryList | null;
  #subscribe: () => void;

  constructor(query: string) {
    this.#query = typeof matchMedia === 'function' ? matchMedia(query) : null;
    this.#subscribe = createSubscriber((update) => {
      const q = this.#query;
      if (!q) return;
      q.addEventListener('change', update);
      return () => q.removeEventListener('change', update);
    });
  }

  /** Whether the query matches now (reactive when read in a component or effect). */
  get current(): boolean {
    this.#subscribe();
    return this.#query?.matches ?? false;
  }
}

export const compactLayout = new MediaFlag(COMPACT_QUERY);
export const coarsePointer = new MediaFlag('(pointer: coarse)');
