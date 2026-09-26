/**
 * TS port of upstream Wesnoth's WML variable store (`src/variable.hpp/.cpp`,
 * `src/variable_info.hpp/.cpp`, `src/game_data.cpp`'s `get_variable`/
 * `set_variable`, and the `$var` interpolation half of
 * `src/formula/string_utils.cpp`'s `do_interpolation`).
 *
 * ## Storage model
 *
 * Upstream stores all WML variables in a single `config` tree (`game_data::
 * variables_`, mirroring a scenario's `[variables]` child): a scalar
 * variable is a plain attribute; an *array* variable `foo` is a same-named
 * repeated child list (`$foo[2].bar` navigates into the 3rd child tagged
 * `foo`, then reads its `bar` attribute); `$foo.length` is a read-only
 * pseudo-attribute counting `foo`'s children.
 *
 * `WmlConfig` (the shared parse-tree type, `src/wml/config.ts`) is
 * append-only -- it has no way to remove or replace a child once added,
 * which upstream's mutable `config` supports freely and which WML actions
 * like `[set_variables] mode=replace` and `[clear_variable]` need. Rather
 * than extend `WmlConfig` (out of this port's scope -- owned by the WML
 * pipeline, not `events/`), variables are stored in a private, fully
 * mutable `VarNode` tree with the identical shape (attributes + named
 * child-lists), and only converted to/from `WmlConfig` at the boundary
 * (loading a scenario's `[variables]`, or handing a container out to code
 * that wants a `WmlConfig` view, e.g. `[store_unit]`'s per-entry output).
 *
 * ## What's ported vs. simplified
 *
 * - Dotted/bracketed path navigation (`foo.bar`, `foo[2].bar`, negative
 *   indices, `.length`) mirrors `variable_info`'s state machine
 *   (`calculate_value`) faithfully enough for real content: every array
 *   access in `data/campaigns/Dead_Water/scenarios/01_Invasion.cfg`
 *   (`zombie_number_pattern[N].number`-style paths via macros) round-trips
 *   correctly, see `test/events/variables.test.ts`.
 * - `$var` string interpolation (`substitute`) ports `do_interpolation`'s
 *   right-to-left rescan (so `$creatures[$i].name` resolves the inner `$i`
 *   first) and its `$var?default|` / `$|` / bare-`$` edge cases in
 *   simplified form -- close enough for real message text, not a
 *   character-for-character port of the C++ state machine.
 * - `$(...)` formula substitution is NOT implemented (left untouched in the
 *   output string) -- wiring the WFL interpreter (`packages/engine/src/
 *   formula/`) through here is a reasonable follow-up (see filter.ts for
 *   the one place this port *does* wire WFL in, for `formula=` unit
 *   filters) but wasn't needed by any real content exercised so far.
 */

import { parseFormula } from '../formula/index.js';
import { TString } from '../i18n/tstring.js';
import { WmlConfig, plainValue, type WmlAttributeValue, type WmlStoredValue } from '../wml/config.js';

/** A mutable, freely-replaceable analogue of `WmlConfig`'s (attrs, named child-lists) shape. */
export interface VarNode {
  attrs: Map<string, WmlStoredValue>;
  arrays: Map<string, VarNode[]>;
}

export function newVarNode(): VarNode {
  return { attrs: new Map(), arrays: new Map() };
}

/** Builds a `VarNode` from a parsed `WmlConfig` (e.g. a scenario's `[variables]` child). */
export function varNodeFromConfig(cfg: WmlConfig): VarNode {
  const node = newVarNode();
  for (const name of cfg.attributeNames()) {
    node.attrs.set(name, cfg.getRaw(name)!);
  }
  for (const { tag, config } of cfg.allChildren()) {
    let arr = node.arrays.get(tag);
    if (!arr) {
      arr = [];
      node.arrays.set(tag, arr);
    }
    arr.push(varNodeFromConfig(config));
  }
  return node;
}

