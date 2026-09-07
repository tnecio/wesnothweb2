/**
 * TS port of the expression-tree classes and the `parse_expression` /
 * `parse_args` / `parse_set_args` / `parse_where_clauses` /
 * `parse_function_args` functions from src/formula/formula.cpp.
 *
 * The overall shape (a single recursive `parseExpression` over a flat token
 * array, picking the lowest-precedence top-level operator as the split
 * point) is kept as close to upstream as practical, including its quirks
 * (e.g. `and`/`or` evaluate both operands unconditionally -- WFL's boolean
 * operators are *not* short-circuiting, matching `operator_expression::execute`).
 *
 * Not ported: the `formula` class's own multi-file `wfl '<file>' ...
 * wflend` inclusion handling (see tokenizer.ts's module doc) and the
 * formula debugger hooks (`add_debug_info` / `formula_debugger`) -- neither
 * is meaningful without the surrounding editor/profiler tooling.
 */

import { type Token, TokenType, tokenize } from './tokenizer';
import type { Callable } from './variant';
import { Variant } from './variant';
import { dotCallable, listPropsCallable, mapPropsCallable, memberCallable, stringPropsCallable } from './callable';
import type { Expression } from './expression';
import { FormulaError } from './expression';
import { FunctionSymbolTable, type UserFunctionDef } from './functions';

// ---- dice roll RNG hook ----

/**
 * The `d` operator (dice roll, e.g. `2d6`) delegates to a pluggable RNG so
 * the engine's deterministic RNG (once it exists -- see
 * src/random.cpp/random_deterministic.cpp, not yet ported) can be plugged
 * in later without this module depending on it. Defaults to `Math.random`.
 */
export let diceRng: (facesExclusive: number) => number = (faces) => Math.floor(Math.random() * faces);

export function setFormulaDiceRng(fn: (facesExclusive: number) => number): void {
  diceRng = fn;
}

function diceRoll(numRolls: number, faces: number): number {
  let res = 0;
  let n = numRolls;
  while (faces > 0 && n-- > 0) {
    res += 1 + diceRng(faces);
  }
  return res;
}

// ---- operator precedence ----

// Matches formula.cpp's `operator_precedence` table exactly (lower binds
// looser; the split-point search below picks the lowest-precedence
// top-level operator, so e.g. `and` (4) splits before `+` (7)).
const PRECEDENCE: Record<string, number> = {
  not: 1,
  where: 2,
  or: 3,
  and: 4,
  '=': 5,
  '!=': 5,
  '<': 5,
  '>': 5,
  '<=': 5,
  '>=': 5,
  in: 5,
  '~': 6,
  '+': 7,
  '-': 7,
  '..': 7,
  '*': 8,
  '/': 8,
  '%': 9,
  '^': 10,
  d: 11,
  '.': 12,
};

function precedence(t: Token): number {
  const p = PRECEDENCE[t.text];
  if (p === undefined) throw new FormulaError(`Unknown operator: '${t.text}'`);
  return p;
}

function tokensToString(tokens: Token[], lo: number, hi: number): string {
  return tokens
    .slice(lo, hi)
    .map((t) => t.text)
    .join(' ');
}

// ---- expression node classes ----

class NullExpression implements Expression {
  toString(): string {
    return '';
  }
  evaluate(): Variant {
    return Variant.null_();
  }
}

export const NULL_EXPRESSION: Expression = new NullExpression();

class IntegerExpression implements Expression {
  constructor(private readonly value: number) {}
  toString(): string {
    return String(this.value);
  }
  evaluate(): Variant {
    return Variant.int(this.value);
  }
}

class DecimalExpression implements Expression {
  constructor(
    private readonly i: number,
    private readonly f: number,
  ) {}
  toString(): string {
    return `${this.i}.${String(this.f).padStart(3, '0')}`;
  }
  evaluate(): Variant {
    return Variant.decimalRaw(this.i * 1000 + this.f);
  }
}

