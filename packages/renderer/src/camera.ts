/**
 * Phase 22: the map camera, as pure arithmetic -- no Pixi, no DOM -- so it is
 * testable in node and every caller (`GameBoardView`'s drag, wheel, hotkeys,
 * scripted `[scroll_to]`/`[zoom]`, the minimap) moves the view the same way.
 *
 * Ported from upstream `display.cpp`:
 *  - zoom levels and `get_zoom_levels_index` / `set_zoom`;
 *  - `bounds_check_position` + `map_area` (keep the map in view, centre it
 *    on an axis where it is smaller than the viewport);
 *  - `scroll_to_tiles` (`SCROLL`/`WARP`/`ONSCREEN`/`ONSCREEN_WARP` targets);
 *  - `scroll_to_xy`'s accelerate / cruise / decelerate profile.
 *
 * Coordinates. A `View` is where the board's stage sits on screen: a world
 * point `p` (unscaled board pixels, `hexToPixel`'s space, where the top-left
 * playable hex's tile starts at (0, 0)) is drawn at `x + p.x * scale`. Upstream
 * instead stores `viewport_origin_`, the world pixel at the viewport's
 * top-left at the current zoom -- the same thing negated.
 */
import { HEX_COL_WIDTH, TILE_SIZE, hexToPixel } from './hexGeometry'

/** `data/game_config.cfg`'s `zoom_levels`: hex sizes in pixels, ascending. 72 (`tile_size`) is 1:1. */
export const ZOOM_LEVELS: readonly number[] = [16, 24, 36, 52, 72, 100, 144, 216, 288]
/** `game_config::tile_size`: the hex size at scale 1. */
export const DEFAULT_ZOOM = TILE_SIZE
export const DEFAULT_ZOOM_INDEX = ZOOM_LEVELS.indexOf(DEFAULT_ZOOM)

/** Where the stage sits on screen and at what scale (hex size / 72). */
export interface View {
  x: number
  y: number
  scale: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Map size in playable hexes (upstream `map().w()`/`h()`, border excluded). */
export interface MapSize {
  w: number
  h: number
}

/** `theme_.border().size` in the default theme: half a hex of off-map border on each side. */
const BORDER = 0.5

/** Scale for a zoom level (hex size in px). */
export function scaleForZoom(zoom: number): number {
  return zoom / DEFAULT_ZOOM
}

/**
 * `get_zoom_levels_index`: the level closest to `zoom` (a hex size in px),
 * clamped to the ends. Ties go to the higher level, as upstream's
 * `lower < upper` comparison does.
 */
export function zoomIndexFor(zoom: number): number {
  const z = Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!, Math.max(ZOOM_LEVELS[0]!, zoom))
  let i = ZOOM_LEVELS.findIndex((level) => level >= z)
  if (i > 0) {
    const hi = ZOOM_LEVELS[i]!
    const lo = ZOOM_LEVELS[i - 1]!
    const lower = (z - lo) / (hi - lo)
    const upper = (hi - z) / (hi - lo)
    if (lower < upper) i--
  }
  return i
}

/**
 * Continuous zoom -- a deliberate departure from upstream (the user's call, 2026-09-27): upstream only
 * ever shows one of `ZOOM_LEVELS`, and its steps felt jarring under a pinch. Pinch and Ctrl+wheel now
 * scale smoothly; the hex size stays within upstream's smallest and largest levels. The `zoomin`/
 * `zoomout` hotkeys and WML `[zoom]` still land on a level (`stepZoom`, `zoomIndexFor`).
 */
export const MIN_ZOOM = ZOOM_LEVELS[0]!
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * Pinch zoom (ours; upstream has no touch zoom): the zoom the pinch began at, scaled by how far the fingers
 * have spread (`ratio` = current / starting distance), clamped.
 */
export function pinchZoom(startZoom: number, ratio: number): number {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return startZoom
  return clampZoom(startZoom * ratio)
}

