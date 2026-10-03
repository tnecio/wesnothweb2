/**
 * TS port of upstream's `readonly_context`/`readwrite_context`
 * (`src/ai/contexts.hpp/.cpp`), collapsed into one class: everything a
 * candidate action needs to read the world (move maps, aspects, keeps,
 * power projection) and the one thing every CA needs to change it
 * (gamestate-change-tracked action execution, which `RcaStage` reads to
 * decide whether to blacklist a CA for lying in `evaluate()` -- see
 * `composite/rca.ts`).
 *
 * S1 only wires move + stopunit through the gamestate-tracked action
 * path (the only actions S1's own candidate actions need); attack/
 * recruit/recall join in S2/S3 as a dedicated `actions.ts` once more
 * than one caller needs the same `check*`/`execute*` split (this class's
 * own `executeMove`/`stopUnit` are that split's first two members,
 * inlined here rather than prematurely extracted).
 */

import { Location, distanceBetween } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Team } from '../model/Team.js';
import type { Unit } from '../model/Unit.js';
import { WmlConfig } from '../wml/config.js';
import type { DestVect } from '../pathfind/pathfind.js';
import { locationMatchesFilterOnBoard } from '../events/filter.js';
import { performMove, type PerformMoveResult } from '../actions/moveSequence.js';
import { performAttack } from '../actions/attackSequence.js';
import type { AttackResult } from '../actions/combat.js';
import { recruitUnit, recallUnit, type PlaceRecruitResult } from '../actions/recruit.js';
import type { UnitType } from '../model/UnitType.js';
import type { AiHost, AiAction } from './types.js';
import { CompositeAspect, facetFromConfig, isAspectActive } from './composite/aspect.js';
import { calculateMoves, type MoveMap } from './moveMaps.js';
import { powerProjection as powerProjectionFn, bestDefensivePosition as bestDefensivePositionFn, type DefensivePosition } from './powerProjection.js';
import { nearestKeep as nearestKeepFn, suitableKeep as suitableKeepFn } from './keeps.js';
import { analyzeTargets } from './default/aspectAttacks.js';
import type { AttackAnalysis } from './default/attackAnalysis.js';
import type { Goal } from './composite/goal.js';

/** Real Wesnoth's `[value][not][/not][/value]` "matches nothing" idiom (the real `avoid` aspect's own built-in default) -- used as `getAvoidConfig`'s fallback when no `avoid` aspect was configured at all (e.g. a hand-built test context). */
const AVOID_MATCHES_NOTHING = (() => {
  const cfg = new WmlConfig();
  cfg.addChild('not');
  return cfg;
})();

/** `variant<bool, vector<string>>`-typed aspects (`passive_leader`, `passive_leader_shares_keep`, `leader_ignores_keep`): `"yes"`/`"no"` applies to every leader, otherwise a comma list of specific leader ids. */
function boolOrIdListMatches(raw: string, id: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'no' || trimmed === 'false') return false;
  if (trimmed === 'yes' || trimmed === 'true') return true;
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .includes(id);
}

export class AiContext {
  readonly host: AiHost;
  readonly side: number;
  private readonly aspects: ReadonlyMap<string, CompositeAspect>;
  private goals: Goal[];
  private gamestateChangeCounter = 0;

  private srcDstCache?: MoveMap;
  private dstSrcCache?: MoveMap;
  private enemySrcDstCache?: MoveMap;
  private enemyDstSrcCache?: MoveMap;

  private attacksCache?: AttackAnalysis[];
  private attacksCacheGamestate?: number;
  private recentAttackLocs: Location[] = [];
  private actionLog: AiAction[] = [];

  constructor(host: AiHost, side: number, aspects: ReadonlyMap<string, CompositeAspect>, goals: readonly Goal[] = []) {
    this.host = host;
    this.side = side;
    this.aspects = aspects;
    this.goals = [...goals];
  }

  get board(): GameBoard {
    return this.host.board;
  }

  turnNumber(): number {
    return this.host.turnNumber();
  }

  timeOfDayId(): string {
    return this.host.timeOfDayId();
  }

  team(): Team {
    const t = this.host.board.getTeam(this.side);
    if (!t) throw new Error(`AiContext: side ${this.side} has no team on the board`);
    return t;
  }

