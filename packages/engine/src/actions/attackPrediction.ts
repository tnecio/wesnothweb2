/**
 * TS port of upstream Wesnoth's `attack_prediction.hpp`/`.cpp`: the
 * statistical combat-outcome engine that computes a full probability
 * distribution over post-combat hitpoints (plus poison/slow/"untouched"
 * chances) for both combatants, given their stats. This feeds both the UI's
 * combat-prediction popup and (in `combat.ts`) nothing directly -- actual
 * combat resolution uses real RNG rolls (`combat.ts`), not this module;
 * this module is pure prediction, exactly mirroring upstream's own split
 * between `attack_prediction.cpp` (statistics) and `actions/attack.cpp`
 * (`attack::perform_hit`, the real roll-by-roll resolution).
 *
 * ## Algorithm, in short
 *
 * The engine tracks a joint probability matrix over
 * (attacker hp, defender hp, attacker-slowed?, defender-slowed?) -- four
 * "planes" (neither/A-only/B-only/both slowed), each a dense
 * `(maxHpA+1) x (maxHpB+1)` grid of probabilities. Each blow struck shifts
 * probability mass within this matrix: `shiftCols`/`shiftRows` move a
 * `hitChance`-weighted portion of each cell's probability towards lower
 * HP (by `damage` columns/rows), optionally also moving it to a "slowed"
 * plane and/or a HP-drained row/column. Column/row 0 acts as an absorbing
 * "dead" state. After all blows in a round (interleaved by firststrike
 * order), the matrix is summed back down to independent per-combatant HP
 * distributions (`hpDist`) for the next round or for the final result.
 *
 * ## Deliberate simplifications vs. upstream (see module doc comments below
 * for the specifics)
 *
 *  - **Dense matrices, not upstream's sparse "used rows/cols" bookkeeping.**
 *    Upstream tracks which rows/columns of each plane are actually nonzero
 *    purely as a *performance* optimization (the AI evaluates huge numbers
 *    of hypothetical attacks). This port always processes the full
 *    `rows x cols` grid; every transfer already no-ops on a zero source
 *    (mirroring `xfer`'s `if (src != 0.0)` guard), so this is a pure
 *    constant-factor slowdown, not a correctness difference -- verified by
 *    literally replicating the same row/column *traversal order*
 *    (ascending/descending based on drain sign) that upstream's comments
 *    say is what actually matters for correctness when a plane transfers
 *    to itself.
 *  - **No Monte Carlo fallback.** Upstream switches to a 5000-iteration
 *    Monte Carlo simulation (`monte_carlo_combat_matrix`) once
 *    `fight_complexity() > 50000` (roughly: swarm-slice-count *
 *    maxHpA * maxHpB, doubled per slow-capable side) to keep the AI's combat
 *    evaluation fast. This port always runs the exact probability
 *    calculation. This is *slower* on very-high-HP combats (e.g. two
 *    100+-HP swarm units both slowed) but never less correct -- exact
 *    calculation is strictly more precise than the Monte Carlo path it
 *    replaces, and nothing in this project's scope yet needs the AI-scale
 *    performance that fallback exists for.
 *  - **No fast paths.** Upstream's `do_fight()` special-cases "at most one
 *    strike each" (`one_strike_fight`) and "nobody can possibly die this
 *    exchange" (`no_death_fight`) with closed-form Pascal's-triangle-style
 *    math, purely for speed -- `complex_fight()`'s general matrix approach
 *    produces identical results for those cases (upstream's own code
 *    comments and its `#if 0`-guarded self-check in `combatant::fight`
 *    confirm this). This port always takes the general `complexFight` path.
 */

/** One combatant's effective stats for a single simulated combat, mirroring `battle_context_unit_stats`. */
export interface BattleContextUnitStats {
  readonly isAttacker: boolean;
  readonly isPoisoned: boolean;
  readonly isSlowed: boolean;
  /** This combatant's attack slows the opponent when it hits. */
  readonly slows: boolean;
  /** This combatant's attack drains hp from the opponent when it hits. */
  readonly drains: boolean;
  /** This combatant's attack petrifies the opponent when it hits. */
  readonly petrifies: boolean;
  /** This combatant's attack poisons the opponent when it hits. */
  readonly poisons: boolean;
  /** This combatant's attack has the firststrike special. */
  readonly firststrike: boolean;
  readonly canAdvance: boolean;
  readonly experience: number;
  readonly maxExperience: number;
  readonly level: number;
  /** Berserk-derived number of rounds (1 if no berserk). */
  readonly rounds: number;
  readonly hp: number;
  readonly maxHp: number;
  /** 0-100. */
  readonly chanceToHit: number;
  readonly damage: number;
  /** Damage dealt while slowed (== damage if already slowed). */
  readonly slowDamage: number;
  readonly drainPercent: number;
  readonly drainConstant: number;
  /** Effective number of blows this round, accounting for swarm at the combat's starting hp. */
  readonly numBlows: number;
  readonly swarmMin: number;
  readonly swarmMax: number;
}

