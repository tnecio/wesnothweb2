import { describe, expect, it } from 'vitest'
import { thinAnimations } from '../src/terrain/thinAnimations'
import type { TerrainLayout } from '../src/terrain/terrainLayout'

/** One hex: 21 frames of ocean (water, 150 ms each), 4 of a burning brazier, and a static grass image. */
function layout(): TerrainLayout {
  const ocean = Array.from({ length: 21 }, (_, i) => ({ path: `terrain/water/ocean${String(i + 1).padStart(2, '0')}.png`, mods: '', durationMs: 150 }))
  const brazier = Array.from({ length: 4 }, (_, i) => ({ path: `scenery/brazier-lit${i + 1}.png`, mods: '', durationMs: 100 }))
  return {
    hexes: [{ x: 0, y: 0, bg: [{ frames: ocean, water: true }, { frames: [{ path: 'terrain/grass/green.png', mods: '', durationMs: 0 }] }], fg: [{ frames: brazier }] }],
    refs: [],
  }
}
const paths = (l: TerrainLayout, layer: 'bg' | 'fg', i: number) => l.hexes[0]![layer][i]!.frames.map((f) => f.path.replace(/^.*\//, ''))
const period = (l: TerrainLayout, layer: 'bg' | 'fg', i: number) => l.hexes[0]![layer][i]!.frames.reduce((s, f) => s + f.durationMs, 0)

describe('thinAnimations', () => {
  it('stride 1 with everything animating is the layout as it is', () => {
    const l = layout()
    expect(thinAnimations(l, { stride: 1, animation: { map: true, water: true } })).toBe(l)
  })

  it('stride 3 keeps every third frame of a longer cycle, each as long as the three, so the period stays', () => {
    const thin = thinAnimations(layout(), { stride: 3, animation: { map: true, water: true } })
    expect(paths(thin, 'bg', 0)).toEqual(['ocean01.png', 'ocean04.png', 'ocean07.png', 'ocean10.png', 'ocean13.png', 'ocean16.png', 'ocean19.png'])
    expect(thin.hexes[0]!.bg[0]!.frames.every((f) => f.durationMs === 450)).toBe(true)
    expect(period(thin, 'bg', 0)).toBe(21 * 150)
    expect(thin.hexes[0]!.bg[0]!.water).toBe(true)
    // 4 frames: 1 and 4 (the last group is the one frame left), 300 + 100 ms.
    expect(paths(thin, 'fg', 0)).toEqual(['brazier-lit1.png', 'brazier-lit4.png'])
    expect(period(thin, 'fg', 0)).toBe(400)
    expect(paths(thin, 'bg', 1)).toEqual(['green.png'])
    // Only what is drawn is preloaded.
    expect(thin.refs).toHaveLength(7 + 2 + 1)
  })

  it('"Animate water" off: water keeps its first frame only; other cycles still run', () => {
    const thin = thinAnimations(layout(), { stride: 1, animation: { map: true, water: false } })
    expect(paths(thin, 'bg', 0)).toEqual(['ocean01.png'])
    expect(paths(thin, 'fg', 0)).toHaveLength(4)
  })

  it('"Animate map" off: every cycle keeps its first frame', () => {
    const thin = thinAnimations(layout(), { stride: 3, animation: { map: false, water: true } })
    expect(paths(thin, 'bg', 0)).toEqual(['ocean01.png'])
    expect(paths(thin, 'fg', 0)).toEqual(['brazier-lit1.png'])
  })
})
