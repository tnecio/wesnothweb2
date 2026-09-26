/**
 * TS port of upstream Wesnoth's `config` (src/config.hpp/.cpp): the in-memory
 * tree that WML parses into. A node has ordered attributes and an ordered
 * list of (tag, child) pairs -- WML preserves document order across
 * differently-named sibling tags, and repeated tags (e.g. multiple [side])
 * are common, so children are NOT a Record<tag, Config[]>.
 *
 * This is the shared contract between the WML pipeline (tokenizer ->
 * preprocessor -> parser, which produces WmlConfig) and everything that
 * consumes parsed WML (the data model, WFL, the event pump, Lua bridge).
 * API shape deliberately mirrors config.hpp's (get/hasAttribute/child/
 * childRange/addChild) so later C++-to-TS porting reads similarly.
 */

import { TString, isTStringJson, type TStringJson } from '../i18n/tstring.js';

export type WmlAttributeValue = string | number | boolean;

/**
 * What an attribute actually stores: a scalar, or a `TString` when the WML
 * wrote it as `_ "..."`. Readers that want text use `get()`/`getString()`,
 * which translate (upstream's `config_attribute_value` converts the same
 * way); readers that must keep the value translatable across a language
 * switch use `getTString()`.
 */
export type WmlStoredValue = WmlAttributeValue | TString;

/** Translated text for a value read straight from `WmlConfigJson.attrs`; scalars pass through. */
export function plainJsonValue(v: WmlAttributeValue | TStringJson): WmlAttributeValue;
export function plainJsonValue(v: WmlAttributeValue | TStringJson | undefined): WmlAttributeValue | undefined;
export function plainJsonValue(v: WmlAttributeValue | TStringJson | undefined): WmlAttributeValue | undefined {
  return isTStringJson(v) ? TString.fromJSON(v).str() : v;
}

/** Translated text for a stored value; scalars pass through. */
export function plainValue(v: WmlStoredValue): WmlAttributeValue {
  return v instanceof TString ? v.str() : v;
}

interface ChildEntry {
  tag: string;
  config: WmlConfig;
}

export class WmlConfig {
  private attrs = new Map<string, WmlStoredValue>();
  private childEntries: ChildEntry[] = [];

  // --- attributes ---

  /** The value as plain data; a translatable string is returned translated. */
  get(key: string): WmlAttributeValue | undefined {
    const v = this.attrs.get(key);
    return v === undefined ? undefined : plainValue(v);
  }

  /** The stored value untouched, `TString` included. */
  getRaw(key: string): WmlStoredValue | undefined {
    return this.attrs.get(key);
  }

  /** The value as a `TString` (a literal one when the WML did not mark it translatable). */
  getTString(key: string): TString | undefined {
    const v = this.attrs.get(key);
    if (v === undefined) return undefined;
    return v instanceof TString ? v : TString.literal(String(v));
  }

  /** True when the WML wrote this attribute as `_ "..."`. */
  isTranslatable(key: string): boolean {
    const v = this.attrs.get(key);
    return v instanceof TString && v.translatable;
  }

  getString(key: string, fallback = ''): string {
    const v = this.get(key);
    return v === undefined ? fallback : String(v);
  }

  getNumber(key: string, fallback = 0): number {
    const v = this.get(key);
    if (v === undefined) return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isNaN(n) ? fallback : n;
  }

  getBoolean(key: string, fallback = false): boolean {
    const v = this.get(key);
    if (v === undefined) return fallback;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return v === 'yes' || v === 'true' || v === '1';
  }

  hasAttribute(key: string): boolean {
    return this.attrs.has(key);
  }

  setAttribute(key: string, value: WmlStoredValue): this {
    this.attrs.set(key, value);
    return this;
  }

  attributeNames(): string[] {
    return [...this.attrs.keys()];
  }

  // --- children ---

  /** First child with this tag, or undefined. Mirrors config::child(). */
  child(tag: string): WmlConfig | undefined {
    return this.childEntries.find((e) => e.tag === tag)?.config;
  }

  /** All children with this tag, in document order. Mirrors config::child_range(). */
  children(tag: string): WmlConfig[] {
    return this.childEntries.filter((e) => e.tag === tag).map((e) => e.config);
  }

  hasChild(tag: string): boolean {
    return this.childEntries.some((e) => e.tag === tag);
  }

  /** All (tag, child) pairs in original document order, mixing tags. */
  allChildren(): ReadonlyArray<{ tag: string; config: WmlConfig }> {
    return this.childEntries;
  }

  addChild(tag: string, value: WmlConfig = new WmlConfig()): WmlConfig {
    this.childEntries.push({ tag, config: value });
    return value;
  }

  /** Mirrors `config::clear_children(tag)`: drops every child with this tag, keeping attributes and other children. */
  removeChildren(tag: string): void {
    this.childEntries = this.childEntries.filter((e) => e.tag !== tag);
  }

  /**
   * A deep copy, mirroring `config`'s own copy constructor. Needed wherever
   * a config is used as a template that must not be mutated in place -- a
   * scenario's `[side]` blocks becoming a save's live ones, for instance.
   */
  clone(): WmlConfig {
    const copy = new WmlConfig();
    for (const [key, value] of this.attrs) copy.attrs.set(key, value);
    for (const entry of this.childEntries) copy.childEntries.push({ tag: entry.tag, config: entry.config.clone() });
    return copy;
  }

  childCount(tag?: string): number {
    return tag === undefined
      ? this.childEntries.length
      : this.childEntries.filter((e) => e.tag === tag).length;
  }

  // --- JSON (de)serialization ---
  //
  // Lets a WmlConfig subtree (e.g. a scenario's [event] blocks) travel from
  // the build-time snapshot script (Node, full WML pipeline) to the browser
  // (no WML pipeline -- see docs/ARCHITECTURE.md's "content pipeline"
  // section) as plain JSON, then be reconstructed as a real WmlConfig there
  // so the real, tested event pump (packages/engine/src/events/) can run
  // against it unmodified. Deliberately a plain recursive object/array
  // shape (not relying on WmlConfig's own class identity) so it round-trips
  // through JSON.stringify/parse with no custom reviver.

  toJSON(): WmlConfigJson {
    return {
      attrs: Object.fromEntries([...this.attrs].map(([k, v]) => [k, v instanceof TString ? v.toJSON() : v])),
      children: this.childEntries.map((e) => ({ tag: e.tag, config: e.config.toJSON() })),
    };
  }

  static fromJSON(json: WmlConfigJson): WmlConfig {
    const cfg = new WmlConfig();
    for (const [key, value] of Object.entries(json.attrs)) {
      cfg.setAttribute(key, isTStringJson(value) ? TString.fromJSON(value) : value);
    }
    for (const child of json.children) {
      cfg.addChild(child.tag, WmlConfig.fromJSON(child.config));
    }
    return cfg;
  }
}

export interface WmlConfigJson {
  /** A translatable attribute is `{"t": [[domain, msgid] | literal, ...]}`; everything else is a scalar. */
  attrs: Record<string, WmlAttributeValue | TStringJson>;
  children: Array<{ tag: string; config: WmlConfigJson }>;
}
