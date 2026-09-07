/**
 * The evaluatable-node contract shared by the parser (src/formula/formula.cpp's
 * expression classes) and the builtin/user function machinery
 * (src/formula/function.hpp's `formula_expression`). Kept in its own module
 * so `parser.ts` and `functions.ts` can both depend on it without an import
 * cycle between them (mirroring upstream's `formula.hpp` <-> `function.hpp`
 * mutual dependency, which C++ tolerates via forward declarations but a
 * from-scratch ES module graph should just avoid).
 */

import type { Callable, Variant } from './variant';

export interface Expression {
  evaluate(vars: Callable): Variant;
  toString(): string;
}

/** TS port of `wfl::formula_error` (thrown for both parse- and eval-time faults). */
export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}