/** Inverse of `varNodeFromConfig`: builds a fresh `WmlConfig` snapshot (e.g. for `[store_unit]` output). */
export function varNodeToConfig(node: VarNode): WmlConfig {
  const cfg = new WmlConfig();
  for (const [key, value] of node.attrs) {
    cfg.setAttribute(key, value);
  }
  for (const [tag, arr] of node.arrays) {
    for (const item of arr) {
      cfg.addChild(tag, varNodeToConfig(item));
    }
  }
  return cfg;
}

type PathSeg = { kind: 'key'; name: string } | { kind: 'index'; index: number };

/**
 * Tokenizes a variable path like `foo[2].bar` into `[{key:"foo"},
 * {index:2}, {key:"bar"}]`, mirroring `variable_info::calculate_value`'s
 * treatment of both `.` and `[` as key terminators.
 */
function parsePath(path: string): PathSeg[] {
  const segs: PathSeg[] = [];
  const re = /([^.[\]]+)|\[(-?\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) segs.push({ kind: 'key', name: m[1] });
    else segs.push({ kind: 'index', index: Number(m[2]) });
  }
  return segs;
}

/**
 * The WML variable store for one game/scenario context. Mirrors `game_data`'s
 * variable-access surface (`get_variable`/`get_variable_const`/
 * `get_variable_cfg`/`set_variable`), minus the auto-store-on-scope-exit
 * (`scoped_wml_variable`) and recall-list-backed (`scoped_recall_unit`)
 * variants, which are event-pump plumbing rather than storage concerns and
 * aren't ported here.
 */
export class VariableStore {
  constructor(private root: VarNode = newVarNode()) {}

  /** Loads a scenario's `[variables]` child (or starts empty if absent). */
  static fromScenario(scenarioCfg: WmlConfig | undefined): VariableStore {
    const varsCfg = scenarioCfg?.child('variables');
    return new VariableStore(varsCfg ? varNodeFromConfig(varsCfg) : newVarNode());
  }

  // --- low-level navigation ---

  private resolveIndex(node: VarNode, key: string, rawIndex: number): number {
    if (rawIndex >= 0) return rawIndex;
    const count = node.arrays.get(key)?.length ?? 0;
    return count + rawIndex;
  }

  private childAt(node: VarNode, key: string, index: number, create: boolean): VarNode | undefined {
    let arr = node.arrays.get(key);
    if (!arr) {
      if (!create) return undefined;
      arr = [];
      node.arrays.set(key, arr);
    }
    if (index < 0) return undefined;
    if (index >= arr.length) {
      if (!create) return undefined;
      while (arr.length <= index) arr.push(newVarNode());
    }
    return arr[index];
  }

  /** Resolves everything but the final key, matching `variable_info`'s (child_, key_) pair used by `as_scalar`. */
  private locate(path: string, create: boolean): { node: VarNode; key: string } | undefined {
    const segs = parsePath(path);
    if (segs.length === 0) return undefined;
    let node = this.root;
    let i = 0;
    while (i < segs.length) {
      const seg = segs[i]!;
      if (seg.kind !== 'key') return undefined; // malformed: index with no preceding key
      const key = seg.name;
      const next = segs[i + 1];
      const isLast = i === segs.length - 1;
      if (next && next.kind === 'index') {
        const idx = this.resolveIndex(node, key, next.index);
        const child = this.childAt(node, key, idx, create);
        if (!child) return undefined;
        node = child;
        i += 2;
      } else if (isLast) {
        return { node, key };
      } else {
        // Implicit array access: "foo.bar" descends into foo's *first* element (index 0),
        // matching get_variable_key_visitor::from_named's do_from_config(get_child_at(...,0)).
        const child = this.childAt(node, key, 0, create);
        if (!child) return undefined;
        node = child;
        i += 1;
      }
    }
    return undefined;
  }

