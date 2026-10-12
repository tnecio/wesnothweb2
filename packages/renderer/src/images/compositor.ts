/**
 * Image compositor: resolves a Wesnoth image reference (path + IPF modifier
 * chain) to composited pixels on a canvas. PixiJS-free and DOM-light on
 * purpose (Phase 28a P1): it depends only on `fetch`, `createImageBitmap` and
 * canvas 2D, all of which also exist inside a Web Worker, so it can move off
 * the main thread (P2). `ImageCache` wraps its output in PixiJS textures.
 *
 * Why this exists: the engine ships modifier strings (`MASK(...)`, `CROP(...)`)
 * rather than pixels, and ignoring them draws every terrain transition image in
 * full instead of clipped to its hex wedge — the board renders as overlapping
 * rectangles. MASK and CROP alone account for ~33k of the ~34k modifier uses on
 * a typical map.
 *
 * Why in JS rather than C++: the ops that actually occur (MASK, CROP, O, BLIT,
 * NOP) are all plain compositing, which canvas2d does natively and fast. Keeping
 * it here avoids a WASM rebuild for every change, and the browser's own PNG
 * decoder and HTTP cache stay in play.
 *
 * Ported near-verbatim from attempt #1
 * (wesnothweb/frontend/src/board/images/ImageCache.ts) — this file encodes
 * weeks of pixel-fidelity debugging against the real C++ engine and the
 * compositing math is deliberately NOT re-derived here. Its output is pinned
 * by `packages/renderer/fixtures/imagecache-golden.json`
 * (`npm run check:image-golden`). The only behavioural change from the
 * original is `imageUrl()`: attempt #1 hardcoded a `/data/data/` dev-server
 * prefix tied to its own asset-serving setup; here the base is a
 * configurable module-level value (see `setImageBaseUrl`).
 *
 * MUST NOT import `pixi.js` (or anything that does) -- enforced by
 * `test/compositorIsolation.test.ts`.
 */

import { parseIpf, splitRef, type IpfOp } from './ipf'
import { generateColorMapping, type ColorData } from './teamColor'
import type { TodColor } from '../animation/timeOfDay'
import { cloneRaster, makeRaster, type Raster } from './surfaceOps'
import { applyModification, modificationOrder, PIXEL_OPS, STRAIGHT_OPS, type ModificationContext } from './modifications'

export { scaledSize } from './modifications'

/** Hex tile size, and the alpha mask every terrain image is clipped by. */
const TILE = 72
export const HEX_MASK = 'terrain/alphamask.png'

/**
 * Wrap a reference so it rasterises the way the engine draws terrain.
 *
 * The engine applies this at draw time (image::HEXED), not as part of the
 * locator's modifier chain, so it is modelled here as a trailing pseudo-op. It
 * still participates in the cache key, which is what we want: the hexed and
 * un-hexed forms of an image are different textures.
 */
export function hexedRef(ref: string): string {
  return `${ref}~HEXED()`
}

/**
 * Wrap a reference with a time-of-day tint (see `../animation/timeOfDay.ts`).
 *
 * Like `~HEXED()`, this is not a real IPF modifier — upstream applies
 * time-of-day colour as a separate global blit stage
 * (`image::set_color_adjustment`/`get_tod_colored`), not via a locator's own
 * modifier chain — so it's modelled the same way: a trailing pseudo-op that
 * still participates in the cache key (a unit under a red dusk tint is a
 * different texture from the same unit at midday).
 */
export function todRef(ref: string, tod: TodColor): string {
  if (tod.r === 0 && tod.g === 0 && tod.b === 0) return ref
  return `${ref}~TOD(${tod.r},${tod.g},${tod.b})`
}

/** Ops we have not implemented, warned about once each rather than per use. */
const warnedOps = new Set<string>()

function warnOnce(op: string): void {
  if (warnedOps.has(op)) return
  warnedOps.add(op)
  console.warn(`[ImageCache] unimplemented IPF op ~${op}() — ignored`)
}

