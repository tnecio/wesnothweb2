/**
 * Phase 27c S1: upstream's surface functions (`sdl/utils.cpp`), ported to plain RGBA pixel arrays so the
 * image path functions that use them (`image_modifications.cpp`) give the engine's own pixels.
 *
 * A {@link Raster} holds straight (not premultiplied) RGBA, as an SDL surface does; canvas 2D premultiplies,
 * which loses colour in translucent pixels, so the compositor keeps a chain of pixel functions in a raster and
 * only goes through a canvas for the ops that composite (BLIT, HEXED). Every function here follows its C++
 * original's integer and `float` arithmetic (`Math.fround` where the original computes in `float`), including
 * its quirks, so the result can be compared with the image oracle pixel for pixel.
 *
 * No DOM, no canvas: runs in the compositor workers and in unit tests alike.
 */

/** Straight-alpha RGBA pixels, row-major: what an SDL surface holds (as ARGB words). */
export interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** A transparent `w`x`h` raster (`surface(w, h)`). */
export function makeRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(Math.max(0, width) * Math.max(0, height) * 4) }
}

/** A copy of `r` (the ops change their input). */
export function cloneRaster(r: Raster): Raster {
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) }
}

const f = Math.fround

/** `adjust_surface_color`: add to each channel and clamp; `~CS`, `~R`, `~G`, `~B`. */
export function adjustColor(r: Raster, red: number, green: number, blue: number): void {
  if (red === 0 && green === 0 && blue === 0) return
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i]! + red
    d[i + 1] = d[i + 1]! + green
    d[i + 2] = d[i + 2]! + blue
  }
}

/** `greyscale_image`: `(77r + 150g + 29b) / 256`; `~GS`. */
export function greyscale(r: Raster): void {
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    const avg = ((77 * d[i]! + 150 * d[i + 1]! + 29 * d[i + 2]!) / 256) | 0
    d[i] = d[i + 1] = d[i + 2] = avg
  }
}

/** `monochrome_image`: white where the grey value is above `threshold`, else black; `~BW`. */
export function monochrome(r: Raster, threshold: number): void {
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    const grey = Math.trunc(0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) & 0xff
    d[i] = d[i + 1] = d[i + 2] = grey > threshold ? 255 : 0
  }
}

/** `sepia_image`; `~SEPIA`. */
export function sepia(r: Raster): void {
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    const red = d[i]!, green = d[i + 1]!, blue = d[i + 2]!
    d[i] = Math.min(255, Math.trunc(red * 0.393 + green * 0.769 + blue * 0.189))
    d[i + 1] = Math.min(255, Math.trunc(red * 0.349 + green * 0.686 + blue * 0.168))
    d[i + 2] = Math.min(255, Math.trunc(red * 0.272 + green * 0.534 + blue * 0.131))
  }
}

/** `negative_image`: invert each channel that is above its threshold (-1 inverts all); `~NEG`. */
export function negative(r: Raster, tr: number, tg: number, tb: number): void {
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i]! > tr) d[i] = 255 - d[i]!
    if (d[i + 1]! > tg) d[i + 1] = 255 - d[i + 1]!
    if (d[i + 2]! > tb) d[i + 2] = 255 - d[i + 2]!
  }
}

/** `alpha_to_greyscale`: the alpha channel as an opaque grey image; `~PLOT_ALPHA`. */
export function alphaToGreyscale(r: Raster): void {
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = d[i + 3]!
    d[i + 3] = 255
  }
}

/** `wipe_alpha`: make every pixel opaque; `~WIPE_ALPHA`. */
export function wipeAlpha(r: Raster): void {
  const d = r.data
  for (let i = 3; i < d.length; i += 4) d[i] = 255
}

/** Channel index (0 red, 1 green, 2 blue, 3 alpha) of a `~SWAP` argument, or -1. */
export function channelIndex(name: string): number {
  return ['red', 'green', 'blue', 'alpha'].indexOf(name)
}

/** `swap_channels_image`: each output channel takes the named input channel; `~SWAP`. */
export function swapChannels(r: Raster, red: number, green: number, blue: number, alpha: number): void {
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    const c = [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!]
    d[i] = c[red]!
    d[i + 1] = c[green]!
    d[i + 2] = c[blue]!
    d[i + 3] = c[alpha]!
  }
}

