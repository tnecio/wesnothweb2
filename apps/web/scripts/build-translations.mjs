#!/usr/bin/env node
/**
 * Phase 20 Stage 2: turns upstream's gettext catalogues into the per-language,
 * per-domain JSON the browser fetches, plus `languages.json`.
 *
 *   apps/web/public/i18n/languages.json
 *   apps/web/public/i18n/<locale>/<domain>.json    e.g. pl_PL/wesnoth-lib.json
 *
 * A catalogue file is `{ "plural": "<Plural-Forms>", "entries": { msgid: msgstr | [forms] } }`
 * and holds only translated, non-fuzzy entries whose text differs from the
 * source (an untranslated string is simply absent, so the runtime falls back to
 * English, exactly as upstream's gettext does). Wesnoth's catalogues carry
 * `context^text` in the msgid itself; none uses `msgctxt`.
 *
 * Languages come from upstream's `data/languages/<locale>.cfg` (`name`,
 * `sort_name`, `alternates`, `dir=rtl`, `percent`). The shipped set is the one
 * list below: upstream's own >= 80% languages plus Polish, decided for Phase 20.
 * Adding a language is one line here (plus a re-run).
 *
 * Domains: the core ones, one per shipped campaign, and our own `wesnothweb`
 * (port-only UI strings, `apps/web/i18n/`; English-only until translated).
 *
 * Run: node apps/web/scripts/build-translations.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPo } from './lib/po.mjs';
import { findPoRoot } from './lib/poRoot.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outRoot = path.join(repoRoot, 'apps/web/public/i18n');
const languagesDir = path.join(repoRoot, 'wesnoth/data/languages');
const ownPoRoot = path.join(repoRoot, 'apps/web/i18n');

/** Upstream languages at >= 80% (`data/languages/*.cfg`), plus Polish by request. en_US is the source language. */
export const SHIPPED_LOCALES = ['en_US', 'it_IT', 'es_ES', 'en_GB', 'gl_ES', 'cs_CZ', 'ar_AR', 'hu_HU', 'fi_FI', 'pl_PL'];

const CORE_DOMAINS = ['wesnoth', 'wesnoth-lib', 'wesnoth-units', 'wesnoth-help'];
/**
 * Every shipped campaign's own domain (the `#textdomain` its `_main.cfg` opens with, from `campaigns.json`), and
 * `wesnoth-sotbe`, which core content also uses. A fixed list here had left out The South Guard's.
 */
const CAMPAIGN_DOMAINS = [
  ...new Set([
    ...JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8'))
      .campaigns.filter((c) => c.wesnothId)
      .map((c) => /^#textdomain\s+(\S+)/m.exec(fs.readFileSync(path.join(repoRoot, 'wesnoth/data/campaigns', c.wesnothId, '_main.cfg'), 'utf8'))?.[1])
      .filter(Boolean),
    'wesnoth-sotbe',
  ]),
];
const OWN_DOMAINS = ['wesnothweb'];
const DOMAINS = [...CORE_DOMAINS, ...CAMPAIGN_DOMAINS, ...OWN_DOMAINS];

function parseLocaleCfg(file) {
  const text = fs.readFileSync(file, 'utf8');
  const get = (k) => {
    const m = new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\n#]*?)"?\\s*(?:#.*)?$`, 'm').exec(text);
    return m ? m[1].trim() : undefined;
  };
  return {
    name: get('name'),
    sortName: get('sort_name'),
    locale: get('locale'),
    alternates: (get('alternates') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    rtl: get('dir') === 'rtl',
    percent: Number(get('percent') ?? 0),
  };
}

function poFile(domain, locale) {
  const root = domain === 'wesnothweb' ? ownPoRoot : findPoRoot();
  const short = locale.split('_')[0];
  for (const name of [`${locale}.po`, `${short}.po`]) {
    const f = path.join(root, domain, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function catalogueFrom(po) {
  const entries = {};
  let n = 0;
  for (const e of po.entries) {
    if (e.fuzzy) continue;
    const key = e.msgctxt === undefined ? e.msgid : `${e.msgctxt}\u0004${e.msgid}`;
    if (e.msgidPlural !== undefined) {
      if (e.msgstr.length === 0 || e.msgstr.some((s) => !s)) continue;
      entries[key] = e.msgstr;
    } else {
      const str = e.msgstr[0];
      if (!str || str === e.msgid) continue;
      entries[key] = str;
    }
    n++;
  }
  return { catalogue: { plural: po.header['Plural-Forms'] ?? '', entries }, count: n };
}

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

const languages = [];
let totalBytes = 0;
for (const locale of SHIPPED_LOCALES) {
  const cfg = parseLocaleCfg(path.join(languagesDir, `${locale}.cfg`));
  const domains = [];
  if (locale !== 'en_US') {
    for (const domain of DOMAINS) {
      const file = poFile(domain, locale);
      if (!file) continue;
      const { catalogue, count } = catalogueFrom(readPo(file));
      if (count === 0) continue;
      const out = path.join(outRoot, locale, `${domain}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const json = JSON.stringify(catalogue);
      fs.writeFileSync(out, json);
      totalBytes += Buffer.byteLength(json);
      domains.push(domain);
    }
  }
  // `wesnoth-lib`'s `language code for localized resources^en_US`: which `l10n/<code>/` art dirs this
  // language reads, in priority order (`get_localized_path`). Empty for English (the source art).
  let resourceLanguages = [];
  if (locale !== 'en_US') {
    const file = poFile('wesnoth-lib', locale);
    const entry = file ? readPo(file).entries.find((e) => e.msgid === 'language code for localized resources^en_US' && !e.fuzzy) : undefined;
    resourceLanguages = (entry?.msgstr[0] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  }
  languages.push({
    code: cfg.locale,
    name: cfg.name,
    ...(cfg.sortName ? { sortName: cfg.sortName } : {}),
    alternates: cfg.alternates,
    rtl: cfg.rtl,
    percent: cfg.percent,
    resourceLanguages,
    domains,
  });
}

languages.sort((a, b) => (a.sortName ?? a.name).localeCompare(b.sortName ?? b.name, 'en'));
fs.writeFileSync(path.join(outRoot, 'languages.json'), JSON.stringify({ languages }, null, 1) + '\n');

console.log(`${languages.length} languages, ${(totalBytes / 1024 / 1024).toFixed(1)} MB of catalogues`);
for (const l of languages) console.log(`  ${l.code.padEnd(6)} ${String(l.percent).padStart(3)}%  ${l.rtl ? 'rtl ' : '    '}${l.name}  [${l.domains.length} domains]`);