class IdentifierExpression implements Expression {
  constructor(private readonly id: string) {}
  toString(): string {
    return this.id;
  }
  evaluate(vars: Callable): Variant {
    return vars.getValue(this.id);
  }
}

class ListExpression implements Expression {
  constructor(private readonly items: Expression[]) {}
  toString(): string {
    return `[${this.items.map((i) => i.toString()).join(',')}]`;
  }
  evaluate(vars: Callable): Variant {
    return Variant.list(this.items.map((i) => i.evaluate(vars)));
  }
}

class MapExpression implements Expression {
  constructor(private readonly items: Expression[]) {}
  toString(): string {
    if (this.items.length === 0) return '[->]';
    let s = '[';
    for (let i = 0; i + 1 < this.items.length; i += 2) {
      if (i !== 0) s += ', ';
      s += `${this.items[i]!.toString()} -> ${this.items[i + 1]!.toString()}`;
    }
    return s + ']';
  }
  evaluate(vars: Callable): Variant {
    const entries: [Variant, Variant][] = [];
    for (let i = 0; i + 1 < this.items.length; i += 2) {
      entries.push([this.items[i]!.evaluate(vars), this.items[i + 1]!.evaluate(vars)]);
    }
    return Variant.map(entries);
  }
}

class UnaryOperatorExpression implements Expression {
  constructor(
    private readonly op: string,
    private readonly operand: Expression,
  ) {
    if (op !== 'not' && op !== '-') {
      throw new FormulaError(`Illegal unary operator: '${op}'`);
    }
  }
  toString(): string {
    return `${this.op}(${this.operand.toString()})`;
  }
  evaluate(vars: Callable): Variant {
    const res = this.operand.evaluate(vars);
    return this.op === 'not' ? Variant.int(res.asBool() ? 0 : 1) : res.neg();
  }
}

class DotExpression implements Expression {
  constructor(
    private readonly left: Expression,
    private readonly right: Expression,
  ) {}
  toString(): string {
    return `${this.left.toString()}.${this.right.toString()}`;
  }
  evaluate(vars: Callable): Variant {
    const left = this.left.evaluate(vars);
    if (!left.isCallable()) {
      if (left.isList()) return this.right.evaluate(dotCallable(vars, listPropsCallable(left)));
      if (left.isMap()) return this.right.evaluate(dotCallable(vars, mapPropsCallable(left)));
      if (left.isString()) return this.right.evaluate(dotCallable(vars, stringPropsCallable(left)));
      return left;
    }
    return this.right.evaluate(dotCallable(vars, memberCallable(left)));
  }
}

class SquareBracketExpression implements Expression {
  constructor(
    private readonly left: Expression,
    private readonly key: Expression,
  ) {}
  toString(): string {
    return `${this.left.toString()}[${this.key.toString()}]`;
  }
  evaluate(vars: Callable): Variant {
    const left = this.left.evaluate(vars);
    const key = this.key.evaluate(vars);
    if (left.isList() || left.isMap()) return left.get(key);
    return Variant.null_();
  }
}

