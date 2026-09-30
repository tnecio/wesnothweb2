/**
 * TS port of upstream Wesnoth's `map_location` (src/map/location.hpp/.cpp).
 *
 * ## Coordinate convention (verified against map/location.cpp, not guessed)
 *
 * `Location.x`/`Location.y` are 0-based (column, row) offset coordinates into
 * the map's rectangular storage grid. This is a "shoved-column" / odd-q-style
 * flat-top hex layout: **odd columns are shifted down half a hex relative to
 * even columns**. Concretely, from `get_adjacent_tiles()` in location.cpp:
 *
 * ```
 * x even: NE = (x+1, y-1)   SE = (x+1, y  )   NW = (x-1, y-1)   SW = (x-1, y  )
 * x odd:  NE = (x+1, y  )   SE = (x+1, y+1)   NW = (x-1, y  )   SW = (x-1, y+1)
 * N = (x, y-1)   S = (x, y+1)   always.
 * ```
 *
 * This is confirmed unambiguously by `map_location::to_cubic()`:
 * `q = x; r = y - floor(x/2); s = -q-r` (for x >= 0) which is exactly
 * redblobgames.com's "odd-q offset" -> cube conversion for a layout where
 * *odd* columns are pushed down. Whoever ports the renderer's hex geometry
 * needs to either match this convention exactly, or apply an explicit,
 * documented transform at the engine/renderer boundary -- do not assume
 * axial/doubled-coordinate conventions used elsewhere without checking.
 *
 * WML text files use 1-based coordinates. `wmlX`/`wmlY` (mirroring
 * `map_location::wml_x()`/`wml_y()`) convert to/from that; internal `x`/`y`
 * stay 0-based everywhere else, matching upstream.
 */

import type { WmlConfig } from '../wml/config.js';

export enum Direction {
  North,
  NorthEast,
  SouthEast,
  South,
  SouthWest,
  NorthWest,
  Indeterminate,
}

export const ALL_DIRECTIONS: readonly Direction[] = [
  Direction.North,
  Direction.NorthEast,
  Direction.SouthEast,
  Direction.South,
  Direction.SouthWest,
  Direction.NorthWest,
];

/** Mirrors `map_location::rotate_direction`. */
export function rotateDirection(dir: Direction, steps = 1): Direction {
  if (dir === Direction.Indeterminate) return Direction.Indeterminate;
  const adjustedSteps = steps >= 0 ? steps : steps * -5;
  return (((dir + adjustedSteps) % 6) + 6) % 6;
}

export function oppositeDirection(dir: Direction): Direction {
  return rotateDirection(dir, 3);
}

/** Mirrors `map_location::parse_direction` (without the `(...)`-grouping recursion, rarely used). */
export function parseDirection(str: string): Direction {
  if (!str) return Direction.Indeterminate;
  const negate = str[0] === '-';
  const body = negate ? str.slice(1) : str;
  const colonIdx = body.indexOf(':');
  const mainDir = colonIdx === -1 ? body : body.slice(0, colonIdx);
  let dir: Direction;
  switch (mainDir) {
    case 'n':
      dir = Direction.North;
      break;
    case 'ne':
      dir = Direction.NorthEast;
      break;
    case 'se':
      dir = Direction.SouthEast;
      break;
    case 's':
      dir = Direction.South;
      break;
    case 'sw':
      dir = Direction.SouthWest;
      break;
    case 'nw':
      dir = Direction.NorthWest;
      break;
    default:
      return Direction.Indeterminate;
  }
  if (negate) dir = oppositeDirection(dir);
  if (colonIdx !== -1) {
    const relDir = body.slice(colonIdx + 1);
    if (relDir === 'cw') dir = rotateDirection(dir, 1);
    else if (relDir === 'ccw') dir = rotateDirection(dir, -1);
    else return Direction.Indeterminate;
  }
  return dir;
}

export function writeDirection(dir: Direction): string {
  switch (dir) {
    case Direction.North:
      return 'n';
    case Direction.NorthEast:
      return 'ne';
    case Direction.SouthEast:
      return 'se';
    case Direction.South:
      return 's';
    case Direction.SouthWest:
      return 'sw';
    case Direction.NorthWest:
      return 'nw';
    default:
      return '';
  }
}

export interface CubicLocation {
  q: number;
  r: number;
  s: number;
}

