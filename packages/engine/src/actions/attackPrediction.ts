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
 * ## As upstream (Phase 29)
 *
 * The matrix tracks which rows and columns hold probability, so a blow only
 * touches those; `do_fight` takes the closed-form paths for "at most one
 * strike each" and "nobody can die this exchange"; and a fight whose
 * `fight_complexity` exceeds 50000 is simulated 5000 times (Monte Carlo)
 * instead, drawing from the prediction generator (`setPredictionRandom`,
 * upstream's `rng::default_instance()` -- never the game's synced RNG). The
 * AI evaluates a great many hypothetical fights; without these it was most
 * of an AI turn.
 */

import { RngDeterministic } from '../rng/RngDeterministic.js';
import { MtRng } from '../rng/MtRng.js';

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
// ProbMatrix: the 4-plane probability grid, with upstream's bookkeeping of
// which rows and columns of each plane hold probability (`used_rows_`/
// `used_cols_`), so each blow touches only those -- the AI evaluates a great
// many hypothetical fights.
// ---------------------------------------------------------------------------

const NEITHER_SLOWED = 0;
const A_SLOWED = 1;
const B_SLOWED = 2;
const BOTH_SLOWED = 3;
const NUM_PLANES = 4;

class ProbMatrix {
  private readonly planes: (Float64Array | null)[] = [null, null, null, null];
  protected readonly rows: number;
  protected readonly cols: number;
  /** `used_rows_`/`used_cols_` as flags: a set bit is a row/column that is (or was) nonzero in that plane. Row/column 0 always is. */
  private readonly usedRows: Uint8Array[];
  private readonly usedCols: Uint8Array[];

  /**
   * `aMax`/`bMax` are max-HP values, NOT row/column counts -- mirrors
   * `prob_matrix::prob_matrix`'s `rows_(a_max + 1), cols_(b_max + 1)`.
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
    const aCur = Math.min(aCurIn, this.rows - 1);
    const bCur = Math.min(bCurIn, this.cols - 1);
    this.usedRows = Array.from({ length: NUM_PLANES }, () => new Uint8Array(this.rows));
    this.usedCols = Array.from({ length: NUM_PLANES }, () => new Uint8Array(this.cols));
    for (let p = 0; p < NUM_PLANES; p++) {
      this.usedRows[p]![0] = 1;
      this.usedCols[p]![0] = 1;
    }
    const needASlowed = needASlowedIn || aInitial[1].length > 0;
    const needBSlowed = needBSlowedIn || bInitial[1].length > 0;

    this.planes[NEITHER_SLOWED] = this.newPlane();
    this.planes[A_SLOWED] = needASlowed ? this.newPlane() : null;
    this.planes[B_SLOWED] = needBSlowed ? this.newPlane() : null;
    this.planes[BOTH_SLOWED] = needASlowed && needBSlowed ? this.newPlane() : null;

    this.initializePlane(NEITHER_SLOWED, aCur, bCur, aInitial[0], bInitial[0]);
    if (aInitial[1].length > 0) this.initializePlane(A_SLOWED, aCur, bCur, aInitial[1], bInitial[0]);
    if (bInitial[1].length > 0) this.initializePlane(B_SLOWED, aCur, bCur, aInitial[0], bInitial[1]);
    if (aInitial[1].length > 0 && bInitial[1].length > 0) this.initializePlane(BOTH_SLOWED, aCur, bCur, aInitial[1], bInitial[1]);
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

  /** The used rows of plane `p`, ascending (a snapshot, like upstream's cached vector). */
  protected usedRowList(p: number): number[] {
    const flags = this.usedRows[p]!;
    const out: number[] = [];
    for (let i = 0; i < flags.length; i++) if (flags[i]) out.push(i);
    return out;
  }
  protected usedColList(p: number): number[] {
    const flags = this.usedCols[p]!;
    const out: number[] = [];
    for (let i = 0; i < flags.length; i++) if (flags[i]) out.push(i);
    return out;
  }

  protected val(p: number, r: number, c: number): number {
    return this.planes[p]![r * this.cols + c]!;
  }

  private initializePlane(plane: number, aCur: number, bCur: number, aInitial: number[], bInitial: number[]): void {
    if (aInitial.length > 0) {
      const rowCount = Math.min(aInitial.length, this.rows);
      for (let row = 0; row < rowCount; row++) {
        if (aInitial[row] !== 0) {
          this.usedRows[plane]![row] = 1;
          this.initializeRow(plane, row, aInitial[row]!, bCur, bInitial);
        }
      }
    } else {
      this.usedRows[plane]![aCur] = 1;
      this.initializeRow(plane, aCur, 1.0, bCur, bInitial);
    }
  }

