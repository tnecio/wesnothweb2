/**
 * TS port of upstream Wesnoth's WFL tokenizer (src/formula/tokenizer.hpp/.cpp).
 *
 * This is a distinct, self-contained tokenizer from the WML tokenizer -- WFL
 * (Wesnoth Formula Language) is a small expression language used inside WML
 * string values (the `formula=` key on ability/weapon-special filters, plus
 * some AI scoring code), not a document format like WML itself.
 *
 * Deliberate simplifications vs. upstream:
 *  - No support for the `wfl '<file>' ... wflend` multi-file-inclusion
 *    mechanism (upstream uses it to let one .wfl file `{include}` another;
 *    our engine has no concept of loading formula files, only strings from
 *    already-parsed WML). `wfl`/`wflend` are still tokenized as keywords so
 *    a formula using them fails cleanly during parsing rather than silently
 *    misbehaving.
 */

export enum TokenType {
  Operator = 'operator',
  String = 'string',
  Identifier = 'identifier',
  Integer = 'integer',
  Decimal = 'decimal',
  LParen = 'lparen',
  RParen = 'rparen',
  LSquare = 'lsquare',
  RSquare = 'rsquare',
  Comma = 'comma',
  Semicolon = 'semicolon',
  Keyword = 'keyword',
  Pointer = 'pointer',
}

export interface Token {
  readonly type: TokenType;
  /** Raw source text of the token (string literals include their quotes). */
  readonly text: string;
  readonly line: number;
}

export class FormulaTokenError extends Error {
  constructor(
    public readonly description: string,
    public readonly context: string,
  ) {
    super(context ? `${description}: ${context}` : description);
    this.name = 'FormulaTokenError';
  }
}

// Word-shaped operators/keywords, matching tokenizer.cpp's special-cased
// identifier lookahead exactly: `d, or, in, def, and, not, wfl, where,
// wflend, functions`.
const WORD_OPERATORS = new Set(['d', 'or', 'in', 'and', 'not', 'where']);
const KEYWORDS = new Set(['def', 'wfl', 'wflend', 'functions']);

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Tokenizes a full WFL formula source string into a flat token list. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;

  const errorAt = (description: string, start: number): never => {
    let end = start;
    while (end < n && source[end] !== '\n') end++;
    throw new FormulaTokenError(description, source.slice(start, end));
  };

  while (i < n) {
    const ch = source[i]!;

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch <= ' ') {
      // Any other whitespace (space, tab, CR, ...).
      i++;
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < n && isIdentStart(source[i]!)) i++;
      const text = source.slice(start, i);
      if (WORD_OPERATORS.has(text)) {
        tokens.push({ type: TokenType.Operator, text, line });
      } else if (KEYWORDS.has(text)) {
        tokens.push({ type: TokenType.Keyword, text, line });
      } else {
        tokens.push({ type: TokenType.Identifier, text, line });
      }
      continue;
    }

    if (isDigit(ch)) {
      const start = i;
      i++;
      let dot = false;
      while (i < n) {
        const c = source[i]!;
        if (isDigit(c)) {
          i++;
          continue;
        }
        if (c === '.') {
          if (dot) errorAt('Multiple dots near decimal expression', start);
          dot = true;
          i++;
          continue;
        }
        break;
      }
      tokens.push({ type: dot ? TokenType.Decimal : TokenType.Integer, text: source.slice(start, i), line });
      continue;
    }

    switch (ch) {
      case '[':
        tokens.push({ type: TokenType.LSquare, text: ch, line });
        i++;
        continue;
      case ']':
        tokens.push({ type: TokenType.RSquare, text: ch, line });
        i++;
        continue;
      case '(':
        tokens.push({ type: TokenType.LParen, text: ch, line });
        i++;
        continue;
      case ')':
        tokens.push({ type: TokenType.RParen, text: ch, line });
        i++;
        continue;
      case ',':
        tokens.push({ type: TokenType.Comma, text: ch, line });
        i++;
        continue;
      case ';':
        tokens.push({ type: TokenType.Semicolon, text: ch, line });
        i++;
        continue;
      case '^':
      case '~':
      case '+':
      case '*':
      case '/':
      case '%':
      case '=':
        tokens.push({ type: TokenType.Operator, text: ch, line });
        i++;
        continue;
      case '<':
      case '>': {
        i++;
        if (i < n && source[i] === '=') {
          tokens.push({ type: TokenType.Operator, text: ch + '=', line });
          i++;
        } else {
          tokens.push({ type: TokenType.Operator, text: ch, line });
        }
        continue;
      }
      case '-': {
        i++;
        if (i < n && source[i] === '>') {
          tokens.push({ type: TokenType.Pointer, text: '->', line });
          i++;
        } else {
          tokens.push({ type: TokenType.Operator, text: '-', line });
        }
        continue;
      }
      case '.': {
        i++;
        if (i < n && '+-*/.'.includes(source[i]!)) {
          tokens.push({ type: TokenType.Operator, text: '.' + source[i], line });
          i++;
        } else {
          tokens.push({ type: TokenType.Operator, text: '.', line });
        }
        continue;
      }
      case '!': {
        i++;
        if (i < n && source[i] === '=') {
          tokens.push({ type: TokenType.Operator, text: '!=', line });
          i++;
        } else {
          errorAt('Unrecognized token', i - 1);
        }
        continue;
      }
      case "'": {
        // Formula string literal. Bracket-depth-aware so a `]` used as part
        // of an embedded `[substitution]` (or, one level in, a list/map
        // index) doesn't prematurely end the string.
        const start = i;
        i++;
        let depth = 0;
        while (i < n) {
          const c = source[i]!;
          if (c === '[') depth++;
          else if (depth > 0 && c === ']') depth--;
          else if (depth === 0 && c === "'") break;
          if (c === '\n') line++;
          i++;
        }
        if (i >= n) errorAt("Missing closing ' for formula string", start);
        i++; // consume closing quote
        tokens.push({ type: TokenType.String, text: source.slice(start, i), line });
        continue;
      }
      case '#': {
        // `# ... #` comment (can span multiple lines).
        const start = i;
        i++;
        while (i < n && source[i] !== '#') {
          if (source[i] === '\n') line++;
          i++;
        }
        if (i >= n) errorAt('Missing closing # for formula comment', start);
        i++; // consume closing '#'
        continue;
      }
      default:
        errorAt('Unrecognized token', i);
    }
  }

  return tokens;
}
