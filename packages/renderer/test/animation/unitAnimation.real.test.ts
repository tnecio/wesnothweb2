import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWmlFile,
  preloadDefinesFromDir,
  type DefineMap,
} from '@wesnothweb2/engine/src/wml/index.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { TerrainTypeData, NONE_TERRAIN } from '@wesnothweb2/engine/src/model/Terrain.js';
import { UnitType } from '@wesnothweb2/engine/src/model/UnitType.js';
import { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import { Direction, Location } from '@wesnothweb2/engine/src/model/Location.js';
import type { AnimationContext } from '../../src/animation/animationContext.js';
import { chooseAnimation, parseUnitAnimations, selectTopAnimations } from '../../src/animation/unitAnimation.js';

/**
 * Real-content verification, following this project's established standard
 * (see docs/PROGRESS.md): parse real `[unit_type]` WML through the actual
 * WML pipeline (same pattern as `packages/engine/test/model/
 * gameBoardIntegration.test.ts`), extract its real `[attack_anim]`/
 * `[defend]`/`[movement_anim]` blocks, and assert on real filter
 * values/frame counts pulled from the file -- not invented fixtures.
 *
 * Two real core units are used, each chosen for a specific real feature
 * they exercise that a synthetic fixture couldn't verify honestly:
 *  - `data/core/units/elves/Fighter.cfg` (Elvish Fighter): two weapons,
 *    real `[filter_attack]`-per-weapon `[attack_anim]` blocks, a
 *    `[defend]` built from the `DEFENSE_ANIM_RANGE` macro (real `[if]`
 *    hits= branching with no `[else]`), and a `[movement_anim]` using the
 *    `path[1~10].png:60` bracket-range image syntax.
 *  - `data/core/units/merfolk/Fighter.cfg` (Merman Fighter): two
 *    `[attack_anim]` blocks distinguished purely by `direction=` --
 *    exactly the "attack, hit, facing X should match the direction-filtered
 *    block" scenario from the Phase 4 task description.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadDefines(): DefineMap {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  return defines;
}

function loadUnitTypeCfg(relPath: string, defines: DefineMap): WmlConfig {
  const cfg = parseWmlFile(path.join(dataRoot, relPath), { dataRoot, defines: new Map(defines) });
  const ut = cfg.child('unit_type');
  if (!ut) throw new Error(`${relPath}: no [unit_type] found`);
  return ut;
}

/**
 * Builds a real `UnitType` (for its real `[attack]` weapons) from the same
 * config the animations are parsed from. `movement_type=` isn't resolved
 * against a real `[movemetype]` registry here (not needed for animation
 * matching) -- `UnitType.fromConfig` falls back to a default `MoveType`
 * when the id isn't found in the supplied map, which is fine for this test.
 */
function buildUnitType(cfg: WmlConfig): UnitType {
  const terrainData = TerrainTypeData.fromConfigs([]);
  return UnitType.fromConfig(cfg, new Map(), terrainData);
}

const defines = loadDefines();

describe('parseUnitAnimations + matching (real Elvish Fighter content)', () => {
  const cfg = loadUnitTypeCfg('core/units/elves/Fighter.cfg', defines);
  const animations = parseUnitAnimations(cfg);
  const unitType = buildUnitType(cfg);
  const sword = unitType.attacks.find((a) => a.id === 'sword')!;
  const bow = unitType.attacks.find((a) => a.id === 'bow')!;

  it('has both real weapons (sword, bow) parsed from [attack]', () => {
    expect(unitType.attacks.map((a) => a.id).sort()).toEqual(['bow', 'sword']);
  });

  it('parses every real anim block: 1 movement_anim + 3 sword/1 bow attack_anim (each hit/miss-split by SOUND:HIT_AND_MISS) + 1 defend (hit/miss-split by DEFENSE_ANIM_RANGE) x2 ranges + the no-standing_anim default fallback + the generic engine-injected defend hit-flash fallback (2 variants: hit/kill-flash + miss-passthrough)', () => {
    // 1 movement + (3 sword + 1 bow attack_anim blocks) x 2 (hit/miss split) + 2 defend blocks x 3 (miss/hit-or-kill auto-split + the DEFENSE_ANIM_RANGE hit-specific [if] branch) + 1 synthesized default + 2 generic defend fallback (see unitAnimation.ts's own doc comment -- always added, regardless of real content, but low-priority so real [defend] blocks like this unit's own still win).
    expect(animations.length).toBe(1 + 4 * 2 + 2 * 3 + 1 + 2);
  });

  it('registers no "standing" or "default" candidate other than the synthesized fallback (this unit type has no real [standing_anim] -- its idle_anim is commented out in the source)', () => {
    const defaultCandidates = animations.filter((a) => a.events.includes('default'));
    expect(defaultCandidates).toHaveLength(1);
    expect(defaultCandidates[0]!.baseScore).toBe(-9); // DEFAULT_ANIM sentinel
  });

  function makeUnit(): Unit {
    const unit = Unit.create(unitType, 1, new Location(0, 0));
    unit.facing = Direction.SouthEast;
    return unit;
  }

  it('an "attack" event with the sword weapon only matches sword-filtered [attack_anim] blocks, never the bow ones', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'attack',
      value: 5, value2: 0, hit: 'hit', attack: sword, secondAttack: undefined,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top.length).toBeGreaterThan(0);
    for (const anim of top) {
      expect(anim.primaryAttackFilters.some((f) => f.getString('name') === 'sword')).toBe(true);
    }
  });

  it('"attack, hit, sword" selects exactly the 3 tied hit-scored sword [attack_anim] variants (one per authored block, real content has no direction= filter on this unit so all 3 tie)', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'attack',
      value: 5, value2: 0, hit: 'hit', attack: sword, secondAttack: undefined,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top).toHaveLength(3);
    for (const anim of top) {
      expect(anim.hits).toEqual(['hit', 'kill']);
      expect(anim.frames.length).toBeGreaterThan(0);
    }
    // Real frame counts from the file: two blocks have 3 frames (melee-1, melee-2/3/4, fighter.png),
    // one has 2 (melee-1~4 combined into a single [frame], then fighter.png).
    expect(top.map((a) => a.frames.length).sort()).toEqual([2, 2, 3]);
  });

  it('"attack, miss, sword" selects the miss-scored variants instead (disjoint from the hit set)', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'attack',
      value: 0, value2: 0, hit: 'miss', attack: sword, secondAttack: undefined,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top).toHaveLength(3);
    for (const anim of top) expect(anim.hits).toEqual(['miss']);
  });

  it('"attack, hit, bow" selects only the bow-filtered variant, with its real 3-frame missile+swing sequence', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'attack',
      value: 3, value2: 0, hit: 'hit', attack: bow, secondAttack: undefined,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top).toHaveLength(1);
    expect(top[0]!.primaryAttackFilters[0]!.getString('name')).toBe('bow');
    expect(top[0]!.frames).toHaveLength(3);
    expect(top[0]!.missileFrames).toHaveLength(1);
    expect(top[0]!.missileFrames[0]!.image[0]!.value).toBe('projectiles/missile-n.png');
  });

  it('"defend, hit, melee" prefers the DEFENSE_ANIM_RANGE-authored hits=hit branch (score 0) over the auto-split hit-or-kill fallback (score -1)', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'defend',
      value: 5, value2: 0, hit: 'hit', attack: sword, secondAttack: sword,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const chosen = chooseAnimation(animations, ctx);
    expect(chosen).toBeDefined();
    expect(chosen!.hits).toEqual(['hit']);
    expect(chosen!.baseScore).toBe(0);
    // Real frame content from DEFENSE_ANIM_RANGE: {BASE_IMAGE}:1,{REACTION_IMAGE}:250,{BASE_IMAGE}:1 -- one [frame] tag with 3 bracket-expanded images.
    expect(chosen!.frames).toHaveLength(1);
    expect(chosen!.frames[0]!.image).toHaveLength(3);
    expect(chosen!.frames[0]!.image.map((i) => i.durationMs)).toEqual([1, 250, 1]);
  });

  it('"defend, miss, melee" falls back to the auto-split miss variant (no author-provided miss-specific branch exists)', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'defend',
      value: 0, value2: 0, hit: 'miss', attack: sword, secondAttack: sword,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top).toHaveLength(1);
    expect(top[0]!.hits).toEqual(['miss']);
    expect(top[0]!.baseScore).toBe(-1);
  });

  it('"defend" against a ranged weapon only matches the range=ranged [defend] block, never the range=melee one', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'defend',
      value: 3, value2: 0, hit: 'hit', attack: bow, secondAttack: sword,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top.length).toBeGreaterThan(0);
    for (const anim of top) {
      expect(anim.primaryAttackFilters[0]!.getString('range')).toBe('ranged');
    }
  });

  it('"movement" selects the real 10-frame bracket-range running cycle, 60ms per frame', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'movement',
      value: 0, value2: 0, hit: 'invalid', terrainAtLoc: NONE_TERRAIN,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top).toHaveLength(1);
    const frame = top[0]!.frames[0]!;
    expect(frame.image).toHaveLength(10);
    expect(frame.durationMs).toBe(600);
    expect(frame.image.every((i) => i.durationMs === 60)).toBe(true);
    expect(frame.image[0]!.value).toBe('units/elves-wood/fighter/fighter-se-run1.png');
  });

  it('an unmatched event (no such anim authored) returns no candidates', () => {
    const unit = makeUnit();
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'teaching',
      value: 0, value2: 0, hit: 'invalid', terrainAtLoc: NONE_TERRAIN,
    };
    expect(selectTopAnimations(animations, ctx)).toHaveLength(0);
  });
});

