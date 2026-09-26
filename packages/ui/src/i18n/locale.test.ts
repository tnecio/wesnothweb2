import { afterEach, describe, expect, it } from 'vitest';
import { TString, clearCatalogues, dsgettext } from '@wesnothweb2/engine';
import { LocaleManager, detectLanguage, languageTag, type LanguageInfo, type LocaleHost } from './locale';

const languages: LanguageInfo[] = [
  { code: 'en_US', name: 'English (US)', alternates: ['C', 'en_PH'], rtl: false, percent: 100, domains: [] },
  { code: 'en_GB', name: 'English (GB)', alternates: ['en_AU', 'en_IE'], rtl: false, percent: 99, domains: ['wesnoth'] },
  { code: 'es_ES', name: 'Español', alternates: ['es_MX', 'es_AR'], rtl: false, percent: 99, domains: ['wesnoth'] },
  { code: 'pl_PL', name: 'Polski', alternates: [], rtl: false, percent: 68, domains: ['wesnoth', 'wesnoth-lib', 'wesnoth-dw'] },
  { code: 'ar_AR', name: 'العربية', alternates: ['ar_EG'], rtl: true, percent: 88, domains: ['wesnoth'] },
];

const catalogues: Record<string, unknown> = {
  'languages.json': { languages },
  'pl_PL/wesnoth.json': { plural: 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);', entries: { Recruit: 'Rekrutuj' } },
  'pl_PL/wesnoth-lib.json': { entries: { 'End Turn': 'Zakończ turę' } },
  'pl_PL/wesnoth-dw.json': { entries: { Hello: 'Cześć' } },
  'ar_AR/wesnoth.json': { entries: { Recruit: 'جنّد', Lato: 'لاتو' } },
};

interface Recorded {
  fetched: string[];
  saved: string | null;
  document: { lang: string; dir: string } | null;
  fonts?: string;
}

function fakeHost(over: Partial<LocaleHost> & { saved?: string | null; preferred?: string[] } = {}): { host: LocaleHost; rec: Recorded } {
  const rec: Recorded = { fetched: [], saved: over.saved ?? null, document: null };
  const host: LocaleHost = {
    fetchJson: async (url) => {
      rec.fetched.push(url);
      if (!(url in catalogues)) throw new Error(`404 ${url}`);
      return catalogues[url];
    },
    loadChoice: () => rec.saved,
    saveChoice: (c) => (rec.saved = c),
    preferredLanguages: () => over.preferred ?? [],
    applyDocument: (lang, dir) => (rec.document = { lang, dir }),
    applyFonts: (stacks) => (rec.fonts = stacks.ui),
    ...over,
  };
  return { host, rec };
}

afterEach(() => clearCatalogues());

describe('detectLanguage', () => {
  it('matches exact locales, then alternates, then the same language', () => {
    expect(detectLanguage(['pl-PL'], languages)).toBe('pl_PL');
    expect(detectLanguage(['es-MX'], languages)).toBe('es_ES');
    expect(detectLanguage(['pl'], languages)).toBe('pl_PL');
    expect(detectLanguage(['es-CL'], languages)).toBe('es_ES');
    expect(detectLanguage(['en-AU'], languages)).toBe('en_GB');
  });

  it('honours the browser preference order and falls back to English', () => {
    expect(detectLanguage(['ja', 'pl'], languages)).toBe('pl_PL');
    expect(detectLanguage(['ja', 'ko'], languages)).toBe('en_US');
    expect(detectLanguage([], languages)).toBe('en_US');
  });
});

describe('languageTag', () => {
  it('turns upstream codes into BCP 47', () => {
    expect(languageTag('pl_PL')).toBe('pl-PL');
    expect(languageTag('sr_RS@latin')).toBe('sr-RS');
  });
});

