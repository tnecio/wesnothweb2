import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/wml/parser';

describe('parseConfig', () => {
  it('parses attributes and nested tags into a WmlConfig tree', () => {
    const cfg = parseConfig(`
[scenario]
    id=01_Invasion
    name= _ "Invasion!"
    turns=32

    [side]
        side=1
        gold=100
        controller=human
    [/side]
    [side]
        side=2
        gold=50
    [/side]
[/scenario]
`);

    const scenario = cfg.child('scenario');
    expect(scenario).toBeDefined();
    expect(scenario!.getString('id')).toBe('01_Invasion');
    expect(scenario!.getString('name')).toBe('Invasion!');
    expect(scenario!.get('turns')).toBe(32);

    const sides = scenario!.children('side');
    expect(sides).toHaveLength(2);
    expect(sides[0]!.get('side')).toBe(1);
    expect(sides[0]!.get('gold')).toBe(100);
    expect(sides[0]!.get('controller')).toBe('human');
    expect(sides[1]!.get('gold')).toBe(50);
  });

  it('infers numbers and booleans, keeps other strings as-is', () => {
    const cfg = parseConfig('a=5\nb=yes\nc=no\nd=true\ne=false\nf=hello\ng=1.5\nh=-3\n');
    expect(cfg.get('a')).toBe(5);
    expect(cfg.get('b')).toBe(true);
    expect(cfg.get('c')).toBe(false);
    expect(cfg.get('d')).toBe(true);
    expect(cfg.get('e')).toBe(false);
    expect(cfg.get('f')).toBe('hello');
    expect(cfg.get('g')).toBe(1.5);
    expect(cfg.get('h')).toBe(-3);
  });

  it('supports multi-assign x,y=1,2', () => {
    const cfg = parseConfig('x,y=1,2\n');
    expect(cfg.get('x')).toBe(1);
    expect(cfg.get('y')).toBe(2);
  });

  it('keeps unquoted comma-separated lists as one literal string when there is only one variable (note: the tokenizer does not preserve inter-token whitespace, so a space directly after a comma is dropped -- matches upstream)', () => {
    const cfg = parseConfig('recruit=Merman Citizen, Merman Fighter, Merman Hunter\n');
    expect(cfg.getString('recruit')).toBe('Merman Citizen,Merman Fighter,Merman Hunter');
  });

  it('concatenates strings with +, including across lines', () => {
    const cfg = parseConfig('desc= "a" + "b" + \n "c"\n');
    expect(cfg.getString('desc')).toBe('abc');
  });

  it('supports [+tag] merging into the last same-named child', () => {
    const cfg = parseConfig(`
[a]
    x=1
[/a]
[+a]
    y=2
[/a]
`);
    const children = cfg.children('a');
    expect(children).toHaveLength(1);
    expect(children[0]!.get('x')).toBe(1);
    expect(children[0]!.get('y')).toBe(2);
  });

  it('throws on mismatched closing tags', () => {
    expect(() => parseConfig('[a]\n[/b]\n')).toThrow();
  });

  it('throws on a missing closing tag', () => {
    expect(() => parseConfig('[a]\nx=1\n')).toThrow();
  });
});
