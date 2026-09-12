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
  statusTint,
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
  it('unmoved: full moves AND full attacks', () => {
    expect(movesOrbStatus(6, 6, 2, 2)).toBe('unmoved')
  })
  it('moved: no moves AND no attacks left', () => {
    expect(movesOrbStatus(0, 6, 0, 2)).toBe('moved')
  })
  it('partial: anything else, including the real disengaged case (moved some, no attacks)', () => {
    expect(movesOrbStatus(3, 6, 2, 2)).toBe('partial') // moved some, can still attack
    expect(movesOrbStatus(3, 6, 0, 2)).toBe('partial') // moved some, no attacks (real "disengaged")
    expect(movesOrbStatus(6, 6, 0, 2)).toBe('partial') // full moves, no attacks (real "disengaged")
  })
  it('every status has a distinct real ORB_COLOR entry', () => {
    expect(new Set(Object.values(ORB_COLOR)).size).toBe(3)
  })
})

describe('statusTint (units/drawer.cpp redraw_unit poison/slow blend)', () => {
  it('no status: no-op white tint', () => {
    expect(statusTint(false, false)).toBe(0xffffff)
  })
  it('poisoned alone: a real, non-white green-leaning tint', () => {
    const tint = statusTint(true, false)
    expect(tint).not.toBe(0xffffff)
    const g = (tint >> 8) & 0xff
    const r = (tint >> 16) & 0xff
    expect(g).toBeGreaterThan(r) // green channel boosted relative to red
  })
  it('slowed alone: a real, non-white blue-leaning tint', () => {
    const tint = statusTint(false, true)
    expect(tint).not.toBe(0xffffff)
    const b = tint & 0xff
    const r = (tint >> 16) & 0xff
    expect(b).toBeGreaterThan(r) // blue channel boosted relative to red
  })
  it('both: distinct from either alone (real averaged blend, not just one winning)', () => {
    const both = statusTint(true, true)
    expect(both).not.toBe(statusTint(true, false))
    expect(both).not.toBe(statusTint(false, true))
    expect(both).not.toBe(0xffffff)
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
