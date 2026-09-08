// Public API barrel for @wesnothweb2/engine, consumed by packages/ui,
// packages/renderer, and apps/web. The WML-pipeline internals (src/wml/*,
// Node-only file access -- see docs/ARCHITECTURE.md) are deliberately NOT
// re-exported here: browser consumers should go through
// `snapshot/gameBoardSnapshot.ts` instead (see its module doc comment).

export * from './model/Location.js';
export * from './model/Map.js';
export * from './model/Terrain.js';
export * from './model/MoveType.js';
export * from './model/UnitType.js';
export * from './model/Unit.js';
export * from './model/Team.js';
export * from './model/GameBoard.js';

export * from './pathfind/pathfind.js';
export * from './actions/index.js';
export * from './rng/index.js';

export * from './snapshot/gameBoardSnapshot.js';
