/**
 * TS port of `src/game_events/conditional_wml.hpp/.cpp`: evaluates `[if]`
 * conditions, `[event][filter_condition]`, and the same shape reused by
 * `filter.ts` for a unit filter's own `[and]`/`[or]`/`[not]` composition.
 *
 * Ported builtin conditions: `[variable]` (`variable_matches`, all ten
 * comparison attributes: `equals`/`not_equals`/`numerical_equals`/
 * `numerical_not_equals`/`greater_than`/`less_than`/
 * `greater_than_equal_to`/`less_than_equal_to`/`boolean_equals`/
 * `boolean_not_equals`/`contains`), `[have_unit]` (via `filter.ts`'s unit
 * filter, including `count=`), `[true]`/`[false]`, and `[and]`/`[or]`/
 * `[not]` with the same left-to-right, in-order precedence as upstream
 * (each connective folds against the *running* result so far, not a
 * single final boolean expression tree).
 *
 * NOT ported: `[have_location]` (needs the terrain-filter machinery in
 * `terrain/filter.cpp`, out of scope here -- `filter.ts`'s
 * `locationMatchesFilter` only covers x/y ranges, not the full terrain
 * filter `[have_location]` normally uses), side-filter/role-filter
 * conditionals, and any Lua-registered custom conditional
 * (`wesnoth.wml_conditionals.*`, e.g. content that ships its own `[foo]`
 * condition via `[lua]`) -- those are silently treated as passing
 * (matches upstream's own "unknown key -> skip" loop shape once Lua-backed
 * conditionals exist; here it's simply that no handler is registered for
 * them yet).
 */

import type { WmlConfig } from '../wml/config.js';
import type { EventContext } from './context.js';
import { findLocations, findUnits } from './filter.js';

/** Parses a WML count= range list ("1-infinity", "2", "1-3,5") the same way `have_unit`'s count= does. */
function parseCounts(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const part of text.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const dash = token.indexOf('-');
    if (dash === -1) {
      const n = Number(token);
      if (!Number.isNaN(n)) ranges.push([n, n]);
    } else {
      const loStr = token.slice(0, dash);
      const hiStr = token.slice(dash + 1);
      const lo = loStr === '' ? 0 : Number(loStr);
      const hi = hiStr === 'infinity' ? Infinity : Number(hiStr);
      ranges.push([lo, hi]);
    }
  }
  return ranges;
}

function inCounts(n: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

const DEFAULT_COUNTS: Array<[number, number]> = [[1, Infinity]];

function haveUnit(cfg: WmlConfig, ctx: EventContext): boolean {
  const counts = cfg.hasAttribute('count') ? parseCounts(cfg.getString('count')) : DEFAULT_COUNTS;
  const includeRecall = cfg.getBoolean('search_recall_list', false);
  const matched = findUnits(ctx.board, cfg, includeRecall).filter((u) => u.hitpoints > 0);
  return inCounts(matched.length, counts);
}

function variableMatches(cfg: WmlConfig, ctx: EventContext): boolean {
  const name = cfg.getString('name', '');
  if (name === '') {
    ctx.log('error', '[variable] with missing name=');
    return true;
  }
  const value = ctx.variables.get(name);
  const strValue = value === undefined ? '' : String(value);
  const numValue = value === undefined ? 0 : Number(value);
  const boolValue = value === undefined ? false : value === true || value === 'yes' || value === 'true' || value === 1 || value === '1';

  if (cfg.hasAttribute('equals')) return strValue === cfg.getString('equals');
  if (cfg.hasAttribute('not_equals')) return strValue !== cfg.getString('not_equals');
  if (cfg.hasAttribute('numerical_equals')) return numValue === cfg.getNumber('numerical_equals');
  if (cfg.hasAttribute('numerical_not_equals')) return numValue !== cfg.getNumber('numerical_not_equals');
  if (cfg.hasAttribute('greater_than')) return numValue > cfg.getNumber('greater_than');
  if (cfg.hasAttribute('less_than')) return numValue < cfg.getNumber('less_than');
  if (cfg.hasAttribute('greater_than_equal_to')) return numValue >= cfg.getNumber('greater_than_equal_to');
  if (cfg.hasAttribute('less_than_equal_to')) return numValue <= cfg.getNumber('less_than_equal_to');
  if (cfg.hasAttribute('boolean_equals')) return boolValue === cfg.getBoolean('boolean_equals');
  if (cfg.hasAttribute('boolean_not_equals')) return boolValue !== cfg.getBoolean('boolean_not_equals');
  if (cfg.hasAttribute('contains')) return strValue.includes(cfg.getString('contains'));

  ctx.log('error', `[variable] name='${name}' found with no comparison attribute`);
  return true;
}

export const builtinConditions: Record<string, (cfg: WmlConfig, ctx: EventContext) => boolean> = {
  have_unit: haveUnit,
  variable: variableMatches,
  // wml_conditionals.have_location: how many hexes match the location filter, against count= (default 1-infinity).
  have_location: (cfg, ctx) => {
    const counts = cfg.hasAttribute('count') ? parseCounts(cfg.getString('count')) : DEFAULT_COUNTS;
    return inCounts(findLocations(ctx.board, cfg).length, counts);
  },
  // object.lua's wml_conditionals.found_item: was the [object] with this id taken?
  found_item: (cfg, ctx) => ctx.usedItems.has(cfg.getString('id', '')),
};

const CONNECTIVE_OR_BRANCH_TAGS = new Set(['then', 'else', 'elseif', 'not', 'and', 'or', 'do']);

function internalConditionalPassed(cond: WmlConfig, ctx: EventContext): boolean {
  if (cond.hasChild('true')) return true;
  if (cond.hasChild('false')) return false;

  for (const { tag, config } of cond.allChildren()) {
    if (CONNECTIVE_OR_BRANCH_TAGS.has(tag)) continue;
    const handler = builtinConditions[tag];
    if (!handler) continue; // unregistered/Lua-only conditional -- treated as passing, see module doc comment.
    if (!handler(ctx.variables.expandConfig(config), ctx)) return false;
  }
  return true;
}

/**
 * Evaluates an `[if]`/`[filter_condition]`/`[elseif]`-shaped condition
 * config against the current game state. Mirrors `conditional_passed`:
 * builtin conditions (`[variable]`, `[have_unit]`, ...) are AND-ed
 * together, then `[and]`/`[or]`/`[not]` children are folded in document
 * order against the running result.
 */
export function conditionalPassed(cond: WmlConfig, ctx: EventContext): boolean {
  let matches = internalConditionalPassed(cond, ctx);

  for (const { tag, config } of cond.allChildren()) {
    if (tag === 'and') matches = matches && conditionalPassed(ctx.variables.expandConfig(config), ctx);
    else if (tag === 'or') matches = matches || conditionalPassed(ctx.variables.expandConfig(config), ctx);
    else if (tag === 'not') matches = matches && !conditionalPassed(ctx.variables.expandConfig(config), ctx);
  }

  return matches;
}