class OperatorExpression implements Expression {
  constructor(
    private readonly op: string,
    private readonly left: Expression,
    private readonly right: Expression,
  ) {}
  toString(): string {
    return `(${this.left.toString()}${this.op}${this.right.toString()})`;
  }
  evaluate(vars: Callable): Variant {
    // Note: both operands are evaluated unconditionally, even for `and`/`or`
    // -- matches upstream's `operator_expression::execute` (WFL booleans do
    // not short-circuit).
    const left = this.left.evaluate(vars);
    const right = this.right.evaluate(vars);
    switch (this.op) {
      case 'and':
        return left.asBool() === false ? left : right;
      case 'or':
        return left.asBool() ? left : right;
      case '+':
        return left.add(right);
      case '-':
        return left.sub(right);
      case '*':
        return left.mul(right);
      case '/':
        return left.div(right);
      case '^':
        return left.pow(right);
      case '.+':
        return left.listElementsAdd(right);
      case '.-':
        return left.listElementsSub(right);
      case '.*':
        return left.listElementsMul(right);
      case './':
        return left.listElementsDiv(right);
      case 'in':
        return Variant.int(right.contains(left) ? 1 : 0);
      case '..':
        return left.concatenate(right);
      case '=':
        return Variant.int(left.eq(right) ? 1 : 0);
      case '!=':
        return Variant.int(left.ne(right) ? 1 : 0);
      case '<=':
        return Variant.int(left.le(right) ? 1 : 0);
      case '>=':
        return Variant.int(left.ge(right) ? 1 : 0);
      case '<':
        return Variant.int(left.lt(right) ? 1 : 0);
      case '>':
        return Variant.int(left.gt(right) ? 1 : 0);
      case '%':
        return left.mod(right);
      case '~':
        return left.buildRange(right);
      case 'd':
        return Variant.int(diceRoll(left.asInt(), right.asInt()));
      default:
        throw new FormulaError(`Unimplemented operator: '${this.op}'`);
    }
  }
}

class WhereExpression implements Expression {
  constructor(
    private readonly body: Expression,
    private readonly clauses: Map<string, Expression>,
  ) {}
  toString(): string {
    const parts = [...this.clauses.entries()].map(([k, v]) => `, [${k}] -> [${v.toString()}]`).join('');
    return `{where:(${this.body.toString()}${parts})}`;
  }
  evaluate(vars: Callable): Variant {
    const cache = new Map<string, Variant>();
    const wrapped: Callable = {
      getValue: (key: string) => {
        const expr = this.clauses.get(key);
        if (expr) {
          const cached = cache.get(key);
          if (cached) return cached;
          const v = expr.evaluate(vars);
          cache.set(key, v);
          return v;
        }
        return vars.getValue(key);
      },
      getInputs: () => [...this.clauses.keys()],
    };
    return this.body.evaluate(wrapped);
  }
}

class FunctionListExpression implements Expression {
  constructor(private readonly symbols: FunctionSymbolTable) {}
  toString(): string {
    return '{function_list_expression()}';
  }
  evaluate(): Variant {
    return Variant.list(this.symbols.getFunctionNames().map((n) => Variant.string(n)));
  }
}

class StringExpression implements Expression {
  private readonly template: string;
  private readonly subs: { pos: number; expr: Expression }[] = [];

  constructor(raw: string) {
    let str = raw;
    let i = 0;
    while (true) {
      const open = str.indexOf('[', i);
      if (open === -1) break;
      let depth = 0;
      let j = open + 1;
      while (j < str.length && (depth > 0 || str[j] !== ']')) {
        if (str[j] === '[') depth++;
        else if (str[j] === ']' && depth > 0) depth--;
        j++;
      }
      if (j >= str.length) break;

      const inner = str.slice(open + 1, j);
      if (j - open === 2 && (inner === '(' || inner === "'" || inner === ')')) {
        const replacement = inner === '(' ? '[' : inner === ')' ? ']' : "'";
        str = str.slice(0, open) + replacement + str.slice(j + 1);
        i = open + 1;
      } else {
        str = str.slice(0, open) + str.slice(j + 1);
        const tokens = tokenize(inner);
        this.subs.push({ pos: open, expr: parseTokens(tokens, FunctionSymbolTable.builtins()) });
        i = open;
      }
    }
    this.template = str;
  }

  toString(): string {
    return `'${this.template}'`;
  }

  evaluate(vars: Callable): Variant {
    if (this.subs.length === 0) return Variant.string(this.template);
    let res = this.template;
    for (let i = this.subs.length - 1; i >= 0; i--) {
      const sub = this.subs[i]!;
      const text = sub.expr.evaluate(vars).stringCast();
      res = res.slice(0, sub.pos) + text + res.slice(sub.pos);
    }
    return Variant.string(res);
  }
}

