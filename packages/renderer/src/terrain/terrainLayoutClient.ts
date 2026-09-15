/**
 * Phase 28a P3: terrain layout for a map, computed in a worker
 * (`terrainLayout.worker.ts`) where possible, else in-thread.
 *
 * One worker is kept for the page's lifetime so the parsed rules survive
 * scenario changes. Anything that stops the worker path -- no `Worker`
 * (Node), a failed worker, or `globalThis.__wesnothImageWorkers = false`
 * for A/B runs -- falls back to fetching the rules and laying out on the
 * main thread, with identical output.
 */
import { layoutTerrain, type TerrainHexCode, type TerrainLayout } from './terrainLayout'
import type { FromTerrainLayoutWorker, ToTerrainLayoutWorker } from './terrainLayout.worker'
import { reviveBuildingRules, type BuildingRule } from './terrainGraphicsRules'

type WorkerAnswer = { layout: TerrainLayout | null } | null

let worker: Worker | null | undefined
let nextId = 1
const waiting = new Map<number, (answer: WorkerAnswer) => void>()
const inThreadRules = new Map<string, Promise<BuildingRule[]>>()

function workerWanted(): boolean {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return false
  return (globalThis as { __wesnothImageWorkers?: boolean }).__wesnothImageWorkers !== false
}

function failWorker(reason: unknown): void {
  console.warn('[terrainLayout] worker failed, laying out terrain on the main thread:', reason)
  for (const resolve of waiting.values()) resolve(null)
  waiting.clear()
  worker?.terminate()
  worker = null
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  if (!workerWanted()) return (worker = null)
  try {
    const w = new Worker(new URL('./terrainLayout.worker.ts', import.meta.url), { type: 'module' })
    w.addEventListener('message', (event: MessageEvent<FromTerrainLayoutWorker>) => {
      const resolve = waiting.get(event.data.id)
      if (!resolve) return
      waiting.delete(event.data.id)
      if (event.data.error) console.warn('[terrainLayout] worker error:', event.data.error)
      resolve(event.data.error ? null : { layout: event.data.layout })
    })
    w.addEventListener('error', (event) => failWorker(event.message))
    worker = w
  } catch (err) {
    failWorker(err)
  }
  return worker ?? null
}

function fetchRulesInThread(url: string): Promise<BuildingRule[]> {
  let rules = inThreadRules.get(url)
  if (!rules) {
    rules = fetch(url)
      .then(async (res) => (res.ok ? reviveBuildingRules((await res.json()) as BuildingRule[]) : []))
      .catch(() => [])
    inThreadRules.set(url, rules)
  }
  return rules
}

/**
 * The terrain layout of a map whose `[terrain_graphics]` rules are served at
 * `rulesUrl`, or null when no rules are available (flat-coloured fallback).
 */
export async function computeTerrainLayout(
  rulesUrl: string,
  terrain: readonly TerrainHexCode[],
  width: number,
  height: number,
): Promise<TerrainLayout | null> {
  const w = getWorker()
  if (w) {
    const answer = await new Promise<WorkerAnswer>((resolve) => {
      const id = nextId++
      waiting.set(id, resolve)
      const message: ToTerrainLayoutWorker = {
        type: 'layout',
        id,
        rulesUrl,
        terrain: terrain.map((h) => ({ x: h.x, y: h.y, code: h.code })),
        width,
        height,
      }
      w.postMessage(message)
    })
    if (answer) return answer.layout
  }
  const rules = await fetchRulesInThread(rulesUrl)
  return rules.length > 0 ? layoutTerrain(rules, terrain, width, height) : null
}