/**
 * `blend_surface`: mix every pixel with a colour by `amount` (a C++ `float` widened to `double`), in 8-bit
 * fixed point with `uint16_t` intermediates; `~BLEND`.
 */
export function blend(r: Raster, amount: number, red: number, green: number, blue: number): void {
  let ratio = Math.trunc(amount * 256) & 0xffff
  const rr = (ratio * (red & 0xff)) & 0xffff
  const gg = (ratio * (green & 0xff)) & 0xffff
  const bb = (ratio * (blue & 0xff)) & 0xffff
  ratio = (256 - ratio) & 0xffff
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = ((ratio * d[i]! + rr) >> 8) & 0xff
    d[i + 1] = ((ratio * d[i + 1]! + gg) >> 8) & 0xff
    d[i + 2] = ((ratio * d[i + 2]! + bb) >> 8) & 0xff
  }
}

/** `light_surface`: shift each channel by `(light - 128) * 2`; the lightmap must be as wide as the image. */
export function light(r: Raster, lightmap: Raster): void {
  if (r.width !== lightmap.width) return
  const d = r.data
  const l = lightmap.data
  const n = Math.min(d.length, l.length)
  for (let i = 0; i < n; i += 4) {
    d[i] = d[i]! + (l[i]! - 128) * 2
    d[i + 1] = d[i + 1]! + (l[i + 1]! - 128) * 2
    d[i + 2] = d[i + 2]! + (l[i + 2]! - 128) * 2
  }
}

/**
 * `blur_alpha_surface`: a box blur of `depth` pixels each way, horizontal then vertical, with colour weighted
 * by alpha; `~BL`.
 */
export function blurAlpha(r: Raster, depth: number): void {
  depth = Math.min(depth, 256)
  const { width: w, height: h, data: d } = r
  let head = 0
  let sa = 0, sr = 0, sg = 0, sb = 0
  // The queue holds copies of the pixels (as upstream's `Pixel`), since the line is overwritten as it goes.
  const pixels: number[] = []
  const pushPixel = (i: number) => {
    const a = d[i + 3]!
    pixels.push(d[i]!, d[i + 1]!, d[i + 2]!, a)
    sr += a * d[i]!
    sg += a * d[i + 1]!
    sb += a * d[i + 2]!
    sa += a
  }
  const popPixel = () => {
    const a = pixels[head + 3]!
    sr -= a * pixels[head]!
    sg -= a * pixels[head + 1]!
    sb -= a * pixels[head + 2]!
    sa -= a
    head += 4
  }
  const write = (i: number, num: number) => {
    if (!sa) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0
      return
    }
    d[i + 3] = Math.min(Math.floor(sa / num), 255)
    d[i] = Math.min(Math.floor(sr / sa), 255)
    d[i + 1] = Math.min(Math.floor(sg / sa), 255)
    d[i + 2] = Math.min(Math.floor(sb / sa), 255)
  }
  const line = (count: number, index: (k: number) => number) => {
    pixels.length = 0
    head = 0
    sa = sr = sg = sb = 0
    for (let k = 0; k <= depth && k < count; k++) pushPixel(index(k))
    for (let k = 0; k < count; k++) {
      write(index(k), (pixels.length - head) / 4)
      if (k >= depth) popPixel()
      if (k + depth + 1 < count) pushPixel(index(k + depth + 1))
    }
  }
  for (let y = 0; y < h; y++) line(w, (x) => (y * w + x) * 4)
  for (let x = 0; x < w; x++) line(h, (y) => (y * w + x) * 4)
}

/** `fixed_point_divide`: `n1 / n2` in 24.8 fixed point. */
function fixedPointDivide(n1: number, n2: number): number {
  return Math.trunc((n1 << 8) / n2)
}

/**
 * `scale_surface`: bilinear scaling in 8-bit fixed point, colour weighted by alpha. Used by `~L` (its
 * lightmap) and `~ROTATE` (its zoom), not by `~SCALE`.
 */
