/**
 * The subset of Pango markup Wesnoth's own text uses (`<i>`, `<b>`, `<small>`, `<span color=...>`, ...),
 * parsed to a tree of plain values. `Markup.svelte` renders it as DOM elements: the text is never handed
 * to `{@html}`, so nothing in it can become script or an unexpected element. Anything that is not a known
 * tag with a valid attribute (an unknown tag, a stray `<`, a mismatched close) is kept as literal text,
 * as Pango's own error path shows the string unformatted rather than dropping it.
 */

export interface PangoText {
  text: string;
}
export interface PangoElement {
  /** The (validated) CSS this markup means, and the tag it came from, for the renderer's element choice. */
  tag: string;
  style: Readonly<Record<string, string>>;
  children: PangoNode[];
}
export type PangoNode = PangoText | PangoElement;

const NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** `&lt;`, `&#65;`, `&#x41;` and friends; an unknown entity stays as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return codePoint(parseInt(body.slice(2), 16)) ?? whole;
    if (body.startsWith('#')) return codePoint(parseInt(body.slice(1), 10)) ?? whole;
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function codePoint(n: number): string | undefined {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : undefined;
}

const SIZE_WORDS: Readonly<Record<string, string>> = {
  'xx-small': '0.58em',
  'x-small': '0.69em',
  small: '0.83em',
  medium: '1em',
  large: '1.2em',
  'x-large': '1.44em',
  'xx-large': '1.73em',
  smaller: '0.83em',
  larger: '1.2em',
};

/** A `<span>` attribute as CSS, or undefined if the value is not one this renderer accepts. */
function spanStyle(name: string, value: string): [string, string] | undefined {
  const v = value.trim();
  switch (name) {
    case 'color':
    case 'foreground':
    case 'fgcolor':
      return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/.test(v) ? ['color', v] : undefined;
    case 'bgcolor':
    case 'background':
      return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/.test(v) ? ['background-color', v] : undefined;
    case 'size':
    case 'font_size': {
      if (SIZE_WORDS[v]) return ['font-size', SIZE_WORDS[v]];
      if (/^\d+(\.\d+)?%$/.test(v)) return ['font-size', v];
      // Pango: a bare number is 1/1024 pt; "12pt" is points.
      if (/^\d+$/.test(v)) return ['font-size', `${(Number(v) / 1024 / 12).toFixed(3)}em`];
      if (/^\d+(\.\d+)?pt$/.test(v)) return ['font-size', `${(parseFloat(v) / 12).toFixed(3)}em`];
      return undefined;
    }
    case 'weight':
    case 'font_weight':
      return /^(normal|bold|bolder|lighter|[1-9]00)$/.test(v) ? ['font-weight', v] : v === 'ultrabold' || v === 'heavy' ? ['font-weight', '800'] : undefined;
    case 'style':
    case 'font_style':
      return v === 'italic' || v === 'oblique' ? ['font-style', 'italic'] : v === 'normal' ? ['font-style', 'normal'] : undefined;
    case 'underline':
      return v === 'none' ? ['text-decoration', 'none'] : v === 'single' || v === 'double' || v === 'low' ? ['text-decoration', 'underline'] : undefined;
    case 'strikethrough':
      return v === 'true' ? ['text-decoration', 'line-through'] : undefined;
    case 'font_family':
    case 'face':
    case 'font':
      return /^[A-Za-z0-9 _-]{1,40}$/.test(v) ? ['font-family', `"${v}", var(--font-ui)`] : undefined;
    default:
      return undefined;
  }
}

/** The fixed tags: what each means in CSS. */
const TAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  b: { 'font-weight': 'bold' },
  i: { 'font-style': 'italic' },
  u: { 'text-decoration': 'underline' },
  s: { 'text-decoration': 'line-through' },
  big: { 'font-size': '1.2em' },
  small: { 'font-size': '0.83em' },
  sub: { 'vertical-align': 'sub', 'font-size': '0.83em' },
  sup: { 'vertical-align': 'super', 'font-size': '0.83em' },
  tt: { 'font-family': 'monospace' },
  span: {},
};

/**
 * A `rich_label`'s help markup (`rich_label::get_parsed_text`) on top of Pango's: `<ref dst=...>` is a link,
 * drawn in the label's link colour (`font::YELLOW_COLOR` by default) and showing `dst` when it has no text;
 * `<bold>`/`<italic>` and `<header>` (`<h>`) format as upstream does.
 */
const HELP_TAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ref: { color: '#ffff00' },
  bold: { 'font-weight': 'bold' },
  italic: { 'font-style': 'italic' },
  header: { 'font-weight': '900', color: 'white', 'font-size': '1.2em' },
  h: { 'font-weight': '900', color: 'white', 'font-size': '1.2em' },
};

interface OpenElement {
  name: string;
  raw: string;
  node: PangoElement;
  /** A `<ref>`'s destination. */
  dst?: string;
}

/** Parses `text`; `help` adds a rich label's help markup (`HELP_TAGS`). Never throws. */
export function parsePango(text: string, help = false): PangoNode[] {
  const tags = help ? { ...TAGS, ...HELP_TAGS } : TAGS;
  const root: PangoNode[] = [];
  const stack: OpenElement[] = [];
  const out = (): PangoNode[] => (stack.length > 0 ? stack[stack.length - 1]!.node.children : root);
  const pushText = (s: string): void => {
    if (s === '') return;
    const list = out();
    const last = list[list.length - 1];
    if (last && 'text' in last) last.text += s;
    else list.push({ text: s });
  };

  const tagRe = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z_]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>/y;
  let i = 0;
  let literalStart = 0;
  while (i < text.length) {
    if (text[i] !== '<') {
      i++;
      continue;
    }
    tagRe.lastIndex = i;
    const m = tagRe.exec(text);
    const name = m?.[2]!.toLowerCase();
    if (!m || !name || !(name in tags)) {
      i++; // a stray `<` or an unknown tag is literal text
      continue;
    }
    pushText(decodeEntities(text.slice(literalStart, i)));
    if (m[1] === '/') {
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at < 0) pushText(m[0]); // a close with no open
      else {
        // A link with no text shows its destination.
        const closing = stack[at]!;
        if (closing.name === 'ref' && closing.node.children.length === 0) closing.node.children.push({ text: closing.dst ?? '' });
        // Close it, and anything left open inside it, as Pango's recovery does.
        stack.length = at;
      }
    } else {
      const style: Record<string, string> = { ...tags[name] };
      if (name === 'span') {
        for (const a of m[3]!.matchAll(/([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          const css = spanStyle(a[1]!.toLowerCase(), decodeEntities(a[2] ?? a[3] ?? ''));
          if (css) style[css[0]] = css[1];
        }
      }
      const node: PangoElement = { tag: name, style, children: [] };
      out().push(node);
      const dst = name === 'ref' ? /\bdst\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(m[3]!) : null;
      stack.push({ name, raw: m[0], node, ...(dst ? { dst: decodeEntities(dst[1] ?? dst[2] ?? '') } : {}) });
    }
    i = literalStart = m.index + m[0].length;
  }
  pushText(decodeEntities(text.slice(literalStart)));
  return root;
}

/** The text with all markup removed (for a tooltip or an accessible name). */
export function stripPango(text: string): string {
  const flat = (nodes: readonly PangoNode[]): string => nodes.map((n) => ('text' in n ? n.text : flat(n.children))).join('');
  return flat(parsePango(text));
}
