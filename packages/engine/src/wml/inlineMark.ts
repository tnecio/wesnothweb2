/**
 * The preprocessor/tokenizer boundary marker, in its own module for one
 * structural reason: `tokenizer.ts` needs it, and everything downstream of
 * the tokenizer (`parser.ts`) must stay free of `node:fs`/`node:path` so
 * the **browser** can parse WML text it already holds -- an uploaded
 * Wesnoth save file, in Phase 26's case. It used to live in
 * `preprocessor.ts`, which reads files and therefore cannot be imported
 * from a browser bundle at all; importing one constant from it dragged
 * the whole Node-only module into the graph.
 *
 * See `preprocessor.ts`'s own doc comment for what the marker is for: it
 * separates macro-expansion output from surrounding text so that, e.g.,
 * an empty macro argument next to a quote does not accidentally form a
 * doubled-quote escape. U+FFFE is a Unicode noncharacter, so it cannot
 * occur in real WML.
 */
export const INLINE_MARK = '￾';

/**
 * Stand-in for upstream's `\376textdomain NAME` lines. The preprocessor
 * emits `DOMAIN_MARK + name + DOMAIN_MARK` wherever the textdomain in effect
 * changes -- entering a macro body, leaving it, entering and leaving an
 * included file, a substituted argument -- so the tokenizer can stamp each
 * `_ "..."` with the domain its author wrote it under. Unlike upstream's
 * marker it is not a line, because macro bodies are spliced mid-line.
 * U+FFFF is a Unicode noncharacter, so it cannot occur in real WML.
 */
export const DOMAIN_MARK = '\uFFFF';

/** Removes every preprocessor marker from `text` (for symbol names built from substituted arguments). */
export function stripMarks(text: string): string {
  return text.replace(/\uFFFF[^\uFFFF]*\uFFFF/g, '').split(INLINE_MARK).join('');
}
