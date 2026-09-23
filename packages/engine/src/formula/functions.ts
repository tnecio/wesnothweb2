/**
 * TS port of a substantial subset of upstream Wesnoth's WFL builtin function
 * library (src/formula/function.cpp's `namespace builtins`) plus
 * `function_symbol_table`/`user_formula_function` (the `def name(args) ...;`
 * machinery).
 *
 * Deliberately NOT ported (out of scope for this self-contained module --
 * see the port's top-level report for details):
 *  - `debug`, `debug_float`, `debug_print`, `debug_profile`, `dir`,
 *    `get_palette`: depend on the formula debugger / game display / color
 *    palette config, none of which exist yet.
 *  - `byte_index`: depends on the upstream UTF-8 helper; JS strings are
 *    already UTF-16, so the equivalent isn't a direct port.
 *  - `loc`, `distance_between`, `nearest_loc`, `adjacent_locs`,
 *    `locations_in_radius`, `are_adjacent`, `relative_dir`,
 *    `direction_from`, `rotate_loc_around`: depend on `map_location`/hex
 *    geometry, which belongs to the data model another agent is building in
 *    parallel.
 *  - `safe_call`, `set_var` (the `actions` namespace): AI/action-execution
 *    helpers that return `action_callable`s tied to move execution, not
 *    meaningful outside that engine machinery yet.
 */

import type { Callable } from './variant';
import { FormulaTypeError, KeyValuePairCallable, Variant } from './variant';
import { MapFormulaCallable, memberCallable, withBackup } from './callable';
import type { Expression } from './expression';
import { FormulaError } from './expression';

// ---- function_symbol_table / user-defined functions ----

export interface UserFunctionDef {
  /** Parameter names, with any trailing `*` marker already stripped. */
  argNames: string[];
  /** Index into argNames of the "starred" (fallback-providing) argument, or -1. */
  starArgIndex: number;
  body: Expression;
}

type BuiltinFactory = (args: Expression[]) => Expression;

interface FunctionEntry {
  builtin?: BuiltinFactory;
  user?: UserFunctionDef;
}

export class FunctionSymbolTable {
  private readonly custom = new Map<string, FunctionEntry>();
  private readonly parent: FunctionSymbolTable | null;

  constructor(parent?: FunctionSymbolTable | null) {
    this.parent = parent === undefined ? FunctionSymbolTable.builtins() : parent;
  }

  private static builtinsInstance: FunctionSymbolTable | null = null;

  static builtins(): FunctionSymbolTable {
    if (!FunctionSymbolTable.builtinsInstance) {
      const table = new FunctionSymbolTable(null);
      for (const [name, factory] of Object.entries(BUILTIN_FACTORIES)) {
        table.custom.set(name, { builtin: factory });
      }
      FunctionSymbolTable.builtinsInstance = table;
    }
    return FunctionSymbolTable.builtinsInstance;
  }

  /** Registers a host-provided built-in (e.g. game-state functions like `unit_at`, which need the live board). */
  addBuiltin(name: string, factory: (args: Expression[]) => Expression): void {
    this.custom.set(name, { builtin: factory });
  }

  addUserFunction(name: string, def: UserFunctionDef): void {
    this.custom.set(name, { user: def });
  }

  createFunction(name: string, args: Expression[]): Expression {
    const entry = this.custom.get(name);
    if (entry) {
      if (entry.builtin) return entry.builtin(args);
      return new UserFunctionCallExpression(name, args, entry.user!);
    }
    if (this.parent) return this.parent.createFunction(name, args);
    throw new FormulaError(`Unknown function: ${name}`);
  }

  getFunctionNames(): string[] {
    const names = new Set<string>(this.parent ? this.parent.getFunctionNames() : []);
    for (const k of this.custom.keys()) names.add(k);
    return [...names];
  }
}

class UserFunctionCallExpression implements Expression {
  constructor(
    private readonly name: string,
    private readonly args: Expression[],
    private readonly def: UserFunctionDef,
  ) {
    if (args.length !== def.argNames.length) {
      throw new FormulaError(args.length < def.argNames.length ? 'Too few arguments' : 'Too many arguments');
    }
  }

  toString(): string {
    return `${this.name}(${this.args.map((a) => a.toString()).join(',')})`;
  }

