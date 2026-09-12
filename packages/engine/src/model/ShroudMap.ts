/**
 * TS port of upstream `shroud_map` (src/team.hpp/.cpp): one side's per-hex
 * "has this been cleared" bitmap, used for both shroud and fog.
 *
 * Indexed by WML (1-based) coordinates exactly like upstream's
 * `loc.wml_x()`/`wml_y()`, so the border ring (logical -1) is index 0 and
 * `write()`/`read()` round-trip upstream's `shroud_data=` string format.
 * The data grows lazily on `clear()`; any hex with no data is covered.
 */

import type { Location } from './Location.js';

export class ShroudMap {
  enabled: boolean;
  /** `data[x][y]` is true when the hex has been cleared. */
  private data: boolean[][] = [];

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  /** Mirrors `shroud_map::clear`: returns true if the hex was covered before. */
  clear(x: number, y: number): boolean {
    if (!this.enabled || x < 0 || y < 0) return false;
    while (this.data.length <= x) this.data.push([]);
    const col = this.data[x]!;
    while (col.length <= y) col.push(false);
    if (!col[y]) {
      col[y] = true;
      return true;
    }
    return false;
  }

  /** Mirrors `shroud_map::place`: re-covers a hex that already has data (out-of-range hexes are already covered). */
  place(x: number, y: number): void {
    if (!this.enabled || x < 0 || y < 0) return;
    const col = this.data[x];
    if (col && y < col.length) col[y] = false;
  }

  /** Mirrors `shroud_map::reset`. */
  reset(): void {
    if (!this.enabled) return;
    for (const col of this.data) col.fill(false);
  }

  /** Mirrors `shroud_map::value`: true if the hex is covered. */
  value(x: number, y: number): boolean {
    if (!this.enabled) return false;
    const col = x >= 0 ? this.data[x] : undefined;
    if (!col || y < 0 || y >= col.length) return true;
    return !col[y];
  }

  /** Mirrors `shroud_map::shared_value`: covered unless uncovered on any enabled map in `maps`. */
  sharedValue(maps: readonly ShroudMap[], x: number, y: number): boolean {
    if (!this.enabled) return false;
    if (x < 0 || y < 0) return true;
    for (const m of maps) {
      if (m.enabled && !m.value(x, y)) return false;
    }
    return true;
  }

  /** Mirrors `shroud_map::copy_from`. */
  copyFrom(maps: readonly ShroudMap[]): boolean {
    if (!this.enabled) return false;
    let cleared = false;
    for (const m of maps) {
      if (!m.enabled) continue;
      m.data.forEach((col, x) => {
        col.forEach((isClear, y) => {
          if (isClear) cleared = this.clear(x, y) || cleared;
        });
      });
    }
    return cleared;
  }

  /** Mirrors `shroud_map::write`: `|0101\n` per column. */
  write(): string {
    return this.data.map((col) => '|' + col.map((c) => (c ? '1' : '0')).join('') + '\n').join('');
  }

  /** Mirrors `shroud_map::read`. */
  read(str: string): void {
    this.data = [];
    for (const ch of str) {
      if (ch === '|') this.data.push([]);
      const col = this.data[this.data.length - 1];
      if (!col) continue;
      if (ch === '1') col.push(true);
      else if (ch === '0') col.push(false);
    }
  }

  /** Mirrors `shroud_map::merge`: clears every hex marked `1` in `str`, leaving the rest untouched. */
  merge(str: string): void {
    let x = 0;
    let y = 0;
    for (let i = 1; i < str.length; i++) {
      const ch = str[i];
      if (ch === '|') {
        y = 0;
        x++;
      } else if (ch === '1') {
        this.clear(x, y);
        y++;
      } else if (ch === '0') {
        y++;
      }
    }
  }

  clearLoc(loc: Location): boolean {
    return this.clear(loc.wmlX, loc.wmlY);
  }

  placeLoc(loc: Location): void {
    this.place(loc.wmlX, loc.wmlY);
  }

  valueAt(loc: Location): boolean {
    return this.value(loc.wmlX, loc.wmlY);
  }

  sharedValueAt(maps: readonly ShroudMap[], loc: Location): boolean {
    return this.sharedValue(maps, loc.wmlX, loc.wmlY);
  }
}
