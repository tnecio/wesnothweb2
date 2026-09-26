import { afterEach, describe, expect, it } from 'vitest';
import { clearCatalogues, setCatalogue } from '@wesnothweb2/engine/src/i18n/gettext.js';
import { doString, newLuaState } from '../src/luaEnv.js';
import { BOOTSTRAP_LUA_SOURCE } from '../src/bridges/bootstrap.js';
import { installTextdomainBridge } from '../src/bridges/textdomain.js';

function lua(source: string): unknown {
  const L = newLuaState();
  doString(L, BOOTSTRAP_LUA_SOURCE, '=bootstrap');
  installTextdomainBridge(L, (s) => void doString(L, s, '=textdomain'));
  return doString(L, source, '=test');
}

afterEach(() => clearCatalogues());

describe('wesnoth.textdomain', () => {
  it('returns the English text, stripping a context prefix, with no catalogue', () => {
    expect(lua('local _ = wesnoth.textdomain("wesnoth-dw"); return _ "Hello"')).toBe('Hello');
    expect(lua('local _ = wesnoth.textdomain("wesnoth"); return _ "female^Fighter"')).toBe('Fighter');
  });

  it('translates through the engine catalogue of that domain', () => {
    setCatalogue('wesnoth-dw', { entries: { Hello: 'Cześć' } });
    expect(lua('local _ = wesnoth.textdomain("wesnoth-dw"); return _ "Hello"')).toBe('Cześć');
    expect(lua('local _ = wesnoth.textdomain("wesnoth"); return _ "Hello"')).toBe('Hello');
  });

  it('picks a plural form with the catalogue rule', () => {
    setCatalogue('wesnoth', {
      plural: 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
      entries: { '1 turn': ['1 tura', '2 tury', '5 tur'] },
    });
    expect(lua('local _ = wesnoth.textdomain("wesnoth"); return _("1 turn", "turns", 3)')).toBe('2 tury');
    expect(lua('local _ = wesnoth.textdomain("wesnoth"); return _("1 turn", "turns", 1)')).toBe('1 tura');
  });
});
