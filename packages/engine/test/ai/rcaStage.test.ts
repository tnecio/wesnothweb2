import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { CandidateAction, RcaStage, BAD_SCORE, EXECUTION_CAP } from '../../src/ai/composite/rca.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

/**
 * `RcaStage.playStage()` scheduler semantics -- the exact algorithm
 * `stage_rca.cpp:78-146` documents (see `composite/rca.ts`'s own module
 * doc comment): sort by max_score desc, early-break once no remaining
 * CA's max_score can beat the best score so far, execute the winner,
 * disable it if execute() didn't actually change anything, stop once
 * every enabled CA scores <= 0.
 */

function makeCfg(id: string, score: number, maxScore = score): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', id);
  cfg.setAttribute('score', score);
  cfg.setAttribute('max_score', maxScore);
  return cfg;
}

const terrainData = loadTerrainData();

function makeCtx(overrides: Parameters<typeof makeAiHost>[1] = {}) {
  const board = makeBoard(terrainData);
  const host = makeAiHost(board, overrides);
  return new AiContext(host, 1, new Map());
}

/** Fetches (or creates) a unit on `ctx`'s board to poke at via `stopUnit` so a spy CA's `execute()` can report a real gamestate change. */
function placeholderUnit(ctx: AiContext): Unit {
  const existing = ctx.board.unitsForSide(1)[0];
  if (existing) return existing;
  const type = makeUnitType('spy', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1));
  const unit = Unit.create(type, 1, Location.fromWml(1, 1));
  unit.movesLeft = 5;
  ctx.board.addUnit(unit);
  return unit;
}

/**
 * A fully constructor-injectable CA: `evaluate`/`execute` are ALWAYS the
 * counted versions below (never reassigned post-construction, which
 * would silently bypass the counters); behaviour is supplied via
 * `onEvaluate`/`onExecute` callbacks instead.
 */
class SpyCandidateAction extends CandidateAction {
  evalCount = 0;
  execCount = 0;
  constructor(
    ctx: AiContext,
    cfg: WmlConfig,
    private readonly onEvaluate: () => number,
    private readonly onExecute: () => void = () => undefined,
  ) {
    super(ctx, cfg);
  }
  evaluate(): number {
    this.evalCount++;
    return this.onEvaluate();
  }
  execute(): void {
    this.execCount++;
    this.onExecute();
  }
}

describe('RcaStage: sorting and early-break', () => {
  it('executes the highest-max_score CA first', () => {
    const ctx = makeCtx();
    const unit = placeholderUnit(ctx);
    const order: string[] = [];
    let lowFired = false;
    let highFired = false;
    const low = new SpyCandidateAction(
      ctx,
      makeCfg('low', 100, 100),
      () => (lowFired ? BAD_SCORE : 100),
      () => {
        lowFired = true;
        order.push('low');
        unit.movesLeft = 5;
        ctx.stopUnit(unit, true, false);
      },
    );
    const high = new SpyCandidateAction(
      ctx,
      makeCfg('high', 200, 200),
      () => (highFired ? BAD_SCORE : 200),
      () => {
        highFired = true;
        order.push('high');
        unit.movesLeft = 5;
        ctx.stopUnit(unit, true, false);
      },
    );

    const stage = new RcaStage(ctx, 'main', [low, high]);
    stage.playStage();

    expect(order).toEqual(['high', 'low']);
  });

  it('never evaluates a CA whose max_score can never beat a permanently-dominant higher-priority CA (runs to the execution cap)', () => {
    const ctx = makeCtx();
    const unit = placeholderUnit(ctx);
    // A stateless, permanently-renewing real change: always scores 500 and always actually moves something, so it
    // dominates every single pass and the stage only ends via the execution-cap safety valve.
    const dominant = new SpyCandidateAction(
      ctx,
      makeCfg('dominant', 500, 500),
      () => 500,
      () => {
        unit.movesLeft = 5;
        ctx.stopUnit(unit, true, false);
      },
    );
    const neverEvaluated = new SpyCandidateAction(ctx, makeCfg('never', 100, 100), () => 100);

    const stage = new RcaStage(ctx, 'main', [neverEvaluated, dominant]);
    stage.playStage();

    expect(dominant.execCount).toBeGreaterThan(EXECUTION_CAP);
    expect(neverEvaluated.evalCount).toBe(0);
  }, 15000);
});