  private initializeRow(plane: number, row: number, rowProb: number, bCur: number, bInitial: number[]): void {
    const values = this.planes[plane]!;
    if (bInitial.length > 0) {
      const colCount = Math.min(bInitial.length, this.cols);
      for (let col = 0; col < colCount; col++) {
        if (bInitial[col] !== 0) {
          this.usedCols[plane]![col] = 1;
          values[row * this.cols + col] = rowProb * bInitial[col]!;
        }
      }
    } else {
      this.usedCols[plane]![bCur] = 1;
      values[row * this.cols + bCur] = rowProb;
    }
  }

  /** Mirrors the probability-weighted `xfer` overload. */
  private xferProb(dstPlane: number, srcPlane: number, rowDst: number, colDst: number, rowSrc: number, colSrc: number, prob: number): void {
    const src = this.planes[srcPlane]!;
    const srcIdx = rowSrc * this.cols + colSrc;
    const v = src[srcIdx]!;
    if (v !== 0.0) {
      const diff = v * prob;
      src[srcIdx] = v - diff;
      const dst = this.planes[dstPlane]!;
      const dstIdx = rowDst * this.cols + colDst;
      if (dst[dstIdx] === 0.0) {
        this.usedRows[dstPlane]![rowDst] = 1;
        this.usedCols[dstPlane]![colDst] = 1;
      }
      dst[dstIdx] = dst[dstIdx]! + diff;
    }
  }

  /** Mirrors the all-or-nothing `xfer` overload. */
  private xferAll(dstPlane: number, srcPlane: number, rowDst: number, colDst: number, rowSrc: number, colSrc: number): void {
    if (dstPlane === srcPlane && rowDst === rowSrc && colDst === colSrc) return;
    const src = this.planes[srcPlane]!;
    const srcIdx = rowSrc * this.cols + colSrc;
    const v = src[srcIdx]!;
    if (v !== 0.0) {
      const dst = this.planes[dstPlane]!;
      const dstIdx = rowDst * this.cols + colDst;
      if (dst[dstIdx] === 0.0) {
        this.usedRows[dstPlane]![rowDst] = 1;
        this.usedCols[dstPlane]![colDst] = 1;
      }
      dst[dstIdx] = dst[dstIdx]! + v;
      src[srcIdx] = 0;
    }
  }

  private shiftColsInRow(dst: number, src: number, row: number, cols: readonly number[], damage: number, prob: number, drainmax: number, drainConstant: number, drainPercent: number): void {
    const maxRow = this.rows - 1;
    let x = 1;
    for (; x < cols.length && cols[x]! < damage; x++) {
      const drainAmount = Math.trunc((cols[x]! * drainPercent) / 100) + drainConstant;
      this.xferProb(dst, src, clamp(row + drainAmount, 1, maxRow), 0, row, cols[x]!, prob);
    }
    const newRow = clamp(row + drainmax, 1, maxRow);
    for (; x < cols.length; x++) this.xferProb(dst, src, newRow, cols[x]! - damage, row, cols[x]!, prob);
  }

  /** Mirrors `prob_matrix::shift_cols`: B (columns) takes damage. */
  shiftCols(dst: number, src: number, damage: number, prob: number, drainConstant: number, drainPercent: number): void {
    if (!this.planeUsed(src)) return;
    const drainmax = Math.trunc((drainPercent * damage) / 100) + drainConstant;
    const rows = this.usedRowList(src);
    const cols = this.usedColList(src);
    if (drainmax > 0) {
      for (let x = rows.length - 1; x !== 0; x--) this.shiftColsInRow(dst, src, rows[x]!, cols, damage, prob, drainmax, drainConstant, drainPercent);
    } else {
      for (let x = 1; x !== rows.length; x++) this.shiftColsInRow(dst, src, rows[x]!, cols, damage, prob, drainmax, drainConstant, drainPercent);
    }
  }

  private shiftRowsInCol(dst: number, src: number, col: number, rows: readonly number[], damage: number, prob: number, drainmax: number, drainConstant: number, drainPercent: number): void {
    const maxCol = this.cols - 1;
    let x = 1;
    for (; x < rows.length && rows[x]! < damage; x++) {
      const drainAmount = Math.trunc((rows[x]! * drainPercent) / 100) + drainConstant;
      this.xferProb(dst, src, 0, clamp(col + drainAmount, 1, maxCol), rows[x]!, col, prob);
    }
    const newCol = clamp(col + drainmax, 1, maxCol);
    for (; x < rows.length; x++) this.xferProb(dst, src, rows[x]! - damage, newCol, rows[x]!, col, prob);
  }

