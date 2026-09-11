/**
 * Loader that turns a raw, WML-authored `[unit_type]` config tree (as parsed
 * straight out of `data/core/units.cfg`/a campaign's own unit files) into
 * the fully-flattened per-id configs `UnitType.fromConfig` expects -- see
 * that module's own doc comment, which explicitly defers this step
 * ("a loader building `UnitType`s from parsed WML should do the equivalent
 * flattening before calling `UnitType.fromConfig`, so it isn't duplicated
 * here"). This is that loader.
 *
 * Real semantics this ports from `src/units/types.cpp`/`src/config.cpp`
 * (`unit_type::unit_type`, `apply_base_unit`, `config::inherit_from`):
 *
 * 1. **`base_unit=`** (a `[unit_type]` attribute naming another unit_type's
 *    `id`): the derived type inherits every attribute from the base type's
 *    OWN (already-flattened, recursively) config, EXCEPT where the derived
 *    type's own config already sets that attribute directly. Attribute-level
 *    inheritance: derived wins wherever it actually sets the attribute; base
 *    fills in anything left unset. `flattenUnitTypeConfig` below implements
 *    exactly this, recursively (a base type can itself have a `base_unit=`).
 *
 * 2. **Child tags** (`[attack]`, `[movement_costs]`, `[vision_costs]`,
 *    `[jamming_costs]`, `[defense]`, `[resistance]`, `[abilities]`, and --
 *    for simplicity, uniformly -- every other child tag too): **derived
 *    REPLACES base wholesale for a given tag name if the derived config has
 *    ANY children with that tag name, otherwise inherits base's children for
 *    that tag name wholesale.** This is a deliberate simplification versus
 *    upstream's real `config::inherit_from`/`merge_with`, which recursively
 *    merges same-tag children *pairwise by declaration order* (so e.g. a
 *    derived type's first `[attack]` merges attribute-by-attribute into the
 *    base's first `[attack]`, its second into the base's second, etc. --
 *    not a blunt "replace or inherit the whole set"). Verified this doesn't
 *    silently corrupt any REAL stat this project ships: `base_unit=` is not
 *    used ANYWHERE in the entire `wesnoth` submodule's `data/` tree (checked
 *    directly -- `grep -rl "base_unit=" wesnoth/data/` finds nothing), so
 *    this simplification's code path is exercised only by this module's own
 *    synthetic tests, never by real content in this project today. Flagged
 *    here rather than silently assumed correct, per this project's testing
 *    discipline (see docs/PROGRESS.md).
 *
 * 3. **`[male]`/`[female]` sub-tags are deliberately NOT flattened at all**
 *    (their content is simply never read) -- this project has no gendered
 *    recruiting UI, so only the default/genderless top-level config matters.
 *    Confirmed safe against every real unit type this project's target
 *    scenario needs (all ~332 types reachable from `data/core/units.cfg`
 *    plus Dead_Water's own unit files): only two files anywhere under
 *    `data/core/units/` use `[male]`/`[female]` at all --
 *    `monsters/Horse_Black.cfg` and `monsters/Horse_Dark.cfg` -- and both
 *    declare hitpoints/movement/attacks/resistances at the top `[unit_type]`
 *    level already; their `[male]`/`[female]` blocks only override cosmetic
 *    `name=`/`profile=`/`image=` and grant trait pools we don't model. No
 *    real type has stats ONLY inside `[male]`/`[female]`.
 */

import { WmlConfig } from '../wml/config.js';

/**
 * Walks a parsed WML tree collecting every `[unit_type]`'s raw (unflattened)
 * config, keyed by `id=` -- first-seen wins (matches upstream's "first
 * definition of a given id wins" duplicate-id behavior). Recurses into every
 * child regardless of tag (mirrors `build-scenario-snapshot.mjs`'s existing
 * `collectUnitTypeImages`, which this is deliberately kept traversal-
 * identical to, so the same real files produce the same id set both places).
 */
export function collectUnitTypeConfigs(cfg: WmlConfig, out: Map<string, WmlConfig> = new Map()): Map<string, WmlConfig> {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'unit_type') {
      const id = config.getString('id');
      if (id && !out.has(id)) out.set(id, config);
      collectUnitTypeConfigs(config, out);
    } else {
      collectUnitTypeConfigs(config, out);
    }
  }
  return out;
}

/**
 * Walks a parsed WML tree collecting every top-level `[movetype]` block,
 * keyed by `name=` -- the registry `UnitType.fromConfig`'s `movementTypes`
 * parameter expects. In real content these all live inside `data/core/
 * units.cfg`'s `[units]` block (38 of them, alongside `[race]` and the
 * `{core/units/...}`-included `[unit_type]`s), not a separate file.
 */
export function collectMovementTypeConfigs(cfg: WmlConfig, out: Map<string, WmlConfig> = new Map()): Map<string, WmlConfig> {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'movetype') {
      const name = config.getString('name');
      if (name && !out.has(name)) out.set(name, config);
    } else {
      collectMovementTypeConfigs(config, out);
    }
  }
  return out;
}