export function scaleSurface(src: Raster, w: number, h: number): Raster {
  if (w === src.width && h === src.height) return src
  const dst = makeRaster(w, h)
  if (w === 0 || h === 0) return dst
  const s = src.data, o = dst.data
  const sw = src.width, sh = src.height
  const xratio = fixedPointDivide(sw, w)
  const yratio = fixedPointDivide(sh, h)
  const pix = [0, 0, 0, 0]
  const bilin = [0, 0, 0, 0]
  let ysrc = 0
  for (let ydst = 0; ydst !== h; ydst++, ysrc += yratio) {
    let xsrc = 0
    for (let xdst = 0; xdst !== w; xdst++, xsrc += xratio) {
      const xi = xsrc >> 8, yi = ysrc >> 8
      const base = yi * sw + xi
      const dx = xi + 1 < sw ? 1 : 0
      const dy = yi + 1 < sh ? sw : 0
      const e = xsrc & 0xff, so = ysrc & 0xff
      const n = 0xff - so, we = 0xff - e
      pix[0] = base; pix[1] = base + dx; pix[2] = base + dy; pix[3] = base + dx + dy
      bilin[0] = n * we; bilin[1] = n * e; bilin[2] = so * we; bilin[3] = so * e
      let rr = 0, gg = 0, bb = 0, aa = 0
      for (let k = 0; k < 4; k++) {
        const p = pix[k]! * 4
        const temp = s[p + 3]! * bilin[k]!
        rr += s[p]! * temp
        gg += s[p + 1]! * temp
        bb += s[p + 2]! * temp
        aa += temp
      }
      const a = (aa >>> 16) & 0xff
      if (a !== 0) {
        rr = Math.floor(rr / a)
        gg = Math.floor(gg / a)
        bb = Math.floor(bb / a)
      }
      const q = (ydst * w + xdst) * 4
      o[q] = Math.floor(rr / 65536) & 0xff
      o[q + 1] = Math.floor(gg / 65536) & 0xff
      o[q + 2] = Math.floor(bb / 65536) & 0xff
      o[q + 3] = a
    }
  }
  return dst
}

/**
 * `scale_surface_legacy`: bilinear scaling in 8-bit fixed point, where a fully transparent neighbour lends
 * the average colour of the others; `~SCALE` and `~SCALE_INTO`.
 */
export function scaleSurfaceLegacy(src: Raster, w: number, h: number): Raster {
  if (w === src.width && h === src.height) return src
  const dst = makeRaster(w, h)
  if (w === 0 || h === 0) return dst
  const s = src.data, o = dst.data
  const sw = src.width, sh = src.height
  const xratio = fixedPointDivide(sw, w)
  const yratio = fixedPointDivide(sh, h)
  const pix = [0, 0, 0, 0]
  const bilin = [0, 0, 0, 0]
  let ysrc = 0
  for (let ydst = 0; ydst !== h; ydst++, ysrc += yratio) {
    let xsrc = 0
    for (let xdst = 0; xdst !== w; xdst++, xsrc += xratio) {
      const xi = xsrc >> 8, yi = ysrc >> 8
      const base = yi * sw + xi
      const dx = xi + 1 < sw ? 1 : 0
      const dy = yi + 1 < sh ? sw : 0
      const east = xsrc & 0xff, south = ysrc & 0xff
      const north = 0xff - south, west = 0xff - east
      pix[0] = base * 4; pix[1] = (base + dx) * 4; pix[2] = (base + dy) * 4; pix[3] = (base + dx + dy) * 4
      bilin[0] = north * west; bilin[1] = north * east; bilin[2] = south * west; bilin[3] = south * east
      let count = 0, ar = 0, ag = 0, ab = 0
      for (let k = 0; k < 4; k++) {
        const p = pix[k]!
        if (s[p + 3] !== 0) {
          ar += s[p]!
          ag += s[p + 1]!
          ab += s[p + 2]!
          count++
        }
      }
      if (count > 0) {
        ar = Math.trunc(ar / count)
        ag = Math.trunc(ag / count)
        ab = Math.trunc(ab / count)
      }
      let rr = 0, gg = 0, bb = 0, aa = 0
      for (let k = 0; k < 4; k++) {
        const p = pix[k]!
        const a = s[p + 3]!
        const opaque = a !== 0
        rr += (opaque ? s[p]! : ar) * bilin[k]!
        gg += (opaque ? s[p + 1]! : ag) * bilin[k]!
        bb += (opaque ? s[p + 2]! : ab) * bilin[k]!
        aa += a * bilin[k]!
      }
      const q = (ydst * w + xdst) * 4
      o[q] = (rr >>> 16) & 0xff
      o[q + 1] = (gg >>> 16) & 0xff
      o[q + 2] = (bb >>> 16) & 0xff
      o[q + 3] = (aa >>> 16) & 0xff
    }
  }
  return dst
}