  /** Mirrors `prob_matrix::shift_rows`: A (rows) takes damage. */
  shiftRows(dst: number, src: number, damage: number, prob: number, drainConstant: number, drainPercent: number): void {
    if (!this.planeUsed(src)) return;
    const drainmax = Math.trunc((drainPercent * damage) / 100) + drainConstant;
    const rows = this.usedRowList(src);
    const cols = this.usedColList(src);
    if (drainmax > 0) {
      for (let x = cols.length - 1; x !== 0; x--) this.shiftRowsInCol(dst, src, cols[x]!, rows, damage, prob, drainmax, drainConstant, drainPercent);
    } else {
      for (let x = 1; x !== cols.length; x++) this.shiftRowsInCol(dst, src, cols[x]!, rows, damage, prob, drainmax, drainConstant, drainPercent);
    }
  }

  moveColumn(dPlane: number, sPlane: number, dCol: number, sCol: number): void {
    for (const row of this.usedRowList(sPlane)) this.xferAll(dPlane, sPlane, row, dCol, row, sCol);
  }

  moveRow(dPlane: number, sPlane: number, dRow: number, sRow: number): void {
    for (const col of this.usedColList(sPlane)) this.xferAll(dPlane, sPlane, dRow, col, sRow, col);
  }

  /** Excludes row 0 (the dead state). */
  mergeCol(dPlane: number, sPlane: number, col: number, dRow: number): void {
    for (const row of this.usedRowList(sPlane).slice(1)) this.xferAll(dPlane, sPlane, dRow, col, row, col);
  }

  mergeCols(dPlane: number, sPlane: number, dRow: number): void {
    const cols = this.usedColList(sPlane);
    for (const row of this.usedRowList(sPlane).slice(1)) {
      for (const col of cols) this.xferAll(dPlane, sPlane, dRow, col, row, col);
    }
  }

  /** Excludes column 0. */
  mergeRow(dPlane: number, sPlane: number, row: number, dCol: number): void {
    for (const col of this.usedColList(sPlane).slice(1)) this.xferAll(dPlane, sPlane, row, dCol, row, col);
  }

  mergeRows(dPlane: number, sPlane: number, dCol: number): void {
    const cols = this.usedColList(sPlane).slice(1);
    for (const row of this.usedRowList(sPlane)) {
      for (const col of cols) this.xferAll(dPlane, sPlane, row, dCol, row, col);
    }
  }

  /** `prob_matrix::clear`: every value zero, only row/column 0 used. */
  clear(): void {
    for (let p = 0; p < NUM_PLANES; p++) {
      if (!this.planeUsed(p)) continue;
      this.planes[p]!.fill(0);
      this.usedRows[p]!.fill(0);
      this.usedCols[p]!.fill(0);
      this.usedRows[p]![0] = 1;
      this.usedCols[p]![0] = 1;
    }
  }

  /** `prob_matrix::record_monte_carlo_result`. */
  recordMonteCarloResult(aHp: number, bHp: number, aSlowed: boolean, bSlowed: boolean): void {
    const plane = (aSlowed ? 1 : 0) | (bSlowed ? 2 : 0);
    const values = this.planes[plane]!;
    values[aHp * this.cols + bHp] = values[aHp * this.cols + bHp]! + 1;
    this.usedRows[plane]![aHp] = 1;
    this.usedCols[plane]![bHp] = 1;
  }

  /** What is the chance that an indicated combatant (one of them) is at zero? */
  probOfZero(checkA: boolean, checkB: boolean): number {
    let prob = 0;
    for (let p = 0; p < NUM_PLANES; p++) {
      if (!this.planeUsed(p)) continue;
      if (checkB) for (const row of this.usedRowList(p)) prob += this.val(p, row, 0);
      if (checkA) for (const col of this.usedColList(p)) prob += this.val(p, 0, col);
    }
    return prob;
  }

  rowSum(plane: number, row: number): number {
    if (!this.planeUsed(plane)) return 0;
    let sum = 0;
    for (const col of this.usedColList(plane)) sum += this.val(plane, row, col);
    return sum;
  }

  colSum(plane: number, col: number): number {
    if (!this.planeUsed(plane)) return 0;
    let sum = 0;
    for (const row of this.usedRowList(plane)) sum += this.val(plane, row, col);
    return sum;
  }

  sum(plane: number, rowSums: number[], colSums: number[]): void {
    const cols = this.usedColList(plane);
    for (const row of this.usedRowList(plane)) {
      for (const col of cols) {
        const prob = this.val(plane, row, col);
        rowSums[row] = rowSums[row]! + prob;
        colSums[col] = colSums[col]! + prob;
      }
    }
  }
}

