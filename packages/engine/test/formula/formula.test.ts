import { afterEach, describe, expect, it } from 'vitest';
import {
  type Callable,
  FormulaError,
  FormulaTypeError,
  MapFormulaCallable,
  parseFormula,
  setFormulaDiceRng,
  Variant,
} from '../../src/formula/index';

/** A minimal mock "unit" Callable, standing in for the real data model. */
class MockUnitCallable implements Callable {
  constructor(private readonly props: Record<string, Variant>) {}
  getValue(key: string): Variant {
    return this.props[key] ?? Variant.null_();
  }
  getInputs(): string[] {
    return Object.keys(this.props);
  }
}

function evalFormula(source: string, context?: Callable): Variant {
  return parseFormula(source).evaluate(context);
}

describe('WFL parser + evaluator: core grammar', () => {
  it('respects arithmetic operator precedence', () => {
    expect(evalFormula('2 + 3 * 4').asInt()).toBe(14);
    expect(evalFormula('(2 + 3) * 4').asInt()).toBe(20);
    expect(evalFormula('2 ^ 3 ^ 2').asInt()).toBe(512); // right-associative: 2^(3^2)
  });

  it('evaluates comparisons and equality', () => {
    expect(evalFormula('3 < 5').asBool()).toBe(true);
    expect(evalFormula('5 <= 5').asBool()).toBe(true);
    expect(evalFormula("'a' != 'b'").asBool()).toBe(true);
    expect(evalFormula('3 = 3.0').asBool()).toBe(true); // int/decimal cross-type equality
  });

  it('evaluates and/or/not (non-short-circuiting, matching upstream)', () => {
    expect(evalFormula('1 and 0').asInt()).toBe(0);
    expect(evalFormula('0 or 5').asInt()).toBe(5);
    expect(evalFormula('not 0').asInt()).toBe(1);
    expect(evalFormula('not 1').asInt()).toBe(0);
  });

  it('parses and evaluates list literals and indexing', () => {
    expect(evalFormula('[1,2,3][1]').asInt()).toBe(2);
    expect(evalFormula('[1,2,3][-1]').asInt()).toBe(3);
    expect(evalFormula('[1,2,3].size').asInt()).toBe(3);
    expect(evalFormula('[].empty').asBool()).toBe(true);
  });

  it('parses and evaluates map literals and indexing', () => {
    expect(evalFormula("['a'->1,'b'->2]['b']").asInt()).toBe(2);
    expect(evalFormula("['a'->1,'b'->2].a").asInt()).toBe(1);
    expect(evalFormula('[->].empty').asBool()).toBe(true);
  });

  it('evaluates the `in` membership operator for lists and map keys', () => {
    expect(evalFormula('3 in [1,2,3]').asBool()).toBe(true);
    expect(evalFormula('4 in [1,2,3]').asBool()).toBe(false);
    expect(evalFormula("'k' in ['k'->1]").asBool()).toBe(true);
  });

  it('evaluates string concatenation and substitution', () => {
    expect(evalFormula("'foo' .. 'bar'").asString()).toBe('foobar');
    expect(evalFormula("'Hello [1+1]!'").asString()).toBe('Hello 2!');
  });

  it('builds integer ranges and does elementwise list arithmetic', () => {
    expect(evalFormula('(1~4)').asList().map((v) => v.asInt())).toEqual([1, 2, 3, 4]);
    expect(evalFormula('[1,2] .+ [3,4]').asList().map((v) => v.asInt())).toEqual([4, 6]);
  });

  it('evaluates decimal arithmetic', () => {
    expect(evalFormula('1.5 + 2.25').stringCast()).toBe('3.750');
  });
});

