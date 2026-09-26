/**
 * Phase 20 audit: nothing the player reads may bypass the lookup.
 *
 *  1. Templates: every text node and every `title`/`aria-label`/`placeholder`/`alt`
 *     attribute in a `.svelte` file goes through a helper (`t`, `tw`, `th`, `tx`,
 *     `tn`, `ts`, ...), not bare English. Numbers, punctuation and symbols are fine.
 *  2. Script: object properties and assignments that are known to reach the screen
 *     (`label:`, `title:`, `message:` ...) do not hold a bare English literal.
 *  3. Every literal msgid handed to a helper exists in the `.pot` of the domain the
 *     helper reads, so a typo (or a msgid upstream reworded) fails here rather than
 *     silently staying English in every language. `wesnothweb` msgids are checked
 *     against the generated `apps/web/i18n/wesnothweb/wesnothweb.pot`.
 *
 * Add to `ALLOWED` (with a reason) only for text that is genuinely not language:
 * a unit, a product name, a hotkey glyph.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { extractMsgids, readPotMsgids } from './extract';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

/** text -> why it is allowed to stay literal */
const ALLOWED: Record<string, string> = {
  wesnothweb2: 'the product name',
};

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const svelteFiles = [...walk(path.join(repoRoot, 'packages/ui/src'), ['.svelte']), ...walk(path.join(repoRoot, 'apps/web/src'), ['.svelte'])];
/** The lookup machinery itself names its own parameters `msgid`; it is not a caller. */
const MACHINERY = ['packages/ui/src/i18n/locale.ts', 'packages/ui/src/i18n/extract.ts'];
const tsFiles = [...walk(path.join(repoRoot, 'packages/ui/src'), ['.ts']), ...walk(path.join(repoRoot, 'apps/web/src'), ['.ts'])].filter((f) => !MACHINERY.includes(path.relative(repoRoot, f)));
const rel = (f: string): string => path.relative(repoRoot, f);

const A11Y_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'aria-description', 'aria-roledescription']);
const HELPERS = '(?:t|tw|th|tx|tn|twn|td|ts|fmt)';

/** True when `text` reads as language: it has a letter, ignoring escapes and id-like tokens a translator cannot change. */
function hasLanguage(text: string): boolean {
  const plain = text.replace(/\\u\{[0-9A-Fa-f]+\}/g, '').replace(/\\./g, '');
  if (/^[a-z][a-z0-9_:.-]*$/.test(plain)) return false; // `neutral`, `victory`: identifiers, not words shown
  return /\p{L}/u.test(plain);
}

/** Removes every `helper( ... )` call (balanced parentheses), so only the code around it is left to inspect. */
function stripHelperCalls(code: string): string {
  const start = new RegExp(`(?<![\\w$.])${HELPERS}\\(`, 'g');
  let out = '';
  let last = 0;
  for (let m = start.exec(code); m; m = start.exec(code)) {
    if (m.index < last) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      const c = code.charAt(i);
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === "'" || c === '"' || c === '`') {
        for (i++; i < code.length && code.charAt(i) !== c; i++) if (code.charAt(i) === '\\') i++;
      }
    }
    out += code.slice(last, m.index);
    last = i;
    start.lastIndex = i;
  }
  return out + code.slice(last);
}

interface Finding {
  where: string;
  text: string;
}

function templateFindings(file: string): Finding[] {
  const src = fs.readFileSync(file, 'utf8');
  const ast = parse(src, { modern: true }) as unknown as { fragment: unknown };
  const out: Finding[] = [];
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as Record<string, unknown> & { type?: string; start?: number; end?: number };
    if (node.type === 'Text') {
      const data = String(node.data ?? '').trim();
      if (data && hasLanguage(data) && !ALLOWED[data]) out.push({ where: `${rel(file)}:${lineOf(src, node.start ?? 0)}`, text: data.replace(/\s+/g, ' ') });
      return;
    }
    if (node.type === 'Attribute') {
      if (!A11Y_ATTRS.has(String(node.name))) return;
      const values = Array.isArray(node.value) ? node.value : [node.value];
      for (const v of values as Array<Record<string, unknown> & { type?: string; start?: number; end?: number; data?: string }>) {
        if (!v) continue;
        if (v.type === 'Text') {
          if (hasLanguage(String(v.data)) && !ALLOWED[String(v.data)]) out.push({ where: `${rel(file)}:${lineOf(src, v.start ?? 0)}`, text: `${String(node.name)}="${v.data}"` });
        } else if (v.type === 'ExpressionTag') {
          const code = src.slice(v.start ?? 0, v.end ?? 0);
          const stripped = stripHelperCalls(code);
          const literal = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
          for (let m = literal.exec(stripped); m; m = literal.exec(stripped)) {
            if (hasLanguage(m[2] as string) && !ALLOWED[m[2] as string]) out.push({ where: `${rel(file)}:${lineOf(src, v.start ?? 0)}`, text: `${String(node.name)}=${code}` });
          }
        }
      }
      return;
    }
    if (node.type === 'ExpressionTag') {
      // `{cond ? 'Victory!' : 'Defeat'}` in text position: literals outside a helper call are bare English.
      const code = src.slice(node.start ?? 0, node.end ?? 0);
      const stripped = stripHelperCalls(code);
      const literal = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
      for (let m = literal.exec(stripped); m; m = literal.exec(stripped)) {
        if (hasLanguage(m[2] as string) && !ALLOWED[m[2] as string]) out.push({ where: `${rel(file)}:${lineOf(src, node.start ?? 0)}`, text: code });
      }
      return;
    }
    if (node.type === 'StyleDirective' || node.type === 'ClassDirective') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'parent' || k === 'metadata') continue;
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(ast.fragment);
  return out;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charAt(i) === '\n') line++;
  return line;
}

