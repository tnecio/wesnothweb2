// Public API barrel for @wesnothweb2/engine, consumed by packages/ui,
// packages/renderer, and apps/web. The WML *pipeline* internals (src/wml/
// {tokenizer,preprocessor,parser}.ts -- Node-only file access, see
// docs/ARCHITECTURE.md) are deliberately NOT re-exported here: browser
// consumers should go through `snapshot/gameBoardSnapshot.ts` instead (see
// its module doc comment). `WmlConfig` itself (src/wml/config.ts) has NO
// Node dependency -- it's a plain in-memory tree type with a JSON (de)
// serialization pair -- so it IS exported: the browser needs it to
// reconstruct a scenario's [event] blocks (shipped as JSON in the
// snapshot, see gameBoardSnapshot.ts) and run them through the real event
// pump below.

export * from './model/Location.js';
export * from './model/Map.js';
export * from './model/Terrain.js';
export * from './model/MoveType.js';
export * from './model/UnitType.js';
export * from './model/UnitTypeDatabase.js';
export * from './model/Unit.js';
export * from './model/Team.js';
export * from './model/ShroudMap.js';
export * from './model/GameBoard.js';
export * from './model/Schedule.js';

export * from './pathfind/pathfind.js';
export * from './pathfind/visibility.js';
export * from './actions/index.js';
export * from './ai/index.js';
export * from './rng/index.js';
export * from './events/index.js';
export * from './story/storyParser.js';
export { WmlConfig, type WmlAttributeValue, type WmlConfigJson } from './wml/config.js';
// Browser-safe halves of the WML pipeline, exported for the same reason
// `WmlConfig` is (see this file's own header): neither touches the
// filesystem. `parseConfig` reads WML *text the caller already holds* --
// the preprocessor, which is what actually needs `node:fs`, stays
// unexported -- and `writeWml` turns a config back into that text. Phase
// 26 needs both in the browser: a Wesnoth save file is gzipped WML text,
// so uploading one means parsing it and downloading one means writing it.
export { parseConfig } from './wml/parser.js';
export type { ParseConfigOptions } from './wml/parser.js';
export { writeWml } from './wml/writer.js';

export * from './snapshot/gameBoardSnapshot.js';
