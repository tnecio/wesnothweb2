import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '@wesnothweb2/engine/src/wml/index.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { Direction } from '@wesnothweb2/engine/src/model/Location.js';
import { parseUnitAnimations, selectTopAnimations, type UnitAnimationDef } from '../../src/animation/unitAnimation.js';
import type { AnimationContext } from '../../src/animation/animationContext.js';
import { buildFrameFields, parseFrame } from '../../src/animation/frame.js';
import { animationDurationMs, animationTimeline, sampleAnimation, sampleParticles, sampleUnitHalo } from '../../src/animation/playback.js';

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
    startTimeMs: 0,
    missileFrames: [],
    particles: [],
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

describe('particles and halos (bugs6.md: particle effects missing)', () => {
  /** An `[attack_anim]` with a projectile and a halo, parsed through `parseUnitAnimations` so upstream's missile defaults apply. */
  function projectileAttack(): UnitAnimationDef {
    const unitType = new WmlConfig();
    const attack = unitType.addChild('attack_anim');
    const frame = attack.addChild('frame');
    frame.setAttribute('begin', -200);
    frame.setAttribute('duration', 400);
    frame.setAttribute('image', 'units/test-attack.png');
    frame.setAttribute('halo', 'halo/test-flare.png');
    frame.setAttribute('halo_x', 10);
    const missile = attack.addChild('missile_frame');
    missile.setAttribute('begin', -150);
    missile.setAttribute('duration', 150);
    missile.setAttribute('image', 'projectiles/test-n.png');
    missile.setAttribute('image_diagonal', 'projectiles/test-ne.png');
    return parseUnitAnimations(unitType).find((a) => a.events.includes('attack'))!;
  }
  const src = { x: 0, y: 0 };
  const north = { x: 0, y: -72 };

  it('the timeline spans the unit frames and the missile, on the clock where the blow lands at 0', () => {
    const anim = projectileAttack();
    expect(anim.startTimeMs).toBe(-200);
    expect(anim.particles.map((p) => p.startTimeMs)).toEqual([-150]);
    expect(animationTimeline(anim)).toEqual({ startMs: -200, endMs: 200 });
  });

  it('the missile flies from the attacker toward the target, only while its frames run', () => {
    const anim = projectileAttack();
    expect(sampleParticles(anim, Direction.North, -180, src, north)).toEqual([]); // not launched yet
    const early = sampleParticles(anim, Direction.North, -140, src, north)[0]!;
    const late = sampleParticles(anim, Direction.North, -10, src, north)[0]!;
    expect(early.path).toBe('projectiles/test-n.png');
    expect(late.y).toBeLessThan(early.y); // moving north
    expect(late.y).toBeGreaterThan(north.y * 0.8 - 1); // the default 0~0.8 offset stops short of the target
    expect(sampleParticles(anim, Direction.North, 50, src, north)).toEqual([]); // gone after it lands
  });

  it('flips the missile like upstream: diagonal art, mirrored west, upside-down facing south', () => {
    const anim = projectileAttack();
    const sw = sampleParticles(anim, Direction.SouthWest, -75, src, { x: -54, y: 36 })[0]!;
    expect(sw.path).toBe('projectiles/test-ne.png');
    expect(sw.hflip).toBe(true);
    expect(sw.vflip).toBe(true);
    const n = sampleParticles(anim, Direction.North, -75, src, north)[0]!;
    expect(n.hflip).toBe(false);
    expect(n.vflip).toBe(false);
  });

  it("the unit frame's halo sits at halo_x, mirrored when facing west, and only during the frame", () => {
    const anim = projectileAttack();
    expect(sampleUnitHalo(anim, Direction.NorthEast, 0, src)).toEqual({ path: 'halo/test-flare.png', x: 10, y: 0, hflip: false, vflip: false });
    expect(sampleUnitHalo(anim, Direction.NorthWest, 0, src)).toMatchObject({ x: -10, hflip: true });
    expect(sampleUnitHalo(anim, Direction.North, -250, src)).toBeNull();
    expect(sampleUnitHalo(anim, Direction.North, 250, src)).toBeNull();
  });
});

describe('sampleAnimation alpha= (highlight_ratio)', () => {
  it("fades the Skeleton's recruit animation in from transparent, then draws it opaque", () => {
    const anims = parseUnitAnimations(loadUnitTypeCfg('core/units/undead/Skeleton.cfg'));
    const recruit = anims.find((a) => a.events.includes('recruited'))!;
    expect(recruit).toBeDefined();
    const at = { x: 0, y: 0 };
    // Frame 1 is `alpha="0~1:300"` from the animation's start (start_time=-200).
    expect(sampleAnimation(recruit, Direction.South, 0, at, at).alpha).toBeCloseTo(0, 5);
    expect(sampleAnimation(recruit, Direction.South, 150, at, at).alpha).toBeCloseTo(0.5, 1);
    // Frame 2 sets no alpha: fully drawn.
    expect(sampleAnimation(recruit, Direction.South, 350, at, at).alpha).toBe(1);
  });

  it('is 1 when nothing sets it', () => {
    const at = { x: 0, y: 0 };
    expect(sampleAnimation(makeTwoFrameAnim(), Direction.South, 10, at, at).alpha).toBe(1);
  });
});
