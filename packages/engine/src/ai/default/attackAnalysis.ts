/**
 * TS port of `attack_analysis` (`src/ai/default/attack.cpp`): given a
 * sequence of (attacker, destination) `movements` all converging on one
 * `target`, `analyze()` simulates the whole exchange (each attacker in
 * turn, chaining the defender's accumulated damage via `prevDef`,
 * mirroring upstream's `prev_def`) and fills in the derived fields
 * `rating()` then scores from. Built incrementally by `aspectAttacks.ts`'s
 * `doAttackAnalysis` (one candidate combo at a time); `rating()` is what
 * `caCombat.ts` picks the best combo by.
 *
 * Documented simplification vs. upstream: `choose_attacker_weapon`'s
 * per-candidate-weapon simulation (used only to PICK which weapon each
 * attacker uses) is NOT itself chained against `prevDef` here -- upstream
 * threads `prev_def` all the way through weapon selection too, so a
 * nearly-dead defender can change which weapon looks best; this port picks
 * the weapon from a fresh (unchained) simulation via the shared
 * `chooseDefenderWeaponIndex`/`betterCombat` (also used by the human attack
 * preview and `simpleAi.ts`, neither of which has a `prevDef` concept), then
 * builds the REAL, scored combat with that weapon chained against
 * `prevDef`. Only the weapon CHOICE heuristic is approximate; the actual
 * scoring numbers are correctly chained.
 */

import { getAdjacentTiles, type Location } from '../../model/Location.js';
import type { GameBoard } from '../../model/GameBoard.js';
import type { Unit } from '../../model/Unit.js';
import type { UnitStatsOptions } from '../../actions/combatStats.js';
import { buildBattleContext, chooseDefenderWeaponIndex, betterCombat } from '../../actions/combatStats.js';
import { Combatant, simulateCombat } from '../../actions/attackPrediction.js';
import { isBackstabActive } from '../../actions/combat.js';
import { computeLeadershipBonus, computeResistanceModifier } from '../../actions/abilityEffects.js';
import { POISON_AMOUNT, killXp, combatXp } from '../../actions/gameConfig.js';
import { bestDefensivePosition } from '../powerProjection.js';
import type { MoveMap } from '../moveMaps.js';
import type { AiContext } from '../context.js';

export interface AttackMovement {
  readonly from: Location;
  readonly to: Location;
}

/**
 * Mirrors `battle_context::choose_attacker_weapon` (`src/actions/attack.
 * cpp:415-466`): tries every weapon of `attacker` with a positive
 * `attackWeight`, picking the best-for-the-attacker `(attacker weapon,
 * defender counter)` pairing via `betterCombat` (harmWeight = 1 -
 * aggression). Not ported: the `disable` short-circuit (a weapon special
 * that disables itself against a given counter -- not modelled by this
 * port's simplified specials, see `combatStats.ts`'s own module doc
 * comment).
 */
export function chooseAttackerWeapon(
  attacker: Unit,
  defender: Unit,
  distance: number,
  attackerTerrainDefense: number,
  defenderTerrainDefense: number,
  aggression: number,
  options: UnitStatsOptions,
): { readonly attackerWeaponIndex: number; readonly defenderWeaponIndex: number } | undefined {
  const harmWeight = 1.0 - aggression;
  let best:
    | { attackerWeaponIndex: number; defenderWeaponIndex: number; attacker: Combatant; defender: Combatant; weight: number }
    | undefined;

  attacker.attacks.forEach((weapon, index) => {
    if (weapon.attackWeight <= 0) return;
    const defenderWeaponIndex = chooseDefenderWeaponIndex(
      attacker,
      index,
      defender,
      distance,
      attackerTerrainDefense,
      defenderTerrainDefense,
      options,
    );
    const defenderWeapon = defenderWeaponIndex >= 0 ? defender.attacks[defenderWeaponIndex] : undefined;
    const { attacker: aStats, defender: dStats } = buildBattleContext({
      attacker,
      attackerWeapon: weapon,
      defender,
      defenderWeapon,
      distance,
      attackerTerrainDefense,
      defenderTerrainDefense,
      options,
    });
    const { attacker: aCombatant, defender: dCombatant } = simulateCombat(aStats, dStats);

    if (!best || betterCombat(aCombatant, dCombatant, weapon.attackWeight, best.attacker, best.defender, best.weight, harmWeight)) {
      best = { attackerWeaponIndex: index, defenderWeaponIndex, attacker: aCombatant, defender: dCombatant, weight: weapon.attackWeight };
    }
  });

  return best;
}

