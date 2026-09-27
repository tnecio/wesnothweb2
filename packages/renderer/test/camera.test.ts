import { describe, expect, it } from 'vitest'
import {
  ScrollAnimation,
  ZOOM_LEVELS,
  centerOn,
  clampView,
  mapArea,
  scaleForZoom,
  scrollTargetForHexes,
  scrollWarps,
  stepZoomIndex,
  worldBounds,
  zoomAbout,
  zoomIndexFor,
  type View,
} from '../src/camera'
import { hexToPixel } from '../src/hexGeometry'

const MAP = { w: 43, h: 27 } // Dead Water 1
const SMALL = { w: 6, h: 5 }
const VIEWPORT = { width: 1000, height: 700 }

describe('zoom levels', () => {
  it('are upstream\'s nine hex sizes with 72 as 1:1', () => {
    expect(ZOOM_LEVELS).toEqual([16, 24, 36, 52, 72, 100, 144, 216, 288])
    expect(scaleForZoom(72)).toBe(1)
    expect(scaleForZoom(144)).toBe(2)
  })

  it('snap to the nearest level, clamped at both ends (get_zoom_levels_index)', () => {
    expect(zoomIndexFor(72)).toBe(4)
    expect(zoomIndexFor(80)).toBe(4) // closer to 72 than to 100
    expect(zoomIndexFor(90)).toBe(5)
    expect(zoomIndexFor(86)).toBe(5) // exact midpoint goes up, as upstream's `lower < upper`
    expect(zoomIndexFor(1)).toBe(0)
    expect(zoomIndexFor(10_000)).toBe(8)
  })

  it('step one level at a time and stop at the ends', () => {
    expect(stepZoomIndex(4, true)).toBe(5)
    expect(stepZoomIndex(4, false)).toBe(3)
    expect(stepZoomIndex(8, true)).toBe(8)
    expect(stepZoomIndex(0, false)).toBe(0)
  })
})

describe('clampView (bounds_check_position)', () => {
  it('the world is the map plus half a hex of border, as max_map_area', () => {
    const b = worldBounds(MAP)
    // (w + 1 + 1/3) * 54 by (h + 1 + 1/2) * 72, upstream's xend/yend at 1:1
    expect(b.w).toBeCloseTo((43 + 1 + 1 / 3) * 54)
    expect(b.h).toBeCloseTo((27 + 1 + 0.5) * 72)
    expect(b.x).toBe(-27)
    expect(b.y).toBe(-36)
  })

  it('stops a large map from being dragged past its border, at every zoom', () => {
    for (const zoom of ZOOM_LEVELS.filter((z) => z >= 52)) {
      const scale = scaleForZoom(zoom)
      const b = worldBounds(MAP)
      const farLeft = clampView({ x: 10_000, y: 10_000, scale }, MAP, VIEWPORT)
      expect(farLeft.x).toBeCloseTo(-b.x * scale)
      expect(farLeft.y).toBeCloseTo(-b.y * scale)
      const farRight = clampView({ x: -1e6, y: -1e6, scale }, MAP, VIEWPORT)
      expect(farRight.x + (b.x + b.w) * scale).toBeCloseTo(VIEWPORT.width)
      expect(farRight.y + (b.y + b.h) * scale).toBeCloseTo(VIEWPORT.height)
    }
  })

  it('leaves an in-bounds view alone', () => {
    const v: View = { x: -500, y: -300, scale: 1 }
    expect(clampView(v, MAP, VIEWPORT)).toEqual(v)
  })

  it('centres a map smaller than the viewport, whatever the requested position (map_area)', () => {
    const b = worldBounds(SMALL)
    const v = clampView({ x: 123, y: -456, scale: 1 }, SMALL, VIEWPORT)
    expect(v.x + b.x + b.w / 2).toBeCloseTo(VIEWPORT.width / 2)
    expect(v.y + b.y + b.h / 2).toBeCloseTo(VIEWPORT.height / 2)
    const area = mapArea(v, SMALL, VIEWPORT)
    expect(area.w).toBeCloseTo(b.w)
    expect(area.x).toBeCloseTo((VIEWPORT.width - b.w) / 2)
  })

  it('centres per axis: a wide, short map scrolls sideways but sits mid-screen vertically', () => {
    const wide = { w: 60, h: 4 }
    const b = worldBounds(wide)
    const v = clampView({ x: -800, y: 0, scale: 1 }, wide, VIEWPORT)
    expect(v.x).toBe(-800)
    expect(v.y + b.y + b.h / 2).toBeCloseTo(VIEWPORT.height / 2)
  })
})

describe('zoomAbout', () => {
  it('keeps the anchor point fixed on screen', () => {
    const v: View = { x: -600, y: -400, scale: 1 }
    const anchor = { x: 420, y: 310 }
    const worldUnderAnchor = { x: (anchor.x - v.x) / v.scale, y: (anchor.y - v.y) / v.scale }
    const z = zoomAbout(v, scaleForZoom(100), anchor, MAP, VIEWPORT)
    expect(z.x + worldUnderAnchor.x * z.scale).toBeCloseTo(anchor.x)
    expect(z.y + worldUnderAnchor.y * z.scale).toBeCloseTo(anchor.y)
  })

  it('zooming out far enough centres the whole map', () => {
    const z = zoomAbout({ x: -600, y: -400, scale: 1 }, scaleForZoom(16), { x: 0, y: 0 }, MAP, VIEWPORT)
    const b = worldBounds(MAP)
    expect(z.x + (b.x + b.w / 2) * z.scale).toBeCloseTo(VIEWPORT.width / 2)
  })
})

