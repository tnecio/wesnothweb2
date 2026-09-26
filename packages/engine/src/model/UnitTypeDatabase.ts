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
 * 1. **`[base_unit]`** (a `[unit_type]` CHILD TAG, e.g. `[base_unit]
 *    id=Bandit [/base_unit]` -- NOT a `base_unit=` attribute; real Wesnoth
 *    (`types.cpp`'s constructor: `cfg.optional_child("base_unit")` /
 *    `base_unit["id"]`) never reads an attribute of that name at all): the
 *    derived type inherits every attribute from the base type's OWN
 *    (already-flattened, recursively) config, EXCEPT where the derived
 *    type's own config already sets that attribute directly. Attribute-level
 *    inheritance: derived wins wherever it actually sets the attribute; base
 *    fills in anything left unset. `flattenUnitTypeConfig` below implements
 *    exactly this, recursively (a base type can itself have a `[base_unit]`).
 *    Real content DOES use this: Liberty's `units/Villagers.cfg` reskins
 *    Thug/Bandit/Highwayman as Peasant/Village-Elder/Senior-Village-Elder
 *    via exactly this tag (its "outlaw_type_hack" trick) -- discovered when
 *    Liberty scenario 1 rendered Baldras and other villager-disguised units
 *    as blank white placeholder circles, because the (previously untested
 *    against any real content) attribute-based check here never matched.
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
 *    silently corrupt any REAL stat this project ships: every real
 *    `[base_unit]` USER found so far (Liberty's Villagers.cfg, reskinning
 *    Thug/Bandit/Highwayman) only adds a small `[abilities]` marker tag
 *    (`outlaw_type_hack`, a cosmetic unit-box-color hint this engine doesn't
 *    model) on the derived side, and the base types it points at
 *    (`data/core/units/humans/Outlaw*.cfg`) have no `[abilities]` block at
 *    all to lose -- so wholesale-replace-if-any-children never collides with
 *    a genuine partial override in real content today. Flagged here rather
 *    than silently assumed correct in general, per this project's testing
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
export function mergeUnitTypeConfig(base: WmlConfig, derived: WmlConfig): WmlConfig {
  const merged = new WmlConfig();

  for (const key of base.attributeNames()) merged.setAttribute(key, base.get(key)!);
  for (const key of derived.attributeNames()) merged.setAttribute(key, derived.get(key)!);

  // Children merge POSITIONALLY per tag, mirroring `config::merge_with`
  // (config.cpp:1097, which `inherit_from` runs the base through): the
  // derived type's Nth `[attack]` merges *into* the base's Nth `[attack]`
  // rather than replacing the list, and anything left over is appended.
  //
  // Real, reported gameplay bug (bugs6.md): Liberty's Footpad_Peasant
  // could not attack at all. It is a reskin -- `[base_unit] id=Footpad`
  // -- whose entire `[attack]` block is `damage=4`, meaning "same club as
  // a Footpad, weaker". Replacing the list left it holding one nameless,
  // rangeless, typeless attack, so no weapon was ever usable. Thug_Peasant
  // overrides no attack at all, which is why it worked and made the bug
  // look unit-specific.
  const consumed = new Map<string, number>();
  for (const { tag, config } of base.allChildren()) {
    const incoming = derived.children(tag);
    const next = consumed.get(tag) ?? 0;
    if (next >= incoming.length) {
      merged.addChild(tag, config);
      continue;
    }
    consumed.set(tag, next + 1);
    const override = incoming[next]!;
    // `__remove=yes` deletes the base's child instead of merging into it.
    if (override.getBoolean('__remove', false)) continue;
    merged.addChild(tag, mergeUnitTypeConfig(config, override));
  }

  // Whatever the derived type declares beyond what the base had, in its
  // own document order.
  const seen = new Map<string, number>();
  for (const { tag, config } of derived.allChildren()) {
    const index = seen.get(tag) ?? 0;
    seen.set(tag, index + 1);
    if (index >= (consumed.get(tag) ?? 0)) merged.addChild(tag, config);
  }

  return merged;
}