/**
 * `zoomin`/`zoomout` from a zoom that may lie between levels: the nearest level above (or below) it, so a
 * smoothly zoomed view snaps back onto upstream's levels one step at a time.
 */
export function stepZoom(zoom: number, increase: boolean): number {
  const EPS = 0.5
  if (increase) return ZOOM_LEVELS.find((level) => level > zoom + EPS) ?? MAX_ZOOM
  return [...ZOOM_LEVELS].reverse().find((level) => level < zoom - EPS) ?? MIN_ZOOM
}

/** `set_zoom(bool increase)`: one level in or out, clamped. */
export function stepZoomIndex(index: number, increase: boolean): number {
  return Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index + (increase ? 1 : -1)))
}

/**
 * The world rectangle the camera may show: the playable map plus the theme's
 * half-hex border (`max_map_area`), in unscaled board pixels. Upstream's
 * `xend`/`yend` from `bounds_check_position`, shifted into our origin.
 */
export function worldBounds(map: MapSize): Rect {
  const left = -BORDER * HEX_COL_WIDTH
  const top = -BORDER * TILE_SIZE
  // (w + 2*border) * hex_width + hex_width / 3 -- the last column's tile overhangs by a third of a column.
  const w = (map.w + 2 * BORDER) * HEX_COL_WIDTH + HEX_COL_WIDTH / 3
  // (h + 2*border) * hex_size + hex_size / 2 -- odd columns are shifted down half a hex.
  const h = (map.h + 2 * BORDER) * TILE_SIZE + TILE_SIZE / 2
  return { x: left, y: top, w, h }
}

function clampAxis(pos: number, start: number, length: number, scale: number, viewport: number): number {
  const scaled = length * scale
  // map_area(): a map smaller than the viewport is centred on that axis.
  if (scaled <= viewport) return (viewport - scaled) / 2 - start * scale
  // bounds_check_position: viewport_origin in [0, end - map_area.w].
  const max = -start * scale
  const min = viewport - (start + length) * scale
  return Math.min(max, Math.max(min, pos))
}

/** `bounds_check_position`, plus `map_area`'s centring of a map smaller than the viewport. */
export function clampView(view: View, map: MapSize, viewport: Size): View {
  const b = worldBounds(map)
  return {
    scale: view.scale,
    x: clampAxis(view.x, b.x, b.w, view.scale, viewport.width),
    y: clampAxis(view.y, b.y, b.h, view.scale, viewport.height),
  }
}

/**
 * `map_area()` on screen: the viewport, narrowed on any axis where the whole
 * map fits (the part of the screen actually showing map).
 */
export function mapArea(view: View, map: MapSize, viewport: Size): Rect {
  const b = worldBounds(map)
  const r: Rect = { x: 0, y: 0, w: viewport.width, h: viewport.height }
  if (b.w * view.scale < viewport.width) {
    r.x = view.x + b.x * view.scale
    r.w = b.w * view.scale
  }
  if (b.h * view.scale < viewport.height) {
    r.y = view.y + b.y * view.scale
    r.h = b.h * view.scale
  }
  return r
}

/**
 * Scales to `scale` keeping the screen point `anchor` fixed (the wheel keeps
 * the point under the pointer; hotkeys and `[zoom]` use the viewport centre,
 * as `set_zoom` does), then clamps.
 */
export function zoomAbout(view: View, scale: number, anchor: { x: number; y: number }, map: MapSize, viewport: Size): View {
  const f = scale / view.scale
  return clampView({ scale, x: anchor.x - (anchor.x - view.x) * f, y: anchor.y - (anchor.y - view.y) * f }, map, viewport)
}

/** Centres world point `p` (unscaled board pixels) in the viewport, clamped. */
export function centerOn(view: View, p: { x: number; y: number }, map: MapSize, viewport: Size): View {
  return clampView({ scale: view.scale, x: viewport.width / 2 - p.x * view.scale, y: viewport.height / 2 - p.y * view.scale }, map, viewport)
}

