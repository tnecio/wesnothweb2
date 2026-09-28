/**
 * The "legacy" hex-offset arithmetic `terrain_builder` uses internally
 * (`legacy_negation`/`legacy_sum`/`legacy_difference`, moved into
 * `builder.cpp` from `map_location` -- see that file's own header comment,
 * reproduced here almost verbatim):
 *
 * > Adds an absolute location to a "delta" location. This is not the
 * > mathematically correct behavior, it is neither commutative nor
 * > associative. Negative coordinates may give strange results. It is
 * > retained because terrain builder code relies on this broken behavior.
 * > Best avoid.
 *
 * Every real `[terrain_graphics]` rule's `[tile]` offsets, and the rotation
 * matrix in `rotate()`, were authored and tuned against this exact
 * arithmetic (not the "correct" axial hex addition `Location`'s own
 * neighbour helpers use elsewhere in this codebase) -- so it is ported
 * verbatim here rather than reused/replaced, deliberately kept separate
 * from `packages/engine/src/model/Location.ts`.
 */

/** A plain (x, y) pair in `map_location`'s 0-based convention. */
export interface HexOffset {
  readonly x: number
  readonly y: number
}

export function legacyNegation(a: HexOffset): HexOffset {
  return { x: -a.x, y: -a.y }
}

/** `me.legacy_sum_assign(a)` as a pure function: `me + a`. */
export function legacySum(me: HexOffset, a: HexOffset): HexOffset {
  const parity = (me.x & 1) !== 0
  const x = me.x + a.x
  let y = me.y + a.y
  if (a.x > 0 && a.x % 2 !== 0 && parity) y++
  if (a.x < 0 && a.x % 2 !== 0 && !parity) y--
  return { x, y }
}

export function legacyDifference(me: HexOffset, a: HexOffset): HexOffset {
  return legacySum(me, legacyNegation(a))
}
