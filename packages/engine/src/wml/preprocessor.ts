/**
 * TS port of upstream Wesnoth's `serialization/preprocessor.cpp`.
 *
 * Expands `#define`/`#enddef` macros, `{MACRO arg1 arg2 (arg with spaces)}`
 * macro calls (including nested `{...}` inside arguments and macro names),
 * `{path/to/file.cfg}` / `{path/to/dir/}` includes, `#ifdef`/`#ifndef`/
 * `#ifhave`/`#ifnhave`/`#ifver`/`#ifnver` conditionals with `#else`/`#endif`,
 * `#undef`, `#error`, `#warning`, and `#textdomain` markers, into one flat
 * WML text string ready for tokenizer.ts/parser.ts.
 *
 * -----------------------------------------------------------------------
 * Architectural difference from upstream (read this before changing logic)
 * -----------------------------------------------------------------------
 * Upstream implements this as an incremental `std::streambuf` (`
 * preprocessor_streambuf`) that lazily pulls small chunks through a stack of
 * nested `preprocessor`/`preprocessor_data` objects, because it's designed
 * to feed a `std::istream` the parser reads from one buffer-fill at a time.
 * We don't need that: we have the whole source string in memory and can
 * simply produce the whole expanded string. So this port restructures the
 * *same semantics* (verified line-by-line against preprocessor.cpp) as a
 * straightforward recursive-descent scanner over a string+index, with each
 * "expand this span" operation just returning a string. This is a lot
 * easier to read and verify than a faithful transliteration of the buffer
 * machinery would have been, at the cost of being a restructuring rather
 * than a literal translation for this one file.
 *
 * Known simplifications / deferred features (documented here so they're
 * easy to find):
 *  - Textdomain tracking is a single un-scoped "last seen" value, not
 *    properly push/popped per file/macro like upstream's `textdomain_`.
 *    This has no effect on parsed attribute *values* (WmlConfig has no
 *    translatable-string type -- see parser.ts) so it only matters once a
 *    real i18n layer exists.
 *  - `#deprecated` (both the top-level directive and the `#define` body
 *    variant) is recognized and skipped, but no deprecation warning is
 *    surfaced anywhere.
 *  - Parenthesized macro arguments `(...)` are matched by simple paren-depth
 *    counting. Upstream has a stranger token-stack-based rule for nested
 *    parens; ours is more permissive/intuitive and should handle real WML
 *    (which only nests parens rarely, e.g. filter expressions) at least as
 *    well.
 *  - `{include}` resolution supports only: paths relative to the current
 *    file/macro-definition's directory, and paths relative to a single
 *    configured `dataRoot`. Upstream's `get_wml_location` also searches the
 *    user's data directory, add-on trees, and `~`-prefixed add-on-relative
 *    paths -- none of that exists yet (no add-ons in scope for Phase 1).
 *  - Directory inclusion (`{some/dir/}`) lists `*.cfg` files directly in
 *    that directory (preferring a lone `_main.cfg` if present, else
 *    alphabetical order), matching upstream's actual behavior for the
 *    directories this project currently preprocesses, but not upstream's
 *    subdirectory-with-its-own-`_main.cfg` recursion or the `_first.cfg`/
 *    `_final.cfg` reordering rules (unused by our test content).
 *  - `#line` is not implemented (nothing in a from-scratch preprocessing run
 *    emits it) -- fine since we don't need to map errors back through
 *    upstream's encoded-filename scheme.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MacroDefinition {
  name: string;
  /** Required positional parameter names, in order. */
  params: string[];
  /** Optional parameter name -> raw (unexpanded) default value text. */
  optionalParams: Map<string, string>;
  /** Raw (unexpanded) macro body text. */
  body: string;
  /** Directory of the file this macro was `#define`d in; used to resolve `{includes}` inside its body. */
  dir: string;
  /** For diagnostics. */
  location: string;
}

export type DefineMap = Map<string, MacroDefinition>;

export interface IncludeResolution {
  kind: 'file' | 'dir';
  /** Absolute (or resolver-defined) path, passed back into readFile/readDir. */
  resolvedPath: string;
}

