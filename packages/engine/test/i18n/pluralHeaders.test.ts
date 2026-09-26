import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePluralForms } from '../../src/i18n/plural';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The `Plural-Forms` value of each `.po`'s header entry, which upstream wraps over several quoted lines. */
function headersFromPo(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.po'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === 'msgstr ""');
    if (start < 0) continue;
    let header = '';
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith('"'); i++) {
      header += lines[i]!.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    const m = /^Plural-Forms:\s*(.*)$/m.exec(header);
    // A few catalogues have none, and one still carries gettext's unfilled template.
    if (m && /nplurals\s*=\s*\d/.test(m[1]!)) out.set(f.replace(/\.po$/, ''), m[1]!.trim());
  }
  return out;
}

function checkRule(header: string): void {
  const nplurals = Number(/nplurals\s*=\s*(\d+)/.exec(header)![1]);
  const rule = parsePluralForms(header);
  expect(rule.nplurals).toBe(nplurals);
  const seen = new Set<number>();
  for (let n = 0; n <= 1000; n++) {
    const i = rule.index(n);
    expect(Number.isInteger(i) && i >= 0 && i < nplurals, `${header} n=${n} -> ${i}`).toBe(true);
    seen.add(i);
  }
  // (Not every declared form need be reachable: one upstream header declares 3 forms and only ever picks 2.)
  expect(seen.size, header).toBeGreaterThan(0);
}

describe('Plural-Forms headers of the shipped catalogues', () => {
  const shipped = path.join(repoRoot, 'apps/web/public/i18n');
  const headers = new Set<string>();
  if (fs.existsSync(shipped)) {
    for (const lang of fs.readdirSync(shipped).filter((n) => fs.statSync(path.join(shipped, n)).isDirectory())) {
      for (const f of fs.readdirSync(path.join(shipped, lang))) {
        const plural = JSON.parse(fs.readFileSync(path.join(shipped, lang, f), 'utf8')).plural as string;
        if (plural) headers.add(plural);
      }
    }
  }

  it.skipIf(headers.size === 0)('every distinct header evaluates to a valid form index', () => {
    for (const h of headers) checkRule(h);
  });
});

describe('Plural-Forms headers of every upstream language', () => {
  const candidates = [(process as unknown as { env: Record<string, string | undefined> }).env['WESNOTH_PO'], path.join(repoRoot, 'wesnoth/po'), path.join(os.homedir(), 'wesnothweb/wesnoth/po')].filter(
    (x): x is string => !!x,
  );
  const poDir = candidates.map((c) => path.join(c, 'wesnoth')).find((d) => fs.existsSync(d));

  it.skipIf(!poDir)('all 60 evaluate to a valid form index', () => {
    const headers = headersFromPo(poDir!);
    expect(headers.size).toBeGreaterThan(50); // 60 languages, minus the few catalogues with no usable header
    for (const [, h] of headers) checkRule(h);
  });
});
