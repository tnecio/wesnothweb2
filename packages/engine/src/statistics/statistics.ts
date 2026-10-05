/**
 * Phase 25: game statistics, a port of `statistics_record.cpp` (the data and its `[statistics]` WML) and
 * `statistics.cpp` (`statistics_t`, which records into it, and `statistics_attack_context`).
 *
 * A campaign keeps one record per scenario played (`CampaignStats`), each holding one `StatsT` per side,
 * keyed by the side's `save_id` (or its number). The game records into the current scenario's:
 * recruits and recalls (and their undoing), advancements, and every blow of every attack -- hits and
 * misses by chance to hit, damage done and expected, kills and losses. The statistics dialog reads them
 * back per scenario or summed over the campaign (`calculateStats`).
 *
 * Maps are kept sorted as upstream's `std::map`s are, so the WML written (`toConfig`) lists keys in the
 * same order and a real Wesnoth save round-trips.
 */
import { WmlConfig } from '../wml/config.js';

/** `stats_t::str_int_map`: unit type id -> count. */
export type StrIntMap = Map<string, number>;
/** `battle_sequence_frequency_map`: a hit/miss sequence (`s101`) -> how often it happened. */
export type BattleSequenceFrequencyMap = StrIntMap;
/** `battle_result_map`: chance to hit -> sequences. */
export type BattleResultMap = Map<number, BattleSequenceFrequencyMap>;
/** `hitrate_t`: strikes made at one chance to hit, and how many hit. */
export interface Hitrate {
  strikes: number;
  hits: number;
}
/** `hitrate_map`: chance to hit -> strikes and hits. */
export type HitrateMap = Map<number, Hitrate>;

/** `stats_t::decimal_shift`: expected damage is kept as an integer, times this. */
export const STATS_DECIMAL_SHIFT = 1000;

