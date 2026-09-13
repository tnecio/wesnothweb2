import { describe, expect, it } from 'vitest';
import { parseWml } from '../../src/wml/index.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { parseSideAiConfig } from '../../src/ai/config/upgrade.js';
import { DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON } from '../../src/ai/config/builtinAiConfigs.generated.js';
import { createAiComposite } from '../../src/ai/composite/aiComposite.js';
import { createDefaultCandidateActionRegistry } from '../../src/ai/default/registry.js';
import { AiContext } from '../../src/ai/context.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

describe('AiComposite end-to-end: idle_ai', () => {
  it('an ai_algorithm=idle_ai side does absolutely nothing, ever', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('grunt', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const unit = Unit.create(type, 1, Location.fromWml(3, 3));
    board.addUnit(unit);
    const originalLocation = unit.location;

    const host = makeAiHost(board);
    const sideBlock = parseWml('[ai]\nai_algorithm=idle_ai\n[/ai]').child('ai')!;
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, [sideBlock]);
    const ctx = new AiContext(host, 1, parsed.aspects);
    const registry = createDefaultCandidateActionRegistry();
    const composite = createAiComposite(ctx, parsed.configs, registry);

    composite.newTurn();
    composite.playTurn();

    expect(unit.location.equals(originalLocation)).toBe(true);
    expect(unit.movesLeft).toBe(unit.maxMoves); // never touched
  });
});

describe('AiComposite end-to-end: real ai_default_rca config, S1 CAs only', () => {
  it('moves a leader toward its keep using the real default config (unregistered CAs like combat/recruitment are skipped, not errors)', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    const leader = Unit.create(type, 1, Location.fromWml(2, 1), { canRecruit: true }); // on the castle, off the keep
    board.addUnit(leader);

    const warnings: string[] = [];
    const host = makeAiHost(board, { log: (level, msg) => level === 'warn' && warnings.push(msg) });
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, []); // no side block -> falls back to ai_default_rca
    const ctx = new AiContext(host, 1, parsed.aspects);
    const registry = createDefaultCandidateActionRegistry();
    const composite = createAiComposite(ctx, parsed.configs, registry);

    composite.newTurn();
    composite.playTurn();

    expect(leader.location.equals(Location.fromWml(1, 1))).toBe(true); // walked onto the keep via move_leader_to_keep
    // The real config references combat/recruitment/etc, none of which S1 registers yet -- confirmed logged, not thrown.
    expect(warnings.some((w) => w.includes('has no registered factory yet'))).toBe(true);
  });

  it('does not throw when a scenario has no [side][ai] at all (falls back to the real default algorithm)', () => {
    const board = makeBoard(terrainData);
    const host = makeAiHost(board);
    const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, []);
    const ctx = new AiContext(host, 1, parsed.aspects);
    const registry = createDefaultCandidateActionRegistry();
    const composite = createAiComposite(ctx, parsed.configs, registry);
    expect(() => {
      composite.newTurn();
      composite.playTurn();
    }).not.toThrow();
  });
});
