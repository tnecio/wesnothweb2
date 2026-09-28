import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefines, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { TerrainTypeData, parseTerrainCode } from '../../src/model/Terrain.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import {
  collectUnitTypeConfigs,
  collectMovementTypeConfigs,
  collectSpecialRegistry,
  flattenUnitTypeConfig,
  flattenAllUnitTypes,
} from '../../src/model/UnitTypeDatabase.js';

/**
 * Real-content tests for the `base_unit=`/`[male]`/`[female]`-aware
 * `[unit_type]` flattening loader (`model/UnitTypeDatabase.ts`), the piece
 * `packages/engine/src/model/UnitType.ts`'s own module doc comment
 * explicitly deferred ("a loader building `UnitType`s from parsed WML
 * should do the equivalent flattening before calling `UnitType.
 * fromConfig`"). Parses the actual `wesnoth/data/core/units.cfg` and
 * Dead_Water's own unit files -- not synthetic fixtures -- and spot-checks
 * hand-read real stats, matching this project's established verification
 * discipline (see docs/PROGRESS.md).
 *
 * The `[base_unit]`-inheritance path is covered both by real content
 * (Liberty's `units/Villagers.cfg`, which reskins Thug/Bandit/Highwayman as
 * Peasant/Village-Elder/Senior-Village-Elder via exactly this tag) and by a
 * synthetic test below for the parts real content doesn't happen to
 * exercise (multi-level chains, circular-chain detection). `[male]`/
 * `[female]`-wholesale-ignore is synthetic-only (see its own test).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const campaignDir = path.join(dataRoot, 'campaigns/Dead_Water');

function loadDefines(): DefineMap {
  const defines: DefineMap = new Map();
  const flag = (name: string) =>
    defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<test>' });
  flag('CAMPAIGN_DEAD_WATER');
  flag('NORMAL');
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot });
  return defines;
}

describe('collectUnitTypeConfigs / collectMovementTypeConfigs (real data/core/units.cfg + Dead_Water)', () => {
  const defines = loadDefines();
  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(defines) });
  const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));

  const coreUnitsCfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(defines) });
  const campaignMainCfg = parseWmlFile(path.join(campaignDir, '_main.cfg'), { dataRoot, defines: new Map(defines) });

  const rawUnitTypes = collectUnitTypeConfigs(coreUnitsCfg);
  collectUnitTypeConfigs(campaignMainCfg, rawUnitTypes);

  const movementTypes = collectMovementTypeConfigs(coreUnitsCfg);
  collectMovementTypeConfigs(campaignMainCfg, movementTypes);

  it('finds hundreds of real unit types, including Dead_Water-specific ones not in core', () => {
    expect(rawUnitTypes.size).toBeGreaterThan(300);
    expect(rawUnitTypes.has('Merman Fighter')).toBe(true);
    expect(rawUnitTypes.has('Merman Child King')).toBe(true); // campaigns/Dead_Water/units/Child_King.cfg, not core
  });

  it('finds all 38 real [movetype] blocks (they live inside units.cfg\'s own [units] block, not a separate file)', () => {
    expect(movementTypes.size).toBe(38);
    expect(movementTypes.has('swimmer')).toBe(true);
    expect(movementTypes.has('undeadfoot')).toBe(true);
  });

  it('swimmer movetype matches the real WML exactly (hand-read from units.cfg lines 966-1008)', () => {
    const swimmer = movementTypes.get('swimmer')!;
    const costs = swimmer.child('movement_costs')!;
    expect(costs.getNumber('deep_water')).toBe(1);
    expect(costs.getNumber('flat')).toBe(2);
    expect(costs.getNumber('reef')).toBe(2);
    const defense = swimmer.child('defense')!;
    expect(defense.getNumber('deep_water')).toBe(50);
    expect(defense.getNumber('flat')).toBe(70);
    const resistance = swimmer.child('resistance')!;
    expect(resistance.getNumber('cold')).toBe(80);
  });

  it('undeadfoot movetype matches the real WML exactly (hand-read from units.cfg lines 1155-1199)', () => {
    const undeadfoot = movementTypes.get('undeadfoot')!;
    const costs = undeadfoot.child('movement_costs')!;
    expect(costs.getNumber('deep_water')).toBe(3);
    expect(costs.getNumber('flat')).toBe(1);
  });

  describe('flattening + UnitType.fromConfig against hand-read real stats', () => {
    function flatUnitType(id: string): UnitType {
      const flatCfg = flattenUnitTypeConfig(id, rawUnitTypes);
      return UnitType.fromConfig(flatCfg, movementTypes, terrainData);
    }

    it('Merman Fighter (core/units/merfolk/Fighter.cfg): hp 36, movement 6, one trident pierce 6x3, cost 14', () => {
      const t = flatUnitType('Merman Fighter');
      expect(t.hitpoints).toBe(36);
      expect(t.movement).toBe(6);
      expect(t.level).toBe(1);
      expect(t.cost).toBe(14);
      expect(t.advancesTo).toEqual(['Merman Warrior']);
      expect(t.attacks).toHaveLength(1);
      expect(t.attacks[0]!.id).toBe('trident');
      expect(t.attacks[0]!.type).toBe('pierce');
      expect(t.attacks[0]!.damage).toBe(6);
      expect(t.attacks[0]!.numAttacks).toBe(3);
    });

    it('Merman Child King (campaigns/Dead_Water/units/Child_King.cfg, NOT core): hp 22, movement 6, one scepter impact 4x3, cost 8, level 0', () => {
      const t = flatUnitType('Merman Child King');
      expect(t.hitpoints).toBe(22);
      expect(t.movement).toBe(6);
      expect(t.level).toBe(0);
      expect(t.cost).toBe(8);
      expect(t.attacks).toHaveLength(1);
      expect(t.attacks[0]!.id).toBe('scepter');
      expect(t.attacks[0]!.type).toBe('impact');
      expect(t.attacks[0]!.damage).toBe(4);
      expect(t.attacks[0]!.numAttacks).toBe(3);
    });

    it('Skeleton (core/units/undead/Skeleton.cfg): hp 34, movement_type undeadfoot, movement 5, one axe blade 7x3, advances_to Revenant/Deathblade', () => {
      const t = flatUnitType('Skeleton');
      expect(t.hitpoints).toBe(34);
      expect(t.movement).toBe(5);
      expect(t.level).toBe(1);
      expect(t.cost).toBe(15);
      expect(t.advancesTo).toEqual(['Revenant', 'Deathblade']);
      expect(t.attacks).toHaveLength(1);
      expect(t.attacks[0]!.type).toBe('blade');
      expect(t.attacks[0]!.damage).toBe(7);
      // Real per-type movement/defense resolution -- undeadfoot's own table
      // (deep_water=3, flat=1, hand-read from units.cfg), not a shared flat stub.
      expect(t.moveType.movementCost(parseTerrainCode('Wo'))).toBe(3);
      expect(t.moveType.movementCost(parseTerrainCode('Gg'))).toBe(1);
    });

    it('Dark Sorcerer (core/units/undead/Necro_Dark_Sorcerer.cfg): hp 48, level 2, cost 34, THREE real attacks (staff/chill wave/shadow wave)', () => {
      const t = flatUnitType('Dark Sorcerer');
      expect(t.hitpoints).toBe(48);
      expect(t.level).toBe(2);
      expect(t.cost).toBe(34);
      expect(t.advancesTo).toEqual(['Lich', 'Necromancer']);
      expect(t.attacks).toHaveLength(3);
      expect(t.attacks.map((a) => a.id)).toEqual(['staff', 'chill wave', 'shadow wave']);
      expect(t.attacks[1]!.type).toBe('cold');
      expect(t.attacks[1]!.damage).toBe(13);
      expect(t.attacks[1]!.numAttacks).toBe(2);
    });

    it('[male]/[female]-bearing real types (Black Horse, Dark Horse -- the only two under data/core/units/ that use these tags at all) get their stats from the TOP-LEVEL config, unaffected by ignoring [male]/[female]', () => {
      const blackHorse = flatUnitType('Black Horse');
      expect(blackHorse.hitpoints).toBe(48);
      expect(blackHorse.attacks).toHaveLength(2);
      expect(blackHorse.attacks[0]!.id).toBe('hooves');
      expect(blackHorse.attacks[0]!.damage).toBe(12);

      const darkHorse = flatUnitType('Dark Horse');
      expect(darkHorse.hitpoints).toBe(30);
      expect(darkHorse.attacks[0]!.damage).toBe(9);
    });
  });

});

describe('[base_unit] against real Liberty content (units/Villagers.cfg reskins Thug/Bandit/Highwayman)', () => {
  const defines = loadDefines();
  const libertyDir = path.join(dataRoot, 'campaigns/Liberty');
  const libertyDefines: DefineMap = new Map(defines);
  libertyDefines.set('CAMPAIGN_LIBERTY', {
    name: 'CAMPAIGN_LIBERTY',
    params: [],
    optionalParams: new Map(),
    body: '',
    dir: dataRoot,
    location: '<test>',
  });
  preloadDefines(path.join(libertyDir, '_main.cfg'), libertyDefines, { dataRoot });

  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(libertyDefines) });
  const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));
  const coreUnitsCfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(libertyDefines) });
  const libertyMainCfg = parseWmlFile(path.join(libertyDir, '_main.cfg'), { dataRoot, defines: new Map(libertyDefines) });

  const rawUnitTypes = collectUnitTypeConfigs(coreUnitsCfg);
  collectUnitTypeConfigs(libertyMainCfg, rawUnitTypes);
  const movementTypes = collectMovementTypeConfigs(coreUnitsCfg);
  collectMovementTypeConfigs(libertyMainCfg, movementTypes);

  it('Bandit_Peasant ([base_unit] id=Bandit) inherits Bandit\'s real hp/movement/attacks, but keeps its own overridden name/advances_to', () => {
    expect(rawUnitTypes.get('Bandit_Peasant')!.child('base_unit')!.getString('id')).toBe('Bandit');
    const bandit = UnitType.fromConfig(flattenUnitTypeConfig('Bandit', rawUnitTypes), movementTypes, terrainData);
    const flat = flattenUnitTypeConfig('Bandit_Peasant', rawUnitTypes);
    const banditPeasant = UnitType.fromConfig(flat, movementTypes, terrainData);

    // Inherited from the real Bandit base type -- NOT left at defaults (this
    // is exactly the bug this test regresses: Liberty's Baldras rendered as
    // a blank white placeholder circle with hp 1/1 and no image before this
    // loader read [base_unit] as a child tag rather than a base_unit=
    // attribute real Wesnoth never actually emits).
    expect(banditPeasant.hitpoints).toBe(bandit.hitpoints);
    expect(banditPeasant.movement).toBe(bandit.movement);
    expect(banditPeasant.attacks).toHaveLength(bandit.attacks.length);
    expect(banditPeasant.attacks[0]!.damage).toBe(bandit.attacks[0]!.damage);
    expect(flat.getString('image')).toBe(rawUnitTypes.get('Bandit')!.getString('image'));

    // Overridden on the derived side, not inherited.
    expect(flat.getString('name')).toBe('Village Elder');
    expect(flat.getString('advances_to')).toBe('Highwayman_Peasant');
  });
});

describe('flattenUnitTypeConfig / flattenAllUnitTypes: [base_unit] inheritance (synthetic -- see this file\'s doc comment on why)', () => {
  function unitTypeCfg(attrs: Record<string, string | number | boolean>, children: Record<string, WmlConfig> = {}): WmlConfig {
    const cfg = new WmlConfig();
    for (const [k, v] of Object.entries(attrs)) cfg.setAttribute(k, v);
    for (const [tag, child] of Object.entries(children)) cfg.addChild(tag, child);
    return cfg;
  }
  /** Builds the real `[base_unit] id=<baseId> [/base_unit]` child tag (`types.cpp`: `base_unit["id"]`). */
  function baseUnitTag(baseId: string): WmlConfig {
    const cfg = new WmlConfig();
    cfg.setAttribute('id', baseId);
    return cfg;
  }
  function attackCfg(name: string, damage: number, number: number): WmlConfig {
    const cfg = new WmlConfig();
    cfg.setAttribute('name', name);
    cfg.setAttribute('damage', damage);
    cfg.setAttribute('number', number);
    return cfg;
  }

  it('attribute-level: derived wins wherever it sets an attribute directly, base fills in the rest', () => {
    const raw = new Map<string, WmlConfig>();
    raw.set('Base Fighter', unitTypeCfg({ id: 'Base Fighter', hitpoints: 30, movement: 5, cost: 10, level: 1 }));
    raw.set(
      'Elite Fighter',
      unitTypeCfg({ id: 'Elite Fighter', hitpoints: 45 /* overrides */ }, { base_unit: baseUnitTag('Base Fighter') }),
    );

    const flat = flattenUnitTypeConfig('Elite Fighter', raw);
    expect(flat.getNumber('hitpoints')).toBe(45); // derived's own value wins
    expect(flat.getNumber('movement')).toBe(5); // inherited from base, unset on derived
    expect(flat.getNumber('cost')).toBe(10); // inherited
    expect(flat.getNumber('level')).toBe(1); // inherited
  });

  it('child tags: the derived type\'s Nth child of a tag MERGES INTO the base\'s Nth, extras are appended, unpaired base children stay (config::merge_with)', () => {
    const raw = new Map<string, WmlConfig>();
    raw.set(
      'Base Fighter',
      unitTypeCfg({ id: 'Base Fighter', hitpoints: 30 }, {}),
    );
    const base = raw.get('Base Fighter')!;
    base.addChild('attack', attackCfg('sword', 5, 3));
    base.addChild('attack', attackCfg('bow', 3, 2));
    const defenseBase = base.addChild('defense');
    defenseBase.setAttribute('forest', 40);

    const derived = unitTypeCfg({ id: 'Elite Fighter' }, { base_unit: baseUnitTag('Base Fighter') });
    derived.addChild('attack', attackCfg('greatsword', 9, 2));
    raw.set('Elite Fighter', derived);

    const flat = flattenUnitTypeConfig('Elite Fighter', raw);
    // The one declared attack merges onto the base's FIRST attack; the
    // base's second survives untouched (upstream `config::merge_with`,
    // config.cpp:1097 -- pairing is per tag, by position).
    expect(flat.children('attack').map((a) => a.getString('name'))).toEqual(['greatsword', 'bow']);
    expect(flat.children('attack')[0]!.getNumber('damage')).toBe(9);
    expect(flat.children('attack')[1]!.getNumber('damage')).toBe(3);
    // defense: derived has none -> inherits base's wholesale
    expect(flat.hasChild('defense')).toBe(true);
    expect(flat.child('defense')!.getNumber('forest')).toBe(40);
  });

  it('a partial override keeps the base child\'s other attributes -- the shape real reskins use', () => {
    const raw = new Map<string, WmlConfig>();
    const base = unitTypeCfg({ id: 'Footpad-like', hitpoints: 30 }, {});
    const attack = base.addChild('attack', attackCfg('club', 5, 2));
    attack.setAttribute('type', 'impact');
    attack.setAttribute('range', 'melee');
    raw.set('Footpad-like', base);

    // Exactly Liberty's Footpad_Peasant shape: "same club, weaker".
    const derived = unitTypeCfg({ id: 'Peasant-like' }, { base_unit: baseUnitTag('Footpad-like') });
    const weaker = new WmlConfig();
    weaker.setAttribute('damage', 4);
    derived.addChild('attack', weaker);
    raw.set('Peasant-like', derived);

    const flat = flattenUnitTypeConfig('Peasant-like', raw);
    const merged = flat.children('attack')[0]!;
    expect(merged.getNumber('damage')).toBe(4); // the override
    expect(merged.getString('name')).toBe('club'); // everything else survives
    expect(merged.getString('range')).toBe('melee');
    expect(merged.getString('type')).toBe('impact');
    expect(merged.getNumber('number')).toBe(2);
  });

  it('a `__remove=yes` child deletes the base\'s child at that position instead of merging into it', () => {
    const raw = new Map<string, WmlConfig>();
    const base = unitTypeCfg({ id: 'Two Attacks', hitpoints: 30 }, {});
    base.addChild('attack', attackCfg('sword', 5, 3));
    base.addChild('attack', attackCfg('bow', 3, 2));
    raw.set('Two Attacks', base);

    const derived = unitTypeCfg({ id: 'Swordless' }, { base_unit: baseUnitTag('Two Attacks') });
    const removal = new WmlConfig();
    removal.setAttribute('__remove', true);
    derived.addChild('attack', removal);
    raw.set('Swordless', derived);

    const flat = flattenUnitTypeConfig('Swordless', raw);
    expect(flat.children('attack').map((a) => a.getString('name'))).toEqual(['bow']);
  });

  it('recursive base_unit chains flatten correctly (grandparent -> parent -> child)', () => {
    const raw = new Map<string, WmlConfig>();
    raw.set('Grandparent', unitTypeCfg({ id: 'Grandparent', hitpoints: 20, movement: 4, cost: 5 }));
    raw.set('Parent', unitTypeCfg({ id: 'Parent', hitpoints: 30 }, { base_unit: baseUnitTag('Grandparent') }));
    raw.set('Child', unitTypeCfg({ id: 'Child', movement: 6 }, { base_unit: baseUnitTag('Parent') }));

    const flat = flattenUnitTypeConfig('Child', raw);
    expect(flat.getNumber('hitpoints')).toBe(30); // from Parent
    expect(flat.getNumber('movement')).toBe(6); // Child's own
    expect(flat.getNumber('cost')).toBe(5); // from Grandparent, through Parent
  });

  it('throws on a circular base_unit chain rather than infinite-looping', () => {
    const raw = new Map<string, WmlConfig>();
    raw.set('A', unitTypeCfg({ id: 'A' }, { base_unit: baseUnitTag('B') }));
    raw.set('B', unitTypeCfg({ id: 'B' }, { base_unit: baseUnitTag('A') }));
    expect(() => flattenUnitTypeConfig('A', raw)).toThrow(/circular/i);
  });

  it('throws on an unknown id', () => {
    const raw = new Map<string, WmlConfig>();
    expect(() => flattenUnitTypeConfig('Nonexistent', raw)).toThrow(/no \[unit_type\]/i);
  });

  it('flattenAllUnitTypes flattens every id in the registry', () => {
    const raw = new Map<string, WmlConfig>();
    raw.set('Base Fighter', unitTypeCfg({ id: 'Base Fighter', hitpoints: 30 }));
    raw.set('Elite Fighter', unitTypeCfg({ id: 'Elite Fighter', hitpoints: 45 }, { base_unit: baseUnitTag('Base Fighter') }));
    const all = flattenAllUnitTypes(raw);
    expect(all.get('Base Fighter')!.getNumber('hitpoints')).toBe(30);
    expect(all.get('Elite Fighter')!.getNumber('hitpoints')).toBe(45);
  });
});

