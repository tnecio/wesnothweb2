import { describe, expect, it } from 'vitest'
import {
  ENERGY_BAR,
  energyBarHeight,
  energyBarFilled,
  hpColor,
  KILL_EXPERIENCE,
  xpColor,
  DEFAULT_HP_BAR_SCALING,
  DEFAULT_XP_BAR_SCALING,
  movesOrbStatus,
  ORB_COLOR,
  ORB_COLOR_ID,
  statusBlend,
  blendColorMatrix,
  ellipseImageBase,
} from '../src/unitOverlays'

/**
 * Real-value tests for unitOverlays.ts's color/geometry math -- each
 * expected value is transcribed directly from the real C++ it ports
 * (units/drawer.cpp's energy_bar/draw_bar, units/unit.cpp's hp_color_impl/
 * xp_color, display_context.cpp's unit_orb_status), not re-derived from
 * this module's own code.
 */

describe('energyBarHeight / energyBarFilled (units/drawer.cpp energy_bar)', () => {
  it('height is size*scaling, truncated (int cast, not rounded)', () => {
    expect(energyBarHeight(48, DEFAULT_HP_BAR_SCALING)).toBe(Math.floor(48 * 0.666)); // 31
    expect(energyBarHeight(7, DEFAULT_HP_BAR_SCALING)).toBe(4); // 7*0.666=4.662 -> 4, not 5
  })

  it('filled is size/max clamped to [0,1]', () => {
    expect(energyBarFilled(0, 30)).toBe(0)
    expect(energyBarFilled(15, 30)).toBe(0.5)
    expect(energyBarFilled(30, 30)).toBe(1)
    expect(energyBarFilled(999, 30)).toBe(1) // overheal clamps
    expect(energyBarFilled(5, 0)).toBe(0) // no div-by-zero
  })
})

describe('hpColor (units/unit.cpp hp_color_impl)', () => {
  it('matches every real threshold exactly', () => {
    expect(hpColor(30, 30)).toBe(0x21e100) // == 1.0
    expect(hpColor(35, 30)).toBe(0x64ff64) // > 1.0 (overheal)
    expect(hpColor(25, 30)).toBe(0xaaff00) // 0.833 >= 0.75
    expect(hpColor(15, 30)).toBe(0xffaf00) // 0.5 >= 0.5
    expect(hpColor(10, 30)).toBe(0xff9b00) // 0.333 >= 0.25
    expect(hpColor(1, 30)).toBe(0xff0000) // < 0.25
    expect(hpColor(0, 30)).toBe(0xff0000)
  })
})

describe('xpColor (units/unit.cpp xp_color, can_advance=true branch)', () => {
  it('matches every real kill_experience-relative threshold', () => {
    expect(KILL_EXPERIENCE).toBe(8)
    expect(xpColor(8)).toBe(0xffffff) // near: <= 8
    expect(xpColor(16)).toBe(0x96ffff) // mid: <= 16
    expect(xpColor(24)).toBe(0x00cdcd) // far: <= 24
    expect(xpColor(25)).toBe(0x00a0e1) // beyond far: default blue
    expect(xpColor(1000)).toBe(0x00a0e1)
  })
})

describe('movesOrbStatus (display_context::unit_orb_status, collapsed to 3 states)', () => {
  it('unmoved: full moves AND full attacks (checked before canMove/canAttackHere)', () => {
    expect(movesOrbStatus(6, 6, 2, 2, true, true)).toBe('unmoved')
  })
  it('moved: no moves AND no attacks left', () => {
    expect(movesOrbStatus(0, 6, 0, 2, false, false)).toBe('moved')
  })
  it('real, reported bug: a unit with moves left but no reachable hex, and no attack possible, is "moved" (red) not "partial" (yellow)', () => {
    expect(movesOrbStatus(3, 6, 0, 2, false, false)).toBe('moved')
  })
  it('partial: anything else, including the real disengaged case (can move or attack, but not fully unmoved)', () => {
    expect(movesOrbStatus(3, 6, 2, 2, true, true)).toBe('partial') // moved some, can still attack
    expect(movesOrbStatus(3, 6, 0, 2, true, false)).toBe('partial') // moved some, no attacks, but can still move (real "disengaged")
    expect(movesOrbStatus(6, 6, 0, 2, true, false)).toBe('partial') // full moves, no attacks, can still move (real "disengaged")
    expect(movesOrbStatus(0, 6, 2, 2, false, true)).toBe('partial') // no moves left, but can still attack from here
  })
  it('every status has a distinct real ORB_COLOR entry', () => {
    expect(new Set(Object.values(ORB_COLOR)).size).toBe(3)
  })
  it('ORB_COLOR_ID matches the real default *_orb_color preferences (data/game_config.cfg)', () => {
    expect(ORB_COLOR_ID).toEqual({ unmoved: 'brightgreen', partial: 'brightorange', moved: 'red' })
  })
})

