import { describe, expect, it } from 'vitest';
import { parseWml } from '../../src/wml/index.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType } from '../../src/model/UnitType.js';
import { AiContext } from '../../src/ai/context.js';
import { parseSideAiConfig } from '../../src/ai/config/upgrade.js';
import { DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON } from '../../src/ai/config/builtinAiConfigs.generated.js';
import { compareUnitTypes, RecruitmentCandidateAction } from '../../src/ai/default/recruitment.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg() {
  return parseWml('[recruitment]\nid=recruitment\nname=default_recruitment::recruitment\nscore=180000\nmax_score=180000\n[/recruitment]').child(
    'recruitment',
  )!;
}

function makeTypeRegistry(types: UnitType[]): (id: string) => UnitType {
  const byId = new Map(types.map((t) => [t.id, t]));
  return (id: string) => {
    const t = byId.get(id);
    if (!t) throw new Error(`unknown type ${id}`);
    return t;
  };
}

/** A custom [aspect] block wholly replacing one of the real default_config.cfg aspects for this test (real WML shape: `[default]...[/default]` inside `[aspect]`, not a bare `[value]`). */
function aspectOverride(id: string, defaultBody: string): string {
  return `[aspect]\nid=${id}\n[default]\nengine=cpp\nname=standard_aspect\n${defaultBody}\n[/default]\n[/aspect]`;
}

function makeSetup(types: UnitType[], sideAiWml = '') {
  const board = makeBoard(terrainData);
  const leader = Unit.create(types[0]!, 1, Location.fromWml(1, 1), { canRecruit: true, id: 'leader1' });
  board.addUnit(leader);
  board.getTeam(1)!.canRecruit = new Set(types.map((t) => t.id));

  const sideBlock = sideAiWml ? parseWml(`[ai]\n${sideAiWml}\n[/ai]`).child('ai')! : undefined;
  const parsed = parseSideAiConfig(DEFAULT_AI_CONFIG_JSON, AI_ALGORITHM_CONFIGS_JSON, sideBlock ? [sideBlock] : []);
  const resolveType = makeTypeRegistry(types);
  const host = makeAiHost(board, { resolveType });
  const ctx = new AiContext(host, 1, parsed.aspects);
  return { ctx, board, leader, resolveType };
}

/** Runs the CA the same way `RcaStage` always does: evaluate() first (which is what populates the CA's cached recruitment-instructions for this turn), then execute() only if it scored. */
function runCa(ctx: ReturnType<typeof makeSetup>['ctx'], cfg = makeCfg()): { ca: RecruitmentCandidateAction; score: number } {
  const ca = new RecruitmentCandidateAction(ctx, cfg);
  const score = ca.evaluate();
  if (score > 0) ca.execute();
  return { ca, score };
}

describe('compareUnitTypes', () => {
  it('is antisymmetric: swapping the two types negates the result', () => {
    const strong = new UnitType('brute', 'brute', '', 'neutral', 1, 40, 5, 5, 0, 1, 25, -1, 500, [], '', false, false, false, flatMoveType(terrainData, 50), [makeWeapon(12, 3)], []);
    const weak = new UnitType('weakling', 'weakling', '', 'neutral', 1, 10, 5, 5, 0, 1, 5, -1, 500, [], '', false, false, false, flatMoveType(terrainData, 50), [makeWeapon(2, 1)], []);

    const ab = compareUnitTypes(strong, weak, 50, 50, 0, 0);
    const ba = compareUnitTypes(weak, strong, 50, 50, 0, 0);
    expect(ab).toBeGreaterThan(0); // strong wins the matchup
    expect(ba).toBeCloseTo(-ab, 6);
  });

  it('returns 0 for two types that cannot damage each other', () => {
    const harmless = new UnitType('harmless', 'harmless', '', 'neutral', 1, 10, 5, 5, 0, 1, 5, -1, 500, [], '', false, false, false, flatMoveType(terrainData, 50), [makeWeapon(0, 0)], []);
    expect(compareUnitTypes(harmless, harmless, 50, 50, 0, 0)).toBe(0);
  });
});