describe('collectSpecialRegistry + specials_list=/abilities_list= resolution (real data/core/units.cfg content)', () => {
  const defines = loadDefines();
  const coreUnitsCfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(defines) });
  const weaponSpecialRegistry = collectSpecialRegistry(coreUnitsCfg, 'weapon_specials');
  const abilityRegistry = collectSpecialRegistry(coreUnitsCfg, 'abilities');

  it('finds the real [units][weapon_specials]/[abilities] registries, keyed by unique_id (falling back to id)', () => {
    // Real ids confirmed by reading wesnoth/data/core/macros/weapon_specials.cfg/abilities.cfg directly.
    expect(weaponSpecialRegistry.get('poison')).toMatchObject({ tag: 'poison' });
    expect(weaponSpecialRegistry.get('poison')!.config.getString('id')).toBe('poison');
    // marksman's real TAG is [chance_to_hit] (id=marksman distinguishes it
    // from e.g. "magical", also a [chance_to_hit]) -- weapon-special
    // matching in this engine is by id=, not tag (confirmed safe for
    // every real special `combatStats.ts` evaluates; see this module's
    // own doc comment), so this is fine downstream even though it looks
    // asymmetric next to the tag-based ability checks below.
    expect(weaponSpecialRegistry.get('marksman')).toMatchObject({ tag: 'chance_to_hit' });
    expect(weaponSpecialRegistry.get('marksman')!.config.getString('id')).toBe('marksman');
    // heals_4/heals_8/cures are all TAG "heals" but keyed by their real unique_id, with a DISPLAY id ("healing"/"curing") that does NOT match the tag -- the whole reason RegistryEntry carries tag separately.
    expect(abilityRegistry.get('heals_8')).toMatchObject({ tag: 'heals' });
    expect(abilityRegistry.get('heals_8')!.config.getString('id')).toBe('healing');
    expect(abilityRegistry.get('cures')).toMatchObject({ tag: 'heals' });
    expect(abilityRegistry.get('cures')!.config.getString('id')).toBe('curing');
    expect(abilityRegistry.get('regenerates_8')).toMatchObject({ tag: 'regenerate' });
    expect(abilityRegistry.get('skirmisher')).toMatchObject({ tag: 'skirmisher', config: expect.anything() });
  });

  it('resolves a real unit\'s specials_list= (Orcish Assassin: "specials_list=marksman,poison" on its throwing knives)', () => {
    const rawConfigs = collectUnitTypeConfigs(coreUnitsCfg);
    const flattened = flattenAllUnitTypes(rawConfigs);
    const assassinCfg = flattened.get('Orcish Assassin')!;
    const moveTypes = collectMovementTypeConfigs(coreUnitsCfg);
    const terrainData = new TerrainTypeData();
    const type = UnitType.fromConfig(assassinCfg, moveTypes, terrainData, { weaponSpecials: weaponSpecialRegistry, abilities: abilityRegistry });

    const dagger = type.attacks.find((a) => a.id === 'dagger')!;
    expect(dagger.specials).toHaveLength(0); // no specials_list= on this weapon.
    const knives = type.attacks.find((a) => a.id === 'throwing knives')!;
    expect(knives.specials.map((s) => s.getString('id')).sort()).toEqual(['marksman', 'poison']);
  });

  it('resolves a real unit\'s abilities_list= (Mermaid Priestess: "abilities_list=heals_8,cures" -- the real Cylanna in Dead Water) by TAG, not by the (non-matching) display id', () => {
    const rawConfigs = collectUnitTypeConfigs(coreUnitsCfg);
    const flattened = flattenAllUnitTypes(rawConfigs);
    const priestessCfg = flattened.get('Mermaid Priestess')!;
    const moveTypes = collectMovementTypeConfigs(coreUnitsCfg);
    const terrainData = new TerrainTypeData();
    const type = UnitType.fromConfig(priestessCfg, moveTypes, terrainData, { weaponSpecials: weaponSpecialRegistry, abilities: abilityRegistry });

    // Real bug this regresses: before RegistryEntry/tag-based matching, this
    // was empty in practice for anything consuming it by id==='heals' (see
    // heal.ts's hasAbility), because the real registry's display id is
    // "healing"/"curing", never literally "heals".
    const healsAbilities = type.abilities.filter((a) => a.tag === 'heals');
    expect(healsAbilities).toHaveLength(2);
    // "healing" (heals_8) sets value=8; "curing" (cures) sets no value= at
    // all (poison-cure only, no heal amount) -- real Wesnoth's heal_amount
    // treats an absent value as 0, matching getNumber's own fallback.
    expect(healsAbilities.map((a) => a.config.getNumber('value', 0)).sort((x, y) => x - y)).toEqual([0, 8]);
    expect(healsAbilities.find((a) => a.config.getString('id') === 'curing')!.config.hasAttribute('value')).toBe(false);
  });

  it('resolves a real skirmisher unit\'s abilities_list=skirmisher (Assassin) so hasSkirmisher recognizes it', () => {
    const rawConfigs = collectUnitTypeConfigs(coreUnitsCfg);
    const flattened = flattenAllUnitTypes(rawConfigs);
    const assassinCfg = flattened.get('Assassin')!;
    const moveTypes = collectMovementTypeConfigs(coreUnitsCfg);
    const terrainData = new TerrainTypeData();
    const type = UnitType.fromConfig(assassinCfg, moveTypes, terrainData, { weaponSpecials: weaponSpecialRegistry, abilities: abilityRegistry });
    expect(type.abilities.some((a) => a.tag === 'skirmisher')).toBe(true);
  });

  it('an unknown id in specials_list= is silently skipped, not an error', () => {
    const cfg = new WmlConfig();
    cfg.setAttribute('name', 'test');
    cfg.setAttribute('specials_list', 'poison,not_a_real_special');
    const attack = AttackType.fromConfig(cfg, weaponSpecialRegistry);
    expect(attack.specials.map((s) => s.getString('id'))).toEqual(['poison']);
  });
});

