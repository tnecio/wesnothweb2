/**
 * Phase 27c S1: xBRZ upscaling (`~XBRZ(n)`), ported from upstream's `src/xBRZ/xbrz.cpp` (Zenju's xBRZ, GPL-3,
 * as Wesnoth ships it): `scale_surface_xbrz` calls `xbrz::scale(z, …, ColorFormat::ARGB)`, so this is the ARGB
 * path -- `ColorDistanceARGB` over the buffered YCbCr distance (differences halved to fit a byte, the table
 * held as `float`), `ColorGradientARGB`, `OobReaderTransparent` -- with the default `ScalerCfg`.
 *
 * Kept as upstream has it, quirks included: in the rotated passes of `blendPixel`, `b` and `c` are read
 * unrotated (only `d`..`i` have per-rotation getters).
 */
import { makeRaster, type Raster } from './surfaceOps'

const LUMINANCE_WEIGHT = 1
const EQUAL_COLOR_TOLERANCE = 30
const CENTER_DIRECTION_BIAS = 4
const DOMINANT_DIRECTION_THRESHOLD = 3.6
const STEEP_DIRECTION_THRESHOLD = 2.2
void LUMINANCE_WEIGHT

const BLEND_NONE = 0
const BLEND_NORMAL = 1
const BLEND_DOMINANT = 2

const alpha = (p: number) => p >>> 24
const red = (p: number) => (p >>> 16) & 0xff
const green = (p: number) => (p >>> 8) & 0xff
const blue = (p: number) => p & 0xff

const K_B = 0.0593
const K_R = 0.2627
const K_G = 1 - K_B - K_R
const SCALE_B = 0.5 / (1 - K_B)
const SCALE_R = 0.5 / (1 - K_R)

/** `distYCbCrBuffered`: the table entry for the differences halved (toward zero) and doubled again. */
function distYCbCrBuffered(p1: number, p2: number): number {
  const rd = Math.trunc((red(p1) - red(p2)) / 2) * 2
  const gd = Math.trunc((green(p1) - green(p2)) / 2) * 2
  const bd = Math.trunc((blue(p1) - blue(p2)) / 2) * 2
  const y = K_R * rd + K_G * gd + K_B * bd
  const cb = SCALE_B * (bd - y)
  const cr = SCALE_R * (rd - y)
  return Math.fround(Math.sqrt(y * y + cb * cb + cr * cr))
}

/** `ColorDistanceARGB::dist`. */
function dist(p1: number, p2: number): number {
  const a1 = alpha(p1) / 255.0
  const a2 = alpha(p2) / 255.0
  const d = distYCbCrBuffered(p1, p2)
  return a1 < a2 ? a1 * d + 255 * (a2 - a1) : a2 * d + 255 * (a1 - a2)
}

const eq = (p1: number, p2: number) => dist(p1, p2) < EQUAL_COLOR_TOLERANCE

/** `gradientARGB<M, N>`: the colour M/N of the way from `back` to `front`, weighted by alpha (no blending). */
function gradient(m: number, n: number, front: number, back: number): number {
  const wf = alpha(front) * m
  const wb = alpha(back) * (n - m)
  const sum = wf + wb
  if (sum === 0) return 0
  const c = (f: number, b: number) => Math.trunc((f * wf + b * wb) / sum) & 0xff
  return (((Math.trunc(sum / n) & 0xff) << 24) | (c(red(front), red(back)) << 16) | (c(green(front), green(back)) << 8) | c(blue(front), blue(back))) >>> 0
}

/** The 4x4 kernel around the current pixel F (`Kernel_4x4`). */
interface Kernel {
  a: number; b: number; c: number; d: number
  e: number; f: number; g: number; h: number
  i: number; j: number; k: number; l: number
  m: number; n: number; o: number; p: number
}

