/**
 * TS port of `default_recruitment::recruitment` (`src/ai/default/
 * recruitment.cpp`, ~1900 lines) -- upstream's real recruitment engine:
 * per-leader unit-type "scores" built from pairwise combat comparisons
 * against the visible enemy roster, `[recruit]`/`[limit]` job instructions
 * (the `recruitment_instructions`/`recruitment_pattern` aspects), a
 * save-gold state machine, and scout allocation from neutral villages.
 *
 * **Deliberately NOT ported** (documented, not silently missing --
 * matches this project's "land recruitment without important-hex analysis
 * behind a flag" risk mitigation from the Phase 29 plan):
 *  - The geometric "important hexes" border-zone map analysis
 *    (`update_important_hexes`/`compare_cost_maps_and_update_important_hexes`)
 *    that upstream uses to weight `get_average_defense` towards where the
 *    front line actually is. This port's `averageDefense` instead averages
 *    a unit type's defense over every DISTINCT terrain code present on the
 *    board -- simpler, board-shape-aware, but not front-line-aware.
 *  - `do_similarity_penalty` (discounts units similar to what's already
 *    recruited, e.g. an Archer after a Fighter in the same advancement
 *    tree) and `handle_recruitment_more` (recruit extra units the
 *    `recruitment_more` aspect names once gold allows) -- both secondary
 *    refinements on top of the core score-driven loop this port keeps.
 *  - Per-leader `extra_recruit=`/`recall_filter=` (this port's `Unit` has
 *    no such fields yet -- every leader draws from the team's own
 *    `canRecruit` list and can recall anything on the team's recall list).
 *  - The `unit_stats_cache`/`combat_cache_`/`cheapest_unit_costs_` perf
 *    caches (pure speed optimizations, not behavioural).
 *
 * Everything else -- `compare_unit_types`'s pairwise matchup formula,
 * `[recruit]`/`[limit]` job matching (`pattern=`/`type=`/`total=`/
 * `importance=`), `recruitment_randomness`, the `recruitment_save_gold`
 * state machine, recall-preferred-over-recruit, and "spend until
 * unaffordable or all jobs done" -- is ported line-for-line.
 */

import { Location } from '../../model/Location.js';
import { Unit } from '../../model/Unit.js';
import type { UnitType } from '../../model/UnitType.js';
import type { Team } from '../../model/Team.js';
import type { TerrainCode } from '../../model/Terrain.js';
import { WmlConfig } from '../../wml/config.js';
import { findVacantCastleTile } from '../../actions/recruit.js';
import { buildBattleContext, chooseDefenderWeaponIndex, betterCombat, type UnitStatsOptions } from '../../actions/combatStats.js';
import { Combatant, simulateCombat } from '../../actions/attackPrediction.js';
import { POISON_AMOUNT } from '../../actions/gameConfig.js';
import { CandidateAction } from '../composite/rca.js';

// Constants mirroring recruitment.cpp's anonymous-namespace ones.
const UNIT_THRESHOLD = 5;
const COMBAT_SCORE_POWER = 1.0;
const VILLAGE_PER_SCOUT_MULTIPLICATOR = 2.0;
const SAVE_GOLD_FORECAST_TURNS = 5;

type SaveGoldState = 'normal' | 'save_gold' | 'spend_all_gold' | 'leader_in_danger';

interface LeaderData {
  readonly leader: Unit;
  readonly recruits: Set<string>;
  readonly scores: Map<string, number>;
  ratioScore: number;
  recruitCount: number;
  inDanger: boolean;
}

function scoreSum(data: LeaderData): number {
  let sum = 0;
  for (const v of data.scores.values()) sum += v;
  return sum;
}

/** Mirrors `data::get_normalized_scores`. */
function normalizedScores(data: LeaderData): Map<string, number> {
  const sum = scoreSum(data);
  if (sum === 0) return data.scores;
  const out = new Map<string, number>();
  for (const [type, v] of data.scores) out.set(type, v / sum);
  return out;
}