export interface PreprocessorHost {
  readFile(resolvedPath: string): string;
  /** Lists immediate `*.cfg` filenames (not full paths) directly inside a directory. */
  readDir(resolvedPath: string): string[];
  /** Returns undefined if nothing exists at this exact path. */
  stat(candidatePath: string): { isDirectory: boolean } | undefined;
  /** Joins/normalizes path segments the way this host's filesystem expects. */
  join(...segments: string[]): string;
  dirname(p: string): string;
}

function makeNodeHost(): PreprocessorHost {
  return {
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    readDir: (p) => fs.readdirSync(p),
    stat: (p) => {
      try {
        const st = fs.statSync(p);
        return { isDirectory: st.isDirectory() };
      } catch {
        return undefined;
      }
    },
    join: (...segments) => path.join(...segments),
    dirname: (p) => path.dirname(p),
  };
}

export interface PreprocessOptions {
  /** Directory used to resolve relative `{includes}` found directly in this source. */
  dir: string;
  /** Name used for `{CURRENT_FILE}`/error messages. */
  currentFile?: string;
  /** Fallback root for `{includes}` that aren't found relative to `dir` (e.g. the wesnoth `data/` directory). */
  dataRoot?: string;
  /** Shared, mutated-in-place macro table. Pass the same map across calls to share `#define`s between files. */
  defines?: DefineMap;
  initialTextdomain?: string;
  host?: PreprocessorHost;
}

export interface PreprocessResult {
  text: string;
  defines: DefineMap;
  /** Last `#textdomain` value seen anywhere during this run (see module doc: not properly scoped). */
  textdomain: string;
}

const CURRENT_FILE_SYM = 'CURRENT_FILE';
const CURRENT_DIR_SYM = 'CURRENT_DIRECTORY';
const LEFT_BRACE_SYM = 'LEFT_BRACE';
const RIGHT_BRACE_SYM = 'RIGHT_BRACE';

const MAX_MACRO_DEPTH = 100;
const MAX_INCLUDE_DEPTH = 40;

class PreprocessorError extends Error {}

interface Ctx {
  dir: string;
  currentFile: string;
  defines: DefineMap;
  /** Bound parameter values for the macro body currently being expanded, if any. */
  localArgs?: Map<string, string>;
  depth: number;
  host: PreprocessorHost;
  dataRoot: string | undefined;
  /** Mutable box so directive handling can update it and have later text in the same scan see it. */
  domain: { value: string };
}

function lineAt(src: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src.charAt(i) === '\n') line++;
  }
  return line;
}

function fail(src: string, pos: number, message: string): never {
  throw new PreprocessorError(`${message} (preprocessor, line ${lineAt(src, pos)})`);
}

function isWordBoundary(src: string, pos: number): boolean {
  const c = pos < src.length ? src.charAt(pos) : '';
  return !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && c !== '_';
}

/** Finds the next `#keyword` (one of `words`) at or after `from`, requiring a word boundary after it. */
function findNextDirective(src: string, from: number, words: string[]): { index: number; word: string } | undefined {
  let i = src.indexOf('#', from);
  while (i !== -1) {
    for (const w of words) {
      if (src.startsWith(w, i + 1) && isWordBoundary(src, i + 1 + w.length)) {
        return { index: i, word: w };
      }
    }
    i = src.indexOf('#', i + 1);
  }
  return undefined;
}

function skipSpacesTabs(src: string, pos: number): number {
  while (pos < src.length && (src.charAt(pos) === ' ' || src.charAt(pos) === '\t')) pos++;
  return pos;
}

function skipToEol(src: string, pos: number): number {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.length : nl + 1;
}

function readWord(src: string, pos: number): { word: string; pos: number } {
  let end = pos;
  while (end < src.length && !/\s/.test(src.charAt(end))) end++;
  return { word: src.slice(pos, end), pos: end };
}

function restOfLine(src: string, pos: number): { text: string; pos: number } {
  const nl = src.indexOf('\n', pos);
  const end = nl === -1 ? src.length : nl;
  return { text: src.slice(pos, end).replace(/\r$/, ''), pos: end };
}

// ---------------------------------------------------------------------------
// #define ... #enddef capture (raw, unexpanded body + #arg/#endarg defaults)
// ---------------------------------------------------------------------------

