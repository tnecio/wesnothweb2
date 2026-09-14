/**
 * Phase 16 N6: `[message]` dialog geometry, as pure functions -- a port of
 * the WFL formulas in `data/gui/themes/default/dialogs/wml_message.cfg`
 * (`__GUI_IMAGE_WIDTH`, `__GUI_IMAGE_DISPLAYED_*`, the text column spacer).
 * The dialog window covers the map area; the portrait stands on the
 * window's bottom edge, drawn over the text panel.
 */

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface PortraitRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface MessageLayout {
  /** Reserved portrait column widths (`image_place_holder`); 0 where the dialog has no portrait column. */
  readonly leftSlot: number;
  readonly rightSlot: number;
  readonly left?: PortraitRect;
  readonly right?: PortraitRect;
  /** Text column, relative to the window. */
  readonly contentX: number;
  readonly contentWidth: number;
}

export const MAX_TEXT_WIDTH = 675;
/** Narrow-screen deviation (upstream is desktop-only): the text column never shrinks below this while a portrait column can give way. */
export const MIN_TEXT_WIDTH = 280;

const trunc = Math.trunc;

/** `__GUI_IMAGE_WIDTH`: the portrait column width, 250–500 px, for a portrait of `portrait` original size (undefined: no image). */
export function portraitSlotWidth(map: Size, portrait: Size | undefined): number {
  // text_width_saturation = 3 * height_offset / 2 with height_offset = 25, in integer WFL.
  const textWidthSaturation = trunc((3 * 25) / 2);
  const bestWidth = map.w > textWidthSaturation ? map.w - MAX_TEXT_WIDTH : trunc(map.w / 3);
  const aspect = portrait && portrait.w > 0 ? portrait.h / portrait.w : 0;
  const maxHeight = map.h - 30;
  const bestSize = bestWidth * aspect > maxHeight ? Math.floor(maxHeight / aspect) : bestWidth;
  return Math.min(Math.max(bestSize, 250), 500);
}

/** `__GUI_IMAGE_DISPLAYED_WIDTH/HEIGHT`: small images keep their size, larger ones scale by slot / 500. */
export function portraitDrawSize(slot: number, portrait: Size): Size {
  if (portrait.w < 300 && portrait.h < 300) return portrait;
  return { w: trunc((portrait.w * slot) / 500), h: trunc((portrait.h * slot) / 500) };
}

/**
 * Lays out one message. `primary` is the message's portrait (placed left
 * unless `leftSide` is false), `second` its `second_image` (always right).
 * A dialog with no portrait at all still reserves the left column, as
 * upstream's `wml_message_left` does.
 */
export function layoutMessage(map: Size, primary: Size | undefined, leftSide: boolean, second: Size | undefined): MessageLayout {
  const leftPortrait = leftSide ? primary : undefined;
  const rightPortrait = leftSide ? second : (primary ?? second);
  const hasRightColumn = rightPortrait !== undefined;
  const hasLeftColumn = leftPortrait !== undefined || !hasRightColumn;

  let leftSlot = hasLeftColumn ? portraitSlotWidth(map, leftPortrait) : 0;
  let rightSlot = hasRightColumn ? portraitSlotWidth(map, rightPortrait) : 0;

  // Narrow screens: give the text column room before the portrait columns.
  const overflow = MIN_TEXT_WIDTH - (map.w - leftSlot - rightSlot);
  if (overflow > 0) {
    const columns = (hasLeftColumn ? 1 : 0) + (hasRightColumn ? 1 : 0);
    const cut = Math.ceil(overflow / columns);
    if (hasLeftColumn) leftSlot = Math.max(0, leftSlot - cut);
    if (hasRightColumn) rightSlot = Math.max(0, rightSlot - cut);
  }

  const free = map.w - leftSlot - rightSlot;
  const contentWidth = Math.max(0, Math.min(MAX_TEXT_WIDTH, free));
  // The spare width goes beside the text column away from the portrait (the trailing spacer column).
  const spare = free - contentWidth;
  const contentX = hasLeftColumn ? leftSlot + (hasRightColumn ? trunc(spare / 2) : 0) : spare;

  let left: PortraitRect | undefined;
  if (leftPortrait) {
    const size = portraitDrawSize(leftSlot, leftPortrait);
    left = { x: leftPortrait.w > 100 ? 0 : trunc((leftSlot - size.w) / 2), y: map.h - size.h, ...size };
  }
  let right: PortraitRect | undefined;
  if (rightPortrait) {
    const size = portraitDrawSize(rightSlot, rightPortrait);
    right = { x: map.w - size.w, y: map.h - size.h, ...size };
  }
  return { leftSlot, rightSlot, left, right, contentX, contentWidth };
}

/** The pixel size an image path function fixes, e.g. `~SCALE_SHARP(144,144)`; undefined when none. */
export function scaledSizeFromPath(ref: string): Size | undefined {
  const m = /~SCALE(?:_SHARP|_INTO|_INTO_SHARP)?\((\d+),(\d+)\)/.exec(ref);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}
