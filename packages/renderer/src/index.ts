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
  todRef,
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

// ── Unit animation: context schema, filter matching/selection, frame
//    extraction, time-of-day tinting (see packages/renderer/src/animation) ──
export {
  type AnimationContext,
  type StrikeResult,
  strikeResultOf,
  terrainLookup,
  buildAttackBlowAnimationContexts,
  buildAttackAnimationContexts,
  buildMovementAnimationContext,
  buildMovementAnimationContexts,
} from './animation/animationContext'

export {
  MATCH_FAIL,
  DEFAULT_ANIM,
  type AnimBranch,
  type UnitAnimationDef,
  type MatchOptions,
  expandAnimationBranches,
  parseUnitAnimations,
  attackMatchesFilter,
  matchAnimation,
  scoreAnimations,
  selectTopAnimations,
  chooseAnimation,
} from './animation/unitAnimation'

export {
  type UnitFrameDef,
  type StepSequenceItem,
  type ProgressiveSegment,
  type ResolvedFrameImage,
  type HexPixelPos,
  parseDurationMs,
  squareParentheticalSplit,
  parseStepSequence,
  parseProgressivePair,
  sampleProgressivePair,
  parseFrame,
  resolveFrameImage,
  frameCenterPosition,
  applyFrameEffects,
} from './animation/frame'

export {
  type TodColor,
  NEUTRAL_TOD_COLOR,
  todColorFromTimeConfig,
  applyTodTint,
} from './animation/timeOfDay'

// ── Vertical-slice scenario snapshot board (see module doc comment) ────────
export {
  SnapshotBoard,
  spriteKey,
  type ScenarioSnapshot,
  type SnapshotTerrainHex,
  type SnapshotUnit,
  type SnapshotTeam,
  type SnapshotBoardOptions,
  type HexPoint,
  type HighlightState,
  type VillageOwnerPoint,
  type UnitAnimationCue,
} from './SnapshotBoard'
