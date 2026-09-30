/**
 * The help's markup (Phase 24): a port of upstream's `markup::parse_text` (`src/serialization/markup.cpp`),
 * which turns a help page's text into a config tree that GUI2's `rich_label` lays out.
 *
 * The language is a small XML-like one:
 * - tags (`<b>`, `<i>`, `<span color=...>`, `<header>`, `<img src=... float=... align=.../>`, `<ref dst=...>`,
 *   `<table><row><col>`, ...);
 * - entities (`&lt;`, `&#65;`, `&#x41;`) and backslash escapes;
 * - text, in which two newlines start a new paragraph (a new `text` child).
 * Old-style tags (`<ref>dst=x text=y</ref>`) are accepted as upstream accepts them.
 *
 * The result has the same shape as upstream's config: every node is `{ tag, attrs, children }`. Text runs are
 * `text` nodes whose `attrs.text` is the text; a tag whose whole content is text keeps that text as its own
 * `text` attribute. `HelpMarkup.svelte` renders it; nothing is ever handed to `{@html}`.
 */

export interface MarkupNode {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly children: MarkupNode[];
}

export class MarkupParseError extends Error {
  constructor(
    message: string,
    /** Where in the text the parser stopped (a UTF-16 offset). */
    readonly position: number,
  ) {
    super(message);
    this.name = 'MarkupParseError';
  }
}

const OLD_STYLE_TAGS = ['bold', 'italic', 'header', 'format', 'img', 'ref', 'jump'];
const OLD_STYLE_ATTRS = ['dst', 'text', 'force', 'to', 'amount', 'src', 'align', 'float', 'bold', 'italic', 'color', 'font_size'];

function node(tag: string, attrs: Record<string, string> = {}): MarkupNode {
  return { tag, attrs, children: [] };
}

const isAlnum = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9]$/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isXDigit = (c: string | undefined): boolean => c !== undefined && /^[0-9A-Fa-f]$/.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /^[ \t\n\v\f\r]$/.test(c);
const isNameChar = (c: string | undefined): boolean => isAlnum(c) || c === '_';

/** An entity: a code point when it has one, else (an unknown named entity) just its name. */
interface Entity {
  name?: string;
  codePoint?: number;
}

class Parser {
  /** The read position, as upstream's iterator `beg`. */
  pos = 0;
  constructor(readonly text: string) {}

  /** The character at the read position (a method, so that checks on it are not narrowed across moves). */
  private cur(): string | undefined {
    return this.text[this.pos];
  }
  private at(offset: number): string | undefined {
    return this.text[this.pos + offset];
  }
  private get atEnd(): boolean {
    return this.pos >= this.text.length;
  }
  private error(message: string): MarkupParseError {
    return new MarkupParseError(message, this.pos);
  }

  parseEntity(): Entity {
    let s = '';
    let type: 'unknown' | 'named' | 'hex' | 'decimal' = 'unknown';
    this.pos++; // '&'
    for (; !this.atEnd && this.cur() !== ';'; this.pos++) {
      const c = this.cur()!;
      switch (type) {
        case 'unknown':
          if (c === '#') type = 'decimal';
          else if (isNameChar(c)) {
            type = 'named';
            s += c;
          } else throw this.error("invalid entity: unexpected characters after '&', alphanumeric characters, '#' or '_' expected.");
          break;
        case 'named':
          if (!isAlnum(c)) throw this.error("invalid entity: non-alphanumeric characters after '&'.");
          s += c;
          break;
        case 'decimal':
          if (c === 'x') type = 'hex';
          else if (isDigit(c)) s += c;
          else throw this.error("invalid entity: unexpected characters after '&#', numbers or 'x' expected.");
          break;
        case 'hex':
          if (isXDigit(c)) s += c;
          else throw this.error("invalid entity: unexpected characters after '&#x', hexadecimal digits expected.");
          break;
      }
    }
    if (type === 'named') {
      const known: Record<string, string> = { lt: '<', gt: '>', apos: "'", quot: '"', amp: '&' };
      return known[s] !== undefined ? { name: s, codePoint: known[s]!.codePointAt(0)! } : { name: s };
    }
    const n = parseInt(s, type === 'hex' ? 16 : 10);
    return { codePoint: Number.isFinite(n) ? n : 0 };
  }

  parseEscape(): string {
    // An escape at the end of the text is a literal backslash; otherwise the next character, literally.
    if (this.pos + 1 < this.text.length) this.pos++;
    return this.cur()!;
  }

