/**
 * A real, working (if deliberately simple) AI for `controller=ai` sides --
 * Phase 7, previously entirely unstarted (every `ai`-controlled side was,
 * until now, actually played by whichever human sat at the keyboard in
 * this project's hotseat model -- see `GameSession.endTurn`'s own doc
 * comment).
 *
 * This is NOT a port of upstream's real AI (`data/ai/default/`,
 * `src/ai/composite/`): that's a full candidate-action/aspect framework
 * with its own Lua-configurable scoring, far beyond what a single-session
 * addition should attempt, and this project's standing philosophy is to
 * build the narrowest real thing that actually works rather than a
 * speculative full port. What IS real here: every number this AI bases
 * decisions on comes from the SAME tested engine code a human player's
 * own UI uses --
 *  - Attack scoring reuses `combatStats.ts`'s `buildBattleContext` and
 *    `attackPrediction.ts`'s `simulateCombat` (the exact combat-prediction
 *    math `GameSession.buildPreview` shows a human before they confirm an
 *    attack), including leadership/steadfast/backstab
 *    (`abilityEffects.ts`/`combat.ts`), not a hand-waved damage estimate.
 *  - Movement uses the real `reachableHexes`/`findPath` (ZoC- and
 *    terrain-cost-aware).
 *  - Recruiting uses the real `checkRecruitLocation`/`findVacantCastleTile`/
 *    `recruitUnit`.
 *
 * The DECISION policy itself is a simple, documented heuristic (not
 * upstream's): recruit greedily by a rough hitpoints+damage-per-cost
 * score while gold and a vacant castle tile allow; then, per unit still
 * able to act, evaluate every (reachable hex, adjacent enemy, own
 * weapon) combination's predicted expected-damage-dealt minus
 * expected-damage-taken (with a heavy bonus for a likely kill and
 * penalty for a likely death) and take the best one if it clears a
 * "not a bad trade" threshold; otherwise move toward an unowned/enemy
 * village if one is reachable, else toward the nearest enemy unit it can
 * see. Pathfinding, attack targets and "nearest enemy" all respect the
 * AI side's own fog and `hides` visibility, like upstream's AI.
 */

import { getVisibleUnit, isUnitVisibleToTeam } from '../pathfind/visibility.js';
import { Location, distanceBetween, getAdjacentTiles } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';
import type { UnitType } from '../model/UnitType.js';
import type { Rng } from '../rng/Rng.js';
import { reachableHexes, findPath, type PathStep } from '../pathfind/pathfind.js';
import { executeMove, type MoveResult } from '../actions/move.js';
import { findVacantCastleTile, recruitUnit } from '../actions/recruit.js';
import { executeAttack, isBackstabActive, type AttackResult } from '../actions/combat.js';
import { buildBattleContext, chooseDefenderWeaponIndex, type UnitStatsOptions } from '../actions/combatStats.js';
import { simulateCombat } from '../actions/attackPrediction.js';
import { computeLeadershipBonus, computeResistanceModifier } from '../actions/abilityEffects.js';
import { advanceUnitFully } from '../actions/advancement.js';

export interface AiTurnOptions {
  /** Resolves a recruit-list/type id to its real `UnitType` (see `combat.ts`'s plague `resolveType` param for the same established pattern -- this module has no snapshot access of its own). */
  readonly resolveType: (id: string) => UnitType;
  /** The real, location-aware ToD lawful_bonus (schedule + `[time_area]` + `[illuminates]`, see `actions/illumination.ts`'s `effectiveTimeOfDayAt`) -- omit for a permanently neutral board. */
  readonly lawfulBonusAt?: (loc: Location) => number;
  readonly maxLiminalBonus?: number;
  /** A trade is taken only if its score clears this bar (net expected HP swing, kill/death-weighted -- see `evaluateAttack`). Default 0 (never take a clearly net-negative trade); lower it to make the AI more aggressive. */
  readonly attackScoreThreshold?: number;
}

export type AiActionKind = 'recruit' | 'move' | 'attack' | 'advance';