/** Upstream's `SCROLL_TYPE`. */
export type ScrollType = 'scroll' | 'warp' | 'onscreen' | 'onscreen-warp'

/** Top-left of hex (x, y) (engine 0-based) on screen -- `display::get_location`. */
function hexScreenTopLeft(view: View, x: number, y: number): { x: number; y: number } {
  const c = hexToPixel({ x: x + 1, y: y + 1 })
  return { x: view.x + (c.x - TILE_SIZE / 2) * view.scale, y: view.y + (c.y - TILE_SIZE / 2) * view.scale }
}

/** `display::outside_area`: whether a hex whose tile starts at (x, y) is not wholly inside `area`. */
function outsideArea(area: Rect, x: number, y: number, hexSize: number): boolean {
  return x < area.x || x > area.x + area.w - hexSize || y < area.y || y > area.y + area.h - hexSize
}

export interface ScrollToTilesOptions {
  /** `add_spacing`: for the ONSCREEN types, how many hexes of margin count as "not on screen". */
  addSpacing?: number
  /** `only_if_possible`: give up entirely if the hexes cannot all fit on screen. */
  onlyIfPossible?: boolean
}

/**
 * `display::scroll_to_tiles` up to (not including) the actual scroll: the
 * clamped view the camera should end at, or `null` when it should not move
 * (no hexes, all already on screen for an ONSCREEN type, or cannot fit with
 * `onlyIfPossible`). Hexes are engine 0-based and must be on the map; the
 * caller drops fogged ones first when upstream's `check_fogged` applies.
 */
export function scrollTargetForHexes(
  view: View,
  hexes: readonly { x: number; y: number }[],
  type: ScrollType,
  map: MapSize,
  viewport: Size,
  options: ScrollToTilesOptions = {},
): View | null {
  const hexSize = TILE_SIZE * view.scale
  const area = mapArea(view, map, viewport)
  let minx = 0
  let maxx = 0
  let miny = 0
  let maxy = 0
  let valid = false
  for (const hex of hexes) {
    if (hex.x < 0 || hex.y < 0 || hex.x >= map.w || hex.y >= map.h) continue
    const { x, y } = hexScreenTopLeft(view, hex.x, hex.y)
    if (!valid) {
      minx = maxx = x
      miny = maxy = y
      valid = true
      continue
    }
    const nminx = Math.min(minx, x)
    const nminy = Math.min(miny, y)
    const nmaxx = Math.max(maxx, x)
    const nmaxy = Math.max(maxy, y)
    if (outsideArea({ x: nminx, y: nminy, w: area.w, h: area.h }, nmaxx, nmaxy, hexSize)) {
      // We cannot fit all locations on screen.
      if (options.onlyIfPossible) return null
      break
    }
    minx = nminx
    miny = nminy
    maxx = nmaxx
    maxy = nmaxy
  }
  if (!valid) return null

  const onscreen = type === 'onscreen' || type === 'onscreen-warp'
  if (onscreen) {
    const spacing = Math.round((options.addSpacing ?? 0) * hexSize)
    const shrunk = { x: area.x + spacing, y: area.y + spacing, w: area.w - 2 * spacing, h: area.h - 2 * spacing }
    if (!outsideArea(shrunk, minx, miny, hexSize) && !outsideArea(shrunk, maxx, maxy, hexSize)) return null
  }

  const bbox = { x: minx, y: miny, w: maxx - minx + hexSize, h: maxy - miny + hexSize }
  const target = { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 }
  const centerX = area.x + area.w / 2
  const centerY = area.y + area.h / 2

  if (onscreen) {
    // Don't centre the target unless needed: find the point nearest the
    // screen centre that still puts the hexes in the middle half of the screen.
    const insideFrac = 0.5
    const w = Math.max(1, Math.trunc(area.w * insideFrac) - bbox.w)
    const h = Math.max(1, Math.trunc(area.h * insideFrac) - bbox.h)
    const r = { x: target.x - w / 2, y: target.y - h / 2, w, h }
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
    if (centerX < r.x) {
      target.x = r.x
      target.y = clamp(centerY, r.y, r.y + r.h - 1)
    } else if (centerX > r.x + r.w - 1) {
      target.x = r.x + r.w - 1
      target.y = clamp(centerY, r.y, r.y + r.h - 1)
    } else if (centerY < r.y) {
      target.y = r.y
      target.x = clamp(centerX, r.x, r.x + r.w - 1)
    } else if (centerY > r.y + r.h - 1) {
      target.y = r.y + r.h - 1
      target.x = clamp(centerX, r.x, r.x + r.w - 1)
    }
  }

  // scroll_to_xy: move so `target` lands on the map area's centre, then bounds-check.
  const next = clampView({ scale: view.scale, x: view.x - (target.x - centerX), y: view.y - (target.y - centerY) }, map, viewport)
  return next.x === view.x && next.y === view.y ? null : next
}

