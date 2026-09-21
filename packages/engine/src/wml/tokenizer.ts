/**
 * TS port of upstream Wesnoth's `serialization/tokenizer.{hpp,cpp}`.
 *
 * Lexes already-preprocessed WML text (see preprocessor.ts) into a flat
 * token stream that parser.ts turns into a `WmlConfig` tree.
 *
 * Deliberate simplification vs. upstream: the C++ tokenizer also recognizes
 * `#line`/inline preprocessor markers (an internal-use-only 0xFE control
 * character the preprocessor stitches into its output so error messages can
 * point at the right original file/line even after macro expansion). Our
 * preprocessor fully expands everything into one flat string up front
 * instead of interleaving those markers, so this tokenizer only needs to
 * understand plain `#textdomain NAME` comment-lines and ordinary `#...`
 * comments. Line numbers are tracked for diagnostics, but they are relative
 * to the *preprocessed* text (post macro-expansion), not the original
 * source file -- good enough for Phase 1, revisit if better error
 * attribution is needed later.
 */

import { INLINE_MARK } from './inlineMark.js';

export type TokenType =
  | 'NEWLINE'
  | 'EQUALS'
  | 'COMMA'
  | 'PLUS'
  | 'SLASH'
  | 'OPEN_BRACKET'
  | 'CLOSE_BRACKET'
  | 'UNDERSCORE'
  | 'STRING'
  | 'QSTRING'
  | 'UNTERMINATED_QSTRING'
  | 'MISC'
  | 'END';

export interface WmlToken {
  type: TokenType;
  value: string;
  /** 1-based line number (in the preprocessed text) where this token starts. */
  line: number;
}

type Char = string | null;
const EOF: null = null;

const SINGLE_CHAR_TOKENS: Record<string, TokenType> = {
  '[': 'OPEN_BRACKET',
  ']': 'CLOSE_BRACKET',
  '/': 'SLASH',
  '\n': 'NEWLINE',
  '=': 'EQUALS',
  ',': 'COMMA',
  '+': 'PLUS',
};

function isAlpha(c: Char): boolean {
  return c !== null && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
}

function isNumeric(c: Char): boolean {
  return c !== null && c >= '0' && c <= '9';
}

function isAlnum(c: Char): boolean {
  return isAlpha(c) || isNumeric(c);
}

function isSpace(c: Char): boolean {
  return c === ' ' || c === '\t';
}

/**
 * Lexes preprocessed WML text one token at a time. Mirrors the upstream
 * `tokenizer` class's `next_token()` state machine.
 */
export class Tokenizer {
  private readonly src: string;
  private idx: number;
  private current: Char;
  private line = 1;
  private startLine = 0;
  /** Updated in place whenever a `#textdomain NAME` line is scanned. */
  textdomain: string;

  constructor(src: string, initialTextdomain = 'wesnoth') {
    this.src = src;
    this.textdomain = initialTextdomain;
    this.idx = 0;
    this.current = this.rawNext();
  }

  /** Line number (1-based) at which the most recently returned token starts. */
  get startLineNumber(): number {
    return this.startLine;
  }

  private rawNext(): Char {
    // Skip preprocessor boundary marks (see `INLINE_MARK`) transparently --
    // they are never content. `peekChar` deliberately does NOT skip them: a
    // mark between `""` and `""` is exactly what stops the `""` escaped-quote
    // lookahead from fusing two adjacent empty strings into one literal quote.
    while (this.idx < this.src.length && this.src.charAt(this.idx) === INLINE_MARK) this.idx++;
    if (this.idx >= this.src.length) return EOF;
    const c = this.src.charAt(this.idx);
    this.idx++;
    return c;
  }

  private peekChar(): Char {
    return this.idx < this.src.length ? this.src.charAt(this.idx) : EOF;
  }

  /** Advance `current` to the next char, collapsing `\r\n` to `\n`. No line counting. */
  private nextCharSkipCr(): void {
    this.current = this.rawNext();
    if (this.current === '\r') {
      this.current = this.rawNext();
    }
  }

