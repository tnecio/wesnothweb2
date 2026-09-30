/**
 * TS port of upstream's candidate-action framework: `candidate_action`
 * (`src/ai/composite/rca.hpp/.cpp`) and the RCA scheduling loop itself,
 * `candidate_action_evaluation_loop::do_play_stage`
 * (`src/ai/default/stage_rca.cpp:78-146`). This loop IS the AI: every
 * turn is "run the main_loop stage, which repeatedly picks and executes
 * the single best-scoring candidate action until none scores above 0."
 *
 * The exact algorithm (ported line-for-line in spirit, not just result):
 *  1. Re-enable every candidate action (the blacklist below is
 *     per-stage-invocation only, i.e. per turn).
 *  2. Sort candidate actions by `maxScore` descending.
 *  3. Repeat: evaluate each ENABLED action in sorted order, but stop
 *     early the moment `ca.maxScore <= bestScoreSoFar` -- since the list
 *     is sorted by `maxScore` descending, no remaining action's declared
 *     upper bound can beat the best real score already found, so there's
 *     no need to call `evaluate()` on it. This is `max_score`'s entire
 *     purpose (`score` is only ever a lower/actual value); it must be a
 *     true upper bound on what `evaluate()` can return or a CA can be
 *     skipped incorrectly.
 *  4. If the best score found is `> 0` (`BAD_SCORE`): snapshot the
 *     gamestate, `execute()` the winner. If the gamestate did NOT
 *     actually change, the CA "lied" in `evaluate()` -- disable it for
 *     the rest of THIS stage invocation (not permanently) so others get
 *     a turn; otherwise mark that something happened and loop again.
 *  5. If the best score was `<= 0`, stop -- "all candidate actions
 *     declined" ends the stage.
 *
 * A Lua CA's `evaluate()`/`execute()` throwing (Phase 29 S7+) is caught
 * here rather than left to crash the whole turn -- not present in
 * upstream (a C++ exception there is a hard crash too), but a real
 * necessity once user-authored/upstream Lua content can run.
 */

import { WmlConfig } from '../../wml/config.js';
import type { Unit } from '../../model/Unit.js';
import { unitMatchesFilter } from '../../events/filter.js';
import type { AiContext } from '../context.js';
import type { Stage } from './stage.js';

export const BAD_SCORE = 0;
export const DEFAULT_MAX_SCORE = 1e7;
/** Not present upstream (a runaway CA there is, in practice, bounded by the game itself running out of things to do); a hard safety cap so a bug can't hang a turn forever. */
export const EXECUTION_CAP = 1000;

/** TS port of upstream's `candidate_action` base class. */
export abstract class CandidateAction {
  readonly id: string;
  readonly engine: string;
  readonly name: string;
  score: number;
  maxScore: number;
  enabled: boolean;
  /** Set by a CA that wants to be permanently removed after this execution (mirrors `set_to_be_removed()`/Lua "sticky" CAs, Phase 29 S7+; unused by any S1-S4 CA). */
  toBeRemoved = false;
  protected readonly filterOwn: WmlConfig | undefined;
  protected readonly ctx: AiContext;
  /** The `[candidate_action]` it was built from (`candidate_action::to_config`). */
  readonly config: WmlConfig;

  constructor(ctx: AiContext, cfg: WmlConfig) {
    this.ctx = ctx;
    this.config = cfg;
    this.id = cfg.getString('id', '');
    this.engine = cfg.getString('engine', 'cpp');
    this.name = cfg.getString('name', '');
    this.score = cfg.getNumber('score', BAD_SCORE);
    this.maxScore = cfg.getNumber('max_score', DEFAULT_MAX_SCORE);
    this.enabled = cfg.getBoolean('enabled', true);
    this.filterOwn = cfg.child('filter_own');
  }

  /** Computes this action's score for right now (side-effect-free EXCEPT for caching whatever `execute()` will need -- matches upstream's own "evaluate both scores and remembers the move" convention). */
  abstract evaluate(): number;
  /** Performs whatever `evaluate()` decided on. */
  abstract execute(): void;

  enable(): void {
    this.enabled = true;
  }
  disable(): void {
    this.enabled = false;
  }

