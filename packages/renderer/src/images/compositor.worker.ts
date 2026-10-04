/**
 * Phase 28a P2: runs the image compositor off the main thread. Spawned by
 * `CompositorPool` (`./compositorPool.ts`); the message protocol is below.
 *
 * On start it checks it can composite at all (OffscreenCanvas 2D and
 * createImageBitmap inside a worker: Chromium, Firefox 105+, Safari 16.4+)
 * and reports `ready`; the pool falls back to in-thread compositing if any
 * worker cannot. Results are transferred as `ImageBitmap`s (zero-copy).
 *
 * Image bundles (P5) are not fetched here: the worker asks the pool
 * (`needAtlas`), which downloads each bundle once and hands every worker the
 * same `Blob` (`atlas`) -- Blobs cross to workers without copying bytes.
 */
import { Compositor, setCampaignImages, setEngineImageBaseUrl, setEngineImages, setImageBaseUrl } from './compositor'
import type { ColorData } from './teamColor'

export type ToCompositorWorker =
  | {
      type: 'config'
      imageBaseUrl: string
      engineImageBaseUrl: string
      colors: ColorData | null
      atlasManifests: string[]
      campaignImages: { root: string; files: string[] }[]
      engineImages: string[]
    }
  | { type: 'render'; id: number; ref: string }
  | { type: 'atlas'; url: string; blob: Blob | null }
  | { type: 'clear' }

export type FromCompositorWorker =
  | { type: 'ready'; ok: boolean; reason?: string }
  | { type: 'result'; id: number; bitmap: ImageBitmap | null; error?: string }
  | { type: 'needAtlas'; url: string }

interface WorkerScope {
  postMessage(message: FromCompositorWorker, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<ToCompositorWorker>) => void) | null
}

const scope = self as unknown as WorkerScope
const compositor = new Compositor()

/** Bundle requests waiting for the pool's answer, by URL. */
const atlasWaiters = new Map<string, ((blob: Blob | null) => void)[]>()
compositor.setAtlasFetcher(
  (url) =>
    new Promise((resolve) => {
      const waiters = atlasWaiters.get(url)
      if (waiters) {
        waiters.push(resolve)
        return
      }
      atlasWaiters.set(url, [resolve])
      scope.postMessage({ type: 'needAtlas', url })
    }),
)

function compositingProblem(): string | null {
  try {
    if (typeof OffscreenCanvas === 'undefined') return 'no OffscreenCanvas in workers'
    if (typeof createImageBitmap === 'undefined') return 'no createImageBitmap in workers'
    if (!new OffscreenCanvas(1, 1).getContext('2d')) return 'no 2D context on OffscreenCanvas'
    return null
  } catch (err) {
    return String(err)
  }
}

scope.onmessage = (event) => {
  const message = event.data
  switch (message.type) {
    case 'config':
      setImageBaseUrl(message.imageBaseUrl)
      setEngineImageBaseUrl(message.engineImageBaseUrl)
      setCampaignImages(message.campaignImages)
      setEngineImages(message.engineImages)
      compositor.setColorData(message.colors)
      compositor.setAtlasManifests(message.atlasManifests)
      return
    case 'atlas': {
      const waiters = atlasWaiters.get(message.url) ?? []
      atlasWaiters.delete(message.url)
      for (const resolve of waiters) resolve(message.blob)
      return
    }
    case 'clear':
      compositor.clear()
      return
    case 'render':
      compositor
        .render(message.ref)
        .then((canvas) => {
          if (!canvas) {
            scope.postMessage({ type: 'result', id: message.id, bitmap: null })
            return
          }
          const bitmap = (canvas as OffscreenCanvas).transferToImageBitmap()
          scope.postMessage({ type: 'result', id: message.id, bitmap }, [bitmap])
        })
        .catch((err: unknown) => {
          scope.postMessage({ type: 'result', id: message.id, bitmap: null, error: String(err) })
        })
      return
  }
}

const problem = compositingProblem()
scope.postMessage({ type: 'ready', ok: problem === null, ...(problem ? { reason: problem } : {}) })
