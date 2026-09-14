/**
 * Image cache: resolves a Wesnoth image reference (path + IPF modifier chain)
 * to a PIXI texture.
 *
 * Since Phase 28a P1 the pixel work lives in `./compositor.ts` (PixiJS-free,
 * worker-ready); this class keeps what is PixiJS-specific and main-thread
 * bound: the texture cache, de-duplication of in-flight renders, and wrapping
 * composited canvases as textures. Everything is keyed on the full
 * `path~mods` string and computed once. The key is opaque, so results could
 * later be baked to static assets without touching any call site.
 *
 * The URL/ref helpers (`imageUrl`, `hexedRef`, `todRef`, base URL setters)
 * are re-exported from the compositor so existing imports keep working.
 */

import * as PIXI from 'pixi.js'
import { joinRef } from './ipf'
import type { ColorData } from './teamColor'
import { Compositor, type CompositedImage } from './compositor'

export { hexedRef, todRef, imageUrl, setImageBaseUrl, setEngineImageBaseUrl } from './compositor'

class ImageCacheImpl {
  /** Does the pixel work; see `./compositor.ts`. */
  private readonly compositor = new Compositor()

  /** Fully resolved textures, keyed by `path~mods`. (Read by apps/web/scripts/image-golden.mjs.) */
  private readonly textures = new Map<string, PIXI.Texture>()
  /** In-flight renders, so N hexes needing the same image cause one render. */
  private readonly pending = new Map<string, Promise<PIXI.Texture | null>>()

  /**
   * Supply the engine's palettes and per-side colour ranges. Must be set before
   * resolving any ref that uses ~TC or ~RC; without it those ops are skipped and
   * units render in their reference palette (magenta).
   */
  setColorData(colors: ColorData | null): void {
    this.compositor.setColorData(colors)
  }

  /** The palettes/ranges/defaultColors supplied via `setColorData`, or `null` if none has been set yet. */
  getColorData(): ColorData | null {
    return this.compositor.getColorData()
  }

  /** Synchronous lookup for already-resolved refs (used during hex construction). */
  get(path: string, mods?: string | null): PIXI.Texture | null {
    return this.getRef(joinRef(path, mods))
  }

  /** As get(), for a reference already joined (e.g. by hexedRef). */
  getRef(ref: string): PIXI.Texture | null {
    const tex = this.textures.get(ref)
    return tex && !tex.destroyed ? tex : null
  }

  /** Resolve and cache a set of refs. Failures are logged, never thrown. */
  async preload(refs: Iterable<string>): Promise<void> {
    const before = this.compositor.recolorMs
    await Promise.all([...refs].map(r => this.resolveRef(r)))
    const spent = this.compositor.recolorMs - before
    if (spent > 50) {
      console.debug(`[ImageCache] recolour pixel work: ${spent.toFixed(0)} ms over ${this.compositor.recolorCount} images`)
    }
  }

  async resolve(path: string, mods?: string | null): Promise<PIXI.Texture | null> {
    return this.resolveRef(joinRef(path, mods))
  }

  private resolveRef(ref: string): Promise<PIXI.Texture | null> {
    const existing = this.textures.get(ref)
    if (existing && !existing.destroyed) return Promise.resolve(existing)

    const inFlight = this.pending.get(ref)
    if (inFlight) return inFlight

    const job = this.compositor.render(ref)
      .then(bmp => {
        if (!bmp) return null
        const tex = this.toTexture(bmp)
        this.textures.set(ref, tex)
        return tex
      })
      .catch(err => {
        console.warn(`[ImageCache] failed to build "${ref}":`, err)
        return null
      })
      .finally(() => this.pending.delete(ref))

    this.pending.set(ref, job)
    return job
  }

  private toTexture(bmp: CompositedImage): PIXI.Texture {
    // A canvas result is already the composited image.
    const source = new PIXI.CanvasSource({
      resource: bmp as unknown as HTMLCanvasElement,
    })
    return new PIXI.Texture({ source })
  }

  /**
   * Resolve a joined reference and return its texture.
   *
   * Exposed for scripts/dump-images.js, which diffs this pipeline against the
   * engine's own rasteriser (wl-image-oracle), and for
   * apps/web/scripts/image-golden.mjs. Identical to resolveRef, but public so
   * the comparison harness does not depend on private internals.
   */
  resolveRefForTest(ref: string): Promise<PIXI.Texture | null> {
    return this.resolveRef(ref)
  }

  /** Drop everything (call when the board is destroyed). */
  clear(): void {
    for (const tex of this.textures.values()) tex.destroy(true)
    this.textures.clear()
    this.pending.clear()
    this.compositor.clear()
  }

  get size(): number {
    return this.textures.size
  }
}

export const ImageCache = new ImageCacheImpl()