  /** Own units with `canRecruit` set and not incapacitated -- there is no dedicated `Team.leader()` in this port (same informal convention `simpleAi.ts` already established). */
  leaders(): Unit[] {
    return this.host.board.unitsForSide(this.side).filter((u) => u.canRecruit && !u.incapacitated);
  }

  // --- gamestate change tracking (RcaStage's own blacklist-on-no-op mechanism) ---

  gamestateSnapshot(): number {
    return this.gamestateChangeCounter;
  }

  private bumpGamestateChange(): void {
    this.gamestateChangeCounter++;
    this.invalidateMoveMaps();
  }

  // --- move maps (mirrors readonly_context_impl's get_srcdst/get_dstsrc/... ) ---

  private avoidFilter(): (loc: Location) => boolean {
    const cfg = this.getAvoidConfig();
    return (loc: Location) => locationMatchesFilterOnBoard(this.host.board, loc, cfg);
  }

  getSrcDst(): MoveMap {
    if (!this.srcDstCache) this.recalculateMoveMaps();
    return this.srcDstCache!;
  }

  getDstSrc(): MoveMap {
    if (!this.dstSrcCache) this.recalculateMoveMaps();
    return this.dstSrcCache!;
  }

  recalculateMoveMaps(): void {
    const { srcDst, dstSrc } = calculateMoves(this.host.board, this.side, {
      enemy: false,
      assumeFullMovement: false,
      avoid: this.avoidFilter(),
      viewingTeam: this.team(),
    });
    this.srcDstCache = srcDst;
    this.dstSrcCache = dstSrc;
  }

  getEnemySrcDst(): MoveMap {
    if (!this.enemySrcDstCache) this.recalculateEnemyMoveMaps();
    return this.enemySrcDstCache!;
  }

  getEnemyDstSrc(): MoveMap {
    if (!this.enemyDstSrcCache) this.recalculateEnemyMoveMaps();
    return this.enemyDstSrcCache!;
  }

  recalculateEnemyMoveMaps(): void {
    const { srcDst, dstSrc } = calculateMoves(this.host.board, this.side, {
      enemy: true,
      assumeFullMovement: false,
      viewingTeam: this.team(),
    });
    this.enemySrcDstCache = srcDst;
    this.enemyDstSrcCache = dstSrc;
  }

  invalidateMoveMaps(): void {
    this.srcDstCache = undefined;
    this.dstSrcCache = undefined;
    this.enemySrcDstCache = undefined;
    this.enemyDstSrcCache = undefined;
  }

  // --- keeps / power projection ---

  nearestKeep(loc: Location): Location | undefined {
    return nearestKeepFn(this.host.board, loc);
  }

  suitableKeep(leaderLoc: Location, leaderDestinations: DestVect): Location | undefined {
    return suitableKeepFn(this.host.board, leaderLoc, leaderDestinations);
  }

  /**
   * `readonly_context_impl::best_defensive_position`, with its `defensive_position_cache_`: the first answer
   * for a hex stands until `invalidateDefensivePositionCache` (once per turn, `ai_composite::new_turn`), even
   * across the moves made meanwhile, exactly as upstream. Attack analysis asks this for every attacker of every
   * attack combination, so without the cache it was most of an AI turn.
   */
  bestDefensivePosition(loc: Location, srcDst: MoveMap, dstSrc: MoveMap, enemyDstSrc: MoveMap): DefensivePosition {
    const ppCtx = { turnNumber: this.turnNumber(), lawfulBonusAt: this.host.lawfulBonusAt, maxLiminalBonus: this.host.maxLiminalBonus };
    if (!this.host.board.unitAt(loc)) return bestDefensivePositionFn(this.host.board, loc, srcDst, dstSrc, enemyDstSrc, ppCtx);
    const key = loc.key();
    let pos = this.defensivePositionCache.get(key);
    if (!pos) {
      pos = bestDefensivePositionFn(this.host.board, loc, srcDst, dstSrc, enemyDstSrc, ppCtx);
      this.defensivePositionCache.set(key, pos);
    }
    return pos;
  }

  /** `invalidate_defensive_position_cache`. */
  invalidateDefensivePositionCache(): void {
    this.defensivePositionCache.clear();
  }