/** `preProcessCorners`: the blend types of the corners F, G, J, K, packed as [f, g, j, k]. */
function preProcessCorners(ker: Kernel): [number, number, number, number] {
  const result: [number, number, number, number] = [0, 0, 0, 0]
  if ((ker.f === ker.g && ker.j === ker.k) || (ker.f === ker.j && ker.g === ker.k)) return result
  const jg = dist(ker.i, ker.f) + dist(ker.f, ker.c) + dist(ker.n, ker.k) + dist(ker.k, ker.h) + CENTER_DIRECTION_BIAS * dist(ker.j, ker.g)
  const fk = dist(ker.e, ker.j) + dist(ker.j, ker.o) + dist(ker.b, ker.g) + dist(ker.g, ker.l) + CENTER_DIRECTION_BIAS * dist(ker.f, ker.k)
  if (jg < fk) {
    const dominant = DOMINANT_DIRECTION_THRESHOLD * jg < fk
    if (ker.f !== ker.g && ker.f !== ker.j) result[0] = dominant ? BLEND_DOMINANT : BLEND_NORMAL
    if (ker.k !== ker.j && ker.k !== ker.g) result[3] = dominant ? BLEND_DOMINANT : BLEND_NORMAL
  } else if (fk < jg) {
    const dominant = DOMINANT_DIRECTION_THRESHOLD * fk < jg
    if (ker.j !== ker.f && ker.j !== ker.k) result[2] = dominant ? BLEND_DOMINANT : BLEND_NORMAL
    if (ker.g !== ker.f && ker.g !== ker.k) result[1] = dominant ? BLEND_DOMINANT : BLEND_NORMAL
  }
  return result
}

/** The 3x3 names `d`..`i` read from the 4x4 kernel, per rotation (`get_x<rotDeg>`); `b` and `c` never rotate. */
const GETTERS: readonly (readonly (keyof Kernel)[])[] = [
  // d, e, f, g, h, i
  ['e', 'f', 'g', 'i', 'j', 'k'],
  ['j', 'f', 'b', 'k', 'g', 'c'],
  ['g', 'f', 'e', 'c', 'b', 'a'],
  ['b', 'f', 'j', 'a', 'e', 'i'],
]

const rotateBlendInfo = (b: number, rot: number): number =>
  rot === 0 ? b : ((b << (2 * rot)) | (b >> (8 - 2 * rot))) & 0xff
const topR = (b: number) => (b >> 2) & 0x3
const bottomR = (b: number) => (b >> 4) & 0x3
const bottomL = (b: number) => (b >> 6) & 0x3

/** The scaled block of one source pixel, addressed through a rotation (`OutputMatrix`). */
class Out {
  constructor(
    private readonly trg: Uint32Array,
    private readonly base: number,
    private readonly width: number,
    private readonly n: number,
    private readonly rot: number,
  ) {}

  private index(i: number, j: number): number {
    let io = i, jo = j
    for (let r = 0; r < this.rot; r++) {
      const prevI = io
      io = this.n - 1 - jo
      jo = prevI
    }
    return this.base + jo + io * this.width
  }

  grad(m: number, n: number, i: number, j: number, col: number): void {
    const k = this.index(i, j)
    this.trg[k] = gradient(m, n, col, this.trg[k]!)
  }

  set(i: number, j: number, col: number): void {
    this.trg[this.index(i, j)] = col
  }
}

/** The blend shapes of one scale factor (`Scaler2x` .. `Scaler6x`). */
interface Scaler {
  lineShallow(col: number, out: Out): void
  lineSteep(col: number, out: Out): void
  lineSteepAndShallow(col: number, out: Out): void
  lineDiagonal(col: number, out: Out): void
  corner(col: number, out: Out): void
}