describe('WFL parser + evaluator: functions', () => {
  it('if/switch control flow', () => {
    expect(evalFormula("if(1>0, 'yes', 'no')").asString()).toBe('yes');
    expect(evalFormula("if(1<0, 'yes', 'no')").asString()).toBe('no');
    expect(evalFormula("switch(2, 1,'one', 2,'two', 'other')").asString()).toBe('two');
  });

  it('list/map higher-order functions', () => {
    expect(evalFormula('filter([1,2,3,4], self > 2)').asList().map((v) => v.asInt())).toEqual([3, 4]);
    expect(evalFormula('map([1,2,3], self * 2)').asList().map((v) => v.asInt())).toEqual([2, 4, 6]);
    expect(evalFormula('find([1,2,3,4], self > 2)').asInt()).toBe(3);
    expect(evalFormula('reduce([1,2,3,4], a + b)').asInt()).toBe(10);
    expect(evalFormula('sum([1,2,3])').asInt()).toBe(6);
    expect(evalFormula('sort([3,1,2])').asList().map((v) => v.asInt())).toEqual([1, 2, 3]);
    expect(evalFormula('choose([1,5,3], self)').asInt()).toBe(5);
    expect(evalFormula('head([1,2,3])').asInt()).toBe(1);
    expect(evalFormula('tail([1,2,3])').asInt()).toBe(3);
    expect(evalFormula('zip([1,2],[3,4])').asList().map((l) => l.asList().map((v) => v.asInt()))).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it('map/keys/values', () => {
    expect(evalFormula("keys(['a'->1,'b'->2])").asList().map((v) => v.asString())).toEqual(['a', 'b']);
    expect(evalFormula("values(['a'->1,'b'->2])").asList().map((v) => v.asInt())).toEqual([1, 2]);
    expect(evalFormula('index_of(2, [1,2,3])').asInt()).toBe(1);
  });

  it('string functions', () => {
    expect(evalFormula("concatenate('a','b','c')").asString()).toBe('abc');
    expect(evalFormula("substring('hello', 1, 3)").asString()).toBe('ell');
    expect(evalFormula("str_upper('abc')").asString()).toBe('ABC');
    expect(evalFormula("starts_with('hello','he')").asBool()).toBe(true);
  });

  it('math functions', () => {
    expect(evalFormula('abs(-5)').asInt()).toBe(5);
    expect(evalFormula('min(3,1,2)').asInt()).toBe(1);
    expect(evalFormula('max(3,1,2)').asInt()).toBe(3);
    expect(evalFormula('sqrt(2.25)').stringCast()).toBe('1.500');
  });
});

describe('WFL parser + evaluator: def and where', () => {
  it('defines and calls a user function', () => {
    expect(evalFormula('def double(x) x * 2; double(21)').asInt()).toBe(42);
  });

  it('does NOT support self-recursion within a single def (faithful upstream quirk)', () => {
    // Matches upstream exactly: `symbols->add_function(name, ...)` only runs
    // *after* `std::make_shared<const formula>(body_tokens, symbols)` has
    // fully parsed the body (C++ must finish evaluating a call's arguments
    // before making the call) -- so a self-call inside the body resolves
    // against a symbol table that doesn't have `fact` yet. This isn't a
    // simplification on our part: it's how WFL's `def` actually behaves.
    const src = 'def fact(n) if(n <= 1, 1, n * fact(n - 1)); fact(5)';
    expect(() => evalFormula(src)).toThrow(/Unknown function: fact/);
  });

  it('evaluates where clauses', () => {
    expect(evalFormula('a + b where a=1, b=2').asInt()).toBe(3);
  });
});

describe('WFL parser + evaluator: dice roll', () => {
  afterEach(() => {
    setFormulaDiceRng((faces) => Math.floor(Math.random() * faces));
  });

  it('rolls dice using the pluggable RNG hook', () => {
    setFormulaDiceRng(() => 0); // always rolls a 1 on every die
    expect(evalFormula('2d6').asInt()).toBe(2);
  });
});

describe('WFL parser + evaluator: Callable integration', () => {
  function unitContext(): Callable {
    const self = new MockUnitCallable({
      hitpoints: Variant.int(20),
      max_hitpoints: Variant.int(32),
      resting: Variant.int(1),
      level: Variant.int(2),
    });
    const other = new MockUnitCallable({ level: Variant.int(3) });
    return new MapFormulaCallable()
      .add('self', Variant.callable(self))
      .add('other', Variant.callable(other))
      .add('level', Variant.int(2));
  }

  it('reads a property off a mock Callable object', () => {
    expect(evalFormula('self.hitpoints', unitContext()).asInt()).toBe(20);
    expect(evalFormula('self.resting', unitContext()).asBool()).toBe(true);
  });

  it('compares properties across two Callable objects', () => {
    expect(evalFormula('level < other.level', unitContext()).asBool()).toBe(true);
  });
});

describe('WFL parser + evaluator: real formula= examples from data/core', () => {
  // wesnoth/data/core/macros/unit-utils.cfg
  it('self.hitpoints <= self.max_hitpoints / 3 style threshold check', () => {
    const ctx = new MapFormulaCallable().add(
      'self',
      Variant.callable(new MockUnitCallable({ hitpoints: Variant.int(20), max_hitpoints: Variant.int(32) })),
    );
    // wesnoth/data/core/macros/animation-utils.cfg:257
    expect(evalFormula('if(self.hitpoints > self.max_hitpoints / 3, 1, 0)', ctx).asInt()).toBe(1);
  });

  // wesnoth/data/core/units/boats/Fireship.cfg:37,50
  it('(self.hitpoints<=10) / (self.hitpoints>10)', () => {
    const lowHp = new MapFormulaCallable().add('self', Variant.callable(new MockUnitCallable({ hitpoints: Variant.int(5) })));
    const highHp = new MapFormulaCallable().add(
      'self',
      Variant.callable(new MockUnitCallable({ hitpoints: Variant.int(15) })),
    );
    expect(evalFormula('(self.hitpoints<=10)', lowHp).asBool()).toBe(true);
    expect(evalFormula('(self.hitpoints>10)', lowHp).asBool()).toBe(false);
    expect(evalFormula('(self.hitpoints>10)', highHp).asBool()).toBe(true);
  });

  // wesnoth/data/core/macros/abilities.cfg:328
  it('self.resting', () => {
    const ctx = new MapFormulaCallable().add('self', Variant.callable(new MockUnitCallable({ resting: Variant.int(1) })));
    expect(evalFormula('self.resting', ctx).asBool()).toBe(true);
  });

  // wesnoth/data/core/macros/abilities.cfg:218
  it('level < other.level', () => {
    expect(
      evalFormula(
        'level < other.level',
        new MapFormulaCallable()
          .add('level', Variant.int(1))
          .add('other', Variant.callable(new MockUnitCallable({ level: Variant.int(2) }))),
      ).asBool(),
    ).toBe(true);
  });

  // wesnoth/data/core/macros/abilities.cfg:280 -- `unit_at` is a game-provided
  // formula function (registered by the AI/ability integration, not part of
  // core WFL) that this self-contained port does not implement (see
  // functions.ts's module doc).
  //
  // Notable finding: WFL resolves function calls by *name* at PARSE time,
  // not at evaluation time (`parse_expression`'s function-call branch calls
  // `symbols->create_function(name, args)` directly while parsing -- see
  // formula.cpp). So a `formula=` string referencing a not-yet-registered
  // function (here, `unit_at`) fails to even *parse* with our default
  // (builtins-only) symbol table, before evaluation is ever attempted. Once
  // the data-model agent's callable objects land, the engine will need to
  // register game functions like `unit_at`/`enemy_of`/`direction_from` into
  // a `FunctionSymbolTable` *before* parsing real ability/weapon-special
  // formulas from data/core.
  it('fails to parse formulas using not-yet-registered game functions like unit_at', () => {
    const source = 'owner_side = teleport_unit.side_number and not unit_at(loc)';
    expect(() => parseFormula(source)).toThrow(/Unknown function: unit_at/);
  });

  // wesnoth/data/core/macros/weapon_specials.cfg:40 (backstab) -- multiline
  // formula combining a `where` clause with game-provided functions
  // (enemy_of/unit_at/direction_from). Exercises whitespace/newline handling
  // and where-clause grammar; fails to parse for the same reason as above
  // (on `direction_from`, the innermost unregistered call).
  it('exercises multiline where-clause grammar, failing on a real game function', () => {
    const source = `
                enemy_of(self, flanker) and not flanker.petrified
            where
                flanker = unit_at(direction_from(loc, other.facing))
            `;
    expect(() => parseFormula(source)).toThrow(/Unknown function: direction_from/);
  });
});

describe('WFL parser + evaluator: error handling', () => {
  it('throws FormulaError on malformed input', () => {
    expect(() => parseFormula('(')).toThrow(FormulaError);
    expect(() => parseFormula('1 +')).toThrow(FormulaError);
    expect(() => parseFormula('()')).toThrow(FormulaError);
  });

  it('throws FormulaTypeError on int divide by zero', () => {
    expect(() => evalFormula('1 / 0')).toThrow(FormulaTypeError);
  });

  it('throws FormulaError calling an unknown function', () => {
    expect(() => evalFormula('nonexistent_function(1,2,3)')).toThrow(/Unknown function/);
  });
});