function readDefineBody(
  src: string,
  startPos: number,
): { body: string; optionalParams: Map<string, string>; pos: number } {
  const optionalParams = new Map<string, string>();
  let body = '';
  let pos = startPos;

  for (;;) {
    const found = findNextDirective(src, pos, ['enddef', 'define', 'deprecated', 'arg']);
    if (!found) fail(src, startPos, 'Unterminated preprocessor definition (#enddef not found)');

    body += src.slice(pos, found.index);

    if (found.word === 'enddef') {
      pos = found.index + 1 + 'enddef'.length;
      return { body, optionalParams, pos };
    }

    if (found.word === 'define') {
      fail(src, found.index, 'Preprocessor error: #define is not allowed inside a #define/#enddef pair');
    }

    if (found.word === 'deprecated') {
      // #deprecated LEVEL [VERSION] message-until-eol -- recognized and discarded (see module doc).
      // Unlike processDirective's top-level directives, no explicit '\n'
      // needs adding here: the next loop iteration's `body += src.slice(pos,
      // found.index)` naturally starts right after this line and captures
      // through the following directive, newline included -- confirmed by
      // tracing `#define FOO\nsome_text\n#deprecated ...\nmore_text\n#enddef`
      // through by hand; adding a newline here double-spaces it instead.
      pos = found.index + 1 + 'deprecated'.length;
      pos = skipToEol(src, pos);
      continue;
    }

    // #arg NAME ... #endarg
    pos = found.index + 1 + 'arg'.length;
    pos = skipSpacesTabs(src, pos);
    const nameRead = readWord(src, pos);
    const argName = nameRead.word;
    pos = skipToEol(src, nameRead.pos);

    const endFound = findNextDirective(src, pos, ['endarg']);
    if (!endFound) fail(src, pos, `Unterminated #arg definition for '${argName}'`);
    const defaultText = src.slice(pos, endFound.index);
    pos = endFound.index + 1 + 'endarg'.length;
    pos = skipToEol(src, pos);
    optionalParams.set(argName, defaultText);
  }
}

// ---------------------------------------------------------------------------
// Verbatim `<<...>>` and quoted `"..."` spans (delimiters are preserved in
// output text -- the tokenizer re-parses them).
// ---------------------------------------------------------------------------

function readVerbatim(src: string, pos: number): { text: string; pos: number } {
  let out = '<<';
  pos += 2;
  for (;;) {
    if (pos >= src.length) fail(src, pos, 'Verbatim string not terminated');
    if (src.charAt(pos) === '>' && src.charAt(pos + 1) === '>') {
      out += '>>';
      pos += 2;
      return { text: out, pos };
    }
    out += src.charAt(pos);
    pos++;
  }
}

function readQuoted(src: string, pos: number, ctx: Ctx, active: boolean): { text: string; pos: number } {
  let out = '"';
  pos += 1;
  for (;;) {
    if (pos >= src.length) fail(src, pos, 'Quoted string not terminated');
    const c = src.charAt(pos);
    if (c === '"') {
      if (src.charAt(pos + 1) === '"') {
        out += '"';
        pos += 2;
        continue;
      }
      out += '"';
      pos += 1;
      return { text: out, pos };
    }
    if (c === '<' && src.charAt(pos + 1) === '<') {
      const r = readVerbatim(src, pos);
      out += r.text;
      pos = r.pos;
      continue;
    }
    if (c === '{') {
      const r = readBraceExpr(src, pos + 1, ctx, active);
      out += r.text;
      pos = r.pos;
      continue;
    }
    out += c;
    pos += 1;
  }
}

// ---------------------------------------------------------------------------
// `{...}` macro/include expansion
// ---------------------------------------------------------------------------

