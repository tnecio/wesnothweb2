/**
 * Ability, weapon special and trait pages (Phase 24): ports of upstream's `generate_ability_topics`,
 * `generate_weapon_special_topics`, `generate_trait_topics` and `add_remaining_pages` (`help_impl.cpp`).
 */
import type { WmlConfig } from '@wesnothweb2/engine';
import { _, ABILITY_PREFIX, BULLET, RACE_PREFIX, stringSet, titleLess, WEAPONSPECIAL_PREFIX, type Topic } from '../helpCommon.js';
import { helpTopicIdOf, type AbilityMetadata, type HelpWorld } from '../helpWorld.js';
import { italic, makeLink, tag } from '../markup.js';
import { hasFullDescription, makeUnitLink } from './units.js';

const PAGE_LIMIT = 20;

/** A `std::map<std::string, std::set<std::string, string_less>>` being filled. */
class SetMap {
  private readonly map = new Map<string, Set<string>>();
  add(key: string, value: string): boolean {
    let set = this.map.get(key);
    if (!set) this.map.set(key, (set = new Set()));
    if (set.has(value)) return false;
    set.add(value);
    return true;
  }
  get(key: string): string[] {
    return stringSet(this.map.get(key) ?? []);
  }
}

function byId<T>(map: Map<string, T>): [string, T][] {
  return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `generate_weapon_special_topics`. */
export function generateWeaponSpecialTopics(world: HelpWorld, sortGenerated: boolean): Topic[] {
  const descriptions = new Map<string, { name: string; description: string }>();
  const units = new SetMap();
  const note = (id: string, name: string, description: string, typeId: string, hideHelp: boolean): void => {
    if (!descriptions.has(id)) descriptions.set(id, { name, description });
    if (!hideHelp) units.add(id, makeUnitLink(world, typeId));
  };
  for (const typeId of world.typeIds()) {
    const type = world.unitType(typeId)!;
    if (!hasFullDescription(type)) continue;
    for (const attack of type.unitType.attacks) {
      for (const special of attack.specials) {
        const name = special.getString('name');
        if (!name) continue;
        note(helpTopicIdOf(special), name, special.getString('description'), type.id, type.hideHelp);
      }
    }
    for (const adv of type.modificationAdvancements) {
      for (const effect of adv.children('effect')) {
        const applyTo = effect.getString('apply_to');
        const holder = applyTo === 'new_attack' ? effect.child('specials') : applyTo === 'attack' ? effect.child('set_specials') : undefined;
        if (!holder) continue;
        for (const { config: special } of holder.allChildren()) {
          const name = special.getString('name');
          if (!name) continue;
          note(helpTopicIdOf(special), name, special.getString('description'), type.id, type.hideHelp);
        }
      }
    }
  }
  const topics: Topic[] = [];
  for (const [id, { name, description }] of byId(descriptions)) {
    let text = description;
    text += '\n\n' + tag('header', _('Units with this special attack')) + '\n';
    for (const link of units.get(id)) text += `${BULLET} ${link}\n`;
    topics.push({ title: name, id: WEAPONSPECIAL_PREFIX + id, text });
  }
  if (sortGenerated) topics.sort(titleLess);
  return topics;
}

/** `generate_ability_topics`. */
export function generateAbilityTopics(world: HelpWorld, sortGenerated: boolean): Topic[] {
  const data = new Map<string, AbilityMetadata>();
  const units = new SetMap();
  const parse = (typeId: string, hideHelp: boolean, ability: AbilityMetadata): void => {
    if (!data.has(ability.helpTopicId)) data.set(ability.helpTopicId, ability);
    if (!hideHelp) units.add(ability.helpTopicId, makeUnitLink(world, typeId));
  };
  for (const typeId of world.typeIds()) {
    const type = world.unitType(typeId)!;
    if (!hasFullDescription(type)) continue;
    for (const ability of type.abilitiesMetadata) parse(type.id, type.hideHelp, ability);
    for (const ability of type.advAbilitiesMetadata) parse(type.id, type.hideHelp, ability);
  }
  const topics: Topic[] = [];
  for (const [id, ability] of byId(data)) {
    if (!ability.name) continue;
    let text = ability.description;
    text += '\n\n' + tag('header', _('Units with this ability')) + '\n';
    for (const link of units.get(id)) text += `${BULLET} ${link}\n`;
    topics.push({ title: ability.name, id: ABILITY_PREFIX + id, text });
  }
  if (sortGenerated) topics.sort(titleLess);
  return topics;
}

/** `add_remaining_pages`: the hidden continuation pages of a long list (page 1 is the caller's). */
function addRemainingPages(topics: Topic[], topicName: string, topicId: string, suffix: string, list: readonly string[]): void {
  const pageCount = Math.ceil(list.length / PAGE_LIMIT);
  let it = PAGE_LIMIT;
  for (let page = 2; page <= pageCount; page++) {
    const prevId = page > 2 ? `.${topicId}${suffix}_${page - 1}` : topicId;
    let text = makeLink('&lt;&lt; ' + _('Previous'), prevId) + '\n\n';
    for (let row = 0; row < PAGE_LIMIT && it < list.length; row++, it++) text += `${BULLET} ${list[it]}\n`;
    if (page !== pageCount) text += '\n' + makeLink(_('Next') + ' &gt;&gt;', `.${topicId}${suffix}_${page + 1}`) + '\n';
    topics.push({ title: `${topicName} (${page}/${pageCount})`, id: `.${topicId}${suffix}_${page}`, text });
  }
}

/** `generate_trait_topics`. */
export function generateTraitTopics(world: HelpWorld, sortGenerated: boolean): Topic[] {
  const traitList = new Map<string, WmlConfig>();
  const globalTraits = new Set<string>();
  const traitUnits = new Map<string, Set<string>>();
  const traitRaces = new Map<string, Set<string>>();
  const addTo = (map: Map<string, Set<string>>, key: string, value: string) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(value);
  };

  for (const trait of world.globalTraits) {
    const id = trait.getString('id');
    if (!traitList.has(id)) traitList.set(id, trait);
    globalTraits.add(id);
  }
  const races = new Set<string>();
  for (const typeId of world.typeIds()) {
    const type = world.unitType(typeId)!;
    if (hasFullDescription(type)) races.add(type.raceId);
  }
  for (const raceId of byteSorted(races)) {
    const race = world.race(raceId);
    if (!race) continue;
    for (const trait of race.children('trait')) {
      const id = trait.getString('id');
      if (globalTraits.has(id)) continue;
      if (!traitList.has(id)) traitList.set(id, trait);
      addTo(traitRaces, id, raceId);
    }
  }
  for (const typeId of world.typeIds()) {
    const type = world.unitType(typeId)!;
    const full = hasFullDescription(type);
    // `HIDDEN_BUT_SHOW_MACROS` (the Fog Clearer) adds its traits to the list but not itself to their pages.
    for (const trait of type.possibleTraits) {
      const id = trait.getString('id');
      if (!traitList.has(id)) traitList.set(id, trait);
      const racial = traitRaces.get(id)?.has(type.raceId) ?? false;
      if (full && !globalTraits.has(id) && !racial) addTo(traitUnits, id, type.id);
    }
  }

  const topics: Topic[] = [];
  for (const [traitId, trait] of byId(traitList)) {
    const id = 'traits_' + traitId;
    const name = trait.getString('male_name') || trait.getString('female_name') || trait.getString('name');
    if (!name) continue; // A hidden trait.
    let text = trait.getString('help_text') || trait.getString('description') || _('No description available.');
    if (globalTraits.has(traitId)) {
      text += '\n\n' + italic(_('This is a global trait.'));
      topics.push({ title: name, id, text });
      continue;
    }
    text += '\n';
    const racesWith = stringSet(traitRaces.get(traitId) ?? []);
    if (racesWith.length > 0) text += '\n' + tag('header', _('Races with this trait')) + '\n';
    for (let i = 0; i < racesWith.length; i++) {
      if (i < PAGE_LIMIT) {
        const raceId = racesWith[i]!;
        text += `${BULLET} ${makeLink(world.racePluralName(raceId), '..' + RACE_PREFIX + raceId)}\n`;
      } else {
        text += makeLink(_('Next') + ' &gt;&gt;', `.${id}_races_2`) + '\n';
        addRemainingPages(topics, name, id, '_races', racesWith);
        break;
      }
    }
    const unitsWith = stringSet(traitUnits.get(traitId) ?? []);
    if (unitsWith.length > 0) text += '\n' + tag('header', _('Units with this trait')) + '\n';
    for (let i = 0; i < unitsWith.length; i++) {
      if (i < PAGE_LIMIT) text += `${BULLET} ${makeUnitLink(world, unitsWith[i]!)}\n`;
      else {
        text += makeLink(_('Next') + ' &gt;&gt;', `.${id}_units_2`) + '\n';
        addRemainingPages(topics, name, id, '_units', unitsWith);
        break;
      }
    }
    text += '\n\n';
    topics.push({ title: name, id, text });
  }
  if (sortGenerated) topics.sort(titleLess);
  return topics;
}

function byteSorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