describe('RcaStage: disable-on-no-change', () => {
  it('disables a CA for the rest of this stage run if its execute() reported a positive score but changed nothing, letting the next-best CA run', () => {
    const ctx = makeCtx();
    const unit = placeholderUnit(ctx);
    const liar = new SpyCandidateAction(
      ctx,
      makeCfg('liar', 300, 300),
      () => 300,
      () => undefined, // "lies": claims a move but never actually moves anything
    );
    let honestRan = false;
    const honest = new SpyCandidateAction(
      ctx,
      makeCfg('honest', 200, 200),
      () => (honestRan ? BAD_SCORE : 200),
      () => {
        honestRan = true;
        unit.movesLeft = 5;
        ctx.stopUnit(unit, true, false);
      },
    );

    const stage = new RcaStage(ctx, 'main', [liar, honest]);
    const changed = stage.playStage();

    expect(liar.execCount).toBe(1); // tried once, then blacklisted
    expect(honest.execCount).toBe(1); // got its turn once liar was disabled
    expect(changed).toBe(true); // honest's real change counts for the whole stage
    expect(liar.enabled).toBe(false);
  });

  it('re-enables every CA at the start of the NEXT playStage() call (the blacklist is per-invocation only)', () => {
    const ctx = makeCtx();
    const liar = new SpyCandidateAction(
      ctx,
      makeCfg('liar', 300, 300),
      () => 300,
      () => undefined,
    );
    const stage = new RcaStage(ctx, 'main', [liar]);
    stage.playStage();
    expect(liar.enabled).toBe(false);
    expect(liar.evalCount).toBe(1);
    stage.playStage();
    expect(liar.evalCount).toBe(2); // was re-enabled and evaluated again
  });
});

describe('RcaStage: all-CAs-return-zero ends the stage', () => {
  it('executes nothing and returns false when every CA scores <= 0', () => {
    const ctx = makeCtx();
    const a = new SpyCandidateAction(ctx, makeCfg('a', 0, 100), () => BAD_SCORE);
    const b = new SpyCandidateAction(ctx, makeCfg('b', 0, 50), () => BAD_SCORE);
    const stage = new RcaStage(ctx, 'main', [a, b]);
    const changed = stage.playStage();
    expect(changed).toBe(false);
    expect(a.execCount).toBe(0);
    expect(b.execCount).toBe(0);
  });
});

describe('RcaStage: execution cap', () => {
  it('stops and warns after EXECUTION_CAP executions rather than looping forever on a CA that always reports a real change', () => {
    const warnings: string[] = [];
    const ctx = makeCtx({ log: (level, msg) => level === 'warn' && warnings.push(msg) });
    const unit = placeholderUnit(ctx);

    const infinite = new SpyCandidateAction(
      ctx,
      makeCfg('infinite', 50, 50),
      () => 50,
      () => {
        unit.movesLeft = 5; // undo the previous execution's stopUnit so this one is a REAL change again
        ctx.stopUnit(unit, true, false);
      },
    );

    const stage = new RcaStage(ctx, 'main', [infinite]);
    stage.playStage();

    expect(infinite.execCount).toBeGreaterThan(EXECUTION_CAP);
    expect(infinite.execCount).toBeLessThan(EXECUTION_CAP + 5);
    expect(warnings.some((w) => w.includes('execution cap'))).toBe(true);
  }, 15000);
});