/** `scroll_to_xy`'s acceleration and deceleration times (seconds), before turbo. */
const ACCEL_TIME = 0.3
const DECEL_TIME = 0.4
/** Upstream never lets one frame advance more than 200 ms, so a stalled frame doesn't jump. */
const MAX_DT = 0.2

/**
 * `scroll_to_xy`'s animated scroll: accelerate to `scroll_speed * 60` px/s
 * (times turbo), cruise, and decelerate so as to stop exactly on the target.
 * Call `step(dt)` once per frame with the elapsed seconds; it returns the
 * offset moved so far (screen px, rounded as upstream) and whether it's done.
 */
export class ScrollAnimation {
  private readonly distTotal: number
  private distMoved = 0
  private velocity = 0
  private readonly velocityMax: number
  private readonly accel: number
  private readonly decel: number

  constructor(
    readonly dx: number,
    readonly dy: number,
    scrollSpeed: number,
    turboSpeed = 1,
  ) {
    this.distTotal = Math.hypot(dx, dy)
    this.velocityMax = scrollSpeed * 60 * turboSpeed
    this.accel = this.velocityMax / (ACCEL_TIME / turboSpeed)
    this.decel = this.velocityMax / (DECEL_TIME / turboSpeed)
  }

  get done(): boolean {
    return this.distMoved >= this.distTotal
  }

  step(dtSeconds: number): { x: number; y: number; done: boolean } {
    if (!this.done) {
      const dt = Math.min(dtSeconds, MAX_DT)
      // If we started to decelerate now, where would we stop?
      const stopTime = this.velocity / this.decel
      const distStop = this.distMoved + this.velocity * stopTime - 0.5 * this.decel * stopTime * stopTime
      if (distStop > this.distTotal || this.velocity > this.velocityMax) {
        this.velocity = Math.max(1, this.velocity - this.decel * dt)
      } else {
        this.velocity = Math.min(this.velocityMax, this.velocity + this.accel * dt)
      }
      this.distMoved = Math.min(this.distTotal, this.distMoved + this.velocity * dt)
    }
    const f = this.distTotal === 0 ? 1 : this.distMoved / this.distTotal
    return { x: Math.round(this.dx * f), y: Math.round(this.dy * f), done: this.done }
  }
}

/**
 * Whether a scroll should jump rather than animate: the WARP types, turbo
 * above 2x, scroll speed above 99 (`scroll_to_xy`), and -- this port's
 * addition -- the player's reduced-motion setting.
 */
export function scrollWarps(type: ScrollType, scrollSpeed: number, turboSpeed: number, reducedMotion: boolean): boolean {
  return type === 'warp' || type === 'onscreen-warp' || turboSpeed > 2 || scrollSpeed > 99 || reducedMotion
}

/** `controller_base::handle_scroll`: edge-pan distance for `dtMs` of held pointer, in screen px. */
export function edgeScrollAmount(dtMs: number, scrollSpeed: number): number {
  return dtMs * 0.036 * scrollSpeed
}
