import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WmlConfig } from '@wesnothweb2/engine';
import { MarkupParseError, parseMarkup, tag, type MarkupNode } from './markup.js';
import type { HelpData } from './helpData.js';

const strip = (n: MarkupNode): unknown => ({
  tag: n.tag,
  ...(Object.keys(n.attrs).length > 0 ? { attrs: n.attrs } : {}),
  ...(n.children.length > 0 ? { children: n.children.map(strip) } : {}),
});
const parse = (s: string) => (strip(parseMarkup(s)) as { children?: unknown[] }).children ?? [];

describe('parseMarkup (upstream markup::parse_text)', () => {
  it('keeps one newline, and starts a new text run at two', () => {
    expect(parse('a\nb')).toEqual([{ tag: 'text', attrs: { text: 'a\nb' } }]);
    expect(parse('a\n\nb')).toEqual([
      { tag: 'text', attrs: { text: 'a' } },
      { tag: 'text', attrs: { text: 'b' } },
    ]);
  });

  it('gives a tag whose content is only text that text as its attribute', () => {
    expect(parse("<ref dst='unit_Elvish Fighter'>Elvish Fighter</ref>")).toEqual([
      { tag: 'ref', attrs: { dst: 'unit_Elvish Fighter', text: 'Elvish Fighter' } },
    ]);
  });

  it('nests tags (with the empty text run upstream leaves before a closing tag), and parses self-closing tags', () => {
    expect(parse('<b>x <i>y</i></b><img src=a.png align=left/>')).toEqual([
      {
        tag: 'b',
        children: [{ tag: 'text', attrs: { text: 'x ' } }, { tag: 'i', attrs: { text: 'y' } }, { tag: 'text', attrs: { text: '' } }],
      },
      { tag: 'img', attrs: { src: 'a.png', align: 'left' } },
    ]);
  });

  it('decodes entities and escapes; an unknown named entity is kept as a node', () => {
    expect(parse('&lt;&#65;&#x42;\\<')).toEqual([{ tag: 'text', attrs: { text: '<AB<' } }]);
    expect(parse('a&nbsp;b')).toEqual([
      { tag: 'text', attrs: { text: 'a' } },
      { tag: 'character_entity', attrs: { name: 'nbsp' } },
      { tag: 'text', attrs: { text: 'b' } },
    ]);
  });

  it('accepts old-style tags', () => {
    expect(parse('<ref>dst=foo text=Foo</ref>')).toEqual([{ tag: 'ref', attrs: { dst: 'foo', text: 'Foo' } }]);
  });

  it('reports errors with upstream messages and positions', () => {
    expect(() => parseMarkup('x\n<b>oops')).toThrow(MarkupParseError);
    expect(() => parseMarkup('x\n<b>oops')).toThrow(/^line 2, .*Missing closing tag for b/);
    expect(() => parseMarkup('<b>a</i>')).toThrow(/Mismatched closing tag b/);
  });

  it('builds nothing for an empty tag, as upstream markup::tag', () => {
    expect(tag('col', '')).toBe('');
    expect(tag('col', 1)).toBe('<col>1</col>');
  });
});

describe('the real help texts', () => {
  const file = path.resolve(__dirname, '../../../../apps/web/public/help/core.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as HelpData;
  it('every [topic] text= in data/core/help.cfg parses', () => {
    const help = WmlConfig.fromJSON(data.help);
    const failures: string[] = [];
    for (const topic of help.children('topic')) {
      try {
        parseMarkup(topic.getString('text'));
      } catch (e) {
        failures.push(`${topic.getString('id')}: ${(e as Error).message}`);
      }
    }
    expect(help.children('topic').length).toBeGreaterThan(50);
    expect(failures).toEqual([]);
  });
});