const SCALERS: Record<number, Scaler> = {
  2: {
    lineShallow(c, o) { o.grad(1, 4, 1, 0, c); o.grad(3, 4, 1, 1, c) },
    lineSteep(c, o) { o.grad(1, 4, 0, 1, c); o.grad(3, 4, 1, 1, c) },
    lineSteepAndShallow(c, o) { o.grad(1, 4, 1, 0, c); o.grad(1, 4, 0, 1, c); o.grad(5, 6, 1, 1, c) },
    lineDiagonal(c, o) { o.grad(1, 2, 1, 1, c) },
    corner(c, o) { o.grad(21, 100, 1, 1, c) },
  },
  3: {
    lineShallow(c, o) { o.grad(1, 4, 2, 0, c); o.grad(1, 4, 1, 2, c); o.grad(3, 4, 2, 1, c); o.set(2, 2, c) },
    lineSteep(c, o) { o.grad(1, 4, 0, 2, c); o.grad(1, 4, 2, 1, c); o.grad(3, 4, 1, 2, c); o.set(2, 2, c) },
    lineSteepAndShallow(c, o) { o.grad(1, 4, 2, 0, c); o.grad(1, 4, 0, 2, c); o.grad(3, 4, 2, 1, c); o.grad(3, 4, 1, 2, c); o.set(2, 2, c) },
    lineDiagonal(c, o) { o.grad(1, 8, 1, 2, c); o.grad(1, 8, 2, 1, c); o.grad(7, 8, 2, 2, c) },
    corner(c, o) { o.grad(45, 100, 2, 2, c) },
  },
  4: {
    lineShallow(c, o) { o.grad(1, 4, 3, 0, c); o.grad(1, 4, 2, 2, c); o.grad(3, 4, 3, 1, c); o.grad(3, 4, 2, 3, c); o.set(3, 2, c); o.set(3, 3, c) },
    lineSteep(c, o) { o.grad(1, 4, 0, 3, c); o.grad(1, 4, 2, 2, c); o.grad(3, 4, 1, 3, c); o.grad(3, 4, 3, 2, c); o.set(2, 3, c); o.set(3, 3, c) },
    lineSteepAndShallow(c, o) {
      o.grad(3, 4, 3, 1, c); o.grad(3, 4, 1, 3, c); o.grad(1, 4, 3, 0, c); o.grad(1, 4, 0, 3, c)
      o.grad(1, 3, 2, 2, c)
      o.set(3, 3, c); o.set(3, 2, c); o.set(2, 3, c)
    },
    lineDiagonal(c, o) { o.grad(1, 2, 3, 2, c); o.grad(1, 2, 2, 3, c); o.set(3, 3, c) },
    corner(c, o) { o.grad(68, 100, 3, 3, c); o.grad(9, 100, 3, 2, c); o.grad(9, 100, 2, 3, c) },
  },
  5: {
    lineShallow(c, o) {
      o.grad(1, 4, 4, 0, c); o.grad(1, 4, 3, 2, c); o.grad(1, 4, 2, 4, c)
      o.grad(3, 4, 4, 1, c); o.grad(3, 4, 3, 3, c)
      o.set(4, 2, c); o.set(4, 3, c); o.set(4, 4, c); o.set(3, 4, c)
    },
    lineSteep(c, o) {
      o.grad(1, 4, 0, 4, c); o.grad(1, 4, 2, 3, c); o.grad(1, 4, 4, 2, c)
      o.grad(3, 4, 1, 4, c); o.grad(3, 4, 3, 3, c)
      o.set(2, 4, c); o.set(3, 4, c); o.set(4, 4, c); o.set(4, 3, c)
    },
    lineSteepAndShallow(c, o) {
      o.grad(1, 4, 0, 4, c); o.grad(1, 4, 2, 3, c); o.grad(3, 4, 1, 4, c)
      o.grad(1, 4, 4, 0, c); o.grad(1, 4, 3, 2, c); o.grad(3, 4, 4, 1, c)
      o.grad(2, 3, 3, 3, c)
      o.set(2, 4, c); o.set(3, 4, c); o.set(4, 4, c)
      o.set(4, 2, c); o.set(4, 3, c)
    },
    lineDiagonal(c, o) {
      o.grad(1, 8, 4, 2, c); o.grad(1, 8, 3, 3, c); o.grad(1, 8, 2, 4, c)
      o.grad(7, 8, 4, 3, c); o.grad(7, 8, 3, 4, c)
      o.set(4, 4, c)
    },
    corner(c, o) { o.grad(86, 100, 4, 4, c); o.grad(23, 100, 4, 3, c); o.grad(23, 100, 3, 4, c) },
  },
  6: {
    lineShallow(c, o) {
      o.grad(1, 4, 5, 0, c); o.grad(1, 4, 4, 2, c); o.grad(1, 4, 3, 4, c)
      o.grad(3, 4, 5, 1, c); o.grad(3, 4, 4, 3, c); o.grad(3, 4, 3, 5, c)
      o.set(5, 2, c); o.set(5, 3, c); o.set(5, 4, c); o.set(5, 5, c)
      o.set(4, 4, c); o.set(4, 5, c)
    },
    lineSteep(c, o) {
      o.grad(1, 4, 0, 5, c); o.grad(1, 4, 2, 4, c); o.grad(1, 4, 4, 3, c)
      o.grad(3, 4, 1, 5, c); o.grad(3, 4, 3, 4, c); o.grad(3, 4, 5, 3, c)
      o.set(2, 5, c); o.set(3, 5, c); o.set(4, 5, c); o.set(5, 5, c)
      o.set(4, 4, c); o.set(5, 4, c)
    },
    lineSteepAndShallow(c, o) {
      o.grad(1, 4, 0, 5, c); o.grad(1, 4, 2, 4, c); o.grad(3, 4, 1, 5, c); o.grad(3, 4, 3, 4, c)
      o.grad(1, 4, 5, 0, c); o.grad(1, 4, 4, 2, c); o.grad(3, 4, 5, 1, c); o.grad(3, 4, 4, 3, c)
      o.set(2, 5, c); o.set(3, 5, c); o.set(4, 5, c); o.set(5, 5, c)
      o.set(4, 4, c); o.set(5, 4, c)
      o.set(5, 2, c); o.set(5, 3, c)
    },
    lineDiagonal(c, o) {
      o.grad(1, 2, 5, 3, c); o.grad(1, 2, 4, 4, c); o.grad(1, 2, 3, 5, c)
      o.set(4, 5, c); o.set(5, 5, c); o.set(5, 4, c)
    },
    corner(c, o) {
      o.grad(97, 100, 5, 5, c); o.grad(42, 100, 4, 5, c); o.grad(42, 100, 5, 4, c)
      o.grad(6, 100, 5, 3, c); o.grad(6, 100, 3, 5, c)
    },
  },
}

