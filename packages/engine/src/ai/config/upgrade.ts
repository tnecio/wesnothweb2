/**
 * TS port of the WML-upgrade half of upstream's `ai::configuration`
 * (`src/ai/configuration.cpp`): turning a `[side][ai]` block's simplified
 * syntax (`aggression=0.8`, a bare `[avoid]` child, `ai_algorithm=...`)
 * into the real `[aspect]`/`[stage]` shape the framework runs, and
 * combining it with the real `default_config.cfg` aspect defaults and
 * the chosen `ai_algorithm=` preset (`builtinAiConfigs.generated.ts`).
 *
 * Phase 29 S4 closed the one documented gap this module used to have:
 * `old_goal_tags` (`[target]`/`[target_location]`/`[protect_unit]`/
 * `[protect_location]` as a BARE `[ai]` child, no `[goal]` wrapper --
 * a legacy idiom real content has mostly moved on from in favor of writing
 * `[goal name=target]...[/goal]` directly, but still recognized) is now
 * upgraded into the modern `[goal name=...][criteria]...[/criteria][/goal]`
 * shape `composite/goal.ts`'s `buildGoalsFromConfigs` reads.
 */

import { WmlConfig, type WmlConfigJson } from '../../wml/config.js';
import { CompositeAspect, facetFromConfig } from '../composite/aspect.js';
import { buildGoalsFromConfigs, type Goal } from '../composite/goal.js';

/** Attributes on `[ai]` that are NOT simplified-aspect shorthand -- mirrors `configuration.cpp`'s `non_aspect_attributes`. */
const NON_ASPECT_ATTRIBUTES = new Set(['turns', 'time_of_day', 'engine', 'ai_algorithm', 'id', 'description', 'hidden', 'mp_rank']);

/** Mirrors `configuration.cpp`'s `old_goal_tags` set: a bare `[ai]` child by one of these names (no `[goal]` wrapper) is the legacy goal-authoring idiom. */
const OLD_GOAL_TAGS = new Set(['target', 'target_location', 'protect_unit', 'protect_location']);

/**
 * Mirrors `configuration::expand_simplified_aspects` (`configuration.cpp:
 * 270-390`) for the subset this port currently drives: a bare `key=value`
 * attribute becomes `[aspect id=key][facet value=value turns=.. time_of_day=..][/aspect]`;
 * a bare top-level `[avoid]` child becomes the `avoid` aspect's facet
 * value directly (a config-typed aspect, not a scalar); a bare
 * `[target]`/`[target_location]`/`[protect_unit]`/`[protect_location]`
 * child becomes `[goal name=<tag>][criteria]<the rest of the tag's own
 * attrs/children>[/criteria][/goal]` (`protect_radius=`/`value=` lifted
 * back out of the criteria onto the goal itself, matching upstream); every
 * other child tag (`[engine]`, `[stage]`, `[aspect]`, `[goal]`,
 * `[modify_ai]`, `[micro_ai]`) is copied through verbatim/inert.
 */
export function expandSimplifiedAspects(rawAiCfg: WmlConfig): WmlConfig {
  const out = new WmlConfig();
  for (const key of rawAiCfg.attributeNames()) {
    const value = rawAiCfg.get(key);
    if (value === undefined) continue;
    if (NON_ASPECT_ATTRIBUTES.has(key)) {
      out.setAttribute(key, value);
      continue;
    }
    const aspectCfg = out.addChild('aspect');
    aspectCfg.setAttribute('id', key);
    aspectCfg.setAttribute('engine', 'cpp');
    aspectCfg.setAttribute('name', 'composite_aspect');
    const facet = aspectCfg.addChild('facet');
    facet.setAttribute('engine', 'cpp');
    facet.setAttribute('name', 'standard_aspect');
    facet.setAttribute('value', value);
    if (rawAiCfg.hasAttribute('turns')) facet.setAttribute('turns', rawAiCfg.getString('turns'));
    if (rawAiCfg.hasAttribute('time_of_day')) facet.setAttribute('time_of_day', rawAiCfg.getString('time_of_day'));
  }
  for (const { tag, config } of rawAiCfg.allChildren()) {
    if (tag === 'avoid') {
      const aspectCfg = out.addChild('aspect');
      aspectCfg.setAttribute('id', 'avoid');
      aspectCfg.setAttribute('engine', 'cpp');
      aspectCfg.setAttribute('name', 'composite_aspect');
      const facet = aspectCfg.addChild('facet');
      facet.setAttribute('engine', 'cpp');
      facet.setAttribute('name', 'standard_aspect');
      facet.addChild('value', config);
      continue;
    }
    if (OLD_GOAL_TAGS.has(tag)) {
      const goalCfg = out.addChild('goal');
      goalCfg.setAttribute('name', tag);
      if (rawAiCfg.hasAttribute('turns')) goalCfg.setAttribute('turns', rawAiCfg.getString('turns'));
      if (rawAiCfg.hasAttribute('time_of_day')) goalCfg.setAttribute('time_of_day', rawAiCfg.getString('time_of_day'));
      const criteria = goalCfg.addChild('criteria');
      for (const k of config.attributeNames()) {
        const v = config.get(k);
        if (v === undefined) continue;
        if (tag.startsWith('protect') && k === 'protect_radius') goalCfg.setAttribute('protect_radius', v);
        else if (k === 'value') goalCfg.setAttribute('value', v);
        else criteria.setAttribute(k, v);
      }
      for (const child of config.allChildren()) criteria.addChild(child.tag, child.config);
      continue;
    }
    // Every other child tag copied through verbatim -- see module doc comment.
    out.addChild(tag, config);
  }
  return out;
}

