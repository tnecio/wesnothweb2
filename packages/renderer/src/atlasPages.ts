/**
 * Phase 33: the board's images copied into a few shared textures ("pages"), so that the board draws from a handful
 * of texture sources instead of one per image.
 *
 * Two PixiJS costs grow with the number of sources (measured by `apps/web/scripts/perf-playthrough.mjs` on Heir to
 * the Throne 1: ~16,000 sprites, nearly every terrain image its own texture):
 *   - a sprite whose texture changes to another source makes PixiJS rebuild its render group's instructions --
 *     every animated terrain image, every unit's standing and idle frames did that, so a big board rebuilt on
 *     almost every frame. Between sub-textures of one source the batcher updates the sprite in place;
 *   - a batch holds at most 16 sources, so a board of distinct images broke into hundreds of draw calls a frame.
 *     Drawn from a few pages, it batches into a few.
 *
 * The copies are drawn by the renderer itself, at whole pixels, so each copy's texels are the ones its own texture
 * holds (pinned by the browser check in `apps/web/scripts/perf-playthrough.mjs`). Each copy gets `PAD` pixels of its
 * own edge around it (its edge rows and columns stretched outward, drawn beside it, never under it), so sampling at
 * its border -- a zoomed board -- reads its own edge, as a texture of its own clamps to, and never a neighbour.
 *
 * Images are placed in two ways:
 *   - `place` (the terrain, village flags, halos): copied at once, outside a render; the frames of one animation
 *     cycle all on one page, so changing frame never changes source;
 *   - `get` (a unit's frames, fetched as they are first shown): copied once, after the frame in which it was first
 *     asked for (copying in the middle of PixiJS's render is not safe), the original used until then.
 */
import * as PIXI from 'pixi.js'

const PAD = 2
/** The side of a page, in pixels (16 MB of GPU memory each; every WebGL device supports 4096). */
const PAGE = 2048
/**
 * At most this many pages per board; past them, images are drawn from their own textures, as before. A batch takes
 * 16 sources. Heir to the Throne 1's ~5,000 distinct hex images fill about eight; a page costs about what the
 * images on it did on their own (the originals, no longer drawn, are unloaded by PixiJS's texture GC).
 */
const MAX_PAGES = 16

/**
 * Adds to `scene` the sprites that draw `texture` with its top-left at (`left`, `top`), whole pixels, and its edge
 * rows and columns stretched `PAD` pixels outward.
 */
function addPadded(scene: PIXI.Container, texture: PIXI.Texture, left: number, top: number): void {
  const w = Math.ceil(texture.frame.width)
  const h = Math.ceil(texture.frame.height)
  const place = (piece: PIXI.Texture, px: number, py: number, pw: number, ph: number) => {
    const s = new PIXI.Sprite(piece)
    s.position.set(px, py)
    s.width = pw
    s.height = ph
    scene.addChild(s)
  }
  place(texture, left, top, w, h)
  const edge = (fx: number, fy: number, fw: number, fh: number) =>
    new PIXI.Texture({ source: texture.source, frame: new PIXI.Rectangle(texture.frame.x + fx, texture.frame.y + fy, fw, fh) })
  place(edge(0, 0, 1, h), left - PAD, top, PAD, h)
  place(edge(w - 1, 0, 1, h), left + w, top, PAD, h)
  place(edge(0, 0, w, 1), left, top - PAD, w, PAD)
  place(edge(0, h - 1, w, 1), left, top + h, w, PAD)
  place(edge(0, 0, 1, 1), left - PAD, top - PAD, PAD, PAD)
  place(edge(w - 1, 0, 1, 1), left + w, top - PAD, PAD, PAD)
  place(edge(0, h - 1, 1, 1), left - PAD, top + h, PAD, PAD)
  place(edge(w - 1, h - 1, 1, 1), left + w, top + h, PAD, PAD)
}

interface Shelf {
  x: number
  y: number
  height: number
}

/** Shelf packing: room for a `w`x`h` box from `shelf` (advanced), or null when the page is full. */
function take(shelf: Shelf, w: number, h: number): { x: number; y: number } | null {
  if (shelf.x + w > PAGE) {
    shelf.y += shelf.height
    shelf.x = 0
    shelf.height = 0
  }
  if (shelf.y + h > PAGE || w > PAGE) return null
  const spot = { x: shelf.x, y: shelf.y }
  shelf.x += w
  shelf.height = Math.max(shelf.height, h)
  return spot
}

const boxOf = (t: PIXI.Texture) => ({ w: Math.ceil(t.frame.width) + PAD * 2, h: Math.ceil(t.frame.height) + PAD * 2 })

export class AtlasPages {
  /** Each image's copy (the first, if a cycle placed it again). */
  private readonly copies = new WeakMap<PIXI.Texture, PIXI.Texture>()
  /** Each placed cycle's copies, all on one page, by its frames' identities. */
  private readonly cycles = new Map<string, PIXI.Texture[]>()
  private readonly ids = new WeakMap<PIXI.Texture, number>()
  private nextId = 1
  /** Images that stay as they are (too big, or the pages are full). */
  private readonly kept = new WeakSet<PIXI.Texture>()
  private queue: PIXI.Texture[] = []
  private readonly queued = new WeakSet<PIXI.Texture>()
  private readonly pages: PIXI.RenderTexture[] = []
  /** The shelf being filled on the last page. */
  private shelf: Shelf = { x: 0, y: 0, height: 0 }
  private flushing = false
  private destroyed = false

