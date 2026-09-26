/**
 * TS port of upstream Wesnoth's `serialization/parser.cpp`'s `io::parser`.
 *
 * Consumes the token stream from tokenizer.ts and builds a `WmlConfig` tree:
 * `[tag]...[/tag]` become child nodes (`[+tag]` merges into/extends the last
 * existing same-named child, matching upstream), and `key=value` lines
 * become attributes, including the `x,y = 1,2` multi-assign form and
 * `"a" + "b"` string concatenation.
 *
 * Translatable strings (`_ "text"`) keep their identity: each one is stamped
 * with the textdomain the preprocessor left in effect at that point and the
 * attribute is stored as a `TString`, so a later language switch can
 * retranslate it. An attribute with no translatable part is still inferred
 * to a scalar, exactly as before.
 */

import { TString, type TStringPart } from '../i18n/tstring.js';
import type { WmlAttributeValue, WmlStoredValue } from './config.js';
import { WmlConfig } from './config.js';
import type { TokenType, WmlToken } from './tokenizer.js';
import { Tokenizer } from './tokenizer.js';

export interface ParseConfigOptions {
  /** The textdomain in effect at the start of the text (the preprocessor's initial one; default `wesnoth`). */
  textdomain?: string;
}

/** Parses already-preprocessed WML text into a `WmlConfig` tree. */
export function parseConfig(text: string, opts: ParseConfigOptions = {}): WmlConfig {
  return new Parser(text, opts.textdomain).parse();
}

/**
 * Infers a typed attribute value from raw WML attribute text, mirroring
 * upstream's `config_attribute_value::operator=(std::string&&)`: `yes`/`no`
 * and `true`/`false` become booleans, strings that round-trip through a
 * number become that number, everything else stays a string. Applied
 * uniformly regardless of whether the source used quotes, matching
 * upstream (the tokenizer already stripped quote syntax by this point).
 */
function inferAttributeValue(raw: string): WmlAttributeValue {
  if (raw === '') return '';
  if (raw === 'yes' || raw === 'true') return true;
  if (raw === 'no' || raw === 'false') return false;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  return raw;
}

/** A finished attribute value: a `TString` if any part was translatable, else the inferred scalar. */
function valueFromParts(parts: TStringPart[]): WmlStoredValue {
  if (parts.some((p) => typeof p !== 'string')) return TString.fromParts(parts);
  return inferAttributeValue(parts.join(''));
}

interface ElementFrame {
  cfg: WmlConfig;
  name: string;
  line: number;
}

class ParseError extends Error {}

class Parser {
  private readonly tok: Tokenizer;
  private current: WmlToken;
  private readonly stack: ElementFrame[] = [];

  constructor(text: string, textdomain?: string) {
    this.tok = new Tokenizer(text, textdomain);
    this.current = { type: 'END', value: '', line: 0, textdomain: textdomain ?? 'wesnoth' };
  }

  private next(): WmlToken {
    this.current = this.tok.nextToken();
    return this.current;
  }

  private fail(message: string): never {
    throw new ParseError(`${message} (line ${this.current.line})`);
  }

  parse(): WmlConfig {
    const root = new WmlConfig();
    this.stack.push({ cfg: root, name: '', line: 0 });

    this.next();
    while (this.current.type !== 'END') {
      const type: TokenType = this.current.type;
      if (type === 'NEWLINE') {
        this.next();
        continue;
      } else if (type === 'OPEN_BRACKET') {
        this.parseElement();
      } else if (type === 'STRING') {
        this.parseVariable();
      } else {
        this.fail(`Unexpected characters at line start: ${JSON.stringify(this.current.value)}`);
      }
    }

    if (this.stack.length !== 1) {
      const top = this.stack[this.stack.length - 1] as ElementFrame;
      throw new ParseError(`Missing closing tag for [${top.name}] (opened at line ${top.line})`);
    }

    return root;
  }