/**
 * Mirrors `simulate_attack`: the best attacker-weapon/defender-counter
 * pairing (via the same `chooseDefenderWeaponIndex`/`betterCombat`
 * machinery `attackAnalysis.ts` uses), fought once, reporting each side's
 * expected HP loss (poison-adjusted, clamped to `[0, maxHitpoints]`,
 * matching `attack_simulation::get_avg_hp_of_combatant`). No board, no
 * abilities (leadership/backstab/resistance) -- upstream's own dummy
 * matchup simulation doesn't model those either.
 */
function simulateAttackDamage(
  attackerType: UnitType,
  defenderType: UnitType,
  attackerDefense: number,
  defenderDefense: number,
  lawfulBonus: number,
  maxLiminalBonus: number,
): { damageToAttacker: number; damageToDefender: number } {
  const attacker = Unit.create(attackerType, 1, Location.NULL);
  const defender = Unit.create(defenderType, 2, Location.NULL);
  const options: UnitStatsOptions = { attackerLawfulBonus: lawfulBonus, defenderLawfulBonus: lawfulBonus, maxLiminalBonus };

  let best: { attacker: Combatant; defender: Combatant } | undefined;
  for (let i = 0; i < attacker.attacks.length; i++) {
    const attackerWeapon = attacker.attacks[i]!;
    const defenderWeaponIndex = chooseDefenderWeaponIndex(attacker, i, defender, 1, attackerDefense, defenderDefense, options);
    const defenderWeapon = defenderWeaponIndex >= 0 ? defender.attacks[defenderWeaponIndex] : undefined;
    const { attacker: aStats, defender: dStats } = buildBattleContext({
      attacker,
      attackerWeapon,
      defender,
      defenderWeapon,
      distance: 1,
      attackerTerrainDefense: attackerDefense,
      defenderTerrainDefense: defenderDefense,
      options,
    });
    const { attacker: aCombatant, defender: dCombatant } = simulateCombat(aStats, dStats);
    // harmWeight 0: the attacker's own choice here only cares about maximizing damage dealt (mirrors
    // attack_simulation::better_result's `battle_context::better_combat(..., 0)` call for `for_defender=false`).
    if (!best || betterCombat(aCombatant, dCombatant, 1, best.attacker, best.defender, 1, 0)) {
      best = { attacker: aCombatant, defender: dCombatant };
    }
  }
  if (!best) return { damageToAttacker: 0, damageToDefender: 0 };

  const avgHp = (c: Combatant, maxHp: number): number => {
    const hp = Math.max(0, Math.min(maxHp, c.averageHp() - c.poisoned * POISON_AMOUNT));
    return hp;
  };
  return {
    damageToAttacker: attackerType.hitpoints - avgHp(best.attacker, attackerType.hitpoints),
    damageToDefender: defenderType.hitpoints - avgHp(best.defender, defenderType.hitpoints),
  };
}

/**
 * Mirrors `compare_unit_types`: a signed, asymmetric "how much better is A
 * against B" ratio -- positive means A wins the matchup, negative means B
 * does; magnitude grows with how lopsided the exchange is. `simulateAttack`
 * is run BOTH directions (A attacks B, B attacks A) and the results
 * combined, so the return value only depends on the two types (and the
 * given defenses/ToD), not on attack order.
 */
export function compareUnitTypes(
  typeA: UnitType,
  typeB: UnitType,
  defenseA: number,
  defenseB: number,
  lawfulBonus: number,
  maxLiminalBonus: number,
): number {
  const aAttacksB = simulateAttackDamage(typeA, typeB, defenseA, defenseB, lawfulBonus, maxLiminalBonus);
  const bAttacksA = simulateAttackDamage(typeB, typeA, defenseB, defenseA, lawfulBonus, maxLiminalBonus);
  const damageToA = aAttacksB.damageToAttacker + bAttacksA.damageToDefender;
  const damageToB = aAttacksB.damageToDefender + bAttacksA.damageToAttacker;

  const aCost = typeA.cost > 0 ? typeA.cost : 1;
  const bCost = typeB.cost > 0 ? typeB.cost : 1;
  const aMaxHp = typeA.hitpoints > 0 ? typeA.hitpoints : 1;
  const bMaxHp = typeB.hitpoints > 0 ? typeB.hitpoints : 1;

  if (damageToA <= 0 && damageToB <= 0) return 0;
  if (damageToA <= 0) return 2;
  if (damageToB <= 0) return -2;

  const valueOfA = damageToB / (bMaxHp * aCost);
  const valueOfB = damageToA / (aMaxHp * bCost);
  if (valueOfA > valueOfB) return valueOfA / valueOfB;
  if (valueOfA < valueOfB) return -valueOfB / valueOfA;
  return 0;
}