/**
 * Base URL that resolved image paths are served under. Defaults to the same
 * `/data/data/` convention attempt #1 used; call `setImageBaseUrl` once
 * `apps/web`'s asset-serving story is settled if a different prefix is needed.
 */
let imageBaseUrl = '/data/data'

/** Override the base URL used by {@link imageUrl}. No trailing slash needed. */
export function setImageBaseUrl(base: string): void {
  imageBaseUrl = base.replace(/\/+$/, '')
}

/**
 * Base URL for "engine" images — real Wesnoth mounts two physical roots onto
 * one `images/...` VFS namespace: `data/core/images/` (content art: units,
 * terrain, portraits) and a separate top-level `images/` (built-in engine
 * chrome: orbs, energy bars, the leader crown, cursors, panels — see
 * `wesnoth/images/` vs. `wesnoth/data/core/images/` in the checked-out
 * submodule; confirmed against `data/game_config.cfg`'s `orb=`/
 * `leader_crown`-equivalent paths, which resolve only under the former).
 * `imageUrl` can't merge two physical roots into one lookup the way the real
 * VFS does, so a reference to something that only exists under the engine
 * root is spelled with an explicit `engine/` pseudo-prefix (stripped here,
 * not part of the real path) — see `imageUrl`'s own doc comment.
 */
let engineImageBaseUrl = '/data/data-engine'

/** Override the base URL used for `engine/`-prefixed references — see {@link engineImageBaseUrl}. No trailing slash needed. */
export function setEngineImageBaseUrl(base: string): void {
  engineImageBaseUrl = base.replace(/\/+$/, '')
}

/** The current base URLs, for handing to a worker compositor (each worker has its own copy of this module). */
export function getImageBaseUrls(): { image: string; engine: string } {
  return { image: imageBaseUrl, engine: engineImageBaseUrl }
}

/**
 * Turn an engine image reference into a fetchable URL.
 *
 * Terrain layer paths arrive already resolved against the VFS
 * ("core/images/terrain/..."). References *inside* modifiers do not — a mask is
 * named relative to the images root ("terrain/masks/7hex-tr.png") — so those get
 * the core images prefix. An `engine/` prefix instead routes to
 * {@link engineImageBaseUrl} (see its own doc comment) — used only for the
 * handful of engine-chrome assets (currently just the leader crown) that
 * don't exist under `core/images/` at all.
 */
export function imageUrl(path: string): string {
  const rooted = rootedImagePath(path)
  return rooted.startsWith('engine/')
    ? `${engineImageBaseUrl}/${rooted.slice('engine/'.length)}`
    : `${imageBaseUrl}/${rooted}`
}

/**
 * The base-URL-independent identity of an image file: `core/...` or
 * `campaigns/...` (relative to `wesnoth/data`), or `engine/...` (relative to
 * `wesnoth/images`). Image bundle manifests are keyed by it (Phase 28a P5,
 * `apps/web/scripts/build-image-atlases.mjs`).
 */
