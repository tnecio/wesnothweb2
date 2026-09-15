/**
 * Phase 28a P2: a small pool of compositor workers, scheduled from the main
 * thread.
 *
 * - Two queues: `high` for single, latency-sensitive requests (a unit's
 *   sprite, an animation's frames) and `low` for bulk preloads (the board's
 *   terrain). High jobs always dispatch first.
 * - Each worker gets at most `MAX_IN_FLIGHT_PER_WORKER` jobs at a time. The
 *   rest wait here, not in the worker's message queue, so a high-priority
 *   job never sits behind thousands of already-posted terrain tiles.
 * - Jobs are sharded by source image path: every ref built on the same file
 *   goes to the same worker, so each file is fetched and decoded once (each
 *   worker caches its own decoded images; dispatching to the least-loaded
 *   worker instead doubled Dead Water 1's image downloads). Images a ref
 *   pulls in as arguments (hex masks, `~BLIT` overlays) are still fetched
 *   once per worker that needs them.
 * - Base URLs and team colour data are re-sent to every worker whenever they
 *   change (checked before dispatching), since each worker has its own copy
 *   of the compositor module.
 */
import { getImageBaseUrls } from './compositor'
import type { FromCompositorWorker, ToCompositorWorker } from './compositor.worker'
import { splitRef } from './ipf'
import type { ColorData } from './teamColor'

export type RenderPriority = 'high' | 'low'

interface Job {
  id: number
  ref: string
  resolve: (bitmap: ImageBitmap | null) => void
}

interface Slot {
  worker: Worker
  inFlight: number
  high: Job[]
  low: Job[]
}

/** Stable worker index for a ref: FNV-1a over its source image path. */
function shardOf(ref: string, size: number): number {
  const { path } = splitRef(ref)
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % size
}

const MAX_IN_FLIGHT_PER_WORKER = 8
const READY_TIMEOUT_MS = 10000

/** Workers to start: leave one core for the main thread, at most 4. */
export function defaultPoolSize(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2
  return Math.max(1, Math.min(4, cores - 1))
}

export class CompositorPool {
  /** Resolves true once every worker reported it can composite; false means use the in-thread compositor. */
  readonly ready: Promise<boolean>

  private readonly slots: Slot[]
  private readonly waiting = new Map<number, Job>()
  private nextId = 1
  private colors: ColorData | null = null
  private atlasManifests: readonly string[] = []
  private sent: { image: string; engine: string; colors: ColorData | null; atlasManifests: readonly string[] } | null = null