/** `combat_matrix`: a `prob_matrix` that knows how blows move probability. */
class CombatMatrix extends ProbMatrix {
  constructor(
    protected readonly aMaxHp: number,
    protected readonly bMaxHp: number,
    aHp: number,
    bHp: number,
    aSummary: Summary,
    bSummary: Summary,
    protected readonly aSlows: boolean,
    protected readonly bSlows: boolean,
    protected readonly aDamage: number,
    protected readonly bDamage: number,
    protected readonly aSlowDamage: number,
    protected readonly bSlowDamage: number,
    protected readonly aDrainPercent: number,
    protected readonly bDrainPercent: number,
    protected readonly aDrainConstant: number,
    protected readonly bDrainConstant: number,
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
      this.sum(p, summaryA[p & 1 ? 1 : 0], summaryB[p & 2 ? 1 : 0]);
    }
  }
}

/** Where the Monte Carlo simulation draws (`randomness::rng::default_instance()`: never the game's synced RNG). */
export interface PredictionRandom {
  getRandomBool(probability: number): boolean;
  getRandomElement(weights: readonly number[]): number;
}

let predictionRandom: PredictionRandom | null = null;

/** Sets the generator combat prediction's Monte Carlo simulation uses (a session gives its unsynced stream). */
export function setPredictionRandom(rng: PredictionRandom | null): void {
  predictionRandom = rng;
}

let monteCarloAllowed = true;

/**
 * The player's "Allow damage calculation with Monte Carlo simulation" preference
 * (`damage_prediction_allow_monte_carlo_simulation`, on): off, even a very complex fight is calculated exactly.
 */
export function setMonteCarloAllowed(on: boolean): void {
  monteCarloAllowed = on;
}

function predictionRng(): PredictionRandom {
  predictionRandom ??= new RngDeterministic(new MtRng(0));
  return predictionRandom;
}

/** `monte_carlo_combat_matrix`: 5000 simulated fights instead of exact probabilities, for very complex fights. */
class MonteCarloCombatMatrix extends CombatMatrix {
  private static readonly NUM_ITERATIONS = 5000;
  private readonly aInitial: number[] = [];
  private readonly bInitial: number[] = [];
  private readonly aInitialSlowed: number[] = [];
  private readonly bInitialSlowed: number[] = [];
  private iterationsAHit = 0;
  private iterationsBHit = 0;

  constructor(
    aMaxHp: number,
    bMaxHp: number,
    aHp: number,
    bHp: number,
    aSummary: Summary,
    bSummary: Summary,
    aSlows: boolean,
    bSlows: boolean,
    aDamage: number,
    bDamage: number,
    aSlowDamage: number,
    bSlowDamage: number,
    aDrainPercent: number,
    bDrainPercent: number,
    aDrainConstant: number,
    bDrainConstant: number,
    private readonly rounds: number,
    private readonly aHitChance: number,
    private readonly bHitChance: number,
    private readonly aSplit: readonly CombatSlice[],
    private readonly bSplit: readonly CombatSlice[],
    private readonly aInitiallySlowedChance: number,
    private readonly bInitiallySlowedChance: number,
  ) {
    super(aMaxHp, bMaxHp, aHp, bHp, aSummary, bSummary, aSlows, bSlows, aDamage, bDamage, aSlowDamage, bSlowDamage, aDrainPercent, bDrainPercent, aDrainConstant, bDrainConstant);
    scaleProbabilities(aSummary[0], this.aInitial, 1.0 - aInitiallySlowedChance, aHp);
    scaleProbabilities(aSummary[1], this.aInitialSlowed, aInitiallySlowedChance, aHp);
    scaleProbabilities(bSummary[0], this.bInitial, 1.0 - bInitiallySlowedChance, bHp);
    scaleProbabilities(bSummary[1], this.bInitialSlowed, bInitiallySlowedChance, bHp);
    this.clear();
  }