/**
 * Enough raw data for a caller with a renderer (`packages/ui`'s
 * `GameShell.svelte`) to build and play the same real per-action
 * animation a human's own move/attack/recruit already gets -- see
 * `AiAction.animation`'s own doc comment for why this exists as a
 * separate, explicit field rather than something the caller re-derives
 * from board state after the fact.
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
      /** `attacker`/`defender`'s real type id AS OF THIS EXCHANGE, before `advanceUnitFully` below can mutate either unit's `.type` -- see `LastAttackAnimation.attackerTypeId`'s doc comment (packages/ui/src/gameSession.ts) for the full rationale; this mirrors it for the AI's own attack path. */
      readonly attackerTypeId: string;
      readonly defenderTypeId: string;
      /** `attacker`/`defender`'s real hitpoints BEFORE this exchange -- see `LastAttackAnimation.attackerHitpointsBefore`'s doc comment for the full rationale (per-blow HP bar preview during animation playback); this mirrors it for the AI's own attack path. */
      readonly attackerHitpointsBefore: number;
      readonly defenderHitpointsBefore: number;
      /**
       * `attacker`/`defender`'s real location AS OF THIS EXCHANGE -- real,
       * reported bug (bugs4.md #2/#3): a caller building this event's
       * animation cues used to read `attacker.location`/`defender.location`
       * LIVE, well after `playAiTurn` had already resolved the WHOLE rest
       * of this side's turn (every `AiAnimationEvent` this function returns
       * is only ever consumed after the fact, one whole turn at a time --
       * see `AiAction.animation`'s own doc comment). If `attacker` went on
       * to take a LATER action this same turn (a unit can attack and still
       * have moves left, e.g. after a scripted reposition-then-attack, or
       * simply be reused by a later `decideMove` pass), its animation
       * played back at that FINAL location instead of where this exchange
       * actually happened -- e.g. a leader that recruited then moved
       * showing its "recruiting" animation at its post-move hex instead of
       * on its keep. Captured here, at the moment this action is decided,
       * exactly like `move`'s own `path` above.
       */
      readonly attackerLocation: Location;
      readonly defenderLocation: Location;
    }
  | {
      readonly kind: 'recruit';
      readonly unit: Unit;
      readonly leader: Unit;
      /** Same rationale as the `attack` variant's `attackerLocation`/`defenderLocation` above (bugs4.md #2/#3) -- `leader` in particular routinely takes a later action (moving) this same turn after recruiting. */
      readonly unitLocation: Location;
      readonly leaderLocation: Location;
    };

export interface AiAction {
  readonly kind: AiActionKind;
  /** Human-readable summary, ready to drop straight into a UI log (matches this project's other `string` log-line conventions). Empty for a sub-step (e.g. repositioning before an attack) that's real for animation purposes but not worth its own log line -- callers appending to a log should skip empty messages. */
  readonly message: string;
  /**
   * Real, reported bug (bugs2.md "animations during AI turn"): every AI
   * move/attack/recruit used to apply directly to `board` with nothing a
   * caller could animate -- `GameSession.lastAttackAnimation`'s own doc
   * comment documents this as a deliberate simplification at the time,
   * which this field reverses. `playAiTurn` still fully resolves the
   * side's whole turn synchronously (so `board` is already at its final
   * state by the time this function returns) -- callers that want to
   * animate should read `AiAction[]` in order and, for each one with an
   * `animation`, build + play the corresponding cues (reusing this
   * project's existing `buildMoveAnimationCues`/`buildBlowAnimationCues`/
   * `buildRecruitAnimationCues` logic) BEFORE reconciling the renderer to
   * the final board state, since each cue's own src/dst hex data is what
   * actually drives the visual, not `board`'s live positions.
   */
  readonly animation?: AiAnimationEvent;
}

const DEFAULT_ATTACK_SCORE_THRESHOLD = 0;

/** Rough, deliberately simple "how good is this unit type for its cost" score used to rank recruits -- not upstream's real recruitment aspect (which weighs terrain/matchups/ambush econ), just hitpoints plus best-attack damage output. */
function recruitPowerScore(type: UnitType): number {
  const bestAttackDamage = type.attacks.reduce((max, a) => Math.max(max, a.damage * a.numAttacks), 0);
  return type.hitpoints + bestAttackDamage * 3;
}

