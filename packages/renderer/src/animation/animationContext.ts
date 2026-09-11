/**
 * The animation-context schema, transcribed directly from
 * `units/animation.hpp`'s `unit_animation::matches_headless()` parameter
 * list — see `docs/ARCHITECTURE.md`'s "Animation event context" section for
 * why this is ported as a named, tested contract rather than whatever
 * subset seems sufficient at the time:
 *
 *   int matches_headless(loc, second_loc, my_unit, event, value, hit,
 *     attack, second_attack, value2, terrain_at_loc, second_unit) const;
 *
 * This module defines that schema as `AnimationContext`, plus builders that
 * construct one from what `packages/engine`'s `actions/combat.ts`
 * (`AttackResult`/`AttackBlowResult`) and `actions/move.ts` (`MoveResult`)
 * already report — see each builder's doc comment for exactly which real
 * engine fields feed which `matches_headless` parameter, verified against
 * `units/udisplay.cpp`'s `unit_attack()` (the real call site that wires
 * combat results into animation-matching upstream).
 */

import type { AttackBlowResult, AttackResult } from '@wesnothweb2/engine/src/actions/combat.js';
import type { GameBoard } from '@wesnothweb2/engine/src/model/GameBoard.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import type { TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import type { AttackType } from '@wesnothweb2/engine/src/model/UnitType.js';
import type { Unit } from '@wesnothweb2/engine/src/model/Unit.js';

/** Mirrors `strike_result::type` (units/strike_result.hpp). */
export type StrikeResult = 'hit' | 'miss' | 'kill' | 'invalid';

/**
 * TS transcription of `matches_headless`'s parameter list. `myUnit.facing`
 * (already a `Unit` field) stands in for what upstream reads via
 * `my_unit->facing()` inside `matches_headless` itself — there is no
 * separate "direction" parameter upstream, so there isn't one here either.
 */
export interface AnimationContext {
  readonly loc: Location;
  readonly secondLoc: Location;
  readonly myUnit: Unit;
  readonly event: string;
  readonly value: number;
  readonly value2: number;
  readonly hit: StrikeResult;
  readonly attack?: AttackType;
  readonly secondAttack?: AttackType;
  readonly terrainAtLoc: TerrainCode;
  readonly secondUnit?: Unit;
}

/** Looks up the terrain at `loc` on `board`'s map — the "board/terrain lookup" `matches_headless` needs beyond what combat/move results carry. */
export function terrainLookup(board: GameBoard): (loc: Location) => TerrainCode {
  return (loc: Location) => board.map.getTerrain(loc);
}

/**
 * Mirrors `units/udisplay.cpp`'s `unit_attack()` (~L642-649): the strike
 * result upstream derives is `kill` if the blow was lethal, `hit` if it
 * dealt any damage, else `miss`. Our own `AttackBlowResult` already knows
 * hit/kill precisely (including drain/poison/petrify edge cases upstream's
 * `damage > 0` heuristic doesn't need to worry about), so this reads it
 * directly rather than re-deriving from a damage/HP comparison.
 */
export function strikeResultOf(blow: AttackBlowResult): StrikeResult {
  if (!blow.hit) return 'miss';
  return blow.targetDied ? 'kill' : 'hit';
}

export interface AttackBlowAnimationContexts {
  readonly attackerContext: AnimationContext;
  readonly defenderContext: AnimationContext;
}

/**
 * Builds the striking unit's "attack" and receiving unit's "defend"
 * `AnimationContext`s for one blow of an attack exchange, mirroring
 * `unit_attack()`'s two `animator.add_animation(...)` call sites
 * (udisplay.cpp ~L653-661) AND, critically, `attack::perform_hit`'s own
 * role-swap (actions/attack.cpp ~L855-856: `unit_info& attacker =
 * attacker_turn ? a_ : d_; unit_info& defender = attacker_turn ? d_ :
 * a_;`) -- **real per-blow "attacker"/"defender" is NOT the same as the
 * combat's overall attacker/defender**: on a defender's retaliation blow
 * (`blow.attackerTurn === false`), it's the DEFENDER who plays the
 * "attack" animation with ITS OWN weapon, and the original attacker who
 * plays "defend". Getting this wrong means every retaliation blow shows
 * the wrong unit swinging (a real bug caught by finally wiring this into
 * live UI playback, 2026-09-11 -- see `docs/PROGRESS.md`).
 *
 *  - striker: loc=strikerLoc, secondLoc=receiverLoc, event="attack",
 *    value=damage, value2=swing index, attack=striker's own weapon,
 *    secondAttack=receiver's weapon.
 *  - receiver: loc=receiverLoc, secondLoc=strikerLoc, event="defend",
 *    same value/value2/hit — **and `attack` is still the STRIKER's
 *    weapon** (upstream's `choose_animation` call passes the same
 *    `weapon` it used for the striker), not the receiver's own; this
 *    lets a `[defend]` block's `[filter_attack]` react to what it's
 *    being hit *by* (e.g. "defend differently against ranged attacks").
 *
 * `attacker`/`defender` params are still named for the COMBAT's overall
 * roles (matching every other caller in this codebase, e.g.
 * `combat.ts`'s `AttackResult`) — this function itself resolves which of
 * them is actually striking THIS blow via `blow.attackerTurn`. Passed
 * explicitly (not looked up on `board`) because a lethal blow removes
 * the loser from the board before this would be called — the caller
 * (which already has both `Unit` references from setting up the attack)
 * should hold onto them rather than re-resolving.
 */