  simulate(): void {
    const rng = predictionRng();
    for (let i = 0; i < MonteCarloCombatMatrix.NUM_ITERATIONS; i++) {
      let aHit = false;
      let bHit = false;
      let aSlowed = rng.getRandomBool(this.aInitiallySlowedChance);
      let bSlowed = rng.getRandomBool(this.bInitiallySlowedChance);
      let aHp = rng.getRandomElement(aSlowed ? this.aInitialSlowed : this.aInitial);
      let bHp = rng.getRandomElement(bSlowed ? this.bInitialSlowed : this.bInitial);
      const aStrikes = calcBlowsFromSplit(this.aSplit, aHp);
      const bStrikes = calcBlowsFromSplit(this.bSplit, bHp);
      for (let j = 0; j < this.rounds && aHp > 0 && bHp > 0; j++) {
        for (let k = 0; k < Math.max(aStrikes, bStrikes); k++) {
          if (k < aStrikes && rng.getRandomBool(this.aHitChance)) {
            const damage = Math.min(aSlowed ? this.aSlowDamage : this.aDamage, bHp);
            bHit = true;
            bSlowed ||= this.aSlows;
            const drainAmount = Math.trunc((this.aDrainPercent * damage) / 100) + this.aDrainConstant;
            aHp = clamp(aHp + drainAmount, 1, this.aMaxHp);
            bHp -= damage;
            if (bHp === 0) break;
          }
          if (k < bStrikes && rng.getRandomBool(this.bHitChance)) {
            const damage = Math.min(bSlowed ? this.bSlowDamage : this.bDamage, aHp);
            aHit = true;
            aSlowed ||= this.bSlows;
            const drainAmount = Math.trunc((this.bDrainPercent * damage) / 100) + this.bDrainConstant;
            bHp = clamp(bHp + drainAmount, 1, this.bMaxHp);
            aHp -= damage;
            if (aHp === 0) break;
          }
        }
      }
      if (aHit) this.iterationsAHit++;
      if (bHit) this.iterationsBHit++;
      this.recordMonteCarloResult(aHp, bHp, aSlowed, bSlowed);
    }
  }

  override extractResults(summaryA: Summary, summaryB: Summary): void {
    super.extractResults(summaryA, summaryB);
    const n = MonteCarloCombatMatrix.NUM_ITERATIONS;
    const divide = (v: number[]) => {
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
    };
    divide(summaryA[0]);
    divide(summaryB[0]);
    if (this.planeUsed(A_SLOWED)) divide(summaryA[1]);
    if (this.planeUsed(B_SLOWED)) divide(summaryB[1]);
  }

  aHitProbability(): number {
    return this.iterationsAHit / MonteCarloCombatMatrix.NUM_ITERATIONS;
  }
  bHitProbability(): number {
    return this.iterationsBHit / MonteCarloCombatMatrix.NUM_ITERATIONS;
  }
}

/** `monte_carlo_combat_matrix::calc_blows_a/b`: the strikes of the slice `hp` falls in (the last one past the end). */
function calcBlowsFromSplit(split: readonly CombatSlice[], hp: number): number {
  let i = 0;
  while (i < split.length && split[i]!.endHp <= hp) i++;
  if (i === split.length) i--;
  return split[i]!.strikes;
}

/** `monte_carlo_combat_matrix::scale_probabilities`. */
function scaleProbabilities(source: readonly number[], target: number[], divisor: number, singularHp: number): void {
  if (divisor === 0.0) return;
  if (source.length === 0) {
    for (let i = 0; i <= singularHp; i++) target.push(0);
    target[singularHp] = 1.0;
  } else {
    for (const prob of source) target.push(prob / divisor);
  }
}

// ---------------------------------------------------------------------------
// do_fight: the fast paths for simple fights, else complex_fight.
// ---------------------------------------------------------------------------

type NotHit = { self: number; opp: number };
const MONTE_CARLO_SIMULATION_THRESHOLD = 50000;

function forcedLevelup(hpDist: number[]): void {
  for (let i = 1; i < hpDist.length; i++) hpDist[i] = 0;
  hpDist[hpDist.length - 1] = 1 - hpDist[0]!;
}

function conditionalLevelup(hpDist: number[], killProb: number): void {
  let scalefactor = 0;
  const chanceToSurvive = 1 - hpDist[0]!;
  if (chanceToSurvive > 2.2250738585072014e-308 /* DBL_MIN */) scalefactor = 1 - killProb / chanceToSurvive;
  for (let i = 1; i < hpDist.length; i++) hpDist[i] = hpDist[i]! * scalefactor;
  hpDist[hpDist.length - 1] = hpDist[hpDist.length - 1]! + killProb;
}

/** `min_hp`: the lowest hp with any probability, or `def`. */
function minHp(hpDist: readonly number[], def: number): number {
  for (let i = 0; i < hpDist.length; i++) if (hpDist[i] !== 0.0) return i;
  return def;
}

/** `fight_complexity`. */
function fightComplexity(numSlices: number, oppNumSlices: number, stats: BattleContextUnitStats, oppStats: BattleContextUnitStats): number {
  return numSlices * oppNumSlices * (stats.slows || oppStats.isSlowed ? 2 : 1) * (oppStats.slows || stats.isSlowed ? 2 : 1) * stats.maxHp * oppStats.maxHp;
}