/** Properties and assignments that carry player-visible text. */
const VISIBLE_PROP = /\b(label|title|message|placeholder|tooltip|hint|description|caption|heading|statusMessage|errorMessage|errorText)\b\s*(?::|=(?!=))\s*(['"`])((?:(?!\2)[^\\\n]|\\.)*)\2/g;

function scriptFindings(file: string): Finding[] {
  let src = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.svelte')) {
    const scripts = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
    src = scripts.join('\n');
  }
  src = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: Finding[] = [];
  for (let m = VISIBLE_PROP.exec(src); m; m = VISIBLE_PROP.exec(src)) {
    const raw = m[3] as string;
    // A template literal's `${...}` parts are code (usually a helper call); only its own words count.
    const text = m[2] === '`' ? raw.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '') : raw;
    if (!hasLanguage(text) || ALLOWED[text]) continue;
    // Not language: an id/enum-like token (`kind: 'manual'`) has no space and is lower-case.
    if (/^[a-z][a-z0-9_:.-]*$/.test(text)) continue;
    out.push({ where: `${rel(file)}:${lineOf(src, m.index)}`, text: `${m[1]}: ${text}` });
  }
  VISIBLE_PROP.lastIndex = 0;
  return out;
}

describe('no bare English reaches the screen', () => {
  it('templates: text nodes and accessible names go through the lookup', () => {
    const findings = svelteFiles.flatMap(templateFindings);
    expect(findings.map((f) => `${f.where}  ${f.text}`)).toEqual([]);
  });

  it('script: label/title/message properties are not bare English literals', () => {
    const findings = [...svelteFiles, ...tsFiles].flatMap(scriptFindings);
    expect(findings.map((f) => `${f.where}  ${f.text}`)).toEqual([]);
  });
});

function findPoRoot(): string | undefined {
  const candidates = [process.env['WESNOTH_PO'], path.join(repoRoot, 'wesnoth/po'), path.join(os.homedir(), 'wesnothweb/wesnoth/po')].filter((c): c is string => !!c);
  return candidates.find((c) => fs.existsSync(path.join(c, 'wesnoth')));
}

describe('every literal msgid exists in its domain', () => {
  const poRoot = findPoRoot();
  const sources = [...svelteFiles, ...tsFiles].map((f) => ({ file: f, ...extractMsgids(fs.readFileSync(f, 'utf8')) }));
  const potCache = new Map<string, Set<string>>();
  const potFor = (domain: string): Set<string> | undefined => {
    if (potCache.has(domain)) return potCache.get(domain);
    const file = domain === 'wesnothweb' ? path.join(repoRoot, 'apps/web/i18n/wesnothweb/wesnothweb.pot') : path.join(poRoot ?? '', domain, `${domain}.pot`);
    const set = fs.existsSync(file) ? readPotMsgids(fs.readFileSync(file, 'utf8')) : undefined;
    if (set) potCache.set(domain, set);
    return set;
  };

  it.skipIf(!poRoot)('upstream domains: no msgid is missing from its .pot', () => {
    const missing: string[] = [];
    for (const s of sources) {
      for (const u of s.uses) {
        if (u.domain === 'wesnothweb') continue;
        const pot = potFor(u.domain);
        if (!pot) missing.push(`${rel(s.file)}:${u.line}  no .pot for domain ${u.domain}`);
        else if (!pot.has(u.msgid)) missing.push(`${rel(s.file)}:${u.line}  [${u.domain}] ${JSON.stringify(u.msgid)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('wesnothweb.pot lists exactly the port-only msgids the code uses', () => {
    const used = new Set<string>();
    for (const s of sources) for (const u of s.uses) if (u.domain === 'wesnothweb') used.add(u.msgid);
    const pot = potFor('wesnothweb') ?? new Set<string>();
    expect([...used].filter((m) => !pot.has(m)).sort(), 'missing from the .pot: run `node --import tsx apps/web/scripts/extract-wesnothweb-pot.mjs`').toEqual([]);
    expect([...pot].filter((m) => !used.has(m)).sort(), 'stale in the .pot: run `node --import tsx apps/web/scripts/extract-wesnothweb-pot.mjs`').toEqual([]);
  });

  it('nothing hands a helper a non-literal msgid without saying why (they cannot be extracted)', () => {
    const dynamic = sources.flatMap((s) => s.dynamic.map((d) => `${rel(s.file)}:${d.line}  ${d.text}`));
    expect(dynamic).toEqual([]);
  });
});
