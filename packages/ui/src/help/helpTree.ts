/**
 * The help's tree of sections and topics (Phase 24): ports of upstream's `parse_config_internal`,
 * `generate_sections`, `generate_topics`, `generate_topic_text`, `generate_contents_links`,
 * `generate_contents`, `find_topic` and `find_section` (`help_impl.cpp`).
 *
 * `[toplevel]` names the top sections and topics; a `[section]` names its own subsections and topics, and
 * may generate more (`sections_generator=`, `generator=`). An id starting with `.` is hidden from the tree
 * (reachable by links only); `..id` is a section's own page, shown when the section itself is selected.
 */
import { WmlConfig } from '@wesnothweb2/engine';
import {
  BULLET,
  isValidId,
  isVisibleId,
  newSection,
  splitList,
  titleLess,
  type Section,
  type Topic,
} from './helpCommon.js';
import type { HelpWorld } from './helpWorld.js';
import { makeLink } from './markup.js';
import { generateAbilityTopics, generateTraitTopics, generateWeaponSpecialTopics } from './generators/abilities.js';
import { generateEraSections, generateEraTopics } from './generators/eras.js';
import { generateTerrainSections } from './generators/terrains.js';
import { generateTimeOfDayTopics } from './generators/timeOfDay.js';
import { generateRacesSections, generateUnitSections, generateUnitTopics } from './generators/units.js';

const MAX_SECTION_LEVEL = 15;

export class HelpParseError extends Error {}

/** An attribute as upstream's `attribute_value` prints it: a boolean is `yes`/`no`. */
function attrString(cfg: WmlConfig, key: string): string {
  const v = cfg.get(key);
  return typeof v === 'boolean' ? (v ? 'yes' : 'no') : v === undefined ? '' : String(v);
}

function findChild(cfg: WmlConfig, tag: string, id: string): WmlConfig | undefined {
  return cfg.children(tag).find((c) => c.getString('id') === id);
}

class TreeBuilder {
  constructor(
    private readonly world: HelpWorld,
    private readonly helpCfg: WmlConfig,
  ) {}

  parseSection(sectionCfg: WmlConfig, level: number): Section {
    if (level > MAX_SECTION_LEVEL) {
      console.warn('[help] Maximum section depth has been reached. Maybe circular dependency?');
      return newSection();
    }
    const id = level === 0 ? 'toplevel' : sectionCfg.getString('id');
    if (level !== 0 && !isValidId(id)) throw new HelpParseError(`Invalid ID, used for internal purpose: '${id}'`);
    const sec = newSection(id, level === 0 ? '' : sectionCfg.getString('title'));

    for (const secId of splitList(sectionCfg.getString('sections'))) {
      const child = findChild(this.helpCfg, 'section', secId);
      if (!child) throw new HelpParseError(`Help-section '${secId}' referenced from '${id}' but could not be found.`);
      sec.sections.push(this.parseSection(child, level + 1));
    }

    this.generateSections(sectionCfg.getString('sections_generator'), sec, level);
    if (attrString(sectionCfg, 'sort_sections') === 'yes') sec.sections.sort(titleLess);

    let sortTopics = false;
    let sortGenerated = true;
    const sort = attrString(sectionCfg, 'sort_topics');
    if (sort === 'yes') {
      sortTopics = true;
      sortGenerated = false;
    } else if (sort === 'no') {
      sortTopics = false;
      sortGenerated = false;
    } else if (sort === 'generated') {
      sortTopics = false;
      sortGenerated = true;
    } else if (sort !== '') {
      throw new HelpParseError(`Invalid sort option: '${sort}'`);
    }

    const generated = this.generateTopics(sortGenerated, sectionCfg.getString('generator'));
    const topics: Topic[] = [];
    for (const topicId of splitList(sectionCfg.getString('topics'))) {
      const topicCfg = findChild(this.helpCfg, 'topic', topicId);
      if (!topicCfg) throw new HelpParseError(`Help-topic '${topicId}' referenced from '${id}' but could not be found.`);
      const topic: Topic = {
        title: topicCfg.getString('title'),
        id: topicCfg.getString('id'),
        // Now, as upstream: a `contents:generated` list sees the section's subsections but none of its topics yet.
        text: topicCfg.getString('text') + this.generateTopicText(topicCfg.getString('generator'), sec),
      };
      if (!isValidId(topic.id)) throw new HelpParseError(`Invalid ID, used for internal purpose: '${id}'`);
      topics.push(topic);
    }

    if (sortTopics) {
      topics.sort(titleLess);
      generated.sort(titleLess);
      sec.topics.push(...mergeSorted(generated, topics));
    } else {
      sec.topics.push(...topics, ...generated);
    }
    return sec;
  }

  private generateTopics(sortGenerated: boolean, generator: string): Topic[] {
    if (!generator) return [];
    if (generator === 'abilities') return generateAbilityTopics(this.world, sortGenerated);
    if (generator === 'weapon_specials') return generateWeaponSpecialTopics(this.world, sortGenerated);
    if (generator === 'time_of_days') return generateTimeOfDayTopics(this.world);
    if (generator === 'traits') return generateTraitTopics(this.world, sortGenerated);
    const parts = generator.split(':').map((s) => s.trim());
    if (parts.length > 1 && parts[0] === 'units') return generateUnitTopics(this.world, parts[1]!, sortGenerated);
    if (parts.length > 1 && parts[0] === 'era') return generateEraTopics(this.world, parts[1]!, sortGenerated);
    console.warn(`[help] Found a topic generator that I didn't recognize: ${generator}`);
    return [];
  }

