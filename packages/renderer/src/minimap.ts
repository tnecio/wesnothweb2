/**
 * Phase 22: the minimap, as a draw list -- no canvas, no DOM -- so what it
 * shows is testable in node. A port of upstream's
 * `image::prep_minimap_for_rendering` (`minimap.cpp`) plus the two pieces
 * of `display.cpp` that sit on top of it: the viewport outline
 * (`draw_minimap`) and click-to-hex (`minimap_location_on`).
 *
 * Everything the map knows is passed in; everything the viewing side may
 * not know is filtered out here, exactly where upstream filters it:
 * shrouded hexes draw as void terrain, fogged hexes are darkened, villages
 * under fog or shroud are not marked at all, and units are skipped when
 * fogged, hidden, or invisible enemies.
 */
import { pixelToHex } from './hexGeometry'
import type { Rect } from './camera'

/** An `r, g, b` triple, as colour ranges store them (`teamColor.ts`'s `Rgb`, read-only here). */
export type MinimapRgb = readonly [number, number, number]
type Rgb = MinimapRgb

/** A hex's visibility for the viewing side (`GameSession.hexVisibility`'s states). */
export type MinimapVisibility = 'clear' | 'fogged' | 'shrouded'

export type OrbStatus = 'unmoved' | 'partial' | 'moved'

export interface MinimapUnit {
  x: number
  y: number
  side: number
  /** `unit::get_hidden()`: never drawn. */
  hidden?: boolean
  /** `unit::invisible(loc)` at its hex (ambush, nightstalk...): hidden from enemies of its side. */
  invisible?: boolean
  /** `unit_orb_status` for a unit of the viewing side (only used with movement coding off). */
  orb?: OrbStatus
}

export interface MinimapInput {
  /** Playable size in hexes. */
  width: number
  height: number
  /** The terrain code at hex (x, y), engine 0-based. */
  terrainAt(x: number, y: number): string
  /** What the viewing side knows of hex (x, y); omit for "everything" (no viewing side). */
  visibility?(x: number, y: number): MinimapVisibility
  /** The viewing side, or null for none (upstream's `vw == nullptr`). */
  viewingSide: number | null
  /** Whether `side` is an enemy of the viewing side. */
  isEnemy(side: number): boolean
  /** Every village hex and its owner (0 = unowned). */
  villages: readonly { x: number; y: number; owner: number }[]
  units: readonly MinimapUnit[]
  /** Hexes highlighted as reachable (upstream's `reach_map`), as "x,y". */
  reach?: ReadonlySet<string>
  /** `display::is_blindfolded`: nothing but shroud. */
  blindfolded?: boolean
}

export interface MinimapOptions {
  drawTerrain: boolean
  terrainCoding: boolean
  drawUnits: boolean
  movementCoding: boolean
  drawVillages: boolean
}

export interface MinimapStyle {
  /**
   * `terrain_type::minimap_image()` / `minimap_image_overlay()` for a code
   * (`symbol_image`s; the overlay only for a combined `Base^Overlay` code):
   * image paths relative to the images root, e.g. `terrain/grass/green.png`.
   */
  terrainImages(code: string): { base: string | null; overlay: string | null }
  /**
   * Colour-coding mode: the colour ranges of the terrain's own id and of
   * each underlying terrain's id (`union_type`), as upstream looks them up in
   * `team_rgb_range`. `own` is null when the terrain's id has no range;
   * `underlying` null means one of them has none (upstream then leaves the
   * hex uncoloured).
   */
  terrainColors(code: string): { own: Rgb | null; underlying: readonly Rgb[] | null }
  /** `team::get_minimap_color(side)`: the side's colour range `rep`. */
  sideColor(side: number): Rgb
  /** The orb colours (`*_orb_color` preferences, as each range's `rep`). */
  orbColors: Readonly<Record<OrbStatus | 'ally' | 'enemy', Rgb>>
  /** An unowned village: the `white` range's `min`. */
  unownedVillage: Rgb
}

/** Upstream's hex-shaped overlays for fog and reach, blitted over a terrain tile. */
export const MINIMAP_FOG_IMAGE = 'terrain/minimap-fog.png'
export const MINIMAP_HIGHLIGHT_IMAGE = 'terrain/minimap-highlight.png'
/** `t_translation::VOID_TERRAIN`, drawn where the viewing side has shroud. */
export const VOID_TERRAIN = 'Xv'

export type MinimapTerrainCell =
  | { rect: Rect; images: string[] }
  | { rect: Rect; color: Rgb }

export interface MinimapDrawList {
  /** Pixels per hex in the raw minimap image. */
  scale: number
  /** The raw image's size; the caller scales it into its area keeping the aspect ratio. */
  width: number
  height: number
  /** Painted in order: terrain, then villages, then units. */
  terrain: MinimapTerrainCell[]
  villages: { rect: Rect; color: Rgb }[]
  units: { rect: Rect; color: Rgb }[]
}