export function buildAttackBlowAnimationContexts(
  attacker: Unit,
  attackerWeapon: AttackType | undefined,
  defender: Unit,
  defenderWeapon: AttackType | undefined,
  blow: AttackBlowResult,
  swingIndex: number,
  terrainAt: (loc: Location) => TerrainCode,
): AttackBlowAnimationContexts {
  const hit = strikeResultOf(blow);
  const damage = blow.damage;

  const striker = blow.attackerTurn ? attacker : defender;
  const strikerWeapon = blow.attackerTurn ? attackerWeapon : defenderWeapon;
  const receiver = blow.attackerTurn ? defender : attacker;
  const receiverWeapon = blow.attackerTurn ? defenderWeapon : attackerWeapon;

  const attackerContext: AnimationContext = {
    loc: striker.location,
    secondLoc: receiver.location,
    myUnit: striker,
    event: 'attack',
    value: damage,
    value2: swingIndex,
    hit,
    attack: strikerWeapon,
    secondAttack: receiverWeapon,
    terrainAtLoc: terrainAt(striker.location),
    secondUnit: receiver,
  };

  const defenderContext: AnimationContext = {
    loc: receiver.location,
    secondLoc: striker.location,
    myUnit: receiver,
    event: 'defend',
    value: damage,
    value2: swingIndex,
    hit,
    attack: strikerWeapon, // see doc comment: intentionally the STRIKER's weapon, not the receiver's own
    secondAttack: receiverWeapon,
    terrainAtLoc: terrainAt(receiver.location),
    secondUnit: striker,
  };

  return { attackerContext, defenderContext };
}

/**
 * Convenience over `buildAttackBlowAnimationContexts` for a full
 * `AttackResult`: builds the per-blow context pairs in swing order (`value2`
 * counts up from 0, matching upstream's `swing` parameter — see
 * `actions/attack.cpp`'s per-blow loop, which increments a swing counter
 * each `perform_hit()` call).
 *
 * `AttackResult`/`BattleContextUnitStats` (`actions/combat.ts`,
 * `actions/attackPrediction.ts`) don't carry the `AttackType` objects
 * themselves (only derived stats), so the caller — which already selected
 * `attackerWeaponIndex`/`defenderWeaponIndex` to call `executeAttack` —
 * passes them through explicitly here.
 */
export function buildAttackAnimationContexts(
  attacker: Unit,
  attackerWeapon: AttackType | undefined,
  defender: Unit,
  defenderWeapon: AttackType | undefined,
  result: AttackResult,
  terrainAt: (loc: Location) => TerrainCode,
): AttackBlowAnimationContexts[] {
  return result.blows.map((blow, i) =>
    buildAttackBlowAnimationContexts(attacker, attackerWeapon, defender, defenderWeapon, blow, i, terrainAt));
}

/**
 * Builds a "movement" `AnimationContext` for one step of a move (from one
 * entered hex to the next), mirroring `units/udisplay.cpp`'s per-step
 * `animator_.add_animation(unit, "movement", from_hex, to_hex)` call.
 * `unit.facing` must already reflect this step's direction of travel (as
 * `actions/move.ts`'s `executeMove` sets it) since `matches_headless` reads
 * facing off the unit itself, not a context field — see `AnimationContext`'s
 * doc comment.
 */
export function buildMovementAnimationContext(
  unit: Unit,
  from: Location,
  to: Location,
  terrainAt: (loc: Location) => TerrainCode,
): AnimationContext {
  return {
    loc: from,
    secondLoc: to,
    myUnit: unit,
    event: 'movement',
    value: 0,
    value2: 0,
    hit: 'invalid',
    terrainAtLoc: terrainAt(from),
  };
}

/** Builds one `AnimationContext` per step transition in a `MoveResult.path`, for a "movement" animation per hex entered. */
export function buildMovementAnimationContexts(
  unit: Unit,
  path: readonly Location[],
  terrainAt: (loc: Location) => TerrainCode,
): AnimationContext[] {
  const contexts: AnimationContext[] = [];
  for (let i = 1; i < path.length; i++) {
    contexts.push(buildMovementAnimationContext(unit, path[i - 1]!, path[i]!, terrainAt));
  }
  return contexts;
}
