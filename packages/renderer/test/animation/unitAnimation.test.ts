import { describe, expect, it } from 'vitest';
import { Direction, Location } from '@wesnothweb2/engine/src/model/Location.js';
import { GRASS_LAND, MOUNTAIN } from '@wesnothweb2/engine/src/model/Terrain.js';
import { AttackType, UnitType } from '@wesnothweb2/engine/src/model/UnitType.js';
import { MoveType } from '@wesnothweb2/engine/src/model/MoveType.js';
import { TerrainTypeData } from '@wesnothweb2/engine/src/model/Terrain.js';
import { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import { WmlConfig, type WmlAttributeValue } from '@wesnothweb2/engine/src/wml/config.js';
import type { AnimationContext } from '../../src/animation/animationContext.js';
import {
  attackMatchesFilter,
  expandAnimationBranches,
  MATCH_FAIL,
  matchAnimation,
  parseUnitAnimations,
  selectTopAnimations,
} from '../../src/animation/unitAnimation.js';

/**
 * Isolated unit tests for matching/branch-expansion edge cases the two real
 * units in `unitAnimation.real.test.ts` don't happen to exercise (nested
 * `[if]`/`[else]`, `frequency=` rejection, terrain/value/value2 filters,
 * `[filter_second]` requiring a second unit). WML shapes here are
 * hand-built but follow real WML syntax throughout (not invented fields).
 */

function wml(attrs: Record<string, WmlAttributeValue> = {}, children: Array<[string, WmlConfig]> = []): WmlConfig {
  const cfg = new WmlConfig();
  for (const [k, v] of Object.entries(attrs)) cfg.setAttribute(k, v);
  for (const [tag, child] of children) cfg.addChild(tag, child);
  return cfg;
}

function makeUnitType(id: string): UnitType {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
  return new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 10, -1, 500, [], '', true, false, false, moveType, [], []);
}

describe('expandAnimationBranches ([if]/[else] port, animation.cpp prepare_single_animation)', () => {
  it('a lone [if] (no [else]) yields both the unbranched original and the if-branch', () => {
    const anim = wml({ start_time: -100 }, [
      ['frame', wml({ image: 'a.png' })],
      ['if', wml({ hits: 'hit' }, [['hit_sound_frame', wml({ sound: 'x.ogg' })]])],
    ]);
    const branches = expandAnimationBranches(anim);
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => b.attrs.get('hits'))).toEqual([undefined, 'hit']);
    // Both branches carry the [frame] that came before the [if].
    for (const b of branches) expect(b.children.some((c) => c.tag === 'frame')).toBe(true);
    // Only the if-branch carries the [hit_sound_frame] nested inside it.
    expect(branches[0]!.children.some((c) => c.tag === 'hit_sound_frame')).toBe(false);
    expect(branches[1]!.children.some((c) => c.tag === 'hit_sound_frame')).toBe(true);
  });

  it('an [if]/[else] pair is exhaustive: only the two branches survive, not a third unbranched one', () => {
    const anim = wml({}, [
      ['if', wml({ hits: 'yes' })],
      ['else', wml({ hits: 'no' })],
    ]);
    const branches = expandAnimationBranches(anim);
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => b.attrs.get('hits')).sort()).toEqual(['no', 'yes']);
  });

  it('children after the [if]/[else] block are appended to every resulting branch', () => {
    const anim = wml({}, [
      ['if', wml({ direction: 'n' })],
      ['else', wml({ direction: 's' })],
      ['frame', wml({ image: 'tail.png' })],
    ]);
    const branches = expandAnimationBranches(anim);
    expect(branches).toHaveLength(2);
    for (const b of branches) {
      expect(b.children.map((c) => c.tag)).toEqual(['frame']);
      expect(b.children[0]!.config.getString('image')).toBe('tail.png');
    }
  });

  it('nested [if] inside an [if] branch multiplies out correctly', () => {
    const anim = wml({}, [
      ['if', wml({ hits: 'yes' }, [
        ['if', wml({ direction: 'n' })],
        ['else', wml({ direction: 's' })],
      ])],
    ]);
    const branches = expandAnimationBranches(anim);
    // base (unbranched, no [else] at the outer level) + 2 inner combinations = 3.
    expect(branches).toHaveLength(3);
    const withHits = branches.filter((b) => b.attrs.get('hits') === 'yes');
    expect(withHits.map((b) => b.attrs.get('direction')).sort()).toEqual(['n', 's']);
  });
});