/** `no_death_fight`: neither side can die this exchange. */
function noDeathFight(stats: BattleContextUnitStats, oppStats: BattleContextUnitStats, strikes: number, oppStrikes: number, summary: Summary, oppSummary: Summary, notHit: NotHit, levelupConsidered: boolean): void {
  const aliveProb = summary[0].length === 0 ? 1.0 : 1.0 - summary[0][0]!;
  const hitChance = (stats.chanceToHit / 100.0) * aliveProb;
  if (oppSummary[0].length === 0) {
    const dist = new Array(oppStats.maxHp + 1).fill(0);
    dist[oppStats.hp] = 1.0;
    for (let i = 0; i < strikes; i++) {
      for (let j = i; j >= 0; j--) {
        const srcIndex = oppStats.hp - j * stats.damage;
        const move = dist[srcIndex] * hitChance;
        dist[srcIndex] -= move;
        dist[srcIndex - stats.damage] += move;
      }
      notHit.opp *= 1.0 - hitChance;
    }
    oppSummary[0] = dist;
  } else {
    const dist = oppSummary[0];
    for (let i = 0; i < strikes; i++) {
      for (let j = stats.damage; j < dist.length; j++) {
        const move = dist[j]! * hitChance;
        dist[j] = dist[j]! - move;
        dist[j - stats.damage] = dist[j - stats.damage]! + move;
      }
      notHit.opp *= 1.0 - hitChance;
    }
  }
  const oppAliveProb = oppSummary[0].length === 0 ? 1.0 : 1.0 - oppSummary[0][0]!;
  const oppHitChance = (oppStats.chanceToHit / 100.0) * oppAliveProb;
  if (summary[0].length === 0) {
    const dist = new Array(stats.maxHp + 1).fill(0);
    dist[stats.hp] = 1.0;
    for (let i = 0; i < oppStrikes; i++) {
      for (let j = i; j >= 0; j--) {
        const srcIndex = stats.hp - j * oppStats.damage;
        const move = dist[srcIndex] * oppHitChance;
        dist[srcIndex] -= move;
        dist[srcIndex - oppStats.damage] += move;
      }
      notHit.self *= 1.0 - oppHitChance;
    }
    summary[0] = dist;
  } else {
    const dist = summary[0];
    for (let i = 0; i < oppStrikes; i++) {
      for (let j = oppStats.damage; j < dist.length; j++) {
        const move = dist[j]! * oppHitChance;
        dist[j] = dist[j]! - move;
        dist[j - oppStats.damage] = dist[j - oppStats.damage]! + move;
      }
      notHit.self *= 1.0 - oppHitChance;
    }
  }
  if (!levelupConsidered || !stats.canAdvance) return;
  if (stats.experience + oppStats.level >= stats.maxExperience) forcedLevelup(summary[0]);
  if (oppStats.experience + stats.level >= oppStats.maxExperience) forcedLevelup(oppSummary[0]);
}