  private readonly defensivePositionCache = new Map<string, DefensivePosition>();

  powerProjection(loc: Location, dstSrc: MoveMap): number {
    return powerProjectionFn(this.host.board, loc, dstSrc, {
      turnNumber: this.turnNumber(),
      lawfulBonusAt: this.host.lawfulBonusAt,
      maxLiminalBonus: this.host.maxLiminalBonus,
    });
  }

  // --- aspect resolution (typed getters, one per real aspect id) ---

  isActive(turns: string, timeOfDay: string): boolean {
    return isAspectActive(turns, timeOfDay, this.turnNumber(), this.timeOfDayId());
  }

  private resolveAspect(id: string): WmlConfig | undefined {
    return this.aspects.get(id)?.resolve(this.turnNumber(), this.timeOfDayId());
  }

  /** An aspect's active facet (`aspect::get`), for engines that read aspects by id (Lua's `ai.aspects`). */
  aspect(id: string): WmlConfig | undefined {
    return this.resolveAspect(id);
  }

  /** Every aspect this side's AI has. */
  aspectIds(): string[] {
    return [...this.aspects.keys()];
  }

  /** `[modify_ai] path=aspect[<id>].facet`: adds a facet (the aspect is created if the side has none by that id). */
  addFacet(aspectId: string, cfg: WmlConfig): boolean {
    let aspect = this.aspects.get(aspectId);
    if (!aspect) {
      aspect = new CompositeAspect(aspectId, { id: '', turns: '', timeOfDay: '', body: new WmlConfig() });
      (this.aspects as Map<string, CompositeAspect>).set(aspectId, aspect);
    }
    if (cfg.getString('id', '') !== '') aspect.deleteFacet(cfg.getString('id'));
    aspect.addFacet(facetFromConfig(cfg));
    this.attacksCache = undefined;
    return true;
  }

  /** `[modify_ai] path=aspect[<id>].facet[<facetId>] action=delete` (`*`: every facet). */
  deleteFacet(aspectId: string, facetId: string): boolean {
    const aspect = this.aspects.get(aspectId);
    if (!aspect) return false;
    this.attacksCache = undefined;
    return aspect.deleteFacet(facetId);
  }

  /** The side's aspects as `[aspect]` configs, for `AiManager.toConfig`. */
  aspectConfigs(): WmlConfig[] {
    return [...this.aspects.values()].map((a) => a.toConfig());
  }

