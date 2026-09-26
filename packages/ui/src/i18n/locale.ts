/**
 * The current language, its catalogues, and reactive lookup for the UI.
 *
 * The engine owns lookup (`@wesnothweb2/engine`'s `i18n/`); this module owns
 * everything that needs a browser: fetching catalogues, remembering the
 * choice, and telling Svelte to re-render when the language changes. It is
 * plain TypeScript (no runes) so it runs under node in tests; reactivity comes
 * from `createSubscriber`, which is a no-op outside an effect.
 *
 * Catalogues are fetched per language x domain, and only for the domains in
 * use: the core ones always, a scenario's own as it loads. English fetches
 * nothing. A missing entry falls back to English, as upstream's gettext does.
 */

import { createSubscriber } from 'svelte/reactivity';
import {
  dsgettext,
  dsngettext,
  setCatalogues,
  type Catalogue,
  type TString,
} from '@wesnothweb2/engine';

export interface LanguageInfo {
  /** Locale code as upstream writes it, e.g. `pl_PL`. */
  code: string;
  /** The language's own name, e.g. `Polski`. */
  name: string;
  sortName?: string;
  /** Other locale codes that should pick this language (`es_MX` for `es_ES`). */
  alternates: string[];
  rtl: boolean;
  percent: number;
  /** Domains that have a catalogue file for this language. */
  domains: string[];
}

export const SOURCE_LANGUAGE = 'en_US';
/** Domains the game chrome and unit/terrain text always need. */
export const CORE_DOMAINS = ['wesnoth', 'wesnoth-lib', 'wesnoth-units', 'wesnothweb'] as const;

const STORAGE_KEY = 'wesnothweb2.language';

export interface LocaleHost {
  fetchJson(url: string): Promise<unknown>;
  /** Saved choice and the browser's preferences; both optional (node tests, private windows). */
  loadChoice(): string | null;
  saveChoice(code: string): void;
  preferredLanguages(): readonly string[];
  /** Called with the BCP 47 tag and text direction whenever the language changes. */
  applyDocument(lang: string, dir: 'ltr' | 'rtl'): void;
}

function browserHost(baseUrl: string): LocaleHost {
  return {
    fetchJson: async (url) => {
      const res = await fetch(`${baseUrl}${url}`);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.json();
    },
    loadChoice: () => {
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    },
    saveChoice: (code) => {
      try {
        localStorage.setItem(STORAGE_KEY, code);
      } catch {
        /* private window: the choice just is not remembered */
      }
    },
    preferredLanguages: () => (typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])),
    applyDocument: (lang, dir) => {
      if (typeof document === 'undefined') return;
      document.documentElement.lang = lang;
      document.documentElement.dir = dir;
    },
  };
}

/**
 * Picks the shipped language that best matches the browser's preferences, the
 * way upstream matches the system locale: an exact `locale`, then an
 * `alternates` entry, then any locale of the same language (`pl` -> `pl_PL`).
 * Falls back to English.
 */
export function detectLanguage(preferred: readonly string[], languages: readonly LanguageInfo[]): string {
  for (const raw of preferred) {
    const want = raw.replace('-', '_');
    const lang = want.split('_')[0]!.toLowerCase();
    const exact = languages.find((l) => l.code.toLowerCase() === want.toLowerCase());
    if (exact) return exact.code;
    const alt = languages.find((l) => l.alternates.some((a) => a.toLowerCase() === want.toLowerCase()));
    if (alt) return alt.code;
    const sameLanguage = languages.find((l) => l.code.split('_')[0]!.toLowerCase() === lang);
    if (sameLanguage) return sameLanguage.code;
  }
  return SOURCE_LANGUAGE;
}

/** BCP 47 form of an upstream locale code (`pl_PL` -> `pl-PL`). */
export function languageTag(code: string): string {
  return code.replace('_', '-').replace(/@.*/, '');
}

export class LocaleManager {
  private languageList: LanguageInfo[] = [];
  private currentCode = SOURCE_LANGUAGE;
  private wanted = new Set<string>(CORE_DOMAINS);
  private readonly cache = new Map<string, Promise<Catalogue | null>>();
  private readonly listeners = new Set<() => void>();
  private readonly subscribe = createSubscriber((update) => {
    this.listeners.add(update);
    return () => this.listeners.delete(update);
  });
  /** Serialises switches so a fast double click cannot leave the catalogues of the first language installed. */
  private switching: Promise<void> = Promise.resolve();