  private generateSections(generator: string, sec: Section, level: number): void {
    const parse = (cfg: WmlConfig) => this.parseSection(cfg, level + 1);
    if (generator === 'races') generateRacesSections(this.world, sec, parse);
    else if (generator === 'terrains') generateTerrainSections(this.world, sec);
    else if (generator === 'eras') generateEraSections(this.world, sec, parse);
    else {
      const parts = generator.split(':').map((s) => s.trim());
      if (parts.length > 1 && parts[0] === 'units') generateUnitSections(this.world, sec, parts[1]!);
      else if (generator !== '') console.warn(`[help] Found a section generator that I didn't recognize: ${generator}`);
    }
  }

  private generateTopicText(generator: string, sec: Section): string {
    const parts = generator.split(':');
    if (parts.length > 1 && parts[0] === 'contents') {
      return parts[1] === 'generated' ? contentsLinksOfSection(sec) : this.contentsLinksOfConfig(parts[1]!);
    }
    return '';
  }

  /** `generate_contents_links(section_name, help_cfg)`: a `[section]`'s own topics, as a bullet list. */
  private contentsLinksOfConfig(sectionName: string): string {
    const sectionCfg = findChild(this.helpCfg, 'section', sectionName);
    if (!sectionCfg) return '';
    const links: [string, string][] = [];
    for (const topic of splitList(sectionCfg.getString('topics'))) {
      const topicCfg = findChild(this.helpCfg, 'topic', topic);
      if (!topicCfg) continue;
      const id = topicCfg.getString('id');
      if (isVisibleId(id)) links.push([topicCfg.getString('title'), id]);
    }
    if (attrString(sectionCfg, 'sort_topics') === 'yes') links.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
    return links.map(([text, target]) => `${BULLET} ${makeLink(text, target)}\n`).join('');
  }
}

/** `generate_contents_links(section)`: a section's visible subsections and topics, as a bullet list. */
function contentsLinksOfSection(sec: Section): string {
  let res = '';
  for (const s of sec.sections) if (isVisibleId(s.id)) res += `${BULLET} ${makeLink(s.title, '..' + s.id)}\n`;
  for (const t of sec.topics) if (isVisibleId(t.id)) res += `${BULLET} ${makeLink(t.title, t.id)}\n`;
  return res;
}

/** `std::merge` of two lists sorted by title (stable: `a` first on ties). */
function mergeSorted(a: Topic[], b: Topic[]): Topic[] {
  const out: Topic[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(titleLess(b[j]!, a[i]!) < 0 ? b[j++]! : a[i++]!);
  return out.concat(a.slice(i), b.slice(j));
}

export interface HelpContents {
  /** The tree the browser shows. */
  toplevel: Section;
  /** Everything `[help]` defines that no section references: reachable by links (and `[open_help]`) only. */
  hidden: Section;
}

/** `generate_contents`: the toplevel tree, and the unreferenced sections and topics. */
export function generateContents(world: HelpWorld): HelpContents {
  const helpCfg = world.help;
  const builder = new TreeBuilder(world, helpCfg);
  const toplevelCfg = helpCfg.child('toplevel');
  const toplevel = toplevelCfg ? builder.parseSection(toplevelCfg, 0) : newSection();

  const referenced = (key: 'sections' | 'topics', id: string): boolean =>
    [helpCfg.child('toplevel'), ...helpCfg.children('section')].some((c) => c !== undefined && splitList(c.getString(key)).includes(id));
  const hiddenSections = helpCfg
    .children('section')
    .map((s) => s.getString('id'))
    .filter((id) => !findSection(toplevel, id) && !referenced('sections', id));
  const hiddenTopics = helpCfg
    .children('topic')
    .map((t) => t.getString('id'))
    .filter((id) => !findTopic(toplevel, id) && !referenced('topics', id));
  if (hiddenSections.length === 0 && hiddenTopics.length === 0) return { toplevel, hidden: newSection() };

  const hiddenToplevel = new WmlConfig();
  hiddenToplevel.setAttribute('sections', hiddenSections.join(','));
  hiddenToplevel.setAttribute('topics', hiddenTopics.join(','));
  return { toplevel, hidden: builder.parseSection(hiddenToplevel, 0) };
}

/** `find_topic`: depth-first, a section's own topics before its subsections'. */
export function findTopic(sec: Section, id: string): Topic | undefined {
  const own = sec.topics.find((t) => t.id === id);
  if (own) return own;
  for (const s of sec.sections) {
    const t = findTopic(s, id);
    if (t) return t;
  }
  return undefined;
}

/** `find_section`: breadth-first within each level, as upstream. */
export function findSection(sec: Section, id: string): Section | undefined {
  const own = sec.sections.find((s) => s.id === id);
  if (own) return own;
  for (const s of sec.sections) {
    const found = findSection(s, id);
    if (found) return found;
  }
  return undefined;
}
