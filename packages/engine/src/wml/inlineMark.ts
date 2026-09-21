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