/** `scale_surface_sharp`: nearest neighbour, with the ratio in `float`; `~SCALE_SHARP`, `~SCALE_INTO_SHARP`. */
export function scaleSurfaceSharp(src: Raster, w: number, h: number): Raster {
  if (w === src.width && h === src.height) return src
  const dst = makeRaster(w, h)
  if (w === 0 || h === 0) return dst
  const xratio = f(src.width / w)
  const yratio = f(src.height / h)
  const s = src.data, o = dst.data
  for (let y = 0; y < h; y++) {
    const ys = Math.floor(f(y * yratio))
    for (let x = 0; x < w; x++) {
      const xs = Math.floor(f(x * xratio))
      const p = (ys * src.width + xs) * 4
      const q = (y * w + x) * 4
      o[q] = s[p]!; o[q + 1] = s[p + 1]!; o[q + 2] = s[p + 2]!; o[q + 3] = s[p + 3]!
    }
  }
  return dst
}

function copyPixel(s: Uint8ClampedArray, p: number, o: Uint8ClampedArray, q: number): void {
  o[q] = s[p]!; o[q + 1] = s[p + 1]!; o[q + 2] = s[p + 2]!; o[q + 3] = s[p + 3]!
}

/** `rotate_180_surface` (also `~FL(horiz,vert)`). */
export function rotate180(src: Raster): Raster {
  const dst = makeRaster(src.width, src.height)
  const n = src.width * src.height
  for (let i = 0; i < n; i++) copyPixel(src.data, i * 4, dst.data, (n - 1 - i) * 4)
  return dst
}

/** `rotate_90_surface`. */
export function rotate90(src: Raster, clockwise: boolean): Raster {
  const dst = makeRaster(src.height, src.width)
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const di = clockwise ? x * dst.width + (dst.width - 1 - y) : (dst.height - 1 - x) * dst.width + y
      copyPixel(src.data, (y * src.width + x) * 4, dst.data, di * 4)
    }
  }
  return dst
}

/**
 * `rotate_any_surface`: upstream's simplified RotSprite -- zoom the image `zoom` times with `scale_surface`,
 * then sample it every `offset` pixels along the rotated grid. All in `float`, as upstream.
 */
export function rotateAny(surf: Raster, angle: number, zoom: number, offset: number): Raster {
  const radians = f(f(angle * f(Math.PI)) / 180)
  const cosine = f(Math.cos(radians))
  const sine = f(Math.sin(radians))
  const srcW = surf.width * zoom
  const srcH = surf.height * zoom
  const p1x = f(srcH * -sine)
  const p1y = f(srcH * cosine)
  const p2x = f(f(srcW * cosine) - f(srcH * sine))
  const p2y = f(f(srcH * cosine) + f(srcW * sine))
  const p3x = f(srcW * cosine)
  const p3y = f(srcW * sine)
  const minX = Math.min(0, p1x, p2x, p3x)
  const minY = Math.min(0, p1y, p2y, p3y)
  const maxX = angle > 90 && angle < 180 ? 0 : Math.max(p1x, p2x, p3x)
  const maxY = angle > 180 && angle < 270 ? 0 : Math.max(p1y, p2y, p3y)
  const dstW = Math.trunc(Math.trunc(Math.ceil(f(Math.abs(maxX) - minX))) / zoom)
  const dstH = Math.trunc(Math.trunc(Math.ceil(f(Math.abs(maxY) - minY))) / zoom)
  const dst = makeRaster(dstW, dstH)
  const src = scaleSurface(surf, srcW, srcH)
  const scale = f(1 / zoom)
  const limX = dstW * zoom
  const limY = dstH * zoom
  for (let x = 0; x < limX; x += offset) {
    const ax = f(x + minX)
    for (let y = 0; y < limY; y += offset) {
      const ay = f(y + minY)
      const sx = f(f(ax * cosine) + f(ay * sine))
      const sy = f(f(ay * cosine) - f(ax * sine))
      if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
        const di = Math.trunc(f(y * scale)) * dstW + Math.trunc(f(x * scale))
        copyPixel(src.data, (Math.trunc(sy) * srcW + Math.trunc(sx)) * 4, dst.data, di * 4)
      }
    }
  }
  return dst
}

