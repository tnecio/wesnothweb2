/**
 * Image cache: resolves a Wesnoth image reference (path + IPF modifier chain)
 * to a PIXI texture.
 *
 * Since Phase 28a the pixel work lives in `./compositor.ts` (PixiJS-free) and
 * normally runs in a pool of Web Workers (`./compositorPool.ts`), so the
 * compositing no longer blocks the UI. This class keeps what is PixiJS-
 * specific and main-thread bound: the texture cache, de-duplication of
 * in-flight renders, and wrapping results as textures. Where workers are
 * unavailable (Node tests, browsers without OffscreenCanvas in workers, or
 * `globalThis.__wesnothImageWorkers = false` for A/B measurement) it
 * composites in-thread with identical output.
 *
 * Everything is keyed on the full `path~mods` string and computed once. The
 * key is opaque, so results could later be baked to static assets without
 * touching any call site. Output is pinned by
 * `packages/renderer/fixtures/imagecache-golden.json`.
 *
 * The URL/ref helpers (`imageUrl`, `hexedRef`, `todRef`, base URL setters)
 * are re-exported from the compositor so existing imports keep working.
 */

import * as PIXI from 'pixi.js'
import { joinRef } from './ipf'
import type { ColorData } from './teamColor'
import { Compositor, type CompositedImage } from './compositor'
import { CompositorPool, defaultPoolSize, type RenderPriority } from './compositorPool'

export { hexedRef, todRef, imageUrl, setImageBaseUrl, setEngineImageBaseUrl, setCampaignImages, setEngineImages } from './compositor'

function workersWanted(): boolean {
  if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false
  return (globalThis as { __wesnothImageWorkers?: boolean }).__wesnothImageWorkers !== false
}

class ImageCacheImpl {
  /** In-thread pixel work: the fallback, and the only path outside browsers. */
  private readonly compositor = new Compositor()
  /** Worker pool; `undefined` until first needed, `null` when unavailable. */
  private pool: CompositorPool | null | undefined
  private atlasManifests: readonly string[] = []
  private poolUsable: Promise<boolean> | undefined

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
    this.pool?.setColorData(colors)
  }

  /**
   * Phase 28a P5: image bundle manifests (e.g. a scenario's
   * `/atlases/<id>/terrain.json`) to take source images from; see
   * `Compositor.setAtlasManifests`. Replaces the previous list.
   */
  setAtlasManifests(urls: readonly string[]): void {
    this.atlasManifests = [...urls]
    this.compositor.setAtlasManifests(this.atlasManifests)
    this.pool?.setAtlasManifests(this.atlasManifests)
  }

  /**
   * Phase 28a P6: appends bundle manifests not already registered (unit
   * type bundles as types appear). With `prefetch`, their bundle images are
   * downloaded right away (worker pool only) so first use needs no network.
   */
  addAtlasManifests(urls: Iterable<string>, options: { prefetch?: boolean } = {}): void {
    const added = [...new Set(urls)].filter((url) => !this.atlasManifests.includes(url))
    if (added.length > 0) this.setAtlasManifests([...this.atlasManifests, ...added])
    if (options.prefetch) {
      this.ensurePool()
      for (const url of urls) {
        if (this.prefetched.has(url)) continue
        this.prefetched.add(url)
        this.pool?.prefetchAtlasBundle(url)
      }
    }
  }

  private readonly prefetched = new Set<string>()

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

  /** Resolve and cache a set of refs (bulk, low priority). Failures are logged, never thrown. */
  async preload(refs: Iterable<string>): Promise<void> {
    const before = this.compositor.recolorMs
    await Promise.all([...refs].map(r => this.resolveRef(r, 'low')))
    const spent = this.compositor.recolorMs - before
    if (spent > 50) {
      console.debug(`[ImageCache] recolour pixel work: ${spent.toFixed(0)} ms over ${this.compositor.recolorCount} images`)
    }
  }

  async resolve(path: string, mods?: string | null): Promise<PIXI.Texture | null> {
    return this.resolveRef(joinRef(path, mods), 'high')
  }

  private resolveRef(ref: string, priority: RenderPriority): Promise<PIXI.Texture | null> {
    const existing = this.textures.get(ref)
    if (existing && !existing.destroyed) return Promise.resolve(existing)

    const inFlight = this.pending.get(ref)
    if (inFlight) return inFlight

    const job = this.render(ref, priority)
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

  /** Composites `ref` in a worker when the pool is usable, else in-thread. */
  private ensurePool(): void {
    if (this.pool !== undefined) return
    this.pool = workersWanted() ? CompositorPool.create(defaultPoolSize(), this.compositor.getColorData()) : null
    this.pool?.setAtlasManifests(this.atlasManifests)
    this.poolUsable = this.pool ? this.pool.ready : Promise.resolve(false)
  }

  private async render(ref: string, priority: RenderPriority): Promise<CompositedImage | ImageBitmap | null> {
    this.ensurePool()
    if (this.pool && (await this.poolUsable)) return this.pool.render(ref, priority)
    if (this.pool) {
      // A worker could not composite: fall back for good.
      this.pool.terminate()
      this.pool = null
    }
    return this.compositor.render(ref)
  }

  private toTexture(bmp: CompositedImage | ImageBitmap): PIXI.Texture {
    if (typeof ImageBitmap !== 'undefined' && bmp instanceof ImageBitmap) {
      if (transferredBitmapsUploadStraight()) {
        // WebKit (Safari): drawn onto a canvas, whose upload premultiplies as PixiJS asks (see the probe).
        const canvas = makeTextureCanvas(bmp.width, bmp.height)
        canvas.getContext('2d')!.drawImage(bmp, 0, 0)
        bmp.close()
        return new PIXI.Texture({ source: new PIXI.CanvasSource({ resource: canvas as unknown as HTMLCanvasElement }) })
      }
      // Worker result: the composited pixels, transferred without copying.
      return new PIXI.Texture({ source: new PIXI.ImageSource({ resource: bmp }) })
    }
    // In-thread result: a canvas that is already the composited image.
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
    return this.resolveRef(ref, 'high')
  }

  /** Drop everything (call when the board is destroyed). */
  clear(): void {
    for (const tex of this.textures.values()) tex.destroy(true)
    this.textures.clear()
    this.pending.clear()
    this.compositor.clear()
    this.pool?.cancelAll()
  }

  get size(): number {
    return this.textures.size
  }
}