describe('scrollTargetForHexes (scroll_to_tiles)', () => {
  const start: View = { x: -27 * 1 + 27, y: 36, scale: 1 } // top-left corner of the map in view
  const view = clampView(start, MAP, VIEWPORT)
  const screenCentre = (v: View, hx: number, hy: number) => {
    const c = hexToPixel({ x: hx + 1, y: hy + 1 })
    return { x: v.x + c.x * v.scale, y: v.y + c.y * v.scale }
  }

  it('SCROLL centres the hex', () => {
    const t = scrollTargetForHexes(view, [{ x: 20, y: 14 }], 'scroll', MAP, VIEWPORT)!
    const p = screenCentre(t, 20, 14)
    expect(p.x).toBeCloseTo(VIEWPORT.width / 2)
    expect(p.y).toBeCloseTo(VIEWPORT.height / 2)
  })

  it('ONSCREEN does nothing for a hex already on screen', () => {
    expect(scrollTargetForHexes(view, [{ x: 3, y: 3 }], 'onscreen', MAP, VIEWPORT)).toBeNull()
  })

  it('ONSCREEN brings an off-screen hex into the middle half, not all the way to the centre', () => {
    const t = scrollTargetForHexes(view, [{ x: 30, y: 4 }], 'onscreen', MAP, VIEWPORT)!
    const p = screenCentre(t, 30, 4)
    expect(p.x).toBeGreaterThan(VIEWPORT.width * 0.25)
    expect(p.x).toBeLessThan(VIEWPORT.width * 0.75)
    // it scrolled the minimum: the hex sits at the edge of the middle half nearest where it came from
    expect(p.x).toBeGreaterThan(VIEWPORT.width / 2)
  })

  it('never scrolls past the map edge', () => {
    const t = scrollTargetForHexes(view, [{ x: 42, y: 26 }], 'scroll', MAP, VIEWPORT)!
    expect(t).toEqual(clampView(t, MAP, VIEWPORT))
  })

  it('frames two hexes together (a move\'s path) when they fit', () => {
    const t = scrollTargetForHexes(view, [{ x: 25, y: 10 }, { x: 28, y: 12 }], 'onscreen', MAP, VIEWPORT)!
    for (const [hx, hy] of [[25, 10], [28, 12]] as const) {
      const p = screenCentre(t, hx, hy)
      expect(p.x).toBeGreaterThan(0)
      expect(p.x).toBeLessThan(VIEWPORT.width)
    }
  })

  it('returns null with no on-map hexes, or when only-if-possible cannot fit them', () => {
    expect(scrollTargetForHexes(view, [], 'scroll', MAP, VIEWPORT)).toBeNull()
    expect(scrollTargetForHexes(view, [{ x: -1, y: 99 }], 'scroll', MAP, VIEWPORT)).toBeNull()
    expect(scrollTargetForHexes(view, [{ x: 0, y: 0 }, { x: 42, y: 26 }], 'scroll', MAP, VIEWPORT, { onlyIfPossible: true })).toBeNull()
  })

  it('centerOn matches SCROLL for a single hex', () => {
    const c = hexToPixel({ x: 21, y: 15 })
    expect(centerOn(view, c, MAP, VIEWPORT)).toEqual(scrollTargetForHexes(view, [{ x: 20, y: 14 }], 'scroll', MAP, VIEWPORT))
  })
})

describe('ScrollAnimation (scroll_to_xy)', () => {
  function run(dx: number, dy: number, speed = 50, dt = 1 / 1000) {
    const anim = new ScrollAnimation(dx, dy, speed)
    let t = 0
    let prev = { x: 0, y: 0 }
    let maxStep = 0
    let last = anim.step(0)
    while (!last.done && t < 30) {
      t += dt
      last = anim.step(dt)
      maxStep = Math.max(maxStep, Math.hypot(last.x - prev.x, last.y - prev.y))
      prev = last
    }
    return { t, last, maxStep }
  }

  it('ends exactly on the target without overshooting', () => {
    const { last } = run(1234, -567)
    expect(last).toEqual({ x: 1234, y: -567, done: true })
  })

  it('never exceeds scroll_speed * 60 px/s', () => {
    const dt = 1 / 60
    const { maxStep } = run(5000, 0, 50, dt)
    expect(maxStep / dt).toBeLessThanOrEqual(50 * 60 + 1)
  })

  it('takes the hand-computed time: 0.3 s up, 0.4 s down, cruise in between', () => {
    // vmax 3000 px/s; accelerating covers 450 px, decelerating 600 px; 3000 px leaves 1950 px at 3000 px/s.
    const { t } = run(3000, 0)
    expect(t).toBeGreaterThan(1.3)
    expect(t).toBeLessThan(1.4)
  })

  it('a zero-length scroll is done at once', () => {
    expect(new ScrollAnimation(0, 0, 50).step(0.016)).toEqual({ x: 0, y: 0, done: true })
  })

  it('warps for WARP types, turbo, speed 100 and reduced motion', () => {
    expect(scrollWarps('scroll', 50, 1, false)).toBe(false)
    expect(scrollWarps('onscreen', 50, 1, false)).toBe(false)
    expect(scrollWarps('warp', 50, 1, false)).toBe(true)
    expect(scrollWarps('onscreen-warp', 50, 1, false)).toBe(true)
    expect(scrollWarps('scroll', 100, 1, false)).toBe(true)
    expect(scrollWarps('scroll', 50, 3, false)).toBe(true)
    expect(scrollWarps('scroll', 50, 1, true)).toBe(true)
  })
})
