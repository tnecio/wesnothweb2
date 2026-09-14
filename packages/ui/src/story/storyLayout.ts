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

/** Per-layer rect: `story_viewer.cpp:159-195`. */
export function layoutBackgroundLayer(
  layer: ResolvedStoryPart['backgroundLayers'][number],
  viewport: Size,
  original: Size,
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

  const x = tileH ? 0 : Math.max(div(width, 2) - div(w, 2), 0);
  const y = tileV ? 0 : Math.max(div(height, 2) - div(h, 2), 0);
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

  part.backgroundLayers.forEach((layer, i) => {
    const size = layer.image ? sizeOf(layer.image) : undefined;
    if (!size) return;
    const rect = layoutBackgroundLayer(layer, viewport, size);
    layers.push(rect);
    if (i === baseIndex) transform = { scaleX: rect.w / size.w, scaleY: rect.h / size.h, originX: rect.x, originY: rect.y };
  });

  const floating: FloatingRect[] = [];
  for (const image of part.floatingImages) {
    const size = image.file ? sizeOf(image.file) : undefined;
    if (!size) continue;
    floating.push(layoutFloatingImage(image, transform, size));
  }
  return { layers, base: transform, floating };
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
