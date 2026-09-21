import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '@wesnothweb2/engine/src/wml/index.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { Direction } from '@wesnothweb2/engine/src/model/Location.js';
import { parseUnitAnimations, selectTopAnimations, type UnitAnimationDef } from '../../src/animation/unitAnimation.js';
import type { AnimationContext } from '../../src/animation/animationContext.js';
import { buildFrameFields, parseFrame } from '../../src/animation/frame.js';
import { animationDurationMs, sampleAnimation } from '../../src/animation/playback.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadUnitTypeCfg(relPath: string): WmlConfig {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, relPath), { dataRoot, defines });
  const ut = cfg.child('unit_type');
  if (!ut) throw new Error(`${relPath}: no [unit_type] found`);
  return ut;
}

/** A minimal hand-built two-frame animation with an explicit per-frame offset, for exact timing/position math -- not tied to any real content. */
function makeTwoFrameAnim(): UnitAnimationDef {
  const frameACfg = new WmlConfig();
  frameACfg.setAttribute('image', 'a1.png:50,a2.png:50'); // 100ms total, two sub-images
  frameACfg.setAttribute('offset', '0~0.5'); // frame-local offset, sampled over this frame's own 100ms.
  const frameA = parseFrame(frameACfg);

  const frameBCfg = new WmlConfig();
  frameBCfg.setAttribute('image', 'b1.png:80');
  const frameB = parseFrame(frameBCfg); // no offset of its own -> falls back to the animation-wide one.

  const animCfg = new WmlConfig();
  animCfg.setAttribute('offset', '0.5~0'); // animation-wide fallback, sampled over the WHOLE animation's elapsed time.
  return {
    events: ['test'],
    baseScore: 0,
    terrainTypes: [],
    directions: [],
    value: [],
    hits: [],
    value2: [],
    unitFilters: [],
    secondaryUnitFilters: [],
    primaryAttackFilters: [],
    secondaryAttackFilters: [],
    frequency: 0,
    frames: [frameA, frameB],
    missileFrames: [],
    animationParams: buildFrameFields(animCfg, 180), // 100 (frame A) + 80 (frame B)
    usesDefaultMovementOffset: false,
  };
}

describe('animationDurationMs', () => {
  it('sums every frame\'s own duration', () => {
    expect(animationDurationMs(makeTwoFrameAnim())).toBe(180);
  });
});

describe('sampleAnimation (hand-built, exact timing/offset math)', () => {
  const anim = makeTwoFrameAnim();
  const src = { x: 0, y: 0 };
  const dst = { x: 100, y: 0 };

  it('at t=0: frame A, first sub-image, offset=0 (at src)', () => {
    const s = sampleAnimation(anim, Direction.South, 0, src, dst);
    expect(s.imagePath).toBe('a1.png');
    expect(s.x).toBe(0);
  });

  it('at t=50 (into frame A\'s second sub-image, still frame A\'s own offset segment): offset interpolates using frame A\'s own 0~0.5 curve over its own 100ms, i.e. 50% through -> offset 0.25', () => {
    const s = sampleAnimation(anim, Direction.South, 50, src, dst);
    expect(s.imagePath).toBe('a2.png');
    expect(s.x).toBeCloseTo(25, 5); // offset 0.25 of the way from x=0 to x=100.
  });

  it('at t=100 (start of frame B, which has no offset of its own): falls back to the animation-wide 0.5~0 offset, sampled over the WHOLE elapsed time (100/180), not frame B\'s own (just-started) time', () => {
    const s = sampleAnimation(anim, Direction.South, 100, src, dst);
    expect(s.imagePath).toBe('b1.png');
    const expectedOffset = 0.5 + (100 / 180) * (0 - 0.5); // sampleProgressivePair's linear interpolation over the single animation-wide segment.
    expect(s.x).toBeCloseTo(expectedOffset * 100, 5);
  });

  it('at t >= total duration: clamps to the last frame\'s final state rather than returning nothing', () => {
    const s = sampleAnimation(anim, Direction.South, 999, src, dst);
    expect(s.imagePath).toBe('b1.png');
  });

  it('an animation with zero frames samples to the source position with no image', () => {
    const empty: UnitAnimationDef = { ...anim, frames: [] };
    const s = sampleAnimation(empty, Direction.South, 0, src, dst);
    expect(s.imagePath).toBeNull();
    expect(s).toMatchObject({ x: 0, y: 0 });
  });
});

describe('sampleAnimation (real Merman Fighter [attack_anim], data/core/units/merfolk/Fighter.cfg)', () => {
  const cfg = loadUnitTypeCfg('core/units/merfolk/Fighter.cfg');
  const animations = parseUnitAnimations(cfg);

  it('a real se-facing trident attack lunges toward the defender (offset=0~0.3,0.3~0) and cycles its real bracket-range image sequence', () => {
    const ctx: AnimationContext = {
      loc: { x: 0, y: 0, wmlX: 1, wmlY: 1 } as never,
      secondLoc: { x: 1, y: 0, wmlX: 2, wmlY: 1 } as never,
      myUnit: { facing: Direction.SouthEast } as never,
      event: 'attack',
      value: 6,
      value2: 0,
      hit: 'hit',
      attack: { id: 'trident', name: 'trident' } as never,
      secondAttack: undefined,
      terrainAtLoc: { base: 0, overlay: 0 } as never,
      secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    const seAnim = top.find((a) => a.directions.includes(Direction.SouthEast));
    expect(seAnim).toBeDefined();

    const src = { x: 0, y: 0 };
    const dst = { x: 100, y: 0 };
    const total = animationDurationMs(seAnim!);
    expect(total).toBeGreaterThan(0);

    const start = sampleAnimation(seAnim!, Direction.SouthEast, 0, src, dst);
    expect(start.imagePath).toContain('fighter-attack-');
    expect(start.x).toBeCloseTo(0, 3); // offset starts at 0 (still at src).

    // Real offset=0~0.3,0.3~0 splits the total duration into two equal
    // halves: first half ramps 0->0.3 (lunging in), second half 0.3->0
    // (returning) -- so the midpoint of the FIRST half is partway lunged
    // in, strictly between src and dst.
    const quarter = sampleAnimation(seAnim!, Direction.SouthEast, total / 4, src, dst);
    expect(quarter.x).toBeGreaterThan(0);
    expect(quarter.x).toBeLessThan(30); // offset caps at 0.3 -> at most 30% of the way to dst.

    const end = sampleAnimation(seAnim!, Direction.SouthEast, total, src, dst);
    expect(end.x).toBeCloseTo(0, 3); // real trident attack returns fully to src by the end.
  });
});