  evaluate(vars: Callable): Variant {
    const callable = new MapFormulaCallable();
    for (let n = 0; n < this.def.argNames.length; n++) {
      const value = this.args[n]!.evaluate(vars);
      callable.add(this.def.argNames[n]!, value);
      if (n === this.def.starArgIndex) {
        callable.setFallback(value.asCallable());
      }
    }
    return this.def.body.evaluate(callable);
  }
}

// ---- builtin function scaffolding ----

abstract class FnExpr implements Expression {
  protected constructor(
    protected readonly name: string,
    protected readonly args: Expression[],
    minArgs: number,
    maxArgs: number,
  ) {
    if (args.length < minArgs) throw new FormulaError('Too few arguments');
    if (maxArgs >= 0 && args.length > maxArgs) throw new FormulaError('Too many arguments');
  }

  toString(): string {
    return `${this.name}(${this.args.map((a) => a.toString()).join(',')})`;
  }

  abstract evaluate(vars: Callable): Variant;
}

/** Evaluates a single-or-named-self predicate/mapper expression over one item. */
function evalItemFn(fn: Expression, item: Variant, outer: Callable, selfName: string | null): Variant {
  if (selfName === null) {
    return fn.evaluate(withBackup(memberCallable(item), outer));
  }
  const named = new MapFormulaCallable().add(selfName, item);
  return fn.evaluate(withBackup(named, withBackup(memberCallable(item), outer)));
}

const bool01 = (b: boolean) => Variant.int(b ? 1 : 0);

// ---- control flow ----

class IfFn extends FnExpr {
  constructor(args: Expression[]) {
    super('if', args, 2, -1);
  }
  evaluate(vars: Callable): Variant {
    const n = this.args.length;
    for (let i = 0; i + 1 < n; i += 2) {
      if (this.args[i]!.evaluate(vars).asBool()) return this.args[i + 1]!.evaluate(vars);
    }
    return n % 2 !== 0 ? this.args[n - 1]!.evaluate(vars) : Variant.null_();
  }
}

class SwitchFn extends FnExpr {
  constructor(args: Expression[]) {
    super('switch', args, 3, -1);
  }
  evaluate(vars: Callable): Variant {
    const value = this.args[0]!.evaluate(vars);
    const n = this.args.length;
    for (let i = 1; i + 1 < n; i += 2) {
      if (this.args[i]!.evaluate(vars).eq(value)) return this.args[i + 1]!.evaluate(vars);
    }
    return n % 2 === 0 ? this.args[n - 1]!.evaluate(vars) : Variant.null_();
  }
}

class NullFn extends FnExpr {
  constructor(args: Expression[]) {
    super('null', args, 0, -1);
  }
  evaluate(vars: Callable): Variant {
    for (const a of this.args) a.evaluate(vars);
    return Variant.null_();
  }
}

// ---- numeric ----