function doRecruiting(board: GameBoard, side: number, rng: Rng, options: AiTurnOptions, actions: AiAction[]): void {
  const team = board.getTeam(side);
  if (!team) return;

  for (;;) {
    const leader = board.unitsForSide(side).find((u) => u.canRecruit && board.map.isKeep(u.location));
    if (!leader) return;
    const vacant = findVacantCastleTile(board, leader);
    if (!vacant) return;

    const affordable = [...team.canRecruit]
      .map((id) => options.resolveType(id))
      .filter((t) => t.cost <= team.gold);
    if (affordable.length === 0) return;

    affordable.sort((a, b) => recruitPowerScore(b) / Math.max(1, b.cost) - recruitPowerScore(a) / Math.max(1, a.cost));
    const chosen = affordable[0]!;
    const leaderLocation = leader.location;
    const result = recruitUnit(board, team, chosen, vacant, leaderLocation, rng);
    const unitLocation = result.unit.location;
    actions.push({
      kind: 'recruit',
      message: `${team.teamName || `Side ${side}`} recruited a ${chosen.name} for ${result.cost}g.`,
      animation: { kind: 'recruit', unit: result.unit, leader, unitLocation, leaderLocation },
    });
  }
}

/**
 * Predicted expected value of `unit` (currently at `fromLoc`, hypothetically
 * -- may differ from `unit.location` if this is evaluating a not-yet-taken
 * move) attacking `target` with `unit.attacks[weaponIndex]`, reusing the
 * exact same `buildBattleContext`/`simulateCombat` machinery a human's
 * attack preview uses. Temporarily relocates `unit` on `board` for the
 * duration of the call so leadership/backstab (which scan real board
 * adjacency) see the hypothetical position, then restores it -- see
 * module doc comment.
 */
function evaluateAttack(board: GameBoard, unit: Unit, fromLoc: Location, target: Unit, weaponIndex: number, options: AiTurnOptions): number {
  const weapon = unit.attacks[weaponIndex];
  if (!weapon) return -Infinity;
  // A real move can never end (or hypothetically stand) on a hex some other
  // unit already occupies -- `findRoutes` only blocks *enemy*-occupied hexes
  // (allies are legal to path *through* but not to stop on), so an
  // ally-occupied hex can still show up in `destinations`. Without this
  // guard, the temporary relocation below would silently overwrite (and
  // permanently lose) whatever unit already stood at `fromLoc`. Real,
  // reported bug: AI units vanishing when a colleague was evaluated as if
  // standing on their hex.
  const occupant = board.unitAt(fromLoc);
  if (occupant && occupant !== unit) return -Infinity;
  const distance = 1;
  const attackerTerrainDefense = unit.defenseModifier(board.map.getTerrain(fromLoc));
  const defenderTerrainDefense = target.defenseModifier(board.map.getTerrain(target.location));
  const defenderWeaponIndex = chooseDefenderWeaponIndex(unit, weaponIndex, target, distance, attackerTerrainDefense, defenderTerrainDefense);
  const defenderWeapon = defenderWeaponIndex >= 0 ? target.attacks[defenderWeaponIndex] : undefined;

  const originalLoc = unit.location;
  board.moveUnit(originalLoc, fromLoc);
  try {
    const abilityOptions: UnitStatsOptions = {
      attackerLawfulBonus: options.lawfulBonusAt?.(fromLoc) ?? 0,
      defenderLawfulBonus: options.lawfulBonusAt?.(target.location) ?? 0,
      maxLiminalBonus: options.maxLiminalBonus ?? 0,
      backstabActive: isBackstabActive(board, fromLoc, target.location),
      attackerLeadershipBonus: computeLeadershipBonus(board, unit),
      defenderLeadershipBonus: computeLeadershipBonus(board, target),
      attackerResistanceModifier: computeResistanceModifier(board, target, weapon.type, false, target.location),
      defenderResistanceModifier: defenderWeapon ? computeResistanceModifier(board, unit, defenderWeapon.type, true, fromLoc) : undefined,
    };

    const { attacker: aStats, defender: dStats } = buildBattleContext({
      attacker: unit,
      attackerWeapon: weapon,
      defender: target,
      defenderWeapon,
      distance,
      attackerTerrainDefense,
      defenderTerrainDefense,
      options: abilityOptions,
    });
    const { attacker: aCombatant, defender: dCombatant } = simulateCombat(aStats, dStats);

    const damageDealt = target.hitpoints - dCombatant.averageHp();
    const damageTaken = unit.hitpoints - aCombatant.averageHp();
    const killBonus = dCombatant.hpDist[0]! * 60;
    const deathPenalty = aCombatant.hpDist[0]! * 50;
    return damageDealt - damageTaken + killBonus - deathPenalty;
  } finally {
    board.moveUnit(fromLoc, originalLoc);
  }
}