function readParenGroup(src: string, pos: number, ctx: Ctx, active: boolean): { text: string; pos: number } {
  pos += 1; // consume '('
  let depth = 1;
  let out = '';
  for (;;) {
    if (pos >= src.length) fail(src, pos, 'Macro argument not terminated');
    const c = src.charAt(pos);
    if (c === '(') {
      depth++;
      out += c;
      pos++;
      continue;
    }
    if (c === ')') {
      depth--;
      pos++;
      if (depth === 0) return { text: out, pos };
      out += ')';
      continue;
    }
    if (c === '<' && src.charAt(pos + 1) === '<') {
      const r = readVerbatim(src, pos);
      out += r.text;
      pos = r.pos;
      continue;
    }
    if (c === '"') {
      const r = readQuoted(src, pos, ctx, active);
      out += r.text;
      pos = r.pos;
      continue;
    }
    if (c === '{') {
      const r = readBraceExpr(src, pos + 1, ctx, active);
      out += r.text;
      pos = r.pos;
      continue;
    }
    out += c;
    pos++;
  }
}

/** Lightweight brace-depth skip used when a macro call appears inside a skipped `#ifdef` branch. */
function skipBraceExpr(src: string, pos: number): number {
  let depth = 1;
  while (pos < src.length) {
    const c = src.charAt(pos);
    if (c === '<' && src.charAt(pos + 1) === '<') {
      const nl = src.indexOf('>>', pos + 2);
      pos = nl === -1 ? src.length : nl + 2;
      continue;
    }
    if (c === '"') {
      pos++;
      while (pos < src.length) {
        if (src.charAt(pos) === '"') {
          if (src.charAt(pos + 1) === '"') {
            pos += 2;
            continue;
          }
          pos++;
          break;
        }
        pos++;
      }
      continue;
    }
    if (c === '{') {
      depth++;
      pos++;
      continue;
    }
    if (c === '}') {
      depth--;
      pos++;
      if (depth === 0) return pos;
      continue;
    }
    pos++;
  }
  return pos;
}

