/**
 * Phase 16 N3: story screen geometry, as pure functions of a resolved part,
 * the viewport and the images' pixel sizes (from the story asset table, so
 * layout never waits for pixels to arrive).
 *
 * Ports the canvas formulas `gui2::dialogs::story_viewer::display_part` and
 * `draw_floating_image` build (`src/gui/dialogs/story_viewer.cpp`). WFL
 * arithmetic on integers truncates, so every `/` below does too, except the
 * base layer's scale factors, which upstream computes `as_decimal`.
 */
import type { ResolvedStoryPart, StoryFloatingImage } from '@wesnothweb2/engine';

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface LayerRect {
  readonly image: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** `resize_mode=tile_center`: the image repeats, centered, across the rect at its original size. */
  readonly tile: boolean;
}

export interface BaseTransform {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly originX: number;
  readonly originY: number;
}

export interface FloatingRect {
  readonly file: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly delay: number;
}

export interface StoryPartLayout {
  /** Background layers with an image, bottom first. */
  readonly layers: readonly LayerRect[];
  readonly base: BaseTransform;
  /** In drawing order; each appears `delay` ms after the previous one. */
  readonly floating: readonly FloatingRect[];
}

const div = (a: number, b: number): number => Math.trunc(a / b);

/** Phase 23: how far a keep_aspect_ratio picture may be squeezed before it keeps its shape instead (see `layoutBackgroundLayer`). */
const MAX_DISTORTION = 1.25;

/** Per-layer rect: `story_viewer.cpp:159-195`. `isBase`: whether this is the part's base layer (Phase 23's phone deviation treats it differently). */
export function layoutBackgroundLayer(
  layer: ResolvedStoryPart['backgroundLayers'][number],
  viewport: Size,
  original: Size,
  isBase = true,
): LayerRect {
  const { w: width, h: height } = viewport;
  const { w: ow, h: oh } = original;
  const tileH = layer.tileHorizontally;
  const tileV = layer.tileVertically;
  const keep = layer.keepAspectRatio;

  let h = oh;
  if (layer.scaleHorizontally && keep) h = Math.min(div(oh * width, ow), height);
  else if (layer.scaleVertically || tileV) h = height;

  let w = ow;
  if (layer.scaleVertically && keep) w = Math.min(div(ow * height, oh), width);
  else if (layer.scaleHorizontally || tileH) w = width;

  // Phase 23 (a deviation): upstream clamps the scaled side to the window but keeps the other at
  // full size, which distorts a picture on a window narrower (or flatter) than it. On a desktop that
  // is a few percent and stays as upstream's; on a phone held upright it squeezes a map to a third
  // of its width. Past `MAX_DISTORTION` a keep_aspect_ratio picture keeps its shape: the base layer
  // (the one the story is about) fits whole, a backdrop under it covers the screen instead.
  let cover = false;
  if (keep && !tileH && !tileV && (layer.scaleHorizontally || layer.scaleVertically) && ow > 0 && oh > 0 && w > 0 && h > 0) {
    const distortion = Math.max((w / h) / (ow / oh), (ow / oh) / (w / h));
    if (distortion > MAX_DISTORTION) {
      cover = !isBase;
      const s = cover ? Math.max(width / ow, height / oh) : Math.min(w / ow, h / oh);
      w = Math.trunc(ow * s);
      h = Math.trunc(oh * s);
    }
  }

  const x = tileH ? 0 : cover ? div(width, 2) - div(w, 2) : Math.max(div(width, 2) - div(w, 2), 0);
  const y = tileV ? 0 : cover ? div(height, 2) - div(h, 2) : Math.max(div(height, 2) - div(h, 2), 0);
  return { image: layer.image, x, y, w, h, tile: tileH || tileV };
}

/**
 * Lays out a part's background and floating images. `sizeOf` returns an
 * image's original pixel size, or undefined when unknown (such an image is
 * skipped, like a file upstream fails to load).
 */
export function layoutStoryPart(part: ResolvedStoryPart, viewport: Size, sizeOf: (image: string) => Size | undefined): StoryPartLayout {
  const layers: LayerRect[] = [];
  // The base layer is the last one marked base_layer=yes, else the first layer -- even the
  // part's always-present shortcut layer. Its drawn scale and origin position floating images;
  // a base layer that draws nothing sets no canvas variables, so the identity transform applies.
  let baseIndex = 0;
  part.backgroundLayers.forEach((layer, i) => {
    if (layer.baseLayer) baseIndex = i;
  });
  let transform: BaseTransform = { scaleX: 1, scaleY: 1, originX: 0, originY: 0 };
  let baseRect: LayerRect | undefined;

  part.backgroundLayers.forEach((layer, i) => {
    const size = layer.image ? sizeOf(layer.image) : undefined;
    if (!size) return;
    const rect = layoutBackgroundLayer(layer, viewport, size, i === baseIndex);
    layers.push(rect);
    if (i === baseIndex) {
      transform = { scaleX: rect.w / size.w, scaleY: rect.h / size.h, originX: rect.x, originY: rect.y };
      baseRect = rect;
    }
  });

  // Phase 23 (ours; upstream targets landscape windows): on a portrait screen a landscape picture,
  // centred, would sit behind the text panel with blank screen above or below it. It moves to the
  // end the text leaves free -- the top when the text is at the bottom, and the reverse -- taking
  // the other pictures and the floating images (through the base transform) with it.
  const dy = portraitShift(part.textLayout, viewport, baseRect);
  if (dy !== 0) {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]!;
      // A layer as tall as the screen (a backdrop covering it) stays where it is.
      if (!l.tile && l.h < viewport.h) layers[i] = { ...l, y: l.y + dy };
    }
    transform = { ...transform, originY: transform.originY + dy };
  }

  const floating: FloatingRect[] = [];
  for (const image of part.floatingImages) {
    const size = image.file ? sizeOf(image.file) : undefined;
    if (!size) continue;
    floating.push(layoutFloatingImage(image, transform, size));
  }
  return { layers, base: transform, floating };
}

/** How far to move the art vertically on a portrait screen (see `layoutStoryPart`): 0 unless it leaves a gap. */
function portraitShift(textLayout: ResolvedStoryPart['textLayout'], viewport: Size, base: LayerRect | undefined): number {
  if (!base || base.tile || viewport.h <= viewport.w || base.h >= viewport.h) return 0;
  if (textLayout === 'bottom') return -base.y;
  if (textLayout === 'top') return viewport.h - base.h - base.y;
  return 0;
}

/** `story_viewer.cpp:337-362`. */
export function layoutFloatingImage(image: StoryFloatingImage, base: BaseTransform, original: Size): FloatingRect {
  const w = image.resizeWithBackground ? Math.trunc(original.w * base.scaleX) : original.w;
  const h = image.resizeWithBackground ? Math.trunc(original.h * base.scaleY) : original.h;
  let x = Math.trunc(image.x * base.scaleX) + base.originX;
  let y = Math.trunc(image.y * base.scaleY) + base.originY;
  if (image.centered) {
    x -= div(w, 2);
    y -= div(h, 2);
  }
  return { file: image.file, x, y, w, h, delay: image.delay };
}

/** Title text box origin: `max(pos * (size - text) / 100, 0)` on each axis (`story_viewer.cpp:236-239`). */
export function titleOrigin(position: { x: number; y: number }, viewport: Size, text: Size): { x: number; y: number } {
  return {
    x: Math.max(div(position.x * (viewport.w - text.w), 100), 0),
    y: Math.max(div(position.y * (viewport.h - text.h), 100), 0),
  };
}
