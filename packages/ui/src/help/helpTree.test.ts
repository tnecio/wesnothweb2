import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { topicText, type Section, type Topic } from './helpCommon.js';
import type { HelpData } from './helpData.js';
import { findSection, findTopic, generateContents } from './helpTree.js';
import { HelpWorld } from './helpWorld.js';
import { parseMarkup, type MarkupNode } from './markup.js';

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../apps/web/public/help/core.json'), 'utf8')) as HelpData;

function allTopics(sec: Section, out: Topic[] = []): Topic[] {
  out.push(...sec.topics);
  for (const s of sec.sections) allTopics(s, out);
  return out;
}

function refs(node: MarkupNode, out: string[] = []): string[] {
  if (node.tag === 'ref' && node.attrs.dst) out.push(node.attrs.dst);
  for (const c of node.children) refs(c, out);
  return out;
}

/** The page's text with the markup's tags dropped, as a reader sees it. */
function plain(node: MarkupNode): string {
  if (node.tag === 'text' || (node.children.length === 0 && node.attrs.text !== undefined)) return node.attrs.text ?? '';
  return (node.attrs.text ?? '') + node.children.map((c) => plain(c) + (c.tag === 'col' ? ' | ' : '')).join('');
}

describe('the help tree built from the real data', () => {
  const world = new HelpWorld(data);
  const { toplevel, hidden } = generateContents(world);

  it("lists the toplevel sections in help.cfg's order, then the License topic", () => {
    expect(toplevel.sections.map((s) => s.id)).toEqual([
      'introduction',
      'gameplay',
      'units',
      'abilities_section',
      'traits_section',
      'weapon_specials',
      'eras_section',
      'terrains_section',
      'schedule',
      'addons',
      'editor',
      'commands',
      'encyclopedia',
    ]);
    expect(toplevel.topics.map((t) => t.id)).toEqual(['license']);
  });

  it('puts a section per race under Units (every unit shown), sorted by title', () => {
    const units = findSection(toplevel, 'units')!;
    const ids = units.sections.map((s) => s.id);
    expect(ids).toContain('race_merman');
    expect(ids).toContain('race_elf');
    const titles = units.sections.map((s) => s.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    const merfolk = findSection(toplevel, 'race_merman')!;
    expect(merfolk.topics.map((t) => t.title)).toContain('Merman Fighter');
    // `..units` lists the race subsections (and only them: its section's topics are not built yet then).
    expect(topicText(findTopic(toplevel, '..units')!)).toContain("<ref dst='..race_merman'>Merfolk</ref>");
  });

  it('keeps the unreferenced [topic]s reachable as hidden ones', () => {
    expect(findTopic(hidden, '.unknown_unit') ?? findTopic(toplevel, '.unknown_unit')).toBeDefined();
  });

  it('every page parses, and every link on it leads to a page', () => {
    const topics = [...allTopics(toplevel), ...allTopics(hidden)];
    expect(topics.length).toBeGreaterThan(700);
    const ids = new Set(topics.map((t) => t.id));
    const dead = new Set<string>();
    for (const topic of topics) {
      const parsed = parseMarkup(topicText(topic));
      for (const dst of refs(parsed)) if (!ids.has(dst)) dead.add(`${topic.id} -> ${dst}`);
    }
    // Upstream's own data: Lava's `help_topic_text` links `terrain_unwalkable`, whose page is `..terrain_unwalkable`
    // (the Unwalkable section's own page), so the real game cannot follow it either.
    expect([...dead]).toEqual(['terrain_lava -> terrain_unwalkable']);
  });

  it('shows the Merman Fighter page as upstream builds it', () => {
    const page = topicText(findTopic(toplevel, 'unit_Merman Fighter')!);
    const text = plain(parseMarkup(page));
    expect(text).toContain('Level 1');
    expect(text).toContain('Advances to:\u00a0Merman Warrior');
    expect(text).toContain('Race:\u00a0Merfolk');
    expect(text).toMatch(/HP:\u00a036 {2}Moves:\u00a06 {2}Cost:\u00a014 {2}Alignment:\u00a0lawful {2}Required\u00a0XP:\u00a0\d+/);
    expect(text).toContain('trident');
    expect(text).toContain('6\u00d73');
    expect(page).toContain("<ref dst='traits_strong'>strong</ref>");
    expect(page).toContain("<img src='portraits/merfolk/fighter.webp~FL(horiz)' float='true' align='right' />");
    // Resistances: cold 20%, the rest 0%.
    expect(text).toMatch(/cold \| [^|]*20%/);
    // The terrain table has the swimmer's shallow water.
    expect(page).toContain("<ref dst='..terrain_shallow_water'>");
  });

  it('shows a variation page with its base unit', () => {
    const wc = findSection(toplevel, 'unit_Walking Corpse');
    expect(wc).toBeDefined();
    const bat = wc!.topics.find((t) => t.id === 'variation_Walking Corpse_bat')!;
    expect(bat).toBeDefined();
    expect(plain(parseMarkup(topicText(bat)))).toContain('Base unit:\u00a0Walking Corpse');
  });

  it('lists abilities, specials and traits with the units that have them', () => {
    const leadership = topicText(findTopic(toplevel, 'ability_leadership')!);
    expect(leadership).toContain('Units with this ability');
    expect(leadership).toContain("<ref dst='unit_Lieutenant'>Lieutenant</ref>");
    const marksman = topicText(findTopic(toplevel, 'weaponspecial_marksman')!);
    expect(marksman).toContain("<ref dst='unit_Elvish Marksman'>Elvish Marksman</ref>");
    const strong = topicText(findTopic(toplevel, 'traits_strong')!);
    expect(strong).toContain('This is a global trait.');
  });

  it('has terrain pages and the time-of-day notice outside a game', () => {
    expect(findTopic(toplevel, '..terrain_flat')).toBeDefined();
    expect(topicText(findTopic(toplevel, '..schedule')!)).toContain('Only available during a scenario.');
  });
});
