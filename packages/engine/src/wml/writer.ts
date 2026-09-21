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
 * Deliberate deviation, inherited from `parser.ts`: this project's
 * `WmlConfig` has no translatable-string type (see that module's own
 * "Simplification vs. upstream" note), so a value that upstream would
 * write as `_"text"` preceded by a `#textdomain` line is written here as
 * a plain quoted string. Real Wesnoth reads it back as an untranslated
 * literal with the same characters -- the text displays identically in
 * English and loses only the ability to be re-translated.
 *
 * Round-tripping: compare `parse(write(parse(text)))` against
 * `parse(text)`, not the raw text. Upstream's own type inference
 * (`inferAttributeValue`, mirroring `config_attribute_value`) coerces
 * `yes`/`no` and numeric-looking values regardless of quoting, so the
 * *tree* round-trips exactly while the text need not be identical.
 */

import { WmlConfig, type WmlAttributeValue } from './config.js';

/** Mirrors `utils::wml_escape_string` (`string_utils.hpp`): `"` is escaped by doubling it, nothing else is. */
function escapeWmlString(value: string): string {
  return value.replace(/"/g, '""');
}

/** Mirrors `write_key_val`'s type dispatch: bare for bools/numbers, quoted-and-escaped for strings. */
function formatValue(value: WmlAttributeValue): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  return `"${escapeWmlString(value)}"`;
}

function writeInto(out: string[], cfg: WmlConfig, level: number): void {
  const indent = '\t'.repeat(level);
  for (const key of cfg.attributeNames()) {
    out.push(`${indent}${key}=${formatValue(cfg.get(key)!)}\n`);
  }
  for (const { tag, config } of cfg.allChildren()) {
    out.push(`${indent}[${tag}]\n`);
    writeInto(out, config, level + 1);
    out.push(`${indent}[/${tag}]\n`);
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
  const out: string[] = [];
  writeInto(out, cfg, 0);
  return out.join('');
}