class AbsFn extends FnExpr {
  constructor(args: Expression[]) {
    super('abs', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    const v = this.args[0]!.evaluate(vars);
    if (v.isDecimal()) {
      const n = v.asDecimal();
      return Variant.decimalRaw(n >= 0 ? n : -n);
    }
    const n = v.asInt();
    return Variant.int(n >= 0 ? n : -n);
  }
}

class MinFn extends FnExpr {
  constructor(args: Expression[]) {
    super('min', args, 1, -1);
  }
  evaluate(vars: Callable): Variant {
    return reduceExtreme(this.args, vars, (a, b) => a.lt(b));
  }
}

class MaxFn extends FnExpr {
  constructor(args: Expression[]) {
    super('max', args, 1, -1);
  }
  evaluate(vars: Callable): Variant {
    return reduceExtreme(this.args, vars, (a, b) => a.gt(b));
  }
}

function reduceExtreme(args: Expression[], vars: Callable, better: (a: Variant, b: Variant) => boolean): Variant {
  let res = args[0]!.evaluate(vars);
  if (res.isList()) {
    if (res.isEmpty()) throw new FormulaTypeError('min/max(list): list is empty');
    res = extremeOfList(res.asList(), better);
  }
  for (let n = 1; n < args.length; n++) {
    let v = args[n]!.evaluate(vars);
    if (v.isList()) {
      if (v.isEmpty()) continue;
      v = extremeOfList(v.asList(), better);
    }
    if (res.isNull() || better(v, res)) res = v;
  }
  return res;
}

function extremeOfList(list: readonly Variant[], better: (a: Variant, b: Variant) => boolean): Variant {
  let best = list[0]!;
  for (let i = 1; i < list.length; i++) {
    if (better(list[i]!, best)) best = list[i]!;
  }
  return best;
}

function trig(name: string, minArgs: number, maxArgs: number, fn: (args: Expression[], vars: Callable) => number) {
  return class extends FnExpr {
    constructor(args: Expression[]) {
      super(name, args, minArgs, maxArgs);
    }
    evaluate(vars: Callable): Variant {
      const r = fn(this.args, vars);
      if (Number.isNaN(r)) return Variant.null_();
      return Variant.decimalFromNumber(r);
    }
  };
}

const DEG = 180 / Math.PI;
const decArg = (args: Expression[], i: number, vars: Callable) => args[i]!.evaluate(vars).asDecimal() / 1000;

const SinFn = trig('sin', 1, 1, (a, v) => Math.sin((decArg(a, 0, v) * Math.PI) / 180));
const CosFn = trig('cos', 1, 1, (a, v) => Math.cos((decArg(a, 0, v) * Math.PI) / 180));
const TanFn = trig('tan', 1, 1, (a, v) => {
  const r = Math.tan((decArg(a, 0, v) * Math.PI) / 180);
  return Number.isFinite(r) && Math.abs(r) < 2147483647 ? r : NaN;
});
const AsinFn = trig('asin', 1, 1, (a, v) => Math.asin(decArg(a, 0, v)) * DEG);
const AcosFn = trig('acos', 1, 1, (a, v) => Math.acos(decArg(a, 0, v)) * DEG);
const AtanFn = trig('atan', 1, 2, (a, v) =>
  a.length === 1 ? Math.atan(decArg(a, 0, v)) * DEG : Math.atan2(decArg(a, 0, v), decArg(a, 1, v)) * DEG,
);
const SqrtFn = trig('sqrt', 1, 1, (a, v) => Math.sqrt(decArg(a, 0, v)));
const CbrtFn = trig('cbrt', 1, 1, (a, v) => {
  const n = decArg(a, 0, v);
  return n < 0 ? -Math.pow(-n, 1 / 3) : Math.pow(n, 1 / 3);
});
const RootFn = trig('root', 2, 2, (a, v) => {
  const base = decArg(a, 0, v);
  const root = decArg(a, 1, v);
  return base < 0 && root % 2 === 1 ? -Math.pow(-base, 1 / root) : Math.pow(base, 1 / root);
});
const LogFn = trig('log', 1, 2, (a, v) =>
  a.length === 1 ? Math.log(decArg(a, 0, v)) : Math.log(decArg(a, 0, v)) / Math.log(decArg(a, 1, v)),
);
const ExpFn = class extends FnExpr {
  constructor(args: Expression[]) {
    super('exp', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    const r = Math.exp(decArg(this.args, 0, vars));
    if (r === 0 || r >= 2147483647) return Variant.null_();
    return Variant.decimalFromNumber(r);
  }
};
const PiFn = class extends FnExpr {
  constructor(args: Expression[]) {
    super('pi', args, 0, 0);
  }
  evaluate(): Variant {
    return Variant.decimalFromNumber(Math.PI);
  }
};
const HypotFn = trig('hypot', 2, 2, (a, v) => Math.hypot(decArg(a, 0, v), decArg(a, 1, v)));

class WaveFn extends FnExpr {
  constructor(args: Expression[]) {
    super('wave', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    const value = ((this.args[0]!.evaluate(vars).asInt() % 1000) + 1000) % 1000;
    const angle = 2 * Math.PI * (value / 1000);
    return Variant.int(Math.trunc(Math.sin(angle) * 1000));
  }
}

class LerpFn extends FnExpr {
  constructor(args: Expression[]) {
    super('lerp', args, 3, 3);
  }
  evaluate(vars: Callable): Variant {
    const lo = decArg(this.args, 0, vars);
    const hi = decArg(this.args, 1, vars);
    const alpha = decArg(this.args, 2, vars);
    return Variant.decimalRaw(Math.trunc((lo + alpha * (hi - lo)) * 1000));
  }
}

class LerpIndexFn extends FnExpr {
  constructor(args: Expression[]) {
    super('lerp_index', args, 2, 2);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars).asList();
    if (items.length === 0) return Variant.null_();
    const alpha = decArg(this.args, 1, vars);
    const scaled = Math.min(1, Math.max(0, 0.01 * alpha));
    const idx = Math.round((items.length - 1) * scaled);
    return items[idx]!;
  }
}

class ClampFn extends FnExpr {
  constructor(args: Expression[]) {
    super('clamp', args, 3, 3);
  }
  evaluate(vars: Callable): Variant {
    const val = this.args[0]!.evaluate(vars);
    const lo = this.args[1]!.evaluate(vars);
    const hi = this.args[2]!.evaluate(vars);
    if (val.isInt() && lo.isInt() && hi.isInt()) {
      return Variant.int(Math.min(Math.max(val.asInt(), lo.asInt()), hi.asInt()));
    }
    return Variant.decimalRaw(Math.trunc(Math.min(Math.max(val.asDecimal(), lo.asDecimal()), hi.asDecimal())));
  }
}

class CeilFn extends FnExpr {
  constructor(args: Expression[]) {
    super('ceil', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    let d = this.args[0]!.evaluate(vars).asDecimal();
    if (d >= 0 && d % 1000 !== 0) return Variant.int(Math.trunc(d / 1000) + 1);
    return Variant.int(Math.trunc(d / 1000));
  }
}

class RoundFn extends FnExpr {
  constructor(args: Expression[]) {
    super('round', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    const d = this.args[0]!.evaluate(vars).asDecimal();
    const f = d % 1000;
    if (f >= 500) return Variant.int(Math.trunc(d / 1000) + 1);
    if (f <= -500) return Variant.int(Math.trunc(d / 1000) - 1);
    return Variant.int(Math.trunc(d / 1000));
  }
}

class FloorFn extends FnExpr {
  constructor(args: Expression[]) {
    super('floor', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    const d = this.args[0]!.evaluate(vars).asDecimal();
    if (d < 0 && d % 1000 !== 0) return Variant.int(Math.trunc(d / 1000) - 1);
    return Variant.int(Math.trunc(d / 1000));
  }
}

class TruncFn extends FnExpr {
  constructor(args: Expression[]) {
    super('trunc', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.int(this.args[0]!.evaluate(vars).asInt());
  }
}

class FracFn extends FnExpr {
  constructor(args: Expression[]) {
    super('frac', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.decimalRaw(this.args[0]!.evaluate(vars).asDecimal() % 1000);
  }
}

class SgnFn extends FnExpr {
  constructor(args: Expression[]) {
    super('sgn', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    const d = this.args[0]!.evaluate(vars).asDecimal();
    return Variant.int(d === 0 ? 0 : d > 0 ? 1 : -1);
  }
}

class AsDecimalFn extends FnExpr {
  constructor(args: Expression[]) {
    super('as_decimal', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.decimalRaw(this.args[0]!.evaluate(vars).asDecimal());
  }
}

class TypeFn extends FnExpr {
  constructor(args: Expression[]) {
    super('type', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.string(this.args[0]!.evaluate(vars).typeString());
  }
}

// ---- strings ----

function clampOffset(offset: number, length: number): number | null {
  if (offset < 0) {
    offset += length;
    return offset < 0 ? 0 : offset;
  }
  return offset >= length ? null : offset;
}

class SubstringFn extends FnExpr {
  constructor(args: Expression[]) {
    super('substring', args, 2, 3);
  }
  evaluate(vars: Callable): Variant {
    const result = this.args[0]!.evaluate(vars).asString();
    let offset = this.args[1]!.evaluate(vars).asInt();
    const clamped = clampOffset(offset, result.length);
    if (clamped === null) return Variant.string('');
    offset = clamped;
    if (this.args.length > 2) {
      let size = this.args[2]!.evaluate(vars).asInt();
      if (size < 0) {
        size = -size;
        offset = Math.max(0, offset - size + 1);
      }
      return Variant.string(result.substr(offset, size));
    }
    return Variant.string(result.substring(offset));
  }
}

class ReplaceFn extends FnExpr {
  constructor(args: Expression[]) {
    super('replace', args, 3, 4);
  }
  evaluate(vars: Callable): Variant {
    const result = this.args[0]!.evaluate(vars).asString();
    const replacement = this.args[this.args.length - 1]!.evaluate(vars).asString();
    let offset = this.args[1]!.evaluate(vars).asInt();
    if (offset < 0) {
      offset += result.length;
      if (offset < 0) offset = 0;
    } else if (offset >= result.length) {
      return Variant.string(result);
    }
    if (this.args.length > 3) {
      let size = this.args[2]!.evaluate(vars).asInt();
      if (size < 0) {
        size = -size;
        offset = Math.max(0, offset - size + 1);
      }
      return Variant.string(result.slice(0, offset) + replacement + result.slice(offset + size));
    }
    return Variant.string(result.slice(0, offset) + replacement);
  }
}

class ReplaceAllFn extends FnExpr {
  constructor(args: Expression[]) {
    super('replace_all', args, 3, 3);
  }
  evaluate(vars: Callable): Variant {
    const result = this.args[0]!.evaluate(vars).asString();
    const needle = this.args[1]!.evaluate(vars).asString();
    const replacement = this.args[2]!.evaluate(vars).asString();
    if (needle === '') return Variant.string(result);
    return Variant.string(result.split(needle).join(replacement));
  }
}

class StartsWithFn extends FnExpr {
  constructor(args: Expression[]) {
    super('starts_with', args, 2, 2);
  }
  evaluate(vars: Callable): Variant {
    return bool01(this.args[0]!.evaluate(vars).asString().startsWith(this.args[1]!.evaluate(vars).asString()));
  }
}

class EndsWithFn extends FnExpr {
  constructor(args: Expression[]) {
    super('ends_with', args, 2, 2);
  }
  evaluate(vars: Callable): Variant {
    return bool01(this.args[0]!.evaluate(vars).asString().endsWith(this.args[1]!.evaluate(vars).asString()));
  }
}

class InsertFn extends FnExpr {
  constructor(args: Expression[]) {
    super('insert', args, 3, 3);
  }
  evaluate(vars: Callable): Variant {
    const result = this.args[0]!.evaluate(vars).asString();
    const insert = this.args[2]!.evaluate(vars).asString();
    let offset = this.args[1]!.evaluate(vars).asInt();
    if (offset < 0) {
      offset += result.length;
      if (offset < 0) offset = 0;
    } else if (offset >= result.length) {
      return Variant.string(result + insert);
    }
    return Variant.string(result.slice(0, offset) + insert + result.slice(offset));
  }
}

class LengthFn extends FnExpr {
  constructor(args: Expression[]) {
    super('length', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.int(this.args[0]!.evaluate(vars).asString().length);
  }
}

class ConcatenateFn extends FnExpr {
  constructor(args: Expression[]) {
    super('concatenate', args, 1, -1);
  }
  evaluate(vars: Callable): Variant {
    let result = '';
    for (const a of this.args) result += a.evaluate(vars).stringCast();
    return Variant.string(result);
  }
}

class StrUpperFn extends FnExpr {
  constructor(args: Expression[]) {
    super('str_upper', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.string(this.args[0]!.evaluate(vars).asString().toUpperCase());
  }
}

class StrLowerFn extends FnExpr {
  constructor(args: Expression[]) {
    super('str_lower', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.string(this.args[0]!.evaluate(vars).asString().toLowerCase());
  }
}

class ContainsStringFn extends FnExpr {
  constructor(args: Expression[]) {
    super('contains_string', args, 2, 2);
  }
  evaluate(vars: Callable): Variant {
    return bool01(this.args[0]!.evaluate(vars).asString().includes(this.args[1]!.evaluate(vars).asString()));
  }
}

class FindStringFn extends FnExpr {
  constructor(args: Expression[]) {
    super('find_string', args, 2, 2);
  }
  evaluate(vars: Callable): Variant {
    return Variant.int(this.args[0]!.evaluate(vars).asString().indexOf(this.args[1]!.evaluate(vars).asString()));
  }
}

// ---- lists / maps ----

class KeysFn extends FnExpr {
  constructor(args: Expression[]) {
    super('keys', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return this.args[0]!.evaluate(vars).getKeys();
  }
}

class ValuesFn extends FnExpr {
  constructor(args: Expression[]) {
    super('values', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return this.args[0]!.evaluate(vars).getValues();
  }
}

class ToListFn extends FnExpr {
  constructor(args: Expression[]) {
    super('tolist', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.list(this.args[0]!.evaluate(vars).entries());
  }
}

class ToMapFn extends FnExpr {
  constructor(args: Expression[]) {
    super('tomap', args, 1, 2);
  }
  evaluate(vars: Callable): Variant {
    const first = this.args[0]!.evaluate(vars);
    if (this.args.length === 2) {
      const second = this.args[1]!.evaluate(vars);
      if (first.numElements() !== second.numElements()) return Variant.null_();
      const entries: [Variant, Variant][] = [];
      for (let i = 0; i < first.numElements(); i++) entries.push([first.at(i), second.at(i)]);
      return Variant.map(entries);
    }
    const entries: [Variant, Variant][] = [];
    for (const item of first.entries()) {
      const kv = item.tryConvert((c): c is KeyValuePairCallable => c instanceof KeyValuePairCallable);
      if (kv) {
        entries.push([kv.key, kv.value]);
      } else {
        const idx = entries.findIndex(([k]) => Variant.equals(k, item));
        if (idx >= 0) entries[idx] = [item, Variant.int(entries[idx]![1].asInt() + 1)];
        else entries.push([item, Variant.int(1)]);
      }
    }
    return Variant.map(entries);
  }
}

class PairFn extends FnExpr {
  constructor(args: Expression[]) {
    super('pair', args, 2, 2);
  }
  evaluate(vars: Callable): Variant {
    return Variant.callable(new KeyValuePairCallable(this.args[0]!.evaluate(vars), this.args[1]!.evaluate(vars)));
  }
}

class IndexOfFn extends FnExpr {
  constructor(args: Expression[]) {
    super('index_of', args, 2, 2);
  }
  evaluate(vars: Callable): Variant {
    const value = this.args[0]!.evaluate(vars);
    const list = this.args[1]!.evaluate(vars);
    for (let i = 0; i < list.numElements(); i++) {
      if (list.at(i).eq(value)) return Variant.int(i);
    }
    return Variant.int(-1);
  }
}

class ChooseFn extends FnExpr {
  constructor(args: Expression[]) {
    super('choose', args, 2, 3);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    const selfName = this.args.length === 3 ? this.args[1]!.evaluate(vars).asString() : null;
    const scoreFn = this.args[this.args.length - 1]!;
    let best: Variant | null = null;
    let bestScore: Variant | null = null;
    for (const item of items.entries()) {
      const score = evalItemFn(scoreFn, item, vars, selfName);
      if (bestScore === null || score.gt(bestScore)) {
        best = item;
        bestScore = score;
      }
    }
    return best ?? Variant.null_();
  }
}

class SortFn extends FnExpr {
  constructor(args: Expression[]) {
    super('sort', args, 1, 2);
  }
  evaluate(vars: Callable): Variant {
    const list = this.args[0]!.evaluate(vars);
    const items = [...Array(list.numElements()).keys()].map((i) => list.at(i));
    if (this.args.length === 1) {
      items.sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
    } else {
      const cmp = this.args[1]!;
      const less = (a: Variant, b: Variant) => {
        const ctx: Callable = {
          getValue: (key) => (key === 'a' ? a : key === 'b' ? b : vars.getValue(key)),
        };
        return cmp.evaluate(ctx).asBool();
      };
      items.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
    }
    return Variant.list(items);
  }
}

class ReverseFn extends FnExpr {
  constructor(args: Expression[]) {
    super('reverse', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    const arg = this.args[0]!.evaluate(vars);
    if (arg.isString()) return Variant.string([...arg.asString()].reverse().join(''));
    if (arg.isList()) return Variant.list([...arg.asList()].reverse());
    return Variant.null_();
  }
}

class FilterFn extends FnExpr {
  constructor(args: Expression[]) {
    super('filter', args, 2, 3);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    const selfName = this.args.length === 3 ? this.args[1]!.evaluate(vars).asString() : null;
    const predicate = this.args[this.args.length - 1]!;
    const listOut: Variant[] = [];
    const mapOut: [Variant, Variant][] = [];
    for (const item of items.entries()) {
      if (evalItemFn(predicate, item, vars, selfName).asBool()) {
        if (items.isMap()) mapOut.push([item.getMember('key'), item.getMember('value')]);
        else listOut.push(item);
      }
    }
    return items.isMap() ? Variant.map(mapOut) : Variant.list(listOut);
  }
}

class FindFn extends FnExpr {
  constructor(args: Expression[]) {
    super('find', args, 2, 3);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    const selfName = this.args.length === 3 ? this.args[1]!.evaluate(vars).asString() : null;
    const predicate = this.args[this.args.length - 1]!;
    for (const item of items.entries()) {
      if (evalItemFn(predicate, item, vars, selfName).asBool()) return item;
    }
    return Variant.null_();
  }
}

class MapFn extends FnExpr {
  constructor(args: Expression[]) {
    super('map', args, 2, 3);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    const selfName = this.args.length === 3 ? this.args[1]!.evaluate(vars).asString() : null;
    const mapper = this.args[this.args.length - 1]!;
    const listOut: Variant[] = [];
    const mapOut: [Variant, Variant][] = [];
    for (const item of items.entries()) {
      const val = evalItemFn(mapper, item, vars, selfName);
      if (items.isMap()) mapOut.push([item.getMember('key'), val]);
      else listOut.push(val);
    }
    return items.isMap() ? Variant.map(mapOut) : Variant.list(listOut);
  }
}

class TakeWhileFn extends FnExpr {
  constructor(args: Expression[]) {
    super('take_while', args, 2, 2);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    const predicate = this.args[1]!;
    const res: Variant[] = [];
    for (const item of items.entries()) {
      if (!evalItemFn(predicate, item, vars, null).asBool()) break;
      res.push(item);
    }
    return Variant.list(res);
  }
}

class ZipFn extends FnExpr {
  constructor(args: Expression[]) {
    super('zip', args, 1, -1);
  }
  evaluate(vars: Callable): Variant {
    const input = this.args.length === 1 ? this.args[0]!.evaluate(vars).entries() : this.args.map((a) => a.evaluate(vars));
    const maxLen = input.reduce((m, v) => Math.max(m, v.numElements()), 0);
    const output: Variant[] = [];
    for (let i = 0; i < maxLen; i++) {
      output.push(Variant.list(input.map((v) => (i < v.numElements() ? v.at(i) : Variant.null_()))));
    }
    return Variant.list(output);
  }
}

class ReduceFn extends FnExpr {
  constructor(args: Expression[]) {
    super('reduce', args, 2, 3);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    const initial = this.args.length === 2 ? Variant.null_() : this.args[1]!.evaluate(vars);
    const fn = this.args[this.args.length - 1]!;
    const entries = items.entries();
    if (entries.length === 0) return initial;

    // Matches upstream: with no explicit initial value, seed the accumulator
    // from the first element and start folding from the second one instead.
    let idx: number;
    let res: Variant;
    if (initial.isNull()) {
      res = entries[0]!;
      idx = 1;
    } else {
      res = initial;
      idx = 0;
    }

    for (; idx < entries.length; idx++) {
      const ctx = new MapFormulaCallable().add('a', res).add('b', entries[idx]!);
      res = fn.evaluate(withBackup(ctx, withBackup(memberCallable(entries[idx]!), vars)));
    }
    return res;
  }
}

class SumFn extends FnExpr {
  constructor(args: Expression[]) {
    super('sum', args, 1, 2);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    let res: Variant = Variant.int(0);
    if (items.numElements() > 0) {
      const first = items.at(0);
      if (first.isList()) {
        res = this.args.length >= 2 ? this.args[1]!.evaluate(vars) : Variant.list([]);
        if (!res.isList()) return Variant.null_();
      } else if (first.isMap()) {
        res = this.args.length >= 2 ? this.args[1]!.evaluate(vars) : Variant.map([]);
        if (!res.isMap()) return Variant.null_();
      } else if (this.args.length >= 2) {
        res = this.args[1]!.evaluate(vars);
      }
    }
    for (let i = 0; i < items.numElements(); i++) res = res.add(items.at(i));
    return res;
  }
}

class HeadFn extends FnExpr {
  constructor(args: Expression[]) {
    super('head', args, 1, 2);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    const entries = items.entries();
    if (entries.length === 0) return Variant.null_();
    if (this.args.length === 1) return entries[0]!;
    const n = entries.length;
    const req = this.args[1]!.evaluate(vars).asInt();
    const count = req < 0 ? n - Math.min(-req, n) : Math.min(req, n);
    return Variant.list(entries.slice(0, count));
  }
}

class TailFn extends FnExpr {
  constructor(args: Expression[]) {
    super('tail', args, 1, 2);
  }
  evaluate(vars: Callable): Variant {
    const items = this.args[0]!.evaluate(vars);
    const entries = items.entries();
    if (entries.length === 0) return Variant.null_();
    if (this.args.length === 1) return entries[entries.length - 1]!;
    const n = entries.length;
    const req = this.args[1]!.evaluate(vars).asInt();
    const count = req < 0 ? n - Math.min(-req, n) : Math.min(req, n);
    return Variant.list(entries.slice(n - count));
  }
}

class SizeFn extends FnExpr {
  constructor(args: Expression[]) {
    super('size', args, 1, 1);
  }
  evaluate(vars: Callable): Variant {
    return Variant.int(this.args[0]!.evaluate(vars).numElements());
  }
}

// ---- registry ----

const BUILTIN_FACTORIES: Record<string, BuiltinFactory> = {
  if: (a) => new IfFn(a),
  switch: (a) => new SwitchFn(a),
  null: (a) => new NullFn(a),
  abs: (a) => new AbsFn(a),
  min: (a) => new MinFn(a),
  max: (a) => new MaxFn(a),
  sin: (a) => new SinFn(a),
  cos: (a) => new CosFn(a),
  tan: (a) => new TanFn(a),
  asin: (a) => new AsinFn(a),
  acos: (a) => new AcosFn(a),
  atan: (a) => new AtanFn(a),
  sqrt: (a) => new SqrtFn(a),
  cbrt: (a) => new CbrtFn(a),
  root: (a) => new RootFn(a),
  log: (a) => new LogFn(a),
  exp: (a) => new ExpFn(a),
  pi: (a) => new PiFn(a),
  hypot: (a) => new HypotFn(a),
  wave: (a) => new WaveFn(a),
  lerp: (a) => new LerpFn(a),
  lerp_index: (a) => new LerpIndexFn(a),
  clamp: (a) => new ClampFn(a),
  ceil: (a) => new CeilFn(a),
  round: (a) => new RoundFn(a),
  floor: (a) => new FloorFn(a),
  trunc: (a) => new TruncFn(a),
  frac: (a) => new FracFn(a),
  sgn: (a) => new SgnFn(a),
  as_decimal: (a) => new AsDecimalFn(a),
  type: (a) => new TypeFn(a),
  substring: (a) => new SubstringFn(a),
  replace: (a) => new ReplaceFn(a),
  replace_all: (a) => new ReplaceAllFn(a),
  starts_with: (a) => new StartsWithFn(a),
  ends_with: (a) => new EndsWithFn(a),
  insert: (a) => new InsertFn(a),
  length: (a) => new LengthFn(a),
  concatenate: (a) => new ConcatenateFn(a),
  str_upper: (a) => new StrUpperFn(a),
  str_lower: (a) => new StrLowerFn(a),
  contains_string: (a) => new ContainsStringFn(a),
  find_string: (a) => new FindStringFn(a),
  keys: (a) => new KeysFn(a),
  values: (a) => new ValuesFn(a),
  tolist: (a) => new ToListFn(a),
  tomap: (a) => new ToMapFn(a),
  pair: (a) => new PairFn(a),
  index_of: (a) => new IndexOfFn(a),
  choose: (a) => new ChooseFn(a),
  sort: (a) => new SortFn(a),
  reverse: (a) => new ReverseFn(a),
  filter: (a) => new FilterFn(a),
  find: (a) => new FindFn(a),
  map: (a) => new MapFn(a),
  take_while: (a) => new TakeWhileFn(a),
  zip: (a) => new ZipFn(a),
  reduce: (a) => new ReduceFn(a),
  sum: (a) => new SumFn(a),
  head: (a) => new HeadFn(a),
  tail: (a) => new TailFn(a),
  size: (a) => new SizeFn(a),
};
