/**
 * Helper `Callable` implementations used to build/compose evaluation
 * contexts. Ports the handful of small helper classes from
 * src/formula/callable.hpp and the anonymous-namespace helpers in
 * src/formula/formula.cpp (`dot_callable`, `list_callable`, `map_callable`,
 * `string_callable`, `formula_callable_with_backup`,
 * `formula_variant_callable_with_backup`) that the parser and builtin
 * functions (filter/map/find/reduce/choose/sort/...) need to construct
 * evaluation contexts on the fly.
 */

import type { Callable } from './variant';
import { Variant } from './variant';

/**
 * TS port of `wfl::map_formula_callable`: a simple named-variable bag with
 * an optional fallback callable for keys it doesn't have. Used both as the
 * default top-level evaluation context and to bind function-call arguments
 * to their parameter names.
 */
export class MapFormulaCallable implements Callable {
  private readonly values = new Map<string, Variant>();
  private fallback: Callable | null = null;

  add(key: string, value: Variant): this {
    this.values.set(key, value);
    return this;
  }

  setFallback(fallback: Callable | null): void {
    this.fallback = fallback;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  getValue(key: string): Variant {
    const v = this.values.get(key);
    if (v !== undefined) return v;
    if (this.fallback) return this.fallback.getValue(key);
    return Variant.null_();
  }

  getInputs(): string[] {
    const names = [...this.values.keys()];
    if (this.fallback?.getInputs) names.push(...this.fallback.getInputs());
    return names;
  }
}

/** A context that always resolves to null -- the default top-level scope. */
export const EMPTY_CALLABLE: Callable = { getValue: () => Variant.null_(), getInputs: () => [] };

/**
 * TS port of `formula_callable_with_backup`: try `main` first, fall back to
 * `backup` for any key `main` doesn't resolve (returns a null Variant for).
 */
export function withBackup(main: Callable, backup: Callable): Callable {
  return {
    getValue(key: string): Variant {
      const v = main.getValue(key);
      return v.isNull() ? backup.getValue(key) : v;
    },
    getInputs(): string[] {
      return [...(main.getInputs?.() ?? []), ...(backup.getInputs?.() ?? [])];
    },
  };
}

/**
 * TS port of `formula_variant_callable_with_backup`'s member-lookup half:
 * exposes a Variant's own members (works for callables via `getValue`, for
 * lists/maps/strings via `.getMember`, and for anything via the special
 * `self` key) without a backup -- combine with `withBackup` for the full
 * upstream behaviour.
 */
export function memberCallable(item: Variant): Callable {
  return {
    getValue(key: string): Variant {
      return item.getMember(key);
    },
    getInputs(): string[] {
      return item.isCallable() ? (item.asCallable().getInputs?.() ?? []) : [];
    },
  };
}

/**
 * TS port of `dot_callable`: used to evaluate the right-hand side of `a.b`,
 * looking up `local` (the RHS's own scope: the callable/list/map/string
 * that `a` evaluated to) before falling back to `global` (the outer scope,
 * so `a.b.c` and similar chains keep working, and so unqualified names
 * inside the RHS can still see outer variables).
 */
export function dotCallable(global: Callable, local: Callable): Callable {
  return {
    getValue(key: string): Variant {
      const v = local.getValue(key);
      return v.isNull() ? global.getValue(key) : v;
    },
    getInputs(): string[] {
      return local.getInputs?.() ?? [];
    },
  };
}

/** Properties exposed by `mylist.foo` (`size`, `empty`, `first`, `last`). */
export function listPropsCallable(list: Variant): Callable {
  return {
    getValue(key: string): Variant {
      switch (key) {
        case 'size':
          return Variant.int(list.numElements());
        case 'empty':
          return Variant.int(list.numElements() === 0 ? 1 : 0);
        case 'first':
          return list.numElements() > 0 ? list.at(0) : Variant.null_();
        case 'last':
          return list.numElements() > 0 ? list.at(list.numElements() - 1) : Variant.null_();
        default:
          return Variant.null_();
      }
    },
    getInputs(): string[] {
      return ['size', 'empty', 'first', 'last'];
    },
  };
}

/** Properties exposed by `mymap.foo` (named keys, plus `size`/`empty`). */
export function mapPropsCallable(map: Variant): Callable {
  return {
    getValue(key: string): Variant {
      const k = Variant.string(key);
      if (map.contains(k)) return map.get(k);
      if (key === 'size') return Variant.int(map.numElements());
      if (key === 'empty') return Variant.int(map.numElements() === 0 ? 1 : 0);
      return Variant.null_();
    },
    getInputs(): string[] {
      const inputs = ['size', 'empty'];
      for (const [k] of map.asMap()) {
        if (k.isString() && /^[A-Za-z_]+$/.test(k.asString())) inputs.push(k.asString());
      }
      return inputs;
    },
  };
}

/**
 * Properties exposed by `mystring.foo` (`size`, `empty`, `char`/`chars`,
 * `word`/`words`, `item`/`items`). `item`/`items` uses a simplified,
 * bracket-depth-aware comma split (not a full port of
 * `utils::parenthetical_split`'s quote-handling).
 */
export function stringPropsCallable(strVar: Variant): Callable {
  const s = strVar.asString();
  return {
    getValue(key: string): Variant {
      switch (key) {
        case 'size':
          return Variant.int(s.length);
        case 'empty':
          return Variant.int(s.length === 0 ? 1 : 0);
        case 'char':
        case 'chars':
          return Variant.list([...s].map((c) => Variant.string(c)));
        case 'word':
        case 'words': {
          const words = s.split(/[ \t]+/).filter((w) => w.length > 0);
          return Variant.list(words.map((w) => Variant.string(w)));
        }
        case 'item':
        case 'items':
          return Variant.list(parentheticalSplit(s, ',').map((p) => Variant.string(p)));
        default:
          return Variant.null_();
      }
    },
    getInputs(): string[] {
      return ['size', 'empty', 'char', 'word', 'item'];
    },
  };
}

/** Simplified bracket-depth-aware comma split (see `stringPropsCallable`). */
function parentheticalSplit(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of s) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    if (c === sep && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current.trim());
  return parts;
}
