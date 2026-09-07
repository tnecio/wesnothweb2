import * as PIXI from 'pixi.js'
import { tween } from './tween'

/**
 * Spawns a floating damage/heal label that drifts upward and fades out.
 * The label is self-managing — it adds itself to `container` and removes
 * itself when the animation completes.
 *
 * Ported verbatim from attempt #1
 * (wesnothweb/frontend/src/board/effects/FloatingText.ts).
 */
export function showFloatingText(
  container: PIXI.Container,
  text: string,
  color: number,
  pos: { x: number; y: number },
): void {
  const label = new PIXI.Text({
    text,
    style: {
      fontFamily: 'sans-serif',
      fontSize:   14,
      fontWeight: 'bold',
      fill:       color,
    },
  })
  label.anchor.set(0.5, 1)
  label.x = pos.x
  label.y = pos.y
  label.alpha = 1
  container.addChild(label)
  tween(label, { y: label.y - 40, alpha: 0 }, 700).then(() => {
    container.removeChild(label)
    label.destroy()
  })
}