function resolveIncludePath(symbol: string, dir: string, ctx: Ctx): IncludeResolution | undefined {
  const candidates: string[] = [];
  // `~` marks an add-on-relative path upstream; we don't support add-ons yet, so just
  // treat it the same as a plain relative path (best-effort, see module doc).
  const cleaned = symbol.startsWith('~') || symbol.startsWith('./') ? symbol.replace(/^~|^\.\//, '') : symbol;

  candidates.push(ctx.host.join(dir, cleaned));
  if (ctx.dataRoot) candidates.push(ctx.host.join(ctx.dataRoot, cleaned));

  for (const raw of candidates) {
    // `{some/dir/}`-style calls carry a trailing slash; normalize it away before stat()ing
    // so hosts that don't themselves tolerate it (see PreprocessorHost) still work.
    const candidate = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const st = ctx.host.stat(candidate);
    if (st) return { kind: st.isDirectory ? 'dir' : 'file', resolvedPath: candidate };
  }
  return undefined;
}

function listCfgFilesInDir(dirPath: string, ctx: Ctx): string[] {
  const mainCfg = ctx.host.join(dirPath, '_main.cfg');
  if (ctx.host.stat(mainCfg)?.isDirectory === false) {
    return [mainCfg];
  }
  const entries = ctx.host
    .readDir(dirPath)
    .filter((f) => f.endsWith('.cfg') && !f.startsWith('.'))
    .sort();
  return entries.map((f) => ctx.host.join(dirPath, f));
}

function expandIncludedFile(resolvedPath: string, ctx: Ctx): string {
  if (ctx.depth >= MAX_INCLUDE_DEPTH) {
    fail('', 0, 'Too many nested preprocessing inclusions');
  }
  const text = ctx.host.readFile(resolvedPath);
  const nestedCtx: Ctx = {
    dir: ctx.host.dirname(resolvedPath),
    currentFile: resolvedPath,
    defines: ctx.defines,
    localArgs: undefined,
    depth: ctx.depth + 1,
    host: ctx.host,
    dataRoot: ctx.dataRoot,
    domain: ctx.domain,
  };
  const r = expandText(text, 0, nestedCtx, true, false);
  return r.text;
}

function expandIncludedDir(resolvedPath: string, ctx: Ctx): string {
  const files = listCfgFilesInDir(resolvedPath, ctx);
  let out = '';
  for (const f of files) {
    out += expandIncludedFile(f, ctx);
  }
  return out;
}

function bindMacroArgs(
  symbol: string,
  macro: MacroDefinition,
  argChunks: string[],
  ctx: Ctx,
  pos: number,
  src: string,
): Map<string, string> {
  const bound = new Map<string, string>();
  let optionalArgCount = 0;

  for (let i = 0; i < argChunks.length; i++) {
    if (i < macro.params.length) {
      bound.set(macro.params[i] as string, argChunks[i] as string);
      continue;
    }
    const chunk = argChunks[i] as string;
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    const argName = chunk.slice(0, eq);
    if (macro.optionalParams.has(argName)) {
      bound.set(argName, chunk.slice(eq + 1));
      optionalArgCount++;
    } else {
      optionalArgCount++; // keep the arg-count check from blowing up, matching upstream
    }
  }

  for (const [name, defaultRaw] of macro.optionalParams) {
    if (!bound.has(name)) {
      // Optional-argument defaults are themselves WML text that may reference other args.
      const r = expandText(defaultRaw, 0, { ...ctx, dir: macro.dir, localArgs: bound }, true, false);
      bound.set(name, r.text);
    }
  }

  if (argChunks.length - optionalArgCount !== macro.params.length) {
    fail(
      src,
      pos,
      `Preprocessor symbol '${symbol}' defined at ${macro.location} expects ${macro.params.length} arguments, ` +
        `but was given ${argChunks.length - optionalArgCount}`,
    );
  }

  return bound;
}

function readBraceExpr(src: string, pos: number, ctx: Ctx, active: boolean): { text: string; pos: number } {
  if (!active) {
    return { text: '', pos: skipBraceExpr(src, pos) };
  }

  const chunks: string[] = [];
  for (;;) {
    while (pos < src.length && /[ \t\r\n]/.test(src.charAt(pos))) pos++;
    if (pos < src.length && src.charAt(pos) === '#') {
      // A comment/directive between macro-call arguments (rare, but legal).
      const r = processDirective(src, pos, ctx, active, false);
      if (r.stoppedBy) fail(src, pos, 'Unexpected #else/#endif inside macro substitution');
      pos = r.pos;
      continue;
    }
    if (pos >= src.length) fail(src, pos, 'Macro substitution not terminated');
    if (src.charAt(pos) === '}') {
      pos++;
      break;
    }
    if (src.charAt(pos) === '(') {
      const r = readParenGroup(src, pos, ctx, active);
      chunks.push(r.text);
      pos = r.pos;
      continue;
    }

    let word = '';
    while (pos < src.length) {
      const c = src.charAt(pos);
      if (c === '}' || c === '(' || /[ \t\r\n]/.test(c)) break;
      if (c === '<' && src.charAt(pos + 1) === '<') {
        const r = readVerbatim(src, pos);
        word += r.text;
        pos = r.pos;
        continue;
      }
      if (c === '"') {
        const r = readQuoted(src, pos, ctx, active);
        word += r.text;
        pos = r.pos;
        continue;
      }
      if (c === '{') {
        const r = readBraceExpr(src, pos + 1, ctx, active);
        word += r.text;
        pos = r.pos;
        continue;
      }
      word += c;
      pos++;
    }
    chunks.push(word);
  }

  const callSitePos = pos;
  if (chunks.length === 0) {
    fail(src, callSitePos, 'No macro or file substitution target specified');
  }
  const symbol = chunks[0] as string;
  const args = chunks.slice(1);

  if (symbol === CURRENT_FILE_SYM && args.length === 0) {
    return { text: ctx.currentFile, pos };
  }
  if (symbol === CURRENT_DIR_SYM && args.length === 0) {
    return { text: ctx.host.dirname(ctx.currentFile), pos };
  }
  if (symbol === LEFT_BRACE_SYM && args.length === 0) {
    return { text: '{', pos };
  }
  if (symbol === RIGHT_BRACE_SYM && args.length === 0) {
    return { text: '}', pos };
  }

  if (ctx.localArgs?.has(symbol)) {
    if (args.length !== 0) {
      fail(src, callSitePos, `Macro argument '${symbol}' does not expect any arguments`);
    }
    return { text: ctx.localArgs.get(symbol) as string, pos };
  }

  const macro = ctx.defines.get(symbol);
  if (macro) {
    if (ctx.depth >= MAX_MACRO_DEPTH) {
      fail(src, callSitePos, 'Too many nested preprocessing inclusions');
    }
    const bound = bindMacroArgs(symbol, macro, args, ctx, callSitePos, src);
    const nestedCtx: Ctx = {
      dir: macro.dir,
      currentFile: ctx.currentFile,
      defines: ctx.defines,
      localArgs: bound,
      depth: ctx.depth + 1,
      host: ctx.host,
      dataRoot: ctx.dataRoot,
      domain: ctx.domain,
    };
    const r = expandText(macro.body, 0, nestedCtx, true, false);
    return { text: r.text, pos };
  }

  // Not a known macro or special symbol: treat as a file/directory to include.
  const resolved = resolveIncludePath(symbol, ctx.dir, ctx);
  if (!resolved) {
    fail(src, callSitePos, `Macro/file '${symbol}' is missing`);
  }
  const text = resolved.kind === 'dir' ? expandIncludedDir(resolved.resolvedPath, ctx) : expandIncludedFile(resolved.resolvedPath, ctx);
  return { text, pos };
}

// ---------------------------------------------------------------------------
// Directives: #define #ifdef #ifndef #ifhave #ifnhave #ifver #ifnver #else
// #endif #undef #error #warning #textdomain #deprecated, plain comments.
// ---------------------------------------------------------------------------

type StoppedBy = 'else' | 'endif' | null;

function compareVersions(a: string, op: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  let cmp = 0;
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) {
      cmp = da < db ? -1 : 1;
      break;
    }
  }
  switch (op) {
    case '==':
      return cmp === 0;
    case '!=':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    default:
      return false;
  }
}

