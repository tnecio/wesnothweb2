/**
 * Public entry point: TS port of `wfl::formula` (src/formula/formula.hpp/.cpp).
 *
 * Usage:
 * ```ts
 * const formula = parseFormula("self.hitpoints > self.max_hitpoints / 3");
 * const result = formula.evaluate(context); // context implements Callable
 * result.asBool();
 * ```
 */

import { tokenize } from './tokenizer';
import { NULL_EXPRESSION, parseExpression } from './parser';
import type { Expression } from './expression';
import { FunctionSymbolTable } from './functions';
import type { Callable } from './variant';
import { Variant } from './variant';
import { MapFormulaCallable } from './callable';

export class Formula {
  private readonly expr: Expression;

  constructor(
    public readonly source: string,
    symbols: FunctionSymbolTable = new FunctionSymbolTable(),
  ) {
    const tokens = tokenize(source);
    this.expr = tokens.length === 0 ? NULL_EXPRESSION : parseExpression(tokens, 0, tokens.length, symbols);
  }

  evaluate(context: Callable = new MapFormulaCallable()): Variant {
    return this.expr.evaluate(context);
  }

  toString(): string {
    return this.expr.toString();
  }
}

/** Parses `source` into an evaluatable `Formula`. Throws `FormulaTokenError`/`FormulaError` on invalid input. */
export function parseFormula(source: string, symbols?: FunctionSymbolTable): Formula {
  return new Formula(source, symbols);
}