/** `one_strike_fight`: at most one strike each. */
function oneStrikeFight(stats: BattleContextUnitStats, oppStats: BattleContextUnitStats, strikes: number, oppStrikes: number, summary: Summary, oppSummary: Summary, notHit: NotHit, levelupConsidered: boolean): void {
  let aliveProb = summary[0].length === 0 ? 1.0 : 1.0 - summary[0][0]!;
  if (stats.hp === 0) aliveProb = 0.0;
  const hitChance = (stats.chanceToHit / 100.0) * aliveProb;
  if (oppSummary[0].length === 0) {
    const dist = new Array(oppStats.maxHp + 1).fill(0);
    if (strikes === 1 && oppStats.hp > 0) {
      dist[oppStats.hp] = 1.0 - hitChance;
      dist[Math.max(oppStats.hp - stats.damage, 0)] = hitChance;
      notHit.opp *= 1.0 - hitChance;
    } else dist[oppStats.hp] = 1.0;
    oppSummary[0] = dist;
  } else if (strikes === 1) {
    const dist = oppSummary[0];
    for (let i = 1; i < dist.length; i++) {
      const move = dist[i]! * hitChance;
      dist[i] = dist[i]! - move;
      const to = Math.max(i - stats.damage, 0);
      dist[to] = dist[to]! + move;
    }
    notHit.opp *= 1.0 - hitChance;
  }
  const oppAttackProb = (1.0 - oppSummary[0][0]!) * aliveProb;
  const oppHitChance = (oppStats.chanceToHit / 100.0) * oppAttackProb;
  if (summary[0].length === 0) {
    const dist = new Array(stats.maxHp + 1).fill(0);
    if (oppStrikes === 1 && stats.hp > 0) {
      dist[stats.hp] = 1.0 - oppHitChance;
      dist[Math.max(stats.hp - oppStats.damage, 0)] = oppHitChance;
      notHit.self *= 1.0 - oppHitChance;
    } else dist[stats.hp] = 1.0;
    summary[0] = dist;
  } else if (oppStrikes === 1) {
    const dist = summary[0];
    for (let i = 1; i < dist.length; i++) {
      const move = dist[i]! * oppHitChance;
      dist[i] = dist[i]! - move;
      const to = Math.max(i - oppStats.damage, 0);
      dist[to] = dist[to]! + move;
    }
    notHit.self *= 1.0 - oppHitChance;
  }
  if (!levelupConsidered || !stats.canAdvance) return;
  if (stats.experience + combatXpOf(oppStats.level) >= stats.maxExperience) forcedLevelup(summary[0]);
  else if (stats.experience + killXpOf(oppStats.level) >= stats.maxExperience) conditionalLevelup(summary[0], oppSummary[0][0]!);
  if (oppStats.experience + combatXpOf(stats.level) >= oppStats.maxExperience) forcedLevelup(oppSummary[0]);
  else if (oppStats.experience + killXpOf(stats.level) >= oppStats.maxExperience) conditionalLevelup(oppSummary[0], summary[0][0]!);
}

/** `complex_fight`: the full matrix calculation, or (`monteCarlo`) the simulation. */
function complexFight(
  monteCarlo: boolean,
  stats: BattleContextUnitStats,
  oppStats: BattleContextUnitStats,
  strikes: number,
  oppStrikes: number,
  summary: Summary,
  oppSummary: Summary,
  notHit: NotHit,
  levelupConsidered: boolean,
  split: readonly CombatSlice[],
  oppSplit: readonly CombatSlice[],
  initiallySlowedChance: number,
  oppInitiallySlowedChance: number,
): void {
  let rounds = Math.max(stats.rounds, oppStats.rounds);
  const maxAttacks = Math.max(strikes, oppStrikes);
  let aDamage = stats.damage;
  let aSlowDamage = stats.slowDamage;
  let bDamage = oppStats.damage;
  let bSlowDamage = oppStats.slowDamage;
  // Simulate petrify by using a "damage" high enough to kill, then undo the distortion afterwards.
  if (stats.petrifies) aDamage = aSlowDamage = oppStats.maxHp;
  if (oppStats.petrifies) bDamage = bSlowDamage = stats.maxHp;

  const originalSelfNotHit = notHit.self;
  const originalOppNotHit = notHit.opp;
  const hitChance = stats.chanceToHit / 100;
  const oppHitChance = oppStats.chanceToHit / 100;
  let selfHit = 0;
  let oppHit = 0;
  let selfHitUnknown = 1.0;
  let oppHitUnknown = 1.0;

  let matrix: CombatMatrix;
  if (!monteCarlo) {
    const pm = new CombatMatrix(stats.maxHp, oppStats.maxHp, stats.hp, oppStats.hp, summary, oppSummary, stats.slows, oppStats.slows, aDamage, bDamage, aSlowDamage, bSlowDamage, stats.drainPercent, oppStats.drainPercent, stats.drainConstant, oppStats.drainConstant);
    do {
      for (let i = 0; i < maxAttacks; i++) {
        if (i < strikes) {
          const bAlreadyDead = pm.deadProbB();
          pm.receiveBlowB(hitChance);
          const firstHit = hitChance * oppHitUnknown;
          oppHit += firstHit;
          oppHitUnknown -= firstHit;
          const bothWereAlive = 1.0 - bAlreadyDead - pm.deadProbA();
          const thisHitKilledB = bothWereAlive !== 0 ? (pm.deadProbB() - bAlreadyDead) / bothWereAlive : 1.0;
          selfHitUnknown *= 1.0 - thisHitKilledB;
        }
        if (i < oppStrikes) {
          const aAlreadyDead = pm.deadProbA();
          pm.receiveBlowA(oppHitChance);
          const firstHit = oppHitChance * selfHitUnknown;
          selfHit += firstHit;
          selfHitUnknown -= firstHit;
          const bothWereAlive = 1.0 - aAlreadyDead - pm.deadProbB();
          const thisHitKilledA = bothWereAlive !== 0 ? (pm.deadProbA() - aAlreadyDead) / bothWereAlive : 1.0;
          oppHitUnknown *= 1.0 - thisHitKilledA;
        }
      }
    } while (--rounds > 0 && pm.deadProb() < 0.99);

    selfHit = Math.min(selfHit, 1.0);
    oppHit = Math.min(oppHit, 1.0);
    notHit.self = originalSelfNotHit * (1.0 - selfHit);
    notHit.opp = originalOppNotHit * (1.0 - oppHit);
    if (stats.slows) {
      const plane = (stats.isSlowed ? 1 : 0) | (oppStats.isSlowed ? 2 : 0);
      notHit.opp = originalOppNotHit * (pm.colSum(plane, oppStats.hp) + (plane & 1 ? 0 : pm.colSum(plane | 1, oppStats.hp)));
    }
    if (oppStats.slows) {
      const plane = (stats.isSlowed ? 1 : 0) | (oppStats.isSlowed ? 2 : 0);
      notHit.self = originalSelfNotHit * (pm.rowSum(plane, stats.hp) + (plane & 2 ? 0 : pm.rowSum(plane | 2, stats.hp)));
    }
    matrix = pm;
  } else {
    const mcm = new MonteCarloCombatMatrix(stats.maxHp, oppStats.maxHp, stats.hp, oppStats.hp, summary, oppSummary, stats.slows, oppStats.slows, aDamage, bDamage, aSlowDamage, bSlowDamage, stats.drainPercent, oppStats.drainPercent, stats.drainConstant, oppStats.drainConstant, rounds, hitChance, oppHitChance, split, oppSplit, initiallySlowedChance, oppInitiallySlowedChance);
    mcm.simulate();
    notHit.self = 1.0 - mcm.aHitProbability();
    notHit.opp = 1.0 - mcm.bHitProbability();
    matrix = mcm;
  }

  if (stats.petrifies) matrix.removePetrifyDistortionA(stats.damage, stats.slowDamage, oppStats.hp);
  if (oppStats.petrifies) matrix.removePetrifyDistortionB(oppStats.damage, oppStats.slowDamage, stats.hp);

  // As upstream, both sides' level-ups are considered only when this side can advance.
  if (levelupConsidered && stats.canAdvance) {
    if (stats.experience + combatXpOf(oppStats.level) >= stats.maxExperience) matrix.forcedLevelupA();
    else if (stats.experience + killXpOf(oppStats.level) >= stats.maxExperience) matrix.conditionalLevelupA();
    if (oppStats.experience + combatXpOf(stats.level) >= oppStats.maxExperience) matrix.forcedLevelupB();
    else if (oppStats.experience + killXpOf(stats.level) >= oppStats.maxExperience) matrix.conditionalLevelupB();
  }

  matrix.extractResults(summary, oppSummary);
}