/** Mirrors `map_location`. Immutable value type: all mutating-looking ops return a new Location. */
export class Location {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}

  /** The (invalid) default-constructed location, `map_location()`. */
  static readonly NULL = new Location(-1000, -1000);

  static readonly ZERO = new Location(0, 0);

  /** Builds a Location from 1-based WML `x`/`y` attributes (`map_location(x, y, wml_loc{})`). */
  static fromWml(wmlX: number, wmlY: number): Location {
    return new Location(wmlX - 1, wmlY - 1);
  }

  get wmlX(): number {
    return this.x + 1;
  }

  get wmlY(): number {
    return this.y + 1;
  }

  /**
   * Builds a Location from a config's `x`/`y` attributes (1-based WML
   * convention). The literal string "recall" (used for units sitting on a
   * side's recall list, which has no board position) yields the sentinel
   * -1000 for that axis, matching `map_location(const config&, ...)`.
   */
  static fromConfig(cfg: WmlConfig): Location {
    const parse = (s: string): number => {
      if (s === '' || s === 'recall') return -1000;
      const n = Number.parseInt(s, 10);
      return Number.isNaN(n) ? -1000 : n - 1;
    };
    return new Location(parse(cfg.getString('x', '')), parse(cfg.getString('y', '')));
  }

  /** Writes `x`/`y` back into a config using 1-based WML convention. */
  writeToConfig(cfg: WmlConfig): void {
    cfg.setAttribute('x', this.wmlX);
    cfg.setAttribute('y', this.wmlY);
  }

  /** Stable string key for use in Map/Set, e.g. `GameBoard`'s unit-by-location index. */
  key(): string {
    return (this.#key ??= `${this.x},${this.y}`);
  }

  // A private field, so it stays out of spreads, JSON and deep equality.
  #key: string | undefined;

  static fromKey(key: string): Location {
    const [x, y] = key.split(',').map(Number);
    return new Location(x ?? -1000, y ?? -1000);
  }

  toString(): string {
    return `${this.wmlX},${this.wmlY}`;
  }

  /** Mirrors the parameterless `map_location::valid()`: non-negative coordinates. */
  valid(width?: number, height?: number, border = 0): boolean {
    if (width === undefined || height === undefined) {
      return this.x >= 0 && this.y >= 0;
    }
    return (
      this.x + border >= 0 &&
      this.y + border >= 0 &&
      this.x < width + border &&
      this.y < height + border
    );
  }

  equals(other: Location): boolean {
    return this.x === other.x && this.y === other.y;
  }

  /** Three-way comparator, mirrors `do_compare` (x-major, then y). */
  compare(other: Location): number {
    return this.x === other.x ? this.y - other.y : this.x - other.x;
  }

  vectorNegation(): Location {
    // eslint-disable-next-line no-bitwise
    return new Location(-this.x, -this.y - (this.x & 1));
  }

  vectorSum(other: Location): Location {
    // eslint-disable-next-line no-bitwise
    const carry = (this.x & 1) && (other.x & 1) ? 1 : 0;
    return new Location(this.x + other.x, this.y + carry + other.y);
  }

  vectorDifference(other: Location): Location {
    return this.vectorSum(other.vectorNegation());
  }

  /** Steps `n` hexes in direction `dir`. Mirrors `map_location::get_direction`. */
  getDirection(dir: Direction, n = 1): Location {
    if (dir === Direction.Indeterminate) return Location.NULL;
    if (n < 0) return this.getDirection(oppositeDirection(dir), -n);

    if (dir === Direction.North) return new Location(this.x, this.y - n);
    if (dir === Direction.South) return new Location(this.x, this.y + n);

    // eslint-disable-next-line no-bitwise
    const xFactor = (dir as number) <= 2 ? 1 : -1; // NE/SE go east(+), SW/NW go west(-)
    // SE=>0, S=>1(unused here), SW=>2, NW=>3, N/NE handled via the >>>0 wraparound below
    const tmpY = ((dir as number) - 2) >>> 0;
    const yFactor = tmpY <= 2 ? 1 : -1;

    // eslint-disable-next-line no-bitwise
    const xOdd = this.x & 1;
    if (tmpY <= 2) {
      // SE, S(unused), SW
      return new Location(this.x + xFactor * n, this.y + yFactor * Math.floor((n + (xOdd === 1 ? 1 : 0)) / 2));
    } else {
      // NW, N(unused), NE
      return new Location(this.x + xFactor * n, this.y + yFactor * Math.floor((n + (xOdd === 0 ? 1 : 0)) / 2));
    }
  }

  toCubic(): CubicLocation {
    const q = this.x;
    const r = this.y - Math.floor((this.x - (Math.abs(this.x) % 2)) / 2);
    const s = -q - r;
    return { q, r, s };
  }

  static fromCubic(h: CubicLocation): Location {
    const x = h.q;
    const y = h.r + Math.floor((h.q - (Math.abs(h.q) % 2)) / 2);
    return new Location(x, y);
  }

  /** Mirrors `rotate_right_around_center`: rotates clockwise around `center` in 60-degree steps. */
  rotateRightAroundCenter(center: Location, k: number): Location {
    const me = this.toCubic();
    const c = center.toCubic();
    const vec = { q: me.q - c.q, r: me.r - c.r, s: me.s - c.s };
    // Each row: |value| is the (1-based) source column, sign is +1/-1.
    const rotations = [
      [1, 2, 3],
      [-2, -3, -1],
      [3, 1, 2],
      [-1, -2, -3],
      [2, 3, 1],
      [-3, -1, -2],
    ];
    const i = (((k % 6) + 6) % 6);
    const src = [vec.q, vec.r, vec.s];
    const rotated = rotations[i]!.map((v) => Math.sign(v) * src[Math.abs(v) - 1]!);
    return Location.fromCubic({
      q: rotated[0]! + c.q,
      r: rotated[1]! + c.r,
      s: rotated[2]! + c.s,
    });
  }

  /**
   * `map_location::matches_range`: `x=`/`y=` comma lists of ranges, paired element by element (a list's
   * leftover entries match on that coordinate alone). Both empty matches everything.
   */
  matchesRange(xloc: string, yloc: string): boolean {
    const xs = parsedRangeList(xloc);
    const ys = parsedRangeList(yloc);
    if (xs.length === 0 && ys.length === 0) return true;
    const x = this.wmlX;
    const y = this.wmlY;
    const inRange = ([lo, hi]: readonly [number, number], v: number) => lo <= v && v <= hi;
    let i = 0;
    for (; i < xs.length && i < ys.length; i++) if (inRange(xs[i]!, x) && inRange(ys[i]!, y)) return true;
    for (; i < xs.length; i++) if (inRange(xs[i]!, x)) return true;
    for (; i < ys.length; i++) if (inRange(ys[i]!, y)) return true;
    return false;
  }

  getRing(min: number, max: number): Location[] {
    const tiles: Location[] = [];
    const center = this.toCubic();
    for (let dx = -max; dx <= max; dx++) {
      for (let dy = Math.max(-max, -dx - max); dy <= Math.min(max, -dx + max); dy++) {
        const dz = -dx - dy;
        const distance = (Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) / 2;
        if (distance < min || distance > max) continue;
        tiles.push(Location.fromCubic({ q: center.q + dx, r: center.r + dy, s: center.s + dz }));
      }
    }
    return tiles;
  }
}