export class AttackAnalysis {
  target!: Location;
  movements: AttackMovement[] = [];
  targetValue = 0;
  avgLosses = 0;
  chanceToKill = 0;
  avgDamageInflicted = 0;
  targetStartingDamage = 0;
  avgDamageTaken = 0;
  resourcesUsed = 0;
  terrainQuality = 0;
  alternativeTerrainQuality = 0;
  vulnerability = 0;
  support = 0;
  leaderThreat = false;
  usesLeader = false;
  isSurrounded = false;

  /** Shallow-ish copy (fresh `movements` array) -- upstream pushes `attack_analysis` into `result` BY VALUE (`result.push_back(cur_analysis)`), and the shared C++ object keeps mutating afterward during backtracking, so a JS reference push would alias every result. `doAttackAnalysis` calls this before each push. */
  clone(): AttackAnalysis {
    const copy = new AttackAnalysis();
    Object.assign(copy, this);
    copy.movements = [...this.movements];
    return copy;
  }

  /**
   * Mirrors `attack_analysis::analyze` (`attack.cpp:42-253`): simulates
   * every movement in `this.movements` against the unit currently at
   * `this.target`, filling in every derived scoring field. Temporarily
   * relocates each attacker to its planned destination (cumulatively --
   * later attackers in the sequence see earlier ones already in their new
   * position, exactly like upstream, which restores every unit only at the
   * very end) then restores them all.
   */
  analyze(board: GameBoard, ctx: AiContext, dstSrc: MoveMap, srcDst: MoveMap, enemyDstSrc: MoveMap, aggression: number): void {
    const defendUnit = board.unitAt(this.target);
    if (!defendUnit) throw new Error('AttackAnalysis.analyze: no unit at target location');

    // See if the target is a threat to our leader or an ally's leader.
    let leaderThreat = false;
    for (const adj of getAdjacentTiles(this.target)) {
      const u = board.unitAt(adj);
      if (u && u.canRecruit) {
        const uTeam = board.getTeam(u.side);
        if (uTeam && !ctx.team().isEnemy(uTeam)) {
          leaderThreat = true;
          break;
        }
      }
    }
    this.leaderThreat = leaderThreat;
    this.usesLeader = false;

    this.targetValue = defendUnit.type.cost;
    const defendExperience = defendUnit.type.advancesTo.length > 0 ? defendUnit.experience : 0;
    this.targetValue += (defendExperience / defendUnit.maxExperience) * this.targetValue;
    this.targetStartingDamage = defendUnit.maxHitpoints - defendUnit.hitpoints;

    // Alternative terrain quality: what defense could the attackers get if they repositioned instead of attacking.
    this.alternativeTerrainQuality = 0;
    let costSum = 0;
    const ppCtx = { turnNumber: ctx.turnNumber(), lawfulBonusAt: ctx.host.lawfulBonusAt, maxLiminalBonus: ctx.host.maxLiminalBonus };
    for (const m of this.movements) {
      const att = board.unitAt(m.from);
      if (!att) continue;
      const cost = att.type.cost;
      costSum += cost;
      const pos = bestDefensivePosition(board, m.from, srcDst, dstSrc, enemyDstSrc, ppCtx);
      this.alternativeTerrainQuality += cost * pos.chanceToHit;
    }
    this.alternativeTerrainQuality /= costSum * 100;

    this.avgDamageInflicted = 0;
    this.avgDamageTaken = 0;
    this.resourcesUsed = 0;
    this.terrainQuality = 0;
    this.avgLosses = 0;
    this.chanceToKill = 0;

    let defAvgExperience = 0;
    let firstChanceKill = 0;
    let probDeadAlready = 0;
    let prevDef: Combatant | undefined;
    let first = true;

    try {
      for (const m of this.movements) {
        const up = board.unitAt(m.from);
        if (!up) continue;
        board.moveUnit(m.from, m.to);

        let mAggression = aggression;
        if (up.canRecruit) {
          this.usesLeader = true;
          // Mirrors a real upstream quirk (attack.cpp:113, "FIXME: suokko's r29531 omitted this line") -- kept faithful.
          this.leaderThreat = false;
          mAggression = ctx.getLeaderAggression();
        }

        const distance = 1;
        const attackerTerrainDefense = up.defenseModifier(board.map.getTerrain(m.to));
        const defenderTerrainDefense = defendUnit.defenseModifier(board.map.getTerrain(this.target));
        const baseOptions: UnitStatsOptions = {
          backstabActive: isBackstabActive(board, m.to, this.target),
          attackerLeadershipBonus: computeLeadershipBonus(board, up),
          defenderLeadershipBonus: computeLeadershipBonus(board, defendUnit),
        };

        const choice = chooseAttackerWeapon(up, defendUnit, distance, attackerTerrainDefense, defenderTerrainDefense, mAggression, baseOptions);
        if (!choice) continue;

        const attackerWeapon = up.attacks[choice.attackerWeaponIndex]!;
        const defenderWeapon = choice.defenderWeaponIndex >= 0 ? defendUnit.attacks[choice.defenderWeaponIndex] : undefined;

        const { attacker: aStats, defender: dStats } = buildBattleContext({
          attacker: up,
          attackerWeapon,
          defender: defendUnit,
          defenderWeapon,
          distance,
          attackerTerrainDefense,
          defenderTerrainDefense,
          options: {
            ...baseOptions,
            attackerResistanceModifier: computeResistanceModifier(board, defendUnit, attackerWeapon.type, false, this.target),
            defenderResistanceModifier: defenderWeapon
              ? computeResistanceModifier(board, up, defenderWeapon.type, true, m.to)
              : undefined,
          },
        });

        const att = new Combatant(aStats);
        const def = new Combatant(dStats, prevDef);
        att.fight(def);
        prevDef = def;

        const probFought = 1.0 - probDeadAlready;
        const probKilled = def.hpDist[0]! - probDeadAlready;
        probDeadAlready = def.hpDist[0]!;
        const probDied = att.hpDist[0]!;
        const probSurvived = (1.0 - probDied) * probFought;

        let cost = up.type.cost;
        const onVillage = board.map.isVillage(m.to);
        const upExperience = up.type.advancesTo.length > 0 ? up.experience : 0;
        cost += (upExperience / up.maxExperience) * cost;
        this.resourcesUsed += cost;
        this.avgLosses += cost * probDied;
        this.avgLosses += (cost * (up.poisoned ? 1 : 0)) / 2;

        if (!dStats.isPoisoned) {
          this.avgDamageInflicted += POISON_AMOUNT * 2 * def.poisoned * (1 - probKilled);
        }
        if (onVillage) {
          this.avgDamageTaken -= POISON_AMOUNT * 2 * probSurvived;
        }

        this.terrainQuality += (dStats.chanceToHit / 100) * cost * (onVillage ? 0.5 : 1.0);

        let advanceProb = 0;
        if (up.type.advancesTo.length > 0) {
          let xpForAdvance = up.experienceToAdvance();
          if (xpForAdvance === 0) xpForAdvance = 1;
          const fightXp = combatXp(defendUnit.level);
          const killXpVal = killXp(fightXp);

          if (fightXp >= xpForAdvance) {
            advanceProb = probFought;
            this.avgLosses -= up.type.cost * probFought;
          } else if (killXpVal >= xpForAdvance) {
            advanceProb = probKilled;
            this.avgLosses -= up.type.cost * probKilled;
            this.avgLosses -= (up.type.cost * 0.25 * fightXp * (probFought - probKilled)) / xpForAdvance;
          } else {
            this.avgLosses -= (up.type.cost * 0.25 * (killXpVal * probKilled + fightXp * (probFought - probKilled))) / xpForAdvance;
          }

          const plagues = attackerWeapon.specials.some((s) => s.getString('id', '') === 'plague');
          if (plagues) {
            this.avgLosses -= probKilled * up.type.cost;
          }
        }

        this.avgDamageTaken += (up.hitpoints - att.averageHp()) * (1.0 - advanceProb);

        const fightXpUp = combatXp(up.level);
        const killXpUp = killXp(fightXpUp);
        defAvgExperience += fightXpUp * (1.0 - att.hpDist[0]!) + killXpUp * att.hpDist[0]!;
        if (first) {
          firstChanceKill = def.hpDist[0]!;
          first = false;
        }
      }

      if (defendUnit.type.advancesTo.length > 0 && defAvgExperience >= defendUnit.experienceToAdvance()) {
        this.chanceToKill = firstChanceKill;
        this.avgDamageInflicted += defendUnit.hitpoints - defendUnit.maxHitpoints;
      } else if (prevDef) {
        this.chanceToKill = prevDef.hpDist[0]!;
        const healing = board.map.givesHealing(this.target);
        this.avgDamageInflicted += defendUnit.hitpoints - prevDef.averageHp(healing);
      }

      this.terrainQuality /= this.resourcesUsed;
    } finally {
      for (const m of this.movements) {
        if (board.unitAt(m.to)) board.moveUnit(m.to, m.from);
      }
    }
  }

