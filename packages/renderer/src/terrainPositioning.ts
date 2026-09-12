/**
 * Terrain hex-cropping and per-layer positioning.
 *
 * Extracted from attempt #1's `board/game/Hex.ts` (`makeLayerSprite` and its
 * surrounding notes), which built one `PIXI.Sprite`/`AnimatedSprite` per
 * terrain image layer for a hex. Left behind: `HexDisplay`/`Hex` themselves,
 * which are tied to attempt #1's `WlTerrain`/`QueryManager` snapshot types and
 * app-specific fog/village-ownership rendering — none of that is "cleanly
 * separable" the way this offset model is.
 *
 * Background: `terrain/alphamask.png` clips every terrain image to a single
 * hex's outline (see `images/ImageCache.ts`'s `~HEXED()` op, which applies the
 * 72x72 crop + mask). That alone is not sufficient to position a layer,
 * though — see the offset note on {@link layerOffset} below.
 */

import * as PIXI from 'pixi.js'
import { hexedRef, ImageCache } from './images/ImageCache'
import { joinRef } from './images/ipf'

/** One animation-cycle frame of a terrain image layer. */
export interface TerrainFrame {
  /** Image path, already resolved against the content VFS. */
  path: string
  /** Raw IPF modifier chain (no leading `~`), or ''. */
  mods: string
  /** Frame duration in ms; only meaningful when a layer has >1 frame. */
  durationMs: number
  /** Pixel offset from the queried hex's centre — see {@link layerOffset}. */
  offsetX?: number
  offsetY?: number
}

/** One terrain image layer: a single image, or an animation cycle of frames. */
export interface TerrainLayer {
  frames: TerrainFrame[]
}

/**
 * The (offsetX, offsetY) carried by a layer's first frame.
 *
 * Upstream never offsets anything at draw time: `display::draw_hex` blits
 * every terrain texture at `get_location_rect(loc)` of the tile the image is
 * attached to, and `terrain_builder::apply_rule` attaches each constraint's
 * images to that constraint's *own* tile. Which slice of a multi-hex image
 * lands on which tile is the `~GLOBAL(...)` crop's job (see
 * `terrain/terrainBuilder.ts`), not a position nudge.
 *
 * attempt #1 concluded the opposite ("the offset says which hex this layer
 * belongs to and must be applied") because its engine fork's
 * `get_terrain_frames_at()` reported a rule's images against the tile it
 * queried and encoded the target hex in basex/basey. This project's
 * `terrainBuilder.ts` mirrors upstream's per-tile attachment instead, so it
 * always emits `offsetX = offsetY = 0`; applying `basex - 36` on top of that
 * double-shifted every layer and broke every transition (caught by comparing
 * against the real engine's `--screenshot` of the same map). The field is
 * kept for the rare caller that genuinely wants a draw-time nudge.
 */
export function layerOffset(frame: TerrainFrame): { x: number; y: number } {
  return { x: frame.offsetX ?? 0, y: frame.offsetY ?? 0 }
}

/**
 * Build one sprite (or animated sprite) for one terrain layer, positioned at
 * hex-centre pixel `(px, py)` plus the layer's neighbour-hex offset.
 *
 * `layer.frames` is an animation cycle: one frame means a static image,
 * several mean an `AnimatedSprite`. Drawing each frame as its own sprite
 * would stack all of them (e.g. all 13 water-wave frames superimposed as a
 * static ring) — grouping them here is what fixes that.
 *
 * Textures are requested hexed (`~HEXED()`, see `images/ImageCache.ts`), so
 * each is already cropped to the 72x72 hex box and clipped to the hex
 * outline — the same thing `image::HEXED` does before the engine blits it.
 * That is why no additional cropping is applied here, only the offset.
 *
 * Returns `null` if none of the layer's frames have a resolved texture yet
 * (the caller is expected to have preloaded refs via `ImageCache.preload`).
 */
export function makeLayerSprite(
  layer: TerrainLayer,
  px: number,
  py: number,
): PIXI.Sprite | PIXI.AnimatedSprite | null {
  const frames = layer.frames
  if (!frames || frames.length === 0) return null

  const usable = frames
    .map(f => ({ f, tex: ImageCache.getRef(hexedRef(joinRef(f.path, f.mods))) }))
    .filter((p): p is { f: TerrainFrame; tex: PIXI.Texture } => !!p.tex && !p.tex.destroyed)

  if (usable.length === 0) return null

  let sprite: PIXI.Sprite | PIXI.AnimatedSprite

  if (usable.length === 1) {
    sprite = new PIXI.Sprite(usable[0]!.tex)
  } else {
    const anim = new PIXI.AnimatedSprite(
      usable.map(({ f, tex }) => ({ texture: tex, time: Math.max(1, f.durationMs) })),
    )
    anim.animationSpeed = 1
    anim.play()
    sprite = anim
  }

  const { x: offsetX, y: offsetY } = layerOffset(usable[0]!.f)
  sprite.anchor.set(0.5)
  sprite.x = px + offsetX
  sprite.y = py + offsetY
  return sprite
}