interface AttackCandidate {
  readonly destination: Location;
  readonly target: Unit;
  readonly weaponIndex: number;
  readonly score: number;
}

function bestAttack(board: GameBoard, unit: Unit, destinations: readonly PathStep[], options: AiTurnOptions): AttackCandidate | undefined {
  if (unit.attacksLeft <= 0) return undefined;
  let best: AttackCandidate | undefined;
  for (const step of destinations) {
    // Skip hexes some other unit already occupies -- see evaluateAttack's
    // doc comment for why this matters (`destinations` can legally include
    // ally-occupied pass-through hexes the unit could never actually stop on).
    const occupant = board.unitAt(step.curr);
    if (occupant && occupant !== unit) continue;
    for (const adj of getAdjacentTiles(step.curr)) {
      const target = getVisibleUnit(board, adj, board.getTeam(unit.side), false);
      if (!target || target.side === unit.side) continue;
      const targetTeam = board.getTeam(target.side);
      const ownTeam = board.getTeam(unit.side);
      if (!targetTeam || !ownTeam || !ownTeam.isEnemy(targetTeam)) continue;
      for (let weaponIndex = 0; weaponIndex < unit.attacks.length; weaponIndex++) {
        const score = evaluateAttack(board, unit, step.curr, target, weaponIndex, options);
        if (!best || score > best.score) {
          best = { destination: step.curr, target, weaponIndex, score };
        }
      }
    }
  }
  return best;
}

function nearestEnemyLocation(board: GameBoard, unit: Unit): Location | undefined {
  const team = board.getTeam(unit.side);
  let best: Location | undefined;
  let bestDist = Infinity;
  for (const other of board.allUnits()) {
    if (other.side === unit.side) continue;
    const otherTeam = board.getTeam(other.side);
    if (!team || !otherTeam || !team.isEnemy(otherTeam)) continue;
    if (!isUnitVisibleToTeam(board, other, team, false)) continue;
    const d = distanceBetween(unit.location, other.location);
    if (d < bestDist) {
      bestDist = d;
      best = other.location;
    }
  }
  return best;
}

function moveUnitTo(board: GameBoard, unit: Unit, dest: Location): MoveResult | undefined {
  const route = findPath(board, unit, dest);
  if (route.steps.length === 0) return undefined;
  return executeMove(board, unit, route.steps);
}

/** Movement-only fallback for a unit with no worthwhile attack: capture a reachable unowned/enemy village, else close distance to the nearest enemy. Pushes a real `move` action (message + animation) if it moved. */
function decideMove(board: GameBoard, unit: Unit, destinations: readonly PathStep[], actions: AiAction[]): void {
  const candidates = destinations.filter((d) => !d.curr.equals(unit.location));
  if (candidates.length === 0) return;

  const villageDest = candidates.find((d) => board.map.isVillage(d.curr) && board.villageOwner(d.curr) !== unit.side);
  if (villageDest) {
    const result = moveUnitTo(board, unit, villageDest.curr);
    if (result) {
      actions.push({
        kind: 'move',
        message: `${unit.type.name} advanced to capture a village.`,
        animation: { kind: 'move', unit, path: result.path },
      });
    }
    return;
  }

  const enemyLoc = nearestEnemyLocation(board, unit);
  if (!enemyLoc) return;
  const currentDist = distanceBetween(unit.location, enemyLoc);
  let bestDest: Location | undefined;
  let bestDist = currentDist;
  for (const d of candidates) {
    const dist = distanceBetween(d.curr, enemyLoc);
    if (dist < bestDist) {
      bestDist = dist;
      bestDest = d.curr;
    }
  }
  if (bestDest) {
    const result = moveUnitTo(board, unit, bestDest);
    if (result) {
      actions.push({
        kind: 'move',
        message: `${unit.type.name} advanced toward the enemy.`,
        animation: { kind: 'move', unit, path: result.path },
      });
    }
  }
}

/**
 * Plays one `ai`-controlled side's entire turn: recruits while it can
 * afford to, then gives every unit still able to act a chance to attack
 * (if a worthwhile trade exists) or otherwise move, and returns a log of
 * what happened -- ready for a caller (`GameSession`, or a headless test)
 * to append to its own turn log. Does not itself call `endTurn`; the
 * caller decides when the side's turn is over (immediately after, for
 * this AI, since it never intentionally holds units back).
 */
