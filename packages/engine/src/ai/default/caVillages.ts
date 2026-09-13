/**
 * TS port of `ai_default_rca::get_villages_phase` (`src/ai/default/ca.cpp:
 * 535-1311`). Score 60000. Assigns reachable, not-already-owned villages
 * to own units (skipping guardians, passive leaders, `[filter_own]`
 * failures, and villages too dangerous for the unit's own HP to risk --
 * `hitpoints < threat*2*chanceToBeHit/100`, mirroring upstream exactly),
 * then moves everyone assigned, leaders last (so the castle stays clear
 * for recruiting).
 *
 * Simplified vs. upstream's `dispatch`/`dispatch_complex` (documented,
 * not silent): this port does the same "unit with exactly one option" /
 * "village reachable by exactly one unit" simple-dispatch passes upstream
 * does first, but falls back to a GREEDY fewest-options-first assignment
 * for the remainder rather than upstream's true backtracking maximum
 * bipartite matching -- faithful for the common case (few villages
 * contested by more than a couple of units at once) but can leave a
 * village uncaptured in a genuinely tangled many-to-many configuration
 * where the optimal matching needs backtracking.
 */

import { Location } from '../../model/Location.js';
import type { Unit } from '../../model/Unit.js';
import { findPath } from '../../pathfind/pathfind.js';
import { CandidateAction } from '../composite/rca.js';

interface VillageAssignment {
  readonly unit: Unit;
  readonly village: Location;
}

export class VillagesCandidateAction extends CandidateAction {
  private assignments: VillageAssignment[] = [];

  evaluate(): number {
    this.assignments = this.findAssignments();
    return this.assignments.length > 0 ? this.score : 0;
  }

  private findAssignments(): VillageAssignment[] {
    const board = this.ctx.board;
    const team = this.ctx.team();
    const enemyDstSrc = this.ctx.getEnemyDstSrc();
    const srcDst = this.ctx.getSrcDst();

    const unitVillages = new Map<Unit, Location[]>();
    for (const unit of board.unitsForSide(this.ctx.side)) {
      if (unit.guardian) continue;
      if (this.ctx.isPassiveLeader(unit.id)) continue;
      if (!this.isAllowedUnit(unit)) continue;
      const dests = srcDst.get(unit.location.key()) ?? [];
      const villages: Location[] = [];
      for (const loc of dests) {
        if (!board.map.isVillage(loc)) continue;
        const owner = board.villageOwner(loc);
        if (owner === this.ctx.side) continue;
        if (owner !== undefined) {
          const ownerTeam = board.getTeam(owner);
          if (ownerTeam && !team.isEnemy(ownerTeam)) continue; // ally-owned: not a valid target
        }
        const threat = this.ctx.powerProjection(loc, enemyDstSrc);
        const chanceToBeHit = unit.defenseModifier(board.map.getTerrain(loc));
        if (unit.hitpoints < (threat * 2 * chanceToBeHit) / 100) continue;
        villages.push(loc);
      }
      if (villages.length > 0) unitVillages.set(unit, villages);
    }

    return dispatchVillages(unitVillages);
  }

  execute(): void {
    // Leaders move last so the castle stays clear for a later recruitment CA.
    const ordered = [...this.assignments].sort((a, b) => Number(a.unit.canRecruit) - Number(b.unit.canRecruit));
    for (const { unit, village } of ordered) {
      if (this.ctx.board.unitAt(unit.location) !== unit) continue; // died/was moved by an earlier assignment this call
      if (!village.equals(unit.location) && this.ctx.board.hasUnitAt(village)) continue; // became occupied meanwhile
      const route = findPath(this.ctx.board, unit, village, { viewingTeam: this.ctx.team() });
      if (route.steps.length > 1) this.ctx.executeMove(unit, route.steps, true);
    }
  }
}

/** See class doc comment for how this simplifies upstream's `dispatch`/`dispatch_complex`. */
function dispatchVillages(unitVillages: Map<Unit, Location[]>): VillageAssignment[] {
  const villageUnits = new Map<string, Unit[]>();
  for (const [unit, villages] of unitVillages) {
    for (const v of villages) {
      const arr = villageUnits.get(v.key());
      if (arr) arr.push(unit);
      else villageUnits.set(v.key(), [unit]);
    }
  }

  const assignments: VillageAssignment[] = [];
  const assignedUnits = new Set<Unit>();
  const assignedVillages = new Set<string>();

  const removeUnit = (unit: Unit): void => {
    unitVillages.delete(unit);
    for (const [key, units] of villageUnits) {
      villageUnits.set(
        key,
        units.filter((u) => u !== unit),
      );
    }
  };
  const removeVillage = (key: string, loc: Location): void => {
    villageUnits.delete(key);
    for (const [unit, villages] of unitVillages) {
      unitVillages.set(
        unit,
        villages.filter((v) => !v.equals(loc)),
      );
    }
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const [unit, villages] of [...unitVillages]) {
      if (assignedUnits.has(unit) || villages.length !== 1) continue;
      const village = villages[0]!;
      assignments.push({ unit, village });
      assignedUnits.add(unit);
      assignedVillages.add(village.key());
      removeUnit(unit);
      removeVillage(village.key(), village);
      changed = true;
    }
    for (const [key, units] of [...villageUnits]) {
      if (assignedVillages.has(key) || units.length !== 1) continue;
      const unit = units[0]!;
      const village = Location.fromKey(key);
      assignments.push({ unit, village });
      assignedUnits.add(unit);
      assignedVillages.add(key);
      removeUnit(unit);
      removeVillage(key, village);
      changed = true;
    }
  }

  const remaining = [...unitVillages.entries()]
    .filter(([unit, villages]) => !assignedUnits.has(unit) && villages.length > 0)
    .sort((a, b) => a[1].length - b[1].length);
  for (const [unit, villages] of remaining) {
    if (assignedUnits.has(unit)) continue;
    const village = villages.find((v) => !assignedVillages.has(v.key()));
    if (village) {
      assignments.push({ unit, village });
      assignedUnits.add(unit);
      assignedVillages.add(village.key());
    }
  }

  return assignments;
}
