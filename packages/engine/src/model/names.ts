/**
 * Phase 27c S7: random unit names, as upstream makes them (`utils/markov_generator.cpp`,
 * `utils/context_free_grammar_generator.cpp`, `utils/name_generator_factory.cpp`).
 *
 * Both generators read a fixed count of synced random numbers whatever name comes out -- the markov one 12,
 * the grammar 20 -- which the engine already draws when it creates a unit (`rollNewUnit`, `nameDrawCount`), so
 * a name is made from exactly those numbers and nothing else about the game changes.
 */

/** A race's name source for one gender (`name_generator_factory::add_name_generator_from_config`). */
export type NameSource =
  | { readonly kind: 'markov'; readonly names: string; readonly chainSize: number }
  | { readonly kind: 'grammar'; readonly grammar: string };

/** `markov_generator`'s `max_len`. */
export const MARKOV_MAX_LEN = 12;
/** `context_free_grammar_generator::seed_size`. */
export const GRAMMAR_SEED_SIZE = 20;

/** `markov_prefixes`: every prefix (up to `length` code points) of every name, and the code points that follow it (0 for the end). */
function markovPrefixes(items: readonly string[], length: number): Map<string, number[]> {
  const res = new Map<string, number[]>();
  for (const item of items) {
    const cps = Array.from(item).map((c) => c.codePointAt(0)!);
    for (let i = 0; i <= cps.length; i++) {
      const start = i > length ? i - length : 0;
      const key = String.fromCodePoint(...cps.slice(start, i));
      const c = i !== cps.length ? cps[i]! : 0;
      let list = res.get(key);
      if (!list) res.set(key, (list = []));
      list.push(c);
    }
  }
  return res;
}

const markovCache = new Map<string, Map<string, number[]>>();

/**
 * `markov_generate_name`: a name from `names` (comma-separated, as `utils::split`) built `chainSize` code points
 * at a time, choosing each next one with the next of `random` (its 12 numbers, unsigned).
 */
export function markovName(names: string, chainSize: number, random: readonly number[], maxLen = MARKOV_MAX_LEN): string {
  const items = names.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const cacheKey = `${chainSize}\u0000${items.join('\u0000')}`;
  let prefixes = markovCache.get(cacheKey);
  if (!prefixes) markovCache.set(cacheKey, (prefixes = markovPrefixes(items, chainSize)));
  if (prefixes.size === 0 || chainSize === 0) return '';

  let prefix: number[] = [];
  let res: number[] = [];
  let j = 0;
  const key = (cps: readonly number[]) => String.fromCodePoint(...cps);
  while (res.length < maxLen) {
    const options = prefixes.get(key(prefix));
    if (!options || options.length === 0) return key(res);
    const c = options[(random[j++]! >>> 0) % options.length]!;
    if (c === 0) return key(res);
    res.push(c);
    prefix.push(c);
    while (prefix.length > chainSize) prefix.shift();
  }
  // The maximum length was reached: strip characters until the name ends where some name ends.
  const original = res;
  res = [...res];
  while (res.length > 0) {
    const len = Math.min(chainSize, res.length);
    prefix = res.slice(res.length - len);
    const options = prefixes.get(key(prefix));
    if (!options || options.length === 0) return key(res);
    if (options.includes(0)) return key(res);
    res.pop();
  }
  return key(original);
}

/** One nonterminal: its possibilities (each a list of literal pieces and `{name` references), and the last one picked. */
interface Nonterminal {
  readonly possibilities: string[][];
  last: number;
}

/** `context_free_grammar_generator`: a grammar (`name = a|b{other}c` lines; `main` is generated). */
export class GrammarNameGenerator {
  private readonly nonterminals = new Map<string, Nonterminal>();

  /** Throws `Error` for what upstream rejects (`name_generator_invalid_exception`). */
  constructor(source: string) {
    let current: Nonterminal | null = null;
    let filled: string[] | null = null;
    let buf = '';
    for (let i = 0; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === '=') {
        const key = buf.trim();
        if (key === '!' || key === '(' || key === ')') throw new Error('[context_free_grammar_generator] Parsing error: nonterminals (, ! and ) may not be overridden');
        current = this.nonterminals.get(key) ?? { possibilities: [], last: 1 };
        this.nonterminals.set(key, current);
        filled = [];
        current.possibilities.push(filled);
        buf = '';
      } else if (ch === '\n') {
        if (filled) filled.push(buf);
        filled = null;
        current = null;
        buf = '';
      } else if (ch === '|') {
        if (!filled || !current) throw new Error('[context_free_grammar_generator] Parsing error: misplaced | symbol');
        filled.push(buf);
        filled = [];
        current.possibilities.push(filled);
        buf = '';
      } else if (ch === '\\' && source[i + 1] === 'n') {
        i++;
        buf += '\n';
      } else if (ch === '\\' && source[i + 1] === 't') {
        i++;
        buf += '\t';
      } else if (ch === '{') {
        if (!filled) throw new Error('[context_free_grammar_generator] Parsing error: misplaced { symbol');
        filled.push(buf);
        buf = '';
      } else if (ch === '}') {
        if (!filled) throw new Error('[context_free_grammar_generator] Parsing error: misplaced } symbol');
        filled.push(`{${buf.trim()}`);
        buf = '';
      } else {
        buf += ch;
      }
    }
    if (filled) filled.push(buf);
  }

  /** `print_nonterminal`: `seedPos` is passed by value, as upstream's `short seed_pos`. */
  private print(name: string, seed: readonly number[], seedPos: number): string {
    if (name === '!') return '|';
    if (name === '(') return '{';
    if (name === ')') return '}';
    const got = this.nonterminals.get(name);
    if (!got) return `!${name}`;
    let picked = (seed[seedPos++]! >>> 0) % got.possibilities.length;
    if (seedPos >= GRAMMAR_SEED_SIZE) seedPos = 0;
    if (picked === got.last) {
      picked = (seed[seedPos++]! >>> 0) % got.possibilities.length;
      if (seedPos >= GRAMMAR_SEED_SIZE) seedPos = 0;
    }
    got.last = picked;
    let result = '';
    for (const piece of got.possibilities[picked]!) {
      result += piece.startsWith('{') ? this.print(piece.slice(1), seed, seedPos) : piece;
    }
    return result;
  }

  /** `generate`: the `main` nonterminal from the 20-number `seed`. */
  generate(seed: readonly number[]): string {
    return this.print('main', seed, 0);
  }
}

/** Upstream keeps one generator per race, its `last_` choices carried from name to name: one per grammar here. */
const grammars = new Map<string, GrammarNameGenerator | null>();

/** A name from `source` and the random numbers drawn for it (12 or 20); empty when the grammar does not parse. */
export function generateName(source: NameSource, random: readonly number[]): string {
  if (source.kind === 'markov') return markovName(source.names, source.chainSize, random);
  let generator = grammars.get(source.grammar);
  if (generator === undefined) {
    try {
      generator = new GrammarNameGenerator(source.grammar);
    } catch {
      generator = null;
    }
    grammars.set(source.grammar, generator);
  }
  return generator ? generator.generate(random) : '';
}
