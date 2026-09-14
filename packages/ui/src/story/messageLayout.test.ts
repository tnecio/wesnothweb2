import { describe, expect, it } from 'vitest';
import { layoutMessage, portraitDrawSize, portraitSlotWidth, scaledSizeFromPath } from './messageLayout.js';

describe('portraitSlotWidth (__GUI_IMAGE_WIDTH)', () => {
  it('fills the width left over by the 675 px text column, clamped to 500', () => {
    // best_width = 1640 - 675 = 965; square portrait fits under max_height 1000 -> clamp(965) = 500.
    expect(portraitSlotWidth({ w: 1640, h: 1030 }, { w: 400, h: 400 })).toBe(500);
  });

  it('shrinks for tall portraits on short maps, never below 250', () => {
    // best_width = 1000 - 675 = 325; aspect 2 -> 650 > 570 -> floor(570 / 2) = 285.
    expect(portraitSlotWidth({ w: 1000, h: 600 }, { w: 400, h: 800 })).toBe(285);
    expect(portraitSlotWidth({ w: 800, h: 600 }, { w: 400, h: 400 })).toBe(250);
  });

  it('treats a missing portrait as aspect 0', () => {
    expect(portraitSlotWidth({ w: 1100, h: 700 }, undefined)).toBe(425);
  });
});

describe('portraitDrawSize', () => {
  it('keeps images under 300 px and scales larger ones by slot / 500', () => {
    expect(portraitDrawSize(400, { w: 144, h: 144 })).toEqual({ w: 144, h: 144 });
    expect(portraitDrawSize(285, { w: 400, h: 800 })).toEqual({ w: 228, h: 456 });
  });
});

describe('layoutMessage', () => {
  const map = { w: 1640, h: 1030 };

  it('left portrait: standing on the bottom edge, text column after the slot', () => {
    expect(layoutMessage(map, { w: 400, h: 400 }, true, undefined)).toEqual({
      leftSlot: 500,
      rightSlot: 0,
      left: { x: 0, y: 630, w: 400, h: 400 },
      right: undefined,
      contentX: 500,
      contentWidth: 675,
    });
  });

  it('centers a small image in its slot', () => {
    expect(layoutMessage(map, { w: 72, h: 72 }, true, undefined).left).toEqual({ x: 214, y: 958, w: 72, h: 72 });
  });

  it('right portrait: flush right, text column before the slot', () => {
    const l = layoutMessage(map, { w: 400, h: 400 }, false, undefined);
    expect([l.leftSlot, l.rightSlot, l.right, l.contentX, l.contentWidth]).toEqual([0, 500, { x: 1240, y: 630, w: 400, h: 400 }, 465, 675]);
  });

  it('no portrait still reserves the left column', () => {
    const l = layoutMessage({ w: 1100, h: 700 }, undefined, true, undefined);
    expect([l.leftSlot, l.left, l.contentX, l.contentWidth]).toEqual([425, undefined, 425, 675]);
  });

  it('double portrait: primary left, second right', () => {
    const l = layoutMessage(map, { w: 400, h: 400 }, true, { w: 450, h: 500 });
    expect(l.left).toEqual({ x: 0, y: 630, w: 400, h: 400 });
    expect(l.right).toEqual({ x: 1190, y: 530, w: 450, h: 500 });
    // Right slot: aspect 1.11 -> 965 * 1.11 > 1000 -> floor(1000 / 1.11) = 900 -> clamp 500. Text gets 1640 - 1000 = 640.
    expect([l.leftSlot, l.rightSlot, l.contentX, l.contentWidth]).toEqual([500, 500, 500, 640]);
  });

  it('keeps a readable text column on a phone', () => {
    const l = layoutMessage({ w: 390, h: 700 }, { w: 400, h: 400 }, true, undefined);
    expect(l.contentWidth).toBe(280);
    expect(l.leftSlot).toBe(110);
  });
});

describe('scaledSizeFromPath', () => {
  it('reads the size a SCALE function fixes', () => {
    expect(scaledSizeFromPath('units/undead/bat-se.png~SCALE_SHARP(144,144)')).toEqual({ w: 144, h: 144 });
    expect(scaledSizeFromPath('portraits/cylanna.webp')).toBeUndefined();
  });
});