/**
 * Resolves `id`'s fully-flattened config: itself if it has no `[base_unit]`
 * child, otherwise the base type's own (recursively flattened) config merged
 * with its own attributes/children on top (see module doc comment). Memoizes
 * via `cache` (shared across a whole `flattenAllUnitTypes` call, or pass your
 * own to flatten one id at a time against a larger raw registry). Throws on
 * an unknown id or a circular `[base_unit]` chain.
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

  const baseUnitTag = raw.child('base_unit');
  if (!baseUnitTag) {
    cache.set(id, raw);
    return raw;
  }

  if (resolving.has(id)) {
    throw new Error(`flattenUnitTypeConfig: circular base_unit chain involving "${id}"`);
  }
  resolving.add(id);
  const baseId = baseUnitTag.getString('id');
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

// ---------------------------------------------------------------------------
// Race-level trait pools and name generators (Phase 18b)
// ---------------------------------------------------------------------------

/** Every `[race]` in a parsed tree, keyed by `id=`, first definition winning (as for unit types). */
export function collectRaceConfigs(cfg: WmlConfig, out: Map<string, WmlConfig> = new Map()): Map<string, WmlConfig> {
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'race') {
      const id = config.getString('id');
      if (id && !out.has(id)) out.set(id, config);
    } else if (tag !== 'unit_type') {
      collectRaceConfigs(config, out);
    }
  }
  return out;
}

/** The global `[units][trait]`s every race gets unless it says `ignore_global_traits` (`unit_type_data::set_config`). */
export function collectGlobalTraits(cfg: WmlConfig): WmlConfig[] {
  const units = cfg.child('units');
  return units ? units.children('trait') : [];
}

/**
 * How many synced random numbers naming one unit of `race` and `gender`
 * consumes -- not the name itself, which this port does not generate, but
 * the draws, which a replay must reproduce. Upstream made the count fixed
 * on purpose (`markov_generator::generate` always draws `max_len` = 12, "to
 * avoid [...] traits to be different"; `context_free_grammar_generator`
 * always draws its 20-number seed), so it depends only on which generator
 * the race has (`name_generator_factory`): `<gender>_name_generator=`,
 * else `<gender>_names=`, else the ungendered `name_generator=`/`names=`,
 * else none at all.
 */
export function nameDrawCount(race: WmlConfig | undefined, gender: 'male' | 'female'): number {
  if (!race) return 0;
  const markov = (list: string): number =>
    list.split(',').some((n) => n.trim() !== '') && race.getNumber('markov_chain_size', 2) > 0 ? 12 : 0;
  for (const prefix of [`${gender}_`, '']) {
    if (race.hasAttribute(`${prefix}name_generator`)) return 20;
    const names = race.getString(`${prefix}names`, '');
    if (names.trim() !== '') return markov(names);
  }
  return 0;
}

/**
 * Folds each unit type's race into its own config the way upstream's
 * `unit_type` constructor does (`types.cpp`, `build_help_index`): the
 * possible traits in upstream's order -- the global ones (unless the race
 * ignores them), then the race's own (a neutral type skips `fearless`;
 * `ignore_race_traits=yes` drops everything so far), then the type's own --
 * `num_traits=` falling back to the race's (0 with no race), and the name
 * generator's draw counts. The order matters: a random trait is picked by
 * index into this list. Marks the result `traits_resolved=yes` so
 * `UnitType.fromConfig` uses it as-is.
 */
export function resolveTraitPools(
  flattened: Map<string, WmlConfig>,
  races: ReadonlyMap<string, WmlConfig>,
  globalTraits: readonly WmlConfig[],
): void {
  for (const cfg of flattened.values()) {
    const race = races.get(cfg.getString('race', ''));
    let pool: WmlConfig[] = [...globalTraits];
    if (race) {
      if (race.getBoolean('ignore_global_traits', false)) pool = [];
      if (cfg.getBoolean('ignore_race_traits', false)) {
        pool = [];
      } else {
        const neutral = cfg.getString('alignment', 'neutral') === 'neutral';
        for (const t of race.children('trait')) {
          if (!neutral || t.getString('id') !== 'fearless') pool.push(t);
        }
      }
    }
    pool.push(...cfg.children('trait'));
    cfg.removeChildren('trait');
    for (const t of pool) cfg.addChild('trait', t);
    if (!cfg.hasAttribute('num_traits')) cfg.setAttribute('num_traits', race ? race.getNumber('num_traits', 0) : 0);
    cfg.setAttribute('name_draws_male', nameDrawCount(race, 'male'));
    cfg.setAttribute('name_draws_female', nameDrawCount(race, 'female'));
    cfg.setAttribute('traits_resolved', true);
  }
}
