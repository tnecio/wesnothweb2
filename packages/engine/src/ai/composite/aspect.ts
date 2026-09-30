/**
 * TS port of upstream's `composite_aspect<T>` (`src/ai/composite/
 * aspect.hpp/.cpp`): a named AI knob (`aggression`, `caution`,
 * `recruitment_pattern`, ...) whose effective value is either a constant
 * default or one of several `[facet]`s conditionally active by
 * `turns=`/`time_of_day=`.
 *
 * Deliberately NOT ported (documented gap, not silently missing): the
 * `invalidate_on_turn_start`/`invalidate_on_tod_change`/
 * `invalidate_on_gamestate_change` caching-invalidation machinery.
 * Upstream needs it because resolving some aspects (especially `attacks`,
 * the AI's own attack-combination analysis) is expensive; this port
 * simply re-resolves an aspect's active facet fresh on every read, which
 * is correct (never stale) and cheap for every aspect except `attacks`
 * (Phase 29 S2 -- ported separately, with its own real caching, since
 * it's the one aspect where this actually matters for performance).
 */

import { WmlConfig } from '../../wml/config.js';

/**
 * Parses upstream's `utils::parse_range`-style comma list ("3", "5-9",
 * "12-" meaning 12 and beyond) and reports whether `turn` falls in any of
 * it. An empty spec matches nothing by itself -- callers combine this
 * with the "empty turns= means always active" rule at the call site (see
 * `isAspectActive`), matching upstream's own precedence (an empty
 * `turns=` doesn't restrict activity at all, it isn't "matches turn 0").
 */
function turnInRangeSpec(turn: number, spec: string): boolean {
  for (const part of spec.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const dash = token.indexOf('-');
    if (dash === -1) {
      if (Number(token) === turn) return true;
      continue;
    }
    const lo = Number(token.slice(0, dash));
    const hiToken = token.slice(dash + 1).trim();
    const hi = hiToken === '' ? Infinity : Number(hiToken);
    if (!Number.isNaN(lo) && turn >= lo && turn <= hi) return true;
  }
  return false;
}

/**
 * Mirrors `readonly_context_impl::is_active` (`src/ai/contexts.cpp`):
 * both `turns=`/`time_of_day=` empty means always active; a non-empty
 * `time_of_day=` that doesn't match the current ToD id fails immediately
 * regardless of `turns=`; otherwise a non-empty `turns=` must match the
 * current turn.
 */
export function isAspectActive(turnsSpec: string, timeOfDaySpec: string, turnNumber: number, timeOfDayId: string): boolean {
  if (timeOfDaySpec.trim() !== '') {
    const ids = timeOfDaySpec
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!ids.includes(timeOfDayId)) return false;
  }
  if (turnsSpec.trim() !== '') {
    return turnInRangeSpec(turnNumber, turnsSpec);
  }
  return true;
}

/**
 * One `[default]` or `[facet]` entry of a composite aspect. `body` is the
 * facet's own config, carrying either a scalar `value=` attribute or a
 * `[value]` child config, depending on the aspect's real type (see each
 * `AiContext` typed getter for which it reads). `id=''` marks the
 * `[default]` facet (upstream: unnamed, never matched/removed by id).
 */
export interface AspectFacet {
  readonly id: string;
  readonly turns: string;
  readonly timeOfDay: string;
  readonly body: WmlConfig;
}

/** Builds an `AspectFacet` from a `[default]` or `[facet]` WmlConfig (its own attrs/children are the facet's `body`). */
export function facetFromConfig(cfg: WmlConfig): AspectFacet {
  return {
    id: cfg.getString('id', ''),
    turns: cfg.getString('turns', ''),
    timeOfDay: cfg.getString('time_of_day', ''),
    body: cfg,
  };
}

/**
 * Mirrors `composite_aspect<T>`: a `[default]` value plus zero or more
 * `[facet]`s, added in document order. `resolve()` mirrors
 * `composite_aspect::recalculate()`: the LAST-added active facet wins,
 * falling back to the default when none are active.
 */
export class CompositeAspect {
  readonly id: string;
  private defaultFacet: AspectFacet;
  private facets: AspectFacet[] = [];

  constructor(id: string, defaultFacet: AspectFacet) {
    this.id = id;
    this.defaultFacet = defaultFacet;
  }

  addFacet(facet: AspectFacet): void {
    this.facets.push(facet);
  }

  /** Mirrors `[modify_ai] path=aspect[id].facet[<facetId>] action=delete` (`*` deletes every facet). Returns whether a facet was actually removed. */
  deleteFacet(facetId: string): boolean {
    const before = this.facets.length;
    this.facets = facetId === '*' ? [] : this.facets.filter((f) => f.id !== facetId);
    return this.facets.length !== before;
  }

  /** `composite_aspect::to_config`: the `[aspect]` with its `[default]` and `[facet]`s. */
  toConfig(): WmlConfig {
    const cfg = new WmlConfig();
    cfg.setAttribute('id', this.id);
    cfg.setAttribute('engine', 'cpp');
    cfg.setAttribute('name', 'composite_aspect');
    cfg.addChild('default', this.defaultFacet.body.clone());
    for (const f of this.facets) cfg.addChild('facet', f.body.clone());
    return cfg;
  }

  setDefault(facet: AspectFacet): void {
    this.defaultFacet = facet;
  }

  /** Resolves the effective facet body for the given turn/time-of-day -- see class doc comment. */
  resolve(turnNumber: number, timeOfDayId: string): WmlConfig {
    for (let i = this.facets.length - 1; i >= 0; i--) {
      const facet = this.facets[i]!;
      if (isAspectActive(facet.turns, facet.timeOfDay, turnNumber, timeOfDayId)) return facet.body;
    }
    return this.defaultFacet.body;
  }
}