/**
 * Real, reported gameplay bug (bugs6.md): in Liberty scenario 1 the
 * Footpad_Peasant could not attack Goblin Pillagers at all, while the
 * Thug_Peasant standing next to it could.
 *
 * Both are reskins of core outlaws via `[base_unit]`, but only
 * Footpad_Peasant overrides an `[attack]`, and it overrides just one
 * attribute of it (`damage=4`, "same club, weaker"). Merging the derived
 * type's children by *replacing* the base's list left it holding a single
 * nameless, rangeless, typeless attack -- i.e. no usable weapon. Upstream
 * merges positionally per tag instead (`config::merge_with`,
 * config.cpp:1097), which is what `mergeUnitTypeConfig` now does.
 */
describe('[base_unit] reskins against real Liberty content (bugs6.md: Footpad_Peasant could not attack)', () => {
  const libertyDir = path.join(dataRoot, 'campaigns/Liberty');

  function libertyContent(): { flattened: Map<string, WmlConfig>; movementTypes: Map<string, WmlConfig> } {
    const defines: DefineMap = new Map();
    for (const name of ['CAMPAIGN_LIBERTY', 'NORMAL']) {
      defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<test>' });
    }
    preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
    preloadDefines(path.join(libertyDir, '_main.cfg'), defines, { dataRoot });
    const core = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(defines) });
    const campaign = parseWmlFile(path.join(libertyDir, '_main.cfg'), { dataRoot, defines: new Map(defines) });
    const raw = collectUnitTypeConfigs(core);
    collectUnitTypeConfigs(campaign, raw);
    return { flattened: flattenAllUnitTypes(raw), movementTypes: collectMovementTypeConfigs(core) };
  }

  const { flattened, movementTypes: libertyMoveTypes } = libertyContent();

  it('Footpad_Peasant keeps its base Footpad\'s weapons, with only the damage it actually overrides changed', () => {
    const attacks = flattened.get('Footpad_Peasant')!.children('attack');
    expect(attacks.map((a) => a.getString('name'))).toEqual(['club', 'sling']);

    const club = attacks[0]!;
    expect(club.getNumber('damage')).toBe(4); // the override
    expect(club.getString('range')).toBe('melee'); // inherited -- this is what was lost
    expect(club.getString('type')).toBe('impact');
    expect(club.getNumber('number')).toBe(2);
  });

  it('every weapon it ends up with is actually usable (a name, a range and a type)', () => {
    const type = UnitType.fromConfig(flattened.get('Footpad_Peasant')!, libertyMoveTypes, new TerrainTypeData());
    expect(type.attacks.length).toBe(2);
    for (const attack of type.attacks) {
      expect(attack.id).not.toBe('');
      expect(['melee', 'ranged']).toContain(attack.range);
      expect(attack.damage).toBeGreaterThan(0);
    }
  });

  it('Thug_Peasant, which overrides no attack at all, is unaffected (it is why the bug looked unit-specific)', () => {
    const attacks = flattened.get('Thug_Peasant')!.children('attack');
    expect(attacks.map((a) => a.getString('name'))).toEqual(['club']);
    expect(attacks[0]!.getString('range')).toBe('melee');
  });
});
