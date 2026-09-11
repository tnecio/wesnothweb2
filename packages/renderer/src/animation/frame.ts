/**
 * TS port of the *data-extraction* half of upstream's `units/frame.hpp`/
 * `.cpp` (`frame_builder`/`frame_parsed_parameters`/`unit_frame`, plus the
 * `progressive_pair`/`progressive_single` templates from `units/
 * frame_private.hpp`): given a `[frame]`/`[missile_frame]` WML config, what
 * image(s) it shows, for how long, and where (position/offset), so a later
 * renderer pass can actually draw it.
 *
 * Deliberately NOT ported (real *rendering* effects, not data — see the
 * Phase 4 task's scope note): halo compositing (`halo::manager`),
 * submerge/highlight alpha blending. `applyFrameEffects()` below is
 * still a stub for those. `blend_with`/`blend_ratio` (the hit-flash
 * colour blitting) is the one exception, now real (2026-09-11) — see
 * `playback.ts`'s `sampleAnimation` (which samples it the same
 * frame-wins-else-animation-wide way as `offset=`) and `SnapshotBoard`'s
 * `applyBlend` (the actual PixiJS-side tinted-overlay compositing). Halo/
 * submerge data is still extracted faithfully in `UnitFrameDef` so a
 * real compositor for THOSE can be dropped in later the same way.
 *
 * What IS ported for real, because the Phase 4 plan calls it out
 * explicitly (attack-lunge positioning, direction-aware image selection):
 *  - The `path[A~B]ext:duration` / `path[1~4]ext:[d1*n,d2]` bracket-range
 *    image sequence syntax (`serialization/string_utils.cpp`'s
 *    `square_parenthetical_split`, as used by `progressive_single`/
 *    `progressive_image`) — real unit art uses this pervasively for
 *    multi-frame animations authored as a single `image=` string (e.g.
 *    `units/elves-wood/fighter/fighter-se-run[1~10].png:60`, a 10-frame
 *    running cycle).
 *  - The `from~to:duration,from2~to2:duration2,...` progressive-pair syntax
 *    used by `offset=`/`x=`/`y=`/`blend_ratio=`/`alpha=` (`highlight_ratio`)
 *    — the attack-lunge/movement-slide interpolation curve.
 *  - Direction-based image selection: diagonal directions (NE/SE/NW/SW) use
 *    `image_diagonal=` when present, falling back to `image=`; NW/SW mirror
 *    the NE/SE art horizontally (`unit_frame::redraw`, frame.cpp ~L660-696).
 *  - The on-screen position formula itself
 *    (`x = offset*xdst + (1-offset)*xsrc`, frame.cpp ~L676) as a pure
 *    function of hex-center pixel coordinates, not tied to a live display.
 */

