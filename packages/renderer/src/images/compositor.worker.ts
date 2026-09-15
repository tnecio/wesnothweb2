/**
 * Phase 28a P2: runs the image compositor off the main thread. Spawned by
 * `CompositorPool` (`./compositorPool.ts`); the message protocol is below.
 *
 * On start it checks it can composite at all (OffscreenCanvas 2D and
 * createImageBitmap inside a worker: Chromium, Firefox 105+, Safari 16.4+)
 * and reports `ready`; the pool falls back to in-thread compositing if any
 * worker cannot. Results are transferred as `ImageBitmap`s (zero-copy).
 */
import { Compositor, setEngineImageBaseUrl, setImageBaseUrl } from './compositor'
import type { ColorData } from './teamColor'

export type ToCompositorWorker =
  | { type: 'config'; imageBaseUrl: string; engineImageBaseUrl: string; colors: ColorData | null }
  | { type: 'render'; id: number; ref: string }
  | { type: 'clear' }

export type FromCompositorWorker =
  | { type: 'ready'; ok: boolean; reason?: string }
  | { type: 'result'; id: number; bitmap: ImageBitmap | null; error?: string }

interface WorkerScope {
  postMessage(message: FromCompositorWorker, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<ToCompositorWorker>) => void) | null
}

const scope = self as unknown as WorkerScope
const compositor = new Compositor()

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
      compositor.setColorData(message.colors)
      return
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