describe('LocaleManager', () => {
  it('starts in English and fetches no catalogue for it', async () => {
    const { host, rec } = fakeHost();
    const m = new LocaleManager(host);
    await m.init();
    expect(m.current).toBe('en_US');
    expect(rec.fetched).toEqual(['languages.json']);
    expect(m.translate('wesnoth', 'Recruit')).toBe('Recruit');
  });

  it('picks the browser language on first run and loads only the core domains it has', async () => {
    const { host, rec } = fakeHost({ preferred: ['pl-PL'] });
    const m = new LocaleManager(host);
    await m.init();
    expect(m.current).toBe('pl_PL');
    expect(rec.fetched.sort()).toEqual(['languages.json', 'pl_PL/wesnoth-lib.json', 'pl_PL/wesnoth.json']);
    expect(m.translate('wesnoth', 'Recruit')).toBe('Rekrutuj');
    expect(m.translate('wesnoth-lib', 'End Turn')).toBe('Zakończ turę');
    expect(rec.document).toEqual({ lang: 'pl-PL', dir: 'ltr' });
  });

  it('does not remember an auto-detected language, but remembers a chosen one', async () => {
    const { host, rec } = fakeHost({ preferred: ['pl'] });
    const m = new LocaleManager(host);
    await m.init();
    expect(rec.saved).toBeNull();
    await m.setLanguage('es_ES');
    expect(rec.saved).toBe('es_ES');
  });

  it('a saved choice beats the browser preference', async () => {
    const { host } = fakeHost({ saved: 'es_ES', preferred: ['pl'] });
    const m = new LocaleManager(host);
    await m.init();
    expect(m.current).toBe('es_ES');
  });

  it('switches at run time, relocalizes a live TString, and switches back', async () => {
    const { host } = fakeHost();
    const m = new LocaleManager(host);
    await m.init();
    const label = TString.translatable('wesnoth', 'Recruit');
    expect(label.str()).toBe('Recruit');
    await m.setLanguage('pl_PL');
    expect(label.str()).toBe('Rekrutuj');
    await m.setLanguage('en_US');
    expect(label.str()).toBe('Recruit');
    expect(dsgettext('wesnoth', 'Recruit')).toBe('Recruit');
  });

  it('sets the document direction for a right-to-left language', async () => {
    const { host, rec } = fakeHost();
    const m = new LocaleManager(host);
    await m.init();
    await m.setLanguage('ar_AR');
    expect(m.rtl).toBe(true);
    expect(rec.document).toEqual({ lang: 'ar-AR', dir: 'rtl' });
    await m.setLanguage('pl_PL');
    expect(rec.document?.dir).toBe('ltr');
  });

  it('takes the font order from the language\'s own family_order, falling through to bundled fonts', async () => {
    const { host, rec } = fakeHost();
    const m = new LocaleManager(host);
    await m.init();
    expect(rec.fonts).toBe('"Lato", "DejaVu Sans", sans-serif');
    await m.setLanguage('ar_AR');
    // Arabic's translators wrote a name no installed font has; the English name and DejaVu Sans (which has Arabic) follow.
    expect(rec.fonts).toBe('"لاتو", "Lato", "DejaVu Sans", sans-serif');
    await m.setLanguage('pl_PL');
    expect(rec.fonts).toBe('"Lato", "DejaVu Sans", sans-serif');
  });

  it('fetches a scenario domain only when asked, and only if the language has one', async () => {
    const { host, rec } = fakeHost();
    const m = new LocaleManager(host);
    await m.init();
    await m.setLanguage('pl_PL');
    expect(m.translate('wesnoth-dw', 'Hello')).toBe('Hello');
    await m.useDomains(['wesnoth-dw', 'wesnoth-tb']);
    expect(m.translate('wesnoth-dw', 'Hello')).toBe('Cześć');
    expect(rec.fetched).not.toContain('pl_PL/wesnoth-tb.json');
    // A later switch keeps wanting it.
    await m.setLanguage('en_US');
    await m.setLanguage('pl_PL');
    expect(m.translate('wesnoth-dw', 'Hello')).toBe('Cześć');
  });

  it('serves a language it has already fetched from memory', async () => {
    const { host, rec } = fakeHost();
    const m = new LocaleManager(host);
    await m.init();
    await m.setLanguage('pl_PL');
    const n = rec.fetched.length;
    await m.setLanguage('en_US');
    await m.setLanguage('pl_PL');
    expect(rec.fetched.length).toBe(n);
  });

  it('falls back to English when a catalogue fails to load', async () => {
    const { host } = fakeHost({
      fetchJson: async (url) => {
        if (url === 'languages.json') return { languages };
        throw new Error('offline');
      },
    });
    const m = new LocaleManager(host);
    await m.init();
    await m.setLanguage('pl_PL');
    expect(m.translate('wesnoth', 'Recruit')).toBe('Recruit');
  });

  it('survives an unreachable language list', async () => {
    const { host } = fakeHost({
      fetchJson: async () => {
        throw new Error('offline');
      },
    });
    const m = new LocaleManager(host);
    await m.init();
    expect(m.current).toBe('en_US');
    expect(m.languages).toEqual([]);
  });

  it('two quick switches end on the second language', async () => {
    const { host } = fakeHost();
    const m = new LocaleManager(host);
    await m.init();
    const a = m.setLanguage('pl_PL');
    const b = m.setLanguage('ar_AR');
    await Promise.all([a, b]);
    expect(m.current).toBe('ar_AR');
    expect(m.translate('wesnoth', 'Recruit')).toBe('جنّد');
  });
});