  /** Mirrors `attack_analysis::attack_close`. */
  attackClose(ctx: AiContext): boolean {
    return ctx.isAttackClose(this.target);
  }

  /** Mirrors `attack_analysis::rating` (`attack.cpp:268-331`). */
  rating(aggression: number, ctx: AiContext): number {
    if (this.leaderThreat) aggression = 1.0;
    if (this.usesLeader) aggression = ctx.getLeaderAggression();

    let value = this.chanceToKill * this.targetValue - this.avgLosses * (1.0 - aggression);

    if (this.terrainQuality > this.alternativeTerrainQuality) {
      const exposureMod = this.usesLeader ? 2.0 : ctx.getCaution();
      const exposure =
        (exposureMod * this.resourcesUsed * (this.terrainQuality - this.alternativeTerrainQuality) * this.vulnerability) /
        Math.max(0.01, this.support);
      value -= exposure * (1.0 - aggression);
    }

    value += (this.targetStartingDamage / 3 + this.avgDamageInflicted - (1.0 - aggression) * this.avgDamageTaken) / 10.0;

    if (!this.isSurrounded || (this.support !== 0 && this.avgDamageTaken !== 0)) {
      if (
        this.vulnerability > 50.0 &&
        this.vulnerability > this.support * 2.0 &&
        this.chanceToKill < 0.02 &&
        aggression < 0.75 &&
        !this.attackClose(ctx)
      ) {
        return -1.0;
      }
    }

    if (!this.leaderThreat && this.vulnerability * this.terrainQuality > 0.0 && this.support !== 0) {
      value *= this.support / (this.vulnerability * this.terrainQuality);
    }

    value /= this.resourcesUsed / 2 + (this.resourcesUsed / 2) * this.terrainQuality;

    if (this.leaderThreat) value *= 5.0;

    return value;
  }
}
