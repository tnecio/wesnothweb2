#!/usr/bin/env node
/**
 * Phase 20 Stage 1 check: every translatable string that survived into the
 * shipped JSON (`public/scenarios`, `public/story`) names a `{domain, msgid}`
 * that exists in that domain's upstream `.pot`.
 *
 * This is what proves the preprocessor's textdomain scoping: a macro expanded
 * under the wrong domain produces a msgid that is not in the domain's
 * catalogue, and the translation would silently never apply. The target is
 * zero misses; anything reported is either a scoping bug or a string
 * upstream itself never extracted.
 *
 * Known gaps live in `i18n-known-gaps.json` (`--write-known-gaps` regenerates it
 * from the current run; review the diff, don't rubber-stamp it). Two kinds:
 *  - upstream never extracted them: the Rogue Mage / Shadow Mage line lives in
 *    `data/internal/` and no `.pot` carries its strings, so upstream's own
 *    game shows them in English in every language;
 *  - our synthetic debug scenarios' own English text (not Wesnoth content).
 * Anything NOT in that file fails the run.
 *
 * Run: node apps/web/scripts/i18n-coverage.mjs [--verbose] [--write-known-gaps]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPo } from './lib/po.mjs';
import { findPoRoot } from './lib/poRoot.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const poRoot = findPoRoot();
const verbose = process.argv.includes('--verbose');
const gapsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n-known-gaps.json');
const knownGaps = new Set(fs.existsSync(gapsFile) ? JSON.parse(fs.readFileSync(gapsFile, 'utf8')).map((g) => `${g.domain}\0${g.msgid}`) : []);

const catalogueCache = new Map();
function potMsgids(domain) {
  if (!catalogueCache.has(domain)) {
    const file = path.join(poRoot, domain, `${domain}.pot`);
    catalogueCache.set(domain, fs.existsSync(file) ? new Set(readPo(file).entries.map((e) => e.msgid)) : null);
  }
  return catalogueCache.get(domain);
}

const seen = new Map(); // "domain\0msgid" -> { count, where: Set }
let total = 0;

function visit(node, where) {
  if (Array.isArray(node)) {
    for (const n of node) visit(n, where);
    return;
  }
  if (node && typeof node === 'object') {
    if (Array.isArray(node.t) && Object.keys(node).length === 1) {
      for (const part of node.t) {
        if (Array.isArray(part)) {
          total++;
          const key = `${part[0]}\0${part[1]}`;
          const e = seen.get(key) ?? { count: 0, where: new Set() };
          e.count++;
          e.where.add(where);
          seen.set(key, e);
        }
      }
      return;
    }
    for (const v of Object.values(node)) visit(v, where);
  }
}

for (const dir of ['scenarios', 'story']) {
  const full = path.join(repoRoot, 'apps/web/public', dir);
  for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.json')).sort()) {
    visit(JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')), `${dir}/${f}`);
  }
}

const byDomain = new Map();
const misses = [];
for (const [key, e] of seen) {
  const [domain, msgid] = key.split('\0');
  const pot = potMsgids(domain);
  const d = byDomain.get(domain) ?? { distinct: 0, missing: 0, occurrences: 0 };
  d.distinct++;
  d.occurrences += e.count;
  if (pot === null || !pot.has(msgid)) {
    d.missing++;
    misses.push({ domain, msgid, pot: pot !== null, where: [...e.where].slice(0, 3) });
  }
  byDomain.set(domain, d);
}

if (process.argv.includes('--write-known-gaps')) {
  const gaps = misses
    .map((m) => ({ domain: m.domain, msgid: m.msgid }))
    .sort((x, y) => (x.domain + x.msgid < y.domain + y.msgid ? -1 : 1));
  fs.writeFileSync(gapsFile, JSON.stringify(gaps, null, 2) + '\n');
  console.log(`wrote ${gaps.length} known gaps to ${path.relative(repoRoot, gapsFile)}`);
  process.exit(0);
}

const unexpected = misses.filter((m) => !knownGaps.has(`${m.domain}\0${m.msgid}`));

console.log(`${total} translatable parts, ${seen.size} distinct (domain, msgid) pairs`);
for (const [domain, d] of [...byDomain].sort((a, b) => b[1].occurrences - a[1].occurrences)) {
  console.log(`  ${domain.padEnd(28)} ${String(d.distinct).padStart(6)} distinct  ${String(d.missing).padStart(5)} missing from .pot`);
}
console.log(`\n${misses.length - unexpected.length} known gaps (upstream's own, or our synthetic scenarios), ${unexpected.length} unexpected`);
if (unexpected.length) {
  for (const m of unexpected.slice(0, verbose ? Infinity : 40)) {
    console.log(`  [${m.domain}${m.pot ? '' : ' (no .pot)'}] ${JSON.stringify(m.msgid).slice(0, 100)}  <- ${m.where.join(', ')}`);
  }
  process.exit(1);
}
console.log('OK: every translatable string is in its domain catalogue.');
