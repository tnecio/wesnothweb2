/**
 * TS port of upstream Wesnoth's `wfl::variant` (src/formula/variant.hpp/.cpp,
 * variant_value.hpp/.cpp). This is the dynamic value type WFL expressions
 * operate on and evaluate to: null, integer, decimal (fixed-point, stored
 * internally as thousandths -- see below), string, list, map (an
 * associative array keyed by variant, sorted like `std::map`), and
 * "callable" (an opaque host object exposing named properties, e.g. a unit
 * or location -- see the `Callable` interface below).
 *
 * Decimal representation: upstream stores a decimal as an `int` scaled by
 * 1000 (so `1.234` is the raw integer `1234`), and all decimal arithmetic
 * (`+ - * / % ^`) operates on that fixed-point representation with specific
 * truncating-then-rounding rules. This port keeps that representation and
 * those exact rules (see `add`/`mul`/`div`/`mod` below) rather than using
 * JS floating point, since unit filter formulas (`formula=`) can depend on
 * the precise rounding behaviour.
 *
 * `Callable` is intentionally minimal -- just enough for `formula=` filters
 * to read named properties off a host object (e.g. `unit.hitpoints`).  The
 * real data model (units, locations, ...) is being built in parallel by
 * another agent; when it lands, it only needs to implement this interface
 * to be usable from WFL. Upstream's `formula_callable` has a lot more
 * machinery (mutation, "self" auto-injection, iteration input lists,
 * ordering/equality for use as map keys) -- ported here as *optional*
 * methods so a minimal host object needs only `getValue`.
 */

export interface Callable {
  /** Returns the named property, or a null Variant if it doesn't exist. */
  getValue(key: string): Variant;
  /**
   * Lists the names this object exposes, for iteration (`tolist(obj)`,
   * `dir()`-style introspection) and for debug-string dumps. Optional --
   * objects that don't implement it simply can't be iterated.
   */
  getInputs?(): string[];
  /** Optional custom equality, otherwise falls back to reference identity. */
  equalsCallable?(other: Callable): boolean;
  /** Optional custom ordering, otherwise falls back to an arbitrary but stable order. */
  lessCallable?(other: Callable): boolean;
}

export type VariantKind = 'null' | 'integer' | 'decimal' | 'object' | 'list' | 'string' | 'map';

// Matches formula_variant.hpp's declared enum order, used for cross-type `<`
// fallback comparisons (e.g. an int is always "less than" a string).
const KIND_ORDER: Record<VariantKind, number> = {
  null: 0,
  integer: 1,
  decimal: 2,
  object: 3,
  list: 4,
  string: 5,
  map: 6,
};

export class FormulaTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaTypeError';
  }
}

let callableOrdinalCounter = 0;
const callableOrdinals = new WeakMap<Callable, number>();
function ordinalFor(c: Callable): number {
  let id = callableOrdinals.get(c);
  if (id === undefined) {
    id = ++callableOrdinalCounter;
    callableOrdinals.set(c, id);
  }
  return id;
}

export type VariantMapEntry = readonly [Variant, Variant];

export class Variant {
  private constructor(
    private readonly kind: VariantKind,
    /** Integer payload: the int value, or a decimal's raw thousandths. */
    private readonly num = 0,
    private readonly str = '',
    private readonly listItems: readonly Variant[] = [],
    private readonly mapItems: readonly VariantMapEntry[] = [],
    private readonly obj: Callable | null = null,
  ) {}

  // ---- construction ----

  private static readonly NULL_INSTANCE = new Variant('null');

  static null_(): Variant {
    return Variant.NULL_INSTANCE;
  }

  static int(n: number): Variant {
    return new Variant('integer', Math.trunc(n));
  }

  /** Raw thousandths, matching C++'s `variant(int, DECIMAL_VARIANT)`. */
  static decimalRaw(thousandths: number): Variant {
    return new Variant('decimal', Math.trunc(thousandths));
  }

