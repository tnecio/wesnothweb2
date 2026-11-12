/**
 * The terrain's animation cycles cut down to what will be drawn, before any image is made for them.
 */
import { hexedRef } from '../images/compositor'
import { joinRef } from '../images/ipf'
import type { TerrainFrame, TerrainLayer } from '../terrainPositioning'
import type { TerrainLayout } from './terrainLayout'

export interface ThinOptions {
  /** Keep every `stride`-th frame of a cycle longer than that (1: all). */
  stride: number
  /** "Animate map" and "Animate water": a cycle these hold still keeps only its first frame. */
  animation: { map: boolean; water: boolean }
}

/**
 * `layout` with each animation cycle thinned:
 *   - one that does not run (`animate_map` off, or a water image with `animate_water` off) keeps its first frame --
 *     the one it is held on -- so its other frames are never built;
 *   - one longer than `stride` keeps every `stride`-th of its shown frames (a 0 ms frame is never shown while it
 *     runs), each lasting as long as the frames it stands for, so the cycle's period and speed stay the same.
 * Animated water is most of a coastal map's images (21 frames for every water piece and transition: 5,191 of The
 * South Guard 3's 5,795), and on phones those ran Safari out of memory.
 */
export function thinAnimations(layout: TerrainLayout, { stride, animation }: ThinOptions): TerrainLayout {
  if (stride <= 1 && animation.map && animation.water) return layout
  const thin = (layer: TerrainLayer): TerrainLayer => {
    if (layer.frames.length <= 1) return layer
    const runs = animation.map && (!layer.water || animation.water)
    if (!runs) return { ...layer, frames: [layer.frames[0]!] }
    if (stride <= 1 || layer.frames.length <= stride) return layer
    // A 0 ms frame is never shown while the cycle runs: it is there to be the frame a held cycle shows (the weather
    // macros' `noweather.png:0`, so that "Animate map" off removes the rain). Grouped with shown frames it would take
    // their time -- Choice in the Fog's rain blinked on an iPhone, an empty frame for 160 ms out of every 400.
    const shown = layer.frames.filter((f) => f.durationMs > 0)
    if (shown.length <= stride) return shown.length > 0 && shown.length < layer.frames.length ? { ...layer, frames: shown } : layer
    const frames: TerrainFrame[] = []
    for (let i = 0; i < shown.length; i += stride) {
      const group = shown.slice(i, i + stride)
      frames.push({ ...group[0]!, durationMs: group.reduce((sum, f) => sum + f.durationMs, 0) })
    }
    return { ...layer, frames }
  }
  const refs = new Set<string>()
  const hexes = layout.hexes.map((hex) => {
    const bg = hex.bg.map(thin)
    const fg = hex.fg.map(thin)
    for (const layer of [...bg, ...fg]) for (const frame of layer.frames) refs.add(hexedRef(joinRef(frame.path, frame.mods)))
    return { ...hex, bg, fg }
  })
  return { hexes, refs: [...refs] }
}