  /** Text up to `close` (or the end): one or more `text` children, and `character_entity` for unknown entities. */
  parseTextUntil(close: string): MarkupNode {
    let s = '';
    let sawNewline = false;
    const res = node('');
    for (; !this.atEnd && this.cur() !== close; this.pos++) {
      const c = this.cur()!;
      if (c === '&') {
        const entity = this.parseEntity();
        if (this.atEnd) throw this.error('unexpected end of stream after entity');
        if (entity.codePoint !== undefined) s += fromCodePoint(entity.codePoint);
        else {
          res.children.push(node('text', { text: s }));
          res.children.push(node('character_entity', { name: entity.name ?? '' }));
          s = '';
        }
      } else if (c === '\\') {
        s += this.parseEscape();
      } else if (c === '\n') {
        if (sawNewline) {
          res.children.push(node('text', { text: s }));
          s = '';
        } else {
          sawNewline = true;
          continue;
        }
      } else {
        if (sawNewline) s += '\n';
        s += c;
      }
      sawNewline = false;
    }
    // A span ending in a newline keeps it.
    if (sawNewline) s += '\n';
    res.children.push(node('text', { text: s }));
    return res;
  }

  parseName(): string {
    let s = '';
    for (; !this.atEnd && isNameChar(this.cur()); this.pos++) s += this.cur();
    return s;
  }

  /** One `name=value` (or a bare `name`); leaves `pos` on the attribute's last character, as upstream. */
  parseAttribute(oldStyle: boolean): [string, string] {
    const attr = this.parseName();
    if (!attr) throw this.error('missing attribute name');
    if (oldStyle && !OLD_STYLE_ATTRS.includes(attr)) throw this.error('dummy error: not an old-style attribute name');
    while (isSpace(this.cur())) this.pos++;
    if (this.cur() !== '=') {
      if (oldStyle) throw this.error('attribute missing value in old-style tag');
      this.pos--;
      return [attr, ''];
    }
    this.pos++;
    while (isSpace(this.cur())) this.pos++;

    let value = '';
    if (this.cur() === "'" || this.cur() === '"') {
      const quote = this.cur()!;
      this.pos++;
      const res = this.parseTextUntil(quote);
      if (res.children.some((ch) => ch.tag === 'character_entity')) throw this.error('unsupported entity in attribute value');
      if (res.children.length > 1) throw this.error('paragraph break in attribute value');
      value = res.children[0]?.attrs.text ?? '';
    } else {
      let s = '';
      let foundSlash = false;
      for (; !this.atEnd && this.cur() !== '>' && this.cur() !== '<' && !isSpace(this.cur()); this.pos++) {
        const c = this.cur()!;
        if (c === '&') {
          const entity = this.parseEntity();
          if (this.atEnd) throw this.error('unexpected end of stream after entity');
          if (entity.codePoint === undefined) throw this.error('unsupported entity in attribute value');
          s += fromCodePoint(entity.codePoint);
        } else if (c === '\\') {
          s += this.parseEscape();
        } else if (c === '/') {
          foundSlash = true;
        } else {
          if (foundSlash) {
            s += '/';
            foundSlash = false;
          }
          s += c;
        }
      }
      value = s;
      this.pos--;
      if (foundSlash) this.pos--;
    }
    return [attr, value];
  }

  checkClosingTag(tagName: string): void {
    const remaining = this.text.length - this.pos;
    if (remaining < tagName.length + 3) throw this.error('Unexpected end of stream in closing tag');
    this.pos += 2;
    if (this.text.slice(this.pos, this.pos + tagName.length) !== tagName) throw this.error(`Mismatched closing tag ${tagName}`);
    this.pos += tagName.length;
    if (this.cur() !== '>') throw this.error(`Unterminated closing tag ${tagName}`);
    this.pos++;
  }