  /** Matches C++'s `variant(double, DECIMAL_VARIANT)` rounding. */
  static decimalFromNumber(n: number): Variant {
    const scaled = n * 1000;
    let truncated = Math.trunc(scaled);
    const remainder = scaled - truncated;
    if (remainder > 0.5) truncated++;
    else if (remainder < -0.5) truncated--;
    return new Variant('decimal', truncated);
  }

  static string(s: string): Variant {
    return new Variant('string', 0, s);
  }

  static list(items: readonly Variant[]): Variant {
    return new Variant('list', 0, '', items);
  }

  static map(entries: readonly VariantMapEntry[]): Variant {
    return new Variant('map', 0, '', [], buildSortedMap(entries));
  }

  static callable(c: Callable): Variant {
    return new Variant('object', 0, '', [], [], c);
  }

  // ---- type queries ----

  isNull(): boolean {
    return this.kind === 'null';
  }
  isInt(): boolean {
    return this.kind === 'integer';
  }
  isDecimal(): boolean {
    return this.kind === 'decimal';
  }
  isCallable(): boolean {
    return this.kind === 'object';
  }
  isList(): boolean {
    return this.kind === 'list';
  }
  isString(): boolean {
    return this.kind === 'string';
  }
  isMap(): boolean {
    return this.kind === 'map';
  }
  typeString(): VariantKind {
    return this.kind;
  }

  // ---- conversions ----

  asInt(fallback = 0): number {
    if (this.isNull()) return fallback;
    if (this.isDecimal()) return Math.trunc(this.num / 1000);
    this.mustBe('integer');
    return this.num;
  }

  /** Raw thousandths (matches C++'s `as_decimal`). */
  asDecimal(fallback = 0): number {
    if (this.isDecimal()) return this.num;
    if (this.isInt()) return this.num * 1000;
    if (this.isNull()) return fallback;
    throw new FormulaTypeError(this.expectedMsg('an integer or a decimal'));
  }

  asBool(): boolean {
    switch (this.kind) {
      case 'null':
        return false;
      case 'integer':
      case 'decimal':
        return this.num !== 0;
      case 'string':
        return this.str.length > 0;
      case 'list':
        return this.listItems.length > 0;
      case 'map':
        return this.mapItems.length > 0;
      case 'object':
        return this.obj !== null;
    }
  }

  asString(): string {
    this.mustBe('string');
    return this.str;
  }

  asList(): readonly Variant[] {
    this.mustBe('list');
    return this.listItems;
  }

  asMap(): readonly VariantMapEntry[] {
    this.mustBe('map');
    return this.mapItems;
  }

  asCallable(): Callable {
    this.mustBe('object');
    // Guaranteed non-null: the only constructor for 'object' takes a Callable.
    return this.obj as Callable;
  }

  /** Attempts to narrow the underlying callable to a specific class/shape. */
  tryConvert<T extends Callable>(guard: (c: Callable) => c is T): T | null {
    if (!this.isCallable()) return null;
    const c = this.asCallable();
    return guard(c) ? c : null;
  }

  // ---- indexing / member access ----

  isEmpty(): boolean {
    switch (this.kind) {
      case 'string':
        return this.str.length === 0;
      case 'list':
        return this.listItems.length === 0;
      case 'map':
        return this.mapItems.length === 0;
      default:
        return true;
    }
  }

  numElements(): number {
    if (!this.isList() && !this.isMap()) {
      throw new FormulaTypeError(this.expectedMsg('a list or a map'));
    }
    return this.isList() ? this.listItems.length : this.mapItems.length;
  }

  /** `operator[](size_t)`: positional list index (or `this` for a callable). */
  at(index: number): Variant {
    if (this.isCallable()) return this;
    this.mustBe('list');
    if (index < 0 || index >= this.listItems.length) {
      throw new FormulaTypeError('invalid index');
    }
    return this.listItems[index]!;
  }

