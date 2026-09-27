/**
 * Phase 20 milestone 4: the same Dead Water 1 strings, read from the real game and from us.
 *
 *   node apps/web/scripts/i18n-real-binary-check.mjs [--lang pl] [--locale pl_PL]
 *
 * The installed Wesnoth (1.16.9 here) ships its own compiled catalogues
 * (`/usr/share/games/wesnoth/1.16/locale/<lang>/LC_MESSAGES/<domain>.mo`), the very files the real binary
 * runs `wesnoth --language pl_PL` from. This reads them with Python's gettext and compares them, msgid
 * by msgid, with what we ship (built from the 1.19 `.po`), for every translatable string Dead Water 1
 * uses in its scenario and story: dialogue, objectives, unit and terrain names, attack names.
 *
 * The two are different releases, so this is not expected to be identical: a string reworded between
 * 1.16 and 1.19 is missing on one side. What must hold is that where BOTH have a translation it is the
 * same (a disagreement would mean we look up the wrong domain or context), and that the strings
 * both have make up nearly everything. Exits non-zero if more than 3 % of the both-translated strings differ.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const lang = arg('lang', 'pl');
const locale = arg('locale', 'pl_PL');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const realRoot = `/usr/share/games/wesnoth/1.16/locale/${lang}/LC_MESSAGES`;
if (!fs.existsSync(realRoot)) {
  console.log(`skip: no installed Wesnoth catalogue at ${realRoot}`);
  process.exit(0);
}

/** Every `[domain, msgid]` in the scenario and its story. */
function collect(node, out) {
  if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === 'object') {
    if (Array.isArray(node.t) && Object.keys(node).length === 1) {
      for (const p of node.t) if (Array.isArray(p)) out.set(`${p[0]}\u0000${p[1]}`, p);
    } else for (const v of Object.values(node)) collect(v, out);
  }
}
const used = new Map();
for (const file of ['scenarios/01_Invasion.json', 'story/01_Invasion.json']) {
  collect(JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public', file), 'utf8')), used);
}

const domains = [...new Set([...used.values()].map((p) => p[0]))];
const py = `
import gettext, json, sys
out = {}
for d in json.loads(sys.argv[2]):
    try:
        with open(sys.argv[1] + '/' + d + '.mo', 'rb') as f:
            t = gettext.GNUTranslations(f)
        out[d] = {k if isinstance(k, str) else k[0]: v for k, v in t._catalog.items() if isinstance(k, str)}
    except FileNotFoundError:
        out[d] = {}
print(json.dumps(out))
`;
const real = JSON.parse(execFileSync('python3', ['-c', py, realRoot, JSON.stringify(domains)], { encoding: 'utf8', maxBuffer: 1 << 28 }));

const ours = {};
for (const d of domains) {
  const f = path.join(repoRoot, 'apps/web/public/i18n', locale, `${d}.json`);
  ours[d] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).entries : {};
}
const str = (v) => (Array.isArray(v) ? v[0] : v);

const tally = { same: 0, differ: 0, oursOnly: 0, realOnly: 0, neither: 0 };
const differ = [];
for (const [domain, msgid] of used.values()) {
  const a = str(ours[domain][msgid]);
  const b = str(real[domain]?.[msgid]);
  if (a && b) {
    if (a === b) tally.same++;
    else {
      tally.differ++;
      differ.push({ domain, msgid: msgid.slice(0, 60), ours: a.slice(0, 60), real: b.slice(0, 60) });
    }
  } else if (a) tally.oursOnly++;
  else if (b) tally.realOnly++;
  else tally.neither++;
}
const both = tally.same + tally.differ;
console.log(`${used.size} distinct translatable strings in Dead Water 1 (${domains.join(', ')})`);
console.log(`  same in the real 1.16.9 catalogue and ours : ${tally.same}`);
console.log(`  translated in both, different              : ${tally.differ}`);
console.log(`  ours only (added or reworded since 1.16)   : ${tally.oursOnly}`);
console.log(`  real only (removed or reworded since)      : ${tally.realOnly}`);
console.log(`  untranslated in both                       : ${tally.neither}`);
for (const d of differ.slice(0, 8)) console.log(`   differ [${d.domain}] ${JSON.stringify(d.msgid)}: ours ${JSON.stringify(d.ours)} / real ${JSON.stringify(d.real)}`);
const ratio = both === 0 ? 1 : tally.differ / both;
console.log(`agreement where both translate: ${((1 - ratio) * 100).toFixed(1)}%`);
if (ratio > 0.03) {
  console.error('FAIL: more than 3% of the strings both catalogues translate disagree');
  process.exitCode = 1;
}
