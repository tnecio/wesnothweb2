import { describe, expect, it } from 'vitest';
import { FormulaTypeError, Variant } from '../../src/formula/variant';

describe('Variant', () => {
  it('does integer arithmetic', () => {
    expect(Variant.int(2).add(Variant.int(3)).asInt()).toBe(5);
    expect(Variant.int(2).sub(Variant.int(3)).asInt()).toBe(-1);
    expect(Variant.int(4).mul(Variant.int(3)).asInt()).toBe(12);
    expect(Variant.int(7).div(Variant.int(2)).asInt()).toBe(3);
    expect(Variant.int(7).mod(Variant.int(2)).asInt()).toBe(1);
    expect(Variant.int(2).pow(Variant.int(10)).asInt()).toBe(1024);
    expect(Variant.int(5).neg().asInt()).toBe(-5);
  });

  it('throws on integer divide/mod by zero', () => {
    expect(() => Variant.int(1).div(Variant.int(0))).toThrow(FormulaTypeError);
    expect(() => Variant.int(1).mod(Variant.int(0))).toThrow(FormulaTypeError);
  });

  it('does fixed-point decimal arithmetic matching upstream rounding rules', () => {
    // 1/3 as a decimal: raw thousandths truncate-then-round-half-up, matching
    // wfl::variant::operator/ exactly (see variant.cpp).
    const third = Variant.decimalFromNumber(1).div(Variant.decimalFromNumber(3));
    expect(third.stringCast()).toBe('0.333');

    const product = Variant.decimalFromNumber(2.5).mul(Variant.int(2));
    expect(product.stringCast()).toBe('5.000');

    const sum = Variant.decimalFromNumber(1.5).add(Variant.decimalFromNumber(2.25));
    expect(sum.stringCast()).toBe('3.750');
  });

  it('promotes int to decimal when mixed', () => {
    const v = Variant.int(1).add(Variant.decimalFromNumber(0.5));
    expect(v.isDecimal()).toBe(true);
    expect(v.stringCast()).toBe('1.500');
  });

  it('compares values with cross-type int/decimal coercion', () => {
    expect(Variant.int(1).eq(Variant.decimalFromNumber(1))).toBe(true);
    expect(Variant.decimalFromNumber(1.5).lt(Variant.int(2))).toBe(true);
    expect(Variant.int(3).gt(Variant.int(2))).toBe(true);
    expect(Variant.string('a').lt(Variant.string('b'))).toBe(true);
  });

  it('builds and indexes lists', () => {
    const list = Variant.list([Variant.int(1), Variant.int(2), Variant.int(3)]);
    expect(list.numElements()).toBe(3);
    expect(list.at(0).asInt()).toBe(1);
    expect(list.get(Variant.int(-1)).asInt()).toBe(3);
    expect(list.contains(Variant.int(2))).toBe(true);
    expect(list.contains(Variant.int(9))).toBe(false);
  });

  it('concatenates lists and strings, and rejects mixed concatenation', () => {
    const l1 = Variant.list([Variant.int(1)]);
    const l2 = Variant.list([Variant.int(2)]);
    expect(l1.concatenate(l2).asList().map((v) => v.asInt())).toEqual([1, 2]);
    expect(Variant.string('foo').concatenate(Variant.string('bar')).asString()).toBe('foobar');
    expect(() => l1.concatenate(Variant.string('x'))).toThrow(FormulaTypeError);
  });

  it('builds and looks up maps, sorted by key', () => {
    const map = Variant.map([
      [Variant.string('b'), Variant.int(2)],
      [Variant.string('a'), Variant.int(1)],
    ]);
    expect(map.get(Variant.string('a')).asInt()).toBe(1);
    expect(map.get(Variant.string('missing')).isNull()).toBe(true);
    expect(map.getKeys().asList().map((k) => k.asString())).toEqual(['a', 'b']);
    expect(map.contains(Variant.string('b'))).toBe(true);
  });

  it('overwrites duplicate map keys with the later value (later wins)', () => {
    const map = Variant.map([
      [Variant.string('x'), Variant.int(1)],
      [Variant.string('x'), Variant.int(2)],
    ]);
    expect(map.numElements()).toBe(1);
    expect(map.get(Variant.string('x')).asInt()).toBe(2);
  });

  it('builds an integer range', () => {
    const up = Variant.int(1).buildRange(Variant.int(4));
    expect(up.asList().map((v) => v.asInt())).toEqual([1, 2, 3, 4]);
    const down = Variant.int(4).buildRange(Variant.int(1));
    expect(down.asList().map((v) => v.asInt())).toEqual([4, 3, 2, 1]);
  });

  it('does elementwise list arithmetic (.+ .- .* ./)', () => {
    const a = Variant.list([Variant.int(1), Variant.int(2)]);
    const b = Variant.list([Variant.int(3), Variant.int(4)]);
    expect(a.listElementsAdd(b).asList().map((v) => v.asInt())).toEqual([4, 6]);
    expect(a.listElementsMul(b).asList().map((v) => v.asInt())).toEqual([3, 8]);
  });

  it('round-trips serialization for common literal shapes', () => {
    expect(Variant.null_().serializeToString()).toBe('null()');
    expect(Variant.int(42).serializeToString()).toBe('42');
    expect(Variant.string("it's [ok]").serializeToString()).toBe("'it[']s [(]ok[)]'");
    expect(Variant.list([Variant.int(1), Variant.int(2)]).serializeToString()).toBe('[1, 2]');
    // Faithful upstream quirk: an empty list and empty map both serialize as `[->]`.
    expect(Variant.list([]).serializeToString()).toBe('[->]');
    expect(Variant.map([]).serializeToString()).toBe('[->]');
  });
});