// ---- token-range helpers (each mirrors a formula.cpp `parse_*` function) ----

function isBracketOpen(t: Token): boolean {
  return t.type === TokenType.LParen || t.type === TokenType.LSquare;
}
function isBracketClose(t: Token): boolean {
  return t.type === TokenType.RParen || t.type === TokenType.RSquare;
}

function parseFunctionArgs(tokens: Token[], start: number, hi: number): { argNames: string[]; starIndex: number; next: number } {
  let i = start;
  if (!tokens[i] || tokens[i]!.type !== TokenType.LParen) {
    throw new FormulaError('Invalid function definition');
  }
  i++;
  const rawNames: string[] = [];
  while (i < hi && tokens[i]!.type !== TokenType.RParen) {
    const t = tokens[i]!;
    if (t.type === TokenType.Identifier) {
      const next = tokens[i + 1];
      if (next && next.text === '*') {
        rawNames.push(t.text + '*');
        i++; // also consume the '*' token
      } else {
        rawNames.push(t.text);
      }
    } else if (t.type === TokenType.Comma) {
      // nothing
    } else {
      throw new FormulaError('Invalid function definition');
    }
    i++;
  }
  if (!tokens[i] || tokens[i]!.type !== TokenType.RParen) {
    throw new FormulaError('Invalid function definition');
  }
  i++;

  let starIndex = -1;
  const argNames = rawNames.map((n, idx) => {
    if (n.endsWith('*')) {
      starIndex = idx;
      return n.slice(0, -1);
    }
    return n;
  });
  return { argNames, starIndex, next: i };
}

function parseArgs(tokens: Token[], lo: number, hi: number, symbols: FunctionSymbolTable): Expression[] {
  const res: Expression[] = [];
  let parens = 0;
  let beg = lo;
  for (let i = lo; i < hi; i++) {
    const t = tokens[i]!;
    if (isBracketOpen(t)) parens++;
    else if (isBracketClose(t)) parens--;
    else if (t.type === TokenType.Comma && parens === 0) {
      res.push(parseExpression(tokens, beg, i, symbols));
      beg = i + 1;
    }
  }
  if (beg !== hi) res.push(parseExpression(tokens, beg, hi, symbols));
  return res;
}

function parseSetArgs(tokens: Token[], lo: number, hi: number, symbols: FunctionSymbolTable): Expression[] {
  const res: Expression[] = [];
  let parens = 0;
  let checkPointer = false;
  let beg = lo;
  for (let i = lo; i < hi; i++) {
    const t = tokens[i]!;
    if (isBracketOpen(t)) parens++;
    else if (isBracketClose(t)) parens--;
    else if (t.type === TokenType.Pointer && parens === 0) {
      if (!checkPointer) {
        checkPointer = true;
        res.push(parseExpression(tokens, beg, i, symbols));
        beg = i + 1;
      } else {
        throw new FormulaError("Too many '->' operators found");
      }
    } else if (t.type === TokenType.Comma && parens === 0) {
      if (checkPointer) checkPointer = false;
      else throw new FormulaError("Expected comma, but '->' found");
      res.push(parseExpression(tokens, beg, i, symbols));
      beg = i + 1;
    }
  }
  if (beg !== hi) res.push(parseExpression(tokens, beg, hi, symbols));
  return res;
}

