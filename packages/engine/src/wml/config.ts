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

export type WmlAttributeValue = string | number | boolean;

interface ChildEntry {
  tag: string;
  config: WmlConfig;
}

export class WmlConfig {
  private attrs = new Map<string, WmlAttributeValue>();
  private childEntries: ChildEntry[] = [];

  // --- attributes ---

  get(key: string): WmlAttributeValue | undefined {
    return this.attrs.get(key);
  }

  getString(key: string, fallback = ''): string {
    const v = this.attrs.get(key);
    return v === undefined ? fallback : String(v);
  }

  getNumber(key: string, fallback = 0): number {
    const v = this.attrs.get(key);
    if (v === undefined) return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isNaN(n) ? fallback : n;
  }

  getBoolean(key: string, fallback = false): boolean {
    const v = this.attrs.get(key);
    if (v === undefined) return fallback;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return v === 'yes' || v === 'true' || v === '1';
  }

  hasAttribute(key: string): boolean {
    return this.attrs.has(key);
  }

  setAttribute(key: string, value: WmlAttributeValue): this {
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

  childCount(tag?: string): number {
    return tag === undefined
      ? this.childEntries.length
      : this.childEntries.filter((e) => e.tag === tag).length;
  }
}