  /** A tag's content up to and including its closing tag. `pos` is on the opening tag's `>`. */
  parseTagContents(tagName: string, checkForAttributes: boolean): MarkupNode {
    this.pos++; // '>'
    if (!OLD_STYLE_TAGS.includes(tagName)) checkForAttributes = false;

    const res = node('');
    for (; checkForAttributes && !this.atEnd && this.cur() !== '<'; this.pos++) {
      if (isSpace(this.cur())) continue;
      const save = this.pos;
      try {
        const [key, val] = this.parseAttribute(true);
        res.attrs[key] = val;
      } catch (e) {
        if (!(e instanceof MarkupParseError)) throw e;
        this.pos = save;
        while (!this.atEnd && isSpace(this.cur())) this.pos++;
        break;
      }
    }
    const atClosing = (): boolean => !this.atEnd && this.cur() === '<' && this.pos + 1 < this.text.length && this.at(1) === '/';
    if ('text' in res.attrs) {
      if (!atClosing()) throw this.error("Extra text at the end of old-style tag with explicit 'text' attribute");
      this.checkClosingTag(tagName);
      return res;
    } else if (Object.keys(res.attrs).length > 0) {
      const text = this.parseTextUntil('<');
      if (!atClosing()) throw this.error("Extra text at the end of old-style tag with explicit 'text' attribute");
      if (text.children.length === 1 && text.children[0]!.tag === 'text') res.attrs.text = text.children[0]!.attrs.text ?? '';
      else res.children.push(...text.children);
      this.checkClosingTag(tagName);
      return res;
    }
    for (;;) {
      const text = this.parseTextUntil('<');
      if (this.atEnd || this.pos + 1 >= this.text.length) throw this.error(`Missing closing tag for ${tagName}`);
      res.children.push(...text.children);
      if (this.at(1) === '/') {
        this.checkClosingTag(tagName);
        break;
      }
      res.children.push(this.parseTag());
    }
    if (res.children.length === 1 && res.children[0]!.tag === 'text' && Object.keys(res.attrs).length === 0) {
      return node('', { ...res.children[0]!.attrs });
    }
    return res;
  }

  /** A tag, `pos` on its `<`. */
  parseTag(): MarkupNode {
    this.pos++; // '<'
    const tagName = this.parseName();
    if (!tagName) throw this.error('missing tag name');
    let autoClosed = false;
    const elem = node(tagName);
    for (; !this.atEnd && this.cur() !== '>'; this.pos++) {
      if (isSpace(this.cur())) continue;
      if (this.cur() === '/' && this.at(1) === '>') {
        autoClosed = true;
      } else if (isNameChar(this.cur())) {
        const [key, value] = this.parseAttribute(false);
        if (this.atEnd) throw this.error('unexpected end of stream following attribute');
        elem.attrs[key] = value;
      }
    }
    if (autoClosed) {
      this.pos++; // '>'
    } else {
      const contents = this.parseTagContents(tagName, Object.keys(elem.attrs).length === 0);
      const keys = Object.keys(contents.attrs);
      if (contents.children.length === 0 && keys.length === 1 && keys[0] === 'text') {
        elem.attrs.text = contents.attrs.text!;
      } else {
        Object.assign(elem.attrs, contents.attrs);
        elem.children.push(...contents.children);
      }
    }
    return elem;
  }

  parseDocument(): MarkupNode {
    const res = node('');
    while (!this.atEnd) {
      if (this.cur() === '<') res.children.push(this.parseTag());
      else res.children.push(...this.parseTextUntil('<').children);
    }
    return res;
  }
}

function fromCodePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
}

/** "line N, character M", as upstream's `position_info`. */
function positionInfo(text: string, position: number): string {
  const before = text.slice(0, position);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n');
  return `line ${line}, character ${[...text.slice(lineStart < 0 ? 0 : lineStart, position)].length}`;
}

/** Parses help markup; throws `MarkupParseError` with upstream's message and position on malformed text. */
export function parseMarkup(text: string): MarkupNode {
  const parser = new Parser(text);
  try {
    return parser.parseDocument();
  } catch (e) {
    if (e instanceof MarkupParseError) throw new MarkupParseError(`${positionInfo(text, e.position)}: ${e.message}`, e.position);
    throw e;
  }
}

// The builders upstream's generators use (`markup::make_link`, `markup::img`, `markup::tag`...), so the ported
// generators read like the C++.

/** Escapes `<`, `>`, `&`, `'` and `"`, for text put inside markup (upstream `font::escape_text`). */
export function escapeText(text: string): string {
  return text.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' })[c]!);
}

export function makeLink(text: string, dst: string): string {
  return `<ref dst='${dst}'>${text}</ref>`;
}

export function img(src: string, align = 'left', floating = false): string {
  return `<img src='${src}' float='${floating}' align='${align}' />`;
}

/** `<name>data</name>`; nothing at all when the data is empty, as upstream. */
export function tag(name: string, ...data: (string | number)[]): string {
  const input = data.join('');
  return input ? `<${name}>${input}</${name}>` : '';
}

export function tagAttr(name: string, attrs: Readonly<Record<string, string | number>>, ...data: (string | number)[]): string {
  const input = data.join('');
  if (!input) return '';
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}='${v}'`)
    .join('');
  return `<${name}${a}>${input}</${name}>`;
}

export const bold = (...data: (string | number)[]): string => tag('b', ...data);
export const italic = (...data: (string | number)[]): string => tag('i', ...data);
export const spanColor = (color: string, ...data: (string | number)[]): string => tagAttr('span', { color }, ...data);
