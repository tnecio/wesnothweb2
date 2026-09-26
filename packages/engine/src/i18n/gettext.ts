/**
 * Message lookup, ported from upstream's `src/gettext.cpp`.
 *
 * Pure and browser-safe: nothing here reads files or touches the DOM. A host
 * (the web UI, or a node test) loads catalogues and registers them; the
 * engine only looks strings up. With nothing registered every lookup returns
 * its English source text, which is exactly what upstream does for `en_US`.
 *
 * Catalogues hold only translated, non-fuzzy entries (the build script drops
 * the rest), keyed by the raw `msgid` including any `context^` prefix -- as
 * Wesnoth's own `.po` files do; none of them uses `msgctxt`.
 */

import { ENGLISH_PLURAL, parsePluralForms } from './plural.js';

export interface Catalogue {
  /** The `Plural-Forms` header value, when the language has one. */
  plural?: string;
  /** `msgid` -> `msgstr`, or the list of plural forms for a plural entry. */
  entries: Record<string, string | string[]>;
}

const catalogues = new Map<string, Catalogue>();
let generation = 1;

/**
 * Bumped whenever the set of catalogues changes. `TString` keys its cached
 * translation on this, as upstream's `t_string_base::str()` does with
 * `translation_timestamp`, so a language switch relocalizes lazily.
 */
export function translationGeneration(): number {
  return generation;
}

export function setCatalogue(domain: string, catalogue: Catalogue | undefined): void {
  if (catalogue) catalogues.set(domain, catalogue);
  else catalogues.delete(domain);
  generation++;
}

/** Replaces every catalogue at once (a language switch). */
export function setCatalogues(all: Iterable<[string, Catalogue]>): void {
  catalogues.clear();
  for (const [domain, cat] of all) catalogues.set(domain, cat);
  generation++;
}

export function clearCatalogues(): void {
  catalogues.clear();
  generation++;
}

export function hasCatalogue(domain: string): boolean {
  return catalogues.has(domain);
}

/** `dgettext`: the translation, or `msgid` itself when there is none. */
export function dgettext(domain: string, msgid: string): string {
  if (msgid === '') return '';
  const hit = catalogues.get(domain)?.entries[msgid];
  if (hit === undefined) return msgid;
  const str = typeof hit === 'string' ? hit : hit[0];
  return str === undefined || str === '' ? msgid : str;
}

/**
 * `dsgettext`: like `dgettext`, but an untranslated `context^text` string
 * yields just `text` (`translation::dsgettext`). This is what hides the
 * `female^` and `Fighter^` disambiguation prefixes in English.
 */
export function dsgettext(domain: string, msgid: string): string {
  const msgval = dgettext(domain, msgid);
  if (msgval === msgid) {
    const hat = msgid.lastIndexOf('^');
    return hat === -1 ? msgid : msgid.slice(hat + 1);
  }
  return msgval;
}

/** `dsngettext`: plural-aware lookup with the same `^` rule for the untranslated case. */
export function dsngettext(domain: string, singular: string, plural: string, n: number): string {
  const cat = catalogues.get(domain);
  const hit = cat?.entries[singular];
  if (Array.isArray(hit)) {
    const rule = parsePluralForms(cat?.plural);
    const str = hit[rule.index(n)];
    if (str !== undefined && str !== '') return str;
  }
  const original = ENGLISH_PLURAL.index(n) === 0 ? singular : plural;
  const hat = original.lastIndexOf('^');
  return hat === -1 ? original : original.slice(hat + 1);
}
