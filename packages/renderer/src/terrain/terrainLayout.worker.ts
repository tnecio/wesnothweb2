/**
 * Phase 28a P3: computes terrain layouts off the main thread. Fetches and
 * revives the `[terrain_graphics]` rules itself (once per URL, kept for the
 * worker's lifetime), so neither the ~17.5 MB rules JSON parse nor the rule
 * matching touches the main thread. Spawned by `terrainLayoutClient.ts`.
 */
import { layoutTerrain, type TerrainHexCode, type TerrainLayout } from './terrainLayout'
import { mergeBuildingRules, reviveBuildingRules, type BuildingRule } from './terrainGraphicsRules'

export interface ToTerrainLayoutWorker {
  type: 'layout'
  id: number
  rulesUrl: string
  /** The campaign's and scenario's own rules (`mergeBuildingRules`), as JSON. */
  extraRules: BuildingRule[]
  terrain: TerrainHexCode[]
  width: number
  height: number
}

export interface FromTerrainLayoutWorker {
  type: 'layout'
  id: number
  /** Null when no rules could be loaded: the board falls back to flat-coloured terrain. */
  layout: TerrainLayout | null
  error?: string
}

interface WorkerScope {
  postMessage(message: FromTerrainLayoutWorker): void
  onmessage: ((event: MessageEvent<ToTerrainLayoutWorker>) => void) | null
}

const scope = self as unknown as WorkerScope
const rulesByUrl = new Map<string, Promise<BuildingRule[]>>()

function loadRules(url: string): Promise<BuildingRule[]> {
  let rules = rulesByUrl.get(url)
  if (!rules) {
    rules = fetch(url)
      .then(async (res) => (res.ok ? reviveBuildingRules((await res.json()) as BuildingRule[]) : []))
      .catch(() => [])
    rulesByUrl.set(url, rules)
  }
  return rules
}

scope.onmessage = (event) => {
  const message = event.data
  loadRules(message.rulesUrl)
    .then((rules) => {
      const all = mergeBuildingRules(rules, reviveBuildingRules(message.extraRules))
      const layout = rules.length > 0 ? layoutTerrain(all, message.terrain, message.width, message.height) : null
      scope.postMessage({ type: 'layout', id: message.id, layout })
    })
    .catch((err: unknown) => {
      scope.postMessage({ type: 'layout', id: message.id, layout: null, error: String(err) })
    })
}
