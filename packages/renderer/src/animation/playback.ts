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
 * ~L600-696) and the `offset=`/`blend_ratio=` "frame value wins, else the
 * animation-wide `particle::parameters_` value" merge rule (frame.cpp's
 * `unit_frame::merge_parameters`) -- previously extracted as data
 * (`UnitAnimationDef.animationParams`) but never actually applied
 * anywhere; this is where that merge finally happens (2026-09-11: now
 * covers `blend_ratio=`/`blend_color=` too, not just `offset=` -- see
 * `SnapshotBoard`'s own doc comment on why: the real per-unit-type
 * `[defend]` hit-flash and the generic engine-injected fallback both
 * ride on this same blend mechanism). Halo/submerge stay unimplemented
 * (see `frame.ts`'s `applyFrameEffects` stub) -- only image, position,
 * and blend are resolved here.
 */

import { Direction } from '@wesnothweb2/engine/src/model/Location.js';
import {
  squareParentheticalSplit,
  frameCenterPosition,
  resolveFrameImage,
  sampleProgressivePair,
  type HexPixelPos,
  type StepSequenceItem,
  type UnitFrameDef,
} from './frame.js';
import type { ParticleDef, UnitAnimationDef } from './unitAnimation.js';

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
  /** 0 (no tint) to ~1 (fully the tint colour) -- `blend_ratio=`, sampled the same "frame wins, else animation-wide" way as `offset=`. A real `[defend]` hit-flash's curve peaks around 0.5, matching upstream's own `color_t` alpha-blend convention. */
  readonly blendRatio: number;
  /** Parsed from `blend_color=`'s real `"r,g,b"` WML format into a `0xRRGGBB` value a renderer can hand straight to e.g. PixiJS `tint` -- `null` if unparseable or absent. */
  readonly blendColor: number | null;
  /**
   * The sprite's opacity, 0 to 1: `alpha=` (upstream's `highlight_ratio`), the frame's value when it is not 1,
   * else the animation-wide one (`frame_parsed_parameters` merge). Upstream brightens above 1; that part is
   * not drawn here.
   */
  readonly alpha: number;
}

/** Parses the real `blend_color=` WML format (`"r,g,b"`, each 0-255 -- mirrors `color_t::from_rgb_string`) into a `0xRRGGBB` number. */
export function parseBlendColor(raw: string): number | null {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
  return (clamp(parts[0]!) << 16) | (clamp(parts[1]!) << 8) | clamp(parts[2]!);
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
  if (!picked) return { imagePath: null, hflip: false, x: src.x, y: src.y, blendRatio: 0, blendColor: null, alpha: 1 };
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

  // Same merge rule for blend_ratio=/blend_color= (e.g. the real
  // [defend] hit-flash's red pulse, or the generic engine-injected
  // fallback -- see SnapshotBoard's own doc comment).
  const usingFrameBlend = frame.blendRatio.length > 0;
  const blendSegments = usingFrameBlend ? frame.blendRatio : anim.animationParams.blendRatio;
  const blendTimeMs = usingFrameBlend ? tInFrame : elapsedMs;
  const blendRatio = Math.max(0, sampleProgressivePair(blendSegments, blendTimeMs));
  const blendColorRaw = frame.blendColor || anim.animationParams.blendColor;
  const blendColor = blendColorRaw ? parseBlendColor(blendColorRaw) : null;

  const frameHighlight = frame.highlightRatio.length > 0 ? sampleProgressivePair(frame.highlightRatio, tInFrame) : 1;
  const animHighlight = anim.animationParams.highlightRatio.length > 0 ? sampleProgressivePair(anim.animationParams.highlightRatio, elapsedMs) : 1;
  const highlight = Math.abs(frameHighlight - 1) > 0.001 ? frameHighlight : animHighlight;
  const alpha = Math.max(0, Math.min(1, highlight));

  return { imagePath, hflip: resolvedImage.hflip, x: pos.x, y: pos.y, blendRatio, blendColor, alpha };
}

// ── Particles and halos ──────────────────────────────────────────────────────

