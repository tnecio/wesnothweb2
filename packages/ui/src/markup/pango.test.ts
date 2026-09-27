import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeEntities, parsePango, stripPango, type PangoNode } from './pango.js';

const shape = (nodes: PangoNode[]): unknown[] => nodes.map((n) => ('text' in n ? n.text : { [n.tag]: shape(n.children), ...(Object.keys(n.style).length > 0 ? { style: n.style } : {}) }));

describe('parsePango', () => {
  it('leaves plain text alone', () => expect(shape(parsePango('Hello'))).toEqual(['Hello']));

  it('parses nested tags', () => {
    expect(shape(parsePango('a <b>b <i>c</i></b> d'))).toEqual([
      'a ',
      { b: ['b ', { i: ['c'], style: { 'font-style': 'italic' } }], style: { 'font-weight': 'bold' } },
      ' d',
    ]);
  });

  it('turns a span into validated CSS', () => {
    const [span] = parsePango(`<span color='#ff8800' size="x-large" weight='bold' style="italic">x</span>`);
    expect((span as { style: unknown }).style).toEqual({ color: '#ff8800', 'font-size': '1.44em', 'font-weight': 'bold', 'font-style': 'italic' });
  });

  it('drops span attributes it does not accept, keeping the text', () => {
    const [span] = parsePango(`<span color="red; background:url(x)" onclick="evil()">x</span>`);
    expect((span as { style: unknown }).style).toEqual({});
  });

  it('keeps an unknown tag, a stray < and a close with no open as literal text', () => {
    expect(shape(parsePango('1 < 2 and <script>alert(1)</script> </b>'))).toEqual(['1 < 2 and <script>alert(1)</script> </b>']);
  });

  it('closes what is left open at the end and tolerates a mismatched close', () => {
    expect(shape(parsePango('<b>bold <i>both</b> after'))).toEqual([
      { b: ['bold ', { i: ['both'], style: { 'font-style': 'italic' } }], style: { 'font-weight': 'bold' } },
      ' after',
    ]);
    expect(stripPango('<b>never closed')).toBe('never closed');
  });

  it('decodes entities, including numeric ones, but not an unknown one', () => {
    expect(decodeEntities('&lt;b&gt; &amp; &#65;&#x42; &nbsp; &#0;')).toBe('<b> & AB &nbsp; &#0;');
    expect(shape(parsePango('&lt;b&gt;'))).toEqual(['<b>']);
  });

  it('never produces an element that is not a known tag', () => {
    const walk = (nodes: PangoNode[]): void => {
      for (const n of nodes) if (!('text' in n)) {
        expect(['b', 'i', 'u', 's', 'big', 'small', 'sub', 'sup', 'tt', 'span']).toContain(n.tag);
        walk(n.children);
      }
    };
    walk(parsePango('<img src=x onerror=y><a href="x">l</a><b onclick="z">t</b><SPAN color="red">ok</SPAN>'));
  });
});

describe('the markup the shipped content actually uses', () => {
  const publicDir = path.resolve(__dirname, '../../../../apps/web/public');
  const text = (v: unknown): string => (typeof v === 'string' ? v : ((v as { t: unknown[] }).t.map((p) => (typeof p === 'string' ? p : (p as string[])[1])).join('')));

  it('parses every campaign description to text with no leftover markup', () => {
    const campaigns = JSON.parse(fs.readFileSync(path.join(publicDir, 'campaigns.json'), 'utf8')).campaigns as { id: string; description: unknown }[];
    for (const c of campaigns) {
      const plain = stripPango(text(c.description));
      expect(plain, c.id).not.toMatch(/<\/?(small|i|b)>/);
      expect(plain.length, c.id).toBeGreaterThan(20);
    }
  });

  it('parses every tip (69 of upstream)', () => {
    const cfg = fs.readFileSync(path.resolve(__dirname, '../../../../wesnoth/data/tips.cfg'), 'utf8');
    const tips = [...cfg.matchAll(/(?:text|source)\s*=\s*_\s*"([^"]*)"/g)].map((m) => m[1]!);
    expect(tips.length).toBeGreaterThan(100);
    for (const tip of tips) expect(stripPango(tip)).not.toMatch(/<\/?[ib]>/);
  });
});
