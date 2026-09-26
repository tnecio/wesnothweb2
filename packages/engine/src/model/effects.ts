/**
 * `[effect]` application (Phase 18c): a port of `unit::apply_builtin_effect`
 * and the per-effect loop of `unit::add_modification` (`units/unit.cpp`).
 *
 * A unit's modifications -- traits, `[object]`s, advancements -- are lists
 * of `[effect]`s. `Unit.resetFromType` + `Unit.applyModifications` rebuild
 * the unit from its type and re-apply them all (upstream's `advance_to` ->
 * `apply_modifications`, with `no_add` semantics: `apply_to=type`/
 * `variation` are skipped so a re-application does not recurse);
 * `Unit.addModification` applies a new one on top of the current state.
 *
 * `EffectEnv` carries what upstream reaches through globals: the board (for
 * an `[effect][filter]` that looks at locations), the type registry (for
 * `apply_to=type`/`variation`), and the side's recall cost.
 */

import type { WmlConfig } from '../wml/config.js';
import type { GameBoard } from './GameBoard.js';
import type { Unit } from './Unit.js';
import { AttackType, applyModifier, type RegistryEntry, type UnitType } from './UnitType.js';

export interface EffectEnv {
  /** For `[effect][filter]`s that look at the unit's surroundings; unit-only filters work without it. */
  readonly board?: GameBoard;
  /** Resolves `apply_to=type`'s `name=`. Without it, that effect is skipped (and logged). */
  readonly resolveType?: (id: string) => UnitType;
  /** The unit's side's `recall_cost` (`apply_to=recall_cost` with a percentage); upstream's default is 20. */
  readonly teamRecallCost?: number;
  readonly log?: (message: string) => void;
}

/**
 * The unit filter an `[effect][filter]` is matched with. The model layer
 * cannot import the event layer's `unitMatchesFilter`, so that module
 * registers it here (`setEffectUnitFilter`); until it has, every filter
 * matches.
 */
let effectUnitFilter: (unit: Unit, filter: WmlConfig, board?: GameBoard) => boolean = () => true;

export function setEffectUnitFilter(matcher: (unit: Unit, filter: WmlConfig, board?: GameBoard) => boolean): void {
  effectUnitFilter = matcher;
}

/** The `apply_to=` values `apply_builtin_effect` implements. */
export const BUILTIN_EFFECTS: ReadonlySet<string> = new Set([
  'fearless',
  'healthy',
  'profile',
  'new_attack',
  'remove_attacks',
  'attack',
  'hitpoints',
  'movement',
  'vision',
  'jamming',
  'experience',
  'max_experience',
  'loyal',
  'status',
  'movement_costs',
  'vision_costs',
  'jamming_costs',
  'defense',
  'resistance',
  'zoc',
  'new_ability',
  'remove_ability',
  'image_mod',
  'new_animation',
  'ellipse',
  'halo',
  'overlay',
  'new_advancement',
  'remove_advancement',
  'alignment',
  'max_attacks',
  'recall_cost',
  'variation',
  'type',
  'level',
]);

const MOVETYPE_EFFECTS = new Set(['movement_costs', 'vision_costs', 'jamming_costs', 'defense', 'resistance']);