/**
 * Where `anim` sits on the animation clock (hits land at 0): from the
 * earliest of its unit frames and particles to the latest end. A cycling
 * particle does not extend it (it only runs while the rest does).
 * `unit_animator` starts every animation of a beat together at the
 * earliest such start, so an attacker's and a defender's line up on the
 * blow (`unit_animator::start_animations`).
 */
export function animationTimeline(anim: UnitAnimationDef): { startMs: number; endMs: number } {
  let startMs = anim.startTimeMs;
  let endMs = anim.startTimeMs + animationDurationMs(anim);
  for (const p of anim.particles) {
    startMs = Math.min(startMs, p.startTimeMs);
    if (!p.cycles) endMs = Math.max(endMs, p.startTimeMs + particleDurationMs(p));
  }
  return { startMs, endMs };
}

function particleDurationMs(p: ParticleDef): number {
  return p.frames.reduce((sum, f) => sum + f.durationMs, 0);
}

/** One image to draw above the units for a moment: a particle's sprite (a missile) or a halo. Positions are board pixels of the image's centre. */
export interface OverlaySample {
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly hflip: boolean;
  readonly vflip: boolean;
}

const isDiagonal = (d: Direction): boolean =>
  d === Direction.NorthEast || d === Direction.SouthEast || d === Direction.NorthWest || d === Direction.SouthWest;
const facesWest = (d: Direction): boolean => d === Direction.NorthWest || d === Direction.SouthWest;
const facesNorth = (d: Direction): boolean => d === Direction.NorthWest || d === Direction.North || d === Direction.NorthEast;

/**
 * `unit_frame::redraw`'s halo half (frame.cpp ~L735-790): the halo image
 * (frame value, else the animation-wide one) plus `halo_mod`, centred on
 * the frame's position shifted by `halo_x`/`halo_y` -- `halo_x` mirrored
 * when facing west -- and flipped per upstream's orientation table
 * (vertical flips only when `auto_vflip` holds, i.e. not for the unit's
 * own frames by default).
 */
function haloSample(
  frame: UnitFrameDef,
  params: UnitFrameDef,
  tInFrame: number,
  elapsedMs: number,
  pos: HexPixelPos,
  direction: Direction,
  autoVflip: boolean,
): OverlaySample | null {
  const usingFrameHalo = frame.halo.length > 0;
  const halo = usingFrameHalo ? stepAt(frame.halo, tInFrame) : stepAt(params.halo, elapsedMs);
  if (!halo) return null;
  const mod = frame.haloMod || params.haloMod;
  const haloX = sampleProgressivePair(frame.haloX.length > 0 ? frame.haloX : params.haloX, frame.haloX.length > 0 ? tInFrame : elapsedMs);
  const haloY = sampleProgressivePair(frame.haloY.length > 0 ? frame.haloY : params.haloY, frame.haloY.length > 0 ? tInFrame : elapsedMs);
  const west = facesWest(direction);
  const south = direction === Direction.South || direction === Direction.SouthEast || direction === Direction.SouthWest;
  return {
    path: mod ? `${halo}${mod}` : halo,
    x: pos.x + (west ? -haloX : haloX),
    y: pos.y + haloY,
    hflip: west,
    vflip: south && autoVflip,
  };
}

/**
 * Halo of the unit's own current frame at `absMs` on the animation clock,
 * or `null` outside its frames (upstream draws halos only "in scope of
 * frame") or when it has none. `pos` is where the unit is drawn.
 */
export function sampleUnitHalo(anim: UnitAnimationDef, direction: Direction, absMs: number, pos: HexPixelPos): OverlaySample | null {
  const local = absMs - anim.startTimeMs;
  if (local < 0 || local >= animationDurationMs(anim)) return null;
  const picked = frameAt(anim.frames, local);
  if (!picked) return null;
  const autoVflip = picked.frame.autoVflip ?? anim.animationParams.autoVflip ?? false; // unit frames: `!primary` = false
  return haloSample(picked.frame, anim.animationParams, picked.tInFrame, local, pos, direction, autoVflip);
}