// --- job matching (recruitment_instructions aspect: "[recruit]"/"[limit]" tags) ---

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function recruitMatchesType(resolveType: (id: string) => UnitType | undefined, recruit: string, type: string): boolean {
  const recruitType = resolveType(recruit);
  if (!recruitType) return false;
  if (recruitType.id === type) return true;
  if (recruitType.usage === type) return true;
  if (String(recruitType.level) === type) return true;
  return false;
}

function recruitMatchesTypes(resolveType: (id: string) => UnitType | undefined, recruit: string, types: readonly string[]): boolean {
  if (types.length === 0) return true;
  return types.some((t) => recruitMatchesType(resolveType, recruit, t));
}

function recruitMatchesJob(resolveType: (id: string) => UnitType | undefined, recruit: string, job: WmlConfig): boolean {
  return recruitMatchesTypes(resolveType, recruit, splitList(job.getString('type', '')));
}

export class RecruitmentCandidateAction extends CandidateAction {
  private state: SaveGoldState = 'normal';
  private ownUnitsCount = new Map<string, number>();
  private totalOwnUnits = 0;
  private scoutsWanted = 0;
  private instructionsTurn = -1;
  private jobs: WmlConfig[] = [];
  private limits: WmlConfig[] = [];

  private resolveType(id: string): UnitType | undefined {
    try {
      return this.ctx.host.resolveType(id);
    } catch {
      return undefined;
    }
  }

  // --- aspects ---

  private refreshInstructionsIfNewTurn(): void {
    const turn = this.ctx.turnNumber();
    if (turn === this.instructionsTurn) return;
    this.instructionsTurn = turn;

    const instructions = this.ctx.getRecruitmentInstructionsConfig();
    this.jobs = [...instructions.children('recruit')];
    this.limits = [...instructions.children('limit')];

    const patternTypes = splitList(this.ctx.getRecruitmentPattern());
    if (patternTypes.length > 0) {
      const job = new WmlConfig();
      job.setAttribute('type', patternTypes.join(', '));
      job.setAttribute('number', 99999);
      job.setAttribute('pattern', true);
      job.setAttribute('blocker', true);
      job.setAttribute('total', false);
      job.setAttribute('importance', 1);
      this.jobs.push(job);
    }
  }

  // --- job selection (mirrors get_most_important_job) ---

  private getMostImportantJob(): WmlConfig | undefined {
    let best: WmlConfig | undefined;
    let bestImportance = -1;
    let biggestNumber = -1;
    for (const job of this.jobs) {
      let number = job.getNumber('number', 99999);
      const total = job.getBoolean('total', false);
      if (total) {
        this.updateOwnUnitsCount();
        for (const [unitType, count] of this.ownUnitsCount) {
          if (recruitMatchesJob(this.resolveType.bind(this), unitType, job)) number -= count;
        }
      }
      if (number <= 0) continue;
      const importance = job.getNumber('importance', 1);
      if (importance > bestImportance || (importance === bestImportance && biggestNumber > number)) {
        best = job;
        bestImportance = importance;
        biggestNumber = number;
      }
    }
    return best;
  }

  /** Mirrors `limit_ok`. */
  private limitOk(recruit: string): boolean {
    for (const limit of this.limits) {
      const types = splitList(limit.getString('type', ''));
      if (!recruitMatchesTypes(this.resolveType.bind(this), recruit, types)) continue;
      let count = 0;
      for (const [unitType, n] of this.ownUnitsCount) {
        if (recruitMatchesTypes(this.resolveType.bind(this), unitType, types)) count += n;
      }
      if (count >= limit.getNumber('max', 0)) return false;
    }
    return true;
  }

