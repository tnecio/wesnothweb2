/**
 * The help browser's navigation (Phase 24), from upstream's `gui2::dialogs::help_browser`: the topic tree
 * (with the search filter), the ids of its nodes, and the back/next history.
 *
 * Tree nodes are named as upstream names them: a section's node is `+<section id>` and shows the section's
 * own page, `..<section id>`; a topic's node is `-<topic id>`.
 */
import { isVisibleId, type Section } from './helpCommon.js';

export interface HelpTreeNode {
  /** `+<section id>` or `-<topic id>`. */
  id: string;
  title: string;
  section: boolean;
  children: HelpTreeNode[];
}

/** `translation::make_ci_matcher`: every word of the filter appears in the text, ignoring case. */
export function makeMatcher(filter: string): (text: string) => boolean {
  const words = filter
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => w.toLocaleLowerCase());
  return (text) => {
    const t = text.toLocaleLowerCase();
    return words.every((w) => t.includes(w));
  };
}

/**
 * `add_topics_for_section`: the tree under `section`, keeping (with a filter) the topics whose id or title
 * matches and the sections that match or hold a match. Returns whether anything was added.
 */
function addTopicsForSection(section: Section, into: HelpTreeNode[], filter: string, unfold: Set<string>): boolean {
  let added = false;
  const match = makeMatcher(filter);
  for (const sub of section.sections) {
    const node: HelpTreeNode = { id: '+' + sub.id, title: sub.title, section: true, children: [] };
    const subAdded = addTopicsForSection(sub, node.children, filter, unfold);
    if (subAdded || match(sub.id) || match(sub.title)) {
      if (filter !== '') unfold.add(node.id);
      into.push(node);
      added = true;
    }
  }
  for (const topic of section.topics) {
    if (topic.id[0] === '.') continue;
    if ((match(topic.id) || match(topic.title)) && !topic.id.startsWith('..')) {
      into.push({ id: '-' + topic.id, title: topic.title, section: false, children: [] });
      added = true;
    }
  }
  return added;
}

/** `update_list`: the tree for `filter`, or the whole tree when nothing matches it; and the sections a match unfolds. */
export function buildHelpTree(toplevel: Section, filter = ''): { nodes: HelpTreeNode[]; unfold: Set<string> } {
  const nodes: HelpTreeNode[] = [];
  const unfold = new Set<string>();
  if (!addTopicsForSection(toplevel, nodes, filter, unfold)) {
    nodes.length = 0;
    unfold.clear();
    addTopicsForSection(toplevel, nodes, '', unfold);
  }
  return { nodes, unfold };
}

/** The tree node that shows `topicId`: `..x` is section x's node `+x`, anything else `-<id>`. */
export function nodeIdOfTopic(topicId: string): string {
  return topicId.startsWith('..') ? '+' + topicId.slice(2) : '-' + topicId;
}

/** The topic a node (or a `+`/`-` id) shows. */
export function topicIdOfNode(id: string): string {
  if (id.startsWith('+')) return '..' + id.slice(1);
  if (id.startsWith('-')) return id.slice(1);
  return id;
}

/** The ids of the sections above `nodeId` in the tree, outermost first; null if it is not in the tree. */
export function ancestorsOf(nodes: readonly HelpTreeNode[], nodeId: string, path: string[] = []): string[] | null {
  for (const n of nodes) {
    if (n.id === nodeId) return path;
    const found = ancestorsOf(n.children, nodeId, [...path, n.id]);
    if (found) return found;
  }
  return null;
}

/** The nodes a keyboard user moves through: every node whose sections above are all unfolded, in order. */
export function visibleNodes(nodes: readonly HelpTreeNode[], unfolded: ReadonlySet<string>, out: HelpTreeNode[] = []): HelpTreeNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.section && unfolded.has(n.id)) visibleNodes(n.children, unfolded, out);
  }
  return out;
}

/**
 * The back/next history of pages shown. Unlike upstream's (which appends after the current entry without
 * dropping the ones ahead of it, so "next" after following a link can lead anywhere), following a link drops
 * the pages ahead, as a web browser does.
 */
export class HelpHistory {
  private entries: string[] = [];
  private pos = -1;

  /** Records `topicId` as shown; the same page twice in a row is one entry. */
  push(topicId: string): void {
    if (this.entries[this.pos] === topicId) return;
    this.entries = this.entries.slice(0, this.pos + 1);
    this.entries.push(topicId);
    this.pos = this.entries.length - 1;
  }
  get canBack(): boolean {
    return this.pos > 0;
  }
  get canForward(): boolean {
    return this.pos < this.entries.length - 1;
  }
  back(): string | undefined {
    if (!this.canBack) return undefined;
    return this.entries[--this.pos];
  }
  forward(): string | undefined {
    if (!this.canForward) return undefined;
    return this.entries[++this.pos];
  }
}

/** Whether a topic id can be shown in the tree (not a hidden page, which is reached by links only). */
export function isTreeTopic(topicId: string): boolean {
  return isVisibleId(topicId) || topicId.startsWith('..');
}
