import { afterEach, describe, expect, it } from 'vitest';
import {
  TString,
  clearCatalogues,
  dgettext,
  dsgettext,
  dsngettext,
  parsePluralForms,
  setCatalogue,
  translationGeneration,
} from '../../src/i18n/index';

afterEach(() => clearCatalogues());

describe('dsgettext', () => {
  it('returns the source text when nothing is registered', () => {
    expect(dsgettext('wesnoth', 'Recruit')).toBe('Recruit');
  });

  it('strips an untranslated `context^` prefix, as upstream does', () => {
    expect(dsgettext('wesnoth', 'female^Elvish Fighter')).toBe('Elvish Fighter');
    expect(dsgettext('wesnoth', 'Multiplayer_AI^Default AI (RCA)')).toBe('Default AI (RCA)');
  });

  it('uses the translation, context and all, when there is one', () => {
    setCatalogue('wesnoth', { entries: { 'female^Elvish Fighter': 'Elfia Wojowniczka' } });
    expect(dsgettext('wesnoth', 'female^Elvish Fighter')).toBe('Elfia Wojowniczka');
    expect(dsgettext('wesnoth', 'Elvish Fighter')).toBe('Elvish Fighter');
  });

  it('keeps domains apart', () => {
    setCatalogue('wesnoth-dw', { entries: { Hello: 'Cześć' } });
    expect(dsgettext('wesnoth-dw', 'Hello')).toBe('Cześć');
    expect(dsgettext('wesnoth', 'Hello')).toBe('Hello');
  });

  it('never looks up the empty string (which would return the catalogue header)', () => {
    setCatalogue('wesnoth', { entries: { '': 'Project-Id-Version: x' } });
    expect(dgettext('wesnoth', '')).toBe('');
  });
});

describe('dsngettext', () => {
  it('uses English rules without a catalogue', () => {
    expect(dsngettext('wesnoth', '1 turn', '%d turns', 1)).toBe('1 turn');
    expect(dsngettext('wesnoth', '1 turn', '%d turns', 5)).toBe('%d turns');
  });

  it('selects the plural form with the catalogue rule', () => {
    setCatalogue('wesnoth', {
      plural: 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
      entries: { '%d turn': ['%d tura', '%d tury', '%d tur'] },
    });
    expect(dsngettext('wesnoth', '%d turn', '%d turns', 1)).toBe('%d tura');
    expect(dsngettext('wesnoth', '%d turn', '%d turns', 3)).toBe('%d tury');
    expect(dsngettext('wesnoth', '%d turn', '%d turns', 5)).toBe('%d tur');
    expect(dsngettext('wesnoth', '%d turn', '%d turns', 22)).toBe('%d tury');
  });
});

describe('parsePluralForms', () => {
  it('evaluates the common rules', () => {
    const ru = parsePluralForms(
      'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
    );
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => ru.index(n))).toEqual([0, 1, 2, 2, 0, 1, 2]);
    const ar = parsePluralForms(
      'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);',
    );
    expect([0, 1, 2, 5, 15, 100].map((n) => ar.index(n))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(parsePluralForms('nplurals=1; plural=0;').index(7)).toBe(0);
  });

  it('falls back to English on a malformed header rather than throwing', () => {
    expect(parsePluralForms('nplurals=2; plural=(n !! 1);').index(1)).toBe(0);
    expect(parsePluralForms('garbage').index(2)).toBe(1);
  });
});

describe('TString', () => {
  it('translates lazily and follows a catalogue change', () => {
    const t = TString.translatable('wesnoth', 'Hello');
    expect(t.str()).toBe('Hello');
    const before = translationGeneration();
    setCatalogue('wesnoth', { entries: { Hello: 'Cześć' } });
    expect(translationGeneration()).toBeGreaterThan(before);
    expect(t.str()).toBe('Cześć');
    clearCatalogues();
    expect(t.str()).toBe('Hello');
  });

  it('keeps the untranslatable tail of a concatenation', () => {
    const t = TString.translatable('wesnoth', 'Hello').concat(', world');
    setCatalogue('wesnoth', { entries: { Hello: 'Cześć' } });
    expect(t.str()).toBe('Cześć, world');
    expect(t.baseStr()).toBe('Hello, world');
    expect(t.translatable).toBe(true);
    expect(TString.literal('x').translatable).toBe(false);
  });

  it('round-trips through JSON', () => {
    const t = TString.fromParts([{ domain: 'wesnoth-dw', msgid: 'A' }, ' and ', { domain: 'wesnoth', msgid: 'B' }]);
    const back = TString.fromJSON(JSON.parse(JSON.stringify(t)));
    expect(back.parts).toEqual(t.parts);
  });
});
