/**
 * Image cache: resolves a Wesnoth image reference (path + IPF modifier chain)
 * to a PIXI texture, applying the modifiers.
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
 * Everything is keyed on the full `path~mods` string and computed once. The key
 * is opaque, so results could later be baked to static assets without touching
 * any call site.
 *
 * Ported near-verbatim from attempt #1
 * (wesnothweb/frontend/src/board/images/ImageCache.ts) — this file encodes
 * weeks of pixel-fidelity debugging against the real C++ engine and the
 * compositing math is deliberately NOT re-derived here. The only behavioural
 * change from the original is `imageUrl()`: attempt #1 hardcoded a
 * `/data/data/` dev-server prefix tied to its own asset-serving setup; here
 * the base is a configurable module-level value (see `setImageBaseUrl`),
 * since wesnothweb2's content-serving convention isn't finalised yet
 * (see docs/ARCHITECTURE.md "Content pipeline").
 */

import * as PIXI from 'pixi.js'
import { joinRef, parseAlpha, parseIpf, splitRef } from './ipf'
import {
  applyColorMapping, DEFAULT_TC_PALETTE, generateColorMapping, type ColorData,
} from './teamColor'
import { applyTodTint, type TodColor } from '../animation/timeOfDay'

/** Hex tile size, and the alpha mask every terrain image is clipped by. */
const TILE = 72
const HEX_MASK = 'terrain/alphamask.png'

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
 * Turn an engine image reference into a fetchable URL.
 *
 * Terrain layer paths arrive already resolved against the VFS
 * ("core/images/terrain/..."). References *inside* modifiers do not — a mask is
 * named relative to the images root ("terrain/masks/7hex-tr.png") — so those get
 * the core images prefix.
 */
export function imageUrl(path: string): string {
  const clean = path.replace(/^\/+/, '')
  const rooted = clean.startsWith('core/') || clean.startsWith('campaigns/')
    ? clean
    : `core/images/${clean}`
  return `${imageBaseUrl}/${rooted}`
}

type Bitmap = ImageBitmap | HTMLImageElement

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

class ImageCacheImpl {
  /** Palette/range data from the engine; needed for ~TC and ~RC. */
  private colors: ColorData | null = null
  /** Memoised colour mappings, keyed by the modifier arguments. */
  private readonly colorMaps = new Map<string, Map<number, number>>()

  /** Fully resolved textures, keyed by `path~mods`. */
  private readonly textures = new Map<string, PIXI.Texture>()
  /** In-flight renders, so N hexes needing the same image cause one render. */
  private readonly pending = new Map<string, Promise<PIXI.Texture | null>>()
  /** Decoded source images, keyed by URL. */
  private readonly bitmaps = new Map<string, Promise<Bitmap | null>>()

  /** Cumulative time in the pixel-readback path, to attribute cost honestly. */
  private recolorMs = 0
  private recolorCount = 0