/** `do_fight`: the fast paths when they apply (no slow, drain, petrify, berserk or earlier slowed results). */
function doFight(
  stats: BattleContextUnitStats,
  oppStats: BattleContextUnitStats,
  strikes: number,
  oppStrikes: number,
  summary: Summary,
  oppSummary: Summary,
  notHit: NotHit,
  levelupConsidered: boolean,
): void {
  if (
    !stats.slows && !oppStats.slows && !stats.drains && !oppStats.drains && !stats.petrifies && !oppStats.petrifies &&
    stats.rounds === 1 && oppStats.rounds === 1 && summary[1].length === 0 && oppSummary[1].length === 0
  ) {
    if (strikes <= 1 && oppStrikes <= 1) {
      oneStrikeFight(stats, oppStats, strikes, oppStrikes, summary, oppSummary, notHit, levelupConsidered);
      return;
    }
    if (strikes * stats.damage < minHp(oppSummary[0], oppStats.hp) && oppStrikes * oppStats.damage < minHp(summary[0], stats.hp)) {
      noDeathFight(stats, oppStats, strikes, oppStrikes, summary, oppSummary, notHit, levelupConsidered);
      return;
    }
  }
  complexFight(false, stats, oppStats, strikes, oppStrikes, summary, oppSummary, notHit, levelupConsidered, [], [], 0, 0);
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

    if (fightComplexity(split.length, oppSplit.length, this.stats, opponent.stats) > MONTE_CARLO_SIMULATION_THRESHOLD && monteCarloAllowed) {
      // A very complex fight: a Monte Carlo simulation instead of exact probabilities.
      complexFight(true, this.stats, opponent.stats, this.stats.numBlows, opponent.stats.numBlows, this.summary, opponent.summary, notHit, levelupConsidered, split, oppSplit, this.slowed, opponent.slowed);
    } else if (split.length === 1 && oppSplit.length === 1) {
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