/** `get_scale`: pixels per hex, by map size (smaller hexes on bigger maps). */
export function minimapScale(width: number, height: number, options: Pick<MinimapOptions, 'drawTerrain' | 'terrainCoding'>): number {
  const sizeMax = Math.max(width, height)
  if (!options.drawTerrain || !options.terrainCoding) return 4
  if (sizeMax > 60) return 8
  if (sizeMax > 40) return 16
  return 24
}

/** `get_dst_rect`: where hex (x, y) (engine 0-based) goes in the raw image, with the balanced half-hex stagger. */
export function minimapHexRect(x: number, y: number, scale: number): Rect {
  const q = Math.trunc(scale / 4)
  return {
    x: Math.trunc((x * scale * 3) / 4) - q,
    y: y * scale + q * (x % 2 === 1 ? 1 : -1) - q,
    w: scale,
    h: scale,
  }
}

const clamp255 = (v: number): number => Math.min(255, Math.max(0, v))

/** `prep_minimap_for_rendering`, up to the draw calls. */
export function buildMinimap(input: MinimapInput, options: MinimapOptions, style: MinimapStyle): MinimapDrawList | null {
  const scale = minimapScale(input.width, input.height, options)
  const width = Math.trunc((input.width * scale * 3) / 4)
  const height = input.height * scale
  // No map, or nothing to draw.
  if (width === 0 || height === 0) return null
  if (!options.drawVillages && !options.drawTerrain) return null

  const hasViewer = input.viewingSide !== null
  const visibility = (x: number, y: number): MinimapVisibility => (hasViewer && input.visibility ? input.visibility(x, y) : 'clear')
  const shrouded = (x: number, y: number): boolean => !!input.blindfolded || visibility(x, y) === 'shrouded'
  // Shrouded hexes are not considered fogged (no need to fog a black image).
  const fogged = (x: number, y: number): boolean => !shrouded(x, y) && visibility(x, y) === 'fogged'

  const out: MinimapDrawList = { scale, width, height, terrain: [], villages: [], units: [] }

  if (options.drawTerrain) {
    for (let y = 0; y < input.height; y++) {
      for (let x = 0; x < input.width; x++) {
        const highlighted = !!input.reach?.has(`${x},${y}`) && !shrouded(x, y)
        const code = shrouded(x, y) ? VOID_TERRAIN : input.terrainAt(x, y)
        const rect = minimapHexRect(x, y, scale)
        if (options.terrainCoding) {
          const { base, overlay } = style.terrainImages(code)
          if (!base) continue
          const images = [base]
          // The overlay is skipped when the base is missing, so as not to hide the error.
          if (overlay) images.push(overlay)
          if (fogged(x, y)) images.push(MINIMAP_FOG_IMAGE)
          if (highlighted) images.push(MINIMAP_HIGHLIGHT_IMAGE)
          out.terrain.push({ rect, images })
        } else {
          const { own, underlying } = style.terrainColors(code)
          // Upstream returns from the per-hex lambda when an underlying terrain has no range.
          if (!underlying) continue
          let col: Rgb = own ?? [0, 0, 0]
          let first = true
          for (const u of underlying) {
            let tmp: [number, number, number] = [u[0], u[1], u[2]]
            if (fogged(x, y)) tmp = [clamp255(tmp[0] - 50), clamp255(tmp[1] - 50), clamp255(tmp[2] - 50)]
            if (highlighted) tmp = [clamp255(tmp[0] + 50), clamp255(tmp[1] + 50), clamp255(tmp[2] + 50)]
            if (first) {
              first = false
              col = tmp
            } else {
              // col - (col - tmp) / 2, in upstream's integer arithmetic.
              col = [col[0] - Math.trunc((col[0] - tmp[0]) / 2), col[1] - Math.trunc((col[1] - tmp[1]) / 2), col[2] - Math.trunc((col[2] - tmp[2]) / 2)]
            }
          }
          out.terrain.push({ rect: { ...rect, w: Math.trunc((scale * 3) / 4) }, color: col })
        }
      }
    }
  }

  const narrow = (x: number, y: number): Rect => ({ ...minimapHexRect(x, y, scale), w: Math.trunc((scale * 3) / 4) })

  if (options.drawVillages && !input.blindfolded) {
    for (const v of input.villages) {
      if (hasViewer && visibility(v.x, v.y) !== 'clear') continue
      let color = style.unownedVillage
      if (v.owner > 0) {
        if (options.movementCoding || !hasViewer) color = style.sideColor(v.owner)
        else if (v.owner === input.viewingSide) color = style.orbColors.unmoved
        else if (input.isEnemy(v.owner)) color = style.orbColors.enemy
        else color = style.orbColors.ally
      }
      out.villages.push({ rect: narrow(v.x, v.y), color })
    }
  }

  if (options.drawUnits && !input.blindfolded) {
    for (const u of input.units) {
      const enemy = hasViewer && input.isEnemy(u.side)
      if ((hasViewer && visibility(u.x, u.y) !== 'clear') || (enemy && u.invisible) || u.hidden) continue
      let color = style.sideColor(u.side)
      if (!options.movementCoding) {
        if (enemy) color = style.orbColors.enemy
        else if (hasViewer && u.side === input.viewingSide) color = style.orbColors[u.orb ?? 'unmoved']
        else color = style.orbColors.ally
      }
      out.units.push({ rect: narrow(u.x, u.y), color })
    }
  }

  return out
}

