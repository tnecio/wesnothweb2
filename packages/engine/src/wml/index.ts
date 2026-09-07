/**
 * WML pipeline entry point: tokenizer -> preprocessor -> parser -> `WmlConfig`.
 * See tokenizer.ts, preprocessor.ts and parser.ts for the individual stages
 * and their documented simplifications relative to upstream Wesnoth's
 * `src/serialization/{tokenizer,preprocessor,parser}.cpp`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { WmlConfig } from './config.js';
import type { DefineMap, PreprocessorHost } from './preprocessor.js';
import { preprocess, preloadDefines, preloadDefinesFromDir } from './preprocessor.js';
import { parseConfig } from './parser.js';

export { WmlConfig } from './config.js';
export type { WmlAttributeValue } from './config.js';
export { Tokenizer } from './tokenizer.js';
export type { TokenType, WmlToken } from './tokenizer.js';
export { parseConfig } from './parser.js';
export type { ParseConfigOptions } from './parser.js';
export {
  preprocess,
  preprocessFile,
  preloadDefines,
  preloadDefinesFromDir,
} from './preprocessor.js';
export type {
  MacroDefinition,
  DefineMap,
  PreprocessOptions,
  PreprocessResult,
  PreprocessorHost,
} from './preprocessor.js';

export interface ParseWmlOptions {
  /**
   * Path of the file being parsed. Used as the include-resolution base
   * directory (its containing directory) and for `{CURRENT_FILE}`/error
   * messages. Optional for parsing an ad-hoc snippet with no file identity.
   */
  filePath?: string;
  /** Explicit include-resolution base directory; defaults to `dirname(filePath)` or cwd. */
  dir?: string;
  /** Fallback root for `{includes}` not found relative to `dir` (e.g. the wesnoth `data/` directory). */
  dataRoot?: string;
  /**
   * Shared macro table, mutated in place as `#define`/`#undef` run. Pass the
   * same map across multiple `parseWml`/`preloadDefines*` calls to share
   * definitions the way upstream's single global `preproc_map` does across
   * a whole game data load.
   */
  defines?: DefineMap;
  initialTextdomain?: string;
  host?: PreprocessorHost;
}

/** Preprocesses and parses a WML snippet already in memory. */
export function parseWml(text: string, opts: ParseWmlOptions = {}): WmlConfig {
  const dir = opts.dir ?? (opts.filePath ? path.dirname(opts.filePath) : process.cwd());
  const pre = preprocess(text, {
    dir,
    currentFile: opts.filePath ?? '<string>',
    dataRoot: opts.dataRoot,
    defines: opts.defines,
    initialTextdomain: opts.initialTextdomain,
    host: opts.host,
  });
  return parseConfig(pre.text, { textdomain: pre.textdomain });
}

/** Reads, preprocesses and parses a `.cfg` file from disk. */
export function parseWmlFile(filePath: string, opts: Omit<ParseWmlOptions, 'filePath' | 'dir'> = {}): WmlConfig {
  const host = opts.host;
  const text = host ? host.readFile(filePath) : fs.readFileSync(filePath, 'utf8');
  return parseWml(text, { ...opts, filePath });
}
