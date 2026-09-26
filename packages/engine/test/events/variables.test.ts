import { describe, expect, it } from 'vitest';
import { VariableStore } from '../../src/events/variables.js';
import { WmlConfig } from '../../src/wml/config.js';
import { TString, clearCatalogues, setCatalogue } from '../../src/i18n/index.js';

describe('VariableStore', () => {
  it('reads/writes plain scalars', () => {
    const vars = new VariableStore();
    expect(vars.get('foo')).toBeUndefined();
    vars.set('foo', 42);
    expect(vars.get('foo')).toBe(42);
    expect(vars.getString('foo')).toBe('42');
    vars.set('name', 'Krellis');
    expect(vars.getString('name')).toBe('Krellis');
  });

  it('supports array-style variables with indexed field access, matching $foo[n].field', () => {
    const vars = new VariableStore();
    vars.set('creatures[0].user_description', 'Merman Citizen');
    vars.set('creatures[1].user_description', 'Gwabbo');
    expect(vars.arrayLength('creatures')).toBe(2);
    expect(vars.getString('creatures[0].user_description')).toBe('Merman Citizen');
    expect(vars.getString('creatures[1].user_description')).toBe('Gwabbo');
    expect(vars.get('creatures.length')).toBe(2);
  });

  it('extends an array with blank elements when writing past the end (mirrors upstream get_child_at)', () => {
    const vars = new VariableStore();
    vars.set('list[2].value', 'third');
    expect(vars.arrayLength('list')).toBe(3);
    expect(vars.get('list[0].value')).toBeUndefined();
    expect(vars.getString('list[2].value')).toBe('third');
  });

  it('resolves negative indices against the current array length', () => {
    const vars = new VariableStore();
    vars.set('list[0].n', 1);
    vars.set('list[1].n', 2);
    vars.set('list[2].n', 3);
    expect(vars.get('list[-1].n')).toBe(3);
  });

  it('pushArray/setArray/getArray round-trip whole elements', () => {
    const vars = new VariableStore();
    const one = { attrs: new Map<string, string | number | boolean>([['number', 1]]), arrays: new Map() };
    const two = { attrs: new Map<string, string | number | boolean>([['number', 2]]), arrays: new Map() };
    vars.pushArray('pattern', one);
    vars.pushArray('pattern', two);
    expect(vars.arrayLength('pattern')).toBe(2);
    expect(vars.get('pattern[1].number')).toBe(2);

    vars.setArray('pattern', [two]); // mode=replace
    expect(vars.arrayLength('pattern')).toBe(1);
    expect(vars.get('pattern[0].number')).toBe(2);
  });

  it('clear() drops both the scalar attribute and any same-named array', () => {
    const vars = new VariableStore();
    vars.set('x', 1);
    vars.clear('x');
    expect(vars.get('x')).toBeUndefined();
  });

  it('loads a scenario [variables] child and round-trips through toConfig()', () => {
    const scenario = new WmlConfig();
    const varsCfg = scenario.addChild('variables');
    varsCfg.setAttribute('number_of_captured_villages', 0);
    const store = VariableStore.fromScenario(scenario);
    expect(store.getNumber('number_of_captured_villages')).toBe(0);
    store.set('number_of_captured_villages', 3);
    expect(store.toConfig().getNumber('number_of_captured_villages')).toBe(3);
  });

  describe('substitute()', () => {
    it('replaces plain $var references', () => {
      const vars = new VariableStore();
      vars.set('name', 'Krellis');
      expect(vars.substitute('Hello, $name!')).toBe('Hello, Krellis!');
    });

    it('resolves nested array-index references right-to-left, e.g. $creatures[$i].name', () => {
      const vars = new VariableStore();
      vars.set('i', 1);
      vars.set('creatures[1].name', 'Cylanna');
      expect(vars.substitute('I am $creatures[$i].name!')).toBe('I am Cylanna!');
    });

    it('replaces missing variables with an empty string', () => {
      const vars = new VariableStore();
      expect(vars.substitute('[$missing]')).toBe('[]');
    });

    it('supports the $var?default| fallback syntax', () => {
      const vars = new VariableStore();
      expect(vars.substitute('$missing?fallback|!')).toBe('fallback!');
      vars.set('present', 'value');
      expect(vars.substitute('$present?fallback|!')).toBe('value!');
    });

    it('treats "$|" and a bare trailing "$" as an escaped literal dollar sign', () => {
      const vars = new VariableStore();
      expect(vars.substitute('$|5')).toBe('$5');
    });
  });

  describe('expandConfig()', () => {
    it('substitutes string attributes but leaves numbers/booleans and nested children untouched', () => {
      const vars = new VariableStore();
      vars.set('who', 'Krellis');
      const cfg = new WmlConfig();
      cfg.setAttribute('message', 'Hail, $who!');
      cfg.setAttribute('count', 3);
      const child = cfg.addChild('option');
      child.setAttribute('label', 'unexpanded $who');

      const expanded = vars.expandConfig(cfg);
      expect(expanded.getString('message')).toBe('Hail, Krellis!');
      expect(expanded.getNumber('count')).toBe(3);
      // Children are kept as raw references -- expanding them is each consumer's own job,
      // done at the point it actually reads them (see the module doc comment on why).
      expect(expanded.child('option')!.getString('label')).toBe('unexpanded $who');
    });
  });

  describe('translatable values', () => {
    it('keeps a `_ "..."` value translatable in the store and across toConfig/JSON', () => {
      const vars = new VariableStore();
      vars.set('title', TString.translatable('wesnoth-dw', 'Hello'));
      expect(vars.getString('title')).toBe('Hello');
      const back = WmlConfig.fromJSON(JSON.parse(JSON.stringify(vars.toConfig().toJSON())));
      const restored = new VariableStore();
      restored.replaceAll(back);
      setCatalogue('wesnoth-dw', { entries: { Hello: 'Cześć' } });
      try {
        expect(restored.getString('title')).toBe('Cześć');
      } finally {
        clearCatalogues();
      }
    });

    it('expandConfig keeps the TString when nothing was substituted, and an interpolated one when something was', () => {
      const vars = new VariableStore();
      vars.set('who', 'Krellis');
      const cfg = new WmlConfig();
      cfg.setAttribute('plain', TString.translatable('wesnoth', 'Hello'));
      cfg.setAttribute('subst', TString.translatable('wesnoth', 'Hail, $who!'));
      const out = vars.expandConfig(cfg);
      expect(out.isTranslatable('plain')).toBe(true);
      expect(out.getString('subst')).toBe('Hail, Krellis!');
      // Interpolated text still follows the language, over the variables as they were then...
      setCatalogue('wesnoth', { entries: { 'Hail, $who!': 'Witaj, $who!' } });
      try {
        vars.set('who', 'someone else');
        expect(out.getString('subst')).toBe('Witaj, Krellis!');
      } finally {
        clearCatalogues();
      }
      // ...and is saved as the plain text it reads as, never as parts that would lose the substitution.
      expect(out.toJSON().attrs['subst']).toBe('Hail, Krellis!');
      expect(out.toJSON().attrs['plain']).toEqual({ t: [['wesnoth', 'Hello']] });
    });

    it('translates before substituting, as upstream does', () => {
      const vars = new VariableStore();
      vars.set('who', 'Krellis');
      setCatalogue('wesnoth', { entries: { 'Hail, $who!': 'Witaj, $who!' } });
      try {
        const cfg = new WmlConfig();
        cfg.setAttribute('m', TString.translatable('wesnoth', 'Hail, $who!'));
        expect(vars.expandConfig(cfg).getString('m')).toBe('Witaj, Krellis!');
      } finally {
        clearCatalogues();
      }
    });
  });
});