/**
 * Handles a conditional's chosen branch: fully expands (if `active`) or skips
 * (if `!active`) text starting at `pos` until a matching `#else`/`#endif`.
 */
function scanConditionalBranch(
  src: string,
  pos: number,
  ctx: Ctx,
  active: boolean,
): { text: string; pos: number; stoppedBy: 'else' | 'endif' } {
  const r = expandText(src, pos, ctx, active, true);
  if (!r.stoppedBy) fail(src, pos, '#ifdef or #ifndef not terminated');
  return { text: r.text, pos: r.pos, stoppedBy: r.stoppedBy };
}

/** Processes one `#directive` (or plain `#comment`) starting at `pos` (which points at the `#`). */
function processDirective(
  src: string,
  pos: number,
  ctx: Ctx,
  active: boolean,
  stopAtElseOrEndif: boolean,
): { text: string; pos: number; stoppedBy: StoppedBy } {
  const afterHash = pos + 1;
  const { word: command, pos: afterCommand } = readWord(src, afterHash);

  if (command === 'define') {
    let p = skipSpacesTabs(src, afterCommand);
    const line = restOfLine(src, p);
    const items = line.text.split(/\s+/).filter((s) => s.length > 0);
    if (items.length === 0) fail(src, p, 'No macro name found after #define directive');
    const name = items[0] as string;
    const params = items.slice(1);
    p = line.pos < src.length ? line.pos + 1 : line.pos; // skip the newline

    const { body, optionalParams, pos: afterDefine } = readDefineBody(src, p);

    if (active) {
      ctx.defines.set(name, {
        name,
        params,
        optionalParams,
        body,
        dir: ctx.dir,
        location: `${ctx.currentFile}:${lineAt(src, pos)}`,
      });
    }
    return { text: '', pos: afterDefine, stoppedBy: null };
  }

  if (command === 'ifdef' || command === 'ifndef') {
    const negate = command === 'ifndef';
    let p = skipSpacesTabs(src, afterCommand);
    const { word: symbol, pos: afterSym } = readWord(src, p);
    if (!symbol) fail(src, p, 'No macro argument found after #ifdef/#ifndef directive');
    p = skipToEol(src, afterSym);
    const found = ctx.defines.has(symbol);
    const takeIf = negate ? !found : found;
    return finishConditional(src, p, ctx, active, takeIf);
  }

  if (command === 'ifhave' || command === 'ifnhave') {
    const negate = command === 'ifnhave';
    let p = skipSpacesTabs(src, afterCommand);
    const { word: symbol, pos: afterSym } = readWord(src, p);
    if (!symbol) fail(src, p, 'No path argument found after #ifhave/#ifnhave directive');
    p = skipToEol(src, afterSym);
    const found = active ? resolveIncludePath(symbol, ctx.dir, ctx) !== undefined : false;
    const takeIf = negate ? !found : found;
    return finishConditional(src, p, ctx, active, takeIf);
  }

  if (command === 'ifver' || command === 'ifnver') {
    const negate = command === 'ifnver';
    let p = skipSpacesTabs(src, afterCommand);
    const symRead = readWord(src, p);
    p = skipSpacesTabs(src, symRead.pos);
    const opRead = readWord(src, p);
    p = skipSpacesTabs(src, opRead.pos);
    const verRead = readWord(src, p);
    p = skipToEol(src, verRead.pos);

    let takeIf: boolean;
    if (!active) {
      takeIf = false;
    } else {
      const macro = ctx.defines.get(symRead.word);
      if (!macro) fail(src, p, `Undefined macro in #ifver/#ifnver first argument: '${symRead.word}'`);
      const found = compareVersions(macro.body.trim(), opRead.word, verRead.word);
      takeIf = negate ? !found : found;
    }
    return finishConditional(src, p, ctx, active, takeIf);
  }

  // NOTE: every branch below consumes an entire source line (up to and
  // including its newline, via skipToEol) but must produce a `text: '\n'`,
  // not `text: ''`, in its place. We don't track #line-style source
  // positions the way upstream's streambuf does (see module doc comment),
  // so the newline the directive line occupied has to survive into the
  // flat expanded output itself, or the line before and the line after
  // silently concatenate into one -- exactly what happened before this was
  // fixed: `key=value # trailing comment\nnext_key=...` collapsed into
  // `key=value     next_key=...`, corrupting real content (data/core/
  // terrain.cfg's `string=Exos # comment` / `aliasof=...` pair, caught by
  // GameBoard's real-content integration test).

  if (command === 'else' || command === 'endif') {
    if (!stopAtElseOrEndif) fail(src, pos, `Unexpected #${command}`);
    const p = skipToEol(src, afterCommand);
    return { text: '\n', pos: p, stoppedBy: command };
  }

  if (command === 'textdomain') {
    const p1 = skipSpacesTabs(src, afterCommand);
    const { word: domain, pos: afterWord } = readWord(src, p1);
    if (domain) ctx.domain.value = domain;
    return { text: '\n', pos: skipToEol(src, afterWord), stoppedBy: null };
  }

  if (command === 'enddef') {
    fail(src, pos, 'Unexpected #enddef');
  }

  if (command === 'undef') {
    const p = skipSpacesTabs(src, afterCommand);
    const { word: symbol, pos: afterSym } = readWord(src, p);
    if (active) ctx.defines.delete(symbol);
    return { text: '\n', pos: skipToEol(src, afterSym), stoppedBy: null };
  }

  if (command === 'error') {
    const p = skipSpacesTabs(src, afterCommand);
    const { text: msg, pos: afterMsg } = restOfLine(src, p);
    if (active) fail(src, pos, `#error: "${msg}"`);
    return { text: '\n', pos: skipToEol(src, afterMsg), stoppedBy: null };
  }

  if (command === 'warning') {
    const p = skipSpacesTabs(src, afterCommand);
    const { text: msg, pos: afterMsg } = restOfLine(src, p);
    if (active) {
      // eslint-disable-next-line no-console
      console.warn(`WML #warning: ${msg} (line ${lineAt(src, pos)})`);
    }
    return { text: '\n', pos: skipToEol(src, afterMsg), stoppedBy: null };
  }

  if (command === 'deprecated') {
    // Top-level "this file is deprecated" notice -- recognized and discarded, see module doc.
    return { text: '\n', pos: skipToEol(src, afterCommand), stoppedBy: null };
  }

  // Unrecognized `#word`: an ordinary comment line.
  return { text: '\n', pos: skipToEol(src, afterCommand), stoppedBy: null };
}