describe('direction-filtered [attack_anim] selection (real Merman Fighter content)', () => {
  const cfg = loadUnitTypeCfg('core/units/merfolk/Fighter.cfg', defines);
  const animations = parseUnitAnimations(cfg);
  const unitType = buildUnitType(cfg);
  const trident = unitType.attacks.find((a) => a.id === 'trident')!;

  function makeUnit(facing: Direction): Unit {
    const unit = Unit.create(unitType, 1, new Location(0, 0));
    unit.facing = facing;
    return unit;
  }

  it('facing south-east matches the direction=se,sw [attack_anim] block (real 8-frame swing, an animation-wide lunge offset)', () => {
    const unit = makeUnit(Direction.SouthEast);
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'attack',
      value: 6, value2: 0, hit: 'hit', attack: trident, secondAttack: undefined,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top).toHaveLength(1);
    expect(top[0]!.directions).toEqual([Direction.SouthEast, Direction.SouthWest]);
    expect(top[0]!.frames[0]!.image).toHaveLength(8); // fighter-attack-[1~6,2,1].png
    // The animation-wide offset=0~0.3,0.3~0 (attack-lunge curve) lives at
    // the [attack_anim] level, not on the [frame] itself (see
    // UnitAnimationDef.animationParams's doc comment) -- distributed evenly
    // across the block's real 600ms total (8 frames * 75ms).
    expect(top[0]!.animationParams.offset).toEqual([
      { from: 0, to: 0.3, durationMs: 300 },
      { from: 0.3, to: 0, durationMs: 300 },
    ]);
  });

  it('facing north matches the direction=n,ne,nw,s [attack_anim] block instead (real 3-frame idle-ish swing)', () => {
    const unit = makeUnit(Direction.North);
    const ctx: AnimationContext = {
      loc: unit.location, secondLoc: unit.location, myUnit: unit, event: 'attack',
      value: 6, value2: 0, hit: 'hit', attack: trident, secondAttack: undefined,
      terrainAtLoc: NONE_TERRAIN, secondUnit: undefined,
    };
    const top = selectTopAnimations(animations, ctx);
    expect(top).toHaveLength(1);
    expect(top[0]!.directions).toEqual([Direction.North, Direction.NorthEast, Direction.NorthWest, Direction.South]);
    expect(top[0]!.frames.map((f) => f.durationMs)).toEqual([50, 250, 50]);
  });
});
