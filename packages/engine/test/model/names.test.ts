import { describe, expect, it } from 'vitest';
import { GrammarNameGenerator, markovName, generateName } from '../../src/model/names.js';
import { loadRealContent } from '../helpers/realContent.js';
import { parseWml } from '../../src/wml/index.js';
import { raceNameSource } from '../../src/model/UnitTypeDatabase.js';

describe('markovName (markov_generate_name)', () => {
  it('with one name and a chain as long as it, gives that name back whatever the numbers', () => {
    expect(markovName('Delfador', 8, Array(12).fill(7))).toBe('Delfador');
  });

  it('picks each next letter with the next number, and ends where a name ends', () => {
    // Prefix "" -> [a, b]; "a" -> [end]; "b" -> [end]. Number 1 picks "b", then the end.
    expect(markovName('a,b', 1, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe('b');
    expect(markovName('a,b', 1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe('a');
  });

  it('cut at 12 letters, it strips back to an ending some name has', () => {
    // "ab" repeats forever with chain 1 when the end is never drawn: a -> [b], b -> [a, end].
    const name = markovName('aba', 1, Array(12).fill(0));
    expect(name.length).toBeLessThanOrEqual(12);
    expect(name.endsWith('a')).toBe(true);
  });
});

describe('GrammarNameGenerator (context_free_grammar_generator)', () => {
  it('builds main from its nonterminals, the seed choosing each', () => {
    const g = new GrammarNameGenerator('main={first}{second}\nfirst=Ka|Mo\nsecond=lin|dor|ren\n');
    // main takes seed[0]; first and second both start at seed[1] (seed_pos is passed by value):
    // 2 % 2 = 0 -> "Ka", 2 % 3 = 2 -> "ren". Shared, second would read seed[2] = 0 -> "lin".
    expect(g.generate([0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe('Karen');
  });

  it('does not pick the same possibility twice running (last_), using the next number instead', () => {
    const g = new GrammarNameGenerator('main=A|B\n');
    const seed = Array(20).fill(1);
    seed[1] = 0;
    // last_ starts at 1: a first pick of 1 is redrawn from the next number (0) -> "A".
    expect(g.generate(seed)).toBe('A');
  });

  it('rejects overriding !, ( and )', () => {
    expect(() => new GrammarNameGenerator('!=x\n')).toThrow();
  });
});

describe('raceNameSource (name_generator_factory)', () => {
  const race = (wml: string) => parseWml(`[race]\n${wml}\n[/race]`).child('race')!;
  it('prefers the gendered grammar, then the gendered names, then the ungendered ones', () => {
    expect(raceNameSource(race('male_names="a,b"\nmale_name_generator="main=x"\nnames="c"'), 'male')?.kind).toBe('grammar');
    expect(raceNameSource(race('male_names="a,b"\nname_generator="main=x"'), 'male')?.kind).toBe('markov');
    expect(raceNameSource(race('name_generator="main=x"'), 'female')?.kind).toBe('grammar');
    expect(raceNameSource(race('names=""'), 'male')).toBeNull();
  });
});

describe('real races', () => {
  const real = loadRealContent();
  it('a human and an elf get a name of letters from their own grammar', () => {
    const human = real.unitType('Spearman').nameSource('male')!;
    const elf = real.unitType('Elvish Fighter').nameSource('female')!;
    expect(human.kind).toBe('grammar');
    expect(elf.kind).toBe('grammar');
    const seed = Array.from({ length: 20 }, (_, i) => (i * 2654435761) >>> 0);
    expect(generateName(human, seed)).toMatch(/^\p{L}[\p{L}' -]*$/u);
    expect(generateName(elf, seed)).toMatch(/^\p{L}[\p{L}' -]*$/u);
  });
});