describe('RcaStage: a throwing CA is disabled rather than crashing the turn', () => {
  it('catches evaluate() throwing, logs an error, disables the CA, and lets others run', () => {
    const errors: string[] = [];
    const ctx = makeCtx({ log: (level, msg) => level === 'error' && errors.push(msg) });
    const unit = placeholderUnit(ctx);
    const broken = new SpyCandidateAction(ctx, makeCfg('broken', 900, 900), () => {
      throw new Error('boom');
    });
    let ran = false;
    const fine = new SpyCandidateAction(
      ctx,
      makeCfg('fine', 100, 100),
      () => (ran ? BAD_SCORE : 100),
      () => {
        ran = true;
        unit.movesLeft = 5;
        ctx.stopUnit(unit, true, false);
      },
    );
    const stage = new RcaStage(ctx, 'main', [broken, fine]);
    expect(() => stage.playStage()).not.toThrow();
    expect(broken.enabled).toBe(false);
    expect(fine.execCount).toBe(1);
    expect(errors.some((e) => e.includes('boom'))).toBe(true);
  });

  it('catches execute() throwing the same way', () => {
    const ctx = makeCtx({ log: () => undefined });
    const unit = placeholderUnit(ctx);
    const broken = new SpyCandidateAction(ctx, makeCfg('broken', 900, 900), () => 900, () => {
      throw new Error('boom in execute');
    });
    let ran = false;
    const fine = new SpyCandidateAction(
      ctx,
      makeCfg('fine', 100, 100),
      () => (ran ? BAD_SCORE : 100),
      () => {
        ran = true;
        unit.movesLeft = 5;
        ctx.stopUnit(unit, true, false);
      },
    );
    const stage = new RcaStage(ctx, 'main', [broken, fine]);
    expect(() => stage.playStage()).not.toThrow();
    expect(broken.enabled).toBe(false);
    expect(fine.execCount).toBe(1);
  });
});

describe('CandidateAction base: [filter_own]', () => {
  it('gates unit eligibility, matching only when [filter_own] is absent or the unit matches it', () => {
    const ctx = makeCtx();
    const cfg = makeCfg('x', 10);
    const filterOwn = cfg.addChild('filter_own');
    filterOwn.setAttribute('id', 'wanted');

    class ProbeCa extends CandidateAction {
      probe(u: Unit): boolean {
        return (this as unknown as { isAllowedUnit(u: Unit): boolean }).isAllowedUnit(u);
      }
      evaluate(): number {
        return 0;
      }
      execute(): void {
        /* noop */
      }
    }
    const ca = new ProbeCa(ctx, cfg);
    const type = makeUnitType('t', 10, flatMoveType(terrainData, 50), makeWeapon(1, 1));
    const wanted = Unit.create(type, 1, Location.fromWml(1, 1), { id: 'wanted' });
    const other = Unit.create(type, 1, Location.fromWml(2, 1), { id: 'other' });
    expect(ca.probe(wanted)).toBe(true);
    expect(ca.probe(other)).toBe(false);

    const noFilterCa = new ProbeCa(ctx, makeCfg('y', 10));
    expect(noFilterCa.probe(other)).toBe(true);
  });
});

describe('RcaStage: one step per action (Phase 29a)', () => {
  it('pauses after each execute() that changed the gamestate, and not after one that did not', () => {
    const ctx = makeCtx();
    const unit = placeholderUnit(ctx);
    const order: string[] = [];
    const acting = (id: string, score: number) => {
      let fired = false;
      return new SpyCandidateAction(
        ctx,
        makeCfg(id, score, score),
        () => (fired ? BAD_SCORE : score),
        () => {
          fired = true;
          order.push(id);
          unit.movesLeft = 5;
          ctx.stopUnit(unit, true, false);
        },
      );
    };
    // Claims a score but does nothing: executed once, disabled, and no step.
    const liar = new SpyCandidateAction(ctx, makeCfg('liar', 300, 300), () => 300, () => order.push('liar'));

    const steps = new RcaStage(ctx, 'main', [acting('low', 100), liar, acting('high', 200)]).playStageSteps();
    let step = steps.next();
    while (!step.done) {
      order.push('|');
      step = steps.next();
    }

    expect(order).toEqual(['liar', 'high', '|', 'low', '|']);
    expect(step.value).toBe(true);
  });
});