/** `rotate_modification`: `~ROTATE(degrees, zoom, offset)`, with 0/90/180/270/360 done exactly. */
export function rotate(src: Raster, degrees: number, zoom: number, offset: number): Raster {
  const normalized = degrees >= 0 ? degrees - 360 * Math.trunc(degrees / 360) : degrees + 360 * (1 + Math.trunc(-degrees / 360))
  switch (normalized) {
    case 0:
    case 360:
      return src
    case 90:
      return rotate90(src, true)
    case 180:
      return rotate180(src)
    case 270:
      return rotate90(src, false)
  }
  // Upstream loops forever on a zero step; that is never wanted.
  if (zoom <= 0 || offset <= 0) return src
  return rotateAny(src, normalized, zoom, offset)
}

/** `get_non_transparent_portion` + `get_surface_portion`: `~CROP_TRANSPARENCY`. */
export function cropTransparency(src: Raster): Raster {
  const { width: w, height: h, data: d } = src
  const rowOpaque = (y: number) => {
    for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] !== 0) return true
    return false
  }
  let top = 0, rows = 0
  for (let y = 0; y < h; y++) if (rowOpaque(y)) { top = y; break }
  for (let y = h - 1; y >= top; y--) if (rowOpaque(y)) { rows = y - top + 1; break }
  const colOpaque = (x: number) => {
    for (let y = top; y < top + rows; y++) if (d[(y * w + x) * 4 + 3] !== 0) return true
    return false
  }
  let left = 0, cols = 0
  for (let x = 0; x < w; x++) if (colOpaque(x)) { left = x; break }
  for (let x = w - 1; x >= left; x--) if (colOpaque(x)) { cols = x - left + 1; break }
  if ((cols === w && rows === h) || cols === 0 || rows === 0) return src
  return cut(src, left, top, cols, rows)
}

/** `cut_surface`: the `w`x`h` rectangle at (x, y), transparent where it leaves the image; `~CROP`. */
export function cut(src: Raster, x: number, y: number, w: number, h: number): Raster {
  const dst = makeRaster(w, h)
  for (let dy = 0; dy < h; dy++) {
    const sy = y + dy
    if (sy < 0 || sy >= src.height) continue
    for (let dx = 0; dx < w; dx++) {
      const sx = x + dx
      if (sx < 0 || sx >= src.width) continue
      copyPixel(src.data, (sy * src.width + sx) * 4, dst.data, (dy * w + dx) * 4)
    }
  }
  return dst
}

/** `pad_modification`: a transparent border (a negative one crops), the image copied in unblended; `~PAD`. */
export function pad(src: Raster, top: number, right: number, bottom: number, left: number): Raster {
  const w = src.width + left + right
  const h = src.height + top + bottom
  if (w <= 0 || h <= 0) return makeRaster(0, 0)
  return cut(src, -left, -top, w, h)
}

/**
 * SDL's alpha blit of a straight-alpha ARGB8888 surface onto another (`sdl_blit`): `src` drawn over `dst` at
 * (x, y), in place. This is the `BlitRGBtoRGBPixelAlphaMMX` arithmetic SDL 2 picks on x86-64 -- each channel
 * `(s * a >> 8) + (d * (255 - a) >> 8)`, alpha as a channel whose source value is 255 -- which matches the
 * image oracle exactly (SDL 2.26); SDL's portable C blitter rounds differently by one.
 */