  getAggression(): number {
    return this.resolveAspect('aggression')?.getNumber('value', 0.4) ?? 0.4;
  }
  getCaution(): number {
    return this.resolveAspect('caution')?.getNumber('value', 0.25) ?? 0.25;
  }
  getGrouping(): string {
    return this.resolveAspect('grouping')?.getString('value', 'offensive') ?? 'offensive';
  }
  getSimpleTargeting(): boolean {
    return this.resolveAspect('simple_targeting')?.getBoolean('value', false) ?? false;
  }
  getVillageValue(): number {
    return this.resolveAspect('village_value')?.getNumber('value', 1.0) ?? 1.0;
  }
  getVillagesPerScout(): number {
    return this.resolveAspect('villages_per_scout')?.getNumber('value', 4) ?? 4;
  }
  getScoutVillageTargeting(): number {
    return this.resolveAspect('scout_village_targeting')?.getNumber('value', 3) ?? 3;
  }
  getSupportVillages(): boolean {
    return this.resolveAspect('support_villages')?.getBoolean('value', false) ?? false;
  }
  getAllowAllyVillages(): boolean {
    return this.resolveAspect('allow_ally_villages')?.getBoolean('value', false) ?? false;
  }
  getLeaderValue(): number {
    return this.resolveAspect('leader_value')?.getNumber('value', 3.0) ?? 3.0;
  }
  getLeaderAggression(): number {
    return this.resolveAspect('leader_aggression')?.getNumber('value', -4.0) ?? -4.0;
  }
  getRetreatFactor(): number {
    return this.resolveAspect('retreat_factor')?.getNumber('value', 0.25) ?? 0.25;
  }
  getRetreatEnemyWeight(): number {
    return this.resolveAspect('retreat_enemy_weight')?.getNumber('value', 1.0) ?? 1.0;
  }
  getAvoidConfig(): WmlConfig {
    return this.resolveAspect('avoid')?.child('value') ?? AVOID_MATCHES_NOTHING;
  }
  /** The `attacks` aspect's active facet body -- its `[filter_own]`/`[filter_enemy]` children gate `getAttacks()`. Falls back to an empty config (no filters) when no `attacks` aspect was configured at all (e.g. a hand-built test context). */
  getAttacksAspectConfig(): WmlConfig {
    return this.resolveAspect('attacks') ?? new WmlConfig();
  }
  /** The `recruitment_instructions` aspect's `[value]` (its `[recruit]`/`[limit]` children) -- the real upstream default is a single `[recruit importance=0]` (recruit anything, low priority), matching `default_config.cfg`. */
  getRecruitmentInstructionsConfig(): WmlConfig {
    return this.resolveAspect('recruitment_instructions')?.child('value') ?? new WmlConfig();
  }
  /** The (old, simplified) `recruitment_pattern` aspect: a comma list of type/usage/level strings, empty by default. */
  getRecruitmentPattern(): string {
    return this.resolveAspect('recruitment_pattern')?.getString('value', '') ?? '';
  }
  getRecruitmentDiversity(): number {
    return this.resolveAspect('recruitment_diversity')?.getNumber('value', 2.0) ?? 2.0;
  }
  getRecruitmentRandomness(): number {
    return this.resolveAspect('recruitment_randomness')?.getNumber('value', 50) ?? 50;
  }
  /** The `recruitment_save_gold` aspect's `[value]` (`active=`/`begin=`/`end=`/`spend_all_gold=`) -- the real upstream default is `active=0` (disabled), matching `default_config.cfg`. */
  getRecruitmentSaveGoldConfig(): WmlConfig {
    return this.resolveAspect('recruitment_save_gold')?.child('value') ?? new WmlConfig();
  }
  /** The `leader_goal` aspect's raw config (`x=`/`y=`/`max_risk=`/`auto_remove=`/`id=`) -- empty by default, read by `move_leader_to_goals`. */
  getLeaderGoalConfig(): WmlConfig {
    return this.resolveAspect('leader_goal') ?? new WmlConfig();
  }

  /** Every `[goal]` this side's `[ai]` config declared (`target`/`target_location`/`protect_unit`/`protect_location`), in declaration order across all merged configs -- built once by `parseSideAiConfig`, NOT an aspect. */
  getGoals(): readonly Goal[] {
    return this.goals;
  }

  /** Mirrors `[modify_ai] path=goal[] action=add` (a bare `goal[]` -- no id needed to append). */
  addGoal(goal: Goal): void {
    this.goals.push(goal);
  }

  /** Mirrors `[modify_ai] path=goal[<id>] action=delete` -- the single most common real-content `[modify_ai]` shape. Returns whether one was actually removed. */
  deleteGoal(id: string): boolean {
    const before = this.goals.length;
    this.goals = this.goals.filter((g) => g.id !== id);
    return this.goals.length !== before;
  }

  /**
   * Mirrors the `attacks` aspect (`ai_default_rca::aspect_attacks`,
   * `invalidate_on_gamestate_change=yes`): every viable attack combination
   * against every visible enemy, from `aspectAttacks.ts`'s `analyzeTargets`.
   * Cached until the gamestate actually changes (a move/attack/stopunit),
   * matching upstream's own invalidation trigger -- see `composite/
   * aspect.ts`'s module doc comment on why this is the one aspect this port
   * bothers caching.
   */
  getAttacks(): AttackAnalysis[] {
    const snapshot = this.gamestateSnapshot();
    if (this.attacksCache === undefined || this.attacksCacheGamestate !== snapshot) {
      const cfg = this.getAttacksAspectConfig();
      this.attacksCache = analyzeTargets(this, {
        filterOwn: cfg.child('filter_own'),
        filterEnemy: cfg.child('filter_enemy'),
      });
      this.attacksCacheGamestate = snapshot;
    }
    return this.attacksCache;
  }