function parseWhereClauses(tokens: Token[], lo: number, hi: number, symbols: FunctionSymbolTable): Map<string, Expression> {
  const result = new Map<string, Expression>();
  let parens = 0;
  let beg = lo;
  let varName = '';
  for (let i = lo; i < hi; i++) {
    const t = tokens[i]!;
    if (isBracketOpen(t)) {
      parens++;
      continue;
    }
    if (isBracketClose(t)) {
      parens--;
      continue;
    }
    if (parens !== 0) continue;

    if (t.type === TokenType.Comma) {
      if (varName === '') {
        throw new FormulaError("There is 'where <expression>' but 'where name=<expression>' was needed");
      }
      result.set(varName, parseExpression(tokens, beg, i, symbols));
      beg = i + 1;
      varName = '';
    } else if (t.type === TokenType.Operator && t.text === '=') {
      const first = tokens[beg]!;
      if (first.type !== TokenType.Identifier) {
        throw new FormulaError(
          i === lo
            ? "There is 'where <expression>' but 'where name=<expression>' was needed"
            : "There is 'where <expression>=<expression>' but 'where name=<expression>' was needed",
        );
      } else if (beg + 1 !== i) {
        throw new FormulaError("There is 'where name <expression>=<expression>' but 'where name=<expression>' was needed");
      } else if (varName !== '') {
        throw new FormulaError("There is 'where name=name=<expression>' but 'where name=<expression>' was needed");
      }
      varName = first.text;
      beg = i + 1;
    }
  }
  if (beg !== hi) {
    if (varName === '') {
      throw new FormulaError("There is 'where <expression>' but 'where name=<expression>' was needed");
    }
    result.set(varName, parseExpression(tokens, beg, hi, symbols));
  }
  return result;
}

function findSplitOperator(tokens: Token[], lo: number, hi: number): number {
  let parens = 0;
  let opIndex = -1;
  let operatorGroup = false;
  for (let i = lo; i < hi; i++) {
    const t = tokens[i]!;
    if (isBracketOpen(t)) {
      parens++;
    } else if (isBracketClose(t)) {
      parens--;
    } else if (parens === 0 && t.type === TokenType.Operator) {
      if (!operatorGroup && (opIndex === -1 || precedence(tokens[opIndex]!) >= precedence(t))) {
        if (t.text !== '^' || opIndex === -1 || tokens[opIndex]!.text !== '^') {
          opIndex = i;
        }
      }
      operatorGroup = true;
    } else {
      operatorGroup = false;
    }
  }
  return opIndex;
}

function parseDecimalToken(text: string): DecimalExpression {
  const dotIdx = text.indexOf('.');
  const intPart = parseInt(text.slice(0, dotIdx), 10);
  let fracDigits = text.slice(dotIdx + 1);
  if (fracDigits.length > 3) fracDigits = fracDigits.slice(0, 3);
  let f = 0;
  let mult = 100;
  for (const ch of fracDigits) {
    f += (ch.charCodeAt(0) - 48) * mult;
    mult = Math.trunc(mult / 10);
  }
  return new DecimalExpression(intPart, f);
}

/**
 * Core recursive-descent-by-precedence parser, ported from
 * `formula::parse_expression`. `tokens` is the full token array for the
 * formula being parsed; `lo`/`hi` delimit the (possibly nested) sub-range
 * currently being parsed, mirroring upstream's `const token* i1, i2`
 * pointer-pair convention.
 */