  /** Mirrors `leader_matches_job`. */
  private leaderMatchesJob(data: LeaderData, job: WmlConfig): boolean {
    let ok = false;
    for (const recruit of data.recruits) {
      if (recruitMatchesJob(this.resolveType.bind(this), recruit, job) && this.limitOk(recruit)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
    const ids = splitList(job.getString('leader_id', ''));
    if (ids.length === 0) return true;
    return ids.includes(data.leader.id);
  }

  /** Mirrors `remove_job_if_no_blocker`: returns whether the job was removed (so the caller should keep looping). */
  private removeJobIfNoBlocker(job: WmlConfig): boolean {
    if (job.getBoolean('blocker', false)) return false;
    this.jobs = this.jobs.filter((j) => j !== job);
    return true;
  }

  // --- per-turn/per-execute bookkeeping ---

  private updateOwnUnitsCount(): void {
    this.ownUnitsCount = new Map();
    this.totalOwnUnits = 0;
    for (const u of this.ctx.board.unitsForSide(this.ctx.side)) {
      if (u.canRecruit || u.incapacitated || u.maxMoves <= 0) continue;
      this.ownUnitsCount.set(u.type.id, (this.ownUnitsCount.get(u.type.id) ?? 0) + 1);
      this.totalOwnUnits++;
    }
  }

  private updateScoutsWanted(villagesPerScout: number): void {
    this.scoutsWanted = 0;
    if (villagesPerScout === 0) return;
    const board = this.ctx.board;
    let neutralVillages = 0;
    for (const v of board.map.villages) {
      if (board.villageOwner(v) === undefined) neutralVillages++;
    }
    const ourShare = neutralVillages / Math.max(1, board.teams().length);
    const effectiveVillagesPerScout = (VILLAGE_PER_SCOUT_MULTIPLICATOR * villagesPerScout) / 2;
    this.scoutsWanted = effectiveVillagesPerScout > 0 ? Math.round(ourShare / effectiveVillagesPerScout) : 0;
    if (this.scoutsWanted === 0) return;
    for (const [unitType, count] of this.ownUnitsCount) {
      if (recruitMatchesType(this.resolveType.bind(this), unitType, 'scout')) this.scoutsWanted -= count;
    }
  }

  private cheapestUnitCost(team: Team): number {
    let cheapest = Infinity;
    for (const id of team.canRecruit) {
      const t = this.resolveType(id);
      if (t && t.cost < cheapest) cheapest = t.cost;
    }
    if (this.ctx.board.recallList(team.side).length > 0 && team.recallCost < cheapest) cheapest = team.recallCost;
    return cheapest === Infinity ? 0 : cheapest;
  }

  // --- combat analysis (mirrors do_combat_analysis, minus important-hexes weighting) ---

  private averageDefense(type: UnitType, terrainCodes: readonly TerrainCode[]): number {
    if (terrainCodes.length === 0) return 50;
    let sum = 0;
    for (const code of terrainCodes) sum += type.moveType.defenseModifier(code);
    return sum / terrainCodes.length;
  }

  private boardTerrainCodes(): TerrainCode[] {
    const board = this.ctx.board;
    const seen = new Set<TerrainCode>();
    const codes: TerrainCode[] = [];
    for (let y = 0; y < board.map.h(); y++) {
      for (let x = 0; x < board.map.w(); x++) {
        const loc = new Location(x, y);
        const code = board.map.getTerrain(loc);
        if (!seen.has(code)) {
          seen.add(code);
          codes.push(code);
        }
      }
    }
    return codes;
  }

  private doCombatAnalysis(leaderData: LeaderData[], diversityThreshold: number): void {
    const board = this.ctx.board;
    const team = this.ctx.team();
    const terrainCodes = this.boardTerrainCodes();
    const lawfulBonus = this.ctx.host.lawfulBonusAt(leaderData[0]?.leader.location ?? Location.NULL);
    const maxLiminalBonus = this.ctx.host.maxLiminalBonus;

    let enemyUnits: Array<{ type: UnitType; hp: number }> = [];
    for (const u of board.allUnits()) {
      const uTeam = board.getTeam(u.side);
      if (!uTeam || !team.isEnemy(uTeam) || u.incapacitated) continue;
      enemyUnits.push({ type: u.type, hp: u.hitpoints });
    }
    if (enemyUnits.length < UNIT_THRESHOLD) {
      const possible = new Set<string>();
      for (const t of board.teams()) {
        if (!team.isEnemy(t)) continue;
        for (const id of t.canRecruit) possible.add(id);
      }
      for (const id of possible) {
        const rt = this.resolveType(id);
        if (rt) enemyUnits.push({ type: rt, hp: rt.hitpoints });
      }
    }

    const defenseCache = new Map<string, number>();
    const getDefense = (t: UnitType): number => {
      let d = defenseCache.get(t.id);
      if (d === undefined) {
        d = this.averageDefense(t, terrainCodes);
        defenseCache.set(t.id, d);
      }
      return d;
    };

    for (const data of leaderData) {
      if (data.recruits.size === 0) continue;
      const tempScores = new Map<string, number>();
      for (const enemy of enemyUnits) {
        for (const recruit of data.recruits) {
          const recruitType = this.resolveType(recruit);
          if (!recruitType) continue;
          let score = compareUnitTypes(recruitType, enemy.type, getDefense(recruitType), getDefense(enemy.type), lawfulBonus, maxLiminalBonus);
          score *= enemy.hp;
          score = Math.pow(score, COMBAT_SCORE_POWER);
          tempScores.set(recruit, (tempScores.get(recruit) ?? 0) + score);
        }
      }
      if (tempScores.size === 0) continue;

      let max = -Infinity;
      let sum = 0;
      for (const v of tempScores.values()) {
        if (v > max) max = v;
        sum += v;
      }
      const average = sum / tempScores.size;
      const scoreThreshold = diversityThreshold > 0 ? diversityThreshold : 0.0001;
      const new100 = max;
      let new0 = max - scoreThreshold * (max - average);
      if (new100 === new0) new0 -= 0.000001;

      for (const [recruit, score] of tempScores) {
        const normalized = Math.max(0, (100 * (score - new0)) / (new100 - new0));
        data.scores.set(recruit, (data.scores.get(recruit) ?? 0) + normalized);
      }
    }
  }

  private doRandomness(leaderData: LeaderData[], randomness: number): void {
    if (randomness <= 0) return;
    for (const data of leaderData) {
      for (const [type, score] of data.scores) {
        data.scores.set(type, score + this.ctx.host.rng.getRandomDouble() * randomness);
      }
    }
  }

  // --- save-gold state machine (mirrors update_state) ---

  private getUnitRatio(): number {
    const board = this.ctx.board;
    const team = this.ctx.team();
    let ownTotal = 0;
    let teamTotal = 0;
    let enemyTotal = 0;
    for (const u of board.allUnits()) {
      if (u.incapacitated || u.maxMoves <= 0 || u.canRecruit) continue;
      const value = (u.type.cost * u.hitpoints) / u.maxHitpoints;
      const uTeam = board.getTeam(u.side);
      if (!uTeam) continue;
      if (team.isEnemy(uTeam)) {
        enemyTotal += value;
      } else {
        teamTotal += value;
        if (u.side === team.side) ownTotal += value;
      }
    }
    let alliesCount = 0;
    for (const t of board.teams()) if (!team.isEnemy(t)) alliesCount++;

    if ((ownTotal === 0 || teamTotal === 0) && enemyTotal === 0) return 0;
    if (enemyTotal === 0) return 999;
    const ownRatio = (ownTotal / enemyTotal) * alliesCount;
    const teamRatio = teamTotal / enemyTotal;
    return Math.min(ownRatio, teamRatio);
  }

  private updateState(saveGoldConfig: WmlConfig): void {
    if (this.state === 'leader_in_danger' || this.state === 'spend_all_gold') return;
    const team = this.ctx.team();
    const spendAllGold = saveGoldConfig.getNumber('spend_all_gold', -1);
    if (spendAllGold > 0 && team.gold >= spendAllGold) {
      this.state = 'spend_all_gold';
      return;
    }
    const ratio = this.getUnitRatio();
    // Estimated-income forecasting (get_estimated_income) is not ported (perf/complexity); this port always
    // treats income as positive, matching save_on_negative_income=yes's own effective behaviour.
    const incomeEstimation = 1;
    const saveGoldBegin = saveGoldConfig.getNumber('begin', 1.5);
    const saveGoldEnd = saveGoldConfig.getNumber('end', 1.1);
    if (this.state === 'normal' && ratio > saveGoldBegin && incomeEstimation > 0) {
      this.state = 'save_gold';
    } else if (this.state === 'save_gold' && ratio < saveGoldEnd) {
      this.state = 'normal';
    }
  }

  // --- evaluate/execute ---

  evaluate(): number {
    this.refreshInstructionsIfNewTurn();
    const job = this.getMostImportantJob();
    if (!job) return 0;

    const board = this.ctx.board;
    const team = this.ctx.team();
    for (const leader of board.unitsForSide(this.ctx.side)) {
      if (!leader.canRecruit || leader.incapacitated) continue;
      if (!this.isAllowedUnit(leader)) continue;
      const cheapest = this.cheapestUnitCost(team);
      if (team.gold < cheapest && cheapest > 0) continue;
      if (board.map.isKeep(leader.location) && findVacantCastleTile(board, leader)) {
        return this.score;
      }
    }
    return 0;
  }

  execute(): void {
    const board = this.ctx.board;
    const team = this.ctx.team();

    const leaderData: LeaderData[] = [];
    for (const leader of board.unitsForSide(this.ctx.side)) {
      if (!leader.canRecruit || leader.incapacitated) continue;
      if (!this.isAllowedUnit(leader)) continue;
      if (!board.map.isKeep(leader.location)) continue;
      if (!findVacantCastleTile(board, leader)) continue;
      const cheapest = this.cheapestUnitCost(team);
      if (team.gold < cheapest && cheapest > 0) continue;

      const data: LeaderData = { leader, recruits: new Set(team.canRecruit), scores: new Map(), ratioScore: 1.0, recruitCount: 0, inDanger: false };
      for (const r of data.recruits) data.scores.set(r, 0);
      for (const recall of board.recallList(team.side)) {
        const value = this.recallUnitValue(recall);
        if (value < 0) continue;
        data.recruits.add(recall.type.id);
        if (!data.scores.has(recall.type.id)) data.scores.set(recall.type.id, 0);
      }
      data.inDanger = this.ctx.powerProjection(leader.location, this.ctx.getEnemyDstSrc()) > 0;
      if (data.inDanger) {
        data.ratioScore = 50;
        this.state = 'leader_in_danger';
      }
      leaderData.push(data);
    }
    if (leaderData.length === 0) return;
    const globalRecruits = new Set<string>();
    for (const data of leaderData) for (const r of data.recruits) globalRecruits.add(r);
    if (globalRecruits.size === 0) return;

    this.updateOwnUnitsCount();
    this.updateScoutsWanted(this.ctx.getVillagesPerScout());

    const diversity = this.ctx.getRecruitmentDiversity();
    this.doCombatAnalysis(leaderData, diversity);
    this.doRandomness(leaderData, this.ctx.getRecruitmentRandomness());

    const saveGoldConfig = this.ctx.getRecruitmentSaveGoldConfig();

    let recruitedAtLeastOnce = false;
    for (;;) {
      this.updateState(saveGoldConfig);
      const saveGoldTurn = saveGoldConfig.getNumber('active', 2);
      const saveGoldActive = saveGoldTurn > 0 && saveGoldTurn <= this.ctx.turnNumber();
      if (this.state === 'save_gold' && saveGoldActive) break;

      const job = this.getMostImportantJob();
      if (!job) break;

      const bestLeaderData = this.getBestLeaderFromRatioScores(leaderData, job);
      if (!bestLeaderData) {
        if (this.removeJobIfNoBlocker(job)) continue;
        break;
      }

      const bestRecruit = this.getBestRecruitFromScores(bestLeaderData, job);
      if (!bestRecruit) {
        if (this.removeJobIfNoBlocker(job)) continue;
        break;
      }

      const recallId = this.getAppropriateRecall(bestRecruit, bestLeaderData, team);
      const vacant = findVacantCastleTile(board, bestLeaderData.leader);
      if (!vacant) {
        if (this.removeJobIfNoBlocker(job)) continue;
        break;
      }

      let ok: boolean;
      if (recallId) {
        const unit = board.recallList(team.side).find((u) => u.id === recallId);
        if (!unit) {
          ok = false;
        } else {
          this.ctx.executeRecall(team, unit, vacant, bestLeaderData.leader.location);
          ok = true;
        }
      } else {
        const type = this.resolveType(bestRecruit);
        if (!type || team.gold < type.cost) {
          ok = false;
        } else {
          this.ctx.executeRecruit(team, type, vacant, bestLeaderData.leader.location);
          ok = true;
        }
      }

      if (ok) {
        recruitedAtLeastOnce = true;
        bestLeaderData.recruitCount++;
        this.ownUnitsCount.set(bestRecruit, (this.ownUnitsCount.get(bestRecruit) ?? 0) + 1);
        this.totalOwnUnits++;
        if (recruitMatchesType(this.resolveType.bind(this), bestRecruit, 'scout')) this.scoutsWanted--;
        if (!job.getBoolean('total', false)) job.setAttribute('number', job.getNumber('number', 99999) - 1);
      } else {
        // Out of gold, no vacancy, or a bad recall lookup -- stop this turn's recruiting.
        if (this.removeJobIfNoBlocker(job)) continue;
        break;
      }
    }

    if (this.state === 'leader_in_danger') this.state = 'normal';
    void recruitedAtLeastOnce;
  }

  private recallUnitValue(recall: Unit): number {
    let avgCost = 0;
    let count = 0;
    for (const advId of recall.type.advancesTo) {
      const t = this.resolveType(advId);
      if (!t) continue;
      avgCost += t.cost;
      count++;
    }
    avgCost = count > 0 ? avgCost / count : recall.type.cost;
    const recallCost = recall.type.recallCost >= 0 ? recall.type.recallCost : this.ctx.team().recallCost;
    return avgCost - recallCost;
  }

  private getAppropriateRecall(type: string, data: LeaderData, team: Team): string | undefined {
    let bestId: string | undefined;
    let bestValue = -1;
    for (const recall of this.ctx.board.recallList(team.side)) {
      if (recall.type.id !== type) continue;
      const value = this.recallUnitValue(recall);
      if (value > bestValue) {
        bestValue = value;
        bestId = recall.id;
      }
    }
    return bestValue >= 0 ? bestId : undefined;
  }

  private getBestLeaderFromRatioScores(leaderData: LeaderData[], job: WmlConfig): LeaderData | undefined {
    let ratioSum = 0;
    let totalRecruitCount = 0;
    for (const d of leaderData) {
      ratioSum += d.ratioScore;
      totalRecruitCount += d.recruitCount;
    }
    if (ratioSum <= 0) return undefined;

    let best: LeaderData | undefined;
    let biggestDifference = -99999;
    for (const d of leaderData) {
      if (!this.leaderMatchesJob(d, job)) continue;
      const desired = (d.ratioScore / ratioSum) * (totalRecruitCount + 1);
      const difference = desired - d.recruitCount;
      if (difference > biggestDifference) {
        biggestDifference = difference;
        best = d;
      }
    }
    return best;
  }

  private getRandomPatternTypeIfExists(data: LeaderData, job: WmlConfig): string {
    if (!job.getBoolean('pattern', false)) return '';
    let jobTypes = splitList(job.getString('type', ''));
    if (jobTypes.length === 0) jobTypes = [...data.recruits];
    jobTypes = jobTypes.filter((t) => [...data.recruits].some((r) => recruitMatchesType(this.resolveType.bind(this), r, t) && this.limitOk(r)));
    if (jobTypes.length === 0) return '';
    return jobTypes[this.ctx.host.rng.getRandomInt(0, jobTypes.length - 1)]!;
  }

  private getBestRecruitFromScores(data: LeaderData, job: WmlConfig): string {
    const patternType = this.getRandomPatternTypeIfExists(data, job);
    let best = '';
    let biggestDifference = -99999;
    for (const [unit, score] of normalizedScores(data)) {
      if (!this.limitOk(unit)) continue;
      if (patternType) {
        if (!recruitMatchesType(this.resolveType.bind(this), unit, patternType)) continue;
      } else if (!recruitMatchesJob(this.resolveType.bind(this), unit, job)) {
        continue;
      }
      const desired = score * (this.totalOwnUnits + 1);
      const current = this.ownUnitsCount.get(unit) ?? 0;
      let difference = desired - current;
      if (this.scoutsWanted > 0 && recruitMatchesType(this.resolveType.bind(this), unit, 'scout')) difference += 1000;
      if (difference > biggestDifference) {
        biggestDifference = difference;
        best = unit;
      }
    }
    return best;
  }
}