export function rootedImagePath(path: string): string {
  const trimmed = path.replace(/^\/+/, '')
  if (/^(engine|core|campaigns|internal)\//.test(trimmed)) return trimmed
  // The engine's image search: the campaign's binary paths first, then core, then the game root's images/.
  const tilde = trimmed.indexOf('~')
  // The file system reads `L3//delfador.png` (TDG's Delfador, a macro's path ending in `/`) as `L3/delfador.png`.
  const file = (tilde < 0 ? trimmed : trimmed.slice(0, tilde)).replace(/\/{2,}/g, '/')
  const mods = tilde < 0 ? '' : trimmed.slice(tilde)
  const found = (name: string): string | null => {
    const own = campaignImages.find((p) => p.files.has(name))
    if (own) return `${own.root}/${name}${mods}`
    return engineImages.has(name) ? `engine/${name}${mods}` : null
  }
  // `load_image_file`: a `.png` or `.jpg` found nowhere is looked for as `.webp` (many were converted). Core
  // has no file list here, so only the campaign's and the engine's images are checked.
  return found(file) ?? (/\.(png|jpg)$/.test(file) ? found(file.slice(0, -4) + '.webp') : null) ?? `core/images/${file}${mods}`
}

let engineImages: ReadonlySet<string> = new Set()

/**
 * The images only the engine's own `images/` has (relative to it): upstream's
 * last binary path is the game root, so `misc/tod-bright.png` is found there.
 * `rootedImagePath` spells them `engine/...`.
 */
export function setEngineImages(files: Iterable<string>): void {
  engineImages = new Set(files)
}

/** What `setEngineImages` set (the compositor workers get the same, see `compositorPool`). */
export function getEngineImages(): ReadonlySet<string> {
  return engineImages
}

/** A binary path's `images/` (`root`, e.g. `campaigns/Dead_Water/images`) and the files under it, relative to it. */
export interface ImagePath {
  readonly root: string
  readonly files: ReadonlySet<string>
}

let campaignImages: readonly ImagePath[] = []

/**
 * Phase 18: the current campaign's `[binary_path]`s, searched in this order before core by
 * `rootedImagePath`: its own `images/`, then any it includes (`{internal/Rogue_Mage}`). Empty for none (a
 * synthetic campaign).
 */
export function setCampaignImages(paths: readonly { readonly root: string; readonly files: Iterable<string> }[]): void {
  campaignImages = paths.map((p) => ({ root: p.root, files: new Set(p.files) }))
}

/** What `setCampaignImages` set (the compositor workers get the same, see `compositorPool`). */
export function getCampaignImages(): readonly ImagePath[] {
  return campaignImages
}

/**
 * Phase 28a P6: file-name stem of a unit type's bundle -- the type id with
 * everything but letters, digits and `-` escaped as `_` + 4 hex digits
 * ("Elvish Fighter" -> "Elvish_0020Fighter"), so ids map to distinct, URL-safe names.
 */
export function unitBundleStem(typeId: string): string {
  return typeId.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Manifest URL of a unit type's bundle (built by `apps/web/scripts/build-image-atlases.mjs`). */
export function unitBundleManifestUrl(typeId: string): string {
  return `/atlases/units/${unitBundleStem(typeId)}.json`
}

/**
 * URL of a bundle image named by a manifest: relative to the manifest (as built), or absolute when a
 * production build rewrote it to a content-hashed path (Phase 28 S3, `apps/web/scripts/stage-dist.mjs`).
 */
export function atlasFileUrl(manifestUrl: string, file: string): string {
  return file.startsWith('/') || /^[a-z]+:/i.test(file) ? file : `${manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1)}${file}`
}

/** One image bundle manifest (`public/atlases/<scenario>/terrain.json`, `public/atlases/units/<type>.json`). */
export interface AtlasManifest {
  atlases: { file: string; width: number; height: number }[]
  /** Rooted image path -> [atlas index, x, y, width, height]. */
  images: Record<string, [number, number, number, number, number]>
}

type Bitmap = ImageBitmap | HTMLImageElement

/** A composited result: an OffscreenCanvas where available (always, in a worker), else a DOM canvas. */
export type CompositedImage = OffscreenCanvas | HTMLCanvasElement

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function ctx2d(c: OffscreenCanvas | HTMLCanvasElement): CanvasRenderingContext2D {
  const g = (c as HTMLCanvasElement).getContext('2d', { willReadFrequently: true })
  if (!g) throw new Error('2d context unavailable')
  return g as CanvasRenderingContext2D
}

export class Compositor {
  /** Palette/range data from the engine; needed for ~TC and ~RC. */
  private colors: ColorData | null = null
  /** Memoised colour mappings, keyed by the modifier arguments. */
  private readonly colorMaps = new Map<string, Map<number, number>>()

  /** Decoded source images, keyed by URL. */
  private readonly bitmaps = new Map<string, Promise<Bitmap | null>>()

  /** Bundle manifests to consult before fetching a file on its own (see `setAtlasManifests`). */
  private atlasManifestUrls: readonly string[] = []
  private readonly manifests = new Map<string, Promise<AtlasManifest | null>>()
  /** Decoded bundle images, keyed by URL. */
  private readonly atlasBitmaps = new Map<string, Promise<ImageBitmap | null>>()
  private readonly warnedFallbacks = new Set<string>()

  /** Cumulative time in the pixel-readback path, to attribute cost honestly. */
  recolorMs = 0
  recolorCount = 0

  /**
   * Supply the engine's palettes and per-side colour ranges. Must be set before
   * resolving any ref that uses ~TC or ~RC; without it those ops are skipped and
   * units render in their reference palette (magenta).
   */
  setColorData(colors: ColorData | null): void {
    this.colors = colors
    this.colorMaps.clear()
  }

  /** The palettes/ranges/defaultColors supplied via `setColorData`, or `null` if none has been set yet. */
  getColorData(): ColorData | null {
    return this.colors
  }

  /** Drop every decoded source image. */
  clear(): void {
    this.bitmaps.clear()
    this.straightDecodes.clear()
    this.atlasBitmaps.clear()
  }

  /**
   * Phase 28a P5: image bundles to use. A source image listed in one of
   * these manifests is cropped out of its (once-decoded) bundle image;
   * anything else is fetched on its own, exactly as without bundles. A
   * missing or broken manifest is ignored.
   */
  setAtlasManifests(urls: readonly string[]): void {
    this.atlasManifestUrls = [...urls]
  }

  private loadManifest(url: string): Promise<AtlasManifest | null> {
    let manifest = this.manifests.get(url)
    if (!manifest) {
      // Through the atlas fetcher too, so workers share one download. A missing file may come back as the
      // dev server's HTML page, hence the type check.
      manifest = this.atlasFetcher(url)
        .then(async (blob) => (blob && blob.type.includes('json') ? (JSON.parse(await blob.text()) as AtlasManifest) : null))
        .catch(() => null)
      this.manifests.set(url, manifest)
    }
    return manifest
  }

  /**
   * How bundle image bytes are obtained. Defaults to a plain fetch; the
   * worker pool replaces it so all workers share ONE download per bundle
   * (a whole-bundle fetch per worker tripled Dead Water 1's terrain bytes,
   * and the HTTP cache did not reliably de-duplicate the concurrent requests).
   */
  setAtlasFetcher(fetcher: (url: string) => Promise<Blob | null>): void {
    this.atlasFetcher = fetcher
  }

  private atlasFetcher: (url: string) => Promise<Blob | null> = (url) =>
    fetch(url)
      .then((res) => (res.ok ? res.blob() : null))
      .catch(() => null)

  private loadAtlas(url: string): Promise<ImageBitmap | null> {
    let atlas = this.atlasBitmaps.get(url)
    if (!atlas) {
      atlas = this.atlasFetcher(url)
        .then((blob) => (blob ? createImageBitmap(blob, { colorSpaceConversion: 'none' }) : null))
        .catch(() => null)
      this.atlasBitmaps.set(url, atlas)
    }
    return atlas
  }

  /** The image from a bundle, or undefined when no loaded manifest has it. */
  private async fromAtlas(path: string): Promise<ImageBitmap | null | undefined> {
    const rooted = rootedImagePath(path)
    const urls = this.atlasManifestUrls
    // Manifests load in parallel (a board can register dozens of unit type bundles); first match in list order wins.
    const manifests = await Promise.all(urls.map((url) => this.loadManifest(url)))
    for (let i = 0; i < urls.length; i++) {
      const manifestUrl = urls[i]!
      const manifest = manifests[i]
      const rect = manifest?.images[rooted]
      if (!manifest || !rect) continue
      const [index, x, y, w, h] = rect
      const entry = manifest.atlases[index]
      if (!entry) continue
      const atlas = await this.loadAtlas(atlasFileUrl(manifestUrl, entry.file))
      if (!atlas) continue
      return createImageBitmap(atlas, x, y, w, h)
    }
    if (this.atlasManifestUrls.length > 0 && !this.warnedFallbacks.has(rooted)) {
      this.warnedFallbacks.add(rooted)
      console.debug(`[ImageCache] not in any image bundle, fetching on its own: ${rooted}`)
    }
    return undefined
  }

  private tcMapping(side: number, paletteName: string): Map<number, number> | null {
    if (!this.colors || !Number.isFinite(side)) return null
    const key = `TC:${side}:${paletteName}`
    const hit = this.colorMaps.get(key)
    if (hit) return hit

    const palette = this.colors.palettes[paletteName]
    const range = this.colors.sideRanges[side]
    if (!palette || !range) {
      warnOnce(`TC(${side},${paletteName})`)
      return null
    }
    const map = generateColorMapping(range, palette)
    this.colorMaps.set(key, map)
    return map
  }

  private rcMapping(spec: string): Map<number, number> | null {
    if (!this.colors) return null
    const key = `RC:${spec}`
    const hit = this.colorMaps.get(key)
    if (hit) return hit

    // "palette>range"; a bare palette name means "no change", which we skip.
    const [from, to] = spec.split('>').map(s => s.trim())
    if (!from || !to) return null

    const palette = this.colors.palettes[from]
    const range = this.colors.ranges[to] ?? this.colors.sideRanges[Number(to)]
    if (!palette || !range) {
      warnOnce(`RC(${spec})`)
      return null
    }
    const map = generateColorMapping(range, palette)
    this.colorMaps.set(key, map)
    return map
  }

  /** Fetch and decode one image file. Missing files resolve to null. */
  private loadBitmap(path: string): Promise<Bitmap | null> {
    const url = imageUrl(path)
    let p = this.bitmaps.get(url)
    if (p) return p

    p = (async () => {
      try {
        const bundled = await this.fromAtlas(path)
        if (bundled !== undefined) return bundled
        const resp = await fetch(url)
        if (!resp.ok) {
          console.warn(`[ImageCache] missing image ${url} (${resp.status})`)
          return null
        }
        // colorSpaceConversion:'none' keeps the decoder from applying the
        // PNG's embedded colour profile. The engine reads raw bytes via
        // SDL_image, so any conversion here shows up as a small uniform shift
        // across every pixel — invisible on screen, but it makes an exact
        // comparison against the engine's own output impossible.
        return await createImageBitmap(await resp.blob(), { colorSpaceConversion: 'none' })
      } catch (err) {
        console.warn(`[ImageCache] failed to load ${url}:`, err)
        return null
      }
    })()

    this.bitmaps.set(url, p)
    return p
  }
  /**
   * Render one image reference to a canvas, applying its modifier chain.
   * Recurses for ops whose arguments are themselves image references.
   */
  async render(ref: string): Promise<CompositedImage | null> {
    const surface = await this.renderSurface(ref)
    return surface ? asCanvas(surface) : null
  }

  /**
   * {@link render}, but leaving the result as straight-alpha pixels when the last op left it so: nested
   * references use this, so their translucent pixels do not go through a (premultiplying) canvas.
   */
  private async renderSurface(ref: string, straight = false): Promise<Surface | null> {
    const { path, mods } = splitRef(ref)
    const ops = modificationOrder(parseIpf(mods))

    let image: Surface | null = null
    if (straight || ops.some((op) => STRAIGHT_OPS.has(op.name))) image = await this.decodeStraight(path)
    if (!image) {
      const base = await this.loadBitmap(path)
      if (!base) return null
      const canvas = makeCanvas(base.width, base.height)
      ctx2d(canvas).drawImage(base as CanvasImageSource, 0, 0)
      image = canvas
    }

    for (const op of ops) {
      image = await this.applyOp(image, op)
    }
    return image
  }

  /** Straight-alpha decodes, keyed by URL (see `decodeStraight`). */
  private readonly straightDecodes = new Map<string, Promise<Raster | null>>()

  /**
   * An image file decoded to straight-alpha pixels, as SDL_image gives them: through `ImageDecoder` with
   * `premultiplyAlpha: 'none'`, since a canvas premultiplies and so rounds away the colour of translucent
   * pixels -- which a lightmap (`~L`) or an op that raises alpha (`~WIPE_ALPHA`, `~SWAP`, `~CHAN`) shows.
   * Null where the browser has no `ImageDecoder` or cannot decode the file this way; the caller then takes
   * the usual (bundle or canvas) path.
   */
  private decodeStraight(path: string): Promise<Raster | null> {
    const Decoder = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder
    if (!Decoder) return Promise.resolve(null)
    const url = imageUrl(path)
    let decoded = this.straightDecodes.get(url)
    if (!decoded) {
      decoded = (async () => {
        try {
          const resp = await fetch(url)
          const type = resp.headers.get('content-type') ?? ''
          if (!resp.ok || !type.startsWith('image/') || !(await Decoder.isTypeSupported(type))) return null
          // `premultiplyAlpha` is in the WebCodecs spec (and Chromium) but not yet in TypeScript's DOM types.
          const init = { data: await resp.arrayBuffer(), type, premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
          const decoder = new Decoder(init as ImageDecoderInit)
          const { image } = await decoder.decode()
          try {
            return await frameToRaster(image)
          } finally {
            image.close()
            decoder.close()
          }
        } catch {
          return null
        }
      })()
      this.straightDecodes.set(url, decoded)
    }
    return decoded.then((r) => (r ? cloneRaster(r) : null))
  }

  private readonly modificationContext: ModificationContext = {
    loadRaster: async (ref, straight) => {
      const surface = await this.renderSurface(ref, straight)
      return surface ? asRaster(surface) : null
    },
    tcMapping: (side, palette) => this.tcMapping(side, palette),
    rcMapping: (spec) => this.rcMapping(spec),
    palette: (name) => this.colors?.palettes[name],
  }

  private async applyOp(image: Surface, op: IpfOp): Promise<Surface> {
    const { name, args } = op

    if (PIXEL_OPS.has(name)) {
      const t0 = performance.now()
      const out = await applyModification(asRaster(image), op, this.modificationContext)
      if (name === 'TC' || name === 'RC' || name === 'PAL') {
        this.recolorMs += performance.now() - t0
        this.recolorCount++
      }
      return out
    }

    switch (name) {
      // ~GLOBAL(locX,locY,centerX,centerY) — pseudo-op (not a real IPF
      // modifier, see `hexedRef`'s own doc comment for the pattern this
      // follows) emitted by `terrain/terrainBuilder.ts`'s `globalCropMod`
      // for `global_image=true` terrain-graphics images: crops the 72x72
      // window belonging to hex `(locX, locY)` out of a LARGER, multi-hex-
      // spanning source image (real mountain art is the prime example --
      // `mountains/basic.png` is much bigger than one hex). Mirrors
      // `picture.cpp`'s `load_image_sub_file`'s loc/center crop exactly,
      // including that `center` only applies its extra shift when BOTH
      // components are >= 0 (upstream's sentinel for "not set" is -1).
      // Always runs before the final `~HEXED()` masking step.
      case 'GLOBAL': {
        const src = asCanvas(image)
        const [locX, locY, centerX, centerY] = args.map(Number)
        if (![locX, locY, centerX, centerY].every(Number.isFinite)) return src
        let x = TILE * 0.75 * locX!
        let y = TILE * locY! + (TILE / 2) * (locX! % 2)
        if (centerX! >= 0 && centerY! >= 0) {
          x += src.width / 2 - centerX!
          y += src.height / 2 - centerY!
        }
        const out = makeCanvas(TILE, TILE)
        ctx2d(out).drawImage(src as CanvasImageSource, x, y, TILE, TILE, 0, 0, TILE, TILE)
        return out
      }

      // ~HEXED() — what image::HEXED does (picture.cpp get_hexed()).
      //
      // Crop the image into a 72x72 box — or centre it there, if smaller —
      // then clip it to the hex with terrain/alphamask.png. No scaling, and
      // deliberately no offset: the engine positions every terrain texture at
      // the hex and uses rule_image basex/basey only to order layers.
      case 'HEXED': {
        const src = asCanvas(image)
        const hexMask = await this.render(HEX_MASK)
        const out = makeCanvas(TILE, TILE)
        const g = ctx2d(out)

        const sx = Math.max(0, Math.trunc((src.width - TILE) / 2))
        const sy = Math.max(0, Math.trunc((src.height - TILE) / 2))
        const sw = Math.min(src.width, TILE)
        const sh = Math.min(src.height, TILE)
        const dx = Math.max(0, Math.trunc((TILE - src.width) / 2))
        const dy = Math.max(0, Math.trunc((TILE - src.height) / 2))
        g.drawImage(src as CanvasImageSource, sx, sy, sw, sh, dx, dy, sw, sh)

        if (hexMask) {
          g.globalCompositeOperation = 'destination-in'
          g.drawImage(hexMask as CanvasImageSource, 0, 0)
        }
        return out
      }

      default:
        warnOnce(name)
        return image
    }
  }
}

/** What a modifier chain is worked on as: a canvas (for the canvas pseudo-ops) or straight-alpha pixels. */
type Surface = CompositedImage | Raster

function isRaster(s: Surface): s is Raster {
  return (s as Raster).data instanceof Uint8ClampedArray
}

function asRaster(s: Surface): Raster {
  if (isRaster(s)) return s
  if (s.width === 0 || s.height === 0) return makeRaster(s.width, s.height)
  const img = ctx2d(s).getImageData(0, 0, s.width, s.height)
  return { width: img.width, height: img.height, data: img.data }
}

/** A decoded frame's pixels as a straight-alpha raster; null for a pixel format other than (A)RGB/BGR(A). */
async function frameToRaster(frame: VideoFrame): Promise<Raster | null> {
  const format = frame.format
  if (format !== 'RGBA' && format !== 'RGBX' && format !== 'BGRA' && format !== 'BGRX') return null
  const width = frame.codedWidth
  const height = frame.codedHeight
  const buffer = new Uint8Array(frame.allocationSize())
  const [plane] = await frame.copyTo(buffer)
  const stride = plane?.stride ?? width * 4
  const offset = plane?.offset ?? 0
  const out = makeRaster(width, height)
  const bgr = format.startsWith('BGR')
  const opaque = format.endsWith('X')
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = offset + y * stride + x * 4
      const q = (y * width + x) * 4
      out.data[q] = buffer[p + (bgr ? 2 : 0)]!
      out.data[q + 1] = buffer[p + 1]!
      out.data[q + 2] = buffer[p + (bgr ? 0 : 2)]!
      out.data[q + 3] = opaque ? 255 : buffer[p + 3]!
    }
  }
  return out
}

function asCanvas(s: Surface): CompositedImage {
  if (!isRaster(s)) return s
  const c = makeCanvas(s.width, s.height)
  if (s.width > 0 && s.height > 0) {
    ctx2d(c).putImageData(new ImageData(s.data as Uint8ClampedArray<ArrayBuffer>, s.width, s.height), 0, 0)
  }
  return c
}
