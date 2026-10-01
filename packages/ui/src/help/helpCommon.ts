/**
 * What the help's modules share (Phase 24): the section/topic model and the id conventions of upstream's
 * `help_impl.hpp`, the translation helpers its generators use (`VGETTEXT`, `VNGETTEXT`; a plain `_` is the
 * `wesnoth-help` helper in the files ported from `help_topic_generators.cpp` and the `wesnoth` one in those from
 * `help_impl.cpp`, which has no textdomain of its own), and the `font::` characters they print.
 */
import { formatMessage } from '@wesnothweb2/engine';
import { locale } from '../i18n/locale.js';

/** A help page. `text` is markup (see `markup.ts`), generated on first read when it is a function. */
export interface Topic {
  title: string;
  id: string;
  text: string | (() => string);
}

export interface Section {
  title: string;
  id: string;
  topics: Topic[];
  sections: Section[];
}

export function newSection(id = '', title = ''): Section {
  return { id, title, topics: [], sections: [] };
}

/** A topic's markup, generating (and caching) it the first time. */
export function topicText(topic: Topic): string {
  if (typeof topic.text === 'function') topic.text = topic.text();
  return topic.text;
}

export const DEFAULT_SHOW_TOPIC = '..introduction';
export const UNKNOWN_UNIT_TOPIC = '.unknown_unit';
export const UNIT_PREFIX = 'unit_';
export const TERRAIN_PREFIX = 'terrain_';
export const RACE_PREFIX = 'race_';
export const FACTION_PREFIX = 'faction_';
export const ERA_PREFIX = 'era_';
export const VARIATION_PREFIX = 'variation_';
export const ABILITY_PREFIX = 'ability_';
export const WEAPONSPECIAL_PREFIX = 'weaponspecial_';

export const NBSP = '\u00a0';
export const BULLET = '\u2022';
export const EM_DASH = '\u2014';
export const FIGURE_DASH = '\u2012';
export const WEAPON_NUMBERS_SEP = '\u00d7';
/** Upstream's `font::unicode_minus` is a plain hyphen-minus. */
export const UNICODE_MINUS = '-';

export function hiddenSymbol(hidden = true): string {
  return hidden ? '.' : '';
}

export function isVisibleId(id: string): boolean {
  return id === '' || id[0] !== '.';
}

/** `is_valid_id`: ids the `[help]` config may not define itself. */
export function isValidId(id: string): boolean {
  if (id === 'toplevel' || id === 'hidden') return false;
  if (id.startsWith(UNIT_PREFIX) || id.slice(hiddenSymbol().length).startsWith(UNIT_PREFIX)) return false;
  if (id.startsWith(ABILITY_PREFIX) || id.startsWith(WEAPONSPECIAL_PREFIX)) return false;
  return true;
}

/**
 * `VGETTEXT` in `domain`: translate, then substitute `$name`. (`help_impl.cpp` has no textdomain of its own, so
 * its strings are `wesnoth`'s; `help.cpp`'s and `help_topic_generators.cpp`'s are `wesnoth-help`'s.)
 */
export function vgettext(domain: string, msgid: string, symbols: Readonly<Record<string, string | number>>): string {
  return formatMessage(locale.translate(domain, msgid), symbols);
}

/** `VNGETTEXT`: the plural form for `n`, then substitute `$name`. */
export function vngettext(singular: string, plural: string, n: number, symbols: Readonly<Record<string, string | number>>): string {
  return formatMessage(locale.translatePlural('wesnoth-help', singular, plural, n), symbols);
}

/** `translation::compare`: the current language's collation. */
export function compareText(a: string, b: string): number {
  return collator().compare(a, b);
}

let cachedCollator: { lang: string; collator: Intl.Collator } | null = null;
function collator(): Intl.Collator {
  const lang = locale.current.replace('_', '-');
  if (cachedCollator?.lang !== lang) {
    let c: Intl.Collator;
    try {
      c = new Intl.Collator(lang);
    } catch {
      c = new Intl.Collator('en');
    }
    cachedCollator = { lang, collator: c };
  }
  return cachedCollator.collator;
}

export const titleLess = (a: { title: string }, b: { title: string }): number => compareText(a.title, b.title);

/** A `std::set<std::string, string_less>`: sorted by collation, one entry per collation-equal string. */
export function stringSet(values: Iterable<string>): string[] {
  const sorted = [...values].sort(compareText);
  return sorted.filter((v, i) => i === 0 || compareText(sorted[i - 1]!, v) !== 0);
}

/** A `std::set<std::string>`: sorted by code unit, unique. */
export function byteSet(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `utils::quoted_split`, as the help's `sections=`/`topics=` lists use it. */
export function splitList(s: string): string[] {
  return s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}