/** `blendPixel<Scaler, ColorDistance, rotDeg>`. */
function blendPixel(scaler: Scaler, n: number, ker: Kernel, trg: Uint32Array, base: number, trgWidth: number, blendInfo: number, rot: number): void {
  const blend = rotateBlendInfo(blendInfo, rot)
  if (bottomR(blend) < BLEND_NORMAL) return
  const [kd, ke, kf, kg, kh, ki] = GETTERS[rot]!
  const b = ker.b, c = ker.c
  const d = ker[kd!], e = ker[ke!], f = ker[kf!], g = ker[kg!], h = ker[kh!], i = ker[ki!]

  const doLineBlend = (() => {
    if (bottomR(blend) >= BLEND_DOMINANT) return true
    if (topR(blend) !== BLEND_NONE && !eq(e, g)) return false
    if (bottomL(blend) !== BLEND_NONE && !eq(e, c)) return false
    if (!eq(e, i) && eq(g, h) && eq(h, i) && eq(i, f) && eq(f, c)) return false
    return true
  })()

  const px = dist(e, f) <= dist(e, h) ? f : h
  const out = new Out(trg, base, trgWidth, n, rot)
  if (doLineBlend) {
    const fg = dist(f, g)
    const hc = dist(h, c)
    const shallow = STEEP_DIRECTION_THRESHOLD * fg <= hc && e !== g && d !== g
    const steep = STEEP_DIRECTION_THRESHOLD * hc <= fg && e !== c && b !== c
    if (shallow) {
      if (steep) scaler.lineSteepAndShallow(px, out)
      else scaler.lineShallow(px, out)
    } else if (steep) scaler.lineSteep(px, out)
    else scaler.lineDiagonal(px, out)
  } else {
    scaler.corner(px, out)
  }
}