export function blitBlend(dst: Raster, src: Raster, x: number, y: number): void {
  const s = src.data, d = dst.data
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy
    if (dy < 0 || dy >= dst.height) continue
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx
      if (dx < 0 || dx >= dst.width) continue
      const p = (sy * src.width + sx) * 4
      const q = (dy * dst.width + dx) * 4
      const a = s[p + 3]!
      if (a === 0) continue
      if (a === 255) {
        copyPixel(s, p, d, q)
        continue
      }
      for (let c = 0; c < 3; c++) d[q + c] = ((s[p + c]! * a) >> 8) + ((d[q + c]! * (255 - a)) >> 8)
      d[q + 3] = ((a * 255) >> 8) + ((d[q + 3]! * (255 - a)) >> 8)
    }
  }
}

/** `background_modification`: the image over a solid colour; `~BG`. */
export function background(src: Raster, red: number, green: number, blue: number, alpha: number): Raster {
  const dst = cloneRaster(src)
  const d = dst.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = red & 0xff; d[i + 1] = green & 0xff; d[i + 2] = blue & 0xff; d[i + 3] = alpha & 0xff
  }
  blitBlend(dst, src, 0, 0)
  return dst
}

/**
 * `mask_modification`: each pixel's alpha becomes the smaller of its own and the mask's (`mask_surface`). Unless
 * the mask is the image's size and at 0,0, it is first blitted (blended, so a translucent alpha loses a step) at
 * (x, y) onto a transparent surface of the image's size; `~MASK`.
 */
export function mask(src: Raster, maskImage: Raster, x: number, y: number): void {
  let m = maskImage
  if (!(m.width === src.width && m.height === src.height && x === 0 && y === 0)) {
    m = makeRaster(src.width, src.height)
    blitBlend(m, maskImage, x, y)
  }
  if (src.width !== m.width) return
  const d = src.data, md = m.data
  const n = Math.min(d.length, md.length)
  for (let i = 3; i < n; i += 4) if (md[i]! < d[i]!) d[i] = md[i]!
}

/** `float_to_color`: 0..1 to 0..255, truncating `n * 256`. */
export function floatToColor(n: number): number {
  if (n <= 0) return 0
  if (n >= 1) return 255
  return Math.trunc(f(n) * 256) & 0xff
}

/** `o_modification`: alpha times `opacity` (`color_multiply`, `a * b / 255`); `~O`. */
export function opacity(r: Raster, opacityValue: number): void {
  const mod = floatToColor(opacityValue)
  const d = r.data
  for (let i = 3; i < d.length; i += 4) {
    if (d[i]) d[i] = Math.trunc((d[i]! * mod) / 255)
  }
}

/** `flip_surface` / `flop_surface` / `rotate_180_surface`: `~FL`. */
export function flip(src: Raster, horiz: boolean, vert: boolean): Raster {
  if (horiz && vert) return rotate180(src)
  if (!horiz && !vert) return src
  const { width: w, height: h } = src
  const dst = makeRaster(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = horiz ? w - 1 - x : x
      const sy = vert ? h - 1 - y : y
      copyPixel(src.data, (sy * w + sx) * 4, dst.data, (y * w + x) * 4)
    }
  }
  return dst
}

/**
 * A per-pixel colour function for `~ADJUST_ALPHA`/`~CHAN`: given the pixel's index and RGBA, returns the four
 * new channel values (each already through upstream's `std::min<unsigned>(…, 255)`).
 */
export type PixelFunction = (x: number, y: number, r: number, g: number, b: number, a: number) => [number, number, number, number]

/** Apply a {@link PixelFunction} to every pixel. */
export function mapPixels(r: Raster, fn: PixelFunction): void {
  const { width: w, data: d } = r
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    const out = fn(k % w, Math.trunc(k / w), d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!)
    d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3]
  }
}

/** Apply a recolour map (packed RGB to packed RGB) to every pixel, keeping alpha (`recolor_image`). */
export function recolor(r: Raster, map: ReadonlyMap<number, number>): void {
  if (map.size === 0) return
  const d = r.data
  for (let i = 0; i < d.length; i += 4) {
    const hit = map.get((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!)
    if (hit === undefined) continue
    d[i] = (hit >> 16) & 0xff
    d[i + 1] = (hit >> 8) & 0xff
    d[i + 2] = hit & 0xff
  }
}
