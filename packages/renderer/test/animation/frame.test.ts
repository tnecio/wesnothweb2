import { describe, expect, it } from 'vitest';
import { Direction } from '@wesnothweb2/engine/src/model/Location.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import {
  frameCenterPosition,
  parseFrame,
  parseProgressivePair,
  parseStepSequence,
  resolveFrameImage,
  sampleProgressivePair,
  squareParentheticalSplit,
} from '../../src/animation/frame.js';

/**
 * These strings are copied verbatim from real content (verified against
 * `wesnoth/data/core/units/elves/Fighter.cfg` and `.../merfolk/Fighter.cfg`
 * — see `test/animation/unitAnimation.real.test.ts` for the same unit types
 * parsed end-to-end through the real WML pipeline). Testing the bracket
 * expansion against real strings, not invented ones, is what caught the
 * `hits=yes/no` boolean-coercion bug during development (see
 * `unitAnimation.ts`'s `bhits` helper).
 */
describe('squareParentheticalSplit (units/frame.cpp square_parenthetical_split port)', () => {
  it('expands a single range bracket with a shared trailing duration (Elvish Fighter movement_anim)', () => {
    expect(squareParentheticalSplit('units/elves-wood/fighter/fighter-se-run[1~10].png:60')).toEqual([
      'units/elves-wood/fighter/fighter-se-run1.png:60',
      'units/elves-wood/fighter/fighter-se-run2.png:60',
      'units/elves-wood/fighter/fighter-se-run3.png:60',
      'units/elves-wood/fighter/fighter-se-run4.png:60',
      'units/elves-wood/fighter/fighter-se-run5.png:60',
      'units/elves-wood/fighter/fighter-se-run6.png:60',
      'units/elves-wood/fighter/fighter-se-run7.png:60',
      'units/elves-wood/fighter/fighter-se-run8.png:60',
      'units/elves-wood/fighter/fighter-se-run9.png:60',
      'units/elves-wood/fighter/fighter-se-run10.png:60',
    ]);
  });

  it('zips two bracket groups positionally, including "*N" repeat syntax (Elvish Fighter bow attack_anim)', () => {
    expect(squareParentheticalSplit('units/elves-wood/fighter/fighter-bow-attack[1~4].png:[75*2,100,130]')).toEqual([
      'units/elves-wood/fighter/fighter-bow-attack1.png:75',
      'units/elves-wood/fighter/fighter-bow-attack2.png:75',
      'units/elves-wood/fighter/fighter-bow-attack3.png:100',
      'units/elves-wood/fighter/fighter-bow-attack4.png:130',
    ]);
  });

  it('expands a literal comma list inside brackets (Elvish Fighter sword attack_anim)', () => {
    expect(squareParentheticalSplit('units/elves-wood/fighter/fighter-melee-[2,3,4].png:[80,80,125]')).toEqual([
      'units/elves-wood/fighter/fighter-melee-2.png:80',
      'units/elves-wood/fighter/fighter-melee-3.png:80',
      'units/elves-wood/fighter/fighter-melee-4.png:125',
    ]);
  });

  it('handles a range that repeats a value out of order (Merman Fighter attack_anim)', () => {
    expect(squareParentheticalSplit('units/merfolk/fighter-attack-[1~6,2,1].png:75')).toEqual([
      'units/merfolk/fighter-attack-1.png:75',
      'units/merfolk/fighter-attack-2.png:75',
      'units/merfolk/fighter-attack-3.png:75',
      'units/merfolk/fighter-attack-4.png:75',
      'units/merfolk/fighter-attack-5.png:75',
      'units/merfolk/fighter-attack-6.png:75',
      'units/merfolk/fighter-attack-2.png:75',
      'units/merfolk/fighter-attack-1.png:75',
    ]);
  });

  it('passes through a plain path with no comma/bracket unchanged', () => {
    expect(squareParentheticalSplit('units/elves-wood/fighter/fighter-bow.png:65')).toEqual([
      'units/elves-wood/fighter/fighter-bow.png:65',
    ]);
  });

  it('returns an empty list for an empty string', () => {
    expect(squareParentheticalSplit('')).toEqual([]);
  });
});

describe('parseStepSequence (progressive_single port)', () => {
  it('splits value:duration pairs from an expanded sequence', () => {
    expect(parseStepSequence('units/elves-wood/fighter/fighter-bow-attack[1~4].png:[75*2,100,130]', 0)).toEqual([
      { value: 'units/elves-wood/fighter/fighter-bow-attack1.png', durationMs: 75 },
      { value: 'units/elves-wood/fighter/fighter-bow-attack2.png', durationMs: 75 },
      { value: 'units/elves-wood/fighter/fighter-bow-attack3.png', durationMs: 100 },
      { value: 'units/elves-wood/fighter/fighter-bow-attack4.png', durationMs: 130 },
    ]);
  });

  it('distributes total duration evenly across entries missing an explicit duration', () => {
    // Neither sub-image specifies its own ":N" -- both should get an equal
    // share of a supplied 600ms total (mirrors progressive_single's
    // `duration > 1ms` redistribution branch, frame_private.hpp ~L165-184).
    expect(parseStepSequence('a.png,b.png', 600)).toEqual([
      { value: 'a.png', durationMs: 300 },
      { value: 'b.png', durationMs: 300 },
    ]);
  });

  it('returns an empty list for an empty input', () => {
    expect(parseStepSequence('', 500)).toEqual([]);
  });
});

