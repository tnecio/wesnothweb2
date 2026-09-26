/**
 * Evaluator for the C-expression subset gettext uses in a catalogue's
 * `Plural-Forms:` header, e.g. `nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : 1);`.
 * A small recursive-descent parser -- never `eval` -- so a catalogue cannot
 * run code. Supports `n`, integer literals, `?:`, `||`, `&&`, `== !=`,
 * `< > <= >=`, `+ -`, `* / %`, unary `!` and `-`, and parentheses, with C
 * precedence. Comparison results are 0/1 as in C.
 */

export interface PluralRule {
  nplurals: number;
  /** The plural form index for `n` (always within `0..nplurals-1`). */
  index(n: number): number;
}

type Expr = (n: number) => number;

class ExprParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): Expr {
    const e = this.ternary();
    this.skipWs();
    if (this.pos !== this.src.length) throw new Error(`unexpected '${this.src.charAt(this.pos)}' in plural expression`);
    return e;
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src.charAt(this.pos))) this.pos++;
  }

  private eat(tok: string): boolean {
    this.skipWs();
    if (this.src.startsWith(tok, this.pos)) {
      this.pos += tok.length;
      return true;
    }
    return false;
  }

  private ternary(): Expr {
    const cond = this.or();
    if (!this.eat('?')) return cond;
    const a = this.ternary();
    if (!this.eat(':')) throw new Error("expected ':' in plural expression");
    const b = this.ternary();
    return (n) => (cond(n) !== 0 ? a(n) : b(n));
  }

  private or(): Expr {
    let l = this.and();
    while (this.eat('||')) {
      const a = l;
      const r = this.and();
      l = (n) => (a(n) !== 0 || r(n) !== 0 ? 1 : 0);
    }
    return l;
  }

  private and(): Expr {
    let l = this.equality();
    while (this.eat('&&')) {
      const a = l;
      const r = this.equality();
      l = (n) => (a(n) !== 0 && r(n) !== 0 ? 1 : 0);
    }
    return l;
  }

  private equality(): Expr {
    let l = this.relational();
    for (;;) {
      const a = l;
      if (this.eat('==')) {
        const r = this.relational();
        l = (n) => (a(n) === r(n) ? 1 : 0);
      } else if (this.eat('!=')) {
        const r = this.relational();
        l = (n) => (a(n) !== r(n) ? 1 : 0);
      } else return l;
    }
  }

  private relational(): Expr {
    let l = this.additive();
    for (;;) {
      const a = l;
      if (this.eat('<=')) {
        const r = this.additive();
        l = (n) => (a(n) <= r(n) ? 1 : 0);
      } else if (this.eat('>=')) {
        const r = this.additive();
        l = (n) => (a(n) >= r(n) ? 1 : 0);
      } else if (this.eat('<')) {
        const r = this.additive();
        l = (n) => (a(n) < r(n) ? 1 : 0);
      } else if (this.eat('>')) {
        const r = this.additive();
        l = (n) => (a(n) > r(n) ? 1 : 0);
      } else return l;
    }
  }

  private additive(): Expr {
    let l = this.multiplicative();
    for (;;) {
      const a = l;
      if (this.eat('+')) {
        const r = this.multiplicative();
        l = (n) => a(n) + r(n);
      } else if (this.eat('-')) {
        const r = this.multiplicative();
        l = (n) => a(n) - r(n);
      } else return l;
    }
  }

  private multiplicative(): Expr {
    let l = this.unary();
    for (;;) {
      const a = l;
      if (this.eat('*')) {
        const r = this.unary();
        l = (n) => a(n) * r(n);
      } else if (this.eat('/')) {
        const r = this.unary();
        l = (n) => {
          const d = r(n);
          return d === 0 ? 0 : Math.trunc(a(n) / d);
        };
      } else if (this.eat('%')) {
        const r = this.unary();
        l = (n) => {
          const d = r(n);
          return d === 0 ? 0 : a(n) % d;
        };
      } else return l;
    }
  }

  private unary(): Expr {
    if (this.eat('!')) {
      const e = this.unary();
      return (n) => (e(n) === 0 ? 1 : 0);
    }
    if (this.eat('-')) {
      const e = this.unary();
      return (n) => -e(n);
    }
    return this.primary();
  }

  private primary(): Expr {
    this.skipWs();
    if (this.eat('(')) {
      const e = this.ternary();
      if (!this.eat(')')) throw new Error("expected ')' in plural expression");
      return e;
    }
    const c = this.src.charAt(this.pos);
    if (c === 'n') {
      this.pos++;
      return (n) => n;
    }
    const m = /^\d+/.exec(this.src.slice(this.pos));
    if (m) {
      this.pos += m[0].length;
      const v = Number(m[0]);
      return () => v;
    }
    throw new Error(`unexpected '${c}' in plural expression`);
  }
}

/** English: two forms, singular only for exactly 1. */
export const ENGLISH_PLURAL: PluralRule = { nplurals: 2, index: (n) => (n === 1 ? 0 : 1) };

const cache = new Map<string, PluralRule>();

/**
 * Parses a `Plural-Forms` header value. Malformed headers yield the English
 * rule rather than throwing, so one bad catalogue cannot break the game.
 */
export function parsePluralForms(header: string | undefined): PluralRule {
  if (!header) return ENGLISH_PLURAL;
  const hit = cache.get(header);
  if (hit) return hit;
  let rule = ENGLISH_PLURAL;
  const np = /nplurals\s*=\s*(\d+)/.exec(header);
  const pl = /plural\s*=\s*([^;]+)/.exec(header);
  if (np && pl) {
    try {
      const nplurals = Number(np[1]);
      const expr = new ExprParser(pl[1] as string).parse();
      rule = {
        nplurals,
        index: (n) => {
          const i = expr(Math.abs(Math.trunc(n)));
          return i >= 0 && i < nplurals ? i : nplurals - 1;
        },
      };
    } catch {
      rule = ENGLISH_PLURAL;
    }
  }
  cache.set(header, rule);
  return rule;
}
