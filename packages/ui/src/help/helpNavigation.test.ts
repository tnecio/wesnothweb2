import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HelpData } from './helpData.js';
import { ancestorsOf, buildHelpTree, HelpHistory, makeMatcher, nodeIdOfTopic, topicIdOfNode, visibleNodes, type HelpTreeNode } from './helpNavigation.js';
import { generateContents } from './helpTree.js';
import { HelpWorld } from './helpWorld.js';

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../apps/web/public/help/core.json'), 'utf8')) as HelpData;
const { toplevel } = generateContents(new HelpWorld(data));

function titles(nodes: HelpTreeNode[]): string[] {
  return nodes.flatMap((n) => [n.title, ...titles(n.children)]);
}

describe('the help tree (help_browser::add_topics_for_section)', () => {
  it("names nodes as upstream: '+' a section, '-' a topic, and hides '.' topics and sections' own pages", () => {
    const { nodes } = buildHelpTree(toplevel);
    expect(nodes[0]).toMatchObject({ id: '+introduction', section: true });
    expect(nodes.at(-1)).toMatchObject({ id: '-license', section: false });
    const intro = nodes[0]!;
    expect(intro.children.map((c) => c.id)).toEqual(['-about_game']);
  });

  it('keeps only matching topics and the sections holding them, unfolded, with every word matched', () => {
    const { nodes, unfold } = buildHelpTree(toplevel, 'merman fight');
    expect(titles(nodes)).toEqual(['Units', 'Merfolk', 'Merman Fighter']);
    expect([...unfold].sort()).toEqual(['+race_merman', '+units']);
  });

  it('shows everything when nothing matches', () => {
    expect(buildHelpTree(toplevel, 'no such thing at all').nodes.length).toBe(buildHelpTree(toplevel).nodes.length);
  });

  it('matches case-insensitively, word by word', () => {
    expect(makeMatcher('ELVISH arch')('Elvish Archer')).toBe(true);
    expect(makeMatcher('elvish dwarf')('Elvish Archer')).toBe(false);
  });

  it('finds a node, its ancestors, and the nodes a keyboard walks', () => {
    const { nodes } = buildHelpTree(toplevel);
    expect(ancestorsOf(nodes, '-unit_Merman Fighter')).toEqual(['+units', '+race_merman']);
    const walked = visibleNodes(nodes, new Set(['+units']));
    expect(walked.some((n) => n.id === '+race_merman')).toBe(true);
    expect(walked.some((n) => n.id === '-unit_Merman Fighter')).toBe(false);
  });

  it('maps topics to nodes and back', () => {
    expect(nodeIdOfTopic('..units')).toBe('+units');
    expect(nodeIdOfTopic('unit_Elvish Fighter')).toBe('-unit_Elvish Fighter');
    expect(topicIdOfNode('+units')).toBe('..units');
    expect(topicIdOfNode('-license')).toBe('license');
  });
});

describe('HelpHistory', () => {
  it('walks back and forward, and following a link drops the pages ahead', () => {
    const h = new HelpHistory();
    h.push('a');
    h.push('b');
    h.push('b');
    h.push('c');
    expect(h.canForward).toBe(false);
    expect(h.back()).toBe('b');
    expect(h.back()).toBe('a');
    expect(h.canBack).toBe(false);
    expect(h.forward()).toBe('b');
    h.push('d');
    expect(h.canForward).toBe(false);
    expect(h.back()).toBe('b');
  });
});