function finishConditional(
  src: string,
  pos: number,
  ctx: Ctx,
  active: boolean,
  takeIf: boolean,
): { text: string; pos: number; stoppedBy: StoppedBy } {
  const ifBranch = scanConditionalBranch(src, pos, ctx, active && takeIf);
  if (ifBranch.stoppedBy === 'endif') {
    return { text: ifBranch.text, pos: ifBranch.pos, stoppedBy: null };
  }
  // Hit our own #else: scan (and possibly discard) the else-branch.
  const elseBranch = scanConditionalBranch(src, ifBranch.pos, ctx, active && !takeIf);
  if (elseBranch.stoppedBy !== 'endif') {
    fail(src, elseBranch.pos, 'Unexpected second #else');
  }
  return { text: takeIf ? ifBranch.text : elseBranch.text, pos: elseBranch.pos, stoppedBy: null };
}

// ---------------------------------------------------------------------------
// Top-level scanning loop, shared by whole-file scans and conditional-branch scans.
// ---------------------------------------------------------------------------

function expandText(
  src: string,
  startPos: number,
  ctx: Ctx,
  active: boolean,
  stopAtElseOrEndif: boolean,
): { text: string; pos: number; stoppedBy: StoppedBy } {
  let out = '';
  let pos = startPos;

  while (pos < src.length) {
    const c = src.charAt(pos);

    if (c === '#') {
      const r = processDirective(src, pos, ctx, active, stopAtElseOrEndif);
      if (r.stoppedBy) return { text: out, pos: r.pos, stoppedBy: r.stoppedBy };
      out += r.text;
      pos = r.pos;
      continue;
    }
    if (c === '<' && src.charAt(pos + 1) === '<') {
      const r = readVerbatim(src, pos);
      if (active) out += r.text;
      pos = r.pos;
      continue;
    }
    if (c === '"') {
      const r = readQuoted(src, pos, ctx, active);
      if (active) out += r.text;
      pos = r.pos;
      continue;
    }
    if (c === '{') {
      const r = readBraceExpr(src, pos + 1, ctx, active);
      if (active) out += r.text;
      pos = r.pos;
      continue;
    }
    if (active) out += c;
    pos++;
  }

  if (stopAtElseOrEndif) fail(src, pos, '#ifdef or #ifndef not terminated');
  return { text: out, pos, stoppedBy: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function preprocess(source: string, opts: PreprocessOptions): PreprocessResult {
  const defines = opts.defines ?? new Map<string, MacroDefinition>();
  const domain = { value: opts.initialTextdomain ?? 'wesnoth' };
  const ctx: Ctx = {
    dir: opts.dir,
    currentFile: opts.currentFile ?? '<string>',
    defines,
    localArgs: undefined,
    depth: 0,
    host: opts.host ?? makeNodeHost(),
    dataRoot: opts.dataRoot,
    domain,
  };
  const r = expandText(source, 0, ctx, true, false);
  return { text: r.text, defines, textdomain: domain.value };
}

export function preprocessFile(filePath: string, opts: Omit<PreprocessOptions, 'dir' | 'currentFile'> = {}): PreprocessResult {
  const host = opts.host ?? makeNodeHost();
  const text = host.readFile(filePath);
  return preprocess(text, { ...opts, dir: host.dirname(filePath), currentFile: filePath, host });
}

/** Preprocesses a file purely to populate `defines` (e.g. preloading `core/macros/`); discards output text. */
export function preloadDefines(filePath: string, defines: DefineMap, opts: Omit<PreprocessOptions, 'dir' | 'currentFile' | 'defines'> = {}): void {
  preprocessFile(filePath, { ...opts, defines });
}

/** Like `preloadDefines`, but for an entire directory of `.cfg` files (non-recursive; see module doc). */
export function preloadDefinesFromDir(dirPath: string, defines: DefineMap, opts: Omit<PreprocessOptions, 'dir' | 'currentFile' | 'defines'> = {}): void {
  const host = opts.host ?? makeNodeHost();
  const ctx: Ctx = {
    dir: dirPath,
    currentFile: dirPath,
    defines,
    depth: 0,
    host,
    dataRoot: opts.dataRoot,
    domain: { value: opts.initialTextdomain ?? 'wesnoth' },
  };
  for (const f of listCfgFilesInDir(dirPath, ctx)) {
    preloadDefines(f, defines, opts);
  }
}