  /**
   * Supply the engine's palettes and per-side colour ranges. Must be set before
   * resolving any ref that uses ~TC or ~RC; without it those ops are skipped and
   * units render in their reference palette (magenta).
   */
  setColorData(colors: ColorData | null): void {
    this.colors = colors
    this.colorMaps.clear()
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
    const before = this.recolorMs
    await Promise.all([...refs].map(r => this.resolveRef(r)))
    const spent = this.recolorMs - before
    if (spent > 50) {
      console.debug(`[ImageCache] recolour pixel work: ${spent.toFixed(0)} ms over ${this.recolorCount} images`)
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

    const job = this.render(ref)
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

  private toTexture(bmp: Bitmap | OffscreenCanvas | HTMLCanvasElement): PIXI.Texture {
    // A canvas result is already the composited image; a bare bitmap means the
    // ref had no modifiers and can be uploaded directly.
    const source = new PIXI.CanvasSource({
      resource: bmp as unknown as HTMLCanvasElement,
    })
    return new PIXI.Texture({ source })
  }

  /** Fetch and decode one image file. Missing files resolve to null. */
  private loadBitmap(path: string): Promise<Bitmap | null> {
    const url = imageUrl(path)
    let p = this.bitmaps.get(url)
    if (p) return p

    p = (async () => {
      try {
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
  private async render(ref: string): Promise<OffscreenCanvas | HTMLCanvasElement | null> {
    const { path, mods } = splitRef(ref)
    const base = await this.loadBitmap(path)
    if (!base) return null

    let canvas = makeCanvas(base.width, base.height)
    ctx2d(canvas).drawImage(base as CanvasImageSource, 0, 0)

    for (const op of parseIpf(mods)) {
      canvas = await this.applyOp(canvas, op) ?? canvas
    }
    return canvas
  }

  private async applyOp(
    src: OffscreenCanvas | HTMLCanvasElement,
    op: { name: string; args: string[] },
  ): Promise<OffscreenCanvas | HTMLCanvasElement | null> {
    const { name, args } = op

    switch (name) {
      case 'NOP':
        return src

      // ~CROP(x,y,w,h) — take a sub-rectangle.
      case 'CROP': {
        const [x, y, w, h] = args.map(Number)
        if (![x, y, w, h].every(Number.isFinite) || !w || !h || w <= 0 || h <= 0) return src
        const out = makeCanvas(w, h)
        ctx2d(out).drawImage(src as CanvasImageSource, x ?? 0, y ?? 0, w, h, 0, 0, w, h)
        return out
      }

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

      // ~MASK(ref[,x,y]) — clip to the mask.
      //
      // The engine takes the per-pixel MINIMUM of the two alphas
      // (mask_surface in sdl/utils.cpp), which is not what canvas gives you:
      // 'destination-in' multiplies them. The two agree only where one side is
      // fully opaque, and diverge everywhere both are partly transparent —
      // antialiased edges, and translucent art like water overlays and fords.
      // So the alpha channel is combined by hand.
      case 'MASK': {
        const mask = args[0] ? await this.render(args[0]) : null
        if (!mask) return src
        const x = Number(args[1] ?? 0) || 0
        const y = Number(args[2] ?? 0) || 0

        // The engine blits the mask into a surface the size of the source, so
        // anything the mask does not cover ends up alpha 0 and is clipped away.
        const maskCanvas = makeCanvas(src.width, src.height)
        ctx2d(maskCanvas).drawImage(mask as CanvasImageSource, x, y)

        const out = makeCanvas(src.width, src.height)
        const g = ctx2d(out)
        g.drawImage(src as CanvasImageSource, 0, 0)

        const sd = g.getImageData(0, 0, src.width, src.height)
        const md = ctx2d(maskCanvas).getImageData(0, 0, src.width, src.height)
        for (let i = 3; i < sd.data.length; i += 4) {
          if ((md.data[i] ?? 0) < (sd.data[i] ?? 0)) sd.data[i] = md.data[i] ?? 0
        }
        g.putImageData(sd, 0, 0)
        return out
      }

      // ~BLIT(ref[,x,y]) — composite another image on top.
      case 'BLIT': {
        const top = args[0] ? await this.render(args[0]) : null
        if (!top) return src
        const x = Number(args[1] ?? 0) || 0
        const y = Number(args[2] ?? 0) || 0
        const g = ctx2d(src)
        g.drawImage(top as CanvasImageSource, x, y)
        return src
      }

      // ~O(alpha) — scale opacity.
      //
      // Done by hand rather than with globalAlpha so the arithmetic matches the
      // engine exactly. Upstream converts the argument with
      // float_to_color (truncating n*256, so 0.16 gives 40, not 41) and then
      // applies color_multiply, an integer (a*b)/255. Canvas's globalAlpha
      // rounds differently and left every translucent image off by one or two.
      case 'O': {
        const a = parseAlpha(args[0])
        if (a >= 1) return src

        const alphaMod = a <= 0 ? 0 : Math.min(255, Math.trunc(a * 256))
        const out = makeCanvas(src.width, src.height)
        const g = ctx2d(out)
        g.drawImage(src as CanvasImageSource, 0, 0)

        const d = g.getImageData(0, 0, src.width, src.height)
        for (let i = 3; i < d.data.length; i += 4) {
          d.data[i] = Math.trunc(((d.data[i] ?? 0) * alphaMod) / 255)
        }
        g.putImageData(d, 0, 0)
        return out
      }

      // ~FL([horiz|vert]) — flip; no argument means horizontal.
      case 'FL': {
        const spec = (args[0] ?? '').toLowerCase()
        const horiz = spec === '' || spec.includes('horiz')
        const vert = spec.includes('vert')
        const out = makeCanvas(src.width, src.height)
        const g = ctx2d(out)
        g.translate(horiz ? src.width : 0, vert ? src.height : 0)
        g.scale(horiz ? -1 : 1, vert ? -1 : 1)
        g.drawImage(src as CanvasImageSource, 0, 0)
        return out
      }

      // ~SCALE(w,h) / ~SCALE_SHARP(w,h)
      case 'SCALE':
      case 'SCALE_SHARP':
      case 'SCALE_INTO':
      case 'SCALE_INTO_SHARP': {
        const [w, h] = args.map(Number)
        if (!Number.isFinite(w) || !Number.isFinite(h) || !w || !h || w <= 0 || h <= 0) return src
        const out = makeCanvas(w, h)
        const g = ctx2d(out)
        g.imageSmoothingEnabled = !name.endsWith('SHARP')
        g.drawImage(src as CanvasImageSource, 0, 0, w, h)
        return out
      }

      // ~TC(side, palette) — recolour `palette` to that side's team colour.
      // ~RC(palette>range)  — recolour `palette` to a named colour range.
      case 'TC':
      case 'RC': {
        const map = name === 'TC'
          ? this.tcMapping(Number(args[0]), args[1] ?? DEFAULT_TC_PALETTE)
          : this.rcMapping(args[0] ?? '')
        if (!map || map.size === 0) return src
        const t0 = performance.now()
        const g = ctx2d(src)
        const img = g.getImageData(0, 0, src.width, src.height)
        applyColorMapping(img.data, map)
        g.putImageData(img, 0, 0)
        this.recolorMs += performance.now() - t0
        this.recolorCount++
        return src
      }

      // ~HEXED() — what image::HEXED does (picture.cpp get_hexed()).
      //
      // Crop the image into a 72x72 box — or centre it there, if smaller —
      // then clip it to the hex with terrain/alphamask.png. No scaling, and
      // deliberately no offset: the engine positions every terrain texture at
      // the hex and uses rule_image basex/basey only to order layers.
      case 'HEXED': {
        const mask = await this.render(HEX_MASK)
        const out = makeCanvas(TILE, TILE)
        const g = ctx2d(out)

        const sx = Math.max(0, Math.trunc((src.width - TILE) / 2))
        const sy = Math.max(0, Math.trunc((src.height - TILE) / 2))
        const sw = Math.min(src.width, TILE)
        const sh = Math.min(src.height, TILE)
        const dx = Math.max(0, Math.trunc((TILE - src.width) / 2))
        const dy = Math.max(0, Math.trunc((TILE - src.height) / 2))
        g.drawImage(src as CanvasImageSource, sx, sy, sw, sh, dx, dy, sw, sh)

        if (mask) {
          g.globalCompositeOperation = 'destination-in'
          g.drawImage(mask as CanvasImageSource, 0, 0)
        }
        return out
      }

      // ~TOD(r,g,b) — see `todRef` above: additive time-of-day tint, not a
      // real engine IPF op, appended the same way `~HEXED()` is.
      case 'TOD': {
        const [r, g, b] = args.map(Number)
        if (![r, g, b].every(Number.isFinite)) return src
        const g2 = ctx2d(src)
        const img = g2.getImageData(0, 0, src.width, src.height)
        applyTodTint(img.data, { r: r!, g: g!, b: b! })
        g2.putImageData(img, 0, 0)
        return src
      }

      // ~GS() — greyscale.
      case 'GS': {
        const out = makeCanvas(src.width, src.height)
        const g = ctx2d(out)
        g.filter = 'grayscale(100%)'
        g.drawImage(src as CanvasImageSource, 0, 0)
        return out
      }

      default:
        warnOnce(name)
        return src
    }
  }

  /**
   * Resolve a joined reference and return its texture.
   *
   * Exposed for scripts/dump-images.js, which diffs this pipeline against the
   * engine's own rasteriser (wl-image-oracle). Identical to resolveRef, but
   * public so the comparison harness does not depend on private internals.
   */
  resolveRefForTest(ref: string): Promise<PIXI.Texture | null> {
    return this.resolveRef(ref)
  }

  /** Drop everything (call when the board is destroyed). */
  clear(): void {
    for (const tex of this.textures.values()) tex.destroy(true)
    this.textures.clear()
    this.pending.clear()
    this.bitmaps.clear()
  }

  get size(): number {
    return this.textures.size
  }
}

export const ImageCache = new ImageCacheImpl()