  /** `operator[](variant)`: list/map indexing, incl. negative & list-of-indices. */
  get(key: Variant): Variant {
    if (this.isCallable()) return this;
    if (this.isMap()) {
      const found = this.mapItems.find(([k]) => Variant.equals(k, key));
      return found ? found[1] : Variant.null_();
    }
    if (this.isList()) {
      if (key.isList()) {
        return Variant.list(key.listItems.map((k) => this.get(k)));
      }
      const idx = key.asInt();
      if (idx < 0) return this.at(this.listItems.length + idx);
      return this.at(idx);
    }
    throw new FormulaTypeError(this.expectedMsg('a list or a map'));
  }

  /** Property access used by `.` and by predicate contexts (`self.x`, item member lookup). */
  getMember(name: string): Variant {
    if (this.isCallable()) {
      return this.asCallable().getValue(name);
    }
    if (name === 'self') return this;
    return Variant.null_();
  }

  getKeys(): Variant {
    this.mustBe('map');
    return Variant.list(this.mapItems.map(([k]) => k));
  }

  getValues(): Variant {
    this.mustBe('map');
    return Variant.list(this.mapItems.map(([, v]) => v));
  }

  contains(other: Variant): boolean {
    if (this.isList()) return this.listItems.some((v) => Variant.equals(v, other));
    if (this.isMap()) return this.mapItems.some(([k]) => Variant.equals(k, other));
    throw new FormulaTypeError(this.expectedMsg('a list or a map'));
  }

  /**
   * Iteration elements, matching `variant::begin()/end()`: list elements,
   * map entries (as key/value callables), or -- for a callable that
   * declares `getInputs` -- its property values in that order. Everything
   * else iterates as empty (matches upstream: only list/map/object override
   * `make_iterator`).
   */
  entries(): Variant[] {
    switch (this.kind) {
      case 'list':
        return [...this.listItems];
      case 'map':
        return this.mapItems.map(([k, v]) => Variant.callable(new KeyValuePairCallable(k, v)));
      case 'object': {
        const inputs = this.obj?.getInputs?.() ?? [];
        return inputs.map((name) => this.obj!.getValue(name));
      }
      default:
        return [];
    }
  }

  // ---- arithmetic ----

  add(other: Variant): Variant {
    if (this.isList() && other.isList()) {
      return Variant.list([...this.listItems, ...other.listItems]);
    }
    if (this.isMap() && other.isMap()) {
      const merged: VariantMapEntry[] = this.mapItems.map((e) => e);
      for (const [k, v] of other.mapItems) {
        const idx = merged.findIndex(([ek]) => Variant.equals(ek, k));
        if (idx >= 0) merged[idx] = [k, v];
        else merged.push([k, v]);
      }
      return Variant.map(merged);
    }
    if (this.isDecimal() || other.isDecimal()) {
      return Variant.decimalRaw(this.asDecimal() + other.asDecimal());
    }
    return Variant.int(this.asInt() + other.asInt());
  }

  sub(other: Variant): Variant {
    if (this.isDecimal() || other.isDecimal()) {
      return Variant.decimalRaw(this.asDecimal() - other.asDecimal());
    }
    return Variant.int(this.asInt() - other.asInt());
  }

  mul(other: Variant): Variant {
    if (this.isDecimal() || other.isDecimal()) {
      let longInt = this.asDecimal() * other.asDecimal();
      longInt = Math.trunc(longInt / 100);
      if (Math.trunc(longInt % 10) >= 5) {
        longInt = Math.trunc(longInt / 10) + 1;
      } else {
        longInt = Math.trunc(longInt / 10);
      }
      return Variant.decimalRaw(longInt);
    }
    return Variant.int(this.asInt() * other.asInt());
  }