  constructor(private readonly renderer: PIXI.Renderer) {}

  private idOf(texture: PIXI.Texture): number {
    let id = this.ids.get(texture)
    if (id === undefined) {
      id = this.nextId++
      this.ids.set(texture, id)
    }
    return id
  }

  private cycleKey(frames: readonly PIXI.Texture[]): string {
    return frames.map((t) => this.idOf(t)).join(',')
  }

  /**
   * Copies, at once, each group of images not yet copied -- a group's images all onto one page -- with one render
   * per page touched. Call it outside a render (not from a display object's `onRender`).
   */
  place(groups: readonly (readonly PIXI.Texture[])[]): void {
    if (this.destroyed) return
    const scenes = new Map<PIXI.RenderTexture, PIXI.Container>()
    for (const group of groups) {
      if (group.length === 0 || group.some((t) => t.destroyed)) continue
      if (group.length === 1 ? this.copies.has(group[0]!) || this.kept.has(group[0]!) : this.cycles.has(this.cycleKey(group))) continue
      const spots = this.allocate(group.map(boxOf))
      if (!spots) {
        if (group.length === 1) this.kept.add(group[0]!)
        continue
      }
      const copies = group.map((texture, i) => {
        const { page, x, y } = spots[i]!
        let scene = scenes.get(page)
        if (!scene) scenes.set(page, (scene = new PIXI.Container()))
        addPadded(scene, texture, x + PAD, y + PAD)
        const copy = new PIXI.Texture({
          source: page.source,
          frame: new PIXI.Rectangle(x + PAD, y + PAD, Math.ceil(texture.frame.width), Math.ceil(texture.frame.height)),
        })
        if (!this.copies.has(texture)) this.copies.set(texture, copy)
        return copy
      })
      if (group.length > 1) this.cycles.set(this.cycleKey(group), copies)
    }
    for (const [page, scene] of scenes) {
      this.renderer.render({ container: scene, target: page, clear: false })
      scene.destroy({ children: true })
    }
  }

  /** `texture`'s copy, if it has one, else `texture`. */
  copyOf(texture: PIXI.Texture): PIXI.Texture {
    return this.copies.get(texture) ?? texture
  }

  /** A cycle's frames, copied onto one page (copied now if they are not yet), or the frames as they are. */
  cycle(frames: readonly PIXI.Texture[]): PIXI.Texture[] {
    if (frames.length < 2) return frames.map((t) => this.copyOf(t))
    const key = this.cycleKey(frames)
    if (!this.cycles.has(key)) this.place([frames])
    return this.cycles.get(key) ?? [...frames]
  }

  /** `texture`'s copy, or `texture` itself until it has been copied (asked for, the copy is made soon). */
  get(texture: PIXI.Texture): PIXI.Texture {
    const copy = this.copies.get(texture)
    if (copy) return copy
    if (this.destroyed || texture.destroyed || this.kept.has(texture) || this.queued.has(texture)) return texture
    this.queued.add(texture)
    this.queue.push(texture)
    if (!this.flushing) {
      this.flushing = true
      // After this frame's render: a microtask runs once the whole animation-frame callback has returned.
      queueMicrotask(() => this.flush())
    }
    return texture
  }

  /** Whether `texture` is waiting for its copy (asked for with `get`, copied after this frame). */
  pending(texture: PIXI.Texture): boolean {
    return this.queued.has(texture)
  }

  /** How many pages are in use. */
  get size(): number {
    return this.pages.length
  }

  private flush(): void {
    this.flushing = false
    const queue = this.queue
    this.queue = []
    for (const texture of queue) this.queued.delete(texture)
    this.place(queue.map((t) => [t]))
  }

  /** Room for every box of a group on one page: the last page if they all fit, else a new one. */
  private allocate(boxes: readonly { w: number; h: number }[]): { page: PIXI.RenderTexture; x: number; y: number }[] | null {
    const last = this.pages[this.pages.length - 1]
    if (last) {
      const trial = { ...this.shelf }
      const spots = boxes.map((b) => take(trial, b.w, b.h))
      if (spots.every((s) => s)) {
        this.shelf = trial
        return spots.map((s) => ({ page: last, ...s! }))
      }
    }
    const fresh: Shelf = { x: 0, y: 0, height: 0 }
    const spots = boxes.map((b) => take(fresh, b.w, b.h))
    if (!spots.every((s) => s) || this.pages.length >= MAX_PAGES) return null
    const page = PIXI.RenderTexture.create({ width: PAGE, height: PAGE, resolution: 1, antialias: false })
    this.renderer.render({ container: new PIXI.Container(), target: page, clear: true })
    this.pages.push(page)
    this.shelf = fresh
    return spots.map((s) => ({ page, ...s! }))
  }

  destroy(): void {
    this.destroyed = true
    for (const page of this.pages) page.destroy(true)
    this.pages.length = 0
    this.cycles.clear()
  }
}
