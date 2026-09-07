/**
 * Public API of the WFL (Wesnoth Formula Language) interpreter port.
 * See ARCHITECTURE.md's "WFL" bullet and formula.ts's module doc.
 */

export { Formula, parseFormula } from './formula';
export { FormulaError } from './expression';
export type { Expression } from './expression';

export { Variant, FormulaTypeError, KeyValuePairCallable } from './variant';
export type { Callable, VariantKind, VariantMapEntry } from './variant';

export {
  MapFormulaCallable,
  EMPTY_CALLABLE,
  withBackup,
  memberCallable,
  dotCallable,
  listPropsCallable,
  mapPropsCallable,
  stringPropsCallable,
} from './callable';

export { FunctionSymbolTable } from './functions';
export type { UserFunctionDef } from './functions';

export { tokenize, TokenType, FormulaTokenError } from './tokenizer';
export type { Token } from './tokenizer';

export { setFormulaDiceRng } from './parser';