describe('statusBlend (units/drawer.cpp redraw_unit poison/slow blend)', () => {
  it('no status: nothing to blend', () => {
    expect(statusBlend(false, false)).toBeNull()
  })
  it('poisoned: 25% toward pure green', () => {
    expect(statusBlend(true, false)).toEqual({ color: 0x00ff00, ratio: 0.25 })
  })
  it('slowed: 25% toward pale blue (191,191,255)', () => {
    expect(statusBlend(false, true)).toEqual({ color: 0xbfbfff, ratio: 0.25 })
  })
  it('both: colors averaged, ratio averaged', () => {
    expect(statusBlend(true, true)).toEqual({ color: (96 << 16) | (223 << 8) | 128, ratio: 0.25 })
  })
})

describe('blendColorMatrix', () => {
  // Apply the 5x4 matrix to an unpremultiplied 0-1 rgba pixel, as PixiJS's shader does.
  const apply = (m: number[], px: number[]): number[] =>
    [0, 1, 2, 3].map((row) => m[row * 5]! * px[0]! + m[row * 5 + 1]! * px[1]! + m[row * 5 + 2]! * px[2]! + m[row * 5 + 3]! * px[3]! + m[row * 5 + 4]!)
  it('lifts a black pixel a quarter of the way to the slowed blue -- visible, unlike a multiply tint', () => {
    const out = apply(blendColorMatrix({ color: 0xbfbfff, ratio: 0.25 }), [0, 0, 0, 1])
    expect(out[0]).toBeCloseTo((191 / 255) * 0.25)
    expect(out[2]).toBeCloseTo(0.25)
    expect(out[3]).toBe(1)
  })
  it('keeps alpha, so transparent pixels stay transparent', () => {
    expect(apply(blendColorMatrix({ color: 0x00ff00, ratio: 0.25 }), [1, 1, 1, 0])[3]).toBe(0)
  })
})

describe('ENERGY_BAR real geometry constants (units/drawer.cpp)', () => {
  it('matches the real def_origin/def_w/spacing', () => {
    expect(ENERGY_BAR.originX).toBe(14)
    expect(ENERGY_BAR.originY).toBe(13)
    expect(ENERGY_BAR.width).toBe(4)
    expect(ENERGY_BAR.spacing).toBe(5) // def_w + 1
  })
})

describe('setOrbColorIds', () => {
  it('overrides the orb colours by status and can put the defaults back', async () => {
    const { ORB_COLOR_ID, setOrbColorIds } = await import('../src/unitOverlays');
    setOrbColorIds({ unmoved: 'blue', moved: 'purple' });
    expect(ORB_COLOR_ID).toEqual({ unmoved: 'blue', partial: 'brightorange', moved: 'purple' });
    setOrbColorIds({ unmoved: 'brightgreen', moved: 'red' });
    expect(ORB_COLOR_ID).toEqual({ unmoved: 'brightgreen', partial: 'brightorange', moved: 'red' });
  });
});

describe('ellipseImageBase (unit_drawer::draw_ellipses)', () => {
  it('builds the stock ellipse name from leader, zoc and selection', () => {
    expect(ellipseImageBase({ canRecruit: false }, false)).toBe('engine/misc/ellipse');
    expect(ellipseImageBase({ canRecruit: true }, false)).toBe('engine/misc/ellipse-leader');
    expect(ellipseImageBase({ canRecruit: true, emitsZoc: false }, true)).toBe('engine/misc/ellipse-leader-nozoc-selected');
    expect(ellipseImageBase({ canRecruit: false, ellipse: 'misc/ellipse-hero' }, true)).toBe('engine/misc/ellipse-hero-selected');
  });

  it('draws nothing for ellipse=none', () => {
    expect(ellipseImageBase({ canRecruit: true, ellipse: 'none' }, true)).toBeNull();
  });
});