  /** `[filter_own]` gate -- true (allowed) when no filter was given. */
  protected isAllowedUnit(unit: Unit): boolean {
    if (!this.filterOwn) return true;
    return unitMatchesFilter(unit, this.filterOwn, this.ctx.board);
  }
}

/** TS port of `candidate_action_evaluation_loop` -- see module doc comment for the exact algorithm. */
export class RcaStage implements Stage {
  readonly id: string;
  readonly name = 'ai_default_rca::candidate_action_evaluation_loop';
  private candidateActions: CandidateAction[];
  private readonly ctx: AiContext;

  constructor(ctx: AiContext, id: string, candidateActions: readonly CandidateAction[]) {
    this.ctx = ctx;
    this.id = id;
    this.candidateActions = [...candidateActions];
  }

  addCandidateAction(ca: CandidateAction): void {
    this.candidateActions.push(ca);
  }

  /** Mirrors `[modify_ai] path=stage[id].candidate_action[<caId>] action=delete` (`*`: all of them). Returns whether one was actually removed. */
  deleteCandidateAction(caId: string): boolean {
    const before = this.candidateActions.length;
    this.candidateActions = caId === '*' ? [] : this.candidateActions.filter((ca) => ca.id !== caId);
    return this.candidateActions.length !== before;
  }

  listCandidateActions(): readonly CandidateAction[] {
    return this.candidateActions;
  }

  /** `vector_property_handler::handle_add`: an action with the same id is replaced; `position` inserts there, else appends. */
  insertCandidateAction(ca: CandidateAction, position = -1): void {
    if (ca.id !== '') this.deleteCandidateAction(ca.id);
    if (position >= 0 && position < this.candidateActions.length) this.candidateActions.splice(position, 0, ca);
    else this.candidateActions.push(ca);
  }

  /** `candidate_action_evaluation_loop::to_config`. */
  toConfig(): WmlConfig {
    const cfg = new WmlConfig();
    cfg.setAttribute('id', this.id);
    cfg.setAttribute('name', this.name);
    for (const ca of this.candidateActions) cfg.addChild('candidate_action', ca.config.clone());
    return cfg;
  }

  playStage(): boolean {
    for (const ca of this.candidateActions) ca.enable();

    let gamestateChanged = false;
    let executed = true;
    let executions = 0;

    while (executed) {
      executed = false;
      const sorted = [...this.candidateActions].sort((a, b) => b.maxScore - a.maxScore);

      let best: CandidateAction | undefined;
      let bestScore = BAD_SCORE;
      for (const ca of sorted) {
        if (!ca.enabled) continue;
        if (ca.maxScore <= bestScore) break; // early exit: see module doc comment
        let score: number;
        try {
          score = ca.evaluate();
        } catch (e) {
          this.ctx.host.log('error', `candidate_action ${ca.id} evaluate() threw: ${String(e)}`);
          ca.disable();
          continue;
        }
        if (score > bestScore) {
          bestScore = score;
          best = ca;
        }
      }

      if (best && bestScore > BAD_SCORE) {
        const before = this.ctx.gamestateSnapshot();
        try {
          best.execute();
        } catch (e) {
          this.ctx.host.log('error', `candidate_action ${best.id} execute() threw: ${String(e)}`);
          best.disable();
          // A throw is treated like "lied about having a move": disabled, but OTHER candidate actions still deserve a
          // turn this stage invocation -- set executed=true so the outer while loop doesn't mistake this for "nothing
          // left to do" and stop early (a real, previously-caught-by-this-test bug: `continue` alone left `executed`
          // false, silently ending the whole stage after just one broken CA instead of trying the next-best one).
          executed = true;
          continue;
        }
        executed = true;
        executions++;
        if (executions > EXECUTION_CAP) {
          this.ctx.host.log('warn', `RCA stage ${this.id}: execution cap (${EXECUTION_CAP}) reached, stopping this turn's evaluation loop`);
          break;
        }
        const after = this.ctx.gamestateSnapshot();
        if (after === before) {
          // The CA claimed a positive score but didn't actually change anything -- blacklisted for the rest of this stage invocation.
          best.disable();
        } else {
          gamestateChanged = true;
        }
      }
    }

    this.candidateActions = this.candidateActions.filter((ca) => !ca.toBeRemoved);
    return gamestateChanged;
  }
}