export function parseExpression(tokens: Token[], lo: number, hi: number, symbols: FunctionSymbolTable): Expression {
  if (lo >= hi) {
    throw new FormulaError('Empty expression');
  }

  const first = tokens[lo]!;
  const second = tokens[lo + 1];

  if (first.type === TokenType.Keyword && first.text === 'def' && second && second.type === TokenType.Identifier) {
    let i = lo + 1;
    const fnName = tokens[i]!.text;
    i++;
    const { argNames, starIndex, next } = parseFunctionArgs(tokens, i, hi);
    i = next;
    const bodyStart = i;
    while (i < hi && tokens[i]!.type !== TokenType.Semicolon) i++;
    const bodyExpr = parseExpression(tokens, bodyStart, i, symbols);
    const def: UserFunctionDef = { argNames, starArgIndex: starIndex, body: bodyExpr };
    symbols.addUserFunction(fnName, def);

    if (i === hi || i === hi - 1) {
      return new FunctionListExpression(symbols);
    }
    return parseExpression(tokens, i + 1, hi, symbols);
  }

  const opIndex = findSplitOperator(tokens, lo, hi);

  if (opIndex === -1) {
    const last = tokens[hi - 1]!;

    if (first.type === TokenType.LParen && last.type === TokenType.RParen) {
      if (lo + 1 === hi - 1) throw new FormulaError('No expression between parentheses');
      return parseExpression(tokens, lo + 1, hi - 1, symbols);
    }

    if (last.type === TokenType.RSquare) {
      if (hi - lo === 3 && first.type === TokenType.LSquare && tokens[lo + 1]!.type === TokenType.Pointer) {
        return new MapExpression([]);
      }

      let tok = hi - 2;
      let squareParens = 0;
      let isMap = false;
      while (tok > lo && (tokens[tok]!.type !== TokenType.LSquare || squareParens > 0)) {
        if (tokens[tok]!.type === TokenType.RSquare) squareParens++;
        else if (tokens[tok]!.type === TokenType.LSquare) squareParens--;
        else if (tokens[tok]!.type === TokenType.Pointer && squareParens === 0) isMap = true;
        tok--;
      }

      if (tokens[tok]!.type === TokenType.LSquare) {
        if (tok === lo) {
          return isMap
            ? new MapExpression(parseSetArgs(tokens, lo + 1, hi - 1, symbols))
            : new ListExpression(parseArgs(tokens, lo + 1, hi - 1, symbols));
        }
        try {
          return new SquareBracketExpression(
            parseExpression(tokens, lo, tok, symbols),
            parseExpression(tokens, tok + 1, hi - 1, symbols),
          );
        } catch (e) {
          throw new FormulaError((e as Error).message);
        }
      }
    } else if (hi - lo === 1) {
      if (first.type === TokenType.Keyword && first.text === 'functions') {
        return new FunctionListExpression(symbols);
      }
      if (first.type === TokenType.Identifier) return new IdentifierExpression(first.text);
      if (first.type === TokenType.Integer) return new IntegerExpression(parseInt(first.text, 10));
      if (first.type === TokenType.Decimal) return parseDecimalToken(first.text);
      if (first.type === TokenType.String) return new StringExpression(first.text.slice(1, -1));
    } else if (
      first.type === TokenType.Identifier &&
      second &&
      second.type === TokenType.LParen &&
      last.type === TokenType.RParen
    ) {
      let nleft = 0;
      let nright = 0;
      for (let i = lo; i < hi; i++) {
        if (tokens[i]!.type === TokenType.LParen) nleft++;
        else if (tokens[i]!.type === TokenType.RParen) nright++;
      }
      if (nleft === nright) {
        const args = parseArgs(tokens, lo + 2, hi - 1, symbols);
        return symbols.createFunction(first.text, args);
      }
    }

    throw new FormulaError(`Could not parse expression: ${tokensToString(tokens, lo, hi)}`);
  }

  if (opIndex + 1 === hi) {
    throw new FormulaError('Expected another token');
  }

  if (opIndex === lo) {
    return new UnaryOperatorExpression(tokens[opIndex]!.text, parseExpression(tokens, opIndex + 1, hi, symbols));
  }

  const opName = tokens[opIndex]!.text;

  if (opName === '.') {
    return new DotExpression(parseExpression(tokens, lo, opIndex, symbols), parseExpression(tokens, opIndex + 1, hi, symbols));
  }

  if (opName === 'where') {
    const clauses = parseWhereClauses(tokens, opIndex + 1, hi, symbols);
    return new WhereExpression(parseExpression(tokens, lo, opIndex, symbols), clauses);
  }

  return new OperatorExpression(
    opName,
    parseExpression(tokens, lo, opIndex, symbols),
    parseExpression(tokens, opIndex + 1, hi, symbols),
  );
}

/** Parses a full (already-tokenized) formula into an evaluatable Expression. */
export function parseTokens(tokens: Token[], symbols: FunctionSymbolTable): Expression {
  if (tokens.length === 0) return NULL_EXPRESSION;
  return parseExpression(tokens, 0, tokens.length, symbols);
}
