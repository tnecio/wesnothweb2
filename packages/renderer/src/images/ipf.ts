/**
 * Wesnoth Image Path Function (IPF) parsing.
 *
 * The engine ships each image as a path plus a raw modifier string, e.g.
 *   "CROP(0,0,72,72)~MASK(terrain/masks/7hex-tr.png)~O(0.6)"
 *
 * Two things make this less trivial than a split on "~":
 *
 *  - The leading modifier has no "~". The engine's locator stores the chain
 *    without it, so both "CROP(...)" and "~CROP(...)" must parse.
 *  - Arguments nest. A mask reference is itself an image reference with its own
 *    modifier chain: "MASK(terrain/masks/long-convex-tl-l.png~BLIT()~O())".
 *    Splitting naively on "~" or "," corrupts those.
 *
 * So this scans with paren depth tracking rather than splitting.
 *
 * Ported near-verbatim from attempt #1 (wesnothweb/frontend/src/board/images/ipf.ts).
 * This file had no WASM/worker-protocol dependency to begin with.
 */

/** One parsed modifier, e.g. { name: 'CROP', args: ['0','0','72','72'] }. */
export interface IpfOp {
  name: string
  args: string[]
}

/** Split on `sep`, but only at paren depth 0. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

/**
 * Parse a modifier chain into an ordered op list.
 *
 * Unparseable fragments are skipped rather than throwing: a bad modifier should
 * cost one wrong-looking image, not the whole board.
 */
export function parseIpf(mods: string | undefined | null): IpfOp[] {
  if (!mods) return []

  const ops: IpfOp[] = []
  let i = 0

  while (i < mods.length) {
    if (mods[i] === '~') { i++; continue }

    // Op name runs up to '('
    const open = mods.indexOf('(', i)
    if (open === -1) break
    const name = mods.slice(i, open).trim()

    // Find the matching ')' for this '('
    let depth = 0
    let close = -1
    for (let j = open; j < mods.length; j++) {
      if (mods[j] === '(') depth++
      else if (mods[j] === ')') {
        depth--
        if (depth === 0) { close = j; break }
      }
    }
    if (close === -1) break   // unbalanced — ignore the rest

    const inner = mods.slice(open + 1, close)
    if (name) {
      const args = inner.length === 0 ? [] : splitTopLevel(inner, ',').map(a => a.trim())
      ops.push({ name: name.toUpperCase(), args })
    }
    i = close + 1
  }

  return ops
}

/**
 * Split an image reference into its path and modifier chain.
 * "terrain/masks/x.png~BLIT()~O()" → { path, mods }
 */
export function splitRef(ref: string): { path: string; mods: string } {
  const t = ref.indexOf('~')
  return t === -1
    ? { path: ref, mods: '' }
    : { path: ref.slice(0, t), mods: ref.slice(t + 1) }
}

/** Join a path and modifier chain back into the cache key form. */
export function joinRef(path: string, mods: string | undefined | null): string {
  return mods ? `${path}~${mods}` : path
}

/**
 * Parse an alpha argument, which Wesnoth accepts as either a fraction ("0.6")
 * or a percentage ("60%").
 */
export function parseAlpha(arg: string | undefined): number {
  if (!arg) return 1
  const s = arg.trim()
  const v = s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s)
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
}
