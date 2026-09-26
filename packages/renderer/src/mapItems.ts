/**
 * Phase 18: map items as the board draws them (`SnapshotBoard.updateItems`),
 * kept free of PixiJS so it can be tested headless.
 */
import { squareParentheticalSplit } from './animation/frame.js';

/** One map item for `updateItems` -- engine-convention (0-based) hex. */
export interface MapItemPoint {
  x: number;
  y: number;
  image: string;
  halo: string;
}

/** A halo's frames (`halo.cpp`): comma/bracket-split, each `image[:ms]`, 100 ms unless given. */
export function parseHaloFrames(halo: string): { image: string; durationMs: number }[] {
  return squareParentheticalSplit(halo).map((piece) => {
    const idx = piece.lastIndexOf(':');
    const ms = idx === -1 ? NaN : Number(piece.slice(idx + 1));
    return Number.isFinite(ms) ? { image: piece.slice(0, idx), durationMs: ms } : { image: piece, durationMs: 100 };
  });
}

/** One map label for `updateLabels` -- engine-convention (0-based) hex; `color` is `r,g,b`. */
export interface MapLabelPoint {
  x: number;
  y: number;
  text: string;
  color: string;
}

/** `font::SIZE_NORMAL`, the map labels' size at 100% zoom. */
export const LABEL_FONT_SIZE = 17;