describe('attackMatchesFilter ([filter_attack] port, attack_type::matches_simple_filter)', () => {
  const sword = AttackType.fromConfig(wml({ name: 'sword', type: 'blade', range: 'melee', damage: 8, number: 3 }));

  it('matches a plain range= filter', () => {
    expect(attackMatchesFilter(sword, wml({ range: 'melee' }))).toBe(true);
    expect(attackMatchesFilter(sword, wml({ range: 'ranged' }))).toBe(false);
  });

  it('matches numeric range-list filters (damage=, number=)', () => {
    expect(attackMatchesFilter(sword, wml({ damage: '5-10' }))).toBe(true);
    expect(attackMatchesFilter(sword, wml({ damage: '9-10' }))).toBe(false);
    expect(attackMatchesFilter(sword, wml({ number: '1,3,5' }))).toBe(true);
  });

  it('composes [and]/[or]/[not] with in-order precedence', () => {
    const andFilter = wml({ range: 'melee' }, [['and', wml({ type: 'blade' })]]);
    expect(attackMatchesFilter(sword, andFilter)).toBe(true);

    const notFilter = wml({ range: 'melee' }, [['not', wml({ type: 'blade' })]]);
    expect(attackMatchesFilter(sword, notFilter)).toBe(false);

    const orFilter = wml({ range: 'ranged' }, [['or', wml({ type: 'blade' })]]);
    expect(attackMatchesFilter(sword, orFilter)).toBe(true);
  });
});

describe('matchAnimation (unit_animation::matches_headless port) -- edge cases', () => {
  const unitType = makeUnitType('Tester');
  const unit = Unit.create(unitType, 1, new Location(0, 0));
  unit.facing = Direction.North;

  function baseCtx(overrides: Partial<AnimationContext> = {}): AnimationContext {
    return {
      loc: unit.location,
      secondLoc: unit.location,
      myUnit: unit,
      event: 'attack',
      value: 0,
      value2: 0,
      hit: 'invalid',
      terrainAtLoc: GRASS_LAND,
      ...overrides,
    };
  }

  it('terrain_type= rejects a non-matching terrain and accepts a matching one', () => {
    const cfg = wml({ apply_to: 'attack', terrain_type: 'Mm' }, [['frame', wml({ image: 'a.png' })]]);
    const [anim] = parseUnitAnimations(wml({}, [['animation', cfg]]));
    expect(matchAnimation(anim!, baseCtx({ terrainAtLoc: GRASS_LAND }))).toBe(MATCH_FAIL);
    expect(matchAnimation(anim!, baseCtx({ terrainAtLoc: MOUNTAIN }))).toBeGreaterThan(MATCH_FAIL);
  });

  it('value= and value_second= reject non-matching numbers', () => {
    const cfg = wml({ apply_to: 'attack', value: '5,10', value_second: '1' }, [['frame', wml({ image: 'a.png' })]]);
    const [anim] = parseUnitAnimations(wml({}, [['animation', cfg]]));
    expect(matchAnimation(anim!, baseCtx({ value: 7, value2: 1 }))).toBe(MATCH_FAIL);
    expect(matchAnimation(anim!, baseCtx({ value: 5, value2: 2 }))).toBe(MATCH_FAIL);
    expect(matchAnimation(anim!, baseCtx({ value: 10, value2: 1 }))).toBeGreaterThan(MATCH_FAIL);
  });

  it('[filter_second] requires a secondUnit to be present at all', () => {
    const cfg = wml({ apply_to: 'attack' }, [
      ['frame', wml({ image: 'a.png' })],
      ['filter_second', wml({ side: 2 })],
    ]);
    const [anim] = parseUnitAnimations(wml({}, [['animation', cfg]]));
    expect(matchAnimation(anim!, baseCtx({ secondUnit: undefined }))).toBe(MATCH_FAIL);

    const ally = Unit.create(unitType, 2, new Location(1, 0));
    expect(matchAnimation(anim!, baseCtx({ secondUnit: ally }))).toBeGreaterThan(MATCH_FAIL);
  });

  it('frequency= only rejects when a getRandomInt is supplied, and only on a 0 roll', () => {
    const cfg = wml({ apply_to: 'attack', frequency: 2 }, [['frame', wml({ image: 'a.png' })]]);
    const [anim] = parseUnitAnimations(wml({}, [['animation', cfg]]));

    // No rng supplied -> frequency check skipped entirely (deterministic default).
    expect(matchAnimation(anim!, baseCtx())).toBeGreaterThan(MATCH_FAIL);

    expect(matchAnimation(anim!, baseCtx(), { getRandomInt: () => 0 })).toBe(MATCH_FAIL);
    expect(matchAnimation(anim!, baseCtx(), { getRandomInt: () => 1 })).toBeGreaterThan(MATCH_FAIL);
  });

  it('a generic [animation] block can declare multiple apply_to events', () => {
    const cfg = wml({ apply_to: 'attack,defend' }, [['frame', wml({ image: 'a.png' })]]);
    const [anim] = parseUnitAnimations(wml({}, [['animation', cfg]]));
    expect(anim!.events).toEqual(['attack', 'defend']);
    expect(matchAnimation(anim!, baseCtx({ event: 'attack' }))).toBeGreaterThan(MATCH_FAIL);
    expect(matchAnimation(anim!, baseCtx({ event: 'defend' }))).toBeGreaterThan(MATCH_FAIL);
    expect(matchAnimation(anim!, baseCtx({ event: 'death' }))).toBe(MATCH_FAIL);
  });

  it('selectTopAnimations returns only the tied maximum, not every passing candidate', () => {
    const low = wml({ apply_to: 'attack', base_score: 0 }, [['frame', wml({ image: 'a.png' })]]);
    const high = wml({ apply_to: 'attack', base_score: 5 }, [['frame', wml({ image: 'b.png' })]]);
    const unitTypeCfg = wml({}, [['animation', low], ['animation', high]]);
    const anims = parseUnitAnimations(unitTypeCfg);
    const top = selectTopAnimations(anims, baseCtx());
    expect(top).toHaveLength(1);
    expect(top[0]!.baseScore).toBe(5);
  });
});