/**
 * Every particle's image and halo at `absMs` on the animation clock
 * (`unit_animation::particle::redraw`): each is drawn only while one of
 * its frames is current, at its own `offset=` between `src` and `dst`
 * (a missile uses the `missile_offset=0~0.8` default), with the
 * diagonal/flip rules of `unit_frame::redraw` -- particles flip
 * vertically when facing south unless `auto_vflip=no` (the default is
 * `!primary`).
 */
export function sampleParticles(
  anim: UnitAnimationDef,
  direction: Direction,
  absMs: number,
  src: HexPixelPos,
  dst: HexPixelPos,
): OverlaySample[] {
  const out: OverlaySample[] = [];
  for (const p of anim.particles) {
    const duration = particleDurationMs(p);
    let local = absMs - p.startTimeMs;
    if (local < 0 || duration <= 0) continue;
    if (p.cycles) local %= duration;
    else if (local >= duration) continue;
    const picked = frameAt(p.frames, local);
    if (!picked) continue;
    const { frame, tInFrame } = picked;

    const usingFrameOffset = frame.offset.length > 0;
    const offset = sampleProgressivePair(usingFrameOffset ? frame.offset : p.params.offset, usingFrameOffset ? tInFrame : local);
    const pos = frameCenterPosition(src, dst, offset);
    const autoVflip = frame.autoVflip ?? p.params.autoVflip ?? true;
    const autoHflip = frame.autoHflip ?? p.params.autoHflip ?? true;

    const useDiagonal = isDiagonal(direction) && frame.imageDiagonal.length > 0;
    const image = stepAt(useDiagonal ? frame.imageDiagonal : frame.image, tInFrame);
    if (image) {
      const mod = frame.imageMod || p.params.imageMod;
      const dx = sampleProgressivePair(frame.x.length > 0 ? frame.x : p.params.x, frame.x.length > 0 ? tInFrame : local);
      const dy = sampleProgressivePair(frame.y.length > 0 ? frame.y : p.params.y, frame.y.length > 0 ? tInFrame : local);
      out.push({
        path: mod ? `${image}${mod}` : image,
        x: pos.x + dx,
        y: pos.y + dy,
        hflip: autoHflip && facesWest(direction),
        vflip: autoVflip && !facesNorth(direction),
      });
    }
    const halo = haloSample(frame, p.params, tInFrame, local, pos, direction, autoVflip);
    if (halo) out.push(halo);
  }
  return out;
}

// ── Sounds ───────────────────────────────────────────────────────────────────

/** A sound to start when the animation clock reaches `atMs` (hits land at 0). */
export interface SoundCue {
  readonly atMs: number;
  /** A `sound=` value: a comma list (with `[a,b]`/`[1~3]` brackets), one of which is picked when it plays. */
  readonly files: string;
}

/**
 * Every sound an animation makes: `unit_frame::redraw` plays a frame's
 * `sound=` once, when the frame first draws ("stuff that should be done only
 * once per frame"), the frame's own value winning over the animation-wide
 * one (`merge_parameters`). Unit frames and particles (`[sound_frame]`, the
 * built-in `_death_sound`/`_healed_sound`/`_poison_sound`) all count, in
 * clock order.
 */
export function animationSoundCues(anim: UnitAnimationDef): SoundCue[] {
  const cues: SoundCue[] = [];
  const walk = (frames: readonly UnitFrameDef[], startMs: number, fallback: string): void => {
    let at = startMs;
    for (const frame of frames) {
      const files = frame.sound || fallback;
      if (files !== '') cues.push({ atMs: at, files });
      at += frame.durationMs;
    }
  };
  walk(anim.frames, anim.startTimeMs, anim.animationParams.sound);
  for (const p of anim.particles) walk(p.frames, p.startTimeMs, p.params.sound);
  return cues.sort((a, b) => a.atMs - b.atMs);
}

/** Every individual sound file any of `anims` can play (comma lists and `[a,b]`/`[1~3]` brackets expanded) -- what a preload should fetch. */
export function animationSoundFiles(anims: readonly UnitAnimationDef[]): string[] {
  const files = new Set<string>();
  for (const anim of anims) {
    for (const cue of animationSoundCues(anim)) for (const file of squareParentheticalSplit(cue.files)) if (file !== '') files.add(file);
  }
  return [...files];
}