export const ImageCache = new ImageCacheImpl()

let uploadsStraight: boolean | null = null

/**
 * Whether this browser uploads a worker's `transferToImageBitmap` result to WebGL with its colour not
 * premultiplied, though PixiJS asks for it (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`): WebKit does, Chromium does not.
 * Every translucent pixel then draws far too bright -- real, reported: Of Pearls and Pirates 1's terrain "way off"
 * on Safari, its transitions glaring. Probed once: a half-transparent red pixel, uploaded as PixiJS uploads an
 * ImageBitmap, read back. (The worker cannot fix it itself: WebKit's worker crashes making a bitmap from a
 * canvas, and premultiplies a transferred one twice.)
 */
export function transferredBitmapsUploadStraight(): boolean {
  if (uploadsStraight !== null) return uploadsStraight
  uploadsStraight = false
  try {
    if (typeof OffscreenCanvas === 'undefined') return uploadsStraight
    const source = new OffscreenCanvas(1, 1)
    const ctx = source.getContext('2d')
    if (!ctx) return uploadsStraight
    ctx.fillStyle = 'rgba(255, 0, 0, 0.502)'
    ctx.fillRect(0, 0, 1, 1)
    const bitmap = source.transferToImageBitmap()
    const gl = new OffscreenCanvas(1, 1).getContext('webgl')
    if (!gl) return uploadsStraight
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    const framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    const pixel = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    uploadsStraight = pixel[3]! > 0 && pixel[0]! > 200
    bitmap.close()
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    uploadsStraight = false
  }
  return uploadsStraight
}

/** A canvas for one texture's pixels: a DOM canvas (WebKit uploads an OffscreenCanvas to WebGL as black). */
function makeTextureCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof document === 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