/**
 * The raw minimap image scaled into `area` keeping its aspect ratio and
 * centred -- the lambda `prep_minimap_for_rendering` returns. Upstream's
 * `minimap_location_`, which the outline and clicks are measured against.
 */
export function fitMinimap(raw: { width: number; height: number }, area: Rect): Rect {
  const ratio = Math.min(area.w / raw.width, area.h / raw.height)
  const w = Math.trunc(raw.width * ratio)
  const h = Math.trunc(raw.height * ratio)
  return { x: Math.max(area.x, area.x + Math.trunc((area.w - w) / 2)), y: Math.max(area.y, area.y + Math.trunc((area.h - h) / 2)), w, h }
}

/** Column width and hex height at 1:1, in unscaled board pixels (`hex_width`/`hex_size` at zoom 72). */
const HEX_WIDTH = 54
const HEX_SIZE = 72

/*
 * Minimap <-> board coordinates. Upstream converts with the border and a
 * quarter-hex shift that do not match where `get_dst_rect` actually draws a
 * hex (its own comment: "probably more adjustments to do ... the mouse and
 * human capacity to evaluate the rectangle center is not pixel precise") --
 * a click lands up to a hex away from the hex drawn under it. This port uses
 * the exact inverse of `get_dst_rect` instead, for clicks and the outline
 * alike, so the two agree: a hex's centre on the minimap, `(0.75 s x + s/4,
 * s y + s/2 * odd(x))` in the raw image, is the board's `(54 x + 36, 72 y +
 * 36 + 36 * odd(x))`, i.e. board = raw * 72 / s + (18, 36).
 */
const OFFSET_X = HEX_WIDTH / 3
const OFFSET_Y = HEX_SIZE / 2

/** Board point (unscaled board pixels) -> minimap point, for a map drawn at `location`. */
function boardToMinimap(bx: number, by: number, map: { w: number; h: number }, location: Rect): { x: number; y: number } {
  return {
    x: location.x + ((bx - OFFSET_X) * location.w) / (map.w * HEX_WIDTH),
    y: location.y + ((by - OFFSET_Y) * location.h) / (map.h * HEX_SIZE),
  }
}

/**
 * `draw_minimap`'s white outline of what the board shows, in the minimap's
 * coordinates. `view` is the board's stage position/scale and `viewport` the
 * canvas size (`camera.ts`'s `View`); `location` is where the minimap was
 * drawn (`fitMinimap`). Upstream draws it one pixel outside the view.
 */
export function minimapViewRect(
  view: { x: number; y: number; scale: number },
  viewport: { width: number; height: number },
  map: { w: number; h: number },
  location: Rect,
): Rect {
  const topLeft = boardToMinimap(-view.x / view.scale, -view.y / view.scale, map, location)
  const bottomRight = boardToMinimap((viewport.width - view.x) / view.scale, (viewport.height - view.y) / view.scale, map, location)
  const x = Math.trunc(topLeft.x)
  const y = Math.trunc(topLeft.y)
  return { x: x - 1, y: y - 1, w: Math.trunc(bottomRight.x) - x + 2, h: Math.trunc(bottomRight.y) - y + 2 }
}

/**
 * `minimap_location_on`: the hex (engine 0-based) under minimap point
 * (px, py), clamped onto the map, or null outside the minimap.
 */
export function minimapPointToHex(px: number, py: number, map: { w: number; h: number }, location: Rect): { x: number; y: number } | null {
  if (px < location.x || py < location.y || px >= location.x + location.w || py >= location.y + location.h) return null
  const p = minimapPointToBoard(px, py, map, location)
  const hex = pixelToHex(p.x, p.y)
  return {
    x: Math.min(map.w - 1, Math.max(0, hex.x - 1)),
    y: Math.min(map.h - 1, Math.max(0, hex.y - 1)),
  }
}

/** Minimap point -> board point (unscaled board pixels): where a click or drag on the minimap centres the view. */
export function minimapPointToBoard(px: number, py: number, map: { w: number; h: number }, location: Rect): { x: number; y: number } {
  return {
    x: ((px - location.x) * map.w * HEX_WIDTH) / Math.max(location.w, 1) + OFFSET_X,
    y: ((py - location.y) * map.h * HEX_SIZE) / Math.max(location.h, 1) + OFFSET_Y,
  }
}