/** A comma list, trimmed, without empties (`utils::split`). */
function split(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** `utils::parenthetical_split(value, ',')`: commas inside parentheses do not split. */
function parentheticalSplit(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** An attribute that is present and not empty (upstream's `!attr.empty()`). */
function has(effect: WmlConfig, key: string): boolean {
  return effect.hasAttribute(key) && effect.getString(key) !== '';
}

/** `set=` in percent-or-absolute form, relative to `base`. */
function setValue(text: string, base: number): number {
  const n = Number.parseInt(text, 10) || 0;
  return text.trim().endsWith('%') ? Math.trunc((n * base) / 100) : n;
}

/**
 * `unit_type_data::add_registry_entries(effect, "abilities", registry)`: the
 * effect's own `[abilities]` children, then each `abilities_list=` id
 * resolved against the registry.
 */
function abilitiesOf(effect: WmlConfig, registry: ReadonlyMap<string, RegistryEntry>): RegistryEntry[] {
  const inline = effect.children('abilities').flatMap((a) => a.allChildren().map((c) => ({ tag: c.tag, config: c.config })));
  const listed = split(effect.getString('abilities_list', ''))
    .map((id) => registry.get(id))
    .filter((e): e is RegistryEntry => e !== undefined);
  return [...inline, ...listed];
}

/**
 * Applies every `[effect]` of one modification to `unit`, as
 * `add_modification`'s loop does: the effect's `[filter]` (skip if the unit
 * does not match), `times=` (a number, or `per level`), and -- with `noAdd`
 * (re-application) -- no `apply_to=type`/`variation`.
 */
export function applyModificationEffects(unit: Unit, mod: WmlConfig, noAdd: boolean, env: EffectEnv): void {
  for (const effect of mod.children('effect')) {
    const filter = effect.child('filter');
    if (filter && !effectUnitFilter(unit, filter, env.board)) continue;
    const applyTo = effect.getString('apply_to', '');
    if (noAdd && (applyTo === 'type' || applyTo === 'variation')) continue;
    let times = effect.getNumber('times', 1);
    if (effect.getString('times', '') === 'per level') {
      times = applyTo === 'level' ? 1 : unit.level;
    }
    if (!BUILTIN_EFFECTS.has(applyTo)) {
      env.log?.(`[effect] apply_to=${applyTo} is not supported (skipped)`);
      continue;
    }
    for (let i = 0; i < times; i++) applyBuiltinEffect(unit, applyTo, effect, env);
  }
}

/** `unit::apply_builtin_effect`, one `apply_to=` case at a time. */
export function applyBuiltinEffect(unit: Unit, applyTo: string, effect: WmlConfig, env: EffectEnv): void {
  switch (applyTo) {
    case 'fearless':
      unit.fearless = effect.getBoolean('set', true);
      return;
    case 'healthy':
      unit.healthy = effect.getBoolean('set', true);
      return;
    case 'profile':
      if (effect.hasAttribute('portrait')) unit.profile = effect.getString('portrait');
      return;
    case 'new_attack':
      unit.attacks = [...unit.attacks, AttackType.fromConfig(effect, unit.type.registries.weaponSpecials)];
      return;
    case 'remove_attacks':
      unit.attacks = unit.attacks.filter((a) => !a.matchesFilter(effect));
      return;
    case 'attack':
      unit.attacks = unit.attacks.map((a) => (a.matchesFilter(effect) ? a.withEffect(effect, unit.type.registries.weaponSpecials) : a));
      return;
    case 'hitpoints': {
      if (has(effect, 'set')) unit.hitpoints = setValue(effect.getString('set'), unit.maxHitpoints);
      if (has(effect, 'set_total')) unit.maxHitpoints = setValue(effect.getString('set_total'), unit.maxHitpoints);
      if (has(effect, 'increase_total')) unit.maxHitpoints = applyModifier(unit.maxHitpoints, effect.getString('increase_total'));
      if (unit.maxHitpoints < 1) unit.maxHitpoints = 1;
      if (effect.getBoolean('heal_full', false)) unit.hitpoints = unit.maxHitpoints;
      if (has(effect, 'increase')) unit.hitpoints = applyModifier(unit.hitpoints, effect.getString('increase'));
      if (unit.hitpoints > unit.maxHitpoints && !effect.getBoolean('violate_maximum', false)) unit.hitpoints = unit.maxHitpoints;
      if (unit.hitpoints < 1) unit.hitpoints = 1;
      return;
    }
    case 'movement': {
      const applyToVision = effect.getBoolean('apply_to_vision', true);
      // Unlink vision from movement, whether or not both change.
      if (unit.vision < 0) unit.vision = unit.maxMoves;
      const oldMax = unit.maxMoves;
      if (has(effect, 'increase')) unit.maxMoves = applyModifier(unit.maxMoves, effect.getString('increase'), 1);
      if (has(effect, 'set')) unit.maxMoves = effect.getNumber('set');
      if (unit.movesLeft > unit.maxMoves) unit.movesLeft = unit.maxMoves;
      if (applyToVision) unit.vision = Math.max(0, unit.vision + unit.maxMoves - oldMax);
      return;
    }
    case 'vision':
      if (unit.vision < 0) unit.vision = unit.maxMoves;
      if (has(effect, 'increase')) unit.vision = applyModifier(unit.vision, effect.getString('increase'), 1);
      if (has(effect, 'set')) unit.vision = effect.getNumber('set');
      return;
    case 'jamming':
      if (has(effect, 'increase')) unit.jamming = applyModifier(unit.jamming, effect.getString('increase'), 1);
      if (has(effect, 'set')) unit.jamming = effect.getNumber('set');
      return;
    case 'experience':
      if (has(effect, 'set')) unit.experience = setValue(effect.getString('set'), unit.maxExperience);
      if (has(effect, 'increase')) unit.experience = applyModifier(unit.experience, effect.getString('increase'), 0);
      return;
    case 'max_experience':
      if (has(effect, 'set')) unit.maxExperience = Math.max(1, setValue(effect.getString('set'), unit.maxExperience));
      if (has(effect, 'increase')) unit.maxExperience = Math.max(1, applyModifier(unit.maxExperience, effect.getString('increase'), 1));
      return;
    case 'loyal':
      unit.upkeep = 'loyal';
      return;
    case 'status':
      for (const status of split(effect.getString('add', ''))) unit.setStatus(status, true);
      for (const status of split(effect.getString('remove', ''))) unit.setStatus(status, false);
      return;
    case 'zoc':
      if (effect.hasAttribute('value')) unit.emitZoc = effect.getBoolean('value');
      return;
    case 'new_ability': {
      for (const entry of abilitiesOf(effect, unit.type.registries.abilities)) {
        const id = entry.config.getString('id', '');
        if (!unit.abilities.some((a) => a.config.getString('id', '') === id)) unit.abilities = [...unit.abilities, entry];
      }
      return;
    }
    case 'remove_ability': {
      const ids = new Set(effect.children('abilities').flatMap((a) => a.allChildren().map((c) => c.config.getString('id', ''))));
      for (const fab of effect.children('filter_ability')) {
        for (const id of split(fab.getString('id', ''))) ids.add(id);
        const tags = new Set(split(fab.getString('tag_name', '')));
        if (tags.size > 0) unit.abilities = unit.abilities.filter((a) => !tags.has(a.tag));
      }
      unit.abilities = unit.abilities.filter((a) => !ids.has(a.config.getString('id', '')));
      return;
    }
    case 'image_mod': {
      if (has(effect, 'replace')) unit.imageMods = effect.getString('replace');
      if (has(effect, 'add')) unit.imageMods = unit.imageMods === '' ? effect.getString('add') : `${unit.imageMods}~${effect.getString('add')}`;
      return;
    }
    case 'new_animation':
      // Animations are the renderer's; the unit's own [*_anim] overrides are not modelled yet.
      return;
    case 'ellipse':
      unit.ellipse = effect.getString('ellipse', '');
      return;
    case 'halo':
      unit.halo = effect.getString('halo', '');
      return;
    case 'overlay': {
      const add = effect.getString('add', '');
      const remove = effect.getString('remove', '');
      const replace = effect.getString('replace', '');
      if (add !== '') unit.overlays = [...unit.overlays, ...parentheticalSplit(add)];
      if (remove !== '') {
        const gone = new Set(parentheticalSplit(remove));
        unit.overlays = unit.overlays.filter((o) => !gone.has(o));
      }
      if (add === '' && remove === '' && replace !== '') unit.overlays = parentheticalSplit(replace);
      return;
    }
    case 'new_advancement': {
      const replace = effect.getBoolean('replace', false);
      const types = effect.getString('types', '');
      if (types !== '') unit.advancesTo = replace ? parentheticalSplit(types) : [...unit.advancesTo, ...parentheticalSplit(types)];
      if (effect.hasChild('advancement')) {
        unit.advancements = replace ? [...effect.children('advancement')] : [...unit.advancements, ...effect.children('advancement')];
      }
      return;
    }
    case 'remove_advancement': {
      const types = parentheticalSplit(effect.getString('types', ''));
      for (const t of types) {
        const i = unit.advancesTo.indexOf(t);
        if (i >= 0) unit.advancesTo = [...unit.advancesTo.slice(0, i), ...unit.advancesTo.slice(i + 1)];
      }
      const amlas = new Set(parentheticalSplit(effect.getString('amlas', '')));
      unit.advancements = unit.advancements.filter((a) => !amlas.has(a.getString('id', '')));
      return;
    }
    case 'alignment': {
      const value = effect.getString('set', '');
      if (value === 'lawful' || value === 'neutral' || value === 'chaotic' || value === 'liminal') unit.alignment = value;
      return;
    }
    case 'max_attacks':
      if (has(effect, 'increase')) unit.maxAttacksPerTurn = applyModifier(unit.maxAttacksPerTurn, effect.getString('increase'), 1);
      return;
    case 'recall_cost': {
      const current = unit.recallCost < 0 ? (env.teamRecallCost ?? 20) : unit.recallCost;
      if (has(effect, 'set')) unit.recallCost = setValue(effect.getString('set'), current);
      if (has(effect, 'increase')) unit.recallCost = applyModifier(current, effect.getString('increase'), 1);
      return;
    }
    case 'variation': {
      const id = effect.getString('name', '');
      const base = unit.baseType;
      if (id === '' || base.hasVariation(id)) {
        unit.variation = id;
        unit.advanceTo(base, env);
        if (effect.getBoolean('heal_full', false)) unit.healToFull();
      } else {
        env.log?.(`unknown variation '${id}' (name=) in [effect] apply_to=variation, ignoring`);
      }
      return;
    }
    case 'type': {
      const name = effect.getString('name', '');
      let newType: UnitType | undefined;
      try {
        newType = env.resolveType?.(name);
      } catch {
        newType = undefined;
      }
      if (!newType) {
        env.log?.(`unknown type '${name}' (name=) in [effect] apply_to=type, ignoring`);
        return;
      }
      unit.advanceTo(newType, env);
      if (effect.getBoolean('heal_full', false)) unit.healToFull();
      return;
    }
    case 'level':
      if (has(effect, 'set')) unit.level = Number.parseInt(effect.getString('set'), 10) || 0;
      if (has(effect, 'increase')) unit.level += Number.parseInt(effect.getString('increase'), 10) || 0;
      return;
    default:
      if (MOVETYPE_EFFECTS.has(applyTo)) {
        const child = effect.child(applyTo);
        if (child) unit.moveType = unit.moveType.merge(applyTo, child, effect.getBoolean('replace', false));
      }
  }
}