  private constructor(size: number, colors: ColorData | null) {
    this.colors = colors
    const readies: Promise<boolean>[] = []
    this.slots = Array.from({ length: size }, () => {
      const worker = new Worker(new URL('./compositor.worker.ts', import.meta.url), { type: 'module' })
      const slot: Slot = { worker, inFlight: 0, high: [], low: [] }
      readies.push(
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS)
          worker.addEventListener('error', (event) => {
            clearTimeout(timer)
            console.warn('[ImageCache] compositor worker failed:', event.message)
            resolve(false)
          })
          worker.addEventListener('message', (event: MessageEvent<FromCompositorWorker>) => {
            const message = event.data
            if (message.type === 'ready') {
              clearTimeout(timer)
              if (!message.ok) console.warn(`[ImageCache] compositor worker unavailable: ${message.reason}`)
              resolve(message.ok)
            } else if (message.type === 'needAtlas') {
              void this.atlasBlob(message.url).then((blob) =>
                slot.worker.postMessage({ type: 'atlas', url: message.url, blob } satisfies ToCompositorWorker),
              )
            } else {
              this.onResult(slot, message)
            }
          })
        }),
      )
      return slot
    })
    this.ready = Promise.all(readies).then((oks) => oks.every(Boolean))
  }

  /** A pool, or null where workers cannot be created at all (e.g. Node). */
  static create(size: number, colors: ColorData | null): CompositorPool | null {
    if (typeof Worker === 'undefined') return null
    try {
      return new CompositorPool(size, colors)
    } catch (err) {
      console.warn('[ImageCache] could not start compositor workers:', err)
      return null
    }
  }

  setColorData(colors: ColorData | null): void {
    this.colors = colors
  }

  setAtlasManifests(urls: readonly string[]): void {
    this.atlasManifests = [...urls]
  }

  /** Bundle image bytes, downloaded once per URL for all workers (see compositor.worker.ts). */
  private readonly atlasBlobs = new Map<string, Promise<Blob | null>>()

  private atlasBlob(url: string): Promise<Blob | null> {
    let blob = this.atlasBlobs.get(url)
    if (!blob) {
      blob = fetch(url)
        .then((res) => (res.ok ? res.blob() : null))
        .catch(() => null)
      this.atlasBlobs.set(url, blob)
    }
    return blob
  }

  /**
   * Phase 28a P6: downloads a manifest and every bundle image it lists into the shared cache now, so the
   * first use (e.g. an attack animation) needs no network. Workers still decode on first use.
   */
  prefetchAtlasBundle(manifestUrl: string): void {
    void this.atlasBlob(manifestUrl).then(async (blob) => {
      if (!blob || !blob.type.includes('json')) return
      const manifest = JSON.parse(await blob.text()) as { atlases?: { file: string }[] }
      const dir = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1)
      for (const atlas of manifest.atlases ?? []) void this.atlasBlob(`${dir}${atlas.file}`)
    }).catch(() => undefined)
  }

  render(ref: string, priority: RenderPriority): Promise<ImageBitmap | null> {
    return new Promise((resolve) => {
      const job: Job = { id: this.nextId++, ref, resolve }
      const slot = this.slots[shardOf(ref, this.slots.length)]!
      ;(priority === 'high' ? slot.high : slot.low).push(job)
      this.syncConfig()
      this.dispatch(slot)
    })
  }

  /** Resolves every queued and in-flight job with null and drops workers' decoded images. */
  cancelAll(): void {
    for (const slot of this.slots) {
      for (const job of [...slot.high, ...slot.low]) job.resolve(null)
      slot.high.length = 0
      slot.low.length = 0
    }
    for (const job of this.waiting.values()) job.resolve(null)
    this.waiting.clear()
    for (const slot of this.slots) slot.worker.postMessage({ type: 'clear' } satisfies ToCompositorWorker)
  }

  terminate(): void {
    this.cancelAll()
    for (const slot of this.slots) slot.worker.terminate()
  }

  private syncConfig(): void {
    const urls = getImageBaseUrls()
    const sent = this.sent
    if (
      sent &&
      sent.image === urls.image &&
      sent.engine === urls.engine &&
      sent.colors === this.colors &&
      sent.atlasManifests === this.atlasManifests
    )
      return
    this.sent = { ...urls, colors: this.colors, atlasManifests: this.atlasManifests }
    const message: ToCompositorWorker = {
      type: 'config',
      imageBaseUrl: urls.image,
      engineImageBaseUrl: urls.engine,
      colors: this.colors,
      atlasManifests: [...this.atlasManifests],
    }
    for (const slot of this.slots) slot.worker.postMessage(message)
  }

  /** Posts queued jobs to `slot`'s worker, high priority first, up to its in-flight cap. */
  private dispatch(slot: Slot): void {
    while (slot.inFlight < MAX_IN_FLIGHT_PER_WORKER) {
      const job = slot.high.shift() ?? slot.low.shift()
      if (!job) return
      slot.inFlight++
      this.waiting.set(job.id, job)
      slot.worker.postMessage({ type: 'render', id: job.id, ref: job.ref } satisfies ToCompositorWorker)
    }
  }

  private onResult(slot: Slot, message: Extract<FromCompositorWorker, { type: 'result' }>): void {
    slot.inFlight = Math.max(0, slot.inFlight - 1)
    const job = this.waiting.get(message.id)
    if (job) {
      this.waiting.delete(message.id)
      if (message.error) console.warn(`[ImageCache] failed to build "${job.ref}":`, message.error)
      job.resolve(message.bitmap)
    } else {
      message.bitmap?.close()
    }
    this.dispatch(slot)
  }
}
