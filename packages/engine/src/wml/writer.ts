/**
 * TS port of upstream's WML *writer* (`serialization/parser.cpp`'s
 * `write`/`write_key_val`/`write_open_child`/`write_close_child`,
 * ~L500-599 and ~L677-746): turns a `WmlConfig` back into the WML text
 * upstream itself writes.
 *
 * The counterpart to `parser.ts`, and the piece Phase 26 needs: a real
 * Wesnoth save file is nothing more exotic than this text, gzipped
 * (`binary_or_text.cpp`'s `config_writer` pushes a gzip filter in front
 * of exactly this output -- there is no binary save format).
 *
 * Format, matching upstream byte for byte where it matters:
 *  - one **tab** per nesting level, `[tag]` / `[/tag]` at the parent's level;
 *  - a node's attributes first, then its children, each in insertion order
 *    (upstream's `config` does the same -- document order is preserved
 *    within attributes and within children, but not interleaved between);
 *  - booleans as `yes`/`no`, numbers bare, everything else quoted with
 *    embedded `"` **doubled** (`utils::wml_escape_string`), newlines kept
 *    verbatim inside the quotes (that is how real `map_data=` is written).
 *
 * Translatable values (`TString`) are written the way upstream writes them:
 * a `#textdomain NAME` line whenever the domain changes, then `_ "msgid"`,
 * with the parts of a concatenation joined by ` +` and a line break, so
 * the parser reads back the same parts with the same domains.
 *
 * Round-tripping: compare `parse(write(parse(text)))` against
 * `parse(text)`, not the raw text. Upstream's own type inference
 * (`inferAttributeValue`, mirroring `config_attribute_value`) coerces
 * `yes`/`no` and numeric-looking values regardless of quoting, so the
 * *tree* round-trips exactly while the text need not be identical.
 */

import { TString } from '../i18n/tstring.js';
import { WmlConfig, type WmlStoredValue } from './config.js';

/** Mirrors `utils::wml_escape_string` (`string_utils.hpp`): `"` is escaped by doubling it, nothing else is. */
function escapeWmlString(value: string): string {
  return value.replace(/"/g, '""');
}

/** Mirrors `write_key_val`'s type dispatch: bare for bools/numbers, quoted-and-escaped for strings. */
function formatScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  return `"${escapeWmlString(value)}"`;
}

interface WriterState {
  out: string[];
  /** The `#textdomain` in effect where the next line is written; a fresh parse starts in `wesnoth`. */
  domain: string;
}

function writeTString(st: WriterState, indent: string, key: string, value: TString): void {
  let line = `${indent}${key}=`;
  const pieces: string[] = [];
  for (const part of value.parts) {
    if (typeof part === 'string') {
      pieces.push(`"${escapeWmlString(part)}"`);
    } else {
      const switchLine = part.domain !== st.domain ? `#textdomain ${part.domain}\n` : '';
      st.domain = part.domain;
      pieces.push(`${switchLine}_ "${escapeWmlString(part.msgid)}"`);
    }
  }
  // A `#textdomain` line has to start a line, and must not fall inside the first piece's own line.
  const first = pieces[0] as string;
  if (first.startsWith('#textdomain')) {
    const nl = first.indexOf('\n');
    st.out.push(`${first.slice(0, nl + 1)}${line}${first.slice(nl + 1)}`);
  } else {
    st.out.push(`${line}${first}`);
  }
  for (let i = 1; i < pieces.length; i++) st.out.push(` +\n${pieces[i]}`);
  st.out.push('\n');
}

function writeValue(st: WriterState, indent: string, key: string, value: WmlStoredValue): void {
  if (value instanceof TString) {
    if (value.isInterpolated) {
      st.out.push(`${indent}${key}=${formatScalar(value.str())}\n`);
    } else if (value.translatable) {
      writeTString(st, indent, key, value);
    } else {
      st.out.push(`${indent}${key}=${formatScalar(value.baseStr())}\n`);
    }
  } else {
    st.out.push(`${indent}${key}=${formatScalar(value)}\n`);
  }
}

function writeInto(st: WriterState, cfg: WmlConfig, level: number): void {
  const indent = '\t'.repeat(level);
  for (const key of cfg.attributeNames()) {
    writeValue(st, indent, key, cfg.getRaw(key) as WmlStoredValue);
  }
  for (const { tag, config } of cfg.allChildren()) {
    st.out.push(`${indent}[${tag}]\n`);
    writeInto(st, config, level + 1);
    st.out.push(`${indent}[/${tag}]\n`);
  }
}

/**
 * Serializes `cfg` as WML text. The result is the *contents* of a node,
 * so a top-level config writes its attributes and `[tag]` blocks with no
 * wrapper -- which is exactly the shape of a save file, whose root
 * attributes (`version=`, `campaign=`, ...) sit at file level next to
 * `[snapshot]`/`[replay]` and friends.
 */
export function writeWml(cfg: WmlConfig): string {
  const st: WriterState = { out: [], domain: 'wesnoth' };
  writeInto(st, cfg, 0);
  return st.out.join('');
}