  /** Advance `current`, counting a line if the char being left behind was `\n`. */
  private nextChar(): void {
    if (this.current === '\n') this.line++;
    this.nextCharSkipCr();
  }

  /**
   * Called with `current` positioned right after a `#` that starts a
   * comment/directive line. Recognizes `#textdomain NAME`; anything else
   * (including the preprocessor-only `#line`, which should never survive
   * into fully-expanded text) is treated as a plain comment and discarded.
   */
  private skipComment(): void {
    this.nextCharSkipCr();
    if (this.current === '\n' || this.current === EOF) return;

    const firstChar = this.current;
    if (firstChar === 't' && this.skipCommand('extdomain')) {
      let s = '';
      while (this.current !== '\n' && this.current !== EOF) {
        s += this.current;
        this.nextCharSkipCr();
      }
      this.textdomain = s;
      return;
    }

    while (this.current !== '\n' && this.current !== EOF) {
      this.nextCharSkipCr();
    }
  }

  /** Returns true and consumes `cmd` + a trailing space iff the upcoming chars match. */
  private skipCommand(cmd: string): boolean {
    for (let i = 0; i < cmd.length; i++) {
      this.nextCharSkipCr();
      if (this.current !== cmd.charAt(i)) return false;
    }
    this.nextCharSkipCr();
    if (!isSpace(this.current)) return false;
    this.nextCharSkipCr();
    return true;
  }

  private makeToken(type: TokenType, value: string): WmlToken {
    return { type, value, line: this.startLine };
  }

  /** Reads and returns the next token, advancing internal state past it. */
  nextToken(): WmlToken {
    while (isSpace(this.current)) {
      this.nextCharSkipCr();
    }
    if (this.current === '#') {
      this.skipComment();
    }

    this.startLine = this.line;
    const c = this.current;

    if (c === EOF) {
      return this.makeToken('END', '');
    }

    // Double angle brackets: verbatim quoted string (raw Lua etc.), no macro expansion.
    if (c === '<') {
      if (this.peekChar() !== '<') {
        this.nextChar();
        return this.makeToken('MISC', '<');
      }
      this.nextCharSkipCr(); // consume the second '<'
      let value = '';
      let type: TokenType = 'QSTRING';
      for (;;) {
        this.nextChar();
        if (this.current === EOF) {
          type = 'UNTERMINATED_QSTRING';
          break;
        }
        if (this.current === '>' && this.peekChar() === '>') {
          this.nextCharSkipCr();
          break;
        }
        value += this.current;
      }
      if (this.current !== EOF) this.nextChar();
      return this.makeToken(type, value);
    }

    // Double-quoted string, with "" as an escaped literal quote.
    if (c === '"') {
      let value = '';
      let type: TokenType = 'QSTRING';
      for (;;) {
        this.nextChar();
        if (this.current === EOF) {
          type = 'UNTERMINATED_QSTRING';
          break;
        }
        if (this.current === '"') {
          if (this.peekChar() !== '"') break;
          this.nextCharSkipCr();
        }
        value += this.current;
      }
      if (this.current !== EOF) this.nextChar();
      return this.makeToken(type, value);
    }

    const single = SINGLE_CHAR_TOKENS[c];
    if (single !== undefined) {
      this.nextChar();
      return this.makeToken(single, c);
    }

    if (c === '_') {
      if (!isAlnum(this.peekChar())) {
        this.nextChar();
        return this.makeToken('UNDERSCORE', '_');
      }
      // else fall through: leading underscore is part of a plain identifier/number run.
    }

    if (isAlnum(c) || c === '$') {
      let value = '';
      do {
        value += this.current;
        this.nextCharSkipCr();
      } while (isAlnum(this.current) || this.current === '$');
      return this.makeToken('STRING', value);
    }

    // Anything else (punctuation like . ~ : ( ) % - etc.) is a single MISC char.
    this.nextChar();
    return this.makeToken('MISC', c);
  }
}