  div(other: Variant): Variant {
    if (this.isDecimal() || other.isDecimal()) {
      const denominator = other.asDecimal();
      if (denominator === 0) throw new FormulaTypeError('decimal divide by zero error');
      let longInt = this.asDecimal() * 10000;
      longInt = Math.trunc(longInt / denominator);
      if (Math.trunc(longInt % 10) >= 5) {
        longInt = Math.trunc(longInt / 10) + 1;
      } else {
        longInt = Math.trunc(longInt / 10);
      }
      return Variant.decimalRaw(longInt);
    }
    const numerator = this.asInt();
    const denominator = other.asInt();
    if (denominator === 0) throw new FormulaTypeError('int divide by zero error');
    return Variant.int(Math.trunc(numerator / denominator));
  }

  mod(other: Variant): Variant {
    if (this.isDecimal() || other.isDecimal()) {
      const numerator = this.asDecimal();
      const denominator = other.asDecimal();
      if (denominator === 0) throw new FormulaTypeError('divide by zero error');
      return Variant.decimalRaw(numerator % denominator);
    }
    const numerator = this.asInt();
    const denominator = other.asInt();
    if (denominator === 0) throw new FormulaTypeError('divide by zero error');
    return Variant.int(numerator % denominator);
  }

  pow(other: Variant): Variant {
    if (this.isDecimal() || other.isDecimal()) {
      const res = Math.pow(this.asDecimal() / 1000, other.asDecimal() / 1000);
      if (Number.isNaN(res)) return Variant.null_();
      return Variant.decimalFromNumber(res);
    }
    return Variant.int(Math.round(Math.pow(this.asInt(), other.asInt())));
  }

  neg(): Variant {
    if (this.isDecimal()) return Variant.decimalRaw(-this.asDecimal());
    return Variant.int(-this.asInt());
  }

  listElementsAdd(other: Variant): Variant {
    return Variant.zipTransform(this, other, (a, b) => a.add(b));
  }
  listElementsSub(other: Variant): Variant {
    return Variant.zipTransform(this, other, (a, b) => a.sub(b));
  }
  listElementsMul(other: Variant): Variant {
    return Variant.zipTransform(this, other, (a, b) => a.mul(b));
  }
  listElementsDiv(other: Variant): Variant {
    return Variant.zipTransform(this, other, (a, b) => a.div(b));
  }

  private static zipTransform(a: Variant, b: Variant, op: (x: Variant, y: Variant) => Variant): Variant {
    a.mustBe('list');
    b.mustBe('list');
    const la = a.listItems;
    const lb = b.listItems;
    if (la.length !== lb.length) {
      throw new FormulaTypeError('zip_transform requires two lists of the same length');
    }
    return Variant.list(la.map((v, i) => op(v, lb[i]!)));
  }

  concatenate(other: Variant): Variant {
    if (this.isList()) {
      other.mustBe('list');
      return Variant.list([...this.listItems, ...other.listItems]);
    }
    if (this.isString()) {
      other.mustBe('string');
      return Variant.string(this.str + other.str);
    }
    throw new FormulaTypeError(this.expectedMsg('a list or a string'));
  }

  /** The `~` "build range" operator: `1~5` -> `[1,2,3,4,5]`. */
  buildRange(other: Variant): Variant {
    this.mustBe('integer');
    other.mustBe('integer');
    const start = this.num;
    const limit = other.num;
    const len = Math.abs(limit - start) + 1;
    const res: Variant[] = [];
    let i = start;
    for (let k = 0; k < len; k++) {
      res.push(Variant.int(i));
      i += start < limit ? 1 : -1;
    }
    return Variant.list(res);
  }

  // ---- comparisons ----

  eq(other: Variant): boolean {
    return Variant.equals(this, other);
  }
  ne(other: Variant): boolean {
    return !Variant.equals(this, other);
  }
  lt(other: Variant): boolean {
    return Variant.lessThan(this, other);
  }
  gt(other: Variant): boolean {
    return Variant.lessThan(other, this);
  }
  le(other: Variant): boolean {
    return !Variant.lessThan(other, this);
  }
  ge(other: Variant): boolean {
    return !Variant.lessThan(this, other);
  }

