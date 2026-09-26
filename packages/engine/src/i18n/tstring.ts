/**
 * Port of upstream's `t_string` (`src/tstring.{hpp,cpp}`): a string that
 * remembers which parts of it are translatable and translates them lazily.
 *
 * A value is a list of parts, each a plain literal or a `{domain, msgid}`
 * pair, so `_ "a" + "b"` keeps its untranslatable tail. `str()` translates
 * through the registered catalogues and caches the result against the
 * translation generation, so switching language relocalizes the value the
 * next time it is read -- nothing needs to be rebuilt.
 */

import { dsgettext, translationGeneration } from './gettext.js';

export interface TranslatablePart {
  readonly domain: string;
  readonly msgid: string;
}

export type TStringPart = string | TranslatablePart;

/** JSON form: literals as strings, translatable parts as `[domain, msgid]`. */
export interface TStringJson {
  t: Array<string | [string, string]>;
}

export function isTStringJson(v: unknown): v is TStringJson {
  return typeof v === 'object' && v !== null && Array.isArray((v as { t?: unknown }).t);
}

export class TString {
  private cached = '';
  private cachedGeneration = 0;

  private constructor(readonly parts: readonly TStringPart[]) {}

  static literal(text: string): TString {
    return new TString(text === '' ? [] : [text]);
  }

  static translatable(domain: string, msgid: string): TString {
    return msgid === '' ? new TString([]) : new TString([{ domain, msgid }]);
  }

  /** Builds from parts, merging adjacent literals. */
  static fromParts(parts: Iterable<TStringPart>): TString {
    const merged: TStringPart[] = [];
    for (const p of parts) {
      if (typeof p === 'string') {
        if (p === '') continue;
        const last = merged[merged.length - 1];
        if (typeof last === 'string') merged[merged.length - 1] = last + p;
        else merged.push(p);
      } else if (p.msgid !== '') {
        merged.push(p);
      }
    }
    return new TString(merged);
  }

  get translatable(): boolean {
    return this.parts.some((p) => typeof p !== 'string');
  }

  /** The translated text (`t_string::str()`). */
  str(): string {
    const gen = translationGeneration();
    if (this.cachedGeneration !== gen) {
      let out = '';
      for (const p of this.parts) out += typeof p === 'string' ? p : dsgettext(p.domain, p.msgid);
      this.cached = out;
      this.cachedGeneration = gen;
    }
    return this.cached;
  }

  /** The untranslated text (`t_string::base_str()`). */
  baseStr(): string {
    let out = '';
    for (const p of this.parts) out += typeof p === 'string' ? p : p.msgid;
    return out;
  }

  isEmpty(): boolean {
    return this.parts.length === 0;
  }

  concat(other: TString | string): TString {
    return TString.fromParts([...this.parts, ...(typeof other === 'string' ? [other] : other.parts)]);
  }

  toString(): string {
    return this.str();
  }

  toJSON(): TStringJson {
    return { t: this.parts.map((p) => (typeof p === 'string' ? p : ([p.domain, p.msgid] as [string, string]))) };
  }

  static fromJSON(json: TStringJson): TString {
    return TString.fromParts(json.t.map((p) => (typeof p === 'string' ? p : { domain: p[0], msgid: p[1] })));
  }
}