describe('RecruitmentCandidateAction', () => {
  it('recruits repeatedly while affordable and the castle has room', () => {
    const soldier = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    const { ctx, board } = makeSetup([soldier]);
    const { score } = runCa(ctx);
    expect(score).toBe(180000);
    expect(board.getTeam(1)!.gold).toBeLessThan(100);
    // The synthetic board's castle has exactly 2 non-keep tiles -- both get filled.
    expect(board.unitsForSide(1).filter((u) => !u.canRecruit)).toHaveLength(2);
  });

  it('spends until unaffordable, not until the castle is full', () => {
    const pricey = makeUnitType('pricey', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 60);
    const { ctx, board } = makeSetup([pricey]); // 100 gold: exactly one 60-cost unit fits, not two
    runCa(ctx);
    expect(board.getTeam(1)!.gold).toBe(40);
    expect(board.unitsForSide(1).filter((u) => !u.canRecruit)).toHaveLength(1);
  });

  it('[limit] stops recruiting a type once its count is reached', () => {
    const soldier = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 5);
    const { ctx, board } = makeSetup(
      [soldier],
      aspectOverride('recruitment_instructions', '[value]\n[recruit]\ntype=soldier\n[/recruit]\n[limit]\ntype=soldier\nmax=0\n[/limit]\n[/value]'),
    );
    // evaluate() only checks "does some job exist at all" (real upstream behaviour -- limit_ok is checked later,
    // during execute()'s per-recruit selection), so it legitimately still scores; the limit instead makes execute()
    // a no-op, which is exactly the case RcaStage's own gamestate-unchanged blacklisting exists to handle.
    runCa(ctx);
    expect(board.getTeam(1)!.gold).toBe(100); // nothing recruited
  });

  it('the recruitment_pattern aspect restricts recruiting to the named types', () => {
    const soldier = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    const scout = makeUnitType('scout', 15, flatMoveType(terrainData, 50), makeWeapon(3, 1), 10);
    const { ctx, board } = makeSetup([soldier, scout], 'recruitment_pattern=scout');
    runCa(ctx);
    const recruited = board.unitsForSide(1).find((u) => !u.canRecruit);
    expect(recruited?.type.id).toBe('scout');
  });

  it('a higher-importance job is fulfilled before a lower-importance one', () => {
    const soldier = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    const scout = makeUnitType('scout', 15, flatMoveType(terrainData, 50), makeWeapon(3, 1), 10);
    const { ctx, board } = makeSetup(
      [soldier, scout],
      aspectOverride(
        'recruitment_instructions',
        ['[value]', '[recruit]', 'type=scout', 'number=1', 'importance=1', '[/recruit]', '[recruit]', 'type=soldier', 'number=1', 'importance=5', '[/recruit]', '[/value]'].join('\n'),
      ),
    );
    runCa(ctx);
    const recruited = board.unitsForSide(1).find((u) => !u.canRecruit);
    expect(recruited?.type.id).toBe('soldier'); // importance 5 beats importance 1
  });

  it('recruitment_randomness=0 is deterministic across repeated runs with the same seed', () => {
    const soldier = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    const scout = makeUnitType('scout', 15, flatMoveType(terrainData, 50), makeWeapon(3, 1), 10);
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { ctx, board } = makeSetup([soldier, scout], 'recruitment_randomness=0');
      runCa(ctx);
      const recruited = board.unitsForSide(1).find((u) => !u.canRecruit);
      results.push(recruited?.type.id ?? 'none');
    }
    expect(new Set(results).size).toBe(1); // same choice every time
  });

  it('prefers recalling an existing unit over recruiting a fresh one of the same type', () => {
    // recall_unit_value = (fresh cost, since this type has no advancements) - recall cost: only worth recalling
    // when that's positive, so the fresh cost (30) must exceed the team's default recall cost (20, Team's default).
    const soldier = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 30);
    const { ctx, board } = makeSetup([soldier]);
    const veteran = Unit.create(soldier, 1, Location.NULL, { id: 'veteran' });
    veteran.hitpoints = 20;
    board.addToRecallList(1, veteran);

    runCa(ctx);

    expect(board.recallList(1)).toHaveLength(0); // recalled, not left on the list
    const recalled = board.unitsForSide(1).find((u) => u.id === 'veteran');
    expect(recalled).toBeDefined();
    // Recruiting continues into the castle's second vacant tile too (real behaviour, not a one-shot action) -- the
    // recall cost (20) is what matters here, not the total spent.
    expect(board.getTeam(1)!.gold).toBeLessThanOrEqual(100 - board.getTeam(1)!.recallCost);
  });

  it('does not recruit at all while in the save_gold state', () => {
    const soldier = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    // begin=-999 means get_unit_ratio() (always >= 0) exceeds it immediately -> state flips to save_gold on turn 1.
    const { ctx, board } = makeSetup([soldier], aspectOverride('recruitment_save_gold', '[value]\nactive=1\nbegin=-999\nend=-9999\n[/value]'));
    runCa(ctx);
    expect(board.getTeam(1)!.gold).toBe(100);
    expect(board.unitsForSide(1)).toHaveLength(1); // only the leader
  });

  it('wants scouts when there are unclaimed neutral villages and villages_per_scout is set low', () => {
    const soldier = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    const scout = makeUnitType('scout', 15, flatMoveType(terrainData, 50), makeWeapon(3, 1), 10, 'scout');
    // The synthetic board has one neutral village (wml 4,4) -- with villages_per_scout=1 this should want >=1 scout.
    const { ctx, board } = makeSetup([soldier, scout], 'villages_per_scout=1');
    runCa(ctx);
    const recruited = board.unitsForSide(1).find((u) => !u.canRecruit);
    expect(recruited?.type.id).toBe('scout');
  });
});