/**
 * Merges every `[aspect]` child across `configs` (in application order)
 * by `id=` -- mirrors `parse_side_config`'s
 * `merge_children_by_attribute("aspect","id")`: a later block's own
 * `[facet]`s are appended AFTER earlier ones', so (combined with
 * `CompositeAspect.resolve`'s "last active facet wins") a scenario's own
 * facet correctly outranks `default_config.cfg`'s `[default]`. A later
 * block's `[default]` (rare -- real content essentially never overrides
 * one) replaces the running default.
 */
export function buildAspects(configs: readonly WmlConfig[]): Map<string, CompositeAspect> {
  const aspects = new Map<string, CompositeAspect>();
  for (const cfg of configs) {
    for (const { tag, config: aspectCfg } of cfg.allChildren()) {
      if (tag !== 'aspect') continue;
      const id = aspectCfg.getString('id', '');
      if (id === '') continue;
      let aspect = aspects.get(id);
      const defaultChild = aspectCfg.child('default');
      if (!aspect) {
        const defaultFacet = defaultChild ? facetFromConfig(defaultChild) : { id: '', turns: '', timeOfDay: '', body: new WmlConfig() };
        aspect = new CompositeAspect(id, defaultFacet);
        aspects.set(id, aspect);
      } else if (defaultChild) {
        aspect.setDefault(facetFromConfig(defaultChild));
      }
      for (const facetCfg of aspectCfg.children('facet')) {
        aspect.addFacet(facetFromConfig(facetCfg));
      }
    }
  }
  return aspects;
}

export interface ParsedSideAiConfig {
  readonly aspects: Map<string, CompositeAspect>;
  /** Every `[goal]` across `configs`, in declaration order -- see `composite/goal.ts`'s `buildGoalsFromConfigs`. Pass to `new AiContext(host, side, aspects, goals)`. */
  readonly goals: Goal[];
  /**
   * Every `[ai]`-level config in application order (the real
   * `default_config.cfg` aspect list, the chosen `ai_algorithm=` base if
   * any, then each of `sideAiBlocks` already simplified-expanded) --
   * `AiComposite` construction (S1) reads `[stage]` children off these
   * (concatenated across all of them, in order) to build the side's
   * stages.
   */
  readonly configs: readonly WmlConfig[];
}

/**
 * Mirrors `configuration::parse_side_config` (`configuration.cpp:196-267`):
 * prepends the real `default_config.cfg` aspect list, resolves
 * `ai_algorithm=` (the FIRST one found across `sideAiBlocks`; a
 * contradictory second one is ignored, matching upstream's
 * warn-and-ignore behaviour, not ported as a warning here) or falls back
 * to `ai_default_rca` when no algorithm AND no `[stage]` was given
 * anywhere, expands each block's simplified syntax, then merges every
 * block's aspects by id.
 */
export function parseSideAiConfig(
  defaultConfigJson: WmlConfigJson,
  algorithmConfigsJson: Readonly<Record<string, WmlConfigJson>>,
  sideAiBlocks: readonly WmlConfig[],
  defaultAlgorithm = 'ai_default_rca',
): ParsedSideAiConfig {
  const defaultConfig = WmlConfig.fromJSON(defaultConfigJson);
  const expandedBlocks = sideAiBlocks.map(expandSimplifiedAspects);

  let algorithm: string | undefined;
  for (const block of sideAiBlocks) {
    if (block.hasAttribute('ai_algorithm')) {
      algorithm = block.getString('ai_algorithm');
      break;
    }
  }
  const hasExplicitStage = expandedBlocks.some((b) => b.hasChild('stage'));
  if (!algorithm && !hasExplicitStage) algorithm = defaultAlgorithm;

  const configs: WmlConfig[] = [defaultConfig];
  if (algorithm) {
    const algoJson = algorithmConfigsJson[algorithm];
    if (algoJson) configs.push(WmlConfig.fromJSON(algoJson));
  }
  configs.push(...expandedBlocks);

  return { aspects: buildAspects(configs), goals: buildGoalsFromConfigs(configs), configs };
}
