/**
 * The actual *playback* half of Phase 10 (unit animation) -- what
 * `unitAnimation.ts`/`frame.ts`'s own module doc comments flag as
 * missing: "real, tested logic for animation *selection* ... what's
 * missing is actually *playing* the selected animation against the live
 * board instead of drawing a static sprite."
 *
 * This module is the pure, PixiJS-free half of that: given a chosen
 * `UnitAnimationDef` (from `unitAnimation.ts`'s `chooseAnimation`) and an
 * elapsed time since the animation started, `sampleAnimation` resolves
 * exactly what a renderer should show right now -- which image (walking
 * both the animation's `[frame]` sequence AND each frame's own
 * bracket-range image sub-sequence, e.g. `fighter-attack-[1~6,2,1].png:75`),
 * and where on screen (the real `offset=` attack-lunge/movement-slide
 * interpolation between the source and destination hex). `SnapshotBoard`
 * (PixiJS-dependent) drives this over real time via a ticker -- see its
 * `playMovement`/`playAttackBlow` methods.
 *
 * Mirrors `unit_frame::redraw`'s frame/sub-image selection (frame.cpp
 * ~L600-696) and the `offset=` "frame value wins, else the
 * animation-wide `particle::parameters_` value" merge rule (frame.cpp's
 * `unit_frame::merge_parameters`) -- previously extracted as data
 * (`UnitAnimationDef.animationParams`) but never actually applied
 * anywhere; this is where that merge finally happens. Halo/blend/submerge
 * stay unimplemented (see `frame.ts`'s `applyFrameEffects` stub) -- only
 * the image and position are resolved here.
 */

import { Direction } from '@wesnothweb2/engine/src/model/Location.js';
import {
  frameCenterPosition,
  resolveFrameImage,
  sampleProgressivePair,
  type HexPixelPos,
  type StepSequenceItem,
  type UnitFrameDef,
} from './frame.js';
import type { UnitAnimationDef } from './unitAnimation.js';

/** Total real-time duration of `anim`, summing every `[frame]`'s own duration -- when to stop sampling and consider the animation finished. */
export function animationDurationMs(anim: UnitAnimationDef): number {
  return anim.frames.reduce((sum, f) => sum + f.durationMs, 0);
}

/** Finds which `[frame]` covers `elapsedMs` into the animation, and how far into THAT frame that point is. Clamps to the last frame past the end (a caller sampling one final time at/after `animationDurationMs` gets the animation's last real state, not nothing). */
function frameAt(frames: readonly UnitFrameDef[], elapsedMs: number): { frame: UnitFrameDef; tInFrame: number } | null {
  if (frames.length === 0) return null;
  let acc = 0;
  for (const frame of frames) {
    if (elapsedMs < acc + frame.durationMs) return { frame, tInFrame: elapsedMs - acc };
    acc += frame.durationMs;
  }
  const last = frames[frames.length - 1]!;
  return { frame: last, tInFrame: last.durationMs };
}

/** Finds which step of a (possibly bracket-range-expanded) image sub-sequence covers `tMs` into it. */
function stepAt(seq: readonly StepSequenceItem[], tMs: number): string | null {
  if (seq.length === 0) return null;
  let acc = 0;
  for (const step of seq) {
    if (tMs < acc + step.durationMs) return step.value;
    acc += step.durationMs;
  }
  return seq[seq.length - 1]!.value;
}

export interface AnimationSample {
  /** The image path to show right now, or `null` if this animation/frame declares none (e.g. a sound-only or halo-only frame -- caller should keep showing whatever it last drew). */
  readonly imagePath: string | null;
  /** Mirror horizontally (NW/SW diagonal art reuses NE/SE flipped -- see `resolveFrameImage`). */
  readonly hflip: boolean;
  readonly x: number;
  readonly y: number;
}

/**
 * What `anim` should show at `elapsedMs` since it started playing, facing
 * `direction`, sliding/lunging between hex-center pixels `src`/`dst`
 * (pass `src === dst` for an animation with no positional movement, e.g.
 * `defend`/`standing`).
 */
export function sampleAnimation(
  anim: UnitAnimationDef,
  direction: Direction,
  elapsedMs: number,
  src: HexPixelPos,
  dst: HexPixelPos,
): AnimationSample {
  const picked = frameAt(anim.frames, elapsedMs);
  if (!picked) return { imagePath: null, hflip: false, x: src.x, y: src.y };
  const { frame, tInFrame } = picked;

  const resolvedImage = resolveFrameImage(frame, direction);
  const imagePath = stepAt(resolvedImage.sequence, tInFrame);

  // offset= merge rule: the frame's own value wins if it set one; else fall
  // back to the animation-wide value, sampled over the WHOLE animation's
  // elapsed time (not just this frame's) -- see module doc comment.
  const usingFrameOffset = frame.offset.length > 0;
  const offsetSegments = usingFrameOffset ? frame.offset : anim.animationParams.offset;
  const offsetTimeMs = usingFrameOffset ? tInFrame : elapsedMs;
  const offset = sampleProgressivePair(offsetSegments, offsetTimeMs);
  const pos = frameCenterPosition(src, dst, offset);

  return { imagePath, hflip: resolvedImage.hflip, x: pos.x, y: pos.y };
}