  static equals(a: Variant, b: Variant): boolean {
    if (a.kind !== b.kind) {
      if (a.isDecimal() || b.isDecimal()) return a.asDecimal() === b.asDecimal();
      return false;
    }
    switch (a.kind) {
      case 'null':
        return true;
      case 'integer':
      case 'decimal':
        return a.num === b.num;
      case 'string':
        return a.str === b.str;
      case 'list':
        return (
          a.listItems.length === b.listItems.length &&
          a.listItems.every((v, i) => Variant.equals(v, b.listItems[i]!))
        );
      case 'map':
        return (
          a.mapItems.length === b.mapItems.length &&
          a.mapItems.every(([k, v], i) => {
            const other = b.mapItems[i]!;
            return Variant.equals(k, other[0]) && Variant.equals(v, other[1]);
          })
        );
      case 'object': {
        if (a.obj && b.obj) {
          if (a.obj.equalsCallable) return a.obj.equalsCallable(b.obj);
          return a.obj === b.obj;
        }
        return a.obj === b.obj;
      }
    }
  }

  static lessThan(a: Variant, b: Variant): boolean {
    if (a.kind !== b.kind) {
      if (a.isDecimal() && b.isInt()) return a.asDecimal() < b.asDecimal();
      if (b.isDecimal() && a.isInt()) return a.asDecimal() < b.asDecimal();
      return KIND_ORDER[a.kind] < KIND_ORDER[b.kind];
    }
    switch (a.kind) {
      case 'null':
        return false;
      case 'integer':
      case 'decimal':
        return a.num < b.num;
      case 'string':
        return a.str < b.str;
      case 'list': {
        const n = Math.min(a.listItems.length, b.listItems.length);
        for (let i = 0; i < n; i++) {
          if (Variant.lessThan(a.listItems[i]!, b.listItems[i]!)) return true;
          if (Variant.lessThan(b.listItems[i]!, a.listItems[i]!)) return false;
        }
        return a.listItems.length < b.listItems.length;
      }
      case 'map': {
        const n = Math.min(a.mapItems.length, b.mapItems.length);
        for (let i = 0; i < n; i++) {
          const [ak, av] = a.mapItems[i]!;
          const [bk, bv] = b.mapItems[i]!;
          if (Variant.lessThan(ak, bk)) return true;
          if (Variant.lessThan(bk, ak)) return false;
          if (Variant.lessThan(av, bv)) return true;
          if (Variant.lessThan(bv, av)) return false;
        }
        return a.mapItems.length < b.mapItems.length;
      }
      case 'object': {
        if (a.obj && b.obj) {
          if (a.obj.lessCallable) return a.obj.lessCallable(b.obj);
          return ordinalFor(a.obj) < ordinalFor(b.obj);
        }
        return a.obj === null && b.obj !== null;
      }
    }
  }

  // ---- string conversion ----

  stringCast(): string {
    switch (this.kind) {
      case 'null':
        return '0';
      case 'integer':
        return String(this.num);
      case 'decimal':
        return decimalToString(this.num, false);
      case 'string':
        return this.str;
      case 'list':
        return this.listItems.map((v) => v.stringCast()).join(', ');
      case 'map':
        return this.mapItems.map(([k, v]) => `${k.stringCast()}->${v.stringCast()}`).join(', ');
      case 'object':
        return '(object)';
    }
  }