  /** Mirrors `game_info::recent_attacks` (`ai/actions.cpp:307`), inserted by `executeAttack`; read by `AttackAnalysis.attackClose`. */
  isAttackClose(loc: Location): boolean {
    return this.recentAttackLocs.some((l) => distanceBetween(l, loc) < 4);
  }

  /** Mirrors `manager::play_turn`'s `get_ai_info().recent_attacks.clear()` -- called once per side turn by `AiComposite.newTurn`. */
  clearRecentAttacks(): void {
    this.recentAttackLocs = [];
  }

  isPassiveLeader(leaderId: string): boolean {
    return boolOrIdListMatches(this.resolveAspect('passive_leader')?.getString('value', 'no') ?? 'no', leaderId);
  }
  isPassiveKeepSharingLeader(leaderId: string): boolean {
    return boolOrIdListMatches(this.resolveAspect('passive_leader_shares_keep')?.getString('value', 'no') ?? 'no', leaderId);
  }
  isKeepIgnoringLeader(leaderId: string): boolean {
    return boolOrIdListMatches(this.resolveAspect('leader_ignores_keep')?.getString('value', 'no') ?? 'no', leaderId);
  }

  // --- action log (for a host with a renderer, e.g. `packages/ui`'s `GameShell`, to replay real animations --
  //     mirrors `simpleAi.ts`'s own `AiAction[]` return value; `AiManager.playTurn` (Phase 29 S5) drains this once
  //     per side turn) ---

  /** Appends one entry to this turn's action log -- used directly by CAs whose own semantics (e.g. advancement) aren't already covered by `executeMove`/`executeAttack`/`executeRecruit`/`executeRecall` below. */
  logAction(action: AiAction): void {
    this.actionLog.push(action);
  }

  /** Returns and clears everything logged so far this call -- `AiManager.playTurn` drains this once per side turn. */
  drainActionLog(): AiAction[] {
    const log = this.actionLog;
    this.actionLog = [];
    return log;
  }

  // --- gamestate-tracked actions ---

  /** Mirrors `check_move_action`/`execute_move_action` collapsed into one call (this port's action results aren't split into a separate non-executing "check" phase yet -- see this file's own module doc comment). `removeMovement` (default true, matching every S1 CA's own usage) zeroes `movesLeft` once the move lands, mirroring `remove_movement=true`. */
  executeMove(unit: Unit, path: readonly Location[], removeMovement = true): PerformMoveResult {
    const commands = this.host.commands;
    const outcome = commands
      ? commands.move(unit, path)
      : performMove(this.host.board, unit, path, { raise: this.host.raise, viewingTeam: this.team() });
    if (outcome.moved) {
      if (removeMovement && unit.movesLeft > 0) {
        if (commands) commands.stopUnit(unit, true, false);
        else unit.movesLeft = 0;
      }
      this.bumpGamestateChange();
      this.host.pump();
      this.logAction({ kind: 'move', message: '', animation: { kind: 'move', unit, path } });
    }
    return outcome;
  }

  /** Mirrors `check_attack_action`/`execute_attack_action` collapsed into one call (see this file's own module doc comment on why check/execute aren't split yet). Records the target into `recentAttacks` and bumps the gamestate-change counter unconditionally -- a real attack always changes SOMETHING (attacks_left at minimum), matching upstream's own `attack_result` always reporting `is_gamestate_changed()`. */
  executeAttack(attackerLoc: Location, attackerWeaponIndex: number, defenderLoc: Location, defenderWeaponIndex: number | undefined): AttackResult | null {
    const board = this.host.board;
    const attacker = board.unitAt(attackerLoc);
    const defender = board.unitAt(defenderLoc);
    const attackerHitpointsBefore = attacker?.hitpoints ?? 0;
    const attackerVariation = attacker?.variation ?? '';
    const defenderVariation = defender?.variation ?? '';
    const defenderHitpointsBefore = defender?.hitpoints ?? 0;
    const attackerLocation = attackerLoc;
    const defenderLocation = defenderLoc;

    const result = this.host.commands
      ? this.host.commands.attack(attackerLoc, attackerWeaponIndex, defenderLoc, defenderWeaponIndex)
      : performAttack(board, this.host.rng, attackerLoc, attackerWeaponIndex, defenderLoc, defenderWeaponIndex, {
          attackerLawfulBonus: this.host.lawfulBonusAt(attackerLoc),
          defenderLawfulBonus: this.host.lawfulBonusAt(defenderLoc),
          maxLiminalBonus: this.host.maxLiminalBonus,
          resolveType: this.host.resolveType,
          raise: this.host.raise,
          fire: this.host.fire,
        });
    this.recentAttackLocs.push(defenderLoc);
    this.bumpGamestateChange();
    this.host.pump();

    if (result && attacker && defender) {
      const hits = result.blows.filter((b) => b.hit).length;
      this.logAction({
        kind: 'attack',
        message: `${attacker.type.name} attacked ${defender.type.name}: ${hits}/${result.blows.length} blows landed.`,
        animation: {
          kind: 'attack',
          attacker,
          attackerWeaponIndex,
          defender,
          defenderWeaponIndex: defenderWeaponIndex ?? -1,
          result,
          attackerTypeId: attacker.type.id,
          defenderTypeId: defender.type.id,
          attackerVariation,
          defenderVariation,
          attackerHitpointsBefore,
          defenderHitpointsBefore,
          attackerLocation,
          defenderLocation,
        },
      });
    }
    return result;
  }

