import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { parseWml } from '../../src/wml/index.js';
import { Location } from '../../src/model/Location.js';
import { MoveType } from '../../src/model/MoveType.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { Unit } from '../../src/model/Unit.js';

const emptyTerrainData = TerrainTypeData.fromConfigs([]);

/** Phase 29 (real AI port) additions: `Unit.goto`, `UnitType.usage`, `Unit.toConfig()`. */

function makeType(usage = ''): UnitType {
  const weapon = new AttackType('sword', 'sword', 'blade', 'melee', 1, 1, 5, 3, 1, 1, 0, 0, undefined, []);
  return new UnitType(
    'Grunt',
    'Grunt',
    'orc',
    'chaotic',
    1,
    30,
    5,
    5,
    0,
    2,
    15,
    -1,
    500,
    [],
    '',
    true,
    false,
    false,
    MoveType.fromConfig(new WmlConfig(), emptyTerrainData),
    [weapon],
    [],
    2,
    [],
    false,
    usage,
  );
}

describe('UnitType.usage', () => {
  it('reads usage= from WML, defaulting to empty string', () => {
    const cfg = parseWml('[unit_type]\n    id=x\n    hitpoints=1\n    movement=1\n    attacks=1\n    cost=1\n[/unit_type]').child('unit_type')!;
    const withoutUsage = UnitType.fromConfig(cfg, new Map(), emptyTerrainData);
    expect(withoutUsage.usage).toBe('');

    const cfgWithUsage = parseWml('[unit_type]\n    id=x\n    hitpoints=1\n    movement=1\n    attacks=1\n    cost=1\n    usage=scout\n[/unit_type]').child('unit_type')!;
    const withUsage = UnitType.fromConfig(cfgWithUsage, new Map(), emptyTerrainData);
    expect(withUsage.usage).toBe('scout');
  });
});

describe('Unit.goto', () => {
  it('defaults to undefined for a freshly created unit', () => {
    const unit = Unit.create(makeType(), 1, new Location(0, 0));
    expect(unit.goto).toBeUndefined();
  });

  it('is read from goto_x=/goto_y= in fromConfig', () => {
    const type = makeType();
    const cfg = new WmlConfig();
    cfg.setAttribute('type', 'Grunt');
    cfg.setAttribute('x', 1);
    cfg.setAttribute('y', 1);
    cfg.setAttribute('goto_x', 5);
    cfg.setAttribute('goto_y', 3);
    const unit = Unit.fromConfig(cfg, () => type);
    expect(unit.goto).toEqual(Location.fromWml(5, 3));
  });

  it('is omitted when goto_x/goto_y are absent', () => {
    const type = makeType();
    const cfg = new WmlConfig();
    cfg.setAttribute('type', 'Grunt');
    cfg.setAttribute('x', 1);
    cfg.setAttribute('y', 1);
    const unit = Unit.fromConfig(cfg, () => type);
    expect(unit.goto).toBeUndefined();
  });
});

describe('Unit.toConfig', () => {
  it('round-trips through Unit.fromConfig: same type, side, location, hp, moves, goto', () => {
    const type = makeType();
    const original = Unit.create(type, 2, new Location(3, 4), { id: 'u1', name: 'Grunty', canRecruit: true });
    original.hitpoints = 12;
    original.movesLeft = 2;
    original.goto = Location.fromWml(7, 8);

    const cfg = original.toConfig();
    const rebuilt = Unit.fromConfig(cfg, () => type);

    expect(rebuilt.type.id).toBe(original.type.id);
    expect(rebuilt.side).toBe(2);
    expect(rebuilt.location.equals(original.location)).toBe(true);
    expect(rebuilt.id).toBe('u1');
    expect(rebuilt.name).toBe('Grunty');
    expect(rebuilt.canRecruit).toBe(true);
    expect(rebuilt.hitpoints).toBe(12);
    expect(rebuilt.movesLeft).toBe(2);
    expect(rebuilt.goto).toEqual(Location.fromWml(7, 8));
  });

  it('serializes x=/y=recall for an off-board (recall-list) unit', () => {
    const type = makeType();
    const unit = Unit.create(type, 1, Location.NULL, { id: 'r1' });
    const cfg = unit.toConfig();
    expect(cfg.getString('x')).toBe('recall');
    expect(cfg.getString('y')).toBe('recall');
  });

  it('round-trips the guardian ai_special and status flags', () => {
    const type = makeType();
    const unit = Unit.create(type, 1, new Location(0, 0));
    unit.setStatus('guardian', true);
    unit.setStatus('poisoned', true);
    const cfg = unit.toConfig();
    expect(cfg.getString('ai_special')).toBe('guardian');
    const rebuilt = Unit.fromConfig(cfg, () => type);
    expect(rebuilt.guardian).toBe(true);
    expect(rebuilt.hasStatus('poisoned')).toBe(true);
  });
});