/** Mirrors `get_adjacent_tiles`: N, NE, SE, S, SW, NW order. */
export function getAdjacentTiles(center: Location): Location[] {
  const { x, y } = center;
  // eslint-disable-next-line no-bitwise
  const xOdd = x & 1;
  return [
    new Location(x, y - 1),
    new Location(x + 1, y - (xOdd === 0 ? 1 : 0)),
    new Location(x + 1, y + (xOdd === 1 ? 1 : 0)),
    new Location(x, y + 1),
    new Location(x - 1, y + (xOdd === 1 ? 1 : 0)),
    new Location(x - 1, y - (xOdd === 0 ? 1 : 0)),
  ];
}

/**
 * Which of `ALL_DIRECTIONS` points from `from` toward `to`, or
 * `undefined` if they aren't adjacent. Small shared version of a helper
 * (`directionTo`/`directionBetween`) that had been separately
 * hand-duplicated as a private function in `combat.ts`, `move.ts`, and
 * `recruit.ts` -- pulled out here so a caller outside the engine (e.g.
 * `packages/ui`'s per-step movement-animation direction, which needs the
 * real direction of travel for EACH leg of a multi-hex path, not just
 * the final one `executeMove` itself records) doesn't need its own
 * fourth copy. Those three internal duplicates are left as-is (not a
 * regression, just unconsolidated) rather than refactored as a side
 * effect of adding this.
 */