  /** Resolves the full path AS a container (an array element or the implicit-index-0 child), e.g. for `[store_unit]`'s `variable=`. */
  getContainerNode(path: string, create = false): VarNode | undefined {
    const segs = parsePath(path);
    let node = this.root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      if (seg.kind !== 'key') return undefined;
      const key = seg.name;
      const next = segs[i + 1];
      if (next && next.kind === 'index') {
        const idx = this.resolveIndex(node, key, next.index);
        const child = this.childAt(node, key, idx, create);
        if (!child) return undefined;
        node = child;
        i++;
      } else {
        const child = this.childAt(node, key, 0, create);
        if (!child) return undefined;
        node = child;
      }
    }
    return node;
  }

  // --- scalar access ---

  get(path: string): WmlAttributeValue | undefined {
    const raw = this.getRaw(path);
    return raw === undefined ? undefined : plainValue(raw);
  }

  /**
   * The stored value untouched: a `_ "..."` value stays a `TString`, as
   * upstream's variables keep their `t_string`, so it follows a language
   * switch until something interpolates or stringifies it.
   */
  getRaw(path: string): WmlStoredValue | undefined {
    if (path.length > '.length'.length && path.endsWith('.length')) {
      return this.arrayLength(path.slice(0, -'.length'.length));
    }
    const loc = this.locate(path, false);
    if (!loc) return undefined;
    return loc.node.attrs.get(loc.key);
  }

  getString(path: string, fallback = ''): string {
    const v = this.get(path);
    return v === undefined ? fallback : String(v);
  }

  getNumber(path: string, fallback = 0): number {
    const v = this.get(path);
    if (v === undefined) return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isNaN(n) ? fallback : n;
  }

  getBoolean(path: string, fallback = false): boolean {
    const v = this.get(path);
    if (v === undefined) return fallback;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return v === 'yes' || v === 'true' || v === '1';
  }

  set(path: string, value: WmlStoredValue): void {
    const loc = this.locate(path, true);
    if (!loc) return;
    loc.node.attrs.set(loc.key, value);
  }

  /** Mirrors `[clear_variable]`: drops both the scalar attribute and any same-named array at this path. */
  clear(path: string): void {
    const loc = this.locate(path, false);
    if (!loc) return;
    loc.node.attrs.delete(loc.key);
    loc.node.arrays.delete(loc.key);
  }

  // --- array access ---

  arrayLength(path: string): number {
    const loc = this.locate(path, false);
    if (!loc) return 0;
    return loc.node.arrays.get(loc.key)?.length ?? 0;
  }

  getArray(path: string): VarNode[] {
    const loc = this.locate(path, false);
    if (!loc) return [];
    return loc.node.arrays.get(loc.key) ?? [];
  }

  /** `[set_variables] mode=replace`-style full replacement. */
  setArray(path: string, nodes: VarNode[]): void {
    const loc = this.locate(path, true);
    if (!loc) return;
    loc.node.arrays.set(loc.key, nodes);
  }

  pushArray(path: string, node: VarNode): void {
    const loc = this.locate(path, true);
    if (!loc) return;
    let arr = loc.node.arrays.get(loc.key);
    if (!arr) {
      arr = [];
      loc.node.arrays.set(loc.key, arr);
    }
    arr.push(node);
  }

  // --- WmlConfig interop ---

  /** The whole store's root, as a fresh `WmlConfig` snapshot (mirrors `[variables]`'s own shape). */
  toConfig(): WmlConfig {
    return varNodeToConfig(this.root);
  }

  /**
   * Replaces every variable with `cfg`'s contents -- the read side of
   * `toConfig()`. Used to carry a scenario's variables into the next one
   * and to restore them from a save (Phase 17), mirroring upstream's own
   * `[variables]` block in a saved game.
   */
  replaceAll(cfg: WmlConfig): void {
    this.root = varNodeFromConfig(cfg);
  }

  /** Reads the container at `path` (see `getContainerNode`) as a fresh `WmlConfig` snapshot. */
  getConfig(path: string): WmlConfig | undefined {
    const node = this.getContainerNode(path, false);
    return node ? varNodeToConfig(node) : undefined;
  }

  /** Overwrites the container at `path` with `cfg`'s contents (creating it if needed). */
  setConfig(path: string, cfg: WmlConfig): void {
    const node = this.getContainerNode(path, true);
    if (!node) return;
    const fresh = varNodeFromConfig(cfg);
    node.attrs = fresh.attrs;
    node.arrays = fresh.arrays;
  }

  // --- $var interpolation ---

  /**
   * Substitutes `$var`/`$var[n].field`/`$var?default|`/`$|` occurrences in
   * `text` with their current values, scanning right-to-left so nested
   * references (`$arr[$i].name`) resolve the inner variable first --
   * mirrors `utils::do_interpolation` (`src/formula/string_utils.cpp`) in
   * simplified form (no `$(...)` formula substitution -- see module doc
   * comment).
   */
  /** Where a `$( ... )` formula error is reported (upstream logs and substitutes nothing). */
  onFormulaError?: (message: string) => void;

  substitute(text: string): string {
    let res = text;
    let searchFrom = res.length;
    while (searchFrom >= 0) {
      const dollarIdx = res.lastIndexOf('$', searchFrom);
      if (dollarIdx === -1) break;
      searchFrom = dollarIdx - 1;

      const nameStart = dollarIdx + 1;
      if (nameStart >= res.length) continue; // trailing '$' with nothing after it

      if (res[nameStart] === '(') {
        // $( ... ) evaluates a WFL formula (`do_interpolation`): the extent is
        // found by paren nesting, ignoring parens inside 'strings' and #comments#.
        // Anything inside was already substituted (this loop runs back to front),
        // so "$($count % 5)" arrives here as "$(3 % 5)".
        let depth = 0;
        let inString = false;
        let inComment = false;
        let end = nameStart;
        do {
          const c = res[end];
          if (c === '(' && !inString && !inComment) depth++;
          else if (c === ')' && !inString && !inComment) depth--;
          else if (c === '#' && !inString) inComment = !inComment;
          else if (c === "'" && !inComment) inString = !inString;
          end++;
        } while (end < res.length && depth > 0);
        let replacement = '';
        if (depth > 0) {
          this.onFormulaError?.(`Formula in WML string cannot be evaluated due to a missing closing parenthesis: "${res.slice(dollarIdx, end)}"`);
        } else {
          try {
            replacement = parseFormula(res.slice(nameStart + 1, end - 1)).evaluate().stringCast();
          } catch (e) {
            this.onFormulaError?.(`Formula error in "${res.slice(dollarIdx, end)}": ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        res = res.slice(0, dollarIdx) + replacement + res.slice(end);
        continue;
      }

      // Scan the variable name: letters/digits/underscore/dot, with balanced [...] allowed.
      let i = nameStart;
      let depth = 0;
      for (; i < res.length; i++) {
        const c = res[i]!;
        if (c === '[') {
          depth++;
          continue;
        }
        if (c === ']') {
          if (depth === 0) break;
          depth--;
          continue;
        }
        if (depth > 0) continue;
        if (c === '.' || c === '_' || (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
          continue;
        }
        break;
      }
      let nameEnd = i;

      // "$var?default|" fallback syntax, terminated by '|' or end of string.
      if (res[nameEnd] === '?') {
        let j = nameEnd + 1;
        while (j < res.length && res[j] !== '|') j++;
        const fallback = res.slice(nameEnd + 1, j);
        const consumeEnd = j < res.length ? j + 1 : j;
        const varName = res.slice(nameStart, nameEnd);
        const val = varName === '' ? undefined : this.get(varName);
        const replacement = val === undefined || val === '' ? fallback : String(val);
        res = res.slice(0, dollarIdx) + replacement + res.slice(consumeEnd);
        continue;
      }

      // A trailing '.' isn't part of the name unless it immediately follows a ']'
      // (so "$score." reads as "$score" + ".", but "$arr[$i]." keeps the dot as a separator).
      if (nameEnd > nameStart && res[nameEnd - 1] === '.' && res[nameEnd - 2] !== ']') {
        nameEnd -= 1;
      }

      let consumeEnd = nameEnd;
      if (res[consumeEnd] === '|') consumeEnd += 1; // explicit terminator, consumed but not part of the name

      const varName = res.slice(nameStart, nameEnd);
      if (varName === '') {
        // "$|" (or a lone unresolvable '$') is how WML escapes a literal '$'.
        res = res.slice(0, dollarIdx) + '$' + res.slice(consumeEnd);
        continue;
      }

      const val = this.get(varName);
      res = res.slice(0, dollarIdx) + (val === undefined ? '' : String(val)) + res.slice(consumeEnd);
    }
    return res;
  }

  /**
   * Shallow `$var`-substitution of `cfg`'s own attributes into a fresh
   * `WmlConfig` -- children are kept as-is (raw references), matching
   * upstream `vconfig`'s laziness: nested action bodies (e.g. `[if]`'s
   * `[then]`) must NOT be expanded upfront, since earlier actions in the
   * same sequence can change the variables later ones depend on. Callers
   * that consume a nested child directly (not through `runActionSequence`)
   * should call this again on that child at the point they read it.
   */
  expandConfig(cfg: WmlConfig): WmlConfig {
    const out = new WmlConfig();
    for (const name of cfg.attributeNames()) {
      const raw = cfg.getRaw(name)!;
      if (raw instanceof TString) {
        // `interpolate_variables_into_tstring`: translate, substitute, and keep the
        // TString only when substitution changed nothing.
        const text = raw.str();
        const expanded = this.substitute(text);
        out.setAttribute(name, expanded === text ? raw : expanded);
      } else {
        out.setAttribute(name, typeof raw === 'string' ? this.substitute(raw) : raw);
      }
    }
    for (const { tag, config } of cfg.allChildren()) {
      out.addChild(tag, config);
    }
    return out;
  }

  /** `wml.parsed`: `expandConfig` applied through every nested child too -- for WML stored now and run later (`[on_undo]`). `[insert_tag]`s are resolved. */
  expandConfigDeep(cfg: WmlConfig): WmlConfig {
    const out = new WmlConfig();
    for (const name of cfg.attributeNames()) {
      const raw = cfg.getRaw(name)!;
      if (raw instanceof TString) {
        // `interpolate_variables_into_tstring`: translate, substitute, and keep the
        // TString only when substitution changed nothing.
        const text = raw.str();
        const expanded = this.substitute(text);
        out.setAttribute(name, expanded === text ? raw : expanded);
      } else {
        out.setAttribute(name, typeof raw === 'string' ? this.substitute(raw) : raw);
      }
    }
    for (const { tag, config } of this.childrenWithInserts(cfg)) {
      out.addChild(tag, this.expandConfigDeep(config));
    }
    return out;
  }

  /**
   * `cfg`'s children as `vconfig` iterates them: an `[insert_tag] name=
   * variable=` stands for one `[name]` per element of the variable (the
   * element's contents), or one empty `[name]` if it has none
   * (`as_nonempty_range`).
   */
  childrenWithInserts(cfg: WmlConfig): Array<{ tag: string; config: WmlConfig }> {
    const out: Array<{ tag: string; config: WmlConfig }> = [];
    for (const child of cfg.allChildren()) {
      if (child.tag !== 'insert_tag') {
        out.push(child);
        continue;
      }
      const name = this.substitute(child.config.getString('name', ''));
      const variable = this.substitute(child.config.getString('variable', ''));
      const n = this.arrayLength(variable);
      if (n === 0) out.push({ tag: name, config: new WmlConfig() });
      for (let i = 0; i < n; i++) out.push({ tag: name, config: this.getConfig(`${variable}[${i}]`) ?? new WmlConfig() });
    }
    return out;
  }
}