function sortedEntries<K extends string | number, V>(m: Map<K, V>): [K, V][] {
  return [...m.entries()].sort(([a], [b]) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
}

/** `write_str_int_map`: one attribute per count, naming every type with that count (`3=Spearman,Bowman`). */
function writeStrIntMap(m: StrIntMap): WmlConfig {
  const res = new WmlConfig();
  for (const [type, count] of sortedEntries(m)) {
    const key = String(count);
    res.setAttribute(key, res.hasAttribute(key) ? `${res.getString(key)},${type}` : type);
  }
  return res;
}

function readStrIntMap(cfg: WmlConfig, skip: readonly string[] = []): StrIntMap {
  const m: StrIntMap = new Map();
  for (const key of cfg.attributeNames()) {
    if (skip.includes(key)) continue;
    const count = Number.parseInt(key, 10);
    if (!Number.isFinite(count)) continue; // "Invalid statistics entry; skipping"
    for (const type of cfg.getString(key).split(',').map((s) => s.trim()).filter((s) => s !== '')) m.set(type, count);
  }
  return m;
}

function writeBattleResultMap(m: BattleResultMap): WmlConfig {
  const res = new WmlConfig();
  for (const [cth, sequences] of sortedEntries(m)) {
    const seq = res.addChild('sequence', writeStrIntMap(sequences));
    seq.setAttribute('_num', cth);
  }
  return res;
}

function readBattleResultMap(cfg: WmlConfig): BattleResultMap {
  const m: BattleResultMap = new Map();
  for (const seq of cfg.children('sequence')) m.set(seq.getNumber('_num', 0), readStrIntMap(seq, ['_num']));
  return m;
}

function writeByCthMap(m: HitrateMap): WmlConfig {
  const res = new WmlConfig();
  for (const [cth, rate] of sortedEntries(m)) {
    const entry = res.addChild('hitrate_map_entry');
    entry.setAttribute('cth', cth);
    entry.addChild('stats').setAttribute('hits', rate.hits).setAttribute('strikes', rate.strikes);
  }
  return res;
}

function readByCthMap(cfg: WmlConfig): HitrateMap {
  const m: HitrateMap = new Map();
  for (const entry of cfg.children('hitrate_map_entry')) {
    const stats = entry.child('stats');
    m.set(entry.getNumber('cth', 0), { strikes: stats?.getNumber('strikes', 0) ?? 0, hits: stats?.getNumber('hits', 0) ?? 0 });
  }
  return m;
}

function mergeStrIntMap(a: StrIntMap, b: StrIntMap): void {
  for (const [k, v] of b) a.set(k, (a.get(k) ?? 0) + v);
}

function mergeBattleResultMaps(a: BattleResultMap, b: BattleResultMap): void {
  for (const [cth, seqs] of b) {
    let target = a.get(cth);
    if (!target) a.set(cth, (target = new Map()));
    mergeStrIntMap(target, seqs);
  }
}

function mergeCthMap(a: HitrateMap, b: HitrateMap): void {
  for (const [cth, rate] of b) {
    const t = a.get(cth) ?? { strikes: 0, hits: 0 };
    t.hits += rate.hits;
    t.strikes += rate.strikes;
    a.set(cth, t);
  }
}

/** `read_by_cth_map_from_battle_result_maps`: the per-chance hit rates, rebuilt from the sequences. */
function byCthFromBattleResultMaps(attacks: BattleResultMap, defends: BattleResultMap): HitrateMap {
  const merged: BattleResultMap = new Map([...attacks].map(([k, v]) => [k, new Map(v)]));
  mergeBattleResultMaps(merged, defends);
  const m: HitrateMap = new Map();
  for (const [cth, frequencies] of merged) {
    for (const [res, occurrences] of frequencies) {
      const misses = [...res].filter((c) => c === '0').length;
      const hits = [...res].filter((c) => c === '1').length;
      if (misses + hits === 0) continue;
      const t = m.get(cth) ?? { strikes: 0, hits: 0 };
      t.strikes += (misses + hits) * occurrences;
      t.hits += hits * occurrences;
      m.set(cth, t);
    }
  }
  return m;
}

function cloneCth(m: HitrateMap): HitrateMap {
  return new Map([...m].map(([k, v]) => [k, { ...v }]));
}

/** `statistics_record::stats_t`: one side's statistics for one scenario (or summed). */
export class StatsT {
  recruits: StrIntMap = new Map();
  recalls: StrIntMap = new Map();
  advancedTo: StrIntMap = new Map();
  deaths: StrIntMap = new Map();
  killed: StrIntMap = new Map();
  recruitCost = 0;
  recallCost = 0;
  /** This side's attacks on its own turns. */
  attacksInflicted: BattleResultMap = new Map();
  /** This side's attacks on enemies' turns (its retaliation). */
  defendsInflicted: BattleResultMap = new Map();
  /** Enemies' counter-attacks on this side's turns. */
  attacksTaken: BattleResultMap = new Map();
  /** Enemies' attacks against this side on their turns. */
  defendsTaken: BattleResultMap = new Map();
  damageInflicted = 0;
  damageTaken = 0;
  turnDamageInflicted = 0;
  turnDamageTaken = 0;
  byCthInflicted: HitrateMap = new Map();
  byCthTaken: HitrateMap = new Map();
  turnByCthInflicted: HitrateMap = new Map();
  turnByCthTaken: HitrateMap = new Map();
  /** Times `STATS_DECIMAL_SHIFT`. */
  expectedDamageInflicted = 0;
  expectedDamageTaken = 0;
  turnExpectedDamageInflicted = 0;
  turnExpectedDamageTaken = 0;
  saveId = '';

  static fromConfig(cfg: WmlConfig): StatsT {
    const s = new StatsT();
    s.read(cfg);
    return s;
  }

  /** `stats_t::write`. `by_cth_*` are not written: reading rebuilds them from the sequences. */
  toConfig(): WmlConfig {
    const res = new WmlConfig();
    res.addChild('recruits', writeStrIntMap(this.recruits));
    res.addChild('recalls', writeStrIntMap(this.recalls));
    res.addChild('advances', writeStrIntMap(this.advancedTo));
    res.addChild('deaths', writeStrIntMap(this.deaths));
    res.addChild('killed', writeStrIntMap(this.killed));
    res.addChild('attacks', writeBattleResultMap(this.attacksInflicted));
    res.addChild('defends', writeBattleResultMap(this.defendsInflicted));
    res.addChild('attacks_taken', writeBattleResultMap(this.attacksTaken));
    res.addChild('defends_taken', writeBattleResultMap(this.defendsTaken));
    res.addChild('turn_by_cth_inflicted', writeByCthMap(this.turnByCthInflicted));
    res.addChild('turn_by_cth_taken', writeByCthMap(this.turnByCthTaken));
    res.setAttribute('recruit_cost', this.recruitCost);
    res.setAttribute('recall_cost', this.recallCost);
    res.setAttribute('damage_inflicted', this.damageInflicted);
    res.setAttribute('damage_taken', this.damageTaken);
    res.setAttribute('expected_damage_inflicted', this.expectedDamageInflicted);
    res.setAttribute('expected_damage_taken', this.expectedDamageTaken);
    res.setAttribute('turn_damage_inflicted', this.turnDamageInflicted);
    res.setAttribute('turn_damage_taken', this.turnDamageTaken);
    res.setAttribute('turn_expected_damage_inflicted', this.turnExpectedDamageInflicted);
    res.setAttribute('turn_expected_damage_taken', this.turnExpectedDamageTaken);
    res.setAttribute('save_id', this.saveId);
    return res;
  }

  /** `stats_t::read`. */
  read(cfg: WmlConfig): void {
    const c = (tag: string): WmlConfig | undefined => cfg.child(tag);
    if (c('recruits')) this.recruits = readStrIntMap(c('recruits')!);
    if (c('recalls')) this.recalls = readStrIntMap(c('recalls')!);
    if (c('advances')) this.advancedTo = readStrIntMap(c('advances')!);
    if (c('deaths')) this.deaths = readStrIntMap(c('deaths')!);
    if (c('killed')) this.killed = readStrIntMap(c('killed')!);
    if (c('attacks')) this.attacksInflicted = readBattleResultMap(c('attacks')!);
    if (c('defends')) this.defendsInflicted = readBattleResultMap(c('defends')!);
    if (c('attacks_taken')) this.attacksTaken = readBattleResultMap(c('attacks_taken')!);
    if (c('defends_taken')) this.defendsTaken = readBattleResultMap(c('defends_taken')!);
    this.byCthInflicted = byCthFromBattleResultMaps(this.attacksInflicted, this.defendsInflicted);
    // Empty in old (pre-#4070) saves with no [attacks_taken]/[defends_taken].
    this.byCthTaken = byCthFromBattleResultMaps(this.attacksTaken, this.defendsTaken);
    if (c('turn_by_cth_inflicted')) this.turnByCthInflicted = readByCthMap(c('turn_by_cth_inflicted')!);
    if (c('turn_by_cth_taken')) this.turnByCthTaken = readByCthMap(c('turn_by_cth_taken')!);
    this.recruitCost = cfg.getNumber('recruit_cost', 0);
    this.recallCost = cfg.getNumber('recall_cost', 0);
    this.damageInflicted = cfg.getNumber('damage_inflicted', 0);
    this.damageTaken = cfg.getNumber('damage_taken', 0);
    this.expectedDamageInflicted = cfg.getNumber('expected_damage_inflicted', 0);
    this.expectedDamageTaken = cfg.getNumber('expected_damage_taken', 0);
    this.turnDamageInflicted = cfg.getNumber('turn_damage_inflicted', 0);
    this.turnDamageTaken = cfg.getNumber('turn_damage_taken', 0);
    this.turnExpectedDamageInflicted = cfg.getNumber('turn_expected_damage_inflicted', 0);
    this.turnExpectedDamageTaken = cfg.getNumber('turn_expected_damage_taken', 0);
    this.saveId = cfg.getString('save_id', '');
  }

  /** `stats_t::merge_with`: sums, but the "this turn" figures are the last scenario's. */
  mergeWith(b: StatsT): void {
    mergeStrIntMap(this.recruits, b.recruits);
    mergeStrIntMap(this.recalls, b.recalls);
    mergeStrIntMap(this.advancedTo, b.advancedTo);
    mergeStrIntMap(this.deaths, b.deaths);
    mergeStrIntMap(this.killed, b.killed);
    mergeCthMap(this.byCthInflicted, b.byCthInflicted);
    mergeCthMap(this.byCthTaken, b.byCthTaken);
    mergeBattleResultMaps(this.attacksInflicted, b.attacksInflicted);
    mergeBattleResultMaps(this.defendsInflicted, b.defendsInflicted);
    mergeBattleResultMaps(this.attacksTaken, b.attacksTaken);
    mergeBattleResultMaps(this.defendsTaken, b.defendsTaken);
    this.recruitCost += b.recruitCost;
    this.recallCost += b.recallCost;
    this.damageInflicted += b.damageInflicted;
    this.damageTaken += b.damageTaken;
    this.expectedDamageInflicted += b.expectedDamageInflicted;
    this.expectedDamageTaken += b.expectedDamageTaken;
    this.turnDamageInflicted = b.turnDamageInflicted;
    this.turnDamageTaken = b.turnDamageTaken;
    this.turnExpectedDamageInflicted = b.turnExpectedDamageInflicted;
    this.turnExpectedDamageTaken = b.turnExpectedDamageTaken;
    this.turnByCthInflicted = cloneCth(b.turnByCthInflicted);
    this.turnByCthTaken = cloneCth(b.turnByCthTaken);
  }
}

/** `scenario_stats_t`: one scenario's statistics, per side. */
export interface ScenarioStats {
  scenarioName: string;
  teamStats: Map<string, StatsT>;
}

/** `campaign_stats_t`: every scenario of the campaign so far, oldest first. */
export class CampaignStats {
  masterRecord: ScenarioStats[] = [];

  /** `campaign_stats_t::read` (`[statistics]`'s `[scenario]` children). */
  static fromConfig(cfg: WmlConfig): CampaignStats {
    const c = new CampaignStats();
    c.read(cfg);
    return c;
  }

  read(cfg: WmlConfig, append = false): void {
    if (!append) this.masterRecord = [];
    for (const s of cfg.children('scenario')) {
      const teamStats = new Map<string, StatsT>();
      for (const team of s.children('team')) teamStats.set(team.getString('save_id', ''), StatsT.fromConfig(team));
      this.masterRecord.push({ scenarioName: s.getString('scenario', ''), teamStats });
    }
  }

  /** `campaign_stats_t::to_config`: the body of a save's `[statistics]`. */
  toConfig(): WmlConfig {
    const res = new WmlConfig();
    for (const s of this.masterRecord) {
      const sc = res.addChild('scenario');
      sc.setAttribute('scenario', s.scenarioName);
      for (const [, stats] of sortedEntries(s.teamStats)) sc.addChild('team', stats.toConfig());
    }
    return res;
  }

  /** `campaign_stats_t::new_scenario`. */
  newScenario(name: string): void {
    this.masterRecord.push({ scenarioName: name, teamStats: new Map() });
  }

  /** `campaign_stats_t::clear_current_scenario`. */
  clearCurrentScenario(): void {
    this.masterRecord[this.masterRecord.length - 1]?.teamStats.clear();
  }

  clone(): CampaignStats {
    return CampaignStats.fromConfig(this.toConfig());
  }
}

/** What the statistics need of a unit: its type, its side's save id and its cost. */
export interface StatsUnit {
  readonly typeId: string;
  /** `unit_type::parent_id()`: a recruit counts under its base type. */
  readonly baseTypeId: string;
  /** `team::save_id_or_number()` of the unit's side. */
  readonly saveId: string;
  /** `unit::cost()`. */
  readonly cost: number;
}

/** `statistics_attack_context::hit_result`. */
export type HitResult = 'misses' | 'hits' | 'kills';

/** `statistics_t`: records into the current scenario of a `CampaignStats`. */
export class Statistics {
  constructor(readonly record: CampaignStats) {}

  /** `statistics_t::get_stats`: the current scenario's stats for `saveId`, made on first use. */
  getStats(saveId: string): StatsT {
    if (this.record.masterRecord.length === 0) this.record.newScenario('');
    const team = this.record.masterRecord[this.record.masterRecord.length - 1]!.teamStats;
    let s = team.get(saveId);
    if (!s) {
      s = new StatsT();
      // Upstream leaves it empty until `reset_turn_stats`; set here so a scenario that ends before the side's
      // first turn still writes the key it is read back under.
      s.saveId = saveId;
      team.set(saveId, s);
    }
    return s;
  }

  recruitUnit(u: StatsUnit): void {
    const s = this.getStats(u.saveId);
    s.recruits.set(u.baseTypeId, (s.recruits.get(u.baseTypeId) ?? 0) + 1);
    s.recruitCost += u.cost;
  }

  recallUnit(u: StatsUnit): void {
    const s = this.getStats(u.saveId);
    s.recalls.set(u.typeId, (s.recalls.get(u.typeId) ?? 0) + 1);
    s.recallCost += u.cost;
  }

  unRecallUnit(u: StatsUnit): void {
    const s = this.getStats(u.saveId);
    s.recalls.set(u.typeId, (s.recalls.get(u.typeId) ?? 0) - 1);
    s.recallCost -= u.cost;
  }

  unRecruitUnit(u: StatsUnit): void {
    const s = this.getStats(u.saveId);
    s.recruits.set(u.baseTypeId, (s.recruits.get(u.baseTypeId) ?? 0) - 1);
    s.recruitCost -= u.cost;
  }

  /** `statistics_t::advance_unit`: under the type the unit became. */
  advanceUnit(u: StatsUnit): void {
    const s = this.getStats(u.saveId);
    s.advancedTo.set(u.typeId, (s.advancedTo.get(u.typeId) ?? 0) + 1);
  }

  /** `statistics_t::reset_turn_stats`, as a side's turn begins. */
  resetTurnStats(saveId: string): void {
    const s = this.getStats(saveId);
    s.turnDamageInflicted = 0;
    s.turnDamageTaken = 0;
    s.turnExpectedDamageInflicted = 0;
    s.turnExpectedDamageTaken = 0;
    s.turnByCthInflicted = new Map();
    s.turnByCthTaken = new Map();
    s.saveId = saveId;
  }

  /** `statistics_t::calculate_stats`: every scenario's stats for `saveId`, merged oldest first. */
  calculateStats(saveId: string): StatsT {
    const res = new StatsT();
    for (const scenario of this.record.masterRecord) {
      const s = scenario.teamStats.get(saveId);
      if (s) res.mergeWith(s);
    }
    return res;
  }

  /** `statistics_t::level_stats`: each scenario with stats for `saveId`; never empty. */
  levelStats(saveId: string): { name: string; stats: StatsT }[] {
    const levels = this.record.masterRecord.flatMap((s) => {
      const stats = s.teamStats.get(saveId);
      return stats ? [{ name: s.scenarioName, stats }] : [];
    });
    return levels.length > 0 ? levels : [{ name: '', stats: new StatsT() }];
  }

  /** Starts `statistics_attack_context` for one attack. */
  attackContext(attacker: StatsUnit, defender: StatsUnit, attackerCth: number, defenderCth: number): AttackStatsContext {
    return new AttackStatsContext(this, attacker, defender, attackerCth, defenderCth);
  }
}

/** `statistics_t::sum_str_int_map`. */
export function sumStrIntMap(m: StrIntMap): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

/** `statistics_t::sum_cost_str_int_map`: count times the type's cost; unknown types are left out. */
export function sumCostStrIntMap(m: StrIntMap, costOf: (typeId: string) => number | undefined): number {
  let cost = 0;
  for (const [type, n] of m) {
    const c = costOf(type);
    if (c !== undefined) cost += n * c;
  }
  return cost;
}

/** `statistics_attack_context`: one attack's blows, recorded as they land; `finish` is its destructor. */
export class AttackStatsContext {
  private attackerRes = '';
  private defenderRes = '';

  constructor(
    private readonly stats: Statistics,
    private readonly attacker: StatsUnit,
    private readonly defender: StatsUnit,
    /** `chance_to_hit_defender`: the attacker's chance to hit. */
    private readonly cthDefender: number,
    /** `chance_to_hit_attacker`: the defender's chance to hit. */
    private readonly cthAttacker: number,
  ) {}

  private att(): StatsT {
    return this.stats.getStats(this.attacker.saveId);
  }

  private def(): StatsT {
    return this.stats.getStats(this.defender.saveId);
  }

  /** `attack_expected_damage`: damage potential times chance to hit, for each strike. */
  attackExpectedDamage(attackerInflict: number, defenderInflict: number): void {
    const a = Math.round(attackerInflict * STATS_DECIMAL_SHIFT);
    const d = Math.round(defenderInflict * STATS_DECIMAL_SHIFT);
    const att = this.att();
    const def = this.def();
    att.expectedDamageInflicted += a;
    att.expectedDamageTaken += d;
    def.expectedDamageInflicted += d;
    def.expectedDamageTaken += a;
    att.turnExpectedDamageInflicted += a;
    att.turnExpectedDamageTaken += d;
    def.turnExpectedDamageInflicted += d;
    def.turnExpectedDamageTaken += a;
  }

  /** `attack_result`: one of the attacker's strikes. */
  attackResult(res: HitResult, cth: number, damage: number, drain: number): void {
    this.attackerRes += res === 'misses' ? '0' : '1';
    const att = this.att();
    const def = this.def();
    strike(att.byCthInflicted, cth, res !== 'misses');
    strike(att.turnByCthInflicted, cth, res !== 'misses');
    strike(def.byCthTaken, cth, res !== 'misses');
    strike(def.turnByCthTaken, cth, res !== 'misses');
    if (res !== 'misses') {
      att.damageTaken -= drain;
      def.damageInflicted -= drain;
      att.turnDamageTaken -= drain;
      def.turnDamageInflicted -= drain;
      att.damageInflicted += damage;
      def.damageTaken += damage;
      att.turnDamageInflicted += damage;
      def.turnDamageTaken += damage;
    }
    if (res === 'kills') {
      att.killed.set(this.defender.typeId, (att.killed.get(this.defender.typeId) ?? 0) + 1);
      def.deaths.set(this.defender.typeId, (def.deaths.get(this.defender.typeId) ?? 0) + 1);
    }
  }

  /** `defend_result`: one of the defender's strikes. */
  defendResult(res: HitResult, cth: number, damage: number, drain: number): void {
    this.defenderRes += res === 'misses' ? '0' : '1';
    const att = this.att();
    const def = this.def();
    strike(def.byCthInflicted, cth, res !== 'misses');
    strike(def.turnByCthInflicted, cth, res !== 'misses');
    strike(att.byCthTaken, cth, res !== 'misses');
    strike(att.turnByCthTaken, cth, res !== 'misses');
    if (res !== 'misses') {
      def.damageTaken -= drain;
      att.damageInflicted -= drain;
      def.turnDamageTaken -= drain;
      att.turnDamageInflicted -= drain;
      att.damageTaken += damage;
      def.damageInflicted += damage;
      att.turnDamageTaken += damage;
      def.turnDamageInflicted += damage;
    }
    if (res === 'kills') {
      att.deaths.set(this.attacker.typeId, (att.deaths.get(this.attacker.typeId) ?? 0) + 1);
      def.killed.set(this.attacker.typeId, (def.killed.get(this.attacker.typeId) ?? 0) + 1);
    }
  }

  /** `~statistics_attack_context`: the whole exchange's sequences, under each side's chance to hit. */
  finish(): void {
    const attackerKey = `s${this.attackerRes}`;
    const defenderKey = `s${this.defenderRes}`;
    bump(this.att().attacksInflicted, this.cthDefender, attackerKey);
    bump(this.def().defendsInflicted, this.cthAttacker, defenderKey);
    bump(this.att().attacksTaken, this.cthAttacker, defenderKey);
    bump(this.def().defendsTaken, this.cthDefender, attackerKey);
  }
}

function strike(m: HitrateMap, cth: number, hit: boolean): void {
  const t = m.get(cth) ?? { strikes: 0, hits: 0 };
  t.strikes += 1;
  if (hit) t.hits += 1;
  m.set(cth, t);
}

function bump(m: BattleResultMap, cth: number, key: string): void {
  let seqs = m.get(cth);
  if (!seqs) m.set(cth, (seqs = new Map()));
  seqs.set(key, (seqs.get(key) ?? 0) + 1);
}