  constructor(private host: LocaleHost) {}

  setHost(host: LocaleHost): void {
    this.host = host;
  }

  get languages(): readonly LanguageInfo[] {
    this.subscribe();
    return this.languageList;
  }

  /** The current language code. Reactive. */
  get current(): string {
    this.subscribe();
    return this.currentCode;
  }

  get currentInfo(): LanguageInfo | undefined {
    return this.languages.find((l) => l.code === this.current);
  }

  get rtl(): boolean {
    return this.currentInfo?.rtl ?? false;
  }

  /** Loads the language list, then the saved (else detected) language. Never throws: English is the fallback. */
  async init(): Promise<void> {
    try {
      const data = (await this.host.fetchJson('languages.json')) as { languages: LanguageInfo[] };
      this.languageList = data.languages;
    } catch {
      this.languageList = [];
    }
    const saved = this.host.loadChoice();
    const code =
      saved && this.languageList.some((l) => l.code === saved)
        ? saved
        : detectLanguage(this.host.preferredLanguages(), this.languageList);
    await this.setLanguage(code, { remember: false });
  }

  /** Switches language. Resolves once its catalogues are installed and the UI has been told. */
  setLanguage(code: string, opts: { remember?: boolean } = {}): Promise<void> {
    const run = async (): Promise<void> => {
      const info = this.languageList.find((l) => l.code === code);
      const target = info ? code : SOURCE_LANGUAGE;
      const loaded = await this.loadDomains(target, [...this.wanted]);
      setCatalogues(loaded);
      this.currentCode = target;
      const active = this.languageList.find((l) => l.code === target);
      this.host.applyDocument(languageTag(target), active?.rtl ? 'rtl' : 'ltr');
      if (opts.remember !== false) this.host.saveChoice(target);
      this.notify();
    };
    this.switching = this.switching.then(run, run);
    return this.switching;
  }

  /**
   * Makes sure `domains` are loaded for the current language (a scenario's own
   * domains, as it opens). Domains the language has no catalogue for stay English.
   */
  async useDomains(domains: readonly string[]): Promise<void> {
    const fresh = domains.filter((d) => !this.wanted.has(d));
    if (fresh.length === 0) return;
    for (const d of fresh) this.wanted.add(d);
    if (this.currentCode === SOURCE_LANGUAGE) return;
    await this.setLanguage(this.currentCode, { remember: false });
  }

  private async loadDomains(code: string, domains: string[]): Promise<Array<[string, Catalogue]>> {
    const info = this.languageList.find((l) => l.code === code);
    if (!info || code === SOURCE_LANGUAGE) return [];
    const wanted = domains.filter((d) => info.domains.includes(d));
    const loaded = await Promise.all(wanted.map(async (d) => [d, await this.fetchCatalogue(code, d)] as const));
    return loaded.filter((e): e is [string, Catalogue] => e[1] !== null);
  }

  private fetchCatalogue(code: string, domain: string): Promise<Catalogue | null> {
    const key = `${code}/${domain}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.host.fetchJson(`${code}/${domain}.json`).then(
        (json) => json as Catalogue,
        () => null,
      );
      this.cache.set(key, hit);
    }
    return hit;
  }

  private notify(): void {
    for (const update of [...this.listeners]) update();
  }

  /** Reactive lookup: re-runs its reader when the language changes. */
  translate(domain: string, msgid: string): string {
    this.subscribe();
    return dsgettext(domain, msgid);
  }

  translatePlural(domain: string, singular: string, plural: string, n: number): string {
    this.subscribe();
    return dsngettext(domain, singular, plural, n);
  }

  /** Reactive read of a `TString` (model text kept translatable until drawn). */
  text(value: TString): string {
    this.subscribe();
    return value.str();
  }
}

export const locale = new LocaleManager(browserHost('/i18n/'));

/** `wesnoth-lib`: where upstream's own dialogs keep their wording ("End Turn", "Recruit", ...). */
export const t = (msgid: string): string => locale.translate('wesnoth-lib', msgid);
export const tn = (singular: string, plural: string, n: number): string =>
  locale.translatePlural('wesnoth-lib', singular, plural, n);
/** Any other domain, e.g. `wesnoth` for game rules text or `wesnothweb` for port-only strings. */
export const td = (domain: string, msgid: string): string => locale.translate(domain, msgid);
/** A `TString`, translated in the current language and following a switch. */
export const ts = (value: TString): string => locale.text(value);
