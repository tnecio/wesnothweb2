import { describe, expect, it } from 'vitest';
import { Tokenizer } from '../../src/wml/tokenizer';

function tokenTypes(text: string): string[] {
  const tok = new Tokenizer(text);
  const types: string[] = [];
  for (;;) {
    const t = tok.nextToken();
    types.push(t.type);
    if (t.type === 'END') break;
  }
  return types;
}

describe('Tokenizer', () => {
  it('tokenizes a simple key=value line', () => {
    const tok = new Tokenizer('name=foo\n');
    expect(tok.nextToken()).toMatchObject({ type: 'STRING', value: 'name' });
    expect(tok.nextToken()).toMatchObject({ type: 'EQUALS', value: '=' });
    expect(tok.nextToken()).toMatchObject({ type: 'STRING', value: 'foo' });
    expect(tok.nextToken()).toMatchObject({ type: 'NEWLINE' });
    expect(tok.nextToken()).toMatchObject({ type: 'END' });
  });

  it('tokenizes tag brackets and slash/plus', () => {
    expect(tokenTypes('[a][/a][+a]')).toEqual([
      'OPEN_BRACKET',
      'STRING',
      'CLOSE_BRACKET',
      'OPEN_BRACKET',
      'SLASH',
      'STRING',
      'CLOSE_BRACKET',
      'OPEN_BRACKET',
      'PLUS',
      'STRING',
      'CLOSE_BRACKET',
      'END',
    ]);
  });

  it('parses quoted strings with doubled-quote escaping', () => {
    const tok = new Tokenizer('x="a ""quoted"" b"\n');
    tok.nextToken(); // x
    tok.nextToken(); // =
    const q = tok.nextToken();
    expect(q).toMatchObject({ type: 'QSTRING', value: 'a "quoted" b' });
  });

  it('parses verbatim << >> strings without interpreting contents', () => {
    const tok = new Tokenizer('code=<<a{b}c>>\n');
    tok.nextToken(); // code
    tok.nextToken(); // =
    const q = tok.nextToken();
    expect(q).toMatchObject({ type: 'QSTRING', value: 'a{b}c' });
  });

  it('flags unterminated quoted strings', () => {
    const tok = new Tokenizer('x="abc');
    tok.nextToken();
    tok.nextToken();
    expect(tok.nextToken().type).toBe('UNTERMINATED_QSTRING');
  });

  it('treats a lone underscore before a space as UNDERSCORE, but _foo as STRING', () => {
    const tok = new Tokenizer('_ "hi" _foo\n');
    expect(tok.nextToken()).toMatchObject({ type: 'UNDERSCORE', value: '_' });
    expect(tok.nextToken()).toMatchObject({ type: 'QSTRING', value: 'hi' });
    expect(tok.nextToken()).toMatchObject({ type: 'STRING', value: '_foo' });
  });

  it('drops comment lines and tracks #textdomain', () => {
    const tok = new Tokenizer('# a comment\n#textdomain foo\nname=bar\n');
    expect(tok.nextToken()).toMatchObject({ type: 'NEWLINE' });
    expect(tok.textdomain).toBe('wesnoth');
    expect(tok.nextToken()).toMatchObject({ type: 'NEWLINE' });
    expect(tok.textdomain).toBe('foo');
    expect(tok.nextToken()).toMatchObject({ type: 'STRING', value: 'name' });
  });
});