/**
 * Walks a parsed WML tree collecting every child of a top-level
 * `[units][weapon_specials]` or `[units][abilities]` block, keyed by
 * `unique_id=` (falling back to `id=`) -- mirrors
 * `unit_type_data::set_config`'s own registry-building loop
 * (`cfg.child_range("weapon_specials")`/`cfg.child_range("abilities")`,
 * where `cfg` is `[units]`'s own merged content) and
 * `add_registry_entries`'s id-resolution rule. Deliberately only looks at
 * DIRECT children of `[units]` for `containerTag` -- a `[unit_type]`'s
 * OWN `[abilities]` block (its instance abilities, not the registry) must
 * NOT be picked up here, so this does not recurse into `[unit_type]`
 * (unlike `collectUnitTypeConfigs`, which needs to find `[unit_type]`s
 * wherever they're nested).
 *
 * This is what makes real content's `specials_list=`/`abilities_list=`
 * shorthand (e.g. `[attack] specials_list=marksman,poison`, `[unit_type]
 * abilities_list=skirmisher` -- both common in real `data/core/units/`
 * content) resolve to the same real special/ability configs a unit using
 * the equivalent inline `[specials][poison]...` / `[abilities][skirmisher]
 * ...` would get. Without this registry, any real unit relying on the
 * shorthand (rather than inline tags) would silently have NONE of its
 * specials/abilities recognized by this engine at all.
 *
 * Registry entries carry their own tag name alongside the config (not
 * just the bare attributes) because for abilities specifically, real
 * content's `id=` does NOT double as a type discriminator the way it
 * does for weapon specials: e.g. the real `heals`-tagged registry entries
 * `heals_4`/`heals_8`/`cures` all set `id=healing` or `id=curing` (a
 * *display* id, distinct per healing strength/purpose), never literally
 * `id=heals` -- upstream itself matches "does this unit have a heals
 * ability" by TAG NAME (`tag_name == "heals"`, `src/units/abilities.cpp`),
 * not by `id=`. `UnitType.abilities` preserves this; weapon specials
 * happen to have `id=` == tag name for every real special this project
 * evaluates today (spot-checked: poison/drains/plague/marksman/etc.), so
 * `AttackType.specials` stays a flat config list and callers keep
 * matching by `id=` there -- flagged here rather than assumed safe for
 * every possible custom special.
 */
export function collectSpecialRegistry(
  cfg: WmlConfig,
  containerTag: 'weapon_specials' | 'abilities',
  out: Map<string, { tag: string; config: WmlConfig }> = new Map(),
): Map<string, { tag: string; config: WmlConfig }> {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'units') {
      for (const container of config.children(containerTag)) {
        for (const entry of container.allChildren()) {
          const id = entry.config.getString('unique_id', '') || entry.config.getString('id', '');
          if (id && !out.has(id)) out.set(id, { tag: entry.tag, config: entry.config });
        }
      }
      // A [units] block can itself be nested inside other wrapper tags in
      // principle (matches collectUnitTypeConfigs' own traversal, which
      // doesn't assume a fixed nesting depth either) -- keep walking its
      // children too, just not back into [weapon_specials]/[abilities]
      // themselves (already fully consumed above).
      for (const { tag: childTag, config: childConfig } of config.allChildren()) {
        if (childTag !== containerTag) collectSpecialRegistry(childConfig, containerTag, out);
      }
    } else {
      collectSpecialRegistry(config, containerTag, out);
    }
  }
  return out;
}

/**
 * Merges `derived` over `base` per this module's doc comment: attribute-
 * level (derived wins wherever set), child-tag-wholesale (derived's own
 * children for a tag name win outright if it has any, else base's).
 */
function mergeUnitTypeConfig(base: WmlConfig, derived: WmlConfig): WmlConfig {
  const merged = new WmlConfig();

  for (const key of base.attributeNames()) merged.setAttribute(key, base.get(key)!);
  for (const key of derived.attributeNames()) merged.setAttribute(key, derived.get(key)!);

  const tags = new Set<string>();
  for (const { tag } of base.allChildren()) tags.add(tag);
  for (const { tag } of derived.allChildren()) tags.add(tag);
  for (const tag of tags) {
    const derivedChildren = derived.children(tag);
    const chosen = derivedChildren.length > 0 ? derivedChildren : base.children(tag);
    for (const child of chosen) merged.addChild(tag, child);
  }

  return merged;
}

/**
 * Resolves `id`'s fully-flattened config: itself if it has no `base_unit=`,
 * otherwise `base_unit`'s own (recursively flattened) config merged with
 * its own attributes/children on top (see module doc comment). Memoizes via
 * `cache` (shared across a whole `flattenAllUnitTypes` call, or pass your
 * own to flatten one id at a time against a larger raw registry). Throws on
 * an unknown id or a circular `base_unit=` chain.
 */
export function flattenUnitTypeConfig(
  id: string,
  rawConfigs: ReadonlyMap<string, WmlConfig>,
  cache: Map<string, WmlConfig> = new Map(),
  resolving: Set<string> = new Set(),
): WmlConfig {
  const cached = cache.get(id);
  if (cached) return cached;

  const raw = rawConfigs.get(id);
  if (!raw) {
    throw new Error(`flattenUnitTypeConfig: no [unit_type] found for id "${id}"`);
  }

  if (!raw.hasAttribute('base_unit')) {
    cache.set(id, raw);
    return raw;
  }

  if (resolving.has(id)) {
    throw new Error(`flattenUnitTypeConfig: circular base_unit chain involving "${id}"`);
  }
  resolving.add(id);
  const baseId = raw.getString('base_unit');
  const baseFlat = flattenUnitTypeConfig(baseId, rawConfigs, cache, resolving);
  resolving.delete(id);

  const merged = mergeUnitTypeConfig(baseFlat, raw);
  cache.set(id, merged);
  return merged;
}

/** Flattens every id in `rawConfigs`, returning a fresh `id -> flattened config` map. */
export function flattenAllUnitTypes(rawConfigs: ReadonlyMap<string, WmlConfig>): Map<string, WmlConfig> {
  const cache = new Map<string, WmlConfig>();
  for (const id of rawConfigs.keys()) flattenUnitTypeConfig(id, rawConfigs, cache);
  return cache;
}
