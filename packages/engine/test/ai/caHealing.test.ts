import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AttackType, UnitType, type RegistryEntry } from '../../src/model/UnitType.js';
import { AiContext } from '../../src/ai/context.js';
import { HealingCandidateAction } from '../../src/ai/default/caHealing.js';
import { CompositeAspect, facetFromConfig } from '../../src/ai/composite/aspect.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'healing');
  cfg.setAttribute('score', 80000);
  cfg.setAttribute('max_score', 80000);
  return cfg;
}

function makeCtx() {
  const board = makeBoard(terrainData);
  return { ctx: new AiContext(makeAiHost(board), 1, new Map()), board };
}

describe('HealingCandidateAction', () => {
  it('sends a damaged unit to the reachable village (healing terrain) when no enemy threatens it', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const unit = Unit.create(type, 1, Location.fromWml(3, 3));
    unit.hitpoints = 10; // clearly damaged
    board.addUnit(unit);

    const ca = new HealingCandidateAction(ctx, makeCfg());
    const score = ca.evaluate();
    expect(score).toBe(80000);
    ca.execute();
    expect(board.map.givesHealing(unit.location)).toBeGreaterThan(0);
  });

  it('does nothing for a unit at full health and not poisoned', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const unit = Unit.create(type, 1, Location.fromWml(3, 3));
    board.addUnit(unit);
    const ca = new HealingCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });

  it('sends a poisoned-but-full-HP unit to healing terrain too', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const unit = Unit.create(type, 1, Location.fromWml(3, 3));
    unit.setStatus('poisoned', true);
    board.addUnit(unit);
    const ca = new HealingCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(80000);
  });

  it('skips a unit with the regenerate ability even when damaged', () => {
    const { ctx, board } = makeCtx();
    const regenerate: RegistryEntry = { tag: 'regenerate', config: new WmlConfig() };
    const weapon = AttackType.fromConfig(weaponCfg());
    const type = new UnitType(
      'regen', 'regen', '', 'neutral', 1, 30, 5, 5, 0, 1, 10, -1, 500, [], '', false, false, false,
      flatMoveType(terrainData, 50), [weapon], [regenerate],
    );
    const unit = Unit.create(type, 1, Location.fromWml(3, 3));
    unit.hitpoints = 5;
    board.addUnit(unit);
    const ca = new HealingCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });

  it('skips a passive leader', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const leader = Unit.create(type, 1, Location.fromWml(3, 3), { canRecruit: true });
    leader.hitpoints = 5;
    board.addUnit(leader);
    const passiveCfg = new WmlConfig();
    passiveCfg.setAttribute('value', 'yes');
    const aspects = new Map<string, CompositeAspect>([['passive_leader', new CompositeAspect('passive_leader', facetFromConfig(passiveCfg))]]);
    const ctx = new AiContext(makeAiHost(board), 1, aspects);
    const ca = new HealingCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });
});

function weaponCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('name', 'test-weapon');
  cfg.setAttribute('type', 'blade');
  cfg.setAttribute('range', 'melee');
  cfg.setAttribute('damage', 3);
  cfg.setAttribute('number', 1);
  return cfg;
}