describe('parseProgressivePair / sampleProgressivePair (progressive_pair port)', () => {
  it('parses explicit from~to:duration segments (Elvish Fighter sword attack_anim offset=)', () => {
    const segments = parseProgressivePair('0.0:125,0.0~0.6:150,0.6~0.0:180', 0);
    expect(segments).toEqual([
      { from: 0, to: 0, durationMs: 125 },
      { from: 0, to: 0.6, durationMs: 150 },
      { from: 0.6, to: 0, durationMs: 180 },
    ]);
  });

  it('distributes evenly across the total when no segment specifies its own duration (Merman Fighter offset=0~0.3,0.3~0)', () => {
    const segments = parseProgressivePair('0~0.3,0.3~0', 600);
    expect(segments).toEqual([
      { from: 0, to: 0.3, durationMs: 300 },
      { from: 0.3, to: 0, durationMs: 300 },
    ]);
  });

  it('samples linearly within a segment and clamps outside the total range', () => {
    const segments = parseProgressivePair('0~0.6:150,0.6~0:180', 0);
    expect(sampleProgressivePair(segments, 0)).toBeCloseTo(0);
    expect(sampleProgressivePair(segments, 75)).toBeCloseTo(0.3);
    expect(sampleProgressivePair(segments, 150)).toBeCloseTo(0.6);
    expect(sampleProgressivePair(segments, 150 + 90)).toBeCloseTo(0.3);
    expect(sampleProgressivePair(segments, 100000)).toBeCloseTo(0); // clamped to the last segment's end
  });

  it('returns 0 for an empty segment list', () => {
    expect(sampleProgressivePair([], 42)).toBe(0);
  });
});

function frameConfig(attrs: Record<string, string | number | boolean>): WmlConfig {
  const cfg = new WmlConfig();
  for (const [k, v] of Object.entries(attrs)) cfg.setAttribute(k, v);
  return cfg;
}

describe('parseFrame', () => {
  it('computes total duration from an un-timed image sequence when no duration= is given (Elvish Fighter movement_anim)', () => {
    const frame = parseFrame(frameConfig({ image: 'units/elves-wood/fighter/fighter-se-run[1~10].png:60' }));
    expect(frame.durationMs).toBe(600);
    expect(frame.image).toHaveLength(10);
    expect(frame.image[0]).toEqual({ value: 'units/elves-wood/fighter/fighter-se-run1.png', durationMs: 60 });
    expect(frame.image[9]).toEqual({ value: 'units/elves-wood/fighter/fighter-se-run10.png', durationMs: 60 });
  });

  it('honours an explicit duration= over the image sequence', () => {
    const frame = parseFrame(frameConfig({ image: 'a.png', duration: 65 }));
    expect(frame.durationMs).toBe(65);
    expect(frame.image).toEqual([{ value: 'a.png', durationMs: 65 }]);
  });

  it('extracts image_diagonal/halo/offset/x/y as data without evaluating them (missile_frame-shaped example)', () => {
    const frame = parseFrame(frameConfig({
      duration: 150,
      image: 'projectiles/missile-n.png',
      image_diagonal: 'projectiles/missile-ne.png',
      halo: 'halo/aura-1.png',
      offset: '0~1',
      x: '2',
      y: '-3',
    }));
    expect(frame.imageDiagonal).toEqual([{ value: 'projectiles/missile-ne.png', durationMs: 150 }]);
    expect(frame.halo).toEqual([{ value: 'halo/aura-1.png', durationMs: 150 }]);
    expect(frame.offset).toEqual([{ from: 0, to: 1, durationMs: 150 }]);
    expect(frame.x).toEqual([{ from: 2, to: 2, durationMs: 150 }]);
    expect(frame.y).toEqual([{ from: -3, to: -3, durationMs: 150 }]);
  });
});

describe('resolveFrameImage (direction-aware image selection, unit_frame::redraw port)', () => {
  const frame = parseFrame(frameConfig({
    duration: 100,
    image: 'unit-n.png',
    image_diagonal: 'unit-ne.png',
  }));

  it('uses image_diagonal (no flip) for NE', () => {
    const r = resolveFrameImage(frame, Direction.NorthEast);
    expect(r.usedDiagonal).toBe(true);
    expect(r.hflip).toBe(false);
    expect(r.sequence[0]!.value).toBe('unit-ne.png');
  });

  it('uses image_diagonal mirrored (hflip) for NW', () => {
    const r = resolveFrameImage(frame, Direction.NorthWest);
    expect(r.usedDiagonal).toBe(true);
    expect(r.hflip).toBe(true);
    expect(r.sequence[0]!.value).toBe('unit-ne.png');
  });

  it('falls back to the plain image for N/S even when image_diagonal exists', () => {
    expect(resolveFrameImage(frame, Direction.North).usedDiagonal).toBe(false);
    expect(resolveFrameImage(frame, Direction.South).usedDiagonal).toBe(false);
  });

  it('falls back to the plain image for a diagonal direction when no image_diagonal was authored', () => {
    const plain = parseFrame(frameConfig({ duration: 100, image: 'unit-n.png' }));
    const r = resolveFrameImage(plain, Direction.SouthEast);
    expect(r.usedDiagonal).toBe(false);
    expect(r.sequence[0]!.value).toBe('unit-n.png');
  });
});

describe('frameCenterPosition (attack-lunge/movement-slide position formula, unit_frame::redraw port)', () => {
  it('is at src when offset=0 and dst when offset=1', () => {
    const src = { x: 100, y: 200 };
    const dst = { x: 180, y: 240 };
    expect(frameCenterPosition(src, dst, 0)).toEqual({ x: 100, y: 200 });
    expect(frameCenterPosition(src, dst, 1)).toEqual({ x: 180, y: 240 });
  });

  it('interpolates linearly in between', () => {
    const src = { x: 0, y: 0 };
    const dst = { x: 100, y: 50 };
    expect(frameCenterPosition(src, dst, 0.3)).toEqual({ x: 30, y: 15 });
  });
});
