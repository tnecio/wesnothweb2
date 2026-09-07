/**
 * Time-of-day colour tinting — a port of `image::adjust_surface_color`
 * (sdl/utils.cpp ~L406-421) plus the `[time]` config → RGB passthrough in
 * `time_of_day::time_of_day` (time_of_day.cpp ~L28-36).
 *
 * Verified NOT to be an IPF modifier: `display.cpp`'s per-frame
 * `image::set_color_adjustment(tod.color.r, tod.color.g, tod.color.b)`
 * (~L389) sets a *global* additive RGB offset that `picture.cpp`'s
 * `get_tod_colored()` applies as a separate blit stage
 * (`TYPE::TOD_COLORED`, picture.cpp ~L665-670), independent of a locator's
 * own `~MODIFIER()` chain. So this is ported as a pure colour computation
 * (`todColorFromTimeConfig`) plus a per-pixel apply function
 * (`applyTodTint`, exactly `adjust_surface_color`'s formula: add and clamp
 * each channel, alpha untouched) — then wired into `ImageCache` as a
 * trailing pseudo-op, the same pattern `hexedRef`'s `~HEXED()` already
 * uses for another draw-time-only, non-IPF operation.
 */

import type { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';

export interface TodColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** No tint: safe default for "no time-of-day schedule loaded yet" / midday. */
export const NEUTRAL_TOD_COLOR: TodColor = { r: 0, g: 0, b: 0 };

/**
 * TS port of `time_of_day::time_of_day(const config&)` (time_of_day.cpp
 * ~L28-36): a `[time]` block's `red=`/`green=`/`blue=` attributes, read
 * verbatim as signed integer offsets (no scaling/normalisation — upstream
 * does none either). Missing attributes default to 0 (no tint on that
 * channel), matching `config::attribute_value::to_int()`'s own default.
 */
export function todColorFromTimeConfig(timeCfg: WmlConfig): TodColor {
  return {
    r: timeCfg.getNumber('red', 0),
    g: timeCfg.getNumber('green', 0),
    b: timeCfg.getNumber('blue', 0),
  };
}

function clamp255(v: number): number {
  return v > 255 ? 255 : v < 0 ? 0 : v | 0;
}

/**
 * TS port of `adjust_surface_color` (sdl/utils.cpp ~L406-421): adds `tod`'s
 * (r,g,b) offset to every pixel's colour channels in place, clamped to
 * [0,255]. Alpha is untouched. A no-op tint (all zero) is skipped, matching
 * upstream's own `red != 0 || green != 0 || blue != 0` guard.
 */
export function applyTodTint(data: Uint8ClampedArray, tod: TodColor): void {
  if (tod.r === 0 && tod.g === 0 && tod.b === 0) return;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp255(data[i]! + tod.r);
    data[i + 1] = clamp255(data[i + 1]! + tod.g);
    data[i + 2] = clamp255(data[i + 2]! + tod.b);
  }
}