  /** Mirrors `check_recruit_action`/`execute_recruit_action` collapsed into one call: a fresh `type` for `team`, placed at `loc` (a vacant castle/keep tile), from the recruiting leader at `from`. Caller (the recruitment CA) is responsible for affordability/legality checks -- this always spends the gold and places the unit. */
  executeRecruit(team: Team, type: UnitType, loc: Location, from: Location): PlaceRecruitResult | null {
    const leader = this.host.board.unitAt(from);
    const result = this.host.commands
      ? this.host.commands.recruit(team, type, loc, from)
      : recruitUnit(this.host.board, team, type, loc, from, this.host.rng, this.host.raise);
    if (!result) return null;
    const unitLocation = result.unit.location;
    this.bumpGamestateChange();
    this.host.pump();
    this.logAction({
      kind: 'recruit',
      message: `${team.teamName || `Side ${team.side}`} recruited a ${type.name} for ${result.cost}g.`,
      animation: leader ? { kind: 'recruit', unit: result.unit, leader, unitLocation, leaderLocation: from } : undefined,
    });
    return result;
  }

  /** Mirrors `check_recall_action`/`execute_recall_action`: pulls `unit` off `team`'s recall list and places it at `loc`. */
  executeRecall(team: Team, unit: Unit, loc: Location, from: Location): PlaceRecruitResult | null {
    const leader = this.host.board.unitAt(from);
    let result: PlaceRecruitResult | null;
    if (this.host.commands) {
      result = this.host.commands.recall(team, unit, loc, from);
    } else {
      this.host.board.removeFromRecallList(team.side, unit.underlyingId);
      result = recallUnit(this.host.board, team, unit, loc, from, undefined, this.host.raise);
    }
    if (!result) return null;
    const unitLocation = result.unit.location;
    this.bumpGamestateChange();
    this.host.pump();
    this.logAction({
      kind: 'recruit',
      message: `${team.teamName || `Side ${team.side}`} recalled ${unit.type.name} for ${result.cost}g.`,
      animation: leader ? { kind: 'recruit', unit: result.unit, leader, unitLocation, leaderLocation: from } : undefined,
    });
    return result;
  }

  /** Mirrors `check_stopunit_action`/`execute_stopunit_action`: zeroes moves and/or attacks without moving, used by CAs (e.g. `goto`) to burn a unit's turn when its intended move didn't land, so the RCA loop doesn't blacklist them for "lying" in `evaluate()`. */
  stopUnit(unit: Unit, removeMovement: boolean, removeAttacks: boolean): boolean {
    const movement = removeMovement && unit.movesLeft > 0;
    const attacks = removeAttacks && unit.attacksLeft > 0;
    const changed = movement || attacks;
    if (!changed) return false;
    if (this.host.commands) {
      this.host.commands.stopUnit(unit, movement, attacks);
    } else {
      if (movement) unit.movesLeft = 0;
      if (attacks) unit.attacksLeft = 0;
    }
    this.bumpGamestateChange();
    return changed;
  }
}