export function playAiTurn(board: GameBoard, side: number, rng: Rng, options: AiTurnOptions): AiAction[] {
  const actions: AiAction[] = [];
  doRecruiting(board, side, rng, options, actions);

  const threshold = options.attackScoreThreshold ?? DEFAULT_ATTACK_SCORE_THRESHOLD;
  // Snapshot the unit list once: units recruited this turn have 0 moves/attacks
  // (see `recruit.ts`'s `placeRecruit`) so they're naturally skipped below,
  // and a unit that dies mid-turn is simply absent from `board` by the time
  // its own iteration would have been reached.
  for (const unit of board.unitsForSide(side)) {
    if (unit.attacksLeft <= 0 && unit.movesLeft <= 0) continue;
    if (!board.allUnits().includes(unit)) continue; // died earlier this loop (e.g. a prior unit's plague/kill somehow reached it)

    const { destinations } = reachableHexes(board, unit, { viewingTeam: board.getTeam(unit.side) });
    const steps = destinations.values();

    const attack = bestAttack(board, unit, steps, options);
    if (attack && attack.score >= threshold) {
      if (!attack.destination.equals(unit.location)) {
        const moveResult = moveUnitTo(board, unit, attack.destination);
        // Real animation for the repositioning step, but no separate log
        // line -- the attack message below already covers the outcome.
        if (moveResult) actions.push({ kind: 'move', message: '', animation: { kind: 'move', unit, path: moveResult.path } });
      }
      const attackerName = unit.type.name;
      const defender = attack.target;
      const defenderName = defender.type.name;
      const attackerTerrainDefense = unit.defenseModifier(board.map.getTerrain(unit.location));
      const defenderTerrainDefense = defender.defenseModifier(board.map.getTerrain(defender.location));
      const defenderWeaponIndex = chooseDefenderWeaponIndex(
        unit,
        attack.weaponIndex,
        defender,
        1,
        attackerTerrainDefense,
        defenderTerrainDefense,
      );
      const attackerHitpointsBefore = unit.hitpoints;
      const defenderHitpointsBefore = defender.hitpoints;
      const attackerLocation = unit.location;
      const defenderLocation = defender.location;
      const result = executeAttack(board, rng, unit.location, attack.weaponIndex, defender.location, defenderWeaponIndex, {
        attackerLawfulBonus: options.lawfulBonusAt?.(unit.location),
        defenderLawfulBonus: options.lawfulBonusAt?.(defender.location),
        maxLiminalBonus: options.maxLiminalBonus,
        resolveType: options.resolveType,
      });
      if (!result.attackerDied) unit.movesLeft = 0; // mirrors GameSession.confirmAttack's "attack cancels movement" rule.
      actions.push({
        kind: 'attack',
        message: `${attackerName} attacked ${defenderName}: ${result.blows.filter((b) => b.hit).length}/${result.blows.length} blows landed.`,
        animation: {
          kind: 'attack',
          attacker: unit,
          attackerWeaponIndex: attack.weaponIndex,
          defender,
          defenderWeaponIndex,
          result,
          // Captured now, before advanceUnitFully (below) can mutate either
          // unit's `.type` -- see AiAnimationEvent's attack variant doc comment.
          attackerTypeId: unit.type.id,
          defenderTypeId: defender.type.id,
          attackerHitpointsBefore,
          defenderHitpointsBefore,
          attackerLocation,
          defenderLocation,
        },
      });
      // Real Wesnoth checks both combatants for advancement right after
      // the exchange (attack_unit_and_advance, actions/attack.cpp); the
      // AI always picks randomly among its options (no dialog -- see
      // advancement.ts's own doc comment on why that's the right call
      // for a non-human side).
      if (!result.attackerDied) {
        for (const step of advanceUnitFully(board, unit, rng, options.resolveType)) {
          actions.push({ kind: 'advance', message: `${step.fromTypeId} advances to ${step.toTypeId}!` });
        }
      }
      if (!result.defenderDied) {
        for (const step of advanceUnitFully(board, defender, rng, options.resolveType)) {
          actions.push({ kind: 'advance', message: `${step.fromTypeId} advances to ${step.toTypeId}!` });
        }
      }
      continue;
    }

    decideMove(board, unit, steps, actions);
  }

  return actions;
}
