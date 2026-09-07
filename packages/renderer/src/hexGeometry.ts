/**
 * Hex-grid geometry for Wesnoth's flat-top staggered grid.
 *
 * Ported from attempt #1's `lib/utils.ts` and `lib/constants.ts`
 * (wesnothweb/frontend/src/lib/{utils,constants}.ts). Only the pure
 * coordinate-math functions are pulled forward here — everything WASM/
 * worker-protocol-specific (the old `HexCoord` import from `engine/protocol`,
 * UI helpers like `sideColor`/`signed`/`clamp`) is left behind; `HexCoord` is
 * redefined locally since it is just a plain `{x, y}` pair with no protocol
 * coupling.
 *
 * Wesnoth uses 1-based (x, y) where x is column, y is row. Terrain tiles are
 * 72x72 px. Column centres are 54px apart (= tile * 3/4); row centres are
 * 72px apart (= tile height, NOT the regular-hex formula sqrt(3)*size). Odd
 * columns sit at the base row position; even columns are shifted down by
 * half a tile height.
 */

/** A 1-based (column, row) hex coordinate, Wesnoth convention. */
export interface HexCoord {
  x: number  // 1-based column
  y: number  // 1-based row
}

export const TILE_SIZE      = 72          // terrain tile image size (px)
export const HEX_SIZE       = TILE_SIZE / 2   // 36 — half tile, used as "size" param
export const HEX_COL_WIDTH  = TILE_SIZE * 0.75  // 54 — horizontal centre-to-centre
export const HEX_ROW_HEIGHT = TILE_SIZE         // 72 — vertical centre-to-centre

/**
 * Pixel centre of hex (x, y):
 *   px = (x - 1) * HEX_COL_WIDTH + HEX_SIZE
 *   py = (y - 1) * HEX_ROW_HEIGHT + HEX_ROW_HEIGHT/2
 *        + (x % 2 === 0 ? HEX_ROW_HEIGHT/2 : 0)
 */
export function hexToPixel(coord: HexCoord): { x: number; y: number } {
  const px = (coord.x - 1) * HEX_COL_WIDTH + HEX_SIZE
  const py = (coord.y - 1) * HEX_ROW_HEIGHT + HEX_ROW_HEIGHT / 2
    + (coord.x % 2 === 0 ? HEX_ROW_HEIGHT / 2 : 0)
  return { x: px, y: py }
}

/** Inverse of hexToPixel — find nearest hex centre using column-first scan. */
export function pixelToHex(px: number, py: number): HexCoord {
  // Estimate column from x, then check the two candidate columns
  const col = Math.round((px - HEX_SIZE) / HEX_COL_WIDTH) + 1

  let bestDist = Infinity
  let best: HexCoord = { x: 1, y: 1 }

  for (const cx of [col - 1, col, col + 1]) {
    if (cx < 1) continue
    const stagger = cx % 2 === 0 ? HEX_ROW_HEIGHT / 2 : 0
    const rowEst = Math.round((py - HEX_ROW_HEIGHT / 2 - stagger) / HEX_ROW_HEIGHT) + 1
    for (const cy of [rowEst - 1, rowEst, rowEst + 1]) {
      if (cy < 1) continue
      const c = hexToPixel({ x: cx, y: cy })
      const d = (px - c.x) ** 2 + (py - c.y) ** 2
      if (d < bestDist) { bestDist = d; best = { x: cx, y: cy } }
    }
  }
  return best
}

/** The 6 neighbours of a hex in Wesnoth's staggered grid. */
export function hexNeighbours(coord: HexCoord): HexCoord[] {
  const { x, y } = coord
  const isOdd = x % 2 === 1
  // Flat-top staggered: even columns shift down by 0.5 row
  return isOdd
    ? [
        { x: x,     y: y - 1 },  // N
        { x: x + 1, y: y - 1 },  // NE
        { x: x + 1, y: y     },  // SE
        { x: x,     y: y + 1 },  // S
        { x: x - 1, y: y     },  // SW
        { x: x - 1, y: y - 1 },  // NW
      ]
    : [
        { x: x,     y: y - 1 },  // N
        { x: x + 1, y: y     },  // NE
        { x: x + 1, y: y + 1 },  // SE
        { x: x,     y: y + 1 },  // S
        { x: x - 1, y: y + 1 },  // SW
        { x: x - 1, y: y     },  // NW
      ]
}

/** Exact hex distance using cube-coordinate conversion. */
export function hexDistance(a: HexCoord, b: HexCoord): number {
  // Convert staggered (x, y) to cube coords
  const toCube = (c: HexCoord) => {
    const q = c.x - 1
    const r = (c.y - 1) - Math.floor((c.x - 1) / 2)
    return { q, r, s: -q - r }
  }
  const ca = toCube(a)
  const cb = toCube(b)
  return Math.max(
    Math.abs(ca.q - cb.q),
    Math.abs(ca.r - cb.r),
    Math.abs(ca.s - cb.s),
  )
}

/**
 * 6 corner vertices of a Wesnoth flat-top hex centred at (cx, cy).
 *
 * Wesnoth tiles are NOT regular hexagons: column spacing is 3/4 of the tile
 * width (correct for flat-top hex) but row spacing equals the full tile height
 * rather than sqrt(3) * size. The vertical half-height is therefore
 * HEX_ROW_HEIGHT/2 = 36, not size * sin(60°) ≈ 31.18.
 *
 * Corners (clockwise from right):
 *   (cx + rx,    cy      )  right
 *   (cx + rx/2,  cy + ry )  lower-right
 *   (cx - rx/2,  cy + ry )  lower-left
 *   (cx - rx,    cy      )  left
 *   (cx - rx/2,  cy - ry )  upper-left
 *   (cx + rx/2,  cy - ry )  upper-right
 */
export function hexCorners(cx: number, cy: number, size = HEX_SIZE): Array<{ x: number; y: number }> {
  const rx = size
  const ry = (HEX_ROW_HEIGHT / 2) * (size / HEX_SIZE)
  return [
    { x: cx + rx,      y: cy      },
    { x: cx + rx / 2,  y: cy + ry },
    { x: cx - rx / 2,  y: cy + ry },
    { x: cx - rx,      y: cy      },
    { x: cx - rx / 2,  y: cy - ry },
    { x: cx + rx / 2,  y: cy - ry },
  ]
}

/** True if two HexCoords refer to the same hex. */
export function hexEqual(a: HexCoord, b: HexCoord): boolean {
  return a.x === b.x && a.y === b.y
}
