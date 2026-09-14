/**
 * Shared types for Phase 29's real AI port (the RCA candidate-action
 * framework, `src/ai/` upstream). `AiAction`/`AiAnimationEvent` are moved
 * verbatim from the Phase 7 heuristic (`ai/simpleAi.ts`, removed once this
 * framework replaces it in S5) so `packages/ui`'s animation-replay contract
 * (`GameShell.playAiAnimations`) needs no changes when the swap happens.
 */

import type { Location } from '../model/Location.js';
import type { Unit } from '../model/Unit.js';
import type { UnitType } from '../model/UnitType.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Rng } from '../rng/Rng.js';
import type { WmlConfig } from '../wml/config.js';
import type { AttackResult } from '../actions/combat.js';

export type AiActionKind = 'recruit' | 'move' | 'attack' | 'advance';

/**
 * Enough raw data for a caller with a renderer (`packages/ui`'s
 * `GameShell.svelte`) to build and play the same real per-action
 * animation a human's own move/attack/recruit already gets.
 */
export type AiAnimationEvent =
  | { readonly kind: 'move'; readonly unit: Unit; readonly path: readonly Location[] }
  | {
      readonly kind: 'attack';
      readonly attacker: Unit;
      readonly attackerWeaponIndex: number;
      readonly defender: Unit;
      readonly defenderWeaponIndex: number;
      readonly result: AttackResult;
      readonly attackerTypeId: string;
      readonly defenderTypeId: string;
      readonly attackerHitpointsBefore: number;
      readonly defenderHitpointsBefore: number;
      /**
       * Where each combatant stood AS OF THIS EXCHANGE (bugs4.md #2/#3). The
       * whole side turn resolves before any animation plays back, so a unit
       * that acts again later in the same turn would otherwise animate at
       * its final hex -- frozen here, like `move`'s own `path`.
       */
      readonly attackerLocation: Location;
      readonly defenderLocation: Location;
    }
  | {
      readonly kind: 'recruit';
      readonly unit: Unit;
      readonly leader: Unit;
      /** Frozen at recruit time, same rationale as the attack variant -- a recruiting leader routinely moves off its keep later that turn. */
      readonly unitLocation: Location;
      readonly leaderLocation: Location;
    };

export interface AiAction {
  readonly kind: AiActionKind;
  /** Human-readable summary, ready to drop into a UI log; empty for a sub-step (e.g. repositioning before an attack) real for animation purposes but not worth its own log line. */
  readonly message: string;
  readonly animation?: AiAnimationEvent;
}

/**
 * Everything an `AiContext` (and the candidate actions it drives) needs
 * from its host (`packages/ui`'s `GameSession`, or a headless test) --
 * mirrors upstream's `ai::manager`/`resources::*` global access, made
 * explicit and injectable instead. `raise`/`pump` let the AI's own
 * actions fire the same WML events a human's actions do (`moveto`,
 * `capture`, `attack`, `attack end`, `last breath`, `die`, `sighted`) --
 * see `actions/moveSequence.ts`/`attackSequence.ts` (Phase 29 S0), which
 * `ai/actions.ts` (S1) threads this through to.
 */
export interface AiHost {
  readonly board: GameBoard;
  readonly rng: Rng;
  readonly resolveType: (id: string) => UnitType;
  readonly lawfulBonusAt: (loc: Location) => number;
  readonly maxLiminalBonus: number;
  readonly turnNumber: () => number;
  readonly timeOfDayId: () => string;
  readonly raise: (name: string, loc1?: Location, loc2?: Location, data?: WmlConfig) => void;
  /** Fires an event IMMEDIATELY (not queued), for `last breath`/`die` -- must run while a dying unit is still on the board (mirrors `GameSession.confirmAttack`'s own `fire:` callback to `performAttack`, Phase 29 S2's `AiContext.executeAttack`). */
  readonly fire: (name: string, loc1: Location, loc2: Location) => void;
  /** Drains anything `raise` queued (mirrors `GameSession.pumpEvents`); called by the AI after each executed action. */
  readonly pump: () => void;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** True once `[endlevel]`/a leader loss has ended the scenario mid-turn -- the AI stops acting immediately when this flips. */
  readonly scenarioEnded: () => boolean;
}
