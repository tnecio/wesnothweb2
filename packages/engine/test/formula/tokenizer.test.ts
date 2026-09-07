import { describe, expect, it } from 'vitest';
import { FormulaTokenError, TokenType, tokenize } from '../../src/formula/tokenizer';

describe('WFL tokenizer', () => {
  it('tokenizes arithmetic and identifiers', () => {
    const tokens = tokenize('self.hitpoints + 1 * 2');
    expect(tokens.map((t) => [t.type, t.text])).toEqual([
      [TokenType.Identifier, 'self'],
      [TokenType.Operator, '.'],
      [TokenType.Identifier, 'hitpoints'],
      [TokenType.Operator, '+'],
      [TokenType.Integer, '1'],
      [TokenType.Operator, '*'],
      [TokenType.Integer, '2'],
    ]);
  });

  it('tokenizes word operators and keywords distinctly from identifiers', () => {
    // Note: single-letter `d` can never be used as an identifier in WFL --
    // it's always the dice-roll word-operator, matching upstream exactly.
    const tokens = tokenize('a and b or not c in z where e def f functions');
    const types = tokens.map((t) => t.type);
    expect(types).toEqual([
      TokenType.Identifier, // a
      TokenType.Operator, // and
      TokenType.Identifier, // b
      TokenType.Operator, // or
      TokenType.Operator, // not
      TokenType.Identifier, // c
      TokenType.Operator, // in
      TokenType.Identifier, // z
      TokenType.Operator, // where
      TokenType.Identifier, // e
      TokenType.Keyword, // def
      TokenType.Identifier, // f
      TokenType.Keyword, // functions
    ]);
  });

  it('tokenizes a decimal literal separately from two integer/dot tokens', () => {
    const tokens = tokenize('1.5');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: TokenType.Decimal, text: '1.5' });
  });

  it('tokenizes compound operators (.+ .- .* ./ .. -> <= >= !=)', () => {
    // Note: `d` is deliberately avoided as an identifier here -- it's the
    // dice-roll word-operator (see the previous test), matching upstream's
    // tokenizer.cpp exactly.
    const tokens = tokenize('a .+ b .- c .* w ./ e .. f -> g <= h >= i != j');
    const texts = tokens.filter((t) => t.type === TokenType.Operator || t.type === TokenType.Pointer).map((t) => t.text);
    expect(texts).toEqual(['.+', '.-', '.*', './', '..', '->', '<=', '>=', '!=']);
  });

  it('tokenizes a string literal keeping embedded brackets intact', () => {
    const tokens = tokenize("'hello [1+1] world'");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: TokenType.String, text: "'hello [1+1] world'" });
  });

  it('discards comments', () => {
    const tokens = tokenize('1 # this is a comment # + 2');
    expect(tokens.map((t) => t.text)).toEqual(['1', '+', '2']);
  });

  it('tracks line numbers across newlines', () => {
    const tokens = tokenize('1 +\n2');
    expect(tokens[0]!.line).toBe(1);
    expect(tokens[2]!.line).toBe(2);
  });

  it('throws on an unterminated string literal', () => {
    expect(() => tokenize("'unterminated")).toThrow(FormulaTokenError);
  });

  it('throws on an unrecognized character', () => {
    expect(() => tokenize('1 @ 2')).toThrow(FormulaTokenError);
  });
});