  private parseElement(): void {
    const tok = this.next();

    if (tok.type === 'STRING') {
      // [element]
      const name = tok.value;
      if (this.next().type !== 'CLOSE_BRACKET') {
        this.fail(`Unterminated [${name}] tag`);
      }
      const parent = (this.stack[this.stack.length - 1] as ElementFrame).cfg;
      const child = parent.addChild(name);
      this.stack.push({ cfg: child, name, line: tok.line });
      this.next();
      return;
    }

    if (tok.type === 'PLUS') {
      // [+element]: merge into the last existing same-named child, if any.
      const nameTok = this.next();
      if (nameTok.type !== 'STRING') {
        this.fail('Invalid tag name');
      }
      const name = nameTok.value;
      if (this.next().type !== 'CLOSE_BRACKET') {
        this.fail(`Unterminated [+${name}] tag`);
      }
      const parent = (this.stack[this.stack.length - 1] as ElementFrame).cfg;
      const existing = parent.children(name);
      const child = existing.length > 0 ? (existing[existing.length - 1] as WmlConfig) : parent.addChild(name);
      this.stack.push({ cfg: child, name, line: nameTok.line });
      this.next();
      return;
    }

    if (tok.type === 'SLASH') {
      // [/element]
      const nameTok = this.next();
      if (nameTok.type !== 'STRING') {
        this.fail('Invalid closing tag name');
      }
      const name = nameTok.value;
      if (this.next().type !== 'CLOSE_BRACKET') {
        this.fail(`Unterminated closing tag [/${name}]`);
      }
      if (this.stack.length <= 1) {
        this.fail('Unexpected closing tag');
      }
      const top = this.stack[this.stack.length - 1] as ElementFrame;
      if (top.name !== name) {
        this.fail(`Found invalid closing tag [/${name}] for tag [${top.name}] (opened at line ${top.line})`);
      }
      this.stack.pop();
      this.next();
      return;
    }

    this.fail('Invalid tag name');
  }

  private parseVariable(): void {
    const cfg = (this.stack[this.stack.length - 1] as ElementFrame).cfg;
    const variables: string[] = [''];

    while (this.current.type !== 'EQUALS') {
      const type = this.current.type;
      if (type === 'STRING') {
        const lastIdx = variables.length - 1;
        if (variables[lastIdx]) variables[lastIdx] += ' ';
        variables[lastIdx] += this.current.value;
      } else if (type === 'COMMA') {
        if (!variables[variables.length - 1]) this.fail('Empty variable name');
        variables.push('');
      } else {
        this.fail('Unexpected characters after variable name (expected , or =)');
      }
      this.next();
    }
    if (!variables[variables.length - 1]) this.fail('Empty variable name');

    let curvarIdx = 0;
    let parts: TStringPart[] = [];
    let ignoreNextNewlines = false;
    let previousString = false;

    for (;;) {
      this.next();
      const t = this.current;
      let finished = false;
      // Tracks the type of the *last* token actually fetched this iteration
      // (the UNDERSCORE case fetches a second one), used below to decide
      // whether the next unquoted STRING token needs a leading space.
      let lastFetchedType: TokenType = t.type;

      switch (t.type) {
        case 'COMMA':
          if (curvarIdx + 1 < variables.length) {
            cfg.setAttribute(variables[curvarIdx] as string, valueFromParts(parts));
            parts = [];
            curvarIdx++;
          } else {
            parts.push(',');
          }
          break;

        case 'UNDERSCORE': {
          this.next();
          const t2 = this.current;
          lastFetchedType = t2.type;
          if (t2.type === 'UNTERMINATED_QSTRING') {
            this.fail('Unterminated quoted string');
          } else if (t2.type === 'QSTRING') {
            parts.push({ domain: t2.textdomain, msgid: t2.value });
          } else if (t2.type === 'END' || t2.type === 'NEWLINE') {
            parts.push('_');
            finished = true;
          } else {
            parts.push('_' + t2.value);
          }
          break;
        }

        case 'PLUS':
          ignoreNextNewlines = true;
          continue;

        case 'STRING':
          if (previousString) parts.push(' ');
          parts.push(t.value);
          break;

        case 'QSTRING':
          parts.push(t.value);
          break;

        case 'UNTERMINATED_QSTRING':
          this.fail('Unterminated quoted string');
          break;

        case 'NEWLINE':
          if (ignoreNextNewlines) continue;
          finished = true;
          break;

        case 'END':
          finished = true;
          break;

        default:
          parts.push(t.value);
          break;
      }

      if (finished) break;

      previousString = lastFetchedType === 'STRING';
      ignoreNextNewlines = false;
    }

    cfg.setAttribute(variables[curvarIdx] as string, valueFromParts(parts));
    for (let i = curvarIdx + 1; i < variables.length; i++) {
      cfg.setAttribute(variables[i] as string, '');
    }
  }
}