/** Mirrors the free function `swarm_blows()` from `actions/attack.hpp`. */
export function swarmBlows(minBlows: number, maxBlows: number, hp: number, maxHp: number): number {
  if (hp >= maxHp) return maxBlows;
  return maxBlows < minBlows
    ? minBlows - Math.trunc(((minBlows - maxBlows) * hp) / maxHp)
    : minBlows + Math.trunc(((maxBlows - minBlows) * hp) / maxHp);
}

/** Mirrors `battle_context_unit_stats::calc_blows`. */
export function calcBlows(stats: BattleContextUnitStats, newHp: number): number {
  return swarmBlows(stats.swarmMin, stats.swarmMax, newHp, stats.maxHp);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// combat_slice / split_summary: swarm-driven splitting of the combat by the
// number of strikes each combatant gets, when that depends on current hp
// (which can itself have a probability distribution from a prior combat).
// ---------------------------------------------------------------------------

interface CombatSlice {
  readonly beginHp: number;
  readonly endHp: number; // exclusive
  readonly prob: number;
  readonly strikes: number;
}

/** A [normal, slowed] pair of per-hp probability vectors (empty = "not yet computed / single known value"). */
type Summary = [number[], number[]];

function makeSlice(summary: Summary, begin: number, end: number, strikes: number): CombatSlice {
  if (summary[0].length === 0) {
    return { beginHp: begin, endHp: end, prob: 1.0, strikes };
  }
  const clampedEnd = Math.min(end, summary[0].length);
  let prob = 0;
  for (let i = begin; i < clampedEnd; i++) prob += summary[0][i]!;
  if (summary[1].length > 0) {
    for (let i = begin; i < clampedEnd; i++) prob += summary[1][i]!;
  }
  return { beginHp: begin, endHp: end, prob, strikes };
}

function fullSlice(summary: Summary, strikes: number): CombatSlice {
  return { beginHp: 0, endHp: summary[0].length, prob: 1.0, strikes };
}

/** Mirrors `hp_for_next_attack`. */
function hpForNextAttack(curHpIn: number, stats: BattleContextUnitStats): number {
  const oldStrikes = calcBlows(stats, curHpIn);
  let curHp = curHpIn;
  while (++curHp <= stats.maxHp) {
    if (calcBlows(stats, curHp) !== oldStrikes) break;
  }
  return curHp;
}

/** Mirrors `split_summary`. */
function splitSummary(stats: BattleContextUnitStats, summary: Summary): CombatSlice[] {
  if (stats.swarmMin === stats.swarmMax || summary[0].length === 0) {
    return [fullSlice(summary, stats.numBlows)];
  }

  const result: CombatSlice[] = [];
  let curEnd = 0;
  do {
    const curBegin = curEnd;
    curEnd = hpForNextAttack(curBegin, stats);
    const slice = makeSlice(summary, curBegin, curEnd, calcBlows(stats, curBegin));
    if (slice.prob !== 0.0) result.push(slice);
  } while (curEnd <= stats.maxHp);
  return result;
}

// ---------------------------------------------------------------------------
// ProbMatrix: the dense 4-plane probability grid. See module doc comment for
// why this is dense rather than upstream's sparse "used rows/cols" version.
// ---------------------------------------------------------------------------

const NEITHER_SLOWED = 0;
const A_SLOWED = 1;
const B_SLOWED = 2;
const BOTH_SLOWED = 3;
const NUM_PLANES = 4;

class ProbMatrix {
  private readonly planes: (Float64Array | null)[] = [null, null, null, null];
  private readonly rows: number;
  private readonly cols: number;

  /**
   * `aMax`/`bMax` are max-HP values, NOT row/column counts -- mirrors
   * `prob_matrix::prob_matrix`'s `rows_(a_max + 1), cols_(b_max + 1)`
   * member-init-list exactly. Representing HP states 0..maxHp inclusive
   * needs maxHp+1 slots; the +1 must happen here, not at each call site
   * (a prior version of this port passed maxHp straight through as `rows`/
   * `cols`, silently dropping the top HP value and shifting every other
   * outcome down by one -- caught by
   * test/actions/attackPrediction.test.ts's hand-computed binomial cases).
   */
  constructor(
    aMax: number,
    bMax: number,
    needASlowedIn: boolean,
    needBSlowedIn: boolean,
    aCurIn: number,
    bCurIn: number,
    aInitial: Summary,
    bInitial: Summary,
  ) {
    this.rows = aMax + 1;
    this.cols = bMax + 1;
    const needASlowed = needASlowedIn || aInitial[1].length > 0;
    const needBSlowed = needBSlowedIn || bInitial[1].length > 0;

    this.planes[NEITHER_SLOWED] = this.newPlane();
    this.planes[A_SLOWED] = needASlowed ? this.newPlane() : null;
    this.planes[B_SLOWED] = needBSlowed ? this.newPlane() : null;
    this.planes[BOTH_SLOWED] = needASlowed && needBSlowed ? this.newPlane() : null;

    const aCur = Math.min(aCurIn, this.rows - 1);
    const bCur = Math.min(bCurIn, this.cols - 1);

    this.initializePlane(NEITHER_SLOWED, aCur, bCur, aInitial[0], bInitial[0]);
    if (aInitial[1].length > 0) this.initializePlane(A_SLOWED, aCur, bCur, aInitial[1], bInitial[0]);
    if (bInitial[1].length > 0) this.initializePlane(B_SLOWED, aCur, bCur, aInitial[0], bInitial[1]);
    if (aInitial[1].length > 0 && bInitial[1].length > 0) {
      this.initializePlane(BOTH_SLOWED, aCur, bCur, aInitial[1], bInitial[1]);
    }
  }

  private newPlane(): Float64Array {
    return new Float64Array(this.rows * this.cols);
  }

  planeUsed(p: number): boolean {
    return p < NUM_PLANES && this.planes[p] != null;
  }

  numRows(): number {
    return this.rows;
  }
  numCols(): number {
    return this.cols;
  }

  private val(p: number, r: number, c: number): number {
    return this.planes[p]![r * this.cols + c]!;
  }
  private setVal(p: number, r: number, c: number, v: number): void {
    this.planes[p]![r * this.cols + c] = v;
  }
  private addVal(p: number, r: number, c: number, d: number): void {
    const plane = this.planes[p]!;
    const idx = r * this.cols + c;
    plane[idx] = plane[idx]! + d;
  }

  private initializePlane(plane: number, aCur: number, bCur: number, aInitial: number[], bInitial: number[]): void {
    if (aInitial.length > 0) {
      const rowCount = Math.min(aInitial.length, this.rows);
      for (let row = 0; row < rowCount; row++) {
        if (aInitial[row] !== 0) this.initializeRow(plane, row, aInitial[row]!, bCur, bInitial);
      }
    } else {
      this.initializeRow(plane, aCur, 1.0, bCur, bInitial);
    }
  }

  private initializeRow(plane: number, row: number, rowProb: number, bCur: number, bInitial: number[]): void {
    if (bInitial.length > 0) {
      const colCount = Math.min(bInitial.length, this.cols);
      for (let col = 0; col < colCount; col++) {
        if (bInitial[col] !== 0) this.addVal(plane, row, col, rowProb * bInitial[col]!);
      }
    } else {
      this.addVal(plane, row, bCur, rowProb);
    }
  }

  /** Mirrors the probability-weighted `xfer` overload. */
  private xferProb(dstPlane: number, srcPlane: number, rowDst: number, colDst: number, rowSrc: number, colSrc: number, prob: number): void {
    const src = this.val(srcPlane, rowSrc, colSrc);
    if (src !== 0.0) {
      const diff = src * prob;
      this.addVal(srcPlane, rowSrc, colSrc, -diff);
      this.addVal(dstPlane, rowDst, colDst, diff);
    }
  }

  /** Mirrors the all-or-nothing `xfer` overload (used by the levelup/petrify-distortion moves). */
  private xferAll(dstPlane: number, srcPlane: number, rowDst: number, colDst: number, rowSrc: number, colSrc: number): void {
    if (dstPlane === srcPlane && rowDst === rowSrc && colDst === colSrc) return;
    const src = this.val(srcPlane, rowSrc, colSrc);
    if (src !== 0.0) {
      this.addVal(dstPlane, rowDst, colDst, src);
      this.setVal(srcPlane, rowSrc, colSrc, 0);
    }
  }

  private shiftColsInRow(
    dst: number,
    src: number,
    row: number,
    damage: number,
    prob: number,
    drainmax: number,
    drainConstant: number,
    drainPercent: number,
  ): void {
    const maxRow = this.rows - 1;
    let col = 1;
    for (; col < damage && col < this.cols; col++) {
      const drainAmount = Math.trunc((col * drainPercent) / 100) + drainConstant;
      const newRow = clamp(row + drainAmount, 1, maxRow);
      this.xferProb(dst, src, newRow, 0, row, col, prob);
    }
    const newRow = clamp(row + drainmax, 1, maxRow);
    for (; col < this.cols; col++) {
      this.xferProb(dst, src, newRow, col - damage, row, col, prob);
    }
  }

  /** Mirrors `prob_matrix::shift_cols`: B (columns) takes damage. */
  shiftCols(dst: number, src: number, damage: number, prob: number, drainConstant: number, drainPercent: number): void {
    if (!this.planeUsed(src)) return;
    const drainmax = Math.trunc((drainPercent * damage) / 100) + drainConstant;
    if (drainmax > 0) {
      for (let row = this.rows - 1; row >= 1; row--) {
        this.shiftColsInRow(dst, src, row, damage, prob, drainmax, drainConstant, drainPercent);
      }
    } else {
      for (let row = 1; row < this.rows; row++) {
        this.shiftColsInRow(dst, src, row, damage, prob, drainmax, drainConstant, drainPercent);
      }
    }
  }

  private shiftRowsInCol(
    dst: number,
    src: number,
    col: number,
    damage: number,
    prob: number,
    drainmax: number,
    drainConstant: number,
    drainPercent: number,
  ): void {
    const maxCol = this.cols - 1;
    let row = 1;
    for (; row < damage && row < this.rows; row++) {
      const drainAmount = Math.trunc((row * drainPercent) / 100) + drainConstant;
      const newCol = clamp(col + drainAmount, 1, maxCol);
      this.xferProb(dst, src, 0, newCol, row, col, prob);
    }
    const newCol = clamp(col + drainmax, 1, maxCol);
    for (; row < this.rows; row++) {
      this.xferProb(dst, src, row - damage, newCol, row, col, prob);
    }
  }

  /** Mirrors `prob_matrix::shift_rows`: A (rows) takes damage. */
  shiftRows(dst: number, src: number, damage: number, prob: number, drainConstant: number, drainPercent: number): void {
    if (!this.planeUsed(src)) return;
    const drainmax = Math.trunc((drainPercent * damage) / 100) + drainConstant;
    if (drainmax > 0) {
      for (let col = this.cols - 1; col >= 1; col--) {
        this.shiftRowsInCol(dst, src, col, damage, prob, drainmax, drainConstant, drainPercent);
      }
    } else {
      for (let col = 1; col < this.cols; col++) {
        this.shiftRowsInCol(dst, src, col, damage, prob, drainmax, drainConstant, drainPercent);
      }
    }
  }

  moveColumn(dPlane: number, sPlane: number, dCol: number, sCol: number): void {
    if (!this.planeUsed(sPlane)) return;
    for (let row = 0; row < this.rows; row++) this.xferAll(dPlane, sPlane, row, dCol, row, sCol);
  }

  moveRow(dPlane: number, sPlane: number, dRow: number, sRow: number): void {
    if (!this.planeUsed(sPlane)) return;
    for (let col = 0; col < this.cols; col++) this.xferAll(dPlane, sPlane, dRow, col, sRow, col);
  }

  /** Excludes row 0 (the dead state). */
  mergeCol(dPlane: number, sPlane: number, col: number, dRow: number): void {
    if (!this.planeUsed(sPlane)) return;
    for (let row = 1; row < this.rows; row++) this.xferAll(dPlane, sPlane, dRow, col, row, col);
  }

  mergeCols(dPlane: number, sPlane: number, dRow: number): void {
    if (!this.planeUsed(sPlane)) return;
    for (let row = 1; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) this.xferAll(dPlane, sPlane, dRow, col, row, col);
    }
  }

  /** Excludes column 0. */
  mergeRow(dPlane: number, sPlane: number, row: number, dCol: number): void {
    if (!this.planeUsed(sPlane)) return;
    for (let col = 1; col < this.cols; col++) this.xferAll(dPlane, sPlane, row, dCol, row, col);
  }

  mergeRows(dPlane: number, sPlane: number, dCol: number): void {
    if (!this.planeUsed(sPlane)) return;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 1; col < this.cols; col++) this.xferAll(dPlane, sPlane, row, dCol, row, col);
    }
  }

  /** What is the chance that an indicated combatant (one of them) is at zero? */
  probOfZero(checkA: boolean, checkB: boolean): number {
    let prob = 0;
    for (let p = 0; p < NUM_PLANES; p++) {
      if (!this.planeUsed(p)) continue;
      if (checkB) {
        for (let row = 0; row < this.rows; row++) prob += this.val(p, row, 0);
      }
      if (checkA) {
        for (let col = 0; col < this.cols; col++) prob += this.val(p, 0, col);
      }
    }
    return prob;
  }

  rowSum(plane: number, row: number): number {
    if (!this.planeUsed(plane)) return 0;
    let sum = 0;
    for (let col = 0; col < this.cols; col++) sum += this.val(plane, row, col);
    return sum;
  }

  colSum(plane: number, col: number): number {
    if (!this.planeUsed(plane)) return 0;
    let sum = 0;
    for (let row = 0; row < this.rows; row++) sum += this.val(plane, row, col);
    return sum;
  }

  sum(plane: number, rowSums: number[], colSums: number[]): void {
    if (!this.planeUsed(plane)) return;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const prob = this.val(plane, row, col);
        rowSums[row] = (rowSums[row] ?? 0) + prob;
        colSums[col] = (colSums[col] ?? 0) + prob;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CombatMatrix: prob_matrix plus the combat-specific operations layered on
// top (petrify-distortion removal, forced/conditional levelup).
// ---------------------------------------------------------------------------

class CombatMatrix extends ProbMatrix {
  constructor(
    private readonly aMaxHp: number,
    private readonly bMaxHp: number,
    aHp: number,
    bHp: number,
    aSummary: Summary,
    bSummary: Summary,
    private readonly aSlows: boolean,
    private readonly bSlows: boolean,
    private readonly aDamage: number,
    private readonly bDamage: number,
    private readonly aSlowDamage: number,
    private readonly bSlowDamage: number,
    private readonly aDrainPercent: number,
    private readonly bDrainPercent: number,
    private readonly aDrainConstant: number,
    private readonly bDrainConstant: number,
  ) {
    // Note the inversion of the *_slows args, matching upstream's combat_matrix ctor comment.
    super(aMaxHp, bMaxHp, bSlows, aSlows, aHp, bHp, aSummary, bSummary);
  }

  receiveBlowB(hitChance: number): void {
    for (let src = NUM_PLANES - 1; src >= 0; src--) {
      if (!this.planeUsed(src)) continue;
      const dst = this.aSlows ? (src | 2) : src;
      const damage = src & 1 ? this.aSlowDamage : this.aDamage;
      this.shiftCols(dst, src, damage, hitChance, this.aDrainConstant, this.aDrainPercent);
    }
  }

  receiveBlowA(hitChance: number): void {
    for (let src = NUM_PLANES - 1; src >= 0; src--) {
      if (!this.planeUsed(src)) continue;
      const dst = this.bSlows ? (src | 1) : src;
      const damage = src & 2 ? this.bSlowDamage : this.bDamage;
      this.shiftRows(dst, src, damage, hitChance, this.bDrainConstant, this.bDrainPercent);
    }
  }

  deadProb(): number {
    return this.probOfZero(true, true);
  }
  deadProbA(): number {
    return this.probOfZero(true, false);
  }
  deadProbB(): number {
    return this.probOfZero(false, true);
  }

  removePetrifyDistortionA(damage: number, slowDamage: number, bHp: number): void {
    for (let p = 0; p < NUM_PLANES; p++) {
      if (!this.planeUsed(p)) continue;
      const actualDamage = p & 1 ? slowDamage : damage;
      if (bHp > actualDamage) this.moveColumn(p, p, bHp - actualDamage, 0);
    }
  }

  removePetrifyDistortionB(damage: number, slowDamage: number, aHp: number): void {
    for (let p = 0; p < NUM_PLANES; p++) {
      if (!this.planeUsed(p)) continue;
      const actualDamage = p & 2 ? slowDamage : damage;
      if (aHp > actualDamage) this.moveRow(p, p, aHp - actualDamage, 0);
    }
  }

  forcedLevelupA(): void {
    for (let p = 0; p < NUM_PLANES; p++) {
      if (this.planeUsed(p)) this.mergeCols(p & -2, p, this.aMaxHp);
    }
  }
  forcedLevelupB(): void {
    for (let p = 0; p < NUM_PLANES; p++) {
      if (this.planeUsed(p)) this.mergeRows(p & -3, p, this.bMaxHp);
    }
  }
  conditionalLevelupA(): void {
    for (let p = 0; p < NUM_PLANES; p++) {
      if (this.planeUsed(p)) this.mergeCol(p & -2, p, 0, this.aMaxHp);
    }
  }
  conditionalLevelupB(): void {
    for (let p = 0; p < NUM_PLANES; p++) {
      if (this.planeUsed(p)) this.mergeRow(p & -3, p, 0, this.bMaxHp);
    }
  }

  /** Mirrors `extract_results`: sums each plane back down into [normal, slowed] hp distributions. */
  extractResults(summaryA: Summary, summaryB: Summary): void {
    summaryA[0] = new Array(this.numRows()).fill(0);
    summaryB[0] = new Array(this.numCols()).fill(0);
    if (this.planeUsed(A_SLOWED)) summaryA[1] = new Array(this.numRows()).fill(0);
    if (this.planeUsed(B_SLOWED)) summaryB[1] = new Array(this.numCols()).fill(0);

    for (let p = 0; p < NUM_PLANES; p++) {
      if (!this.planeUsed(p)) continue;
      const dstA = p & 1 ? 1 : 0;
      const dstB = p & 2 ? 1 : 0;
      this.sum(p, summaryA[dstA], summaryB[dstB]);
    }
  }
}

// ---------------------------------------------------------------------------
// complexFight / doFight: the general matrix-based resolution of one round's
// worth of interleaved blows (see module doc comment re: skipped fast paths).
// ---------------------------------------------------------------------------

function doFight(
  stats: BattleContextUnitStats,
  oppStats: BattleContextUnitStats,
  strikes: number,
  oppStrikes: number,
  summary: Summary,
  oppSummary: Summary,
  notHit: { self: number; opp: number },
  levelupConsidered: boolean,
): void {
  const rounds = Math.max(stats.rounds, oppStats.rounds);
  const maxAttacks = Math.max(strikes, oppStrikes);

  let aDamage = stats.damage;
  let aSlowDamage = stats.slowDamage;
  let bDamage = oppStats.damage;
  let bSlowDamage = oppStats.slowDamage;

  // Simulate petrify by using a "damage" high enough to kill, then undo the distortion afterwards.
  if (stats.petrifies) {
    aDamage = oppStats.maxHp;
    aSlowDamage = oppStats.maxHp;
  }
  if (oppStats.petrifies) {
    bDamage = stats.maxHp;
    bSlowDamage = stats.maxHp;
  }

  const originalSelfNotHit = notHit.self;
  const originalOppNotHit = notHit.opp;
  const hitChance = stats.chanceToHit / 100;
  const oppHitChance = oppStats.chanceToHit / 100;
  let selfHit = 0;
  let oppHit = 0;
  let selfHitUnknown = 1.0;
  let oppHitUnknown = 1.0;

  const matrix = new CombatMatrix(
    stats.maxHp,
    oppStats.maxHp,
    stats.hp,
    oppStats.hp,
    summary,
    oppSummary,
    stats.slows,
    oppStats.slows,
    aDamage,
    bDamage,
    aSlowDamage,
    bSlowDamage,
    stats.drainPercent,
    oppStats.drainPercent,
    stats.drainConstant,
    oppStats.drainConstant,
  );

  let roundsLeft = rounds;
  do {
    for (let i = 0; i < maxAttacks; i++) {
      if (i < strikes) {
        const bAlreadyDead = matrix.deadProbB();
        matrix.receiveBlowB(hitChance);
        const firstHit = hitChance * oppHitUnknown;
        oppHit += firstHit;
        oppHitUnknown -= firstHit;
        const bothWereAlive = 1.0 - bAlreadyDead - matrix.deadProbA();
        const thisHitKilledB = bothWereAlive !== 0 ? (matrix.deadProbB() - bAlreadyDead) / bothWereAlive : 1.0;
        selfHitUnknown *= 1.0 - thisHitKilledB;
      }
      if (i < oppStrikes) {
        const aAlreadyDead = matrix.deadProbA();
        matrix.receiveBlowA(oppHitChance);
        const firstHit = oppHitChance * selfHitUnknown;
        selfHit += firstHit;
        selfHitUnknown -= firstHit;
        const bothWereAlive = 1.0 - aAlreadyDead - matrix.deadProbB();
        const thisHitKilledA = bothWereAlive !== 0 ? (matrix.deadProbA() - aAlreadyDead) / bothWereAlive : 1.0;
        oppHitUnknown *= 1.0 - thisHitKilledA;
      }
    }
    roundsLeft--;
  } while (roundsLeft > 0 && matrix.deadProb() < 0.99);

  selfHit = Math.min(selfHit, 1.0);
  oppHit = Math.min(oppHit, 1.0);
  notHit.self = originalSelfNotHit * (1.0 - selfHit);
  notHit.opp = originalOppNotHit * (1.0 - oppHit);

  if (stats.slows) {
    const plane = (stats.isSlowed ? 1 : 0) | (oppStats.isSlowed ? 2 : 0);
    const notHitB = matrix.colSum(plane, oppStats.hp) + (plane & 1 ? 0 : matrix.colSum(plane | 1, oppStats.hp));
    notHit.opp = originalOppNotHit * notHitB;
  }
  if (oppStats.slows) {
    const plane = (stats.isSlowed ? 1 : 0) | (oppStats.isSlowed ? 2 : 0);
    const notHitA = matrix.rowSum(plane, stats.hp) + (plane & 2 ? 0 : matrix.rowSum(plane | 2, stats.hp));
    notHit.self = originalSelfNotHit * notHitA;
  }

  if (stats.petrifies) matrix.removePetrifyDistortionA(stats.damage, stats.slowDamage, oppStats.hp);
  if (oppStats.petrifies) matrix.removePetrifyDistortionB(oppStats.damage, oppStats.slowDamage, stats.hp);

  if (levelupConsidered && stats.canAdvance) {
    if (stats.experience + combatXpOf(oppStats.level) >= stats.maxExperience) matrix.forcedLevelupA();
    else if (stats.experience + killXpOf(oppStats.level) >= stats.maxExperience) matrix.conditionalLevelupA();
  }
  if (levelupConsidered && oppStats.canAdvance) {
    if (oppStats.experience + combatXpOf(stats.level) >= oppStats.maxExperience) matrix.forcedLevelupB();
    else if (oppStats.experience + killXpOf(stats.level) >= oppStats.maxExperience) matrix.conditionalLevelupB();
  }

  matrix.extractResults(summary, oppSummary);
}

// Deliberately duplicated here (rather than importing from gameConfig.ts) to
// keep this module's only external coupling being the BattleContextUnitStats
// shape -- attack_prediction.cpp is a genuinely self-contained module
// upstream too (it only depends on game_config's two xp formulas).
function killXpOf(level: number): number {
  return level ? 8 * level : 4;
}
function combatXpOf(level: number): number {
  return 1 * level;
}

function initSliceSummary(src: number[], beginHp: number, endHp: number, prob: number): number[] {
  if (src.length === 0) return [];
  const size = src.length;
  const end = Math.min(endHp, size);
  const result = new Array(size).fill(0);
  for (let i = beginHp; i < end; i++) result[i] = src[i]! / prob;
  return result;
}

function mergeSliceSummary(dst: number[], src: number[], prob: number): number[] {
  const size = src.length;
  const result = dst.length < size ? [...dst, ...new Array(size - dst.length).fill(0)] : dst.slice();
  for (let i = 0; i < size; i++) result[i] = (result[i] ?? 0) + src[i]! * prob;
  return result;
}

/** Mirrors `calculate_probability_of_debuff` (used for both poison and, in spirit, could be reused for other debuffs). */
function calculateProbabilityOfDebuff(
  initialProb: number,
  enemyGives: boolean,
  probTouchedIn: number,
  probStayAliveIn: number,
  killHeals: boolean,
  probKillIn: number,
): number {
  const probTouched = Math.max(probTouchedIn, 0);
  const probStayAlive = Math.max(probStayAliveIn, 0);
  const probKill = clamp(probKillIn, 0, 1);

  const probAlreadyDebuffedNotTouched = initialProb * (1.0 - probTouched);
  const probAlreadyDebuffedTouched = initialProb * probTouched;
  const probInitiallyHealthyTouched = (1.0 - initialProb) * probTouched;

  const probSurviveIfNotHit = 1.0;
  const probSurviveIfHit = probTouched > 0 ? (probStayAlive - (1.0 - probTouched)) / probTouched : 1.0;
  const probKillIfSurvive = probStayAlive > 0 ? probKill / probStayAlive : 0.0;

  let probDebuff = 0;
  probDebuff += killHeals
    ? probAlreadyDebuffedNotTouched * (1.0 - probSurviveIfNotHit * probKillIfSurvive)
    : probAlreadyDebuffedNotTouched;
  probDebuff += killHeals
    ? probAlreadyDebuffedTouched * (1.0 - probSurviveIfHit * probKillIfSurvive)
    : probAlreadyDebuffedTouched;

  if (enemyGives) {
    probDebuff += killHeals ? probInitiallyHealthyTouched * (1.0 - probSurviveIfHit * probKillIfSurvive) : probInitiallyHealthyTouched;
  }
  return probDebuff;
}

function roundProbIfCloseToSure(p: number): number {
  if (p < 1e-9) return 0;
  if (p > 1.0 - 1e-9) return 1;
  return p;
}

/**
 * A single combatant's accumulated state across (possibly several, via
 * repeated `fight()` calls -- e.g. multiple attackers vs. one defender)
 * simulated combats. Mirrors `combatant`.
 */
export class Combatant {
  hpDist: number[];
  untouched = 1.0;
  poisoned: number;
  slowed: number;
  private summary: Summary = [[], []];

  constructor(
    public readonly stats: BattleContextUnitStats,
    prev?: Combatant,
  ) {
    this.hpDist = new Array(stats.maxHp + 1).fill(0);
    if (prev) {
      this.summary = [prev.summary[0].slice(), prev.summary[1].slice()];
      this.hpDist = prev.hpDist.slice();
      this.untouched = prev.untouched;
      this.poisoned = prev.poisoned;
      this.slowed = prev.slowed;
    } else {
      this.hpDist[Math.min(stats.hp, stats.maxHp)] = 1.0;
      this.poisoned = stats.isPoisoned ? 1.0 : 0.0;
      this.slowed = stats.isSlowed ? 1.0 : 0.0;
      if (stats.isSlowed) {
        this.summary[0] = new Array(stats.maxHp + 1).fill(0);
        this.summary[1] = this.hpDist.slice();
      }
    }
  }

  /** Mirrors `combatant::average_hp`. */
  averageHp(healing = 0): number {
    let total = 0;
    for (let i = 1; i < this.hpDist.length; i++) {
      total += this.hpDist[i]! * Math.min(i + healing, this.stats.maxHp);
    }
    return total;
  }

  /**
   * Simulates a fight against `opponent`, mutating both combatants' state.
   * Can be called repeatedly (e.g. once per attacker facing the same
   * defender) for cumulative results, mirroring upstream's usage pattern.
   */
  fight(opponent: Combatant, levelupConsidered = true): void {
    // If defender has firststrike and we don't, reverse (defender's blows go first).
    if (opponent.stats.firststrike && !this.stats.firststrike) {
      opponent.fight(this, levelupConsidered);
      return;
    }

    const notHit = { self: 1.0, opp: 1.0 };

    this.slowed = roundProbIfCloseToSure(this.slowed);
    opponent.slowed = roundProbIfCloseToSure(opponent.slowed);

    const selfAlreadyDead = this.hpDist[0]!;
    const oppAlreadyDead = opponent.hpDist[0]!;

    const split = splitSummary(this.stats, this.summary);
    const oppSplit = splitSummary(opponent.stats, opponent.summary);

    if (split.length === 1 && oppSplit.length === 1) {
      doFight(
        this.stats,
        opponent.stats,
        this.stats.numBlows,
        opponent.stats.numBlows,
        this.summary,
        opponent.summary,
        notHit,
        levelupConsidered,
      );
    } else {
      let summaryResult: Summary = [[], []];
      let oppSummaryResult: Summary = [[], []];
      notHit.self = 0;
      notHit.opp = 0;

      for (const s of split) {
        for (const t of oppSplit) {
          const sitProb = s.prob * t.prob;
          const sitSummary: Summary = [
            initSliceSummary(this.summary[0], s.beginHp, s.endHp, s.prob),
            initSliceSummary(this.summary[1], s.beginHp, s.endHp, s.prob),
          ];
          const sitOppSummary: Summary = [
            initSliceSummary(opponent.summary[0], t.beginHp, t.endHp, t.prob),
            initSliceSummary(opponent.summary[1], t.beginHp, t.endHp, t.prob),
          ];

          const sitNotHit = { self: sitProb, opp: sitProb };
          doFight(this.stats, opponent.stats, s.strikes, t.strikes, sitSummary, sitOppSummary, sitNotHit, levelupConsidered);

          notHit.self += sitNotHit.self;
          notHit.opp += sitNotHit.opp;
          summaryResult = [mergeSliceSummary(summaryResult[0], sitSummary[0], sitProb), mergeSliceSummary(summaryResult[1], sitSummary[1], sitProb)];
          oppSummaryResult = [
            mergeSliceSummary(oppSummaryResult[0], sitOppSummary[0], sitProb),
            mergeSliceSummary(oppSummaryResult[1], sitOppSummary[1], sitProb),
          ];
        }
      }

      this.summary = summaryResult;
      opponent.summary = oppSummaryResult;
    }

    this.hpDist = this.summary[1].length === 0 ? this.summary[0].slice() : this.summary[0].map((v, i) => v + (this.summary[1][i] ?? 0));
    opponent.hpDist =
      opponent.summary[1].length === 0
        ? opponent.summary[0].slice()
        : opponent.summary[0].map((v, i) => v + (opponent.summary[1][i] ?? 0));

    const touched = 1.0 - notHit.self;
    const oppTouched = 1.0 - notHit.opp;

    this.poisoned = calculateProbabilityOfDebuff(
      this.poisoned,
      opponent.stats.poisons,
      touched,
      1.0 - this.hpDist[0]!,
      this.stats.experience + killXpOf(opponent.stats.level) >= this.stats.maxExperience,
      opponent.hpDist[0]! - oppAlreadyDead,
    );
    opponent.poisoned = calculateProbabilityOfDebuff(
      opponent.poisoned,
      this.stats.poisons,
      oppTouched,
      1.0 - opponent.hpDist[0]!,
      opponent.stats.experience + killXpOf(this.stats.level) >= opponent.stats.maxExperience,
      this.hpDist[0]! - selfAlreadyDead,
    );

    this.slowed = Math.min(this.summary[1].reduce((a, b) => a + b, 0), 1.0);
    opponent.slowed = Math.min(opponent.summary[1].reduce((a, b) => a + b, 0), 1.0);

    if (this.stats.canAdvance && this.stats.experience + combatXpOf(opponent.stats.level) >= this.stats.maxExperience) {
      this.poisoned = 0;
      this.slowed = 0;
    }
    if (opponent.stats.canAdvance && opponent.stats.experience + combatXpOf(this.stats.level) >= opponent.stats.maxExperience) {
      opponent.poisoned = 0;
      opponent.slowed = 0;
    }

    this.untouched *= notHit.self;
    opponent.untouched *= notHit.opp;
  }
}

/**
 * Convenience wrapper mirroring the common `battle_context::simulate` usage:
 * builds two fresh `Combatant`s and fights them once. For repeated combat
 * against the same defender (multiple attackers), construct `Combatant`s
 * directly and pass `prev` to chain them, as upstream's `prev_def` does.
 */
export function simulateCombat(
  attacker: BattleContextUnitStats,
  defender: BattleContextUnitStats,
  levelupConsidered = true,
): { attacker: Combatant; defender: Combatant } {
  const a = new Combatant(attacker);
  const d = new Combatant(defender);
  a.fight(d, levelupConsidered);
  return { attacker: a, defender: d };
}