export function directionBetween(from: Location, to: Location): Direction | undefined {
  const idx = getAdjacentTiles(from).findIndex((loc) => loc.equals(to));
  return idx === -1 ? undefined : ALL_DIRECTIONS[idx];
}

/**
 * The general direction from `from` to any other hex (`map_location::
 * get_relative_dir`, its `DEFAULT` mode -- upstream's default call uses a
 * rotation-based "radial symmetry" mode that agrees for adjacent hexes and
 * differs only on exact ties far away). `Indeterminate` for the same hex.
 * Used for a teleporting unit's facing.
 */
export function relativeDirection(from: Location, to: Location): Direction {
  const dx = to.x - from.x;
  let dy = to.y - from.y;
  // eslint-disable-next-line no-bitwise
  if ((to.x & 1) === 0 && (from.x & 1) === 1) dy--;
  if (dx === 0 && dy === 0) return Direction.Indeterminate;
  let dist = Math.abs(dx);
  const distSwNe = Math.abs(dy + Math.trunc((dx + (dy > 0 ? 0 : 1)) / 2));
  const distSeNw = Math.abs(dy - Math.trunc((dx - (dy > 0 ? 0 : 1)) / 2));
  let dir = dy > 0 ? Direction.South : Direction.North;
  if (distSeNw < dist) {
    dir = dx > 0 ? Direction.SouthEast : Direction.NorthWest;
    dist = distSeNw;
  }
  if (distSwNe < dist) dir = dx > 0 ? Direction.NorthEast : Direction.SouthWest;
  return dir;
}

/** Mirrors `tiles_adjacent`. */
export function tilesAdjacent(a: Location, b: Location): boolean {
  const dy = a.y - b.y;
  const dx = a.x - b.x;
  // eslint-disable-next-line no-bitwise
  if (dy === 1) {
    if (dx === 1 || dx === -1) return (a.x & 1) === 0;
    return dx === 0;
  }
  if (dy === -1) {
    if (dx === 1 || dx === -1) return (b.x & 1) === 0;
    return dx === 0;
  }
  if (dy === 0) return dx === 1 || dx === -1;
  return false;
}

/** Mirrors `distance_between`. */
export function distanceBetween(a: Location, b: Location): number {
  const hDistance = Math.abs(a.x - b.x);
  // eslint-disable-next-line no-bitwise
  const vPenalty =
    ((a.x & 1) === 0 && (b.x & 1) === 1 && a.y < b.y) ||
    ((b.x & 1) === 0 && (a.x & 1) === 1 && b.y < a.y)
      ? 1
      : 0;
  return Math.max(hDistance, Math.abs(a.y - b.y) + vPenalty + Math.floor(hDistance / 2));
}

const rangeListCache = new Map<string, ReadonlyArray<readonly [number, number]>>();

/**
 * An `x=`/`y=` list (`1-5,7`) as its parsed ranges. Filters test the same few strings against every hex of the
 * map, so the parse is kept; the cache is bounded, since content can build these strings from variables.
 */
function parsedRangeList(text: string): ReadonlyArray<readonly [number, number]> {
  let parsed = rangeListCache.get(text);
  if (!parsed) {
    parsed = text.split(',').map((p) => p.trim()).filter((p) => p !== '').map(parseRangeText);
    if (rangeListCache.size >= 4096) rangeListCache.clear();
    rangeListCache.set(text, parsed);
  }
  return parsed;
}

/** `utils::parse_range`: "a", "a-b" (b below a counts as a), "a-infinity", "-infinity-b"; invalid text gives 0-0. */
export function parseRangeText(str: string): [number, number] {
  const pos = str.indexOf('-', 1);
  const [a, b] = pos >= 0 && pos + 1 < str.length ? [str.slice(0, pos), str.slice(pos + 1)] : [str, undefined];
  const stoi = (t: string): number => {
    const m = /^\s*[+-]?\d+/.exec(t);
    if (!m) throw new Error('invalid');
    return Number(m[0]);
  };
  const res: [number, number] = [0, 0];
  try {
    res[0] = a === '-infinity' && b !== undefined ? -2147483648 : stoi(a);
    if (b === undefined) res[1] = res[0];
    else if (b.trim() === 'infinity') res[1] = 2147483647;
    else {
      res[1] = stoi(b);
      if (res[1] < res[0]) res[1] = res[0];
    }
  } catch {
    // Invalid range: upstream logs and keeps what it parsed.
  }
  return res;
}