describe('parseUnitAnimations: real add_anims offset= defaulting for movement_anim/attack_anim (animation.cpp ~L765/~L834)', () => {
  it('a [movement_anim] with no offset= gets the real repeating 0~1:200 default -- most real content (e.g. Elvish Fighter) relies on this to slide at all', () => {
    const cfg = wml({}, [['movement_anim', wml({}, [['frame', wml({ image: 'walk.png' })]])]]);
    const [anim] = parseUnitAnimations(cfg);
    expect(anim!.events).toEqual(['movement']);
    expect(anim!.animationParams.offset.length).toBe(34);
    expect(anim!.animationParams.offset[0]).toEqual({ from: 0, to: 1, durationMs: 200 });
  });

  it('a [movement_anim] that DOES declare its own offset= is left alone', () => {
    const cfg = wml({}, [['movement_anim', wml({ offset: '0~1' }, [['frame', wml({ image: 'walk.png' })]])]]);
    const [anim] = parseUnitAnimations(cfg);
    expect(anim!.animationParams.offset).toHaveLength(1);
  });

  it('an [attack_anim] with no offset= and no [missile_frame] gets the real 0~0.6,0.6~0 melee lunge default', () => {
    const cfg = wml({}, [['attack_anim', wml({}, [['frame', wml({ image: 'swing.png:200' })]])]]);
    const [anim] = parseUnitAnimations(cfg);
    expect(anim!.events).toEqual(['attack']);
    expect(anim!.animationParams.offset).toEqual([
      { from: 0, to: 0.6, durationMs: 100 },
      { from: 0.6, to: 0, durationMs: 100 },
    ]);
  });

  it('an [attack_anim] with a [missile_frame] does NOT get the melee lunge default (a ranged weapon has its own missile_offset= handling instead, out of scope here)', () => {
    const cfg = wml({}, [['attack_anim', wml({}, [['frame', wml({ image: 'bow.png' })], ['missile_frame', wml({ image: 'arrow.png' })]])]]);
    const [anim] = parseUnitAnimations(cfg);
    expect(anim!.animationParams.offset).toEqual([]);
  });

  it('an [attack_anim] that DOES declare its own offset= is left alone (real Merman Fighter case)', () => {
    const cfg = wml({}, [['attack_anim', wml({ offset: '0~0.3,0.3~0' }, [['frame', wml({ image: 'trident.png' })]])]]);
    const [anim] = parseUnitAnimations(cfg);
    expect(anim!.animationParams.offset).toHaveLength(2);
    expect(anim!.animationParams.offset[0]!.to).toBe(0.3);
  });
});
