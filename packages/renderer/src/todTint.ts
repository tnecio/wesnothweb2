/**
 * Pure colour math for the board-wide ToD tint -- see
 * `SnapshotBoard.updateTimeOfDayTint`'s own doc comment for why this is a
 * composite-layer reconstruction of `image::set_color_adjustment` rather
 * than the per-texture `~TOD()` pseudo-op (`animation/timeOfDay.ts`).
 * Split into its own PIXI-free module so it can be unit tested without a
 * DOM/canvas (importing `pixi.js` at all crashes outside a browser --
 * `BrowserAdapter` calls `navigator` at module-load time).
 */

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function packColor(r: number, g: number, b: number): number {
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
}

/**
 * Splits a `[time] red=/green=/blue=` triple into the two RGB packed
 * colours a `'add'`-blended rect and a `'subtract'`-blended rect need to
 * reconstruct the same per-channel additive/clamp effect as
 * `image::set_color_adjustment`: `positive` holds each channel's
 * non-negative part, `negative` holds the absolute value of each
 * channel's negative part. Either is `0` (packed black) when that rect
 * would be a no-op and can be skipped.
 */
export function splitTodTintColors(tod: { red: number; green: number; blue: number }): { positive: number; negative: number } {
  return {
    positive: packColor(Math.max(tod.red, 0), Math.max(tod.green, 0), Math.max(tod.blue, 0)),
    negative: packColor(Math.max(-tod.red, 0), Math.max(-tod.green, 0), Math.max(-tod.blue, 0)),
  };
}
