// ── Tween utilities ────────────────────────────────────────────────────────────
//
// Ported verbatim from attempt #1
// (wesnothweb/frontend/src/board/effects/tween.ts) — small RAF-based helpers
// with no WASM/worker-protocol dependency.

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * RAF-based tween: mutates numeric properties on `target` toward `to` values.
 * Works with PIXI.Container (x/y/alpha) and PIXI.ObservablePoint (scale.x/y).
 */
export function tween(target: object, to: Record<string, number>, duration: number): Promise<void> {
  const obj = target as Record<string, number>
  if (duration <= 0) { Object.assign(obj, to); return Promise.resolve() }
  const from: Record<string, number> = {}
  for (const k in to) from[k] = obj[k] ?? 0
  return new Promise(resolve => {
    const start = performance.now()
    const step = (now: number) => {
      const raw = Math.min((now - start) / duration, 1)
      const e = easeInOut(raw)
      for (const k in to) obj[k] = from[k]! + (to[k]! - from[k]!) * e
      if (raw < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
}
