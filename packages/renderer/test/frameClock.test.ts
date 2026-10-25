/**
 * Phase 33: the board's one animation clock (`frameClock.ts`).
 */
import { describe, expect, it } from 'vitest'
import type * as PIXI from 'pixi.js'
import { FrameClock, frameAt } from '../src/frameClock'

/** A sprite as the clock sees it, counting how often its texture is set. */
function stubSprite(): PIXI.Sprite & { sets: number } {
  let texture: unknown = null
  const sprite = { destroyed: false, parent: null, sets: 0 } as unknown as PIXI.Sprite & { sets: number }
  Object.defineProperty(sprite, 'texture', {
    get: () => texture,
    set: (t) => {
      texture = t
      sprite.sets++
    },
  })
  return sprite
}
const tex = (name: string) => ({ name }) as unknown as PIXI.Texture
const frames = [
  { texture: tex('a'), durationMs: 100 },
  { texture: tex('b'), durationMs: 200 },
  { texture: tex('c'), durationMs: 100 },
]

describe('the board animation clock', () => {
  it('shows the frame the cycle has reached, wrapping round', () => {
    expect([0, 99, 100, 299, 300, 399, 400, 550].map((t) => frameAt(frames, 400, t))).toEqual([0, 0, 1, 1, 2, 2, 0, 1])
  })

  it('every sprite of the same cycle shows the same frame at the same time (upstream: one global time)', () => {
    const clock = new FrameClock()
    const a = stubSprite()
    const b = stubSprite()
    clock.add(a, frames)
    clock.tick(150)
    clock.add(b, frames)
    clock.tick(350)
    expect(a.texture).toBe(frames[2]!.texture)
    expect(b.texture).toBe(frames[2]!.texture)
  })

  it('sets a texture only when the frame changes', () => {
    const clock = new FrameClock()
    const sprite = stubSprite()
    clock.add(sprite, frames)
    const afterAdd = sprite.sets
    for (let t = 0; t < 100; t += 10) clock.tick(t)
    expect(sprite.sets).toBe(afterAdd)
    clock.tick(150)
    clock.tick(160)
    expect(sprite.sets).toBe(afterAdd + 1)
  })

  it("an offset shifts one cycle (a village flag's side phase), and a held cycle stays on its first frame", () => {
    const clock = new FrameClock()
    const flag = stubSprite()
    const held = stubSprite()
    let running = false
    clock.add(flag, frames, { offsetMs: 100 })
    clock.add(held, frames, { animates: () => running })
    clock.tick(0)
    expect(flag.texture).toBe(frames[1]!.texture)
    clock.tick(150)
    expect(held.texture).toBe(frames[0]!.texture)
    running = true
    clock.tick(150)
    expect(held.texture).toBe(frames[1]!.texture)
  })

  it('a single frame is just set, and destroyed sprites are dropped', () => {
    const clock = new FrameClock()
    const still = stubSprite()
    clock.add(still, [frames[0]!])
    expect(still.texture).toBe(frames[0]!.texture)
    expect(clock.size).toBe(0)
    const gone = stubSprite()
    clock.add(gone, frames)
    ;(gone as unknown as { destroyed: boolean }).destroyed = true
    clock.tick(150)
    expect(clock.size).toBe(0)
  })
})
