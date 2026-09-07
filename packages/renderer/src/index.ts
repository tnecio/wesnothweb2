// packages/renderer — PixiJS-based board renderer.
//
// Public API surface ported forward from attempt #1's fidelity-tested
// image/geometry/animation helpers (see docs/ARCHITECTURE.md, "packages/renderer").

// ── Image Path Function parsing & resolution ────────────────────────────────
export {
  type IpfOp,
  parseIpf,
  splitRef,
  joinRef,
  parseAlpha,
} from './images/ipf'

export {
  ImageCache,
  hexedRef,
  imageUrl,
  setImageBaseUrl,
} from './images/ImageCache'

export {
  type Rgb,
  type ColorRange,
  type ColorData,
  packRgb,
  generateColorMapping,
  applyColorMapping,
  DEFAULT_TC_PALETTE,
} from './images/teamColor'

// ── Hex-grid geometry ────────────────────────────────────────────────────────
export {
  type HexCoord,
  TILE_SIZE,
  HEX_SIZE,
  HEX_COL_WIDTH,
  HEX_ROW_HEIGHT,
  hexToPixel,
  pixelToHex,
  hexNeighbours,
  hexDistance,
  hexCorners,
  hexEqual,
} from './hexGeometry'

// ── Terrain hex-cropping / per-layer positioning ────────────────────────────
export {
  type TerrainFrame,
  type TerrainLayer,
  layerOffset,
  makeLayerSprite,
} from './terrainPositioning'

// ── Animation helpers ────────────────────────────────────────────────────────
export {
  easeInOut,
  sleep,
  tween,
} from './effects/tween'

export {
  showFloatingText,
} from './effects/FloatingText'