  /**
   * Round-trippable WFL-literal form. Note: faithfully reproduces an
   * upstream quirk where an *empty* list and an empty map both serialize as
   * `[->]` (variant_container::to_string_impl's `annotate_empty` special
   * case doesn't distinguish container kind for the empty case).
   */
  serializeToString(): string {
    switch (this.kind) {
      case 'null':
        return 'null()';
      case 'integer':
        return String(this.num);
      case 'decimal':
        return decimalToString(this.num, false);
      case 'string':
        return serializeString(this.str);
      case 'list':
        return this.listItems.length === 0
          ? '[->]'
          : `[${this.listItems.map((v) => v.serializeToString()).join(', ')}]`;
      case 'map':
        return this.mapItems.length === 0
          ? '[->]'
          : `[${this.mapItems.map(([k, v]) => `${k.serializeToString()}->${v.serializeToString()}`).join(', ')}]`;
      case 'object':
        return ''; // Would delegate to the callable's own serialize(); not modeled here.
    }
  }

  toDebugString(verbose = false, seen: Set<Callable> = new Set()): string {
    switch (this.kind) {
      case 'null':
        return 'null()';
      case 'integer':
        return String(this.num);
      case 'decimal':
        return decimalToString(this.num, true);
      case 'string':
        return this.str;
      case 'list':
        return `[${this.listItems.map((v) => v.toDebugString(verbose, seen)).join(', ')}]`;
      case 'map':
        return `[${this.mapItems
          .map(([k, v]) => `${k.toDebugString(verbose, seen)}->${v.toDebugString(verbose, seen)}`)
          .join(', ')}]`;
      case 'object': {
        if (!this.obj) return '{null}';
        if (seen.has(this.obj)) return '{...}';
        if (!verbose) seen.add(this.obj);
        const inputs = this.obj.getInputs?.() ?? [];
        const parts = inputs.map((name) => `${name} -> ${this.obj!.getValue(name).toDebugString(verbose, seen)}`);
        return `{${parts.join(', ')}}`;
      }
    }
  }

  // ---- internal helpers ----

  private mustBe(kind: VariantKind): void {
    if (this.kind !== kind) {
      throw new FormulaTypeError(this.expectedMsg(kind));
    }
  }

  private expectedMsg(expected: string): string {
    return `TYPE ERROR: expected ${expected} but found ${this.typeString()} (${this.toDebugString()})`;
  }
}

function decimalToString(raw: number, signValue: boolean): string {
  const fractional = raw % 1000;
  const integer = (raw - fractional) / 1000;
  let s = '';
  if (signValue && integer === 0 && raw < 0) s += '-';
  s += String(integer) + '.';
  const absFrac = Math.abs(fractional);
  if (absFrac < 100) s += absFrac < 10 ? '00' : '0';
  s += String(absFrac);
  return s;
}

function serializeString(s: string): string {
  let out = "'";
  for (const c of s) {
    if (c === "'") out += "[']";
    else if (c === '[') out += '[(]';
    else if (c === ']') out += '[)]';
    else out += c;
  }
  return out + "'";
}

function buildSortedMap(entries: readonly VariantMapEntry[]): VariantMapEntry[] {
  const result: VariantMapEntry[] = [];
  for (const [k, v] of entries) {
    const idx = result.findIndex(([ek]) => Variant.equals(ek, k));
    if (idx >= 0) result[idx] = [k, v];
    else result.push([k, v]);
  }
  result.sort(([ak], [bk]) => (Variant.lessThan(ak, bk) ? -1 : Variant.lessThan(bk, ak) ? 1 : 0));
  return result;
}

/**
 * TS port of `wfl::key_value_pair` (src/formula/function.hpp/.cpp): the
 * callable wrapper used to represent a map entry during iteration
 * (`variant_map::deref_iterator`) and by the `pair()` builtin function.
 */
export class KeyValuePairCallable implements Callable {
  constructor(
    public readonly key: Variant,
    public readonly value: Variant,
  ) {}

  getValue(key: string): Variant {
    if (key === 'key') return this.key;
    if (key === 'value') return this.value;
    return Variant.null_();
  }

  getInputs(): string[] {
    return ['key', 'value'];
  }
}
