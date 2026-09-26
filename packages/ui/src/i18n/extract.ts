/**
 * Finds the translatable msgids a source file uses, for the audit test and the
 * `wesnothweb.pot` generator. It recognises the lookup helpers by name and
 * reads their string-literal arguments; a call whose msgid is not a plain
 * literal (a variable, a concatenation) is reported as `dynamic` and left for
 * the reviewer, because nothing can extract it.
 */

export interface MsgidUse {
  /** The helper called (`t`, `tw`, `tn`, `dsgettext`, ...). */
  fn: string;
  domain: string;
  msgid: string;
  plural?: string;
  line: number;
}

export interface DynamicUse {
  fn: string;
  line: number;
  text: string;
}

const DOMAIN_OF: Record<string, string> = {
  t: 'wesnoth-lib',
  tn: 'wesnoth-lib',
  tw: 'wesnoth',
  twn: 'wesnoth',
  th: 'wesnoth-help',
  tx: 'wesnothweb',
  txn: 'wesnothweb',
};
/** Helpers whose first argument is the domain. */
const EXPLICIT_DOMAIN = new Set(['td', 'dsgettext', 'dgettext', 'translatable']);
const PLURAL = new Set(['tn', 'twn', 'txn']);
const EXPLICIT_PLURAL = new Set(['dsngettext']);

const CALL = /(?<![\w.$])(t|tn|tw|twn|th|tx|txn|td|dsgettext|dgettext|dsngettext|translatable)\(/g;

interface Literal {
  value: string;
  end: number;
}

/** Reads one JS string literal at `pos` (after whitespace); undefined if it is not a plain literal. */
function readLiteral(src: string, pos: number): Literal | undefined {
  while (/\s/.test(src.charAt(pos))) pos++;
  const q = src.charAt(pos);
  if (q !== "'" && q !== '"' && q !== '`') return undefined;
  let out = '';
  let i = pos + 1;
  for (; i < src.length; i++) {
    const c = src.charAt(i);
    if (c === '\\') {
      const n = src.charAt(i + 1);
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      i++;
    } else if (c === q) {
      break;
    } else if (q === '`' && c === '$' && src.charAt(i + 1) === '{') {
      return undefined;
    } else {
      out += c;
    }
  }
  return { value: out, end: i + 1 };
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charAt(i) === '\n') line++;
  return line;
}

export function extractMsgids(src: string): { uses: MsgidUse[]; dynamic: DynamicUse[] } {
  const uses: MsgidUse[] = [];
  const dynamic: DynamicUse[] = [];
  CALL.lastIndex = 0;
  for (let m = CALL.exec(src); m; m = CALL.exec(src)) {
    const fn = m[1] as string;
    const line = lineOf(src, m.index);
    let pos = m.index + m[0].length;
    const args: string[] = [];
    const need = EXPLICIT_DOMAIN.has(fn) ? 2 : PLURAL.has(fn) ? 2 : EXPLICIT_PLURAL.has(fn) ? 3 : 1;
    let ok = true;
    for (let a = 0; a < need; a++) {
      const lit = readLiteral(src, pos);
      if (!lit) {
        ok = false;
        break;
      }
      args.push(lit.value);
      pos = lit.end;
      while (/\s/.test(src.charAt(pos))) pos++;
      // After the last literal the call must continue with `,` or `)`, not `+` or `?` (a concatenation).
      const next = src.charAt(pos);
      if (a < need - 1 ? next !== ',' : next !== ',' && next !== ')') {
        ok = false;
        break;
      }
      if (a < need - 1) pos++;
    }
    if (!ok) {
      dynamic.push({ fn, line, text: src.slice(m.index, m.index + 60).split('\n')[0] as string });
      continue;
    }
    if (EXPLICIT_DOMAIN.has(fn)) uses.push({ fn, domain: args[0] as string, msgid: args[1] as string, line });
    else if (EXPLICIT_PLURAL.has(fn)) uses.push({ fn, domain: args[0] as string, msgid: args[1] as string, plural: args[2] as string, line });
    else if (PLURAL.has(fn)) uses.push({ fn, domain: DOMAIN_OF[fn] as string, msgid: args[0] as string, plural: args[1] as string, line });
    else uses.push({ fn, domain: DOMAIN_OF[fn] as string, msgid: args[0] as string, line });
  }
  return { uses, dynamic };
}

/** The msgids of a `.pot`/`.po` file (header excluded), joined across continuation lines. */
export function readPotMsgids(text: string): Set<string> {
  const out = new Set<string>();
  const lines = text.split('\n');
  const unq = (s: string): string =>
    s.slice(1, -1).replace(/\\(n|t|"|\\)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^msgid\s+(".*")\s*$/.exec(line);
    if (!m) continue;
    let id = unq(m[1] as string);
    while (i + 1 < lines.length && (lines[i + 1] as string).startsWith('"')) {
      id += unq((lines[i + 1] as string).trim());
      i++;
    }
    if (id !== '') out.add(id);
  }
  return out;
}
