/**
 * Era and faction pages (Phase 24): ports of upstream's `generate_era_sections`, `generate_era_topics` and
 * `generate_faction_topics` (`help_impl.cpp`), over the multiplayer eras the game config carries.
 */
import { WmlConfig } from '@wesnothweb2/engine';
import { BULLET, byteSet, ERA_PREFIX, FACTION_PREFIX, RACE_PREFIX, titleLess, type Section, type Topic } from '../helpCommon.js';
import { tw } from '../../i18n/locale.js';
import type { HelpWorld } from '../helpWorld.js';
import { makeLink, tag } from '../markup.js';
import { alignmentDescription, makeUnitLinksList } from './units.js';

/** `generate_era_sections`. `parseSection` is `parse_config_internal` for a generated `[section]`. */
export function generateEraSections(world: HelpWorld, sec: Section, parseSection: (cfg: WmlConfig) => Section): void {
  for (const era of world.eras) {
    if (era.getBoolean('hide_help', false)) continue;
    const cfg = new WmlConfig();
    cfg.setAttribute('id', ERA_PREFIX + era.getString('id'));
    cfg.setAttribute('title', era.getString('name'));
    cfg.setAttribute('generator', 'era:' + era.getString('id'));
    sec.sections.push(parseSection(cfg));
  }
}

/** `generate_era_topics`: the era's factions, then the era's own page. */
export function generateEraTopics(world: HelpWorld, eraId: string, sortGenerated: boolean): Topic[] {
  const era = world.eras.find((e) => e.getString('id') === eraId);
  if (!era || era.getBoolean('hide_help', false)) return [];
  const topics = generateFactionTopics(world, era, sortGenerated);
  const factionLinks = topics.map((t) => makeLink(t.title, t.id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let text = '';
  const description = era.getString('description');
  if (description) text += description + '\n\n';
  text += tag('header', tw('Factions')) + '\n';
  for (const link of factionLinks) text += `${BULLET} ${link}\n`;
  topics.push({ title: era.getString('name'), id: '..' + ERA_PREFIX + era.getString('id'), text });
  return topics;
}

function generateFactionTopics(world: HelpWorld, era: WmlConfig, sortGenerated: boolean): Topic[] {
  const topics: Topic[] = [];
  for (const f of era.children('multiplayer_side')) {
    const id = f.getString('id');
    if (id === 'Random') continue;
    let text = '';
    const description = f.getString('description');
    if (description) text += description + '\n\n';
    const recruits = f.getString('recruit').split(',').map((s) => s.trim()).filter(Boolean);
    const races: string[] = [];
    const alignments: string[] = [];
    for (const uid of recruits) {
      const type = world.unitType(uid);
      if (!type) continue;
      const race = world.race(type.raceId);
      if (race) races.push(makeLink(race.getString('plural_name'), '..' + RACE_PREFIX + type.raceId));
      alignments.push(makeLink(alignmentDescription(type), 'time_of_day'));
    }
    const raceSet = byteSet(races);
    if (raceSet.length > 0) text += tw('Races: ') + raceSet.join(', ') + '\n\n';
    const alignmentSet = byteSet(alignments);
    if (alignmentSet.length > 0) text += tw('Alignments: ') + alignmentSet.join(', ') + '\n\n';
    text += tag('header', tw('Leaders')) + '\n';
    for (const link of makeUnitLinksList(world, f.getString('leader').split(',').map((s) => s.trim()).filter(Boolean), true)) text += `${BULLET} ${link}\n`;
    text += '\n';
    text += tag('header', tw('Recruits')) + '\n';
    for (const link of makeUnitLinksList(world, recruits, true)) text += `${BULLET} ${link}\n`;
    topics.push({ title: f.getString('name'), id: FACTION_PREFIX + era.getString('id') + '_' + id, text });
  }
  if (sortGenerated) topics.sort(titleLess);
  return topics;
}
