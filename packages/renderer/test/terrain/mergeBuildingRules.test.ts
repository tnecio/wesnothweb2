import { describe, expect, it } from 'vitest'
import { mergeBuildingRules, ownTerrainGraphicsRules, type BuildingRule } from '../../src/terrain/terrainGraphicsRules'

/** C1: a campaign's and a scenario's own rules join core's as upstream's `multiset<building_rule>` holds them. */
const rule = (name: string, precedence: number, local = false) => ({ name, precedence, local }) as unknown as BuildingRule
const names = (rules: readonly BuildingRule[]) => rules.map((r) => (r as unknown as { name: string }).name)

describe('mergeBuildingRules', () => {
  it('orders by precedence, core first among equals, then the campaign, then the scenario', () => {
    const core = [rule('c-10', -10), rule('c0a', 0), rule('c0b', 0), rule('c5', 5)]
    const own = ownTerrainGraphicsRules({
      campaignTerrainGraphicsRules: [rule('camp0', 0), rule('camp-20', -20)],
      scenarioTerrainGraphicsRules: [rule('scen0', 0, true), rule('scen5', 5, true)],
    })
    expect(names(own)).toEqual(['camp-20', 'camp0', 'scen0', 'scen5'])
    expect(names(mergeBuildingRules(core, own))).toEqual(['camp-20', 'c-10', 'c0a', 'c0b', 'camp0', 'scen0', 'c5', 'scen5'])
  })

  it('is the core list itself when there is nothing to add', () => {
    const core = [rule('a', 0)]
    expect(mergeBuildingRules(core, [])).toBe(core)
  })
})