import { Direction } from '@wesnothweb2/engine/src/model/Location.js';
import type { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';

// ── duration parsing ─────────────────────────────────────────────────────────

/**
 * Parses a WML duration value. Real content is almost always a bare integer
 * (milliseconds); a handful of upstream helpers write "1s"-style suffixes,
 * supported here as a cheap nod to `serialization/chrono.cpp`'s
 * `parse_duration` without pulling in its full unit vocabulary.
 */
export function parseDurationMs(raw: string | number): number {
  if (typeof raw === 'number') return raw;
  const s = raw.trim();
  if (s.endsWith('ms')) return Number(s.slice(0, -2)) || 0;
  if (s.endsWith('s')) return (Number(s.slice(0, -1)) || 0) * 1000;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// ── bracket-range sequence syntax (progressive_single) ──────────────────────

interface BracketSpan {
  left: number;
  right: number;
}

function findBracketSpans(zone: string): BracketSpan[] {
  const spans: BracketSpan[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < zone.length; i++) {
    if (zone[i] === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (zone[i] === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        spans.push({ left: start, right: i });
        start = -1;
      }
    }
  }
  return spans;
}

/** Leading-zero padding width, mirroring `get_padding()` in string_utils.cpp. */
function padWidth(token: string): number {
  return token.length > 1 && token[0] === '0' ? token.length - 1 : 0;
}

/** Expands one `[...]` group's interior into its list of string pieces (range/repeat/literal). */
function expandBracketInterior(inner: string): string[] {
  const out: string[] = [];
  for (const rawPiece of inner.split(',')) {
    const piece = rawPiece.trim();
    const tilde = piece.indexOf('~');
    if (tilde !== -1) {
      const sBegin = piece.slice(0, tilde).trim();
      const sEnd = piece.slice(tilde + 1).trim();
      const begin = parseInt(sBegin, 10);
      const end = parseInt(sEnd, 10);
      const padding = Math.max(padWidth(sBegin), padWidth(sEnd));
      const step = end >= begin ? 1 : -1;
      for (let k = begin; k !== end + step; k += step) {
        let s = String(k);
        while (s.length <= padding) s = `0${s}`;
        out.push(s);
      }
      continue;
    }
    const star = piece.indexOf('*');
    if (star !== -1) {
      const value = piece.slice(0, star).trim();
      const count = parseInt(piece.slice(star + 1).trim(), 10) || 0;
      for (let k = 0; k < count; k++) out.push(value);
      continue;
    }
    out.push(piece);
  }
  return out;
}

/** Expands one top-level comma zone's bracket group(s), zipped positionally. Mirrors the inner loop of `square_parenthetical_split`. */
function expandZone(zone: string): string[] {
  const spans = findBracketSpans(zone);
  if (spans.length === 0) return [zone];

  const expansions = spans.map((span) => expandBracketInterior(zone.slice(span.left + 1, span.right)));
  const count = Math.min(...expansions.map((e) => e.length));
  if (!Number.isFinite(count) || count <= 0) return [zone];

  const results: string[] = [];
  for (let j = 0; j < count; j++) {
    let out = '';
    let cursor = 0;
    spans.forEach((span, idx) => {
      out += zone.slice(cursor, span.left);
      out += expansions[idx]![j];
      cursor = span.right + 1;
    });
    out += zone.slice(cursor);
    results.push(out);
  }
  return results;
}

/**
 * TS port of `square_parenthetical_split(val, ',', "[", "]")`: splits on
 * top-level commas, expanding any `[A~B]`/`[a,b,c]`/`[x*N]` bracket group(s)
 * within each comma zone and zipping multiple groups positionally.
 */
export function squareParentheticalSplit(val: string): string[] {
  if (!val) return [];
  if (!val.includes(',') && !val.includes('[')) return [val.trimEnd()];

  const zones: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= val.length; i++) {
    const c = i < val.length ? val[i] : undefined;
    if (i === val.length || (c === ',' && depth === 0)) {
      zones.push(val.slice(start, i));
      start = i + 1;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
    }
  }

  const out: string[] = [];
  for (const zone of zones) out.push(...expandZone(zone));
  return out.map((s) => s.trimEnd());
}

export interface StepSequenceItem {
  /** The expanded value for this step (an image path, or a halo image name). */
  value: string;
  durationMs: number;
}

/**
 * TS port of `progressive_single<T>` (frame_private.hpp): a comma/bracket
 * sequence of values, each optionally followed by `:duration`. Entries
 * without an explicit duration share the remainder of `totalDurationMs`
 * evenly (mirrors the `duration > 1ms` redistribution branch); pass 0 to get
 * upstream's "no total known yet" first-pass behaviour (1ms per unspecified
 * entry, used only to *compute* what the total should be).
 */
export function parseStepSequence(input: string, totalDurationMs = 0): StepSequenceItem[] {
  const pieces = squareParentheticalSplit(input);
  if (pieces.length === 0) return [];

  const parsed = pieces.map((piece) => {
    const idx = piece.lastIndexOf(':');
    if (idx === -1) return { value: piece, durationMs: undefined as number | undefined };
    const durationMs = Number(piece.slice(idx + 1));
    if (!Number.isFinite(durationMs)) return { value: piece, durationMs: undefined as number | undefined };
    return { value: piece.slice(0, idx), durationMs };
  });

  const specifiedTotal = parsed.reduce((sum, p) => sum + (p.durationMs ?? 0), 0);
  const unspecifiedCount = parsed.filter((p) => p.durationMs === undefined).length;

  let fallback = 1;
  if (unspecifiedCount > 0) {
    fallback = totalDurationMs > 1
      ? Math.max(1, Math.floor((totalDurationMs - specifiedTotal) / unspecifiedCount))
      : 1;
  }

  return parsed.map((p) => ({ value: p.value, durationMs: p.durationMs ?? fallback }));
}

function sequenceTotalMs(input: string): number {
  if (!input) return 0;
  return parseStepSequence(input, 0).reduce((sum, item) => sum + item.durationMs, 0);
}

// ── progressive numeric pairs (offset=/x=/y=/blend_ratio=/alpha=) ──────────

export interface ProgressiveSegment {
  from: number;
  to: number;
  durationMs: number;
}

/**
 * TS port of `progressive_pair<T>`: a comma-separated list of
 * `from~to:duration` (or bare `value:duration`, or no duration at all —
 * split evenly across `totalDurationMs`) numeric interpolation segments.
 */
export function parseProgressivePair(input: string, totalDurationMs: number): ProgressiveSegment[] {
  if (!input) return [];
  const parts = input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return [];
  const chunk = Math.max(1, Math.floor(totalDurationMs / parts.length));

  return parts.map((part) => {
    const colon = part.indexOf(':');
    const valuePart = colon === -1 ? part : part.slice(0, colon);
    const durationMs = colon === -1 ? chunk : (Number(part.slice(colon + 1)) || 0);
    const tilde = valuePart.indexOf('~');
    const from = Number(tilde === -1 ? valuePart : valuePart.slice(0, tilde));
    const to = Number(tilde === -1 ? valuePart : valuePart.slice(tilde + 1));
    return { from: Number.isFinite(from) ? from : 0, to: Number.isFinite(to) ? to : (Number.isFinite(from) ? from : 0), durationMs };
  });
}

/** Samples a progressive-pair segment list at `timeMs` into the sequence. Mirrors `progressive_pair::get_current_element`. */
export function sampleProgressivePair(segments: readonly ProgressiveSegment[], timeMs: number): number {
  if (segments.length === 0) return 0;
  const total = segments.reduce((s, seg) => s + seg.durationMs, 0);
  const t = Math.max(0, Math.min(timeMs, total));

  let elapsed = 0;
  let i = 0;
  while (elapsed < t && i < segments.length) {
    elapsed += segments[i]!.durationMs;
    i++;
  }
  if (i !== 0) {
    i--;
    elapsed -= segments[i]!.durationMs;
  }
  const seg = segments[i]!;
  const frac = seg.durationMs > 0 ? (t - elapsed) / seg.durationMs : 0;
  return frac * (seg.to - seg.from) + seg.from;
}

// ── [frame]/[missile_frame] extraction ──────────────────────────────────────

/**
 * One `[frame]`/`[missile_frame]`'s worth of extracted data. Field names
 * mirror `frame_parameters` (frame.hpp); halo/blend fields are carried as
 * raw data (see module doc comment) rather than evaluated into pixels.
 */
export interface UnitFrameDef {
  readonly durationMs: number;
  /** Bracket-range-expanded image sequence for the "facing N/S" (or only) image. */
  readonly image: readonly StepSequenceItem[];
  /** As `image`, for the "facing NE/SE/NW/SW" diagonal art; empty if not authored. */
  readonly imageDiagonal: readonly StepSequenceItem[];
  readonly imageMod: string;
  readonly halo: readonly StepSequenceItem[];
  readonly haloX: readonly ProgressiveSegment[];
  readonly haloY: readonly ProgressiveSegment[];
  readonly haloMod: string;
  readonly sound: string;
  readonly text: string;
  readonly textColor: string;
  readonly blendRatio: readonly ProgressiveSegment[];
  readonly blendColor: string;
  readonly highlightRatio: readonly ProgressiveSegment[];
  readonly offset: readonly ProgressiveSegment[];
  readonly submerge: readonly ProgressiveSegment[];
  readonly x: readonly ProgressiveSegment[];
  readonly y: readonly ProgressiveSegment[];
  readonly directionalX: number;
  readonly directionalY: number;
  readonly layer?: number;
}

function readAttrString(cfg: WmlConfig, key: string): string {
  return cfg.hasAttribute(key) ? cfg.getString(key) : '';
}

/**
 * Builds a `UnitFrameDef`'s fields given an already-known `durationMs`.
 * Shared by `parseFrame` (which computes that duration from the `[frame]`
 * itself) and `unitAnimation.ts`'s animation-wide parameter extraction
 * (which uses the *whole animation's* total duration instead — mirrors
 * `particle::particle`'s own `parameters_ = frame_parsed_parameters(
 * frame_builder(cfg, ""), get_animation_duration())`, animation.cpp ~L972,
 * where the "duration" fed to the progressive-pair parsers is the
 * animation's total, not any one frame's).
 */
export function buildFrameFields(cfg: WmlConfig, durationMs: number): UnitFrameDef {
  const imageStr = readAttrString(cfg, 'image');
  const imageDiagonalStr = readAttrString(cfg, 'image_diagonal');
  const haloStr = readAttrString(cfg, 'halo');

  return {
    durationMs,
    image: parseStepSequence(imageStr, durationMs),
    imageDiagonal: parseStepSequence(imageDiagonalStr, durationMs),
    imageMod: readAttrString(cfg, 'image_mod'),
    halo: parseStepSequence(haloStr, durationMs),
    haloX: parseProgressivePair(readAttrString(cfg, 'halo_x'), durationMs),
    haloY: parseProgressivePair(readAttrString(cfg, 'halo_y'), durationMs),
    haloMod: readAttrString(cfg, 'halo_mod'),
    sound: readAttrString(cfg, 'sound'),
    text: readAttrString(cfg, 'text'),
    textColor: readAttrString(cfg, 'text_color'),
    blendRatio: parseProgressivePair(readAttrString(cfg, 'blend_ratio'), durationMs),
    blendColor: readAttrString(cfg, 'blend_color'),
    highlightRatio: parseProgressivePair(readAttrString(cfg, 'alpha'), durationMs),
    offset: parseProgressivePair(readAttrString(cfg, 'offset'), durationMs),
    submerge: parseProgressivePair(readAttrString(cfg, 'submerge'), durationMs),
    x: parseProgressivePair(readAttrString(cfg, 'x'), durationMs),
    y: parseProgressivePair(readAttrString(cfg, 'y'), durationMs),
    directionalX: cfg.getNumber('directional_x', 0),
    directionalY: cfg.getNumber('directional_y', 0),
    layer: cfg.hasAttribute('layer') ? cfg.getNumber('layer') : undefined,
  };
}

/**
 * TS port of `frame_builder(cfg, "")` + the final `frame_parsed_parameters`
 * reconstruction (frame.cpp L36-109, L226-251): parses a single
 * `[frame]`/`[missile_frame]` config into fully-resolved (correct total
 * duration, correct even-redistribution of un-timed bracket entries) data.
 */
export function parseFrame(cfg: WmlConfig): UnitFrameDef {
  const imageStr = readAttrString(cfg, 'image');
  const imageDiagonalStr = readAttrString(cfg, 'image_diagonal');
  const haloStr = readAttrString(cfg, 'halo');

  // First pass (mirrors frame_builder's own duration-guessing branch): the
  // frame's own duration, if not given explicitly, is the max of its
  // image/image_diagonal/halo sequences' *natural* total (entries without
  // their own ":N" count as a throwaway 1ms at this stage).
  let durationMs: number;
  if (cfg.hasAttribute('duration')) {
    durationMs = parseDurationMs(cfg.get('duration') as string | number);
  } else if (cfg.hasAttribute('end')) {
    const begin = parseDurationMs(cfg.getString('begin', '0'));
    const end = parseDurationMs(cfg.getString('end', '0'));
    durationMs = end - begin;
  } else {
    durationMs = Math.max(
      sequenceTotalMs(imageStr),
      sequenceTotalMs(imageDiagonalStr),
      sequenceTotalMs(haloStr),
    );
  }
  durationMs = Math.max(1, durationMs);

  return buildFrameFields(cfg, durationMs);
}

// ── direction-aware image selection & positioning ──────────────────────────

export interface ResolvedFrameImage {
  readonly sequence: readonly StepSequenceItem[];
  /** True if `image_diagonal` was used in place of `image` (facing NE/SE/NW/SW). */
  readonly usedDiagonal: boolean;
  /** Mirror horizontally: upstream draws the NE/SE diagonal art flipped for NW/SW. */
  readonly hflip: boolean;
}

/**
 * TS port of the image-selection half of `unit_frame::redraw`
 * (frame.cpp ~L660-696): picks `image_diagonal` over `image` for diagonal
 * facings, and reports whether the result needs a horizontal flip (NW/SW
 * mirror the NE/SE art). N/S always use the plain `image`.
 */
export function resolveFrameImage(frame: UnitFrameDef, direction: Direction): ResolvedFrameImage {
  const isDiagonal = direction === Direction.NorthEast || direction === Direction.SouthEast
    || direction === Direction.NorthWest || direction === Direction.SouthWest;
  const hasDiagonalArt = isDiagonal && frame.imageDiagonal.length > 0;

  return {
    sequence: hasDiagonalArt ? frame.imageDiagonal : frame.image,
    usedDiagonal: hasDiagonalArt,
    hflip: direction === Direction.NorthWest || direction === Direction.SouthWest,
  };
}

export interface HexPixelPos {
  x: number;
  y: number;
}

/**
 * TS port of the on-screen position formula in `unit_frame::redraw`
 * (frame.cpp ~L676-677): interpolates between the source and destination
 * hex's pixel centers by `offset` (0 = at src, 1 = at dst) — this is what
 * drives both attack-lunge (attacker slides partway toward the defender)
 * and movement-slide (unit glides from hex to hex) animations.
 */
export function frameCenterPosition(src: HexPixelPos, dst: HexPixelPos, offset: number): HexPixelPos {
  return {
    x: offset * dst.x + (1 - offset) * src.x,
    y: offset * dst.y + (1 - offset) * src.y,
  };
}

/**
 * Stub for the not-yet-visually-implemented parts of a frame (halo
 * compositing, submerge/highlight alpha). `blend_with`/`blend_ratio` is
 * now real -- see module doc comment -- so this no longer covers that
 * one. The *data* for what's left is already extracted faithfully in
 * `UnitFrameDef` above; wiring it into an actual PixiJS-side effect is
 * deferred (see module doc comment) — this exists so call sites have
 * somewhere to hang that work later without pretending it's implemented
 * now.
 */
export function applyFrameEffects(frame: UnitFrameDef): void {
  if (frame.halo.length > 0 || frame.submerge.length > 0) {
    // eslint-disable-next-line no-console
    console.debug('[frame] halo/submerge effects not yet visually implemented', {
      halo: frame.halo.map((h) => h.value),
    });
  }
}
