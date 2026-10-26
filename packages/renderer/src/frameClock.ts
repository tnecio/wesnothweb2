/**
 * Phase 33: one clock for every looping board animation -- the animated terrain images (water, fire, ...) and the
 * village flags -- instead of a `PIXI.AnimatedSprite` with its own ticker callback each.
 *
 * Upstream draws terrain animations from one global time (`display::get_terrain_images`, `animated<image>` updated
 * from `SDL_GetTicks()`), so every water hex shows the same frame at the same moment. Each sprite here likewise
 * shows the frame its cycle has reached at `now` (plus a fixed offset, for the village flags' one phase per side),
 * and its texture is set only when that frame changes. That matters beyond the ticker callbacks it saves: each
 * frame is a texture of its own, and swapping a sprite's texture to another source makes PixiJS rebuild the whole
 * render group's instructions. Hundreds of unsynchronised cycles changed some frame nearly every frame; in step,
 * the frames change together a few times a second (measured by `apps/web/scripts/perf-playthrough.mjs`).
 */
import type * as PIXI from 'pixi.js'
import type { AtlasPages } from './atlasPages'

export interface ClockFrame {
  readonly texture: PIXI.Texture
  /** How long this frame shows, in ms (at least 1). */
  readonly durationMs: number
}

interface Entry {
  readonly sprite: PIXI.Sprite
  readonly frames: readonly ClockFrame[]
  readonly periodMs: number
  /** Added to the clock's time for this sprite (village flags: one phase per side). */
  readonly offsetMs: number
  /** Whether it animates now (the "Animate map"/"Animate water" preferences); held on frame 0 when not. */
  readonly animates: () => boolean
  shown: number
}

/** The frame a cycle of `frames` shows `t` ms into it (`t` taken modulo the cycle). */
export function frameAt(frames: readonly ClockFrame[], periodMs: number, t: number): number {
  let into = ((t % periodMs) + periodMs) % periodMs
  for (let i = 0; i < frames.length; i++) {
    into -= frames[i]!.durationMs
    if (into < 0) return i
  }
  return frames.length - 1
}

export class FrameClock {
  private entries: Entry[] = []
  /** Where cycles are copied, each onto one page (`atlasPages.ts`), so changing frame changes no source. */
  private atlas: AtlasPages | null = null

  useAtlas(atlas: AtlasPages | null): void {
    this.atlas = atlas
  }

  /** Animates `sprite` through `frames`; a single frame is just set. Returns the sprite. */
  add(sprite: PIXI.Sprite, cycle: readonly ClockFrame[], options: { offsetMs?: number; animates?: () => boolean } = {}): PIXI.Sprite {
    let frames = cycle
    if (this.atlas && cycle.length > 1) {
      const textures = this.atlas.cycle(cycle.map((f) => f.texture))
      frames = cycle.map((f, i) => ({ texture: textures[i]!, durationMs: f.durationMs }))
    }
    sprite.texture = frames[0]!.texture
    if (frames.length < 2) return sprite
    const periodMs = frames.reduce((sum, f) => sum + f.durationMs, 0)
    this.entries.push({ sprite, frames, periodMs, offsetMs: options.offsetMs ?? 0, animates: options.animates ?? (() => true), shown: 0 })
    return sprite
  }

  /** Forgets the sprites that have been destroyed (a rebuilt layer). */
  prune(): void {
    this.entries = this.entries.filter((e) => !e.sprite.destroyed)
  }

  /** Forgets every sprite of `layer` (its children are about to be replaced). */
  removeWithin(layer: PIXI.Container): void {
    this.entries = this.entries.filter((e) => !e.sprite.destroyed && !isWithin(e.sprite, layer))
  }

  clear(): void {
    this.entries = []
  }

  get size(): number {
    return this.entries.length
  }

  /** Shows each sprite's frame at `now` (ms); a texture is set only when the frame changed. */
  tick(now: number): void {
    let dead = false
    for (const e of this.entries) {
      if (e.sprite.destroyed) {
        dead = true
        continue
      }
      const index = e.animates() ? frameAt(e.frames, e.periodMs, now + e.offsetMs) : 0
      if (index === e.shown) continue
      e.shown = index
      e.sprite.texture = e.frames[index]!.texture
    }
    if (dead) this.prune()
  }
}

function isWithin(node: PIXI.Container, ancestor: PIXI.Container): boolean {
  for (let p: PIXI.Container | null = node; p; p = p.parent) if (p === ancestor) return true
  return false
}
