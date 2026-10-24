/**
 * Phase 27c S4: the units that take part in a blow without striking or being struck -- `unit_display::
 * unit_attack`'s helpers, which play an animation of their own with the blow: each leader whose
 * `[leadership]` lifts the striker (`leading`), each neighbour whose `[resistance]` shields the one struck
 * (`resistance`), and any other unit teaching either a weapon ability (`teaching`, unless it already
 * plays one of the first two). Worked out when the fight starts, for both striking directions, so the
 * blows can be shown after the fight has been resolved.
 */
import type { GameBoard } from '../model/GameBoard.js';
import type { Location } from '../model/Location.js';
import type { Unit } from '../model/Unit.js';
import type { AttackType } from '../model/UnitType.js';
import type { WmlConfig } from '../wml/config.js';
import { SpecialsContext, type SpecialsCombatant } from './abilities.js';

/** One helper of a blow: who, where, playing what, towards which hex. */
export interface AttackHelper {
  readonly unit: Unit;
  readonly loc: Location;
  readonly event: 'leading' | 'resistance' | 'teaching';
  /** The striker (leading, teaching) or the one struck (resistance): where the helper faces. */
  readonly towards: Location;
  /** The helper's type, variation and own animations then (as `LastAttackAnimation`'s combatants'). */
  readonly typeId: string;
  readonly variation: string;
  readonly newAnimations: readonly WmlConfig[];
}

/** The helpers of the blows the attacker strikes, and of those the defender strikes back. */
export interface AttackHelpers {
  readonly attackerStrikes: readonly AttackHelper[];
  readonly defenderStrikes: readonly AttackHelper[];
}

function helper(board: GameBoard, loc: Location, event: AttackHelper['event'], towards: Location): AttackHelper | null {
  const unit = board.unitAt(loc);
  if (!unit) return null;
  return { unit, loc, event, towards, typeId: unit.type.id, variation: unit.variation, newAnimations: unit.newAnimations };
}

/** `unit_attack`'s leaders, resistance helpers and teachers for `striker` hitting `struck`. */
function helpersOf(board: GameBoard, striker: SpecialsCombatant, struck: SpecialsCombatant, attacking: boolean): AttackHelper[] {
  const ctx = SpecialsContext.make(board, striker, struck, attacking);
  const self = ctx.combatantOf(striker.un!);
  const other = ctx.other(self);
  const a = striker.loc;
  const b = struck.loc;
  const outside = (loc: Location) => !loc.equals(a) && !loc.equals(b);
  const out: AttackHelper[] = [];
  const leaders = ctx.getAbilitiesWeapons(self, 'leadership').items.map((i) => i.teacherLoc).filter(outside);
  const shields = ctx.getAbilitiesWeapons(other, 'resistance').items.map((i) => i.teacherLoc).filter(outside);
  for (const loc of leaders) {
    const h = helper(board, loc, 'leading', a);
    if (h) out.push(h);
  }
  for (const loc of shields) {
    const h = helper(board, loc, 'resistance', b);
    if (h) out.push(h);
  }
  for (const item of ctx.getActiveCombatTeachers(self).items) {
    const loc = item.teacherLoc;
    if (!outside(loc)) continue;
    if (leaders.some((l) => l.equals(loc)) || shields.some((l) => l.equals(loc))) continue;
    const h = helper(board, loc, 'teaching', a);
    if (h) out.push(h);
  }
  return out;
}

/** The helpers of a fight between `attacker` (with `attackerWeapon`) and `defender` (with `defenderWeapon`, if any). */
export function attackHelpers(board: GameBoard, attacker: Unit, attackerWeapon: AttackType | undefined, defender: Unit, defenderWeapon: AttackType | undefined): AttackHelpers {
  const att: SpecialsCombatant = { un: attacker, loc: attacker.location, at: attackerWeapon };
  const def: SpecialsCombatant = { un: defender, loc: defender.location, at: defenderWeapon };
  return {
    attackerStrikes: attackerWeapon ? helpersOf(board, att, def, true) : [],
    defenderStrikes: defenderWeapon ? helpersOf(board, def, att, false) : [],
  };
}