/** `scale_surface_xbrz`: the image `z` (2 to 6) times as large. */
export function xbrzScale(src: Raster, z: number): Raster {
  const scaler = SCALERS[z]
  if (!scaler) return src
  const sw = src.width, sh = src.height
  const dst = makeRaster(sw * z, sh * z)
  if (sw <= 0 || sh <= 0) return dst

  const s = new Uint32Array(sw * sh)
  for (let k = 0; k < s.length; k++) {
    const q = k * 4
    s[k] = ((src.data[q + 3]! << 24) | (src.data[q]! << 16) | (src.data[q + 1]! << 8) | src.data[q + 2]!) >>> 0
  }
  const trgWidth = sw * z
  const trg = new Uint32Array(trgWidth * sh * z)
  const preProcBuf = new Uint8Array(sw)

  /** `OobReaderTransparent`: rows y-1 .. y+2, transparent outside the image. */
  const reader = (y: number) => {
    const row = (yy: number) => (yy >= 0 && yy < sh ? yy * sw : -1)
    const m1 = row(y - 1), r0 = row(y), p1 = row(y + 1), p2 = row(y + 2)
    return (ker: Kernel, x: number) => {
      const x2 = x + 2
      if (x2 >= 0 && x2 < sw) {
        ker.d = m1 >= 0 ? s[m1 + x2]! : 0
        ker.h = r0 >= 0 ? s[r0 + x2]! : 0
        ker.l = p1 >= 0 ? s[p1 + x2]! : 0
        ker.p = p2 >= 0 ? s[p2 + x2]! : 0
      } else {
        ker.d = ker.h = ker.l = ker.p = 0
      }
    }
  }
  const startKernel = (read: (ker: Kernel, x: number) => void): Kernel => {
    const ker: Kernel = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0, j: 0, k: 0, l: 0, m: 0, n: 0, o: 0, p: 0 }
    read(ker, -4)
    ker.a = ker.d; ker.e = ker.h; ker.i = ker.l; ker.m = ker.p
    read(ker, -3)
    ker.b = ker.d; ker.f = ker.h; ker.j = ker.l; ker.n = ker.p
    read(ker, -2)
    ker.c = ker.d; ker.g = ker.h; ker.k = ker.l; ker.o = ker.p
    read(ker, -1)
    return ker
  }
  const shift = (ker: Kernel) => {
    ker.a = ker.b; ker.e = ker.f; ker.i = ker.j; ker.m = ker.n
    ker.b = ker.c; ker.f = ker.g; ker.j = ker.k; ker.n = ker.o
    ker.c = ker.d; ker.g = ker.h; ker.k = ker.l; ker.o = ker.p
  }

  // The first row's top corners.
  {
    const read = reader(-1)
    const ker = startKernel(read)
    preProcBuf[0] = preProcessCorners(ker)[3]
    for (let x = 0; x < sw; x++) {
      shift(ker)
      read(ker, x)
      const [, , bj, bk] = preProcessCorners(ker)
      preProcBuf[x] = preProcBuf[x]! | (bj << 2)
      if (x + 1 < sw) preProcBuf[x + 1] = bk
    }
  }

  for (let y = 0; y < sh; y++) {
    let out = z * y * trgWidth
    const read = reader(y)
    const ker = startKernel(read)
    let blendXy1 = 0
    {
      const [, bg, , bk] = preProcessCorners(ker)
      blendXy1 = bk
      preProcBuf[0] = preProcBuf[0]! | (bg << 6)
    }
    for (let x = 0; x < sw; x++, out += z) {
      shift(ker)
      read(ker, x)
      let blendXy = preProcBuf[x]!
      {
        const [bf, bg, bj, bk] = preProcessCorners(ker)
        blendXy |= bf << 4
        blendXy1 |= bj << 2
        preProcBuf[x] = blendXy1
        if (x + 1 < sw) {
          blendXy1 = bk
          preProcBuf[x + 1] = preProcBuf[x + 1]! | (bg << 6)
        }
      }
      for (let dy = 0; dy < z; dy++) trg.fill(ker.f, out + dy * trgWidth, out + dy * trgWidth + z)
      if (blendXy !== 0) {
        for (let rot = 0; rot < 4; rot++) blendPixel(scaler, z, ker, trg, out, trgWidth, blendXy, rot)
      }
    }
  }

  const o = dst.data
  for (let k = 0; k < trg.length; k++) {
    const p = trg[k]!
    const q = k * 4
    o[q] = red(p); o[q + 1] = green(p); o[q + 2] = blue(p); o[q + 3] = alpha(p)
  }
  return dst
}
